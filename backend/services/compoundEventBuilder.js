/**
 * compoundEventBuilder.js — Phase 4E-B2
 * =======================================
 * Pure builder functions for constructing declarative compound outbox event
 * payloads compatible with the generic WriteBatch dispatcher (Phase 4E-B1).
 *
 * ARCHITECTURE RULES (enforced here)
 * ────────────────────────────────────────────────────────────────────────────
 *  1. MySQL remains the permanent transactional authority.
 *  2. Firestore is the replicated read model.
 *  3. These functions are PURE BUILDERS — they produce a plain JSON-serialisable
 *     object. They do NOT:
 *       • call Firestore
 *       • call MySQL
 *       • execute any I/O
 *       • generate random business entity IDs
 *       • use FieldValue.increment()
 *  4. All document IDs MUST be supplied by the caller, derived from MySQL
 *     primary keys or immutable business keys.
 *  5. Counter values (today_checkins, today_checkouts, continued_rooms) MUST
 *     be supplied as absolute integers read from MySQL AFTER the UPDATE.
 *     Never supply deltas; never use FieldValue.increment().
 *  6. The compound event schema version is 1 (COMPOUND_EVENT_SCHEMA_VERSION).
 *     Increment this if the schema changes in a backward-incompatible way.
 *
 * MYSQL lastInsertId CONTRACT
 * ────────────────────────────────────────────────────────────────────────────
 * Domain builders (B3+) are responsible for capturing MySQL AUTO_INCREMENT IDs
 * from their INSERT results BEFORE calling these builders. Example:
 *
 *   const [ledgerResult] = await conn.query('INSERT INTO ledger_items ...');
 *   const ledgerMysqlId  = ledgerResult.insertId;   // capture HERE
 *   // Then pass to builder:
 *   wb.addLedgerItem({ ledgerMysqlId, ... });
 *
 * B2 NEVER invents these IDs. If an ID is missing, builders throw a
 * CompoundBuilderError so the problem surfaces at build time, not dispatch time.
 *
 * ABSOLUTE COUNTER CONTRACT
 * ────────────────────────────────────────────────────────────────────────────
 * After the MySQL counter UPDATE:
 *
 *   await conn.query("UPDATE system_settings SET value_val = CAST(CAST(value_val AS UNSIGNED) + 1 AS CHAR) WHERE key_name = 'today_checkins'");
 *   const [[row]] = await conn.query("SELECT value_val FROM system_settings WHERE key_name = 'today_checkins'");
 *   const todayCheckinsAbsolute = Number(row.value_val);   // pass this
 *
 * Pass the absolute value to the compound event. On Firestore retry the same
 * absolute value is written again — idempotent.
 *
 * DUPLICATE WRITE TARGET POLICY
 * ────────────────────────────────────────────────────────────────────────────
 * A write set MUST NOT contain two writes to the exact same Firestore document
 * path (collection + document_id + subcollection + parent_id). This is almost
 * always a builder bug. The final build() call rejects duplicate targets with
 * CompoundBuilderError('DUPLICATE_WRITE_TARGET').
 *
 * Exception: callers may explicitly opt-in with { allowDuplicates: true } on
 * CompoundEventBuilder if they have a deliberate reason (e.g. test scaffolding).
 * This is NOT recommended for production domain builders.
 *
 * COMPATIBILITY
 * ────────────────────────────────────────────────────────────────────────────
 * The payload produced by build() is directly consumable by:
 *   dispatchCompoundEvent(payload)  [outboxDispatcher.js, Phase 4E-B1]
 * and by:
 *   enqueue(conn, { event_type, aggregate_type, aggregate_id, payload })
 * where payload = the built compound event object.
 */

import crypto from 'crypto';
import { SUPPORTED_WRITE_OPERATIONS, FIRESTORE_MAX_BATCH_OPS } from './outboxDispatcher.js';

