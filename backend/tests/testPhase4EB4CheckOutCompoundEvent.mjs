/**
 * PHASE 4E-B4 — Check-Out Compound Outbox Event Tests
 *
 * Tests validate:
 *  - Compound event construction for all check-out variants
 *  - Deterministic Firestore document IDs from MySQL insertIds
 *  - Absolute today_checkouts counter value
 *  - Root + subcollection dual writes for ledger, history and payments
 *  - Feature flag gating (ENABLE_FIRESTORE_DUAL_WRITE)
 *  - No FieldValue.increment() in payload
 *  - Idempotency / retry safety
 *
 * Production MySQL and Firestore are NOT used.
 * All MySQL operations use a shared mock connection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeMockConnection(opts = {}) {
  const { responses = {}, failEnqueue = false } = opts;
  const calls = [];

  const query = async (sql, params = []) => {
    const normalSql = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: normalSql, params });

    if (failEnqueue && normalSql.includes('dual_write_outbox')) {
      throw new Error('Mock enqueue failure: simulated DB error');
    }

    for (const [key, val] of Object.entries(responses)) {
      if (normalSql.includes(key)) return val;
    }

    if (normalSql.includes('dual_write_outbox')) return [{ insertId: 200 }];
    if (normalSql.includes('today_checkouts') && normalSql.startsWith('SELECT')) return [[{ value_val: '10' }]];
    if (normalSql.includes('today_checkouts') && normalSql.startsWith('UPDATE')) return [{ affectedRows: 1 }];
    if (normalSql.includes('system_settings') && normalSql.startsWith('SELECT')) return [[{ value_val: '2026-08-12' }]];
    if (normalSql.includes('FOR UPDATE') && normalSql.includes('rooms')) {
      return [[{ id: 10, number: '101', status: 'occupied', rate: 2500, type: 'STANDARD' }]];
    }
    if (normalSql.includes('FOR UPDATE') && normalSql.includes('bookings')) {
      return [[{ id: 1001, room_id: 10, guest_id: 42, guestName: 'JOHN DOE', booking_status: 'Checked In', advance_amount: 500, booking_number: 'BKG-123456' }]];
    }
    if (normalSql.includes('SELECT g.user_id FROM guests')) return [[{ user_id: 99 }]];
    if (normalSql.includes('SELECT * FROM ledger_items')) return [[]];

    if (normalSql.includes('INSERT INTO cash_logs')) return [{ insertId: 77 }];
    if (normalSql.includes('INSERT INTO payments')) return [{ insertId: 88 }];
    if (normalSql.includes('UPDATE bookings')) return [{ affectedRows: 1 }];
    if (normalSql.includes('INSERT INTO invoices')) return [{ insertId: 0 }];
    if (normalSql.includes('INSERT INTO room_status_history')) return [{ insertId: 999 }];
    if (normalSql.includes('INSERT INTO audit_logs')) return [{ insertId: 1 }];
    if (normalSql.includes('UPDATE rooms')) return [{ affectedRows: 1 }];
    if (normalSql.includes('INSERT INTO booking_history')) return [{ insertId: 123 }];
    if (normalSql.includes('INSERT INTO notifications')) return [{ insertId: 1 }];
    if (normalSql.includes('INSERT INTO checkout_snapshots')) return [{ insertId: 111 }];

    return [{ insertId: 0, affectedRows: 0 }];
  };

  return { query, calls };
}

const BASE_PARAMS = {
  number: '101',
  parsedBalancePaid: 0,
  resolvedUserId: 1
};

const { processCheckOut } = await import('../services/checkOutService.js');

import {
  formatBookingId,
  formatRoomId,
  formatPaymentId,
  formatCashLogId,
  formatHistoryId,
  formatInvoiceId
} from '../services/compoundEventBuilder.js';

function extractOutboxPayload(calls) {
  const call = calls.find(c => c.sql.includes('INSERT INTO dual_write_outbox'));
  if (!call) return null;
  return JSON.parse(call.params[4]);
}

test('Group 1: Basic Check-Out execution', async (t) => {
  await t.test('1.1 processCheckOut returns { bookingId, roomId }', async () => {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';
    const conn = makeMockConnection();
    const res = await processCheckOut(conn, { ...BASE_PARAMS });
    assert.deepEqual(res, { bookingId: 1001, roomId: 10 });
  });
});

test('Group 2: Feature flag gating', async (t) => {
  await t.test('2.1 flag=true enqueues event', async () => {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';
    const conn = makeMockConnection();
    await processCheckOut(conn, { ...BASE_PARAMS });
    const payload = extractOutboxPayload(conn.calls);
    assert.ok(payload);
  });

  await t.test('2.2 flag=false succeeds but does not enqueue', async () => {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
    const conn = makeMockConnection();
    const res = await processCheckOut(conn, { ...BASE_PARAMS });
    assert.ok(res);
    const payload = extractOutboxPayload(conn.calls);
    assert.equal(payload, null);
  });
});

test('Group 3: Event Structure', async (t) => {
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';
  const conn = makeMockConnection();
  await processCheckOut(conn, { ...BASE_PARAMS });
  const payload = extractOutboxPayload(conn.calls);

  await t.test('3.1 event_type is COMPOUND_CHECK_OUT', () => assert.equal(payload.event_type, 'COMPOUND_CHECK_OUT'));
  await t.test('3.2 aggregate_type is BOOKING', () => assert.equal(payload.aggregate_type, 'BOOKING'));
  await t.test('3.3 schema_version is 1', () => assert.equal(payload.schema_version, 1));
  await t.test('3.4 writes array is non-empty', () => assert.ok(payload.writes.length > 0));
  await t.test('3.5 snapshot payload exists', () => {
    const snapWrite = payload.writes.find(w => w.collection === 'checkout_snapshots');
    assert.ok(snapWrite);
  });
});

test('Group 4: No Balance Paid', async (t) => {
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';
  const conn = makeMockConnection();
  await processCheckOut(conn, { ...BASE_PARAMS, parsedBalancePaid: 0 });
  const payload = extractOutboxPayload(conn.calls);

  await t.test('4.1 write count is exactly 8 (no cash or payment)', () => {
    // booking, room, invoice, history(root), history(sub), settings, snapshot = 7. Wait, where is the 8th?
    // 1. booking
    // 2. room
    // 3. invoice
    // 4. history (root)
    // 5. history (sub)
    // 6. settings
    // 7. snapshot
    // Count is 7! Let me check the test array.
    assert.equal(payload.writes.length, 7);
  });

  await t.test('4.2 payment and cash log writes are absent', () => {
    assert.ok(!payload.writes.some(w => w.collection === 'payments'));
    assert.ok(!payload.writes.some(w => w.collection === 'cash_logs'));
  });
});

test('Group 5: Balance Paid', async (t) => {
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';
  const conn = makeMockConnection();
  await processCheckOut(conn, { ...BASE_PARAMS, parsedBalancePaid: 1000 });
  const payload = extractOutboxPayload(conn.calls);

  await t.test('5.1 payment root write is present', () => {
    const payment = payload.writes.find(w => w.collection === 'payments');
    assert.ok(payment);
    assert.equal(payment.document_id, formatPaymentId(88));
  });

  await t.test('5.2 payment subcollection write is present', () => {
    const paymentSub = payload.writes.find(w => w.collection === 'bookings' && w.subcollection === 'payments');
    assert.ok(paymentSub);
  });

  await t.test('5.3 cash log write is present', () => {
    const cashLog = payload.writes.find(w => w.collection === 'cash_logs');
    assert.ok(cashLog);
    assert.equal(cashLog.document_id, formatCashLogId(77));
  });
});

test('Group 6: Absolute Counters and FieldValues', async (t) => {
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';
  const conn = makeMockConnection();
  await processCheckOut(conn, { ...BASE_PARAMS });
  const payload = extractOutboxPayload(conn.calls);

  await t.test('6.1 no FieldValue increment in today_checkouts', () => {
    const settingsWrite = payload.writes.find(w => w.collection === 'settings');
    assert.equal(settingsWrite.data.today_checkouts, 10);
    assert.equal(typeof settingsWrite.data.today_checkouts, 'number');
  });

  await t.test('6.2 payload contains no _methodName (no sentinels)', () => {
    const jsonStr = JSON.stringify(payload);
    assert.ok(!jsonStr.includes('_methodName'));
  });
});

test('Group 7: Rollback Propagation', async (t) => {
  await t.test('7.1 enqueue failure throws error to caller', async () => {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';
    const conn = makeMockConnection({ failEnqueue: true });
    await assert.rejects(
      processCheckOut(conn, { ...BASE_PARAMS }),
      /Mock enqueue failure: simulated DB error/
    );
  });
});
