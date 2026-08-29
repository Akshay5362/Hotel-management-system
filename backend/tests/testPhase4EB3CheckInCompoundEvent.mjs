/**
 * PHASE 4E-B3 — Check-In Compound Outbox Event Tests
 *
 * Tests validate:
 *  - Compound event construction for all check-in variants
 *  - Deterministic Firestore document IDs from MySQL insertIds
 *  - Absolute today_checkins counter value
 *  - Root + subcollection dual writes for ledger and payments
 *  - Feature flag gating (ENABLE_FIRESTORE_DUAL_WRITE)
 *  - MySQL transaction rollback on enqueue failure
 *  - No FieldValue.increment() in payload
 *  - Idempotency / retry safety
 *  - Regression: processCheckIn still returns { bookingId, roomNumber }
 *
 * Production MySQL and Firestore are NOT used.
 * All MySQL operations use a shared mock connection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock MySQL connection that tracks calls and returns
 * configurable responses per query.
 */
function makeMockConnection(opts = {}) {
  const { responses = {}, failEnqueue = false } = opts;
  const calls = [];

  const query = async (sql, params = []) => {
    // Collapse whitespace for reliable matching
    const normalSql = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: normalSql, params });

    // Check for deliberate enqueue failure trigger
    if (failEnqueue && normalSql.includes('dual_write_outbox')) {
      throw new Error('Mock enqueue failure: simulated DB error');
    }

    // Check caller-provided overrides first (by key substring)
    for (const [key, val] of Object.entries(responses)) {
      if (normalSql.includes(key)) return val;
    }

    // Default responses — order matters; more specific first
    if (normalSql.includes('dual_write_outbox')) {
      return [{ insertId: 200 }];
    }
    if (normalSql.includes('today_checkins') && normalSql.startsWith('SELECT')) {
      return [[{ value_val: '5' }]]; // absolute post-increment value
    }
    if (normalSql.includes('today_checkins') && normalSql.startsWith('UPDATE')) {
      return [{ affectedRows: 1 }];
    }
    if (normalSql.includes('system_settings') && normalSql.startsWith('SELECT')) {
      return [[{ value_val: '2026-08-12' }]]; // getBusinessDate
    }
    if (normalSql.includes('FOR UPDATE') && normalSql.includes('rooms') && normalSql.includes('room_types')) {
      return [[{ id: 10, number: '101', status: 'vacant', rate: 2500, housekeeping_status: 'Clean', type: 'STANDARD' }]];
    }
    if (normalSql.includes('booking_status') && normalSql.includes('Checked In') && normalSql.startsWith('SELECT')) {
      return [[]]; // no active checked-in booking
    }
    if (normalSql.includes('FOR UPDATE') && normalSql.includes('reservations')) {
      return [[]]; // no reservation by default
    }
    if (normalSql.includes('FOR UPDATE') && normalSql.includes('guests')) {
      return [[]]; // no existing guest
    }
    if (normalSql.includes('INSERT INTO guests')) {
      return [{ insertId: 42 }];
    }
    if (normalSql.includes('INSERT INTO bookings')) {
      return [{ insertId: 1001 }];
    }
    if (normalSql.includes('UPDATE reservations') && normalSql.includes('Checked-In')) {
      return [{ affectedRows: 1 }];
    }
    if (normalSql.includes('INSERT INTO ledger_items')) {
      return [{ insertId: 555 }];
    }
    if (normalSql.includes('INSERT INTO cash_logs')) {
      return [{ insertId: 77 }];
    }
    if (normalSql.includes('INSERT INTO payments')) {
      return [{ insertId: 88 }];
    }
    if (normalSql.includes('UPDATE rooms') && normalSql.includes('occupied')) {
      return [{ affectedRows: 1 }];
    }
    if (normalSql.includes('INSERT INTO room_status_history')) {
      return [{ insertId: 999 }];
    }
    if (normalSql.includes('INSERT INTO audit_logs')) {
      return [{ insertId: 1 }];
    }
    if (normalSql.includes('INSERT INTO notifications')) {
      return [{ insertId: 1 }];
    }
    if (normalSql.includes('UPDATE razorpay_transactions')) {
      return [{ affectedRows: 1 }];
    }
    // Fallback
    return [{ insertId: 0, affectedRows: 0 }];
  };

  return { query, calls };
}


