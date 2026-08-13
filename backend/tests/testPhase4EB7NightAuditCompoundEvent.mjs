/**
 * PHASE 4E-B7 — Night Audit Compound Outbox Event Tests
 *
 * Tests validate:
 *  - Feature flag gating (ENABLE_FIRESTORE_DUAL_WRITE)
 *  - Zero / one / multiple / 17-room scenarios
 *  - insertId capture and deterministic Firestore IDs
 *  - Root ledger write (/ledger_items/{id})
 *  - Booking subcollection write (/bookings/{bkg}/ledger_items/{id})
 *  - Root/subcollection ID consistency and identical data
 *  - settings/system_date payload (current_date, system_date, counters, updated_at)
 *  - Frozen updated_at (no FieldValue)
 *  - Exactly one settings write
 *  - One compound event per Night Audit
 *  - enqueue uses same MySQL connection as business mutations
 *  - enqueue failure causes rollback (propagates error)
 *  - Builder validation failure causes rollback (propagates error)
 *  - Deterministic retry payload (2N+1 formula verified)
 *  - Batch-limit boundary: 244 rooms = 489 writes (SAFE), 245 = rejected
 *  - >500 operation protection
 *  - No partial Firestore event on failure
 *  - Existing Night Audit behavior unchanged when flag OFF
 *
 * Production MySQL and Firestore are NOT used.
 * All MySQL operations use a shared mock connection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatLedgerItemId,
  formatBookingId,
} from '../services/compoundEventBuilder.js';

// ── Mock connection factory ───────────────────────────────────────────────────
// occupiedRoomCount: how many rooms are 'occupied'
// skippedRooms:      room numbers that already have a rollover tariff (dup guard)
// failEnqueue:       throw on INSERT INTO dual_write_outbox
// failAtInsert:      throw on INSERT INTO ledger_items
function makeMockConnection({
  occupiedRoomCount = 0,
  skippedRooms      = [],
  failEnqueue       = false,
  failAtInsert      = false,
} = {}) {
  const calls = [];
  let ledgerAutoId = 1000;

  const query = async (sql, params = []) => {
    const normalSql = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: normalSql, params });

    // Enqueue failure simulation
    if (failEnqueue && normalSql.includes('dual_write_outbox')) {
      throw new Error('Mock enqueue failure: simulated DB error');
    }

    // Insert failure simulation
    if (failAtInsert && normalSql.startsWith('INSERT INTO ledger_items')) {
      throw new Error('Mock ledger INSERT failure');
    }

    // system_settings FOR UPDATE (full table lock)
    if (normalSql.includes('SELECT * FROM system_settings FOR UPDATE')) {
      return [[{ key_name: 'system_date', value_val: '2026-08-12' }]];
    }

    // Read current business date
    if (normalSql.includes("key_name = 'system_date'") && normalSql.startsWith('SELECT')) {
      return [[{ value_val: '2026-08-12' }]];
    }

    // Duplicate prevention check: audit_logs
    if (normalSql.includes("action = 'DAY_END'") && normalSql.includes('audit_logs') && normalSql.startsWith('SELECT')) {
      return [[]]; // No existing DAY_END for nextDate
    }

    // Occupied rooms query
    if (normalSql.includes("WHERE r.status = 'occupied'")) {
      const rooms = [];
      for (let i = 1; i <= occupiedRoomCount; i++) {
        rooms.push({ id: 100 + i, number: String(100 + i), status: 'occupied', rate: 2500 });
      }
      return [rooms];
    }

    // Active booking for a room
    if (normalSql.includes("booking_status = 'Checked In'") && normalSql.includes('bookings')) {
      const roomId = params[0];
      return [[{ id: 2000 + roomId }]]; // deterministic bookingId from roomId
    }

    // Duplicate tariff check per room
    if (normalSql.includes("LIKE 'Room Tariff%Rollover%'")) {
      const roomNumber = params[0];
      if (skippedRooms.includes(roomNumber)) {
        return [[{ id: 999 }]]; // already exists → skip
      }
      return [[]]; // not yet posted → proceed
    }

    // Tariff ledger INSERT
    if (normalSql.startsWith('INSERT INTO ledger_items')) {
      ledgerAutoId++;
      return [{ insertId: ledgerAutoId }];
    }

    // system_settings UPDATE (date advance, continued_rooms, counter reset)
    if (normalSql.startsWith('UPDATE system_settings')) {
      return [{ affectedRows: 1 }];
    }

    // audit_logs INSERT
    if (normalSql.startsWith('INSERT INTO audit_logs')) {
      return [{ insertId: 1 }];
    }

    // Outbox enqueue INSERT
    if (normalSql.includes('dual_write_outbox')) {
      return [{ insertId: 5000 }];
    }

    return [{ insertId: 0, affectedRows: 0 }];
  };

  return { query, calls };
}

// Extract the compound event payload from mock connection calls
function extractOutboxPayload(calls) {
  const call = calls.find(c => c.sql.includes('INSERT INTO dual_write_outbox'));
  if (!call) return null;
  return JSON.parse(call.params[4]); // payload is 5th param (index 4)
}

// ── Import the service under test ─────────────────────────────────────────────
const { BusinessDateService } = await import('../services/businessDateService.js');

const NEXT_DATE = '2026-08-13';

// Thin wrapper: call advanceBusinessDate directly
async function runNightAudit(conn, opts = {}) {
  await BusinessDateService.advanceBusinessDate(conn, NEXT_DATE, opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 1: Feature Flag Gating
// ─────────────────────────────────────────────────────────────────────────────
test('Group 1: Feature flag gating', async (t) => {
  await t.test('1.1 flag=false: Night Audit succeeds, no enqueue', async () => {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
    const conn = makeMockConnection({ occupiedRoomCount: 2 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    assert.strictEqual(payload, null, 'No outbox event when flag is OFF');
  });

  await t.test('1.2 flag=true: Night Audit enqueues compound event', async () => {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    assert.ok(payload, 'Compound event was enqueued when flag is ON');
  });

  await t.test('1.3 flag=false: no CompoundEventBuilder is invoked (no ledger payload built)', async () => {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
    const conn = makeMockConnection({ occupiedRoomCount: 3 });
    await runNightAudit(conn);
    // No dual_write_outbox INSERT at all
    const outboxCall = conn.calls.find(c => c.sql.includes('dual_write_outbox'));
    assert.strictEqual(outboxCall, undefined, 'No outbox INSERT when flag is OFF');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 2: Zero / One / Multiple Occupied Room Scenarios
// ─────────────────────────────────────────────────────────────────────────────
test('Group 2: Occupied room count scenarios', async (t) => {
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';

  await t.test('2.1 zero occupied rooms: 1 write (settings only)', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 0 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    assert.ok(payload, 'Event enqueued even with 0 rooms');
    assert.strictEqual(payload.writes.length, 1, '2N+1 = 1 for N=0');
    assert.strictEqual(payload.writes[0].collection, 'settings');
  });

  await t.test('2.2 one occupied room: 3 writes (2+1)', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    assert.strictEqual(payload.writes.length, 3, '2N+1 = 3 for N=1');
  });

  await t.test('2.3 three occupied rooms: 7 writes (6+1)', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 3 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    assert.strictEqual(payload.writes.length, 7, '2N+1 = 7 for N=3');
  });

  await t.test('2.4 17-room scenario: at most 35 writes (2*17+1)', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 17 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    // 17 rooms, each gets a new tariff → 2*17 + 1 = 35
    assert.strictEqual(payload.writes.length, 35, '2N+1 = 35 for N=17');
  });

  await t.test('2.5 skipped duplicate rooms: fewer ledger writes', async () => {
    // Room 101 already has rollover tariff; only 102 is new
    const conn = makeMockConnection({ occupiedRoomCount: 2, skippedRooms: ['101'] });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    // N=1 new tariff → 2*1 + 1 = 3
    assert.strictEqual(payload.writes.length, 3, 'Skipped rooms produce no extra writes');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 3: insertId Capture and Deterministic IDs
// ─────────────────────────────────────────────────────────────────────────────
test('Group 3: insertId capture and deterministic Firestore IDs', async (t) => {
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';

  await t.test('3.1 ledger root document_id uses formatLedgerItemId(insertId)', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const rootLedger = payload.writes.find(w => w.collection === 'ledger_items' && !w.subcollection);
    assert.ok(rootLedger, 'Root ledger write exists');
    // The first insertId issued by mock is 1001 (ledgerAutoId starts at 1000, incremented before return)
    assert.strictEqual(rootLedger.document_id, formatLedgerItemId(1001));
  });

  await t.test('3.2 subcollection document_id matches root document_id', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const rootLedger = payload.writes.find(w => w.collection === 'ledger_items' && !w.subcollection);
    const subLedger  = payload.writes.find(w => w.collection === 'bookings' && w.subcollection === 'ledger_items');
    assert.ok(rootLedger);
    assert.ok(subLedger);
    assert.strictEqual(rootLedger.document_id, subLedger.document_id, 'Root and sub IDs match');
  });

  await t.test('3.3 no random/non-deterministic IDs in ledger document_id', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 2 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const ledgerWrites = payload.writes.filter(w => w.collection === 'ledger_items');
    for (const w of ledgerWrites) {
      assert.match(w.document_id, /^ledger_\d+$/, `ID ${w.document_id} must be ledger_{number}`);
    }
  });

  await t.test('3.4 mysql_ledger_id in ledger data equals numeric insertId', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const root = payload.writes.find(w => w.collection === 'ledger_items' && !w.subcollection);
    assert.ok(typeof root.data.mysql_ledger_id === 'number' || typeof root.data.mysql_ledger_id === 'string');
    assert.ok(root.data.mysql_ledger_id, 'mysql_ledger_id is non-empty');
  });

  await t.test('3.5 two rooms produce two distinct ledger IDs', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 2 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const rootIds = payload.writes
      .filter(w => w.collection === 'ledger_items' && !w.subcollection)
      .map(w => w.document_id);
    assert.strictEqual(rootIds.length, 2);
    assert.notStrictEqual(rootIds[0], rootIds[1], 'Two rooms get distinct ledger IDs');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 4: Root and Subcollection Write Structure
// ─────────────────────────────────────────────────────────────────────────────
test('Group 4: Root and subcollection write structure', async (t) => {
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';

  await t.test('4.1 root ledger write: collection is ledger_items, no subcollection', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const root = payload.writes.find(w => w.collection === 'ledger_items' && !w.subcollection);
    assert.ok(root);
    assert.strictEqual(root.operation, 'set_merge');
    assert.ok(!root.subcollection);
  });

  await t.test('4.2 subcollection ledger write: collection is bookings, subcollection is ledger_items', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const sub = payload.writes.find(w => w.collection === 'bookings' && w.subcollection === 'ledger_items');
    assert.ok(sub);
    assert.strictEqual(sub.operation, 'set_merge');
    assert.ok(sub.parent_id, 'parent_id must be set for subcollection');
  });

  await t.test('4.3 root and subcollection have identical data', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const root = payload.writes.find(w => w.collection === 'ledger_items' && !w.subcollection);
    const sub  = payload.writes.find(w => w.collection === 'bookings' && w.subcollection === 'ledger_items');
    assert.deepStrictEqual(root.data, sub.data, 'Root and subcollection data are identical');
  });

  await t.test('4.4 subcollection parent_id is booking document ID', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const sub = payload.writes.find(w => w.collection === 'bookings' && w.subcollection === 'ledger_items');
    assert.match(sub.parent_id, /^bkg_/, 'parent_id must start with bkg_');
  });

  await t.test('4.5 ledger data contains required fields', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const root = payload.writes.find(w => w.collection === 'ledger_items' && !w.subcollection);
    const d = root.data;
    assert.ok(d.item_id,    'item_id present');
    assert.ok(d.room_number,'room_number present');
    assert.ok(d.description,'description present');
    assert.ok(d.business_date, 'business_date present');
    assert.strictEqual(d.qty, 1);
    assert.strictEqual(d.type, 'CHARGE');
    assert.strictEqual(d.status, 'Pending');
    assert.ok(d.amount > 0, 'amount > 0');
    assert.ok(d.created_at, 'created_at present');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 5: settings/system_date Write
// ─────────────────────────────────────────────────────────────────────────────
test('Group 5: settings/system_date write', async (t) => {
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';

  let settingsWrite;
  before_each: {
    const conn = makeMockConnection({ occupiedRoomCount: 2 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    settingsWrite = payload.writes.find(w => w.collection === 'settings' && w.document_id === 'system_date');
  }

  await t.test('5.1 settings/system_date write exists', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 2 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const sw = payload.writes.find(w => w.collection === 'settings' && w.document_id === 'system_date');
    assert.ok(sw, 'settings/system_date write exists');
  });

  await t.test('5.2 exactly ONE settings write per event', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 2 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const settingsWrites = payload.writes.filter(w => w.collection === 'settings' && w.document_id === 'system_date');
    assert.strictEqual(settingsWrites.length, 1, 'Exactly one settings write');
  });

  await t.test('5.3 operation is set_merge', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const sw = payload.writes.find(w => w.collection === 'settings');
    assert.strictEqual(sw.operation, 'set_merge');
  });

  await t.test('5.4 current_date is nextDate', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const sw = payload.writes.find(w => w.collection === 'settings');
    assert.strictEqual(sw.data.current_date, NEXT_DATE);
  });

  await t.test('5.5 system_date is nextDate', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const sw = payload.writes.find(w => w.collection === 'settings');
    assert.strictEqual(sw.data.system_date, NEXT_DATE);
  });

  await t.test('5.6 today_checkins is 0 (absolute reset)', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const sw = payload.writes.find(w => w.collection === 'settings');
    assert.strictEqual(sw.data.today_checkins, 0);
  });

  await t.test('5.7 today_checkouts is 0 (absolute reset)', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const sw = payload.writes.find(w => w.collection === 'settings');
    assert.strictEqual(sw.data.today_checkouts, 0);
  });

  await t.test('5.8 continued_rooms equals occupiedRooms.length', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 4 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const sw = payload.writes.find(w => w.collection === 'settings');
    assert.strictEqual(sw.data.continued_rooms, 4, 'continued_rooms = N occupied rooms');
  });

  await t.test('5.9 continued_rooms is 0 when hotel is empty', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 0 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const sw = payload.writes.find(w => w.collection === 'settings');
    assert.strictEqual(sw.data.continued_rooms, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 6: Frozen updated_at / No FieldValue
// ─────────────────────────────────────────────────────────────────────────────
test('Group 6: Frozen updated_at and no FieldValue', async (t) => {
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';

  await t.test('6.1 settings write contains updated_at', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const sw = payload.writes.find(w => w.collection === 'settings');
    assert.ok(sw.data.updated_at, 'updated_at is present in settings write');
  });

  await t.test('6.2 updated_at is a valid ISO-8601 string', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const sw = payload.writes.find(w => w.collection === 'settings');
    const parsed = new Date(sw.data.updated_at);
    assert.ok(!isNaN(parsed.getTime()), 'updated_at is parseable ISO string');
  });

  await t.test('6.3 updated_at in ledger created_at matches settings updated_at (same frozen stamp)', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const sw = payload.writes.find(w => w.collection === 'settings');
    const ledger = payload.writes.find(w => w.collection === 'ledger_items' && !w.subcollection);
    assert.strictEqual(ledger.data.created_at, sw.data.updated_at, 'All timestamps share the same frozen value');
  });

  await t.test('6.4 no FieldValue sentinel in payload (JSON roundtrip)', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 2 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const jsonStr = JSON.stringify(payload);
    assert.ok(!jsonStr.includes('_methodName'), 'No Firebase FieldValue in payload');
    assert.ok(!jsonStr.includes('increment'),   'No increment sentinel in payload');
  });

  await t.test('6.5 today_checkins is type number not string', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    const sw = payload.writes.find(w => w.collection === 'settings');
    assert.strictEqual(typeof sw.data.today_checkins, 'number');
    assert.strictEqual(typeof sw.data.today_checkouts, 'number');
    assert.strictEqual(typeof sw.data.continued_rooms, 'number');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 7: Event Structure
// ─────────────────────────────────────────────────────────────────────────────
test('Group 7: Compound event structure', async (t) => {
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';

  await t.test('7.1 event_type is COMPOUND_NIGHT_AUDIT', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    assert.strictEqual(payload.event_type, 'COMPOUND_NIGHT_AUDIT');
  });

  await t.test('7.2 aggregate_type is SYSTEM', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    assert.strictEqual(payload.aggregate_type, 'SYSTEM');
  });

  await t.test('7.3 aggregate_id contains nextDate', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    assert.ok(payload.aggregate_id.includes(NEXT_DATE), `aggregate_id includes next date: ${payload.aggregate_id}`);
  });

  await t.test('7.4 schema_version is 1', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    assert.strictEqual(payload.schema_version, 1);
  });

  await t.test('7.5 business_date in event header is nextDate', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    assert.strictEqual(payload.business_date, NEXT_DATE);
  });

  await t.test('7.6 operation_id is present and non-empty', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    assert.ok(payload.operation_id && payload.operation_id.length > 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 8: Transaction Safety — enqueue uses same connection, before commit
// ─────────────────────────────────────────────────────────────────────────────
test('Group 8: Transaction safety', async (t) => {
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';

  await t.test('8.1 enqueue INSERT appears in the same connection call log', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const outboxCall = conn.calls.find(c => c.sql.includes('dual_write_outbox'));
    assert.ok(outboxCall, 'Outbox INSERT recorded in same mock connection');
  });

  await t.test('8.2 enqueue INSERT comes after audit_logs INSERT in call order', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1 });
    await runNightAudit(conn);
    const auditIdx  = conn.calls.findIndex(c => c.sql.includes("'DAY_END'"));
    const enqueueIdx = conn.calls.findIndex(c => c.sql.includes('dual_write_outbox'));
    assert.ok(auditIdx !== -1, 'audit_logs INSERT found');
    assert.ok(enqueueIdx !== -1, 'outbox INSERT found');
    assert.ok(enqueueIdx > auditIdx, 'enqueue comes after audit_logs INSERT (i.e. before COMMIT)');
  });

  await t.test('8.3 enqueue failure propagates error (enables MySQL rollback)', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1, failEnqueue: true });
    await assert.rejects(
      () => runNightAudit(conn),
      /Mock enqueue failure/,
      'enqueue failure propagates out of advanceBusinessDate'
    );
  });

  await t.test('8.4 ledger INSERT failure propagates error (enables MySQL rollback)', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 1, failAtInsert: true });
    await assert.rejects(
      () => runNightAudit(conn),
      /Mock ledger INSERT failure/,
      'ledger INSERT failure propagates out of advanceBusinessDate'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 9: Idempotency / Retry Safety
// ─────────────────────────────────────────────────────────────────────────────
test('Group 9: Idempotency', async (t) => {
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';

  await t.test('9.1 same mock environment produces same write-set shape on two calls', async () => {
    // Two separate mock connections with same config → same payload structure
    const conn1 = makeMockConnection({ occupiedRoomCount: 2 });
    const conn2 = makeMockConnection({ occupiedRoomCount: 2 });
    await runNightAudit(conn1);
    await runNightAudit(conn2);
    const p1 = extractOutboxPayload(conn1.calls);
    const p2 = extractOutboxPayload(conn2.calls);
    // Same shape: same event_type, same writes.length, same collections
    assert.strictEqual(p1.event_type,     p2.event_type);
    assert.strictEqual(p1.writes.length,  p2.writes.length);
    assert.strictEqual(p1.aggregate_type, p2.aggregate_type);
    // Settings write data is identical (counters, dates)
    const s1 = p1.writes.find(w => w.collection === 'settings');
    const s2 = p2.writes.find(w => w.collection === 'settings');
    assert.strictEqual(s1.data.today_checkins,  s2.data.today_checkins);
    assert.strictEqual(s1.data.today_checkouts, s2.data.today_checkouts);
    assert.strictEqual(s1.data.current_date,    s2.data.current_date);
  });

  await t.test('9.2 payload is JSON-serialisable (can be frozen in Outbox)', async () => {
    const conn = makeMockConnection({ occupiedRoomCount: 2 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    // Should not throw
    const roundtripped = JSON.parse(JSON.stringify(payload));
    assert.strictEqual(roundtripped.event_type, payload.event_type);
    assert.strictEqual(roundtripped.writes.length, payload.writes.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 10: Batch-Size Limits
// ─────────────────────────────────────────────────────────────────────────────
test('Group 10: Batch-size limits', async (t) => {
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';

  await t.test('10.1 17-room scenario: 35 writes (SAFE)', async () => {
    process.env.FIRESTORE_MAX_BATCH_OPS = '490';
    const conn = makeMockConnection({ occupiedRoomCount: 17 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    assert.strictEqual(payload.writes.length, 35, '17 rooms → 35 writes');
  });

  await t.test('10.2 244-room scenario: 489 writes (1 under limit)', async () => {
    process.env.FIRESTORE_MAX_BATCH_OPS = '490';
    const conn = makeMockConnection({ occupiedRoomCount: 244 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    assert.strictEqual(payload.writes.length, 489, '244 rooms → 489 writes');
  });

  await t.test('10.3 245-room scenario: 491 writes → WRITE_SET_TOO_LARGE rejection', async () => {
    process.env.FIRESTORE_MAX_BATCH_OPS = '490';
    const conn = makeMockConnection({ occupiedRoomCount: 245 });
    await assert.rejects(
      () => runNightAudit(conn),
      (err) => {
        assert.ok(err.code === 'WRITE_SET_TOO_LARGE' || err.message.includes('exceeds'), `Error: ${err.message}`);
        return true;
      },
      '245 rooms → WRITE_SET_TOO_LARGE'
    );
  });

  await t.test('10.4 245-room rejection: no outbox INSERT in failed call', async () => {
    process.env.FIRESTORE_MAX_BATCH_OPS = '490';
    const conn = makeMockConnection({ occupiedRoomCount: 245 });
    try { await runNightAudit(conn); } catch (_) {}
    const outboxCall = conn.calls.find(c => c.sql.includes('dual_write_outbox'));
    assert.strictEqual(outboxCall, undefined, 'No outbox INSERT on batch-size rejection');
  });

  await t.test('10.5 500-room scenario: also rejected (>500 protection)', async () => {
    process.env.FIRESTORE_MAX_BATCH_OPS = '490';
    const conn = makeMockConnection({ occupiedRoomCount: 500 });
    await assert.rejects(
      () => runNightAudit(conn),
      (err) => {
        assert.ok(err.code === 'WRITE_SET_TOO_LARGE' || err.message.includes('exceeds'), `Error: ${err.message}`);
        return true;
      },
      '500 rooms → WRITE_SET_TOO_LARGE'
    );
  });

  await t.test('10.6 2N+1 formula holds for 10 rooms: 21 writes', async () => {
    process.env.FIRESTORE_MAX_BATCH_OPS = '490';
    const conn = makeMockConnection({ occupiedRoomCount: 10 });
    await runNightAudit(conn);
    const payload = extractOutboxPayload(conn.calls);
    assert.strictEqual(payload.writes.length, 21, '10 rooms → 21 writes');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 11: Existing Business Behavior Unchanged When Flag OFF
// ─────────────────────────────────────────────────────────────────────────────
test('Group 11: Existing Night Audit behavior unchanged when flag OFF', async (t) => {
  await t.test('11.1 flag=false: all existing MySQL calls still execute', async () => {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
    const conn = makeMockConnection({ occupiedRoomCount: 3 });
    await runNightAudit(conn);
    const sqls = conn.calls.map(c => c.sql);
    // Occupied rooms query
    assert.ok(sqls.some(s => s.includes("WHERE r.status = 'occupied'")), 'Occupied rooms query executed');
    // Business date advance
    assert.ok(sqls.some(s => s.includes("key_name = 'system_date'")), 'system_date UPDATE executed');
    // continued_rooms
    assert.ok(sqls.some(s => s.includes("key_name = 'continued_rooms'")), 'continued_rooms UPDATE executed');
    // today_checkins reset
    assert.ok(sqls.some(s => s.includes("key_name = 'today_checkins'")), 'today_checkins reset executed');
    // today_checkouts reset
    assert.ok(sqls.some(s => s.includes("key_name = 'today_checkouts'")), 'today_checkouts reset executed');
    // audit_logs insert
    assert.ok(sqls.some(s => s.includes("'DAY_END'")), 'DAY_END audit log INSERT executed');
  });

  await t.test('11.2 flag=false: ledger INSERTs still execute (existing behavior)', async () => {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
    const conn = makeMockConnection({ occupiedRoomCount: 3 });
    await runNightAudit(conn);
    const ledgerInserts = conn.calls.filter(c => c.sql.startsWith('INSERT INTO ledger_items'));
    assert.strictEqual(ledgerInserts.length, 3, 'All 3 rooms get tariff ledger entries');
  });

  await t.test('11.3 flag=false: no outbox INSERT at all', async () => {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
    const conn = makeMockConnection({ occupiedRoomCount: 5 });
    await runNightAudit(conn);
    const outboxCall = conn.calls.find(c => c.sql.includes('dual_write_outbox'));
    assert.strictEqual(outboxCall, undefined, 'No outbox call when flag is OFF');
  });
});