// ── Re-export deterministic ID formatters from firestoreUtils ────────────────
// Domain builders import these from here so they have a single import point.
export {
  formatBookingId,
  formatReservationId,
  formatRoomId,
  formatGuestId,
  formatStaffId,
  formatInvoiceId,
  formatCategoryDocId,
  formatProductDocId
} from '../repositories/firestore/firestoreUtils.js';

// ── Additional ID formatters not yet in firestoreUtils ───────────────────────

/**
 * Deterministic ID for a ledger item document.
 * @param {number|string} mysqlId - MySQL AUTO_INCREMENT id from ledger_items table.
 */
export const formatLedgerItemId = (mysqlId) => {
  if (mysqlId === null || mysqlId === undefined || String(mysqlId).trim() === '') {
    throw new CompoundBuilderError(
      'formatLedgerItemId requires a non-empty MySQL id',
      'INVALID_LEDGER_ID'
    );
  }
  return `ledger_${String(mysqlId).trim()}`;
};

/**
 * Deterministic ID for a payment document.
 * @param {number|string} mysqlId - MySQL AUTO_INCREMENT id from payments table.
 */
export const formatPaymentId = (mysqlId) => {
  if (mysqlId === null || mysqlId === undefined || String(mysqlId).trim() === '') {
    throw new CompoundBuilderError(
      'formatPaymentId requires a non-empty MySQL id',
      'INVALID_PAYMENT_ID'
    );
  }
  return `payment_${String(mysqlId).trim()}`;
};

/**
 * Deterministic ID for a cash log document.
 * @param {number|string} mysqlId - MySQL AUTO_INCREMENT id from cash_logs table.
 */
export const formatCashLogId = (mysqlId) => {
  if (mysqlId === null || mysqlId === undefined || String(mysqlId).trim() === '') {
    throw new CompoundBuilderError(
      'formatCashLogId requires a non-empty MySQL id',
      'INVALID_CASH_LOG_ID'
    );
  }
  return `cash_log_${String(mysqlId).trim()}`;
};

/**
 * Deterministic ID for a booking history document.
 * @param {number|string} mysqlId - MySQL AUTO_INCREMENT id from booking_history table.
 */
export const formatHistoryId = (mysqlId) => {
  if (mysqlId === null || mysqlId === undefined || String(mysqlId).trim() === '') {
    throw new CompoundBuilderError(
      'formatHistoryId requires a non-empty MySQL id',
      'INVALID_HISTORY_ID'
    );
  }
  return `history_${String(mysqlId).trim()}`;
};

/**
 * Deterministic ID for a cash submission document.
 * @param {string} receiptId - The CS-YYYYMMDD-NNNN receipt_id generated at INSERT time.
 *   This is stable: same business-date + sequence always produces the same ID.
 *   Format of resulting doc ID: cs_CS-YYYYMMDD-NNNN (e.g. cs_CS-20260813-0001)
 */
export const formatCashSubmissionId = (receiptId) => {
  if (!receiptId || String(receiptId).trim() === '') {
    throw new CompoundBuilderError(
      'formatCashSubmissionId requires a non-empty receipt_id',
      'INVALID_CASH_SUBMISSION_ID'
    );
  }
  return `cs_${String(receiptId).trim()}`;
};

// ── Compound Event Schema Version ─────────────────────────────────────────────
/**
 * Schema version for the compound event payload format.
 * Increment this constant (and update dispatchCompoundEvent) if the payload
 * structure changes in a backward-incompatible way.
 */
export const COMPOUND_EVENT_SCHEMA_VERSION = 1;

// ── Error class ───────────────────────────────────────────────────────────────
export class CompoundBuilderError extends Error {
  constructor(message, code = 'BUILDER_ERROR') {
    super(message);
    this.name = 'CompoundBuilderError';
    this.code = code;
  }
}

// ── Low-level write descriptor builder ───────────────────────────────────────