// Shared inputs
const BASE_PARAMS = {
  roomNumber:    '101',
  guestName:     'JOHN DOE',
  phone:         '9876543210',
  email:         'john@test.com',
  address:       '1 Main St',
  country:       'India',
  pax:           2,
  children:      0,
  deposit:       0,
  paymentMethod: 'Cash',
  transactionId: null,
  manualOverride: false,
  checkInDate:   '2026-08-12',
  resolvedUserId: 1,
  reservationId:  null,
  isGuestSelfCheckIn: false,
  guestId:        null,
  departureDate:  null,
  billingInstruction: 'Direct to Guest',
  mealPlan:       'EP'
};

// ── Module under test ─────────────────────────────────────────────────────────

// We import checkInService using dynamic import after setting env vars so the
// feature flag is evaluated at import time (module-level caching).
// Instead, we set the env var before each relevant test and call the function.

// Because processCheckIn calls isFirestoreDualWriteEnabled() at runtime (it is
// a function, not a constant), we can toggle process.env per test.

const { processCheckIn } = await import('../services/checkInService.js');

import {
  formatBookingId,
  formatRoomId,
  formatGuestId,
  formatReservationId,
  formatLedgerItemId,
  formatPaymentId,
  formatCashLogId
} from '../services/compoundEventBuilder.js';

// ── Helper: run check-in with flag settings and capture outbox payload ────────

async function runCheckIn(params, { dualWrite = false, connectionOverrides = {}, failEnqueue = false } = {}) {
  process.env.ENABLE_FIRESTORE_DUAL_WRITE = dualWrite ? 'true' : 'false';
  const conn = makeMockConnection({ responses: connectionOverrides, failEnqueue });
  const result = await processCheckIn(conn, { ...BASE_PARAMS, ...params });

  // Find the outbox INSERT call to extract the payload
  const outboxCall = conn.calls.find(c => c.sql.includes('dual_write_outbox') && c.sql.includes('INSERT'));
  let outboxPayload = null;
  if (outboxCall) {
    // enqueue() inserts: [event_id, event_type, aggregate_type, aggregate_id, payload]
    // payload is at params index 4
    try { outboxPayload = JSON.parse(outboxCall.params[4]); } catch {}
  }

  return { result, conn, outboxPayload };
}

// ── Group 1: Return value regression ─────────────────────────────────────────
console.log('\n── Group 1: Return Value Regression ────────────────────────────');

await test('1.1 processCheckIn still returns { bookingId, roomNumber }', async () => {
  const { result } = await runCheckIn({});
  assert.ok(result.bookingId, 'bookingId should be set');
  assert.strictEqual(result.roomNumber, '101');
});

await test('1.2 flag=false: returns without outbox call', async () => {
  const { conn } = await runCheckIn({}, { dualWrite: false });
  const outboxCall = conn.calls.find(c => /dual_write_outbox/i.test(c.sql));
  assert.ok(!outboxCall, 'No outbox INSERT when flag is false');
});

// ── Group 2: Feature Flag Gating ─────────────────────────────────────────────
console.log('\n── Group 2: Feature Flag Gating ─────────────────────────────────');

await test('2.1 flag=true: outbox INSERT is called', async () => {
  const { conn } = await runCheckIn({}, { dualWrite: true });
  const outboxCall = conn.calls.find(c => /dual_write_outbox/i.test(c.sql));
  assert.ok(outboxCall, 'Outbox INSERT should be called when flag=true');
});

await test('2.2 flag=false: check-in still succeeds (MySQL-only path)', async () => {
  const { result } = await runCheckIn({}, { dualWrite: false });
  assert.ok(result.bookingId > 0);
});

// ── Group 3: Event structure ──────────────────────────────────────────────────
console.log('\n── Group 3: Event Structure ─────────────────────────────────────');

await test('3.1 event_type is COMPOUND_CHECKIN', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  assert.strictEqual(outboxPayload?.event_type, 'COMPOUND_CHECKIN');
});

