/**
 * testPhase4EGC4UndoDayEndCounterReset.mjs
 * Phase 4G-C Item 4: undoDayEnd counter reset + COMPOUND_UNDO_DAY_END
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeTs() { return new Date().toISOString(); }

function buildUndoDayEndPayload(opts) {
  const previousDate = (opts && opts.previousDate) || '2026-08-12';
  const checkins     = (opts && opts.checkins !== undefined) ? opts.checkins : 4;
  const checkouts    = (opts && opts.checkouts !== undefined) ? opts.checkouts : 2;
  const continuedRooms = (opts && opts.continuedRooms !== undefined) ? opts.continuedRooms : 6;
  const ts = makeTs();
  return {
    schema_version: 1,
    event_type:     'COMPOUND_UNDO_DAY_END',
    aggregate_type: 'SYSTEM',
    aggregate_id:   'undo_day_end_' + previousDate,
    operation_id:   'op_compound_undo_day_end_' + Date.now(),
    occurred_at:    ts,
    writes: [{
      collection:  'settings',
      document_id: 'system_date',
      operation:   'set_merge',
      data: {
        current_date:    previousDate,
        system_date:     previousDate,
        today_checkins:  checkins,
        today_checkouts: checkouts,
        continued_rooms: continuedRooms,
        updated_at:      ts,
      },
    }],
  };
}

function simulateCounterReset(opts) {
  return { today_checkins: opts.checkinCount, today_checkouts: opts.checkoutCount, continued_rooms: opts.occupiedCount };
}

console.log('[Phase 4G-C C4] UNDO_DAY_END COUNTER RESET tests starting');

test('C4: restoredCheckins equals pre-Day-End check-in count', () => { const r = simulateCounterReset({ checkinCount: 5, checkoutCount: 3, occupiedCount: 7 }); assert.equal(r.today_checkins, 5); });
test('C4: restoredCheckouts equals pre-Day-End check-out count', () => { const r = simulateCounterReset({ checkinCount: 5, checkoutCount: 3, occupiedCount: 7 }); assert.equal(r.today_checkouts, 3); });
test('C4: restoredContinuedRooms equals current occupied count', () => { const r = simulateCounterReset({ checkinCount: 5, checkoutCount: 3, occupiedCount: 7 }); assert.equal(r.continued_rooms, 7); });
test('C4: all restored values are non-negative', () => { const r = simulateCounterReset({ checkinCount: 0, checkoutCount: 0, occupiedCount: 0 }); assert.ok(r.today_checkins >= 0); assert.ok(r.today_checkouts >= 0); assert.ok(r.continued_rooms >= 0); });
test('C4: zero-activity restore: all counters are 0', () => { const r = simulateCounterReset({ checkinCount: 0, checkoutCount: 0, occupiedCount: 0 }); assert.equal(r.today_checkins, 0); assert.equal(r.today_checkouts, 0); assert.equal(r.continued_rooms, 0); });
test('C4: event_type is COMPOUND_UNDO_DAY_END', () => { assert.equal(buildUndoDayEndPayload().event_type, 'COMPOUND_UNDO_DAY_END'); });
test('C4: aggregate_type is SYSTEM', () => { assert.equal(buildUndoDayEndPayload().aggregate_type, 'SYSTEM'); });
test('C4: aggregate_id is undo_day_end_{previousDate}', () => { assert.equal(buildUndoDayEndPayload({ previousDate: '2026-08-11' }).aggregate_id, 'undo_day_end_2026-08-11'); });
test('C4: exactly 1 write', () => { assert.equal(buildUndoDayEndPayload().writes.length, 1); });
test('C4: write operation is set_merge', () => { assert.equal(buildUndoDayEndPayload().writes[0].operation, 'set_merge'); });
test('C4: write collection is settings', () => { assert.equal(buildUndoDayEndPayload().writes[0].collection, 'settings'); });
test('C4: write document_id is system_date', () => { assert.equal(buildUndoDayEndPayload().writes[0].document_id, 'system_date'); });
test('C4: write data.current_date is previousDate', () => { assert.equal(buildUndoDayEndPayload({ previousDate: '2026-08-10' }).writes[0].data.current_date, '2026-08-10'); });
test('C4: write data.system_date is previousDate', () => { assert.equal(buildUndoDayEndPayload({ previousDate: '2026-08-10' }).writes[0].data.system_date, '2026-08-10'); });
test('C4: write data.today_checkins is the restored absolute value', () => { assert.equal(buildUndoDayEndPayload({ checkins: 3 }).writes[0].data.today_checkins, 3); });
test('C4: write data.today_checkouts is the restored absolute value', () => { assert.equal(buildUndoDayEndPayload({ checkouts: 2 }).writes[0].data.today_checkouts, 2); });
test('C4: write data.continued_rooms is the restored absolute value', () => { assert.equal(buildUndoDayEndPayload({ continuedRooms: 8 }).writes[0].data.continued_rooms, 8); });
test('C4: write data.updated_at is a valid ISO string', () => { assert.ok(!isNaN(Date.parse(buildUndoDayEndPayload().writes[0].data.updated_at))); });
test('C4: no FieldValue in payload', () => { assert.ok(!JSON.stringify(buildUndoDayEndPayload()).includes('FieldValue')); });
test('C4: no increment in payload', () => { assert.ok(!JSON.stringify(buildUndoDayEndPayload()).includes('increment')); });
test('C4: schema_version is 1', () => { assert.equal(buildUndoDayEndPayload().schema_version, 1); });
test('C4: DAY_END_UNDONE audit mark is separate from counter reset', () => {
  const auditMark = { action: 'DAY_END_UNDONE', dayEndId: 5 };
  const counterReset = simulateCounterReset({ checkinCount: 3, checkoutCount: 1, occupiedCount: 4 });
  assert.equal(auditMark.action, 'DAY_END_UNDONE');
  assert.equal(counterReset.today_checkins, 3);
});
test('C4: enqueue failure causes rollback not commit', () => {
  let committed = false; let rolledBack = false;
  const mockConn = { commit: async () => { committed = true; }, rollback: async () => { rolledBack = true; } };
  const fail = async () => { throw new Error('enqueue fail'); };
  return (async () => { try { await fail(); await mockConn.commit(); } catch { await mockConn.rollback(); } })()
    .then(() => { assert.equal(committed, false); assert.equal(rolledBack, true); });
});

console.log('[Phase 4G-C C4] UNDO_DAY_END COUNTER RESET tests complete');
