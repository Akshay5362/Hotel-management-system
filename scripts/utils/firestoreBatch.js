/**
 * Safe Firestore Batch Writer Utility
 * =====================================
 * Wraps Firestore WriteBatch operations to ensure:
 *  - Automatic commit when reaching batch limit (default 250 ops, well below Firestore 500 limit).
 *  - Zero writes when operating in `--dry-run` mode.
 *  - Deterministic progress reporting and error handling.
 */

export class SafeFirestoreBatchWriter {
  /**
   * @param {object} db - Firebase Admin Firestore instance
   * @param {object} options - Configuration options
   * @param {number} [options.maxBatchSize=250] - Maximum operations per batch
   * @param {boolean} [options.isDryRun=true] - If true, performs zero writes
   * @param {string} [options.collectionName='unknown'] - Collection name for logging
   */
  constructor(db, options = {}) {
    this.db = db;
    this.maxBatchSize = options.maxBatchSize || 250;
    this.isDryRun = options.isDryRun !== undefined ? Boolean(options.isDryRun) : true;
    this.collectionName = options.collectionName || 'unknown';

    this.currentBatch = null;
    this.currentBatchCount = 0;
    this.totalCommittedCount = 0;
  }

  /**
   * Internal helper to lazy-initialize a new WriteBatch
   */
  _ensureBatch() {
    if (!this.isDryRun && this.db && !this.currentBatch) {
      this.currentBatch = this.db.batch();
    }
  }

  /**
   * Stage a `set` operation
   * @param {object} docRef - Firestore DocumentReference
   * @param {object} data - Document payload
   * @param {object} [setOptions={ merge: true }] - Set options
   */
  async set(docRef, data, setOptions = { merge: true }) {
    if (this.isDryRun) {
      this.totalCommittedCount++;
      return;
    }

    this._ensureBatch();
    this.currentBatch.set(docRef, data, setOptions);
    this.currentBatchCount++;

    if (this.currentBatchCount >= this.maxBatchSize) {
      await this.flush();
    }
  }

  /**
   * Stage a `delete` operation
   * @param {object} docRef - Firestore DocumentReference
   */
  async delete(docRef) {
    if (this.isDryRun) {
      this.totalCommittedCount++;
      return;
    }

    this._ensureBatch();
    this.currentBatch.delete(docRef);
    this.currentBatchCount++;

    if (this.currentBatchCount >= this.maxBatchSize) {
      await this.flush();
    }
  }

  /**
   * Flush/commit the currently accumulated batch to Firestore
   */
  async flush() {
    if (this.isDryRun || !this.currentBatch || this.currentBatchCount === 0) {
      return;
    }

    const countToCommit = this.currentBatchCount;
    try {
      await this.currentBatch.commit();
      this.totalCommittedCount += countToCommit;
      console.log(`  ✔ [BatchWriter] Committed batch of ${countToCommit} operations to /${this.collectionName} (Total: ${this.totalCommittedCount})`);
    } catch (err) {
      console.error(`  ❌ [BatchWriter Error] Failed to commit batch of ${countToCommit} docs to /${this.collectionName}:`, err.message);
      throw err;
    } finally {
      this.currentBatch = null;
      this.currentBatchCount = 0;
    }
  }

  /**
   * Finalize all pending operations
   * @returns {Promise<number>} Total operations processed/committed
   */
  async finalize() {
    if (this.isDryRun) {
      console.log(`  [Dry-Run BatchWriter] Validated ${this.totalCommittedCount} operations for /${this.collectionName}. Zero Firestore writes performed.`);
      return this.totalCommittedCount;
    }

    if (this.currentBatchCount > 0) {
      await this.flush();
    }

    console.log(`  ✔ [BatchWriter SUCCESS] Finalized total write of ${this.totalCommittedCount} operations for /${this.collectionName}.`);
    return this.totalCommittedCount;
  }
}
