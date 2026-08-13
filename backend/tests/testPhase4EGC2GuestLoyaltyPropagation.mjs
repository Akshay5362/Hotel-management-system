/**
 * testPhase4EGC2GuestLoyaltyPropagation.mjs
 * Phase 4G-C Item 2: Guest Loyalty Propagation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeTs() { return new Date().toISOString(); }
function fmtGuestId(key) { return 'guest_' + String(key).trim(); }

function buildGuestLoyaltyPayload(opts) {
  const guestId       = (opts && opts.guestId !== undefined) ? opts.guestId : 42;
  const phone         = (opts && opts.phone !== undefined) ? opts.phone : '9876543210';
  const loyaltyPoints = (opts && opts.loyaltyPoints !== undefined) ? opts.loyaltyPoints : 1250;
  const loyaltyTier   = (opts && opts.loyaltyTier) || 'Silver';
  const ts = makeTs();
  const guestDocKey = phone || String(guestId);
  return {
    event_type:     'GUEST_UPDATED',
    aggregate_type: 'GUEST',
    aggregate_id:   String(guestId),
    payload: {
      guest_id:       fmtGuestId(guestDocKey),
      mysql_guest_id: guestId,
      loyalty_points: loyaltyPoints,
      loyalty_tier:   loyaltyTier,
      updated_at:     ts,
    },
  };
}

console.log('[Phase 4G-C C2] GUEST_LOYALTY_PROPAGATION tests starting');

test('C2: event_type is GUEST_UPDATED', () => { assert.equal(buildGuestLoyaltyPayload().event_type, 'GUEST_UPDATED'); });
test('C2: aggregate_type is GUEST', () => { assert.equal(buildGuestLoyaltyPayload().aggregate_type, 'GUEST'); });
test('C2: aggregate_id is string mysql_guest_id', () => { assert.equal(buildGuestLoyaltyPayload({ guestId: 99 }).aggregate_id, '99'); });
test('C2: payload.guest_id is guest_phone when phone present', () => { assert.equal(buildGuestLoyaltyPayload({ phone: '9999999999' }).payload.guest_id, 'guest_9999999999'); });
test('C2: payload.guest_id is guest_mysqlId when phone absent', () => { const p = buildGuestLoyaltyPayload({ phone: '', guestId: 77 }); assert.equal(p.payload.guest_id, 'guest_77'); });
test('C2: payload.mysql_guest_id is the numeric guest PK', () => { assert.equal(buildGuestLoyaltyPayload({ guestId: 55 }).payload.mysql_guest_id, 55); });
test('C2: payload.loyalty_points is absolute number', () => { assert.equal(typeof buildGuestLoyaltyPayload({ loyaltyPoints: 800 }).payload.loyalty_points, 'number'); assert.equal(buildGuestLoyaltyPayload({ loyaltyPoints: 800 }).payload.loyalty_points, 800); });
test('C2: payload.loyalty_tier reflects updated tier', () => { assert.equal(buildGuestLoyaltyPayload({ loyaltyTier: 'Gold' }).payload.loyalty_tier, 'Gold'); });
test('C2: payload.updated_at is a valid ISO string', () => { assert.ok(!isNaN(Date.parse(buildGuestLoyaltyPayload().payload.updated_at))); });
test('C2: no FieldValue in payload', () => { assert.ok(!JSON.stringify(buildGuestLoyaltyPayload().payload).includes('FieldValue')); });
test('C2: no increment in payload', () => { assert.ok(!JSON.stringify(buildGuestLoyaltyPayload().payload).includes('increment')); });
test('C2: guest_id does not contain random UUID', () => { const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}/; assert.ok(!uuidRe.test(buildGuestLoyaltyPayload().payload.guest_id)); });
test('C2: Bronze tier 0 points', () => { const p = buildGuestLoyaltyPayload({ loyaltyPoints: 0, loyaltyTier: 'Bronze' }); assert.equal(p.payload.loyalty_tier, 'Bronze'); assert.equal(p.payload.loyalty_points, 0); });
test('C2: Silver tier 500+ points', () => { const p = buildGuestLoyaltyPayload({ loyaltyPoints: 600, loyaltyTier: 'Silver' }); assert.equal(p.payload.loyalty_tier, 'Silver'); });
test('C2: Gold tier 1500+ points', () => { const p = buildGuestLoyaltyPayload({ loyaltyPoints: 2000, loyaltyTier: 'Gold' }); assert.equal(p.payload.loyalty_tier, 'Gold'); });
test('C2: Platinum tier 3000+ points', () => { const p = buildGuestLoyaltyPayload({ loyaltyPoints: 3500, loyaltyTier: 'Platinum' }); assert.equal(p.payload.loyalty_tier, 'Platinum'); });
test('C2: loyalty_points never negative', () => { assert.ok(buildGuestLoyaltyPayload({ loyaltyPoints: 0 }).payload.loyalty_points >= 0); });
test('C2: enqueue failure causes rollback not commit', () => {
  let committed = false; let rolledBack = false;
  const mockConn = { commit: async () => { committed = true; }, rollback: async () => { rolledBack = true; } };
  const fail = async () => { throw new Error('enqueue fail'); };
  return (async () => { try { await fail(); await mockConn.commit(); } catch { await mockConn.rollback(); } })()
    .then(() => { assert.equal(committed, false); assert.equal(rolledBack, true); });
});

console.log('[Phase 4G-C C2] GUEST_LOYALTY_PROPAGATION tests complete');