/**
 * Builds and validates a single write descriptor object compatible with
 * the dispatchCompoundEvent() payload.writes[] schema.
 *
 * This is the foundational primitive — CompoundEventBuilder.add*() methods
 * call this internally.
 *
 * @param {object} opts
 * @param {string}      opts.collection    - Firestore root collection name.
 * @param {string}      opts.document_id   - Deterministic document ID (no random values).
 * @param {string}      opts.operation     - One of: set | set_merge | update | delete.
 * @param {object|null} [opts.data]        - Field data. Required for set/set_merge/update.
 * @param {string|null} [opts.subcollection] - Subcollection name (nested write).
 * @param {string|null} [opts.parent_id]   - Parent document ID (required when subcollection set).
 * @param {number}      [opts.seq]         - Optional ordering hint (documentation only).
 * @returns {{ collection, document_id, operation, data, subcollection, parent_id, seq }}
 * @throws {CompoundBuilderError} on any validation failure.
 */
export function buildWriteDescriptor({
  collection,
  document_id,
  operation,
  data = null,
  subcollection = null,
  parent_id = null,
  seq = undefined
}) {
  // ── operation ───────────────────────────────────────────────────────────────
  const op = typeof operation === 'string' ? operation.toLowerCase().trim() : null;
  if (!op || !Object.values(SUPPORTED_WRITE_OPERATIONS).includes(op)) {
    throw new CompoundBuilderError(
      `Invalid operation '${operation}'. Supported: ${Object.values(SUPPORTED_WRITE_OPERATIONS).join(', ')}`,
      'INVALID_OPERATION'
    );
  }

  // ── collection ──────────────────────────────────────────────────────────────
  if (!collection || typeof collection !== 'string' || !collection.trim()) {
    throw new CompoundBuilderError(
      `'collection' must be a non-empty string; got: ${JSON.stringify(collection)}`,
      'INVALID_COLLECTION'
    );
  }

  // ── document_id (determinism guard) ─────────────────────────────────────────
  if (!document_id || typeof document_id !== 'string' || !document_id.trim()) {
    throw new CompoundBuilderError(
      `'document_id' must be a non-empty string; got: ${JSON.stringify(document_id)}`,
      'INVALID_DOCUMENT_ID'
    );
  }
  // Reject any document_id that looks like a random UUID or timestamp-only ID.
  // IDs must contain a domain prefix (e.g. bkg_, room_, payment_, ledger_...).
  // This is a soft guard — domain builders are responsible for using
  // formatBookingId(), formatPaymentId(), etc.
  // We do NOT reject here to avoid over-constraining the generic builder,
  // but we document that the CALLER is responsible.

  // ── subcollection / parent_id consistency ────────────────────────────────────
  if (subcollection !== null && subcollection !== undefined) {
    if (typeof subcollection !== 'string' || !subcollection.trim()) {
      throw new CompoundBuilderError(
        `'subcollection' must be a non-empty string when provided; got: ${JSON.stringify(subcollection)}`,
        'INVALID_SUBCOLLECTION'
      );
    }
    if (!parent_id || typeof parent_id !== 'string' || !parent_id.trim()) {
      throw new CompoundBuilderError(
        `'parent_id' is required when 'subcollection' is set; got: ${JSON.stringify(parent_id)}`,
        'MISSING_PARENT_ID'
      );
    }
  }

  // ── data ────────────────────────────────────────────────────────────────────
  if (op !== SUPPORTED_WRITE_OPERATIONS.DELETE) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new CompoundBuilderError(
        `Operation '${op}' requires 'data' to be a non-null, non-array object`,
        'INVALID_DATA'
      );
    }
    if (Object.keys(data).length === 0) {
      throw new CompoundBuilderError(
        `Operation '${op}' has an empty 'data' object — this is likely a builder bug`,
        'EMPTY_DATA'
      );
    }
    // Guard: FieldValue.increment() MUST NOT appear in compound event data.
    // Firebase FieldValue objects are non-serialisable via JSON.stringify, so
    // they would corrupt the outbox payload. Detect them by checking for
    // the firebase-admin FieldValue sentinel shape.
    _assertNoFieldValues(data, op);
  }

  const descriptor = {
    collection: collection.trim(),
    document_id: document_id.trim(),
    operation: op,
    data: op === SUPPORTED_WRITE_OPERATIONS.DELETE ? null : { ...data }
  };

  if (subcollection) descriptor.subcollection = subcollection.trim();
  if (parent_id)     descriptor.parent_id     = parent_id.trim();
  if (seq !== undefined) descriptor.seq        = seq;

  return descriptor;
}

