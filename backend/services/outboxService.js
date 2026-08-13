import pool from '../db.js';
import crypto from 'crypto';
import { FEATURE_FLAGS } from '../config/featureFlags.js';

export class OutboxServiceError extends Error {
  constructor(message, code = 'OUTBOX_ERROR', details = null) {
    super(message);
    this.name = 'OutboxServiceError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Creates a structured Outbox Event payload
 */
export function createEvent({ event_type, aggregate_type, aggregate_id, payload, event_id = null }) {
  if (!event_type || !aggregate_type || !aggregate_id || payload === undefined) {
    throw new OutboxServiceError(
      'Missing required event parameters: event_type, aggregate_type, aggregate_id, and payload are required.',
      'INVALID_EVENT_PARAMS'
    );
  }

  const generatedId = event_id || `evt_${event_type.toLowerCase()}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  return {
    event_id: generatedId,
    event_type: String(event_type).toUpperCase(),
    aggregate_type: String(aggregate_type).toUpperCase(),
    aggregate_id: String(aggregate_id),
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    status: 'PENDING',
    created_at: new Date().toISOString()
  };
}

/**
 * Enqueues an event into `dual_write_outbox`.
 * Accepts optional connection `conn` to execute inside an active MySQL transaction.
 */
export async function enqueue(conn, eventData) {
  const db = conn || pool;
  const evt = createEvent(eventData);

  try {
    await db.query(
      `INSERT INTO dual_write_outbox (
        event_id, event_type, aggregate_type, aggregate_id, payload, status, created_at, available_at
      ) VALUES (?, ?, ?, ?, ?, 'PENDING', NOW(), NOW())`,
      [evt.event_id, evt.event_type, evt.aggregate_type, evt.aggregate_id, evt.payload]
    );

    return evt;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw new OutboxServiceError(`Duplicate event_id entry: '${evt.event_id}'`, 'DUPLICATE_EVENT_ID', { eventId: evt.event_id });
    }
    throw new OutboxServiceError(`Failed to enqueue outbox event: ${err.message}`, 'ENQUEUE_FAILED', err);
  }
}

/**
 * Concurrency-safe claim strategy for worker daemon using FOR UPDATE SKIP LOCKED.
 * Claims a batch of PENDING or retry-eligible FAILED outbox events atomically.
 */
export async function claimNextBatch(conn, batchSize = 10, maxRetries = 5) {
  const useConn = conn || await pool.getConnection();
  const isSelfConn = !conn;

  try {
    if (isSelfConn) {
      await useConn.beginTransaction();
    }

    const [candidates] = await useConn.query(
      `SELECT id, event_id, event_type, aggregate_type, aggregate_id, payload, attempts, created_at
       FROM dual_write_outbox
       WHERE (status = 'PENDING' OR (status = 'FAILED' AND attempts < ?))
         AND available_at <= NOW()
       ORDER BY id ASC
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [maxRetries, Number(batchSize)]
    );

    if (candidates.length === 0) {
      if (isSelfConn) await useConn.commit();
      return [];
    }

    const idsToClaim = candidates.map(c => c.id);
    const placeholders = idsToClaim.map(() => '?').join(',');

    await useConn.query(
      `UPDATE dual_write_outbox
       SET status = 'PROCESSING', updated_at = NOW()
       WHERE id IN (${placeholders}) AND (status = 'PENDING' OR status = 'FAILED')`,
      idsToClaim
    );

    if (isSelfConn) {
      await useConn.commit();
    }

    return candidates;
  } catch (err) {
    if (isSelfConn) {
      try { await useConn.rollback(); } catch (_) {}
    }
    throw err;
  } finally {
    if (isSelfConn) {
      useConn.release();
    }
  }
}

/**
 * Marks an outbox event as PROCESSED cleanly upon successful Firestore write.
 */
export async function markProcessed(conn, eventId) {
  const db = conn || pool;
  await db.query(
    `UPDATE dual_write_outbox
     SET status = 'PROCESSED', processed_at = NOW(), last_error = NULL
     WHERE event_id = ?`,
    [String(eventId)]
  );
}

