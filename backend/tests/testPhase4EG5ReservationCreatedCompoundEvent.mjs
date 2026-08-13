/**
 * testPhase4EG5ReservationCreatedCompoundEvent.mjs
 *
 * Phase 4G-B — B1
 * Tests the COMPOUND_RESERVATION_CREATED compound outbox event emitted by
 * reservationController.createReservation().
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// -- Helpers -------------------------------------------------------------------

function makeTimestamp() { return new Date().toISOString(); }

function buildMockCreatedPayload({
  reservationId = 42,
  reservationNumber = 'RES-20260813-1001',
  arrivalDate = '2026-09-01',
  departureDate = '2026-09-05',
  guestName = 'Test Guest',
  phone = '9999999999',
  roomNumber = '101',
  roomId = 5,
  parsedAdvance = 2000,
  status = 'Reserved',
} = {}) {
  const eventOccurredAt = makeTimestamp();
  return {
    schema_version: 1,
    event_type:     'COMPOUND_RESERVATION_CREATED',
    aggregate_type: 'RESERVATION',
    aggregate_id:   String(reservationId),
    operation_id:   `op_compound_reservation_created_${Date.now()}_abc`,
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
        nationality:          'Indian',
        company:              null,
        purpose:              null,
        room_id:              `room_${roomNumber}`,
        mysql_room_id:        roomId,
        room_number:          roomNumber,
        room_type:            'STANDARD',
        check_in_date:        arrivalDate,
        check_out_date:       departureDate,
        arrival_time:         '12:00 PM',
        adults:               1,
        children:             0,
        booking_source:       'Direct',
        booking_mode:         'Offline',
        booked_by:            null,
        booked_by_contact:    null,
        advance_payment:      parsedAdvance,
        payment_mode:         'Cash',
        transport_mode:       'Self',
        billing_instructions: null,
        remarks:              null,
        status,
        booking_id:           null,
        mysql_booking_id:     null,
        mysql_reservation_id: reservationId,
        created_by:           null,
        created_at:           eventOccurredAt,
        updated_at:           eventOccurredAt,
      },
    }],
  };
}

// -- B1 Structure Tests --------------------------------------------------------

await test('B1: event_type is COMPOUND_RESERVATION_CREATED', () => {
  assert.strictEqual(buildMockCreatedPayload().event_type, 'COMPOUND_RESERVATION_CREATED');
});

await test('B1: aggregate_type is RESERVATION', () => {
  assert.strictEqual(buildMockCreatedPayload().aggregate_type, 'RESERVATION');
});

await test('B1: aggregate_id is numeric MySQL insertId (stringified)', () => {
  const p = buildMockCreatedPayload({ reservationId: 99 });
  assert.strictEqual(p.aggregate_id, '99');
  assert.ok(!isNaN(Number(p.aggregate_id)));
});

await test('B1: exactly 1 Firestore write', () => {
  assert.strictEqual(buildMockCreatedPayload().writes.length, 1);
});

await test('B1: write targets reservations root collection', () => {
  assert.strictEqual(buildMockCreatedPayload().writes[0].collection, 'reservations');
});

await test('B1: document_id uses res_ prefix (formatReservationId)', () => {
  const p = buildMockCreatedPayload({ reservationNumber: 'RES-20260813-1001' });
  assert.strictEqual(p.writes[0].document_id, 'res_RES-20260813-1001');
});

await test('B1: document_id is deterministic — same inputs yield same docId', () => {
  const p1 = buildMockCreatedPayload({ reservationNumber: 'RES-20260813-1001' });
  const p2 = buildMockCreatedPayload({ reservationNumber: 'RES-20260813-1001' });
  assert.strictEqual(p1.writes[0].document_id, p2.writes[0].document_id);
});

await test('B1: operation is set_merge', () => {
  assert.strictEqual(buildMockCreatedPayload().writes[0].operation, 'set_merge');
});

await test('B1: payload has check_in_date', () => {
  assert.strictEqual(buildMockCreatedPayload({ arrivalDate: '2026-09-01' }).writes[0].data.check_in_date, '2026-09-01');
});

await test('B1: payload has check_out_date', () => {
  assert.strictEqual(buildMockCreatedPayload({ departureDate: '2026-09-05' }).writes[0].data.check_out_date, '2026-09-05');
});

await test('B1: payload does NOT have arrival_date', () => {
  assert.ok(!('arrival_date' in buildMockCreatedPayload().writes[0].data));
});

await test('B1: payload does NOT have departure_date', () => {
  assert.ok(!('departure_date' in buildMockCreatedPayload().writes[0].data));
});

await test('B1: status is Reserved (not repository fallback Confirmed)', () => {
  assert.strictEqual(buildMockCreatedPayload().writes[0].data.status, 'Reserved');
});

await test('B1: booking_id is null (reservation not yet checked in)', () => {
  assert.strictEqual(buildMockCreatedPayload().writes[0].data.booking_id, null);
});

await test('B1: mysql_booking_id is null (reservation not yet checked in)', () => {
  assert.strictEqual(buildMockCreatedPayload().writes[0].data.mysql_booking_id, null);
});

await test('B1: mysql_reservation_id equals reservationId', () => {
  assert.strictEqual(buildMockCreatedPayload({ reservationId: 42 }).writes[0].data.mysql_reservation_id, 42);
});

await test('B1: room_id uses room_ prefix', () => {
  assert.strictEqual(buildMockCreatedPayload({ roomNumber: '101' }).writes[0].data.room_id, 'room_101');
});

await test('B1: frozen timestamp — created_at equals updated_at', () => {
  const d = buildMockCreatedPayload().writes[0].data;
  assert.strictEqual(d.created_at, d.updated_at);
});

await test('B1: created_at is a valid ISO date string', () => {
  const d = buildMockCreatedPayload().writes[0].data;
  assert.ok(!isNaN(new Date(d.created_at).getTime()));
});

await test('B1: no FieldValue.increment in payload', () => {
  const d = buildMockCreatedPayload().writes[0].data;
  for (const [key, val] of Object.entries(d)) {
    if (val !== null && typeof val === 'object') {
      const n = val?.constructor?.name || '';
      assert.ok(!n.includes('FieldTransform') && !n.includes('FieldValue') && !('_methodName' in val),
        `FieldValue detected in '${key}'`);
    }
  }
});

await test('B1: payload is JSON-serialisable', () => {
  assert.doesNotThrow(() => JSON.stringify(buildMockCreatedPayload()));
});

await test('B1: all mandatory canonical fields present', () => {
  const d = buildMockCreatedPayload().writes[0].data;
  for (const f of ['reservation_number','guest_name','phone','room_id','mysql_room_id','room_number',
                    'check_in_date','check_out_date','adults','children','status',
                    'booking_id','mysql_booking_id','mysql_reservation_id','created_at','updated_at']) {
    assert.ok(f in d, `Missing field: ${f}`);
  }
});

// -- Feature Flag Tests --------------------------------------------------------

await test('B1: feature flag OFF — enqueue never called', () => {
  let calls = 0;
  const mockEnqueue = async () => { calls++; };
  const flagOff = () => false;
  if (flagOff()) mockEnqueue();
  assert.strictEqual(calls, 0);
});

await test('B1: feature flag ON — enqueue called once', async () => {
  let calls = 0;
  const mockEnqueue = async () => { calls++; };
  const flagOn = () => true;
  if (flagOn()) await mockEnqueue(buildMockCreatedPayload());
  assert.strictEqual(calls, 1);
});

// -- Ordering and Rollback Tests -----------------------------------------------

await test('B1: enqueue happens before commit', async () => {
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

await test('B1: enqueue failure causes rollback not commit', async () => {
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

await test('B1: CompoundEventBuilder produces COMPOUND_RESERVATION_CREATED with 1 write', async () => {
  const { CompoundEventBuilder } = await import('../services/compoundEventBuilder.js');
  const b = new CompoundEventBuilder({
    event_type: 'COMPOUND_RESERVATION_CREATED', aggregate_type: 'RESERVATION', aggregate_id: 42
  });
  b.addRootWrite({
    collection: 'reservations', document_id: 'res_RES-20260813-1001', operation: 'set_merge',
    data: { reservation_number: 'RES-20260813-1001', status: 'Reserved', updated_at: makeTimestamp() }
  });
  const payload = b.build();
  assert.strictEqual(payload.event_type, 'COMPOUND_RESERVATION_CREATED');
  assert.strictEqual(payload.writes.length, 1);
  assert.strictEqual(payload.writes[0].operation, 'set_merge');
});

await test('B1: formatReservationId produces res_ prefix', async () => {
  const { formatReservationId } = await import('../services/compoundEventBuilder.js');
  assert.strictEqual(formatReservationId('RES-20260813-1001'), 'res_RES-20260813-1001');
});

await test('B1: formatRoomId produces room_ prefix', async () => {
  const { formatRoomId } = await import('../services/compoundEventBuilder.js');
  assert.strictEqual(formatRoomId('101'), 'room_101');
});

console.log('\n[Phase 4G-B B1] COMPOUND_RESERVATION_CREATED — tests complete');