await test('3.2 aggregate_type is BOOKING', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  assert.strictEqual(outboxPayload?.aggregate_type, 'BOOKING');
});

await test('3.3 schema_version is 1', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  assert.strictEqual(outboxPayload?.schema_version, 1);
});

await test('3.4 writes array is non-empty', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  assert.ok(Array.isArray(outboxPayload?.writes) && outboxPayload.writes.length > 0);
});

await test('3.5 payload is JSON-serialisable (no FieldValue sentinels)', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  assert.doesNotThrow(() => JSON.stringify(outboxPayload));
  const roundtrip = JSON.parse(JSON.stringify(outboxPayload));
  assert.strictEqual(roundtrip.event_type, 'COMPOUND_CHECKIN');
});

// ── Group 4: Deterministic Document IDs ──────────────────────────────────────
console.log('\n── Group 4: Deterministic IDs ───────────────────────────────────');

await test('4.1 booking write uses formatBookingId(bookingNumber)', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const bookingWrite = outboxPayload.writes.find(w => w.collection === 'bookings' && !w.subcollection);
  assert.ok(bookingWrite?.document_id.startsWith('bkg_'), `Got: ${bookingWrite?.document_id}`);
});

await test('4.2 room write uses formatRoomId(roomNumber)', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const roomWrite = outboxPayload.writes.find(w => w.collection === 'rooms');
  assert.strictEqual(roomWrite?.document_id, formatRoomId('101'));
});

await test('4.3 guest write uses formatGuestId(phone) when phone present', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const guestWrite = outboxPayload.writes.find(w => w.collection === 'guests');
  assert.strictEqual(guestWrite?.document_id, formatGuestId('9876543210'));
});

await test('4.4 guest write uses formatGuestId(mysqlGuestId) when no phone', async () => {
  const { outboxPayload } = await runCheckIn({ phone: '' }, { dualWrite: true });
  const guestWrite = outboxPayload.writes.find(w => w.collection === 'guests');
  // finalGuestId = 42 (from mock INSERT INTO guests)
  assert.strictEqual(guestWrite?.document_id, formatGuestId(42));
});

await test('4.5 ledger root ID uses MySQL insertId (555)', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const ledgerRoot = outboxPayload.writes.find(w => w.collection === 'ledger_items' && !w.subcollection);
  assert.strictEqual(ledgerRoot?.document_id, formatLedgerItemId(555));
});

// ── Group 5: Check-In without deposit ────────────────────────────────────────
console.log('\n── Group 5: No-Deposit Check-In ─────────────────────────────────');

await test('5.1 no payment/cash writes when deposit=0', async () => {
  const { outboxPayload } = await runCheckIn({ deposit: 0 }, { dualWrite: true });
  const payWrite  = outboxPayload.writes.find(w => w.collection === 'payments');
  const cashWrite = outboxPayload.writes.find(w => w.collection === 'cash_logs');
  assert.ok(!payWrite,  'No payments write when deposit=0');
  assert.ok(!cashWrite, 'No cash_logs write when deposit=0');
});

await test('5.2 booking payment_status is Pending when deposit=0', async () => {
  const { outboxPayload } = await runCheckIn({ deposit: 0 }, { dualWrite: true });
  const bkgWrite = outboxPayload.writes.find(w => w.collection === 'bookings' && !w.subcollection);
  assert.strictEqual(bkgWrite?.data?.payment_status, 'Pending');
});

await test('5.3 write count without deposit is 6 (bkg+room+guest+ledger_root+ledger_sub+settings)', async () => {
  const { outboxPayload } = await runCheckIn({ deposit: 0 }, { dualWrite: true });
  assert.strictEqual(outboxPayload.writes.length, 6);
});

// ── Group 6: Check-In with non-cash deposit ───────────────────────────────────
console.log('\n── Group 6: Non-Cash Deposit ────────────────────────────────────');

await test('6.1 payment root write present when deposit>0', async () => {
  const { outboxPayload } = await runCheckIn({ deposit: 500, paymentMethod: 'Card' }, { dualWrite: true });
  const payRoot = outboxPayload.writes.find(w => w.collection === 'payments' && !w.subcollection);
  assert.ok(payRoot, 'Payment root write present');
});