/**
 * Marks an outbox event as FAILED with exponential backoff or DEAD_LETTER if max attempts reached.
 * Returns { status, attempts } so callers can detect the DEAD_LETTER transition.
 */
export async function markFailed(conn, eventId, errorMsg, maxRetries = 5) {
  const db = conn || pool;
  const safeErr = String(errorMsg || 'Unknown dispatch failure').slice(0, 1000);

  const [rows] = await db.query(
    `SELECT attempts FROM dual_write_outbox WHERE event_id = ?`,
    [String(eventId)]
  );

  const currentAttempts = (rows[0]?.attempts || 0) + 1;

  if (currentAttempts >= maxRetries) {
    await db.query(
      `UPDATE dual_write_outbox
       SET status = 'DEAD_LETTER', attempts = ?, last_error = ?
       WHERE event_id = ?`,
      [currentAttempts, safeErr, String(eventId)]
    );
    return { status: 'DEAD_LETTER', attempts: currentAttempts };
  } else {
    // Exponential backoff: 10s, 20s, 40s, 80s... capped at 300s
    const backoffSeconds = Math.min(300, Math.pow(2, currentAttempts) * 5);
    await db.query(
      `UPDATE dual_write_outbox
       SET status = 'FAILED', attempts = ?, last_error = ?, available_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
       WHERE event_id = ?`,
      [currentAttempts, safeErr, backoffSeconds, String(eventId)]
    );
    return { status: 'FAILED', attempts: currentAttempts };
  }
}

/**
 * Re-enables a failed or dead-letter event for retry.
 */
export async function retry(conn, eventId) {
  const db = conn || pool;
  await db.query(
    `UPDATE dual_write_outbox
     SET status = 'PENDING', attempts = 0, available_at = NOW(), last_error = NULL
     WHERE event_id = ?`,
    [String(eventId)]
  );
}

/**
 * Manually transitions an event into DEAD_LETTER state.
 */
export async function moveToDeadLetter(conn, eventId, errorMsg) {
  const db = conn || pool;
  await db.query(
    `UPDATE dual_write_outbox
     SET status = 'DEAD_LETTER', last_error = ?
     WHERE event_id = ?`,
    [String(errorMsg || 'Manually moved to dead-letter').slice(0, 1000), String(eventId)]
  );
}

/**
 * Reclaims stale PROCESSING events that have exceeded the lease timeout.
 *
 * A PROCESSING event is considered stale when:
 *   updated_at < NOW() - OUTBOX_PROCESSING_LEASE_MINUTES
 *
 * Default lease timeout: 10 minutes.
 * Configure via environment variable: OUTBOX_PROCESSING_LEASE_MINUTES
 *
 * Stale events are moved to FAILED (not directly to PENDING), so the
 * existing exponential-backoff retry mechanism handles them consistently.
 * The payload is preserved. The attempts counter is NOT reset, so
 * events close to maxRetries will correctly proceed to DEAD_LETTER.
 *
 * The UPDATE is guarded by:
 *   AND status = 'PROCESSING'
 *   AND updated_at < threshold
 * This prevents incorrectly reclaiming an event that was just claimed by
 * an active worker (fresh PROCESSING event with a recent updated_at).
 *
 * @param {object|null} conn  - Optional MySQL connection. Uses pool if null.
 * @returns {Promise<number>} - Number of events reclaimed.
 */
export async function reclaimStaleProcessing(conn) {
  const db = conn || pool;

  const leaseMinutes = Number(process.env.OUTBOX_PROCESSING_LEASE_MINUTES) || 10;

  const [result] = await db.query(
    `UPDATE dual_write_outbox
     SET
       status     = 'FAILED',
       available_at = NOW(),
       last_error = CONCAT(
         'Lease expired: event was stuck in PROCESSING for > ',
         ?,
         ' minutes (worker crash recovery). Recovered at: ',
         NOW()
       )
     WHERE status = 'PROCESSING'
       AND updated_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [leaseMinutes, leaseMinutes]
  );

  return result.affectedRows;
}