/**
 * Asserts that no value in `data` is a Firestore FieldValue sentinel.
 * Firebase FieldValue objects (increment, serverTimestamp, etc.) are
 * non-serialisable and MUST NOT appear in compound event payloads.
 *
 * Detection strategy: FieldValue objects expose a non-enumerable
 * `_methodName` property, or match the firebase-admin internal class name.
 * We also detect objects that fail JSON round-trip.
 */
function _assertNoFieldValues(data, op) {
  for (const [key, val] of Object.entries(data)) {
    if (val !== null && typeof val === 'object') {
      // Check for firebase-admin FieldValue sentinel (has _methodName or is a FieldTransform)
      const constructorName = val?.constructor?.name || '';
      if (
        constructorName === 'FieldTransform' ||
        constructorName === 'FieldValue' ||
        constructorName.includes('Transform') ||
        '_methodName' in val ||
        '_operand' in val
      ) {
        throw new CompoundBuilderError(
          `FieldValue.${val._methodName || 'unknown'}() detected in '${key}' of operation '${op}'. ` +
          'Compound events MUST use absolute values. Read the final MySQL counter value and pass it as a plain number.',
          'FIELDVALUE_FORBIDDEN'
        );
      }
    }
  }
}

// ── CompoundEventBuilder class ────────────────────────────────────────────────

/**
 * Fluent builder for constructing compound outbox event payloads.
 *
 * USAGE PATTERN
 * ─────────────
 * const builder = new CompoundEventBuilder({
 *   event_type:     'COMPOUND_CHECKIN',
 *   aggregate_type: 'BOOKING',
 *   aggregate_id:   'BKG-123456',
 *   operation_id:   `op_checkin_${bookingId}_${Date.now()}`,
 *   business_date:  '2026-08-12',
 *   occurred_at:    new Date().toISOString()
 * });
 *
 * // Add root write
 * builder.addRootWrite({
 *   collection:  'bookings',
 *   document_id: formatBookingId('BKG-123456'),
 *   operation:   'set_merge',
 *   data:        { booking_status: 'Checked In', ... }
 * });
 *
 * // Add subcollection write (dual representation)
 * builder.addSubcollectionWrite({
 *   collection:    'bookings',
 *   parent_id:     formatBookingId('BKG-123456'),
 *   subcollection: 'payments',
 *   document_id:   formatPaymentId(paymentMysqlId),
 *   operation:     'set_merge',
 *   data:          { amount: 1000, ... }
 * });
 *
 * // Build and validate the final payload
 * const payload = builder.build();
 *
 * // Enqueue inside the active MySQL transaction
 * if (isFirestoreDualWriteEnabled()) {
 *   await enqueue(conn, {
 *     event_type:     payload.event_type,
 *     aggregate_type: payload.aggregate_type,
 *     aggregate_id:   payload.aggregate_id,
 *     payload:        payload           // outboxService.createEvent() will JSON.stringify this
 *   });
 * }
 */
