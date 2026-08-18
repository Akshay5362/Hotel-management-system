/**
 * serviceStrategy.js — Service Strategy Abstraction & Router
 * ==============================================================================
 * Central strategy manager for routing service-layer operations.
 *
 * Strategies:
 * - MYSQL: Direct MySQL execution (100% authoritative for all business mutations)
 * - FIRESTORE: Direct Firestore execution (used for testing or forced Firestore reads)
 * - FIRESTORE_WITH_MYSQL_FALLBACK: Controlled read cutover (attempts Firestore, falls back to MySQL on anomaly)
 *
 * HARD SAFETY RULES:
 * - ALL business state mutations (create, update, delete, check-in, check-out, room shift,
 *   payments, invoices, housekeeping, inventory, day-end) MUST REMAIN MYSQL-AUTHORITATIVE.
 * - Firestore read routing uses a thin, deterministic wrapper around executeReadCanary().
 */

import { isFirestoreServicesEnabled, isFirestoreReadsEnabled } from '../config/featureFlags.js';
import { executeReadCanary } from './dualReadVerificationService.js';

export const STRATEGY_MODE = {
  MYSQL: 'MYSQL',
  FIRESTORE: 'FIRESTORE',
  FIRESTORE_WITH_MYSQL_FALLBACK: 'FIRESTORE_WITH_MYSQL_FALLBACK'
};

/**
 * Determines the read strategy for a given service domain.
 */
export function getReadStrategy(domainName, options = {}) {
  if (options.forceMode) {
    return options.forceMode;
  }

  const isServicesOn = isFirestoreServicesEnabled();
  const isReadsOn = isFirestoreReadsEnabled();

  if (isServicesOn || isReadsOn) {
    return STRATEGY_MODE.FIRESTORE_WITH_MYSQL_FALLBACK;
  }

  return STRATEGY_MODE.MYSQL;
}

/**
 * Determines the mutation strategy for a given service domain.
 * HARD SAFETY RULE: Always returns MYSQL to preserve ACID multi-table locking.
 */
export function getMutationStrategy(domainName) {
  return STRATEGY_MODE.MYSQL;
}

// Hardened Observability Metrics & Threshold Model (Phase 17)
export const OBSERVABILITY_THRESHOLDS = {
  MAX_FALLBACK_RATE_PERCENT: 15,
  MAX_LATENCY_MS: 500,
  MAX_OUTBOX_PENDING: 10,
  MAX_OUTBOX_DEAD_LETTER: 0
};

const metrics = {
  readAttempts: 0,
  firestoreDirectSuccesses: 0,
  mysqlFallbackSuccesses: 0,
  readFallbacks: 0,
  timeoutFallbacks: 0,
  exceptionFallbacks: 0,
  permissionFallbacks: 0,
  totalLatencyMs: 0,
  maxLatencyMs: 0
};

export function getServiceReadMetrics() {
  const avg = metrics.readAttempts > 0 ? (metrics.totalLatencyMs / metrics.readAttempts).toFixed(2) : 0;
  const fallbackRate = metrics.readAttempts > 0 ? ((metrics.readFallbacks / metrics.readAttempts) * 100).toFixed(1) : 0;

  return {
    read_attempts: metrics.readAttempts,
    firestore_direct_successes: metrics.firestoreDirectSuccesses,
    mysql_fallback_successes: metrics.mysqlFallbackSuccesses,
    read_fallbacks: metrics.readFallbacks,
    timeout_fallbacks: metrics.timeoutFallbacks,
    exception_fallbacks: metrics.exceptionFallbacks,
    permission_fallbacks: metrics.permissionFallbacks,
    fallback_rate_percent: Number(fallbackRate),
    total_latency_ms: metrics.totalLatencyMs,
    average_latency_ms: Number(avg),
    max_latency_ms: metrics.maxLatencyMs
  };
}

export function resetServiceReadMetrics() {
  metrics.readAttempts = 0;
  metrics.firestoreDirectSuccesses = 0;
  metrics.mysqlFallbackSuccesses = 0;
  metrics.readFallbacks = 0;
  metrics.timeoutFallbacks = 0;
  metrics.exceptionFallbacks = 0;
  metrics.permissionFallbacks = 0;
  metrics.totalLatencyMs = 0;
  metrics.maxLatencyMs = 0;
}

