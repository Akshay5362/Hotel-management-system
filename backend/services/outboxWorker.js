import { FEATURE_FLAGS } from '../config/featureFlags.js';
import { claimNextBatch, markProcessed, markFailed } from './outboxService.js';
import { dispatchEvent } from './outboxDispatcher.js';

let isRunning = false;
let workerInterval = null;

const BATCH_SIZE = Number(process.env.FIRESTORE_OUTBOX_BATCH_SIZE || 10);
const MAX_RETRIES = Number(process.env.FIRESTORE_OUTBOX_MAX_RETRIES || 5);
const POLL_INTERVAL_MS = Number(process.env.FIRESTORE_OUTBOX_POLL_INTERVAL_MS || 3000);

/**
 * Runs a single outbox batch processing cycle.
 * Non-blocking for normal HTTP requests.
 */
export async function processOutboxBatch(batchSize = BATCH_SIZE, maxRetries = MAX_RETRIES) {
  const effectiveBatchSize = typeof batchSize === 'object' && batchSize !== null ? (Number(batchSize.batchSize) || BATCH_SIZE) : (Number(batchSize) || BATCH_SIZE);
  const effectiveMaxRetries = typeof batchSize === 'object' && batchSize !== null ? (Number(batchSize.maxRetries) || maxRetries) : (Number(maxRetries) || MAX_RETRIES);

  try {
    const claimedEvents = await claimNextBatch(null, effectiveBatchSize, effectiveMaxRetries);
    if (claimedEvents.length === 0) {
      return { processed: 0, failed: 0 };
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
        console.warn(`[OutboxWorker] Failed event '${event.event_id}' (${event.event_type}) after ${duration}ms:`, err.message);
        await markFailed(null, event.event_id, err.message, maxRetries);
      }
    }

    return { processed: processedCount, failed: failedCount };
  } catch (err) {
    console.error('[OutboxWorker] Batch processing error:', err.message);
    return { processed: 0, failed: 0, error: err.message };
  }
}

/**
 * Starts the Outbox Worker polling loop if the feature flag is enabled.
 */
export function startOutboxWorker() {
  if (!FEATURE_FLAGS.ENABLE_FIRESTORE_OUTBOX_WORKER && process.env.ENABLE_FIRESTORE_OUTBOX_WORKER !== 'true') {
    console.log('[OutboxWorker] ENABLE_FIRESTORE_OUTBOX_WORKER is disabled. Outbox worker daemon remains idle (safe state).');
    return false;
  }

  if (isRunning) {
    console.log('[OutboxWorker] Worker daemon is already running.');
    return true;
  }

  isRunning = true;
  console.log(`[OutboxWorker] Starting outbox worker daemon (Poll: ${POLL_INTERVAL_MS}ms, Batch: ${BATCH_SIZE}, Max Retries: ${MAX_RETRIES}).`);

  workerInterval = setInterval(async () => {
    if (!isRunning) return;
    await processOutboxBatch(BATCH_SIZE, MAX_RETRIES);
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