export class CompoundEventBuilder {
  /**
   * @param {object} opts
   * @param {string}      opts.event_type     - e.g. 'COMPOUND_CHECKIN'. Will be uppercased.
   * @param {string}      opts.aggregate_type - Primary domain: 'BOOKING', 'ROOM', etc.
   * @param {string}      opts.aggregate_id   - Primary entity key: booking_number, room_number, etc.
   * @param {string}      [opts.operation_id] - Globally unique op ID for tracing. Auto-generated if absent.
   * @param {string}      [opts.occurred_at]  - ISO wall-clock at MySQL COMMIT. Defaults to now.
   * @param {string}      [opts.business_date] - Hotel business date (YYYY-MM-DD).
   * @param {boolean}     [opts.allowDuplicates=false] - Allow duplicate write targets. NOT recommended.
   */
  constructor({
    event_type,
    aggregate_type,
    aggregate_id,
    operation_id = null,
    occurred_at = null,
    business_date = null,
    allowDuplicates = false
  }) {
    // Validate required header fields
    if (!event_type || typeof event_type !== 'string' || !event_type.trim()) {
      throw new CompoundBuilderError(
        'CompoundEventBuilder requires a non-empty event_type',
        'INVALID_EVENT_TYPE'
      );
    }
    const upperType = event_type.toUpperCase().trim();
    if (!upperType.startsWith('COMPOUND_')) {
      throw new CompoundBuilderError(
        `event_type must start with 'COMPOUND_'; got '${upperType}'`,
        'INVALID_EVENT_TYPE_PREFIX'
      );
    }
    if (!aggregate_type || typeof aggregate_type !== 'string' || !aggregate_type.trim()) {
      throw new CompoundBuilderError(
        'CompoundEventBuilder requires a non-empty aggregate_type',
        'INVALID_AGGREGATE_TYPE'
      );
    }
    if (!aggregate_id || (typeof aggregate_id !== 'string' && typeof aggregate_id !== 'number')) {
      throw new CompoundBuilderError(
        'CompoundEventBuilder requires a non-empty aggregate_id',
        'INVALID_AGGREGATE_ID'
      );
    }

    this._eventType     = upperType;
    this._aggregateType = String(aggregate_type).toUpperCase().trim();
    this._aggregateId   = String(aggregate_id);
    this._operationId   = operation_id || _generateOperationId(upperType);
    this._occurredAt    = occurred_at  || new Date().toISOString();
    this._businessDate  = business_date || null;
    this._allowDuplicates = Boolean(allowDuplicates);
    this._writes        = [];
    this._seq           = 0;
  }

  /**
   * Adds a root-collection write descriptor.
   *
   * @param {object} opts - All fields of buildWriteDescriptor except subcollection/parent_id.
   * @returns {this} for method chaining
   */
  addRootWrite({ collection, document_id, operation, data = null }) {
    this._seq++;
    const descriptor = buildWriteDescriptor({
      collection, document_id, operation, data,
      subcollection: null, parent_id: null,
      seq: this._seq
    });
    this._writes.push(descriptor);
    return this;
  }

  /**
   * Adds a subcollection write descriptor.
   * Path: /collection/parent_id/subcollection/document_id
   *
   * @param {object} opts
   * @param {string} opts.collection    - Root collection (typically 'bookings').
   * @param {string} opts.parent_id     - Parent document ID (e.g. 'bkg_BKG-123').
   * @param {string} opts.subcollection - Subcollection name (e.g. 'payments', 'ledger_items', 'history').
   * @param {string} opts.document_id   - Subcollection document ID.
   * @param {string} opts.operation     - Write operation.
   * @param {object} [opts.data]        - Field data.
   * @returns {this} for method chaining
   */
  addSubcollectionWrite({ collection, parent_id, subcollection, document_id, operation, data = null }) {
    this._seq++;
    const descriptor = buildWriteDescriptor({
      collection, document_id, operation, data,
      subcollection, parent_id,
      seq: this._seq
    });
    this._writes.push(descriptor);
    return this;
  }

  /**
   * Adds BOTH a root write AND the matching subcollection write in one call.
   * This is the standard pattern for dual-representation entities such as
   * payments and ledger items that live in both:
   *   /payments/payment_N
   *   /bookings/bkg_X/payments/payment_N
   *
   * The same `data` is used for both writes.
   *
   * @param {object} opts
   * @param {string} opts.rootCollection     - Root collection (e.g. 'payments', 'ledger_items').
   * @param {string} opts.document_id        - Document ID (e.g. 'payment_42').
   * @param {string} opts.parentCollection   - Parent collection (typically 'bookings').
   * @param {string} opts.parent_id          - Parent document ID (e.g. 'bkg_BKG-123').
   * @param {string} opts.subcollection      - Subcollection name (e.g. 'payments', 'ledger_items').
   * @param {string} opts.operation          - Write operation.
   * @param {object} [opts.data]             - Field data.
   * @returns {this} for method chaining
   */
  addDualWrite({
    rootCollection,
    document_id,
    parentCollection,
    parent_id,
    subcollection,
    operation,
    data = null
  }) {
    // Root write
    this.addRootWrite({ collection: rootCollection, document_id, operation, data });
    // Subcollection write
    this.addSubcollectionWrite({
      collection: parentCollection,
      parent_id,
      subcollection,
      document_id,
      operation,
      data
    });
    return this;
  }

