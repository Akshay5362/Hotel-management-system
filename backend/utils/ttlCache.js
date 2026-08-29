/**
 * backend/utils/ttlCache.js
 * ─────────────────────────────────────────────────────────────────────────────
 * High-performance, in-memory, process-local TTL cache with stampede protection.
 *
 * Designed for safe short-TTL caching of read-heavy NoSQL aggregations and
 * semi-static master data.
 *
 * Guarantees:
 *  - Process-local in-memory storage (zero external network / disk I/O)
 *  - Concurrent promise deduplication on cache misses (stampede protection)
 *  - Safe fallback: cache failures NEVER throw or abort business requests
 *  - Safe invalidation: targeted key or prefix purging
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readBudgetMonitor } from './firestoreReadBudget.js';

export class TtlCache {
  constructor(defaultTtlMs = 5000) {
    this.defaultTtlMs = defaultTtlMs;
    this.store = new Map();
    this.inFlight = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0
    };
  }

  /**
   * Retrieves a value if it exists and has not expired.
   * @param {string} key
   * @returns {*|undefined}
   */
  get(key) {
    if (!key) return undefined;
    try {
      const entry = this.store.get(String(key));
      if (!entry) {
        this.stats.misses++;
        readBudgetMonitor?.recordCacheMiss();
        return undefined;
      }
      if (Date.now() > entry.expiresAt) {
        this.store.delete(String(key));
        this.stats.misses++;
        readBudgetMonitor?.recordCacheMiss();
        return undefined;
      }
      this.stats.hits++;
      readBudgetMonitor?.recordCacheHit(45); // average room status/master data read batch saved
      return entry.value;
    } catch (_) {
      return undefined;
    }
  }

  /**
   * Sets a value in the cache with an expiration timestamp.
   * @param {string} key
   * @param {*} value
   * @param {number} [ttlMs]
   */
  set(key, value, ttlMs = this.defaultTtlMs) {
    if (!key) return;
    try {
      const expiresAt = Date.now() + (ttlMs > 0 ? ttlMs : this.defaultTtlMs);
      this.store.set(String(key), { value, expiresAt });
      this.stats.sets++;
    } catch (_) {}
  }

  /**
   * Checks if a valid (non-expired) entry exists for the key.
   * @param {string} key
   * @returns {boolean}
   */
  hasValid(key) {
    if (!key) return false;
    try {
      const entry = this.store.get(String(key));
      if (!entry) return false;
      if (Date.now() > entry.expiresAt) {
        this.store.delete(String(key));
        return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Deletes a specific cache key.
   * @param {string} key
   */
  delete(key) {
    if (!key) return;
    try {
      this.store.delete(String(key));
      this.inFlight.delete(String(key));
      this.stats.invalidations++;
    } catch (_) {}
  }

  /**
   * Deletes all keys matching a prefix.
   * @param {string} prefix
   */
  deleteByPrefix(prefix) {
    if (!prefix) return;
    try {
      const prefixStr = String(prefix);
      for (const k of this.store.keys()) {
        if (k.startsWith(prefixStr)) {
          this.store.delete(k);
          this.inFlight.delete(k);
          this.stats.invalidations++;
        }
      }
    } catch (_) {}
  }

  /**
   * Clears the entire cache store.
   */
  clear() {
    this.store.clear();
    this.inFlight.clear();
    this.stats.invalidations++;
  }

  /**
   * Fetches data with stampede protection (coalescing in-flight loaders).
   * @param {string} key
   * @param {Function} loaderFn - Async function returning data
   * @param {number} [ttlMs]
   * @param {object} [options]
   * @param {boolean} [options.skipCache=false]
   * @returns {Promise<*>}
   */
  async getOrSet(key, loaderFn, ttlMs = this.defaultTtlMs, options = {}) {
    if (typeof loaderFn !== 'function') {
      throw new Error('TtlCache.getOrSet requires a loader function.');
    }

    const { skipCache = false } = options;

    if (!skipCache && this.hasValid(key)) {
      return this.get(key);
    }

    const strKey = String(key);

    // Concurrency / Stampede Protection: If a loader for this key is already running, join it
    if (this.inFlight.has(strKey)) {
      readBudgetMonitor?.recordDeduplication(45);
      return await this.inFlight.get(strKey);
    }

    const promise = (async () => {
      try {
        const result = await loaderFn();
        if (!skipCache && result !== undefined) {
          this.set(strKey, result, ttlMs);
        }
        return result;
      } finally {
        this.inFlight.delete(strKey);
      }
    })();

    this.inFlight.set(strKey, promise);
    return await promise;
  }

  /**
   * Returns diagnostic stats.
   */
  getStats() {
    return {
      ...this.stats,
      size: this.store.size,
      inFlightCount: this.inFlight.size
    };
  }
}

// Global shared default instance
export const globalTtlCache = new TtlCache(5000);
export default globalTtlCache;