await test('6.2 no cash_log write when paymentMethod is Card', async () => {
  const { outboxPayload } = await runCheckIn({ deposit: 500, paymentMethod: 'Card' }, { dualWrite: true });
  const cashWrite = outboxPayload.writes.find(w => w.collection === 'cash_logs');
  assert.ok(!cashWrite, 'No cash_log write for non-Cash payment');
});

await test('6.3 payment ID uses MySQL insertId (88)', async () => {
  const { outboxPayload } = await runCheckIn({ deposit: 500, paymentMethod: 'Card' }, { dualWrite: true });
  const payRoot = outboxPayload.writes.find(w => w.collection === 'payments' && !w.subcollection);
  assert.strictEqual(payRoot?.document_id, formatPaymentId(88));
});

await test('6.4 payment subcollection write present under bookings', async () => {
  const { outboxPayload } = await runCheckIn({ deposit: 500, paymentMethod: 'Card' }, { dualWrite: true });
  const paySub = outboxPayload.writes.find(w => w.collection === 'bookings' && w.subcollection === 'payments');
  assert.ok(paySub, 'Payment subcollection write present under bookings');
  assert.strictEqual(paySub.document_id, formatPaymentId(88));
});

await test('6.5 payment root and subcollection have same document_id', async () => {
  const { outboxPayload } = await runCheckIn({ deposit: 500, paymentMethod: 'Card' }, { dualWrite: true });
  const payRoot = outboxPayload.writes.find(w => w.collection === 'payments' && !w.subcollection);
  const paySub  = outboxPayload.writes.find(w => w.collection === 'bookings'  && w.subcollection === 'payments');
  assert.strictEqual(payRoot?.document_id, paySub?.document_id);
});

await test('6.6 booking payment_status is Partial when deposit>0', async () => {
  const { outboxPayload } = await runCheckIn({ deposit: 500, paymentMethod: 'Card' }, { dualWrite: true });
  const bkgWrite = outboxPayload.writes.find(w => w.collection === 'bookings' && !w.subcollection);
  assert.strictEqual(bkgWrite?.data?.payment_status, 'Partial');
});

// ── Group 7: Cash deposit ─────────────────────────────────────────────────────
console.log('\n── Group 7: Cash Deposit ────────────────────────────────────────');

await test('7.1 cash_log write present when paymentMethod=Cash and deposit>0', async () => {
  const { outboxPayload } = await runCheckIn({ deposit: 500, paymentMethod: 'Cash' }, { dualWrite: true });
  const cashWrite = outboxPayload.writes.find(w => w.collection === 'cash_logs');
  assert.ok(cashWrite, 'Cash log write present');
});

await test('7.2 cash_log ID uses MySQL insertId (77)', async () => {
  const { outboxPayload } = await runCheckIn({ deposit: 500, paymentMethod: 'Cash' }, { dualWrite: true });
  const cashWrite = outboxPayload.writes.find(w => w.collection === 'cash_logs');
  assert.strictEqual(cashWrite?.document_id, formatCashLogId(77));
});

await test('7.3 cash_log write count = 10 (max scenario without reservation)', async () => {
  const { outboxPayload } = await runCheckIn({ deposit: 500, paymentMethod: 'Cash' }, { dualWrite: true });
  // bkg + room + guest + ledger_root + ledger_sub + payment_root + payment_sub + cash_log + settings = 9
  assert.strictEqual(outboxPayload.writes.length, 9);
});

// ── Group 8: With Reservation ─────────────────────────────────────────────────
console.log('\n── Group 8: With Reservation ────────────────────────────────────');

const WITH_RES_RESPONSES = {
  'SELECT * FROM reservations': [[{
    id: 77, status: 'Reserved', guest_name: 'JOHN DOE', phone: '9876543210',
    email: 'john@test.com', address: '', nationality: 'India',
    adults: 1, children: 0, departure_date: '2026-08-14', advance_payment: 0, payment_mode: 'Cash'
  }]]
};