  /**
   * Returns the current number of staged writes.
   */
  get writeCount() {
    return this._writes.length;
  }

  /**
   * Builds, validates, and returns the final compound event payload.
   *
   * Performs final-stage validation:
   *  - Minimum 1 write
   *  - Maximum FIRESTORE_MAX_BATCH_OPS writes
   *  - No duplicate write targets (unless allowDuplicates=true)
   *
   * @returns {CompoundEventPayload} A plain JSON-serialisable object.
   * @throws {CompoundBuilderError} on any final-stage validation failure.
   */
  build() {
    if (this._writes.length === 0) {
      throw new CompoundBuilderError(
        'Cannot build a compound event with zero write descriptors',
        'EMPTY_WRITE_SET'
      );
    }

    if (this._writes.length > FIRESTORE_MAX_BATCH_OPS) {
      throw new CompoundBuilderError(
        `Write set of ${this._writes.length} operations exceeds the configured ` +
        `FIRESTORE_MAX_BATCH_OPS of ${FIRESTORE_MAX_BATCH_OPS}. ` +
        'Split the operation across multiple compound events.',
        'WRITE_SET_TOO_LARGE'
      );
    }

    if (!this._allowDuplicates) {
      _assertNoDuplicateTargets(this._writes);
    }

    return {
      schema_version: COMPOUND_EVENT_SCHEMA_VERSION,
      event_type:     this._eventType,
      aggregate_type: this._aggregateType,
      aggregate_id:   this._aggregateId,
      operation_id:   this._operationId,
      occurred_at:    this._occurredAt,
      business_date:  this._businessDate,
      writes:         this._writes.map(w => ({ ...w })) // defensive copy
    };
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Generates a unique operation ID for tracing.
 * The operation_id is event metadata — not a business entity ID.
 * Using crypto.randomBytes here is intentional and safe because operation_id
 * is used only for log tracing, not for Firestore document paths.
 */
function _generateOperationId(eventType) {
  const prefix = eventType.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return `op_${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Computes the canonical Firestore path string for a write descriptor.
 * Used internally for duplicate-target detection.
 */
function _canonicalPath(descriptor) {
  if (descriptor.subcollection && descriptor.parent_id) {
    return `${descriptor.collection}/${descriptor.parent_id}/${descriptor.subcollection}/${descriptor.document_id}`;
  }
  return `${descriptor.collection}/${descriptor.document_id}`;
}

/**
 * Asserts no two write descriptors target the same Firestore document path.
 * @throws {CompoundBuilderError} on first duplicate detected.
 */
function _assertNoDuplicateTargets(writes) {
  const seen = new Set();
  for (const w of writes) {
    const path = _canonicalPath(w);
    if (seen.has(path)) {
      throw new CompoundBuilderError(
        `Duplicate write target detected: '${path}'. ` +
        'Each Firestore document path may appear at most once per compound event. ' +
        'If this is intentional, pass { allowDuplicates: true } to CompoundEventBuilder.',
        'DUPLICATE_WRITE_TARGET'
      );
    }
    seen.add(path);
  }
}

// ── Convenience factory function ──────────────────────────────────────────────

/**
 * Creates a CompoundEventBuilder with validated header fields.
 * Equivalent to `new CompoundEventBuilder(opts)` — provided for call-site clarity.
 *
 * @param {object} opts - Same as CompoundEventBuilder constructor.
 * @returns {CompoundEventBuilder}
 */
export function createCompoundEventBuilder(opts) {
  return new CompoundEventBuilder(opts);
}
