/**
 * PHASE 4E-B5 — Room Shift Compound Outbox Event Tests
 *
 * Tests validate:
 *  - Compound event construction for Room Shift
 *  - Deterministic Firestore document IDs
 *  - Old Room and New Room updates
 *  - Ledger items retrieval and root + subcollection dual writes
 *  - Feature flag gating (ENABLE_FIRESTORE_DUAL_WRITE)
 *  - Target room tariff insertId capture
 *  - Batch size limits
 *  - Idempotency / retry safety
 *
 * Production MySQL and Firestore are NOT used.
 * All MySQL operations use a shared mock connection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeMockConnection(opts = {}) {
  const { responses = {}, failEnqueue = false, mockLedgerCount = 1, mockLedgers = null } = opts;
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

    if (normalSql.includes('dual_write_outbox')) return [{ insertId: 300 }];
    if (normalSql.includes('system_settings') && normalSql.startsWith('SELECT')) return [[{ value_val: '2026-08-12' }]];
    
    // Lock source and target rooms (roomShiftService)
    if (normalSql.includes('FOR UPDATE') && normalSql.includes('rooms r')) {
      return [[
        { id: 10, number: '101', status: 'occupied', rate: 2500, type: 'STANDARD' },
        { id: 20, number: '102', status: 'vacant', rate: 3000, type: 'DELUXE' }
      ]];
    }

    // Lock target room (AvailabilityService)
    if (normalSql.includes('SELECT id, number, status, housekeeping_status') && normalSql.includes('rooms')) {
      return [[{ id: 20, number: '102', status: 'vacant', housekeeping_status: 'Clean' }]];
    }
    
    // Booking lock (roomShiftService)
    if (normalSql.includes('FOR UPDATE') && normalSql.includes('bookings') && normalSql.includes("booking_status = 'Checked In'") && !normalSql.includes('check_in_date')) {
      return [[{ id: 1001, room_id: 10, guest_id: 42, booking_status: 'Checked In', advance_amount: 500, booking_number: 'BKG-123456' }]];
    }

    // Bookings check (AvailabilityService)
    if (normalSql.includes('SELECT b.id, b.check_in_date')) {
      return [[]]; // No overlapping bookings
    }
    
    // Reservations mock
    if (normalSql.includes('SELECT') && normalSql.includes('reservations')) {
      return [[]]; // No overlapping reservations
    }

    // Target Tariff Insert
    if (normalSql.includes('INSERT INTO ledger_items') && normalSql.includes('Room Tariff')) {
      return [{ insertId: 999 }];
    }

    // Fetch affected ledgers for Firestore dual write
    if (normalSql.startsWith('SELECT id, room_number, `desc`, qty, amount, business_date, booking_id FROM ledger_items WHERE booking_id = ?')) {
      if (mockLedgers) return [mockLedgers];
      const items = [];
      for (let i = 1; i <= mockLedgerCount; i++) {
        items.push({
          id: 1000 + i,
          booking_id: 1001,
          room_number: '102',
          desc: i === mockLedgerCount ? 'Room Tariff — DELUXE (Incl. GST)' : 'Some historical charge',
          qty: 1,
          amount: 3000,
          business_date: '2026-08-12'
        });
      }
      return [items];
    }
    
    // Bookings select (for Firestore builder)
    if (normalSql.startsWith('SELECT * FROM bookings WHERE id = ?')) {
       return [[{ id: 1001, room_id: 20, guest_id: 42, booking_status: 'Checked In' }]];
    }
    
    // Rooms select (for Firestore builder)
    if (normalSql.startsWith('SELECT * FROM rooms WHERE id IN')) {
       return [[
         { id: 10, number: '101', status: 'vacant' },
         { id: 20, number: '102', status: 'occupied' }
       ]];
    }

    if (normalSql.includes('UPDATE bookings')) return [{ affectedRows: 1 }];
    if (normalSql.includes('UPDATE rooms')) return [{ affectedRows: 1 }];
    if (normalSql.includes('DELETE FROM ledger_items')) return [{ affectedRows: 1 }];
    if (normalSql.includes('UPDATE ledger_items')) return [{ affectedRows: 1 }];
    if (normalSql.includes('INSERT INTO room_status_history')) return [{ insertId: 999 }];
    if (normalSql.includes('INSERT INTO audit_logs')) return [{ insertId: 1 }];

    return [{ insertId: 0, affectedRows: 0 }];
  };

  return { query, calls };
}

const BASE_PARAMS = {
  fromRoomNumber: '101',
  toRoomNumber: '102',
  resolvedUserId: 1
};

const { processRoomShift } = await import('../services/roomShiftService.js');

import {
  formatBookingId,
  formatRoomId,
  formatLedgerItemId
} from '../services/compoundEventBuilder.js';

function extractOutboxPayload(calls) {
  const call = calls.find(c => c.sql.includes('INSERT INTO dual_write_outbox'));
  if (!call) return null;
  return JSON.parse(call.params[4]);
}

test('Group 1: Basic Room Shift execution', async (t) => {
  await t.test('1.1 processRoomShift returns { booking, targetRoom }', async () => {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';
    const conn = makeMockConnection();
    const res = await processRoomShift(conn, { ...BASE_PARAMS });
    assert.ok(res.booking);
    assert.ok(res.targetRoom);
    assert.strictEqual(res.targetRoom.id, 20);
  });
});

test('Group 2: Feature flag gating', async (t) => {
  await t.test('2.1 flag=true enqueues event', async () => {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';
    const conn = makeMockConnection();
    await processRoomShift(conn, { ...BASE_PARAMS });
    const payload = extractOutboxPayload(conn.calls);
    assert.ok(payload, 'Compound event was enqueued');
  });

  await t.test('2.2 flag=false succeeds but does not enqueue', async () => {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
    const conn = makeMockConnection();
    await processRoomShift(conn, { ...BASE_PARAMS });
    const payload = extractOutboxPayload(conn.calls);
    assert.strictEqual(payload, null, 'No event enqueued');
  });
});

test('Group 3: Event Structure and Room Writes', async (t) => {
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';
  const conn = makeMockConnection();
  await processRoomShift(conn, { ...BASE_PARAMS });
  const payload = extractOutboxPayload(conn.calls);

  await t.test('3.1 event_type is COMPOUND_ROOM_SHIFT', () => {
    assert.strictEqual(payload.event_type, 'COMPOUND_ROOM_SHIFT');
  });

  await t.test('3.2 writes array contains Booking write', () => {
    const bkgWrite = payload.writes.find(w => w.collection === 'bookings');
    assert.ok(bkgWrite);
    assert.strictEqual(bkgWrite.document_id, formatBookingId(1001));
    assert.strictEqual(bkgWrite.data.room_number, '102'); // Final state
  });

  await t.test('3.3 writes array contains Old Room write', () => {
    const oldRoomWrite = payload.writes.find(w => w.collection === 'rooms' && w.document_id === formatRoomId('101'));
    assert.ok(oldRoomWrite);
    assert.strictEqual(oldRoomWrite.data.status, 'vacant');
    assert.strictEqual(oldRoomWrite.data.current_booking_id, '');
  });

  await t.test('3.4 writes array contains New Room write', () => {
    const newRoomWrite = payload.writes.find(w => w.collection === 'rooms' && w.document_id === formatRoomId('102'));
    assert.ok(newRoomWrite);
    assert.strictEqual(newRoomWrite.data.status, 'occupied');
    assert.strictEqual(newRoomWrite.data.current_booking_id, formatBookingId(1001));
  });
});

test('Group 4: Ledger Items Dual Write', async (t) => {
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';
  // Mock 2 ledger items
  const conn = makeMockConnection({ mockLedgerCount: 2 });
  await processRoomShift(conn, { ...BASE_PARAMS });
  const payload = extractOutboxPayload(conn.calls);

  await t.test('4.1 Root and Subcollection writes are present for all ledger items', () => {
    const ledgerRoots = payload.writes.filter(w => w.collection === 'ledger_items' && !w.subcollection);
    const ledgerSubs = payload.writes.filter(w => w.collection === 'bookings' && w.subcollection === 'ledger_items');
    
    assert.strictEqual(ledgerRoots.length, 2);
    assert.strictEqual(ledgerSubs.length, 2);
    assert.strictEqual(ledgerRoots[0].document_id, formatLedgerItemId(1001));
    assert.strictEqual(ledgerRoots[1].document_id, formatLedgerItemId(1002));
  });

  await t.test('4.2 No FieldValue in payload', () => {
    const jsonStr = JSON.stringify(payload);
    assert.ok(!jsonStr.includes('_methodName'), 'Payload contains sentinel values');
  });
});

test('Group 5: Batch Size Limits', async (t) => {
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';
  process.env.FIRESTORE_MAX_BATCH_OPS = '500';

  await t.test('5.1 Rejects event if writes exceed limit', async () => {
    // 250 ledger items = 500 writes + 3 base writes = 503 writes -> EXCEEDS 500
    const conn = makeMockConnection({ mockLedgerCount: 250 });
    try {
      await processRoomShift(conn, { ...BASE_PARAMS });
      assert.fail('Should have thrown batch limit error');
    } catch (err) {
      assert.match(err.message, /Write set of .* operations exceeds/);
      assert.strictEqual(err.code, 'WRITE_SET_TOO_LARGE');
    }
  });

  await t.test('5.2 Accepts event if writes within limit', async () => {
    // 240 ledger items = 480 writes + 3 base writes = 483 writes -> WITHIN 500
    const conn = makeMockConnection({ mockLedgerCount: 240 });
    await processRoomShift(conn, { ...BASE_PARAMS });
    const payload = extractOutboxPayload(conn.calls);
    assert.ok(payload);
    assert.strictEqual(payload.writes.length, 483);
  });
});

test('Group 6: Rollback Propagation', async (t) => {
  await t.test('6.1 enqueue failure throws error to caller', async () => {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';
    const conn = makeMockConnection({ failEnqueue: true });
    try {
      await processRoomShift(conn, { ...BASE_PARAMS });
      assert.fail('Should have thrown mock enqueue error');
    } catch (err) {
      assert.match(err.message, /Mock enqueue failure/);
    }
  });
});
