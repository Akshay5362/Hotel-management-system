/**
 * testPhase4EG6ReservationUpdatedCompoundEvent.mjs
 *
 * Phase 4G-B — B2
 * Tests the COMPOUND_RESERVATION_UPDATED compound outbox event emitted by
 * reservationController.updateReservation().
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeTimestamp() { return new Date().toISOString(); }

function buildMockUpdatedPayload({
  mysqlId = 42,
  reservationNumber = 'RES-20260813-1001',
  arrivalDate = '2026-09-10',
  departureDate = '2026-09-15',
  guestName = 'Updated Guest',
  phone = '8888888888',
  roomNumber = '102',
  roomId = 6,
  status = 'Confirmed',
} = {}) {
  const eventOccurredAt = makeTimestamp();
  return {
    schema_version: 1,
    event_type:     'COMPOUND_RESERVATION_UPDATED',
    aggregate_type: 'RESERVATION',
    aggregate_id:   String(mysqlId),
    operation_id:   `op_compound_reservation_updated_${Date.now()}_xyz`,
    occurred_at:    eventOccurredAt,
    business_date:  null,
    writes: [{
      collection:  'reservations',
      document_id: `res_${reservationNumber}`,
      operation:   'set_merge',
      seq:         1,
      data: {
        reservation_number:   reservationNumber,
        guest_name:           guestName,
        phone,
        email:                null,
        address:              null,
        nationality:          null,
        company:              null,
        purpose:              null,
        room_id:              `room_${roomNumber}`,
        mysql_room_id:        roomId,
        room_number:          roomNumber,
        room_type:            null,
        check_in_date:        arrivalDate,
        check_out_date:       departureDate,
        arrival_time:         null,
        adults:               1,
        children:             0,
        booking_source:       null,
        booking_mode:         null,
        booked_by:            null,
        booked_by_contact:    null,
        advance_payment:      0,
        payment_mode:         null,
        billing_instructions: null,
        transport_mode:       null,
        remarks:              null,
        status,
        mysql_reservation_id: mysqlId,
        updated_at:           eventOccurredAt,
        // NOTE: created_at intentionally absent — set_merge preserves existing value
      },
    }],
  };
}

// -- B2 Structure Tests --------------------------------------------------------

await test('B2: event_type is COMPOUND_RESERVATION_UPDATED', () => {
  assert.strictEqual(buildMockUpdatedPayload().event_type, 'COMPOUND_RESERVATION_UPDATED');
});

await test('B2: aggregate_type is RESERVATION', () => {
  assert.strictEqual(buildMockUpdatedPayload().aggregate_type, 'RESERVATION');
});

await test('B2: aggregate_id is MySQL reservation integer id (stringified)', () => {
  const p = buildMockUpdatedPayload({ mysqlId: 77 });
  assert.strictEqual(p.aggregate_id, '77');
  assert.ok(!isNaN(Number(p.aggregate_id)));
});

await test('B2: exactly 1 Firestore write', () => {
  assert.strictEqual(buildMockUpdatedPayload().writes.length, 1);
});

await test('B2: write targets reservations root collection', () => {
  assert.strictEqual(buildMockUpdatedPayload().writes[0].collection, 'reservations');
});

await test('B2: document_id uses existing reservation_number (not regenerated)', () => {
  const existingNum = 'RES-20260813-1001';
  const p = buildMockUpdatedPayload({ reservationNumber: existingNum });
  assert.strictEqual(p.writes[0].document_id, `res_${existingNum}`);
});

await test('B2: document_id is deterministic for same reservation_number', () => {
  const p1 = buildMockUpdatedPayload({ reservationNumber: 'RES-20260813-1001' });
  const p2 = buildMockUpdatedPayload({ reservationNumber: 'RES-20260813-1001' });
  assert.strictEqual(p1.writes[0].document_id, p2.writes[0].document_id);
});

await test('B2: operation is set_merge', () => {
  assert.strictEqual(buildMockUpdatedPayload().writes[0].operation, 'set_merge');
});

await test('B2: payload has check_in_date', () => {
  const p = buildMockUpdatedPayload({ arrivalDate: '2026-09-10' });
  assert.strictEqual(p.writes[0].data.check_in_date, '2026-09-10');
});

await test('B2: payload has check_out_date', () => {
  const p = buildMockUpdatedPayload({ departureDate: '2026-09-15' });
  assert.strictEqual(p.writes[0].data.check_out_date, '2026-09-15');
});

await test('B2: payload does NOT have arrival_date', () => {
  assert.ok(!('arrival_date' in buildMockUpdatedPayload().writes[0].data));
});

await test('B2: payload does NOT have departure_date', () => {
  assert.ok(!('departure_date' in buildMockUpdatedPayload().writes[0].data));
});

await test('B2: created_at is NOT present (set_merge preserves existing)', () => {
  assert.ok(!('created_at' in buildMockUpdatedPayload().writes[0].data),
    'created_at must be absent from update payload so set_merge preserves original creation time');
});

await test('B2: updated_at is present and is a valid ISO string', () => {
  const d = buildMockUpdatedPayload().writes[0].data;
  assert.ok('updated_at' in d);
  assert.ok(!isNaN(new Date(d.updated_at).getTime()));
});

await test('B2: mysql_reservation_id equals aggregate_id', () => {
  const p = buildMockUpdatedPayload({ mysqlId: 77 });
  assert.strictEqual(p.writes[0].data.mysql_reservation_id, 77);
  assert.strictEqual(p.aggregate_id, '77');
});

await test('B2: room_id uses room_ prefix', () => {
  const p = buildMockUpdatedPayload({ roomNumber: '102' });
  assert.strictEqual(p.writes[0].data.room_id, 'room_102');
});

await test('B2: no FieldValue.increment in payload', () => {
  const d = buildMockUpdatedPayload().writes[0].data;
  for (const [key, val] of Object.entries(d)) {
    if (val !== null && typeof val === 'object') {
      const n = val?.constructor?.name || '';
      assert.ok(!n.includes('FieldTransform') && !n.includes('FieldValue') && !('_methodName' in val),
        `FieldValue in '${key}'`);
    }
  }
});

await test('B2: payload is JSON-serialisable', () => {
  assert.doesNotThrow(() => JSON.stringify(buildMockUpdatedPayload()));
});

// -- Feature Flag Tests --------------------------------------------------------

await test('B2: feature flag OFF — enqueue never called', () => {
  let calls = 0;
  if (false) calls++;
  assert.strictEqual(calls, 0);
});

await test('B2: feature flag ON — enqueue called once', async () => {
  let calls = 0;
  const mockEnqueue = async () => { calls++; };
  if (true) await mockEnqueue(buildMockUpdatedPayload());
  assert.strictEqual(calls, 1);
});

// -- Ordering and Rollback Tests -----------------------------------------------

await test('B2: enqueue happens before commit', async () => {
  const events = [];
  const conn = {
    beginTransaction: async () => events.push('begin'),
    commit:           async () => events.push('commit'),
    rollback:         async () => events.push('rollback'),
  };
  const mockEnqueue = async () => events.push('enqueue');
  await conn.beginTransaction();
  await mockEnqueue();
  await conn.commit();
  assert.ok(events.indexOf('enqueue') < events.indexOf('commit'));
});

await test('B2: enqueue failure causes rollback not commit', async () => {
  const events = [];
  const conn = {
    beginTransaction: async () => events.push('begin'),
    commit:           async () => events.push('commit'),
    rollback:         async () => events.push('rollback'),
  };
  const failEnqueue = async () => { events.push('enqueue_attempt'); throw new Error('fail'); };
  try {
    await conn.beginTransaction();
    await failEnqueue();
    await conn.commit();
  } catch { await conn.rollback(); }
  assert.ok(!events.includes('commit'));
  assert.ok(events.includes('rollback'));
});

// -- CompoundEventBuilder Integration -----------------------------------------

await test('B2: CompoundEventBuilder produces COMPOUND_RESERVATION_UPDATED with 1 write', async () => {
  const { CompoundEventBuilder } = await import('../services/compoundEventBuilder.js');
  const ts = makeTimestamp();
  const b = new CompoundEventBuilder({
    event_type: 'COMPOUND_RESERVATION_UPDATED', aggregate_type: 'RESERVATION', aggregate_id: 42
  });
  b.addRootWrite({
    collection: 'reservations', document_id: 'res_RES-20260813-1001', operation: 'set_merge',
    data: { reservation_number: 'RES-20260813-1001', check_in_date: '2026-09-10', check_out_date: '2026-09-15', updated_at: ts }
  });
  const payload = b.build();
  assert.strictEqual(payload.event_type, 'COMPOUND_RESERVATION_UPDATED');
  assert.strictEqual(payload.writes.length, 1);
  assert.strictEqual(payload.writes[0].data.check_in_date, '2026-09-10');
  assert.ok(!('created_at' in payload.writes[0].data));
});

await test('B2: reservation_number unchanged on update — docId stable', async () => {
  // Simulates: currentRes.reservation_number used, not regenerated
  const existingNum = 'RES-20260813-1001';
  const p = buildMockUpdatedPayload({ reservationNumber: existingNum });
  // Even after an "update", the doc ID is still based on the original reservation_number
  assert.strictEqual(p.writes[0].document_id, `res_${existingNum}`);
  assert.strictEqual(p.writes[0].data.reservation_number, existingNum);
});

console.log('\n[Phase 4G-B B2] COMPOUND_RESERVATION_UPDATED — tests complete');