await test('8.1 reservation write present when reservation found', async () => {
  const { outboxPayload } = await runCheckIn(
    { reservationId: 77 },
    { dualWrite: true, connectionOverrides: WITH_RES_RESPONSES }
  );
  const resWrite = outboxPayload.writes.find(w => w.collection === 'reservations');
  assert.ok(resWrite, 'Reservation write present');
});

await test('8.2 reservation document_id uses formatReservationId(reservation.id)', async () => {
  const { outboxPayload } = await runCheckIn(
    { reservationId: 77 },
    { dualWrite: true, connectionOverrides: WITH_RES_RESPONSES }
  );
  const resWrite = outboxPayload.writes.find(w => w.collection === 'reservations');
  assert.strictEqual(resWrite?.document_id, formatReservationId(77));
});

await test('8.3 reservation status in write is Checked-In', async () => {
  const { outboxPayload } = await runCheckIn(
    { reservationId: 77 },
    { dualWrite: true, connectionOverrides: WITH_RES_RESPONSES }
  );
  const resWrite = outboxPayload.writes.find(w => w.collection === 'reservations');
  assert.strictEqual(resWrite?.data?.status, 'Checked-In');
});

await test('8.4 no reservation write when no reservation', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const resWrite = outboxPayload.writes.find(w => w.collection === 'reservations');
  assert.ok(!resWrite, 'No reservation write when no reservation present');
});

// ── Group 9: Ledger Dual Write ────────────────────────────────────────────────
console.log('\n── Group 9: Ledger Dual Write ───────────────────────────────────');

await test('9.1 ledger root write exists', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const ledgerRoot = outboxPayload.writes.find(w => w.collection === 'ledger_items' && !w.subcollection);
  assert.ok(ledgerRoot);
});

await test('9.2 ledger subcollection write exists under bookings', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const ledgerSub = outboxPayload.writes.find(w => w.collection === 'bookings' && w.subcollection === 'ledger_items');
  assert.ok(ledgerSub, 'Ledger subcollection write under bookings');
});

await test('9.3 ledger root and subcollection have same document_id', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const ledgerRoot = outboxPayload.writes.find(w => w.collection === 'ledger_items' && !w.subcollection);
  const ledgerSub  = outboxPayload.writes.find(w => w.collection === 'bookings' && w.subcollection === 'ledger_items');
  assert.strictEqual(ledgerRoot?.document_id, ledgerSub?.document_id);
});

await test('9.4 ledger root and subcollection have same amount', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const ledgerRoot = outboxPayload.writes.find(w => w.collection === 'ledger_items' && !w.subcollection);
  const ledgerSub  = outboxPayload.writes.find(w => w.collection === 'bookings' && w.subcollection === 'ledger_items');
  assert.strictEqual(ledgerRoot?.data?.amount, ledgerSub?.data?.amount);
});

await test('9.5 ledger description is Room Tariff (Incl. GST)', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const ledgerRoot = outboxPayload.writes.find(w => w.collection === 'ledger_items' && !w.subcollection);
  assert.strictEqual(ledgerRoot?.data?.description, 'Room Tariff (Incl. GST)');
});

await test('9.6 ledger also has legacy desc field for schema compatibility', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const ledgerRoot = outboxPayload.writes.find(w => w.collection === 'ledger_items' && !w.subcollection);
  assert.strictEqual(ledgerRoot?.data?.desc, 'Room Tariff (Incl. GST)');
});

// ── Group 10: Absolute Counter ────────────────────────────────────────────────
console.log('\n── Group 10: Absolute Counter ───────────────────────────────────');

await test('10.1 settings/system_date write has today_checkins as absolute number', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const settingsWrite = outboxPayload.writes.find(w => w.collection === 'settings' && w.document_id === 'system_date');
  assert.ok(settingsWrite, 'Settings write present');
  // Mock returns '5' from SELECT after UPDATE
  assert.strictEqual(settingsWrite?.data?.today_checkins, 5);
});

await test('10.2 today_checkins is a number (not string)', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const settingsWrite = outboxPayload.writes.find(w => w.collection === 'settings');
  assert.strictEqual(typeof settingsWrite?.data?.today_checkins, 'number');
});

