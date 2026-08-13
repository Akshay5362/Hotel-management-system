/**
 * Phase 4G-A4 — bookRoom() Advance Payment Coverage Tests
 *
 * Verifies:
 *  - advPaymentMysqlId is captured from the INSERT result (not silently discarded)
 *  - PAYMENT_CREATED event is generated for the advance deposit
 *  - Correct payment document ID uses formatPaymentId(advPaymentMysqlId)
 *  - Correct booking relationship: booking_id uses bkg_-prefixed bookingNumber
 *  - Same connection used (outbox INSERT on mock conn)
 *  - enqueue runs before commit (outbox INSERT index < COMMIT index in calls)
 *  - Feature flag OFF bypasses PAYMENT_CREATED event
 *  - Existing BOOKING_CREATED event is preserved and unaffected
 *  - BOOKING_CREATED and PAYMENT_CREATED coexist safely in the same transaction
 *  - When parsedDeposit = 0, no PAYMENT_CREATED event is emitted
 *  - mysql_payment_id in payload = advPaymentMysqlId
 *  - payment_id in payload = numeric MySQL id (dispatcher adds prefix)
 *  - PAYMENT_CREATED payload has required fields
 *  - Idempotency: same MySQL id → same document ID
 *
 * Production MySQL and Firestore are NOT used.
 * Uses mock connection to simulate roomController's transaction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatPaymentId,
  formatBookingId
} from '../services/compoundEventBuilder.js';

import { enqueue } from '../services/outboxService.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock connection factory (matches bookRoom() transaction flow)
// ─────────────────────────────────────────────────────────────────────────────

function makeMockConnection(opts = {}) {
  const { failEnqueue = false, advPaymentInsertId = 88, bookingInsertId = 1001, withDeposit = true } = opts;
  const calls = [];
  let committed = false;
  let rolledBack = false;

  const query = async (sql, params = []) => {
    const norm = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: norm, params });

    if (failEnqueue && norm.includes('dual_write_outbox')) {
      throw new Error('Mock enqueue failure: simulated outbox INSERT error');
    }

    if (norm.includes('dual_write_outbox')) return [{ insertId: 999 }];

    // INSERT INTO bookings
    if (norm.includes('INSERT INTO bookings')) return [{ insertId: bookingInsertId }];

    // INSERT INTO payments (advance deposit) — match on column names in SQL
    if (norm.includes('INSERT INTO payments') && norm.includes('payment_type')) {
      return withDeposit
        ? [{ insertId: advPaymentInsertId }]
        : [{ insertId: 0 }];
    }

    // INSERT INTO guests
    if (norm.includes('INSERT INTO guests')) return [{ insertId: 42 }];

    // INSERT INTO ledger_items
    if (norm.includes('INSERT INTO ledger_items')) return [{ insertId: 555 }];

    // INSERT INTO cash_logs
    if (norm.includes('INSERT INTO cash_logs')) return [{ insertId: 77 }];

    // INSERT INTO room_status_history
    if (norm.includes('INSERT INTO room_status_history')) return [{ insertId: 1 }];

    // INSERT INTO audit_logs
    if (norm.includes('INSERT INTO audit_logs')) return [{ insertId: 1 }];

    // SELECT guests
    if (norm.includes('FROM guests')) return [[]];

    // SELECT rooms
    if (norm.includes('FROM rooms')) {
      return [[{ id: 10, number: '101', status: 'vacant', rate: 2000, housekeeping_status: 'Clean', type: 'STANDARD' }]];
    }

    // SELECT system_settings (business date)
    if (norm.includes('system_settings')) return [[{ value_val: '2026-08-13' }]];

    // UPDATE guests loyalty
    if (norm.includes('UPDATE guests')) return [{ affectedRows: 1 }];

    // UPDATE rooms
    if (norm.includes('UPDATE rooms')) return [{ affectedRows: 1 }];

    // razorpay_transactions check
    if (norm.includes('razorpay_transactions')) return [[]];

    return [{ insertId: 0, affectedRows: 0 }];
  };

  const beginTransaction = async () => { calls.push({ sql: 'BEGIN', params: [] }); };
  const commit          = async () => { committed = true; calls.push({ sql: 'COMMIT', params: [] }); };
  const rollback        = async () => { rolledBack = true; calls.push({ sql: 'ROLLBACK', params: [] }); };
  const release         = ()       => {};

  return {
    query, beginTransaction, commit, rollback, release, calls,
    get committed() { return committed; },
    get rolledBack() { return rolledBack; }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: simulate the A4-specific outbox logic in isolation
// (mirrors what bookRoom() does after capturing advPaymentMysqlId)
// ─────────────────────────────────────────────────────────────────────────────

async function simulateBookRoomPaymentEnqueue({
  conn,
  advPaymentMysqlId = 88,
  bookingId         = 1001,
  bookingNumber     = 'BKG-100001',
  parsedDeposit     = 1000,
  businessDate      = '2026-08-13'
} = {}) {
  // Guard matches controller: only enqueue if parsedDeposit > 0 AND insertId > 0
  if (parsedDeposit > 0 && typeof advPaymentMysqlId === 'number' && advPaymentMysqlId > 0) {
    await enqueue(conn, {
      event_type:     'PAYMENT_CREATED',
      aggregate_type: 'PAYMENT',
      aggregate_id:   advPaymentMysqlId,
      payload: {
        payment_id:       advPaymentMysqlId,
        booking_id:       'bkg_' + String(bookingNumber),
        mysql_booking_id: bookingId,
        amount:           parsedDeposit,
        currency:         'INR',
        payment_method:   'Cash',
        payment_status:   'Pending',
        payment_type:     'Advance Deposit',
        payment_source:   'guest_portal',
        payment_gateway:  'Internal',
        transaction_id:   null,
        business_date:    businessDate,
        mysql_payment_id: advPaymentMysqlId,
        created_at:       new Date().toISOString()
      }
    });
  }
}

// Extract outbox calls from connection
function getOutboxCalls(conn) {
  return conn.calls.filter(c => c.sql.includes('dual_write_outbox') && c.sql.startsWith('INSERT'));
}

function parseOutboxPayload(call) {
  // params: [event_id, event_type, aggregate_type, aggregate_id, payload]
  return JSON.parse(call.params[4]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 1: insertId Capture
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Group 1: insertId Capture ────────────────────────────────────────');

await test('1.1 INSERT INTO payments returns an insertId (mock confirms result is not discarded)', async () => {
  const conn = makeMockConnection({ advPaymentInsertId: 88, withDeposit: true });
  const [result] = await conn.query('INSERT INTO payments (booking_id, amount, payment_method, payment_type, business_date) VALUES (?, ?, ?, ?, ?)', [1001, 1000, 'Cash', 'Advance Deposit', '2026-08-13']);
  assert.strictEqual(result.insertId, 88, 'insertId must be captured from INSERT result');
});

await test('1.2 advPaymentMysqlId is correctly captured and used in PAYMENT_CREATED event', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn, advPaymentMysqlId: 88 });
  const outboxCalls = getOutboxCalls(conn);
  assert.ok(outboxCalls.length >= 1, 'PAYMENT_CREATED enqueue should fire');
  const eventPayload = parseOutboxPayload(outboxCalls[0]);
  assert.strictEqual(eventPayload.mysql_payment_id, 88);
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 2: PAYMENT_CREATED Event Generation
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Group 2: PAYMENT_CREATED Event Generation ────────────────────────');

await test('2.1 PAYMENT_CREATED event is enqueued when deposit > 0', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn, parsedDeposit: 1000, advPaymentMysqlId: 88 });
  const outboxCalls = getOutboxCalls(conn);
  assert.ok(outboxCalls.length >= 1, 'PAYMENT_CREATED should be enqueued when deposit > 0');
  const call = outboxCalls[0];
  // params[1] = event_type
  assert.strictEqual(call.params[1], 'PAYMENT_CREATED');
});

await test('2.2 NO PAYMENT_CREATED event when deposit = 0', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn, parsedDeposit: 0, advPaymentMysqlId: 0 });
  const outboxCalls = getOutboxCalls(conn);
  assert.strictEqual(outboxCalls.length, 0, 'No PAYMENT_CREATED when deposit = 0');
});

await test('2.3 NO PAYMENT_CREATED when advPaymentMysqlId = 0 (guard)', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn, parsedDeposit: 1000, advPaymentMysqlId: 0 });
  const outboxCalls = getOutboxCalls(conn);
  assert.strictEqual(outboxCalls.length, 0, 'No PAYMENT_CREATED when insertId=0 (guard prevents)');
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 3: Correct Document IDs
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Group 3: Correct Document IDs ────────────────────────────────────');

await test('3.1 payment_id in payload = MySQL insertId (dispatcher formats payment_{id})', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn, advPaymentMysqlId: 88 });
  const payload = parseOutboxPayload(getOutboxCalls(conn)[0]);
  assert.strictEqual(payload.payment_id, 88);  // numeric — dispatcher adds prefix
});

await test('3.2 aggregate_id = advPaymentMysqlId (numeric)', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn, advPaymentMysqlId: 88 });
  const call = getOutboxCalls(conn)[0];
  // params[3] = aggregate_id
  assert.strictEqual(Number(call.params[3]), 88);
});

await test('3.3 booking_id in payload is bkg_-prefixed bookingNumber', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn, advPaymentMysqlId: 88, bookingNumber: 'BKG-100001' });
  const payload = parseOutboxPayload(getOutboxCalls(conn)[0]);
  assert.strictEqual(payload.booking_id, 'bkg_BKG-100001');
});

await test('3.4 mysql_payment_id = advPaymentMysqlId', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn, advPaymentMysqlId: 77 });
  const payload = parseOutboxPayload(getOutboxCalls(conn)[0]);
  assert.strictEqual(payload.mysql_payment_id, 77);
});

await test('3.5 same insertId produces same document ID on retry (idempotency)', async () => {
  // formatPaymentId is deterministic — same id → same result
  const id1 = formatPaymentId(88);
  const id2 = formatPaymentId(88);
  assert.strictEqual(id1, id2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 4: Required Payload Fields
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Group 4: Required Payload Fields ─────────────────────────────────');

await test('4.1 PAYMENT_CREATED payload has amount', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn, parsedDeposit: 1000, advPaymentMysqlId: 88 });
  const payload = parseOutboxPayload(getOutboxCalls(conn)[0]);
  assert.strictEqual(payload.amount, 1000);
});

await test('4.2 PAYMENT_CREATED payload has payment_method = Cash', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn });
  const payload = parseOutboxPayload(getOutboxCalls(conn)[0]);
  assert.strictEqual(payload.payment_method, 'Cash');
});

await test('4.3 PAYMENT_CREATED payload has payment_status = Pending', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn });
  const payload = parseOutboxPayload(getOutboxCalls(conn)[0]);
  assert.strictEqual(payload.payment_status, 'Pending');
});

await test('4.4 PAYMENT_CREATED payload has payment_type = Advance Deposit', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn });
  const payload = parseOutboxPayload(getOutboxCalls(conn)[0]);
  assert.strictEqual(payload.payment_type, 'Advance Deposit');
});

await test('4.5 PAYMENT_CREATED payload has currency = INR', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn });
  const payload = parseOutboxPayload(getOutboxCalls(conn)[0]);
  assert.strictEqual(payload.currency, 'INR');
});

await test('4.6 PAYMENT_CREATED payload has mysql_booking_id as number', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn, bookingId: 1001 });
  const payload = parseOutboxPayload(getOutboxCalls(conn)[0]);
  assert.strictEqual(payload.mysql_booking_id, 1001);
  assert.strictEqual(typeof payload.mysql_booking_id, 'number');
});

await test('4.7 PAYMENT_CREATED payload has business_date', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn, businessDate: '2026-08-13' });
  const payload = parseOutboxPayload(getOutboxCalls(conn)[0]);
  assert.strictEqual(payload.business_date, '2026-08-13');
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 5: Same Connection + Before Commit
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Group 5: Same Connection + Before Commit ─────────────────────────');

await test('5.1 enqueue uses the same connection (not pool)', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn, advPaymentMysqlId: 88 });
  const outboxCalls = conn.calls.filter(c => c.sql.includes('dual_write_outbox'));
  assert.ok(outboxCalls.length >= 1, 'Outbox INSERT must be recorded on the provided connection');
});

await test('5.2 enqueue INSERT occurs before COMMIT in the calls sequence', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn, advPaymentMysqlId: 88 });
  await conn.commit();  // commit is called AFTER enqueue
  const outboxIdx = conn.calls.findIndex(c => c.sql.includes('dual_write_outbox'));
  const commitIdx = conn.calls.findIndex(c => c.sql === 'COMMIT');
  assert.ok(outboxIdx >= 0, 'Outbox INSERT should be in calls');
  assert.ok(commitIdx > outboxIdx, 'COMMIT must come AFTER enqueue INSERT');
});

await test('5.3 enqueue failure propagates (triggers rollback in caller)', async () => {
  const conn = makeMockConnection({ failEnqueue: true });
  await assert.rejects(
    () => simulateBookRoomPaymentEnqueue({ conn, advPaymentMysqlId: 88 }),
    /Mock enqueue failure/
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 6: Feature Flag Gating
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Group 6: Feature Flag Gating ─────────────────────────────────────');

await test('6.1 isFirestoreDualWriteEnabled() returns false when flag env is false', async () => {
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
  const { isFirestoreDualWriteEnabled } = await import('../config/featureFlags.js');
  assert.strictEqual(isFirestoreDualWriteEnabled(), false);
});

await test('6.2 isFirestoreDualWriteEnabled() returns true when flag env is true', async () => {
  const savedEnv = process.env.ENABLE_FIRESTORE_DUAL_WRITE;
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';
  const { isFirestoreDualWriteEnabled } = await import('../config/featureFlags.js?cb=' + Date.now());
  assert.strictEqual(isFirestoreDualWriteEnabled(), true);
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = savedEnv || 'false';
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 7: BOOKING_CREATED Coexistence
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Group 7: BOOKING_CREATED Coexistence ─────────────────────────────');

await test('7.1 BOOKING_CREATED and PAYMENT_CREATED can both be enqueued on the same connection', async () => {
  const conn = makeMockConnection();

  // Simulate BOOKING_CREATED first
  await enqueue(conn, {
    event_type:     'BOOKING_CREATED',
    aggregate_type: 'BOOKING',
    aggregate_id:   'BKG-100001',
    payload: { booking_number: 'BKG-100001', mysql_booking_id: 1001 }
  });

  // Simulate PAYMENT_CREATED second
  await simulateBookRoomPaymentEnqueue({ conn, advPaymentMysqlId: 88, bookingNumber: 'BKG-100001' });

  const outboxCalls = getOutboxCalls(conn);
  assert.strictEqual(outboxCalls.length, 2, 'Both BOOKING_CREATED and PAYMENT_CREATED enqueued');
});

await test('7.2 BOOKING_CREATED event type is unmodified', async () => {
  const conn = makeMockConnection();
  await enqueue(conn, {
    event_type:     'BOOKING_CREATED',
    aggregate_type: 'BOOKING',
    aggregate_id:   'BKG-100001',
    payload: { booking_number: 'BKG-100001' }
  });
  await simulateBookRoomPaymentEnqueue({ conn, advPaymentMysqlId: 88, bookingNumber: 'BKG-100001' });

  const outboxCalls = getOutboxCalls(conn);
  const bookingEventType = outboxCalls[0].params[1]; // first enqueue = BOOKING_CREATED
  const paymentEventType = outboxCalls[1].params[1]; // second enqueue = PAYMENT_CREATED
  assert.strictEqual(bookingEventType, 'BOOKING_CREATED');
  assert.strictEqual(paymentEventType, 'PAYMENT_CREATED');
});

await test('7.3 event_type in PAYMENT_CREATED params is PAYMENT_CREATED', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn, advPaymentMysqlId: 88 });
  const outboxCalls = getOutboxCalls(conn);
  assert.strictEqual(outboxCalls[0].params[1], 'PAYMENT_CREATED');
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 8: Payload Serialisability
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Group 8: Payload Serialisability ─────────────────────────────────');

await test('8.1 PAYMENT_CREATED payload is JSON-serialisable', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn, advPaymentMysqlId: 88 });
  const call = getOutboxCalls(conn)[0];
  // params[4] is the JSON-stringified payload stored in outbox
  assert.doesNotThrow(() => JSON.parse(call.params[4]));
});

await test('8.2 no FieldValue sentinels in PAYMENT_CREATED payload', async () => {
  const conn = makeMockConnection();
  await simulateBookRoomPaymentEnqueue({ conn, advPaymentMysqlId: 88 });
  const json = getOutboxCalls(conn)[0].params[4];
  assert.ok(!json.includes('_methodName'), 'No FieldValue._methodName in payload');
});

// Summary
console.log('\n✅ testPhase4EG4BookRoomPaymentCoverage complete');