export function evaluateObservabilityThresholds(outboxCounts = {}) {
  const currentMetrics = getServiceReadMetrics();
  const warnings = [];

  if (currentMetrics.fallback_rate_percent > OBSERVABILITY_THRESHOLDS.MAX_FALLBACK_RATE_PERCENT) {
    warnings.push(`FALLBACK_RATE_EXCEEDED: ${currentMetrics.fallback_rate_percent}% > ${OBSERVABILITY_THRESHOLDS.MAX_FALLBACK_RATE_PERCENT}%`);
  }
  if (currentMetrics.max_latency_ms > OBSERVABILITY_THRESHOLDS.MAX_LATENCY_MS) {
    warnings.push(`MAX_LATENCY_EXCEEDED: ${currentMetrics.max_latency_ms}ms > ${OBSERVABILITY_THRESHOLDS.MAX_LATENCY_MS}ms`);
  }
  if ((outboxCounts.PENDING || 0) > OBSERVABILITY_THRESHOLDS.MAX_OUTBOX_PENDING) {
    warnings.push(`OUTBOX_PENDING_EXCEEDED: ${outboxCounts.PENDING} > ${OBSERVABILITY_THRESHOLDS.MAX_OUTBOX_PENDING}`);
  }
  if ((outboxCounts.DEAD_LETTER || 0) > OBSERVABILITY_THRESHOLDS.MAX_OUTBOX_DEAD_LETTER) {
    warnings.push(`OUTBOX_DEAD_LETTER_EXCEEDED: ${outboxCounts.DEAD_LETTER} > ${OBSERVABILITY_THRESHOLDS.MAX_OUTBOX_DEAD_LETTER}`);
  }

  return {
    operational_status: warnings.length === 0 ? 'HEALTHY' : 'WARNING',
    warning_count: warnings.length,
    warnings,
    thresholds: OBSERVABILITY_THRESHOLDS,
    metrics: currentMetrics
  };
}

/**
 * Executes a service read operation according to the active read strategy.
 * On FIRESTORE_WITH_MYSQL_FALLBACK mode:
 * Attempts Firestore fetch; on timeout, exception, mismatch, or missing doc,
 * logs diagnostic reason and falls back transparently to execute MySQL fetch.
 */
export async function executeServiceRead({
  domainName,
  fetchFirestoreFn,
  fetchMysqlFn,
  validateAndFormatFn = (data) => data,
  timeoutMs = 500,
  options = {}
}) {
  const start = Date.now();
  metrics.readAttempts++;

  const recordLatency = () => {
    const elapsed = Date.now() - start;
    metrics.totalLatencyMs += elapsed;
    if (elapsed > metrics.maxLatencyMs) metrics.maxLatencyMs = elapsed;
  };

  const strategy = getReadStrategy(domainName, options);

  if (strategy === STRATEGY_MODE.MYSQL) {
    const res = await fetchMysqlFn();
    recordLatency();
    metrics.mysqlFallbackSuccesses++;
    return res;
  }

  if (strategy === STRATEGY_MODE.FIRESTORE) {
    const raw = await fetchFirestoreFn();
    const formatted = validateAndFormatFn(raw);
    recordLatency();
    metrics.firestoreDirectSuccesses++;
    return formatted;
  }

  // FIRESTORE_WITH_MYSQL_FALLBACK Mode:
  try {
    const canaryResult = await executeReadCanary({
      flagCheckFn: () => true,
      endpointName: domainName,
      fetchFirestoreFn,
      validateAndFormatFn,
      timeoutMs
    });

    if (canaryResult !== null && canaryResult !== undefined) {
      recordLatency();
      metrics.firestoreDirectSuccesses++;
      return canaryResult;
    }
  } catch (err) {
    if (err.message?.includes('TIMEOUT')) {
      metrics.timeoutFallbacks++;
    } else if (err.message?.includes('PERMISSION')) {
      metrics.permissionFallbacks++;
    } else {
      metrics.exceptionFallbacks++;
    }
  }

  // Transparent Fallback to MySQL
  metrics.readFallbacks++;
  const mysqlResult = await fetchMysqlFn();
  recordLatency();
  metrics.mysqlFallbackSuccesses++;
  return mysqlResult;
}


/**
 * Executes a service mutation operation.
 * HARD SAFETY RULE: Mutations ALWAYS execute via MySQL to preserve ACID transaction locks.
 */
export async function executeServiceMutation({
  domainName,
  executeMysqlFn
}) {
  const strategy = getMutationStrategy(domainName);
  if (strategy !== STRATEGY_MODE.MYSQL) {
    throw new Error(`MUTATION_SAFETY_VIOLATION: Domain '${domainName}' must use MYSQL mutation strategy.`);
  }
  return await executeMysqlFn();
}