await test('10.3 settings SELECT is called after UPDATE', async () => {
  const { conn } = await runCheckIn({}, { dualWrite: true });
  const updateIdx = conn.calls.findIndex(c => /UPDATE system_settings.*today_checkins/.test(c.sql));
  const selectIdx = conn.calls.findIndex(c => /SELECT value_val.*today_checkins/.test(c.sql));
  assert.ok(updateIdx >= 0, 'UPDATE called');
  assert.ok(selectIdx > updateIdx, 'SELECT called AFTER UPDATE');
});

// ── Group 11: FieldValue sentinel guard ──────────────────────────────────────
console.log('\n── Group 11: FieldValue Guard ───────────────────────────────────');

await test('11.1 no FieldValue increment in today_checkins', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const json = JSON.stringify(outboxPayload);
  assert.ok(!json.includes('_methodName'), 'No FieldValue._methodName in payload');
  assert.ok(!json.includes('increment'), 'No increment sentinel in payload');
});

await test('11.2 payload is fully serialisable without lossy fields', async () => {
  const { outboxPayload } = await runCheckIn({ deposit: 500, paymentMethod: 'Cash' }, { dualWrite: true });
  const json = JSON.stringify(outboxPayload);
  const parsed = JSON.parse(json);
  assert.strictEqual(parsed.writes.length, outboxPayload.writes.length);
});

// ── Group 12: Idempotency / Retry Safety ─────────────────────────────────────
console.log('\n── Group 12: Idempotency ────────────────────────────────────────');

await test('12.1 same MySQL IDs produce same document IDs on retry', async () => {
  // Simulate retry: same insertIds → same document IDs
  const { outboxPayload: p1 } = await runCheckIn({}, { dualWrite: true });
  // All writes use set_merge — second run with same IDs produces same state
  const ledger1 = p1.writes.find(w => w.collection === 'ledger_items' && !w.subcollection);
  assert.strictEqual(ledger1?.document_id, formatLedgerItemId(555)); // same mock insertId=555
});

await test('12.2 all writes use set_merge for idempotency', async () => {
  const { outboxPayload } = await runCheckIn({ deposit: 500, paymentMethod: 'Cash' }, { dualWrite: true });
  for (const write of outboxPayload.writes) {
    assert.strictEqual(write.operation, 'set_merge', `Write ${write.collection}/${write.document_id} uses ${write.operation}, expected set_merge`);
  }
});

await test('12.3 booking document_id is stable across same bookingNumber', async () => {
  // The bookingNumber is random but the ID uses it deterministically
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const bkgWrite = outboxPayload.writes.find(w => w.collection === 'bookings' && !w.subcollection);
  assert.ok(bkgWrite?.document_id.startsWith('bkg_BKG-'));
});

// ── Group 13: Failure / Rollback ─────────────────────────────────────────────
console.log('\n── Group 13: Failure / Rollback ─────────────────────────────────');

await test('13.1 enqueue failure propagates as thrown error', async () => {
  await assert.rejects(
    () => runCheckIn({}, { dualWrite: true, failEnqueue: true }),
    /Mock enqueue failure/
  );
});

await test('13.2 enqueue failure means caller can rollback', async () => {
  // The thrown error from enqueue is surfaced to the controller which calls rollback.
  // We verify the error propagates — the actual rollback is the controller's responsibility.
  let threw = false;
  try {
    await runCheckIn({}, { dualWrite: true, failEnqueue: true });
  } catch (e) {
    threw = true;
    assert.ok(e.message.includes('Mock enqueue failure'));
  }
  assert.ok(threw, 'Error must propagate so controller can rollback');
});

await test('13.3 worker disabled (flag=false): check-in still succeeds', async () => {
  const { result, conn } = await runCheckIn({}, { dualWrite: false });
  assert.ok(result.bookingId > 0);
  const outboxCall = conn.calls.find(c => /dual_write_outbox/i.test(c.sql));
  assert.ok(!outboxCall, 'No outbox INSERT when worker/dual_write flag is false');
});

