/**
 * backend/utils/firestoreReadBudget.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Application-Level Firestore Read Budget Monitor & Safety Guardrails.
 *
 * Provides in-memory, process-local observability and rate protection:
 *   - Tracks estimated document reads by endpoint, service, and collection.
 *   - Tracks cache hits, misses, deduplicated requests, and saved reads.
 *   - Configurable safety thresholds (Warning @ 25K, Critical @ 30K, Protection @ 35K).
 *   - ZERO Firestore writes / reads for telemetry.
 *   - ZERO blocking on authoritative transactions (check-in, check-out, shift, payments).
 * ─────────────────────────────────────────────────────────────────────────────
 */

class FirestoreReadBudgetMonitor {
  constructor() {
    this.DAILY_HARD_LIMIT = 50000;      // Official Firebase Spark daily limit
    this.SAFETY_BUDGET = 35000;         // Application safety threshold
    this.WARNING_THRESHOLD = 25000;     // Warn log threshold
    this.CRITICAL_THRESHOLD = 30000;    // Critical log threshold
    this.PROTECTION_THRESHOLD = 35000;  // Pause non-essential background refreshes

    this.estimatedReadsToday = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.deduplicatedRequests = 0;
    this.estimatedReadsSaved = 0;

    this.readsByEndpoint = new Map();
    this.readsByService = new Map();
    this.readsByCollection = new Map();

    // Rolling window for requests per minute
    this.recentRequests = [];

    this.lastResetDate = new Date().toISOString().split('T')[0];
  }

  /**
   * Resets counters if business/calendar day has changed.
   */
  _checkDailyReset() {
    const today = new Date().toISOString().split('T')[0];
    if (today !== this.lastResetDate) {
      this.estimatedReadsToday = 0;
      this.cacheHits = 0;
      this.cacheMisses = 0;
      this.deduplicatedRequests = 0;
      this.estimatedReadsSaved = 0;
      this.readsByEndpoint.clear();
      this.readsByService.clear();
      this.readsByCollection.clear();
      this.lastResetDate = today;
    }
  }

  /**
   * Records an estimated number of Firestore document reads.
   *
   * @param {number} count - Number of documents read
   * @param {object} [context]
   * @param {string} [context.endpoint]
   * @param {string} [context.service]
   * @param {string} [context.collection]
   */
  recordReads(count = 1, context = {}) {
    if (count <= 0) return;
    this._checkDailyReset();

    this.estimatedReadsToday += count;

    const { endpoint, service, collection } = context;
    if (endpoint) {
      this.readsByEndpoint.set(endpoint, (this.readsByEndpoint.get(endpoint) || 0) + count);
    }
    if (service) {
      this.readsByService.set(service, (this.readsByService.get(service) || 0) + count);
    }
    if (collection) {
      this.readsByCollection.set(collection, (this.readsByCollection.get(collection) || 0) + count);
    }

    // Record request timestamp for rolling requests/min calculation
    const now = Date.now();
    this.recentRequests.push(now);
    // Keep only requests from the last 60 seconds
    const oneMinAgo = now - 60000;
    this.recentRequests = this.recentRequests.filter(ts => ts >= oneMinAgo);

    // Logging alerts on threshold crossing
    if (this.estimatedReadsToday >= this.PROTECTION_THRESHOLD) {
      console.warn(`[ReadBudget:PROTECTION] Estimated reads today (${this.estimatedReadsToday}) reached protection threshold (${this.PROTECTION_THRESHOLD}). Non-essential polling paused.`);
    } else if (this.estimatedReadsToday >= this.CRITICAL_THRESHOLD) {
      console.warn(`[ReadBudget:CRITICAL] Estimated reads today (${this.estimatedReadsToday}) reached critical threshold (${this.CRITICAL_THRESHOLD}).`);
    } else if (this.estimatedReadsToday >= this.WARNING_THRESHOLD) {
      console.info(`[ReadBudget:WARNING] Estimated reads today (${this.estimatedReadsToday}) reached warning threshold (${this.WARNING_THRESHOLD}).`);
    }
  }

  /**
   * Records a cache hit and the estimated reads saved.
   * @param {number} estimatedSaved
   */
  recordCacheHit(estimatedSaved = 1) {
    this._checkDailyReset();
    this.cacheHits++;
    this.estimatedReadsSaved += estimatedSaved;
  }

  /**
   * Records a cache miss.
   */
  recordCacheMiss() {
    this._checkDailyReset();
    this.cacheMisses++;
  }

  /**
   * Records request deduplication (coalesced concurrent in-flight requests).
   * @param {number} estimatedSaved
   */
  recordDeduplication(estimatedSaved = 1) {
    this._checkDailyReset();
    this.deduplicatedRequests++;
    this.estimatedReadsSaved += estimatedSaved;
  }

  /**
   * Returns whether the application protection threshold has been reached.
   * @returns {boolean}
   */
  isProtectionThresholdReached() {
    this._checkDailyReset();
    return this.estimatedReadsToday >= this.PROTECTION_THRESHOLD;
  }

  /**
   * Returns formatted budget diagnostics for admin/telemetry endpoints.
   */
  getDiagnostics() {
    this._checkDailyReset();

    const now = Date.now();
    const oneMinAgo = now - 60000;
    const requestsPerMinute = this.recentRequests.filter(ts => ts >= oneMinAgo).length;

    let budgetStatus = 'NORMAL';
    if (this.estimatedReadsToday >= this.PROTECTION_THRESHOLD) {
      budgetStatus = 'PROTECTION_ACTIVE';
    } else if (this.estimatedReadsToday >= this.CRITICAL_THRESHOLD) {
      budgetStatus = 'CRITICAL';
    } else if (this.estimatedReadsToday >= this.WARNING_THRESHOLD) {
      budgetStatus = 'WARNING';
    }

    const endpointObj = {};
    for (const [k, v] of this.readsByEndpoint.entries()) endpointObj[k] = v;

    const serviceObj = {};
    for (const [k, v] of this.readsByService.entries()) serviceObj[k] = v;

    const collectionObj = {};
    for (const [k, v] of this.readsByCollection.entries()) collectionObj[k] = v;

    return {
      status: budgetStatus,
      estimated_reads_today: this.estimatedReadsToday,
      hard_quota_limit: this.DAILY_HARD_LIMIT,
      safety_budget: this.SAFETY_BUDGET,
      remaining_safety_budget: Math.max(0, this.SAFETY_BUDGET - this.estimatedReadsToday),
      utilization_percent: Number(((this.estimatedReadsToday / this.DAILY_HARD_LIMIT) * 100).toFixed(2)),
      requests_per_minute: requestsPerMinute,
      cache_hits: this.cacheHits,
      cache_misses: this.cacheMisses,
      deduplicated_requests: this.deduplicatedRequests,
      estimated_reads_saved: this.estimatedReadsSaved,
      top_endpoints: endpointObj,
      top_services: serviceObj,
      top_collections: collectionObj
    };
  }

  /**
   * Reset helper for testing.
   */
  _resetForTesting() {
    this.estimatedReadsToday = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.deduplicatedRequests = 0;
    this.estimatedReadsSaved = 0;
    this.readsByEndpoint.clear();
    this.readsByService.clear();
    this.readsByCollection.clear();
    this.recentRequests = [];
  }
}

export const readBudgetMonitor = new FirestoreReadBudgetMonitor();
export default readBudgetMonitor;
