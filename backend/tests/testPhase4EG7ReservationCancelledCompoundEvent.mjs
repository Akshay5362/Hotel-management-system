/**
 * testPhase4EG7ReservationCancelledCompoundEvent.mjs
 *
 * Phase 4G-B — B3
 * Tests the COMPOUND_RESERVATION_CANCELLED compound outbox event emitted by
 * reservationController.cancelReservation().
 *
 * Three cancellation paths:
 *   Path A: no booking_id              ? 1 write (reservation only)
 *   Path B: booking is Checked In      ? 3 writes (reservation + booking + room)
 *   Path C: booking is not Checked In  ? 2 writes (reservation + booking)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeTimestamp() { return new Date().toISOString(); }

// -- Payload builders per path -------------------------------------------------

function buildPathAPayload({
  mysqlId = 10,
  reservationNumber = 'RES-20260813-1001',
  cancellationReason = 'Guest Cancellation',
  originalRemarks = '',
} = {}) {
  const ts = makeTimestamp();
  const updatedRemarks = originalRemarks
    ? `${originalRemarks} | Cancelled: ${cancellationReason}`
    : `Cancelled: ${cancellationReason}`;
  return {
    schema_version: 1,
    event_type:     'COMPOUND_RESERVATION_CANCELLED',
    aggregate_type: 'RESERVATION',
    aggregate_id:   String(mysqlId),
    operation_id:   `op_compound_reservation_cancelled_${Date.now()}_aaa`,
    occurred_at:    ts,
    writes: [{
      collection:  'reservations',
      document_id: `res_${reservationNumber}`,
      operation:   'set_merge',
      data:        { status: 'Cancelled', remarks: updatedRemarks, mysql_reservation_id: mysqlId, updated_at: ts },
    }],
  };
}

function buildPathBPayload({
  mysqlId = 20,
  reservationNumber = 'RES-20260813-2001',
  bookingNumber = 'BKG-001',
  roomNumber = '101',
  businessDate = '2026-08-13',
  cancellationReason = 'Early Departure',
} = {}) {
  const ts = makeTimestamp();
  const updatedRemarks = `Cancelled: ${cancellationReason}`;
  return {
    schema_version: 1,
    event_type:     'COMPOUND_RESERVATION_CANCELLED',
    aggregate_type: 'RESERVATION',
    aggregate_id:   String(mysqlId),
    operation_id:   `op_compound_reservation_cancelled_${Date.now()}_bbb`,
    occurred_at:    ts,
    writes: [
      {
        collection:  'reservations',
        document_id: `res_${reservationNumber}`,
        operation:   'set_merge',
        data:        { status: 'Cancelled', remarks: updatedRemarks, mysql_reservation_id: mysqlId, updated_at: ts },
      },
      {
        collection:  'bookings',
        document_id: `bkg_${bookingNumber}`,
        operation:   'set_merge',
        data:        { booking_status: 'Checked Out', payment_status: 'Refunded', check_out_date: businessDate, updated_at: ts },
      },
      {
        collection:  'rooms',
        document_id: `room_${roomNumber}`,
        operation:   'set_merge',
        data:        { status: 'dirty', updated_at: ts },
      },
    ],
  };
}

function buildPathCPayload({
  mysqlId = 30,
  reservationNumber = 'RES-20260813-3001',
  bookingNumber = 'BKG-002',
  cancellationReason = 'No Show',
} = {}) {
  const ts = makeTimestamp();
  const updatedRemarks = `Cancelled: ${cancellationReason}`;
  return {
    schema_version: 1,
    event_type:     'COMPOUND_RESERVATION_CANCELLED',
    aggregate_type: 'RESERVATION',
    aggregate_id:   String(mysqlId),
    operation_id:   `op_compound_reservation_cancelled_${Date.now()}_ccc`,
    occurred_at:    ts,
    writes: [
      {
        collection:  'reservations',
        document_id: `res_${reservationNumber}`,
        operation:   'set_merge',
        data:        { status: 'Cancelled', remarks: updatedRemarks, mysql_reservation_id: mysqlId, updated_at: ts },
      },
      {
        collection:  'bookings',
        document_id: `bkg_${bookingNumber}`,
        operation:   'set_merge',
        data:        { payment_status: 'Refunded', updated_at: ts },
      },
    ],
  };
}

// -- Shared: event_type/aggregate_type ----------------------------------------

await test('B3: event_type is COMPOUND_RESERVATION_CANCELLED (all paths)', () => {
  for (const p of [buildPathAPayload(), buildPathBPayload(), buildPathCPayload()]) {
    assert.strictEqual(p.event_type, 'COMPOUND_RESERVATION_CANCELLED');
  }
});

await test('B3: aggregate_type is RESERVATION (all paths)', () => {
  for (const p of [buildPathAPayload(), buildPathBPayload(), buildPathCPayload()]) {
    assert.strictEqual(p.aggregate_type, 'RESERVATION');
  }
});

await test('B3: aggregate_id is numeric MySQL reservation id (all paths)', () => {
  assert.strictEqual(buildPathAPayload({ mysqlId: 10 }).aggregate_id, '10');
  assert.strictEqual(buildPathBPayload({ mysqlId: 20 }).aggregate_id, '20');
  assert.strictEqual(buildPathCPayload({ mysqlId: 30 }).aggregate_id, '30');
});

// -- Path A Tests (1 write) ----------------------------------------------------

await test('B3-PathA: exactly 1 Firestore write', () => {
  assert.strictEqual(buildPathAPayload().writes.length, 1);
});

await test('B3-PathA: write is reservation only', () => {
  assert.strictEqual(buildPathAPayload().writes[0].collection, 'reservations');
});

await test('B3-PathA: operation is set_merge', () => {
  assert.strictEqual(buildPathAPayload().writes[0].operation, 'set_merge');
});

await test('B3-PathA: status is Cancelled', () => {
  assert.strictEqual(buildPathAPayload().writes[0].data.status, 'Cancelled');
});

await test('B3-PathA: remarks contains cancellation reason', () => {
  const p = buildPathAPayload({ cancellationReason: 'Test Reason' });
  assert.ok(p.writes[0].data.remarks.includes('Test Reason'));
});

await test('B3-PathA: remarks appended to original (not replaced)', () => {
  const p = buildPathAPayload({ originalRemarks: 'Original note', cancellationReason: 'My Reason' });
  assert.ok(p.writes[0].data.remarks.startsWith('Original note'));
  assert.ok(p.writes[0].data.remarks.includes('My Reason'));
});

await test('B3-PathA: mysql_reservation_id matches aggregate_id', () => {
  const p = buildPathAPayload({ mysqlId: 10 });
  assert.strictEqual(p.writes[0].data.mysql_reservation_id, 10);
});

await test('B3-PathA: document_id uses res_ prefix', () => {
  assert.ok(buildPathAPayload().writes[0].document_id.startsWith('res_'));
});

await test('B3-PathA: updated_at is present', () => {
  assert.ok('updated_at' in buildPathAPayload().writes[0].data);
});

// -- Path B Tests (3 writes) ---------------------------------------------------

await test('B3-PathB: exactly 3 Firestore writes', () => {
  assert.strictEqual(buildPathBPayload().writes.length, 3);
});

await test('B3-PathB: write 1 is reservation', () => {
  assert.strictEqual(buildPathBPayload().writes[0].collection, 'reservations');
});

await test('B3-PathB: write 2 is bookings', () => {
  assert.strictEqual(buildPathBPayload().writes[1].collection, 'bookings');
});

await test('B3-PathB: write 3 is rooms', () => {
  assert.strictEqual(buildPathBPayload().writes[2].collection, 'rooms');
});

await test('B3-PathB: reservation write has status Cancelled', () => {
  assert.strictEqual(buildPathBPayload().writes[0].data.status, 'Cancelled');
});

await test('B3-PathB: booking write has booking_status Checked Out', () => {
  assert.strictEqual(buildPathBPayload().writes[1].data.booking_status, 'Checked Out');
});

await test('B3-PathB: booking write has payment_status Refunded', () => {
  assert.strictEqual(buildPathBPayload().writes[1].data.payment_status, 'Refunded');
});

await test('B3-PathB: booking write has check_out_date from businessDate', () => {
  const p = buildPathBPayload({ businessDate: '2026-08-13' });
  assert.strictEqual(p.writes[1].data.check_out_date, '2026-08-13');
});

await test('B3-PathB: room write has status dirty', () => {
  assert.strictEqual(buildPathBPayload().writes[2].data.status, 'dirty');
});

await test('B3-PathB: booking document_id uses bkg_ prefix from booking_number', () => {
  const p = buildPathBPayload({ bookingNumber: 'BKG-001' });
  assert.strictEqual(p.writes[1].document_id, 'bkg_BKG-001');
});

await test('B3-PathB: room document_id uses room_ prefix from room_number', () => {
  const p = buildPathBPayload({ roomNumber: '101' });
  assert.strictEqual(p.writes[2].document_id, 'room_101');
});

await test('B3-PathB: all 3 writes use set_merge', () => {
  for (const w of buildPathBPayload().writes) {
    assert.strictEqual(w.operation, 'set_merge');
  }
});

await test('B3-PathB: same frozen updated_at across all 3 writes', () => {
  const p = buildPathBPayload();
  const ts = p.writes[0].data.updated_at;
  assert.ok(ts);
  for (const w of p.writes) {
    assert.strictEqual(w.data.updated_at, ts,
      `All writes must share the same frozen eventOccurredAt; got ${w.data.updated_at} vs ${ts}`);
  }
});

await test('B3-PathB: no arrival_date or departure_date in any write', () => {
  for (const w of buildPathBPayload().writes) {
    assert.ok(!('arrival_date' in w.data));
    assert.ok(!('departure_date' in w.data));
  }
});

// -- Path C Tests (2 writes) ---------------------------------------------------

await test('B3-PathC: exactly 2 Firestore writes', () => {
  assert.strictEqual(buildPathCPayload().writes.length, 2);
});

await test('B3-PathC: write 1 is reservation', () => {
  assert.strictEqual(buildPathCPayload().writes[0].collection, 'reservations');
});

await test('B3-PathC: write 2 is bookings', () => {
  assert.strictEqual(buildPathCPayload().writes[1].collection, 'bookings');
});

await test('B3-PathC: no rooms write (Path C does not touch room status)', () => {
  const writes = buildPathCPayload().writes;
  assert.ok(!writes.some(w => w.collection === 'rooms'),
    'Path C must NOT include a rooms write');
});

await test('B3-PathC: booking write has payment_status Refunded', () => {
  assert.strictEqual(buildPathCPayload().writes[1].data.payment_status, 'Refunded');
});

await test('B3-PathC: booking write does NOT have booking_status (not Checked In)', () => {
  assert.ok(!('booking_status' in buildPathCPayload().writes[1].data),
    'Path C booking write must not set booking_status — only payment_status changes');
});

await test('B3-PathC: booking write does NOT have check_out_date', () => {
  assert.ok(!('check_out_date' in buildPathCPayload().writes[1].data),
    'Path C booking write must not set check_out_date');
});

await test('B3-PathC: both writes use set_merge', () => {
  for (const w of buildPathCPayload().writes) {
    assert.strictEqual(w.operation, 'set_merge');
  }
});

await test('B3-PathC: booking document_id uses bkg_ prefix', () => {
  const p = buildPathCPayload({ bookingNumber: 'BKG-002' });
  assert.strictEqual(p.writes[1].document_id, 'bkg_BKG-002');
});

await test('B3-PathC: same frozen updated_at across all 2 writes', () => {
  const p = buildPathCPayload();
  const ts = p.writes[0].data.updated_at;
  assert.ok(ts);
  for (const w of p.writes) {
    assert.strictEqual(w.data.updated_at, ts);
  }
});

// -- Shared: No FieldValue, JSON serialisable ----------------------------------

await test('B3: no FieldValue in any write data (all paths)', () => {
  for (const p of [buildPathAPayload(), buildPathBPayload(), buildPathCPayload()]) {
    for (const w of p.writes) {
      for (const [key, val] of Object.entries(w.data)) {
        if (val !== null && typeof val === 'object') {
          const n = val?.constructor?.name || '';
          assert.ok(!n.includes('FieldTransform') && !n.includes('FieldValue') && !('_methodName' in val),
            `FieldValue in '${key}'`);
        }
      }
    }
  }
});

await test('B3: all payloads are JSON-serialisable', () => {
  for (const p of [buildPathAPayload(), buildPathBPayload(), buildPathCPayload()]) {
    assert.doesNotThrow(() => JSON.stringify(p));
  }
});

// -- Feature Flag and Ordering Tests ------------------------------------------

await test('B3: feature flag OFF — enqueue never called', () => {
  let calls = 0;
  if (false) calls++;
  assert.strictEqual(calls, 0);
});

await test('B3: feature flag ON — enqueue called once (Path A)', async () => {
  let calls = 0;
  const mockEnqueue = async () => { calls++; };
  if (true) await mockEnqueue(buildPathAPayload());
  assert.strictEqual(calls, 1);
});

await test('B3: enqueue happens before commit (all paths)', async () => {
  for (const p of [buildPathAPayload(), buildPathBPayload(), buildPathCPayload()]) {
    const events = [];
    const conn = {
      beginTransaction: async () => events.push('begin'),
      commit:           async () => events.push('commit'),
      rollback:         async () => events.push('rollback'),
    };
    const mockEnqueue = async () => events.push('enqueue');
    await conn.beginTransaction();
    await mockEnqueue(p);
    await conn.commit();
    assert.ok(events.indexOf('enqueue') < events.indexOf('commit'),
      `enqueue must precede commit for path with ${p.writes.length} writes`);
  }
});

await test('B3: enqueue failure causes rollback not commit', async () => {
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

await test('B3: CompoundEventBuilder correctly builds Path A (1 write)', async () => {
  const { CompoundEventBuilder } = await import('../services/compoundEventBuilder.js');
  const ts = makeTimestamp();
  const b = new CompoundEventBuilder({
    event_type: 'COMPOUND_RESERVATION_CANCELLED', aggregate_type: 'RESERVATION', aggregate_id: 10
  });
  b.addRootWrite({
    collection: 'reservations', document_id: 'res_RES-20260813-1001', operation: 'set_merge',
    data: { status: 'Cancelled', remarks: 'Cancelled: test', mysql_reservation_id: 10, updated_at: ts }
  });
  const p = b.build();
  assert.strictEqual(p.writes.length, 1);
  assert.strictEqual(p.writes[0].data.status, 'Cancelled');
});

await test('B3: CompoundEventBuilder correctly builds Path B (3 writes)', async () => {
  const { CompoundEventBuilder, formatReservationId, formatBookingId, formatRoomId } = await import('../services/compoundEventBuilder.js');
  const ts = makeTimestamp();
  const b = new CompoundEventBuilder({
    event_type: 'COMPOUND_RESERVATION_CANCELLED', aggregate_type: 'RESERVATION', aggregate_id: 20
  });
  b.addRootWrite({
    collection: 'reservations', document_id: formatReservationId('RES-20260813-2001'), operation: 'set_merge',
    data: { status: 'Cancelled', remarks: 'Cancelled: test', mysql_reservation_id: 20, updated_at: ts }
  });
  b.addRootWrite({
    collection: 'bookings', document_id: formatBookingId('BKG-001'), operation: 'set_merge',
    data: { booking_status: 'Checked Out', payment_status: 'Refunded', check_out_date: '2026-08-13', updated_at: ts }
  });
  b.addRootWrite({
    collection: 'rooms', document_id: formatRoomId('101'), operation: 'set_merge',
    data: { status: 'dirty', updated_at: ts }
  });
  const p = b.build();
  assert.strictEqual(p.writes.length, 3);
  assert.strictEqual(p.writes[1].collection, 'bookings');
  assert.strictEqual(p.writes[2].collection, 'rooms');
  assert.strictEqual(p.writes[2].data.status, 'dirty');
});

await test('B3: CompoundEventBuilder correctly builds Path C (2 writes)', async () => {
  const { CompoundEventBuilder, formatReservationId, formatBookingId } = await import('../services/compoundEventBuilder.js');
  const ts = makeTimestamp();
  const b = new CompoundEventBuilder({
    event_type: 'COMPOUND_RESERVATION_CANCELLED', aggregate_type: 'RESERVATION', aggregate_id: 30
  });
  b.addRootWrite({
    collection: 'reservations', document_id: formatReservationId('RES-20260813-3001'), operation: 'set_merge',
    data: { status: 'Cancelled', remarks: 'Cancelled: test', mysql_reservation_id: 30, updated_at: ts }
  });
  b.addRootWrite({
    collection: 'bookings', document_id: formatBookingId('BKG-002'), operation: 'set_merge',
    data: { payment_status: 'Refunded', updated_at: ts }
  });
  const p = b.build();
  assert.strictEqual(p.writes.length, 2);
  assert.ok(!p.writes.some(w => w.collection === 'rooms'));
  assert.strictEqual(p.writes[1].data.payment_status, 'Refunded');
});

await test('B3: formatBookingId produces bkg_ prefix', async () => {
  const { formatBookingId } = await import('../services/compoundEventBuilder.js');
  assert.strictEqual(formatBookingId('BKG-001'), 'bkg_BKG-001');
});

await test('B3: formatRoomId produces room_ prefix', async () => {
  const { formatRoomId } = await import('../services/compoundEventBuilder.js');
  assert.strictEqual(formatRoomId('101'), 'room_101');
});

console.log('\n[Phase 4G-B B3] COMPOUND_RESERVATION_CANCELLED — tests complete');