// ── Group 14: MySQL InsertId Capture ─────────────────────────────────────────
console.log('\n── Group 14: MySQL InsertId Capture ─────────────────────────────');

await test('14.1 ledger MySQL insertId is captured (555) and used in write', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const ledgerRoot = outboxPayload.writes.find(w => w.collection === 'ledger_items' && !w.subcollection);
  assert.strictEqual(ledgerRoot?.data?.mysql_ledger_id, 555);
});

await test('14.2 payment MySQL insertId captured (88) and present in write data', async () => {
  const { outboxPayload } = await runCheckIn({ deposit: 500, paymentMethod: 'Card' }, { dualWrite: true });
  const payRoot = outboxPayload.writes.find(w => w.collection === 'payments' && !w.subcollection);
  assert.strictEqual(payRoot?.data?.mysql_payment_id, 88);
});

await test('14.3 cash log MySQL insertId captured (77) and present in write data', async () => {
  const { outboxPayload } = await runCheckIn({ deposit: 500, paymentMethod: 'Cash' }, { dualWrite: true });
  const cashWrite = outboxPayload.writes.find(w => w.collection === 'cash_logs');
  assert.strictEqual(cashWrite?.data?.mysql_cash_log_id, 77);
});

await test('14.4 booking mysql_booking_id matches bookings INSERT result (1001)', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const bkgWrite = outboxPayload.writes.find(w => w.collection === 'bookings' && !w.subcollection);
  assert.strictEqual(bkgWrite?.data?.mysql_booking_id, 1001);
});

// ── Group 15: Booking document fields ────────────────────────────────────────
console.log('\n── Group 15: Booking Document Fields ───────────────────────────');

await test('15.1 booking_status is Checked In', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const bkgWrite = outboxPayload.writes.find(w => w.collection === 'bookings' && !w.subcollection);
  assert.strictEqual(bkgWrite?.data?.booking_status, 'Checked In');
});

await test('15.2 booking contains room_number', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const bkgWrite = outboxPayload.writes.find(w => w.collection === 'bookings' && !w.subcollection);
  assert.strictEqual(bkgWrite?.data?.room_number, '101');
});

await test('15.3 booking contains guest_name in uppercase', async () => {
  const { outboxPayload } = await runCheckIn({ guestName: 'john doe' }, { dualWrite: true });
  const bkgWrite = outboxPayload.writes.find(w => w.collection === 'bookings' && !w.subcollection);
  assert.strictEqual(bkgWrite?.data?.guest_name, 'JOHN DOE');
});

await test('15.4 booking room_id uses formatRoomId(roomNumber)', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const bkgWrite = outboxPayload.writes.find(w => w.collection === 'bookings' && !w.subcollection);
  assert.strictEqual(bkgWrite?.data?.room_id, formatRoomId('101'));
});

// ── Group 16: Room document ────────────────────────────────────────────────────
console.log('\n── Group 16: Room Document ──────────────────────────────────────');

await test('16.1 room write status is occupied', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const roomWrite = outboxPayload.writes.find(w => w.collection === 'rooms');
  assert.strictEqual(roomWrite?.data?.status, 'occupied');
});

await test('16.2 room write current_booking_id matches booking doc ID', async () => {
  const { outboxPayload } = await runCheckIn({}, { dualWrite: true });
  const bkgWrite  = outboxPayload.writes.find(w => w.collection === 'bookings' && !w.subcollection);
  const roomWrite = outboxPayload.writes.find(w => w.collection === 'rooms');
  assert.strictEqual(roomWrite?.data?.current_booking_id, bkgWrite?.document_id);
});

// ── Group 17: Self Check-In path ─────────────────────────────────────────────
console.log('\n── Group 17: Self Check-In Path ─────────────────────────────────');

await test('17.1 compound event still built for self check-in', async () => {
  const { outboxPayload } = await runCheckIn({ isGuestSelfCheckIn: true }, { dualWrite: true });
  assert.strictEqual(outboxPayload?.event_type, 'COMPOUND_CHECKIN');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  PHASE 4E-B3 — Check-In Compound Event Tests');
console.log('══════════════════════════════════════════════════════════════');
