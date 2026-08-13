import { isFirestoreOutboxWorkerEnabled } from '../config/featureFlags.js';
import { claimNextBatch, markProcessed, markFailed, reclaimStaleProcessing } from './outboxService.js';
import { dispatchEvent } from './outboxDispatcher.js';

let isRunning = false;
let workerInterval = null;

const BATCH_SIZE = Number(process.env.FIRESTORE_OUTBOX_BATCH_SIZE || 10);
const MAX_RETRIES = Number(process.env.FIRESTORE_OUTBOX_MAX_RETRIES || 5);
const POLL_INTERVAL_MS = Number(process.env.FIRESTORE_OUTBOX_POLL_INTERVAL_MS || 3000);

/**
 * Runs a single outbox batch processing cycle.
 *
 * Sequence per cycle:
 *  1. reclaimStaleProcessing() — recover events orphaned by a prior worker crash.
 *     These are moved PROCESSING → FAILED so the normal retry mechanism picks them up.
 *  2. claimNextBatch()         — claim PENDING / retry-eligible FAILED events.
 *  3. dispatchEvent()          — push each event to its Firestore repository.
 *  4. markProcessed()          — mark success.
 *     OR markFailed()          — record failure, apply exponential backoff, or DEAD_LETTER.
 *
 * Non-blocking for normal HTTP requests.
 */
export async function processOutboxBatch(batchSize = BATCH_SIZE, maxRetries = MAX_RETRIES) {
  const effectiveBatchSize = typeof batchSize === 'object' && batchSize !== null
    ? (Number(batchSize.batchSize) || BATCH_SIZE)
    : (Number(batchSize) || BATCH_SIZE);
  const effectiveMaxRetries = typeof batchSize === 'object' && batchSize !== null
    ? (Number(batchSize.maxRetries) || maxRetries)
    : (Number(maxRetries) || MAX_RETRIES);

  try {
    // ── Step 1: Lease recovery ────────────────────────────────────────────────
    // Reset any PROCESSING events that have been stuck beyond the configured
    // lease timeout (OUTBOX_PROCESSING_LEASE_MINUTES, default 10 minutes).
    // This handles the worker-crash scenario where markProcessed() was never called.
    const reclaimed = await reclaimStaleProcessing();
    if (reclaimed > 0) {
      console.warn(
        `[OutboxWorker] Lease recovery: reclaimed ${reclaimed} stale PROCESSING event(s) ` +
        `(exceeded OUTBOX_PROCESSING_LEASE_MINUTES=${process.env.OUTBOX_PROCESSING_LEASE_MINUTES || 10}). ` +
        `These have been moved to FAILED and will be retried on the next cycle.`
      );
    }

    // ── Step 2: Claim + dispatch ──────────────────────────────────────────────
    const claimedEvents = await claimNextBatch(null, effectiveBatchSize, effectiveMaxRetries);
    if (claimedEvents.length === 0) {
      return { processed: 0, failed: 0, reclaimed };
    }

    let processedCount = 0;
    let failedCount = 0;

    for (const event of claimedEvents) {
      const startTime = Date.now();
      try {
        await dispatchEvent(event);
        await markProcessed(null, event.event_id);
        processedCount++;
        const duration = Date.now() - startTime;
        console.log(`[OutboxWorker] Processed event '${event.event_id}' (${event.event_type}) in ${duration}ms`);
      } catch (err) {
        failedCount++;
        const duration = Date.now() - startTime;
        console.warn(
          `[OutboxWorker] Failed event '${event.event_id}' (${event.event_type}) ` +
          `after ${duration}ms: ${err.message}`
        );
        const updatedEvent = await markFailed(null, event.event_id, err.message, effectiveMaxRetries);

        // ── DEAD_LETTER alert ─────────────────────────────────────────────────
        // markFailed() transitions to DEAD_LETTER when attempts >= maxRetries.
        // Log at ERROR level so operators can detect permanently failed events.
        if (updatedEvent && updatedEvent.status === 'DEAD_LETTER') {
          console.error(
            `[OutboxWorker] DEAD_LETTER: Event '${event.event_id}' (${event.event_type}) ` +
            `has permanently failed after ${updatedEvent.attempts} attempts. ` +
            `Last error: ${err.message}. Manual intervention required.`
          );
        }
      }
    }

    return { processed: processedCount, failed: failedCount, reclaimed };
  } catch (err) {
    console.error('[OutboxWorker] Batch processing error:', err.message);
    return { processed: 0, failed: 0, reclaimed: 0, error: err.message };
  }
}

/**
 * Starts the Outbox Worker polling loop.
 *
 * The worker starts ONLY when ENABLE_FIRESTORE_OUTBOX_WORKER=true.
 * When the flag is false, this function logs and returns false — no interval
 * is created, no Firestore writes occur, and MySQL business operations are
 * entirely unaffected.
 *
 * The isRunning guard prevents duplicate intervals if startOutboxWorker()
 * is called more than once (e.g., from hot-reload or test setup).
 *
 * @returns {boolean} true if started, false if disabled or already running.
 */
export function startOutboxWorker() {
  if (!isFirestoreOutboxWorkerEnabled()) {
    console.log('[OutboxWorker] ENABLE_FIRESTORE_OUTBOX_WORKER is disabled. Outbox worker daemon remains idle (safe state).');
    return false;
  }

  if (isRunning) {
    console.log('[OutboxWorker] Worker daemon is already running.');
    return true;
  }

  isRunning = true;
  console.log(
    `[OutboxWorker] Starting outbox worker daemon ` +
    `(Poll: ${POLL_INTERVAL_MS}ms, Batch: ${BATCH_SIZE}, ` +
    `Max Retries: ${MAX_RETRIES}, ` +
    `Lease timeout: ${process.env.OUTBOX_PROCESSING_LEASE_MINUTES || 10}min).`
  );

  workerInterval = setInterval(async () => {
    if (!isRunning) return;
    // Top-level try/catch ensures a burst of Firestore errors cannot
    // crash the setInterval loop or the main Express process.
    try {
      await processOutboxBatch(BATCH_SIZE, MAX_RETRIES);
    } catch (err) {
      console.error('[OutboxWorker] Unhandled error in polling cycle:', err.message);
    }
  }, POLL_INTERVAL_MS);

  return true;
}

/**
 * Gracefully stops the Outbox Worker polling loop.
 */
export function stopOutboxWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  isRunning = false;
  console.log('[OutboxWorker] Worker daemon stopped.');
}

export function isWorkerRunning() {
  return isRunning;
}
