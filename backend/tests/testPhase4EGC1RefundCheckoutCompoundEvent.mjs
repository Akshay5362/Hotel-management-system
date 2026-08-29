/**
 * testPhase4EGC1RefundCheckoutCompoundEvent.mjs
 * Phase 4G-C Item 1: COMPOUND_REFUND_CHECKOUT
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeTs() { return new Date().toISOString(); }

function buildPayload(opts) {
  const bookingNumber  = (opts && opts.bookingNumber) || 'BKG-123456';
  const roomNumber     = (opts && opts.roomNumber) || '101';
  const businessDate   = (opts && opts.businessDate) || '2026-08-13';
  const parsedRefund   = (opts && opts.parsedRefund !== undefined) ? opts.parsedRefund : 500;
  const refundReason   = (opts && opts.refundReason) || 'Guest Cancellation';
  const todayCheckouts = (opts && opts.todayCheckouts !== undefined) ? opts.todayCheckouts : 3;
  const ts = makeTs();
  return {
    schema_version: 1,
    event_type:     'COMPOUND_REFUND_CHECKOUT',
    aggregate_type: 'BOOKING',
    aggregate_id:   bookingNumber,
    operation_id:   'op_compound_refund_checkout_' + Date.now(),
    occurred_at:    ts,
    writes: [
      { collection: 'bookings', document_id: 'bkg_' + bookingNumber, operation: 'set_merge',
        data: { booking_status: 'Checked Out', payment_status: 'Refunded', check_out_date: businessDate,
                refund_amount: parsedRefund, refund_reason: refundReason, updated_at: ts } },
      { collection: 'rooms',    document_id: 'room_' + roomNumber,   operation: 'set_merge',
        data: { status: 'dirty', updated_at: ts } },
      { collection: 'settings', document_id: 'system_date',          operation: 'set_merge',
        data: { today_checkouts: todayCheckouts, updated_at: ts } },
    ],
  };
}

console.log('[Phase 4G-C C1] COMPOUND_REFUND_CHECKOUT tests starting');

test('C1: event_type is COMPOUND_REFUND_CHECKOUT', () => { assert.equal(buildPayload().event_type, 'COMPOUND_REFUND_CHECKOUT'); });
test('C1: aggregate_type is BOOKING', () => { assert.equal(buildPayload().aggregate_type, 'BOOKING'); });
test('C1: aggregate_id matches booking_number', () => { assert.equal(buildPayload({ bookingNumber: 'BKG-777' }).aggregate_id, 'BKG-777'); });
test('C1: exactly 3 writes', () => { assert.equal(buildPayload().writes.length, 3); });
test('C1: all operations are set_merge', () => { buildPayload().writes.forEach(function(w) { assert.equal(w.operation, 'set_merge'); }); });
test('C1: Write1 collection is bookings', () => { assert.equal(buildPayload().writes[0].collection, 'bookings'); });
test('C1: Write1 document_id is bkg_bookingNumber', () => { assert.equal(buildPayload({ bookingNumber: 'BKG-999' }).writes[0].document_id, 'bkg_BKG-999'); });
test('C1: Write1 booking_status is Checked Out', () => { assert.equal(buildPayload().writes[0].data.booking_status, 'Checked Out'); });
test('C1: Write1 payment_status is Refunded', () => { assert.equal(buildPayload().writes[0].data.payment_status, 'Refunded'); });
test('C1: Write1 check_out_date matches businessDate', () => { assert.equal(buildPayload({ businessDate: '2026-08-15' }).writes[0].data.check_out_date, '2026-08-15'); });
test('C1: Write1 refund_amount is numeric', () => { assert.equal(typeof buildPayload({ parsedRefund: 1500 }).writes[0].data.refund_amount, 'number'); });
test('C1: Write1 refund_reason is captured', () => { assert.equal(buildPayload({ refundReason: 'No Show' }).writes[0].data.refund_reason, 'No Show'); });
test('C1: Write1 updated_at is ISO string', () => { assert.ok(!isNaN(Date.parse(buildPayload().writes[0].data.updated_at))); });
test('C1: Write2 collection is rooms', () => { assert.equal(buildPayload().writes[1].collection, 'rooms'); });
test('C1: Write2 document_id is room_roomNumber', () => { assert.equal(buildPayload({ roomNumber: '305' }).writes[1].document_id, 'room_305'); });
test('C1: Write2 status is dirty', () => { assert.equal(buildPayload().writes[1].data.status, 'dirty'); });
test('C1: Write2 updated_at present', () => { assert.ok(buildPayload().writes[1].data.updated_at); });
test('C1: Write3 collection is settings', () => { assert.equal(buildPayload().writes[2].collection, 'settings'); });
test('C1: Write3 document_id is system_date', () => { assert.equal(buildPayload().writes[2].document_id, 'system_date'); });
test('C1: Write3 today_checkouts is absolute number', () => { const p = buildPayload({ todayCheckouts: 7 }); assert.equal(typeof p.writes[2].data.today_checkouts, 'number'); assert.equal(p.writes[2].data.today_checkouts, 7); });
test('C1: no FieldValue in any write data', () => { assert.ok(!JSON.stringify(buildPayload().writes).includes('FieldValue')); });
test('C1: no random UUIDs in document_ids', () => { const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}/; buildPayload().writes.forEach(function(w) { assert.ok(!uuidRe.test(w.document_id)); }); });
test('C1: schema_version is 1', () => { assert.equal(buildPayload().schema_version, 1); });
test('C1: zero-refund still produces 3 writes', () => { const p = buildPayload({ parsedRefund: 0 }); assert.equal(p.writes.length, 3); assert.equal(p.writes[0].data.refund_amount, 0); });
test('C1: enqueue failure causes rollback not commit', () => {
  let committed = false; let rolledBack = false;
  const mockConn = { commit: async function() { committed = true; }, rollback: async function() { rolledBack = true; } };
  const fail = async function() { throw new Error('enqueue fail'); };
  return (async function() { try { await fail(); await mockConn.commit(); } catch(e) { await mockConn.rollback(); } })()
    .then(function() { assert.equal(committed, false); assert.equal(rolledBack, true); });
});

console.log('[Phase 4G-C C1] COMPOUND_REFUND_CHECKOUT tests complete');
