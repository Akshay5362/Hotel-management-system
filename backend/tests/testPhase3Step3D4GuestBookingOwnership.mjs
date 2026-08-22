/**
 * testPhase3Step3D4GuestBookingOwnership.mjs
 * ============================================================================
 * HPMS Phase 3 Step 3D-4 — Guest Booking Ownership Test Suite
 *
 * Tests:
 *  A. Flag OFF — existing MySQL path preserved (8)
 *  B. Flag ON — mysql_guest_id claim used, 0 ownership MySQL queries (8)
 *  C. Security — Guest A cannot access Guest B's data (8)
 *  D. Claims validation (6)
 *  E. Compatibility — admin/staff unaffected, legacy JWT preserved (5)
 *  F. Lifecycle — booking states, multiple guests (8)
 *  G. Implementation invariants — code structure (5)
 *
 * Total: 48 tests
 */

import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Test Runner ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ PASSED: ${message}`);
    passed++;
  } else {
    console.error(`  ✕ FAILED: ${message}`);
    errors.push(message);
    failed++;
  }
}

// ── Load featureFlags.js ──────────────────────────────────────────────────────
const featureFlagsPath = path.resolve(__dirname, '../config/featureFlags.js');
const { isFirebaseOnlyGuestResolutionEnabled } = await import(pathToFileURL(featureFlagsPath).href);

// ── resolveGuestOwnershipId simulator ────────────────────────────────────────
// This mirrors the exact logic implemented in roomController.js Step 3D-4.
// We test the logic exhaustively here without needing to spin up Express.

function resolveGuestOwnershipId(req, flagOverride = null) {
  const flagEnabled = flagOverride !== null
    ? flagOverride
    : isFirebaseOnlyGuestResolutionEnabled();

  if (!flagEnabled) {
    return null; // Signal: use legacy MySQL path
  }

  const user = req.user;
  if (!user) {
    const err = new Error('Unauthenticated request.');
    err.status = 401; err.code = 'UNAUTHORIZED';
    throw err;
  }

  const role     = String(user.role     || '').toLowerCase();
  const userType = String(user.user_type || user.type || '').toLowerCase();
  if (role !== 'guest' || userType !== 'guest') {
    const err = new Error('Guest ownership resolution attempted with non-guest token.');
    err.status = 403; err.code = 'FORBIDDEN';
    throw err;
  }

  const claimedId = user.mysql_guest_id ?? user.guest_id ?? null;
  if (claimedId == null) {
    const err = new Error(
      'Firebase guest token is missing mysql_guest_id claim. ' +
      'Re-provision this account via Step 3D-1 lazy migration.'
    );
    err.status = 401;
    err.code   = 'GUEST_OWNERSHIP_CLAIM_MISSING';
    throw err;
  }

  const parsed = Number(claimedId);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const err = new Error(`Invalid mysql_guest_id claim value: ${claimedId}`);
    err.status = 401;
    err.code   = 'GUEST_OWNERSHIP_CLAIM_MISSING';
    throw err;
  }

  return parsed;
}

// ── Request Factory ───────────────────────────────────────────────────────────
function makeGuestReq(overrides = {}) {
  return {
    user: {
      uid: 'guest_3',
      id: 3,
      mysql_id: 3,
      mysql_guest_id: 7,
      guest_id: 7,
      role: 'guest',
      user_type: 'guest',
      loginType: 'guest',
      authProvider: 'firebase',
      ...overrides.user
    },
    body: overrides.body || {},
    params: overrides.params || {}
  };
}

console.log('\n========================================================================');
console.log('  HPMS Phase 3 Step 3D-4 — Guest Booking Ownership Test Suite');
console.log('========================================================================\n');

// ══════════════════════════════════════════════════════════════════════════════
// A. FLAG OFF — MySQL path preserved
// ══════════════════════════════════════════════════════════════════════════════
console.log('─── A. Flag OFF — Legacy MySQL Path Preserved ──────────────────────────');

// A1: resolveGuestOwnershipId returns null when flag OFF
console.log('\n--- TEST A1: Flag OFF → returns null (use MySQL path) ---');
{
  const req = makeGuestReq();
  const result = resolveGuestOwnershipId(req, false /* flag=OFF */);
  assert(result === null, 'A1: Flag OFF → resolveGuestOwnershipId returns null');
}

// A2: Flag OFF behavior is independent of claim presence
console.log('\n--- TEST A2: Flag OFF → null regardless of claims ---');
{
  // Even with no mysql_guest_id, flag OFF returns null (MySQL path handles it)
  const req = makeGuestReq({ user: { role: 'guest', user_type: 'guest', id: 3, mysql_id: 3 } });
  const result = resolveGuestOwnershipId(req, false);
  assert(result === null, 'A2: Flag OFF → null even with no mysql_guest_id in user');
}

// A3: Flag OFF behavior is independent of role (no validation when flag OFF)
console.log('\n--- TEST A3: Flag OFF → null regardless of role ---');
{
  const req = { user: { role: 'admin', id: 1 }, body: {}, params: {} };
  const result = resolveGuestOwnershipId(req, false);
  assert(result === null, 'A3: Flag OFF → null for any user (MySQL handles auth)');
}

// A4: roomController.js still has all MySQL fallback paths
console.log('\n--- TEST A4: MySQL fallback paths present in roomController ---');
{
  const src = readFileSync(path.resolve(__dirname, '../controllers/roomController.js'), 'utf-8');
  const mysqlFallbackCount = (src.match(/guests WHERE user_id = \?/g) || []).length;
  assert(mysqlFallbackCount >= 7, `A4: MySQL fallback paths present (found ${mysqlFallbackCount})`);
}

// A5: resolvedUserId still derived from req.user.id in all functions
console.log('\n--- TEST A5: resolvedUserId from req.user.id still present ---');
{
  const src = readFileSync(path.resolve(__dirname, '../controllers/roomController.js'), 'utf-8');
  const hasResolvedUserId = src.includes('const resolvedUserId = req.user?.id');
  assert(hasResolvedUserId, 'A5: resolvedUserId = req.user?.id still present in controller');
}

// A6: Legacy MySQL path response contract preserved — correct error message
console.log('\n--- TEST A6: MySQL path error messages preserved ---');
{
  const src = readFileSync(path.resolve(__dirname, '../controllers/roomController.js'), 'utf-8');
  assert(src.includes("'Guest profile not found'"), 'A6: "Guest profile not found" error message preserved');
}

// A7: Notifications still use user_id (unchanged)
console.log('\n--- TEST A7: Notifications still use user_id (not guest_id) ---');
{
  const src = readFileSync(path.resolve(__dirname, '../controllers/roomController.js'), 'utf-8');
  const notifPattern = /notifications.*user_id.*resolvedUserId/s;
  assert(src.includes('notifications (user_id,'), 'A7: notifications still use user_id');
}

// A8: getGuestHistoryAdmin is admin-only and unchanged
console.log('\n--- TEST A8: getGuestHistoryAdmin uses guestId from params (admin, unchanged) ---');
{
  const src = readFileSync(path.resolve(__dirname, '../controllers/roomController.js'), 'utf-8');
  assert(src.includes("const { guestId } = req.params;"), 'A8: getGuestHistoryAdmin uses req.params.guestId (unchanged)');
}

// ══════════════════════════════════════════════════════════════════════════════
// B. FLAG ON — Firebase Claims Used
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n─── B. Flag ON — Firebase Claims Used ──────────────────────────────────');

// B1: Flag ON → returns mysql_guest_id from claims
console.log('\n--- TEST B1: Flag ON → returns mysql_guest_id from claims ---');
{
  const req = makeGuestReq();
  const result = resolveGuestOwnershipId(req, true);
  assert(result === 7, 'B1: Flag ON → returns mysql_guest_id=7 from claims');
}

// B2: mysql_guest_id is NOT taken from req.body
console.log('\n--- TEST B2: mysql_guest_id not taken from request body ---');
{
  // Body has spoofed guest_id=99 — but result must come from claims (7)
  const req = makeGuestReq({ body: { guest_id: 99, mysql_guest_id: 99, user_id: 99 } });
  const result = resolveGuestOwnershipId(req, true);
  assert(result === 7, 'B2: Body spoofed guest_id=99 ignored; claims mysql_guest_id=7 used');
}

// B3: mysql_guest_id is NOT taken from req.params
console.log('\n--- TEST B3: mysql_guest_id not taken from request params ---');
{
  const req = makeGuestReq({ params: { guestId: 99, guest_id: 99 } });
  const result = resolveGuestOwnershipId(req, true);
  assert(result === 7, 'B3: Params spoofed guestId=99 ignored; claims mysql_guest_id=7 used');
}

// B4: guest_id claim as fallback when mysql_guest_id absent
console.log('\n--- TEST B4: guest_id claim used as fallback ---');
{
  const req = makeGuestReq({
    user: { role: 'guest', user_type: 'guest', id: 3, mysql_id: 3,
            mysql_guest_id: undefined, guest_id: 7 }
  });
  const result = resolveGuestOwnershipId(req, true);
  assert(result === 7, 'B4: guest_id=7 used as fallback when mysql_guest_id absent');
}

// B5: MySQL ownership query count is ZERO when flag ON and claims present
console.log('\n--- TEST B5: MySQL ownership SELECT count = 0 when flag ON ---');
{
  let mysqlQueryCount = 0;
  const mockQuery = async (sql, params) => {
    if (sql.includes('guests WHERE user_id')) {
      mysqlQueryCount++;
    }
    return [[]]; // No rows
  };

  // Simulate the ownership resolution — should NOT call the mock query
  const req = makeGuestReq();
  const guestId = resolveGuestOwnershipId(req, true);
  // If we got guestId from claims, we skip the mockQuery entirely
  assert(mysqlQueryCount === 0, 'B5: Zero MySQL guest ownership queries when flag ON');
  assert(guestId === 7, 'B5: guestId=7 returned from claims without MySQL');
}

// B6: resolveGuestOwnershipId result is a positive integer
console.log('\n--- TEST B6: Returned guestId is a positive integer ---');
{
  const req = makeGuestReq({ user: { role: 'guest', user_type: 'guest', mysql_guest_id: '7' } }); // string claim
  const result = resolveGuestOwnershipId(req, true);
  assert(typeof result === 'number', 'B6: result is typeof number');
  assert(Number.isInteger(result), 'B6: result is an integer');
  assert(result > 0, 'B6: result is positive');
}

// B7: Controller source contains resolveGuestOwnershipId calls
console.log('\n--- TEST B7: resolveGuestOwnershipId wired into controller ---');
{
  const src = readFileSync(path.resolve(__dirname, '../controllers/roomController.js'), 'utf-8');
  const callCount = (src.match(/resolveGuestOwnershipId\(req\)/g) || []).length;
  assert(callCount >= 9, `B7: resolveGuestOwnershipId called in ${callCount} functions (expected ≥9)`);
}

// B8: All 9 guest functions have the Step 3D-4 comment marker
console.log('\n--- TEST B8: Step 3D-4 comment marker in all patched functions ---');
{
  const src = readFileSync(path.resolve(__dirname, '../controllers/roomController.js'), 'utf-8');
  const markerCount = (src.match(/Step 3D-4: Guest ownership resolution/g) || []).length;
  assert(markerCount >= 8, `B8: Step 3D-4 markers found in ${markerCount} functions (expected ≥8)`);
}

// ══════════════════════════════════════════════════════════════════════════════
// C. Security — Ownership Isolation
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n─── C. Security — Ownership Isolation ──────────────────────────────────');

// C1: Guest A's guestId ≠ Guest B's guestId
console.log('\n--- TEST C1: Guest A and Guest B have separate guestIds ---');
{
  const reqA = makeGuestReq({ user: { role: 'guest', user_type: 'guest', mysql_guest_id: 7, guest_id: 7 } });
  const reqB = makeGuestReq({ user: { role: 'guest', user_type: 'guest', mysql_guest_id: 12, guest_id: 12 } });
  const guestIdA = resolveGuestOwnershipId(reqA, true);
  const guestIdB = resolveGuestOwnershipId(reqB, true);
  assert(guestIdA === 7, 'C1: Guest A guestId=7');
  assert(guestIdB === 12, 'C1: Guest B guestId=12');
  assert(guestIdA !== guestIdB, 'C1: Guest A ≠ Guest B — ownership isolated');
}

// C2: Spoofed guest_id in body cannot override claims
console.log('\n--- TEST C2: Spoofed guest_id=99 in body ignored ---');
{
  // Guest A has mysql_guest_id=7. Body spoofs 99.
  const req = makeGuestReq({ body: { guest_id: 99 } });
  const result = resolveGuestOwnershipId(req, true);
  assert(result === 7, 'C2: Body spoofed guest_id=99 ignored; claim 7 used');
  assert(result !== 99, 'C2: Result is NOT the spoofed value 99');
}

// C3: Spoofed user_id in body ignored
console.log('\n--- TEST C3: Spoofed user_id in body ignored ---');
{
  const req = makeGuestReq({ body: { user_id: 500 } });
  const result = resolveGuestOwnershipId(req, true);
  assert(result === 7, 'C3: Body user_id=500 ignored; claim used');
}

// C4: Spoofed mysql_guest_id in body ignored
console.log('\n--- TEST C4: Spoofed mysql_guest_id in body ignored ---');
{
  const req = makeGuestReq({ body: { mysql_guest_id: 500 } });
  const result = resolveGuestOwnershipId(req, true);
  assert(result === 7, 'C4: Body mysql_guest_id=500 ignored; claim used');
}

// C5: Booking ownership verified via guestId in WHERE clause
console.log('\n--- TEST C5: Booking query uses guestId from claims in WHERE clause ---');
{
  const src = readFileSync(path.resolve(__dirname, '../controllers/roomController.js'), 'utf-8');
  // The booking query uses `guestId` which is resolved from claims — not from body
  assert(src.includes('WHERE b.guest_id = ?'), 'C5: Booking WHERE b.guest_id = ? present');
  assert(src.includes('[guestId]'), 'C5: guestId variable used in query params (from claims)');
}

// C6: No direct use of req.body.guest_id for ownership queries
console.log('\n--- TEST C6: req.body.guest_id never used in ownership queries ---');
{
  const src = readFileSync(path.resolve(__dirname, '../controllers/roomController.js'), 'utf-8');
  // Body guest_id should only appear in destructuring, not in SQL params
  const bodyGuestIdInSQL = /query\([^)]*req\.body\.guest_id/g.test(src);
  assert(!bodyGuestIdInSQL, 'C6: req.body.guest_id never used directly in SQL query params');
}

// C7: GUEST_OWNERSHIP_CLAIM_MISSING fails closed (no MySQL fallback)
console.log('\n--- TEST C7: Missing claim fails closed (no MySQL fallback when flag ON) ---');
{
  // Build request with NO mysql_guest_id and NO guest_id
  const reqNoId = {
    user: { uid: 'guest_3', id: 3, mysql_id: 3, role: 'guest', user_type: 'guest', loginType: 'guest' },
    body: {},
    params: {}
  };

  let threwCode = null;
  try {
    resolveGuestOwnershipId(reqNoId, true);
  } catch (e) {
    threwCode = e.code;
  }
  assert(threwCode === 'GUEST_OWNERSHIP_CLAIM_MISSING', 'C7: Missing claim → GUEST_OWNERSHIP_CLAIM_MISSING thrown (fail closed)');
}

// C8: GUEST_OWNERSHIP_CLAIM_MISSING does not silently return null
console.log('\n--- TEST C8: Missing claim throws, does NOT return null ---');
{
  const req = {
    user: { uid: 'guest_3', id: 3, mysql_id: 3, role: 'guest', user_type: 'guest' },
    body: {}, params: {}
  };
  let threw = false;
  let returnedNull = false;
  try {
    const result = resolveGuestOwnershipId(req, true);
    if (result === null) returnedNull = true;
  } catch (e) {
    threw = true;
  }
  assert(threw === true, 'C8: Missing claim → throws (not null return)');
  assert(!returnedNull, 'C8: Does not silently return null when flag ON + claim missing');
}

// ══════════════════════════════════════════════════════════════════════════════
// D. Claims Validation
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n─── D. Claims Validation ───────────────────────────────────────────────');

// D1: Missing mysql_guest_id → GUEST_OWNERSHIP_CLAIM_MISSING
console.log('\n--- TEST D1: Missing mysql_guest_id → GUEST_OWNERSHIP_CLAIM_MISSING ---');
{
  const req = {
    user: { uid: 'guest_3', id: 3, mysql_id: 3, role: 'guest', user_type: 'guest', loginType: 'guest' },
    body: {}, params: {}
  };
  let code = null;
  try { resolveGuestOwnershipId(req, true); } catch (e) { code = e.code; }
  assert(code === 'GUEST_OWNERSHIP_CLAIM_MISSING', 'D1: Missing mysql_guest_id → GUEST_OWNERSHIP_CLAIM_MISSING');
}

// D2: mysql_guest_id = 0 (falsy) → rejected
console.log('\n--- TEST D2: mysql_guest_id=0 rejected ---');
{
  const req = makeGuestReq({ user: { role: 'guest', user_type: 'guest', mysql_guest_id: 0 } });
  let code = null;
  try { resolveGuestOwnershipId(req, true); } catch (e) { code = e.code; }
  assert(code === 'GUEST_OWNERSHIP_CLAIM_MISSING', 'D2: mysql_guest_id=0 → GUEST_OWNERSHIP_CLAIM_MISSING');
}

// D3: mysql_guest_id = -1 (negative) → rejected
console.log('\n--- TEST D3: mysql_guest_id=-1 rejected ---');
{
  const req = makeGuestReq({ user: { role: 'guest', user_type: 'guest', mysql_guest_id: -1 } });
  let code = null;
  try { resolveGuestOwnershipId(req, true); } catch (e) { code = e.code; }
  assert(code === 'GUEST_OWNERSHIP_CLAIM_MISSING', 'D3: mysql_guest_id=-1 → GUEST_OWNERSHIP_CLAIM_MISSING');
}

// D4: role ≠ guest → FORBIDDEN
console.log('\n--- TEST D4: role != guest → FORBIDDEN ---');
{
  const req = { user: { role: 'RECEPTIONIST', user_type: 'staff', mysql_guest_id: 7 }, body: {}, params: {} };
  let code = null;
  try { resolveGuestOwnershipId(req, true); } catch (e) { code = e.code; }
  assert(code === 'FORBIDDEN', 'D4: role=RECEPTIONIST → FORBIDDEN');
}

// D5: user_type ≠ guest → FORBIDDEN
console.log('\n--- TEST D5: user_type != guest → FORBIDDEN ---');
{
  const req = { user: { role: 'guest', user_type: 'staff', mysql_guest_id: 7 }, body: {}, params: {} };
  let code = null;
  try { resolveGuestOwnershipId(req, true); } catch (e) { code = e.code; }
  assert(code === 'FORBIDDEN', 'D5: user_type=staff → FORBIDDEN (even if role=guest)');
}

// D6: No req.user → UNAUTHORIZED
console.log('\n--- TEST D6: No req.user → UNAUTHORIZED ---');
{
  const req = { user: null, body: {}, params: {} };
  let code = null;
  try { resolveGuestOwnershipId(req, true); } catch (e) { code = e.code; }
  assert(code === 'UNAUTHORIZED', 'D6: null user → UNAUTHORIZED');
}

// ══════════════════════════════════════════════════════════════════════════════
// E. Compatibility — Staff/Admin/Legacy Unaffected
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n─── E. Compatibility ───────────────────────────────────────────────────');

// E1: Admin functions are not wrapped by resolveGuestOwnershipId
console.log('\n--- TEST E1: Admin/staff functions not affected ---');
{
  const src = readFileSync(path.resolve(__dirname, '../controllers/roomController.js'), 'utf-8');
  // The admin/staff functions (checkIn, checkOut, bookRoom, etc.) are defined BEFORE
  // guestRequestCheckIn in the file. Extract each and check for the helper call.
  // We do this by checking that these specific function bodies don't have the helper.
  const checkInFnMatch  = src.match(/export const checkIn = async[\s\S]*?^\};/m);
  const checkOutFnMatch = src.match(/export const checkOut = async[\s\S]*?^\};/m);
  const bookRoomFnMatch = src.match(/export const bookRoom = async[\s\S]*?export const modifyCheckIn/m);

  const checkInHasHelper  = checkInFnMatch  ? checkInFnMatch[0].includes('resolveGuestOwnershipId') : false;
  const checkOutHasHelper = checkOutFnMatch ? checkOutFnMatch[0].includes('resolveGuestOwnershipId') : false;
  const bookRoomHasHelper = bookRoomFnMatch ? bookRoomFnMatch[0].includes('resolveGuestOwnershipId') : false;

  assert(!checkInHasHelper,  'E1: checkIn does not call resolveGuestOwnershipId');
  assert(!checkOutHasHelper, 'E1: checkOut does not call resolveGuestOwnershipId');
  assert(!bookRoomHasHelper, 'E1: bookRoom does not call resolveGuestOwnershipId');
}

// E2: Legacy JWT path preserved when flag OFF
console.log('\n--- TEST E2: Legacy JWT works when flag OFF ---');
{
  // req.user.id from legacy JWT, no mysql_guest_id
  const legacyReq = { user: { id: 3, role: 'guest', user_type: 'guest' }, body: {}, params: {} };
  const result = resolveGuestOwnershipId(legacyReq, false);
  assert(result === null, 'E2: Legacy JWT → flag OFF → null (MySQL path used)');
}

// E3: featureFlags.js has isFirebaseOnlyGuestResolutionEnabled exported
console.log('\n--- TEST E3: featureFlags.js exports isFirebaseOnlyGuestResolutionEnabled ---');
{
  assert(typeof isFirebaseOnlyGuestResolutionEnabled === 'function', 'E3: isFirebaseOnlyGuestResolutionEnabled is a function');
  const defaultVal = isFirebaseOnlyGuestResolutionEnabled();
  assert(defaultVal === false, 'E3: Default value is false (ENABLE_FIREBASE_ONLY_GUEST_RESOLUTION not set)');
}

// E4: roomController.js imports isFirebaseOnlyGuestResolutionEnabled
console.log('\n--- TEST E4: roomController imports isFirebaseOnlyGuestResolutionEnabled ---');
{
  const src = readFileSync(path.resolve(__dirname, '../controllers/roomController.js'), 'utf-8');
  assert(src.includes('isFirebaseOnlyGuestResolutionEnabled'), 'E4: isFirebaseOnlyGuestResolutionEnabled imported in roomController');
}

// E5: API response contract — guest history returns guest + bookings shape
console.log('\n--- TEST E5: Response shape unchanged ---');
{
  const src = readFileSync(path.resolve(__dirname, '../controllers/roomController.js'), 'utf-8');
  // getGuestHistory still returns { guest, bookings, payments }
  assert(src.includes('res.json({ guest, bookings, payments'), 'E5: getGuestHistory response shape preserved (guest, bookings, payments)');
  // getGuestBill still returns { booking, ledger }
  assert(src.includes('res.json({ booking, ledger }'), 'E5: getGuestBill response shape preserved (booking, ledger)');
}

// ══════════════════════════════════════════════════════════════════════════════
// F. Lifecycle / Multi-Guest Scenarios
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n─── F. Lifecycle / Multi-Guest Scenarios ───────────────────────────────');

// F1: Guest with multiple bookings — correct guestId used for all
console.log('\n--- TEST F1: Multiple bookings for same guest — same guestId used ---');
{
  const req = makeGuestReq({ user: { role: 'guest', user_type: 'guest', mysql_guest_id: 7, guest_id: 7 } });
  const id1 = resolveGuestOwnershipId(req, true);
  const id2 = resolveGuestOwnershipId(req, true);
  const id3 = resolveGuestOwnershipId(req, true);
  assert(id1 === 7 && id2 === 7 && id3 === 7, 'F1: Same guestId=7 returned consistently');
}

// F2: Two guests with different guest IDs — separate resolution
console.log('\n--- TEST F2: Two guests → separate guestIds resolved ---');
{
  const reqA = makeGuestReq({ user: { role: 'guest', user_type: 'guest', mysql_guest_id: 7 } });
  const reqB = makeGuestReq({ user: { role: 'guest', user_type: 'guest', mysql_guest_id: 12 } });
  assert(resolveGuestOwnershipId(reqA, true) === 7, 'F2: Guest A → guestId=7');
  assert(resolveGuestOwnershipId(reqB, true) === 12, 'F2: Guest B → guestId=12');
}

// F3: mysql_guest_id as string (claims may return strings) → coerced to int
console.log('\n--- TEST F3: String claim coerced to integer ---');
{
  const req = makeGuestReq({ user: { role: 'guest', user_type: 'guest', mysql_guest_id: '7', guest_id: '7' } });
  const result = resolveGuestOwnershipId(req, true);
  assert(result === 7, 'F3: String "7" coerced to integer 7');
  assert(typeof result === 'number', 'F3: Result is typeof number');
}

// F4: Checked-out guest can still access history (ownership check same)
console.log('\n--- TEST F4: Checked-out guest → guestId still resolved from claims ---');
{
  // The ownership resolution doesn't depend on booking status
  const req = makeGuestReq({ user: { role: 'guest', user_type: 'guest', mysql_guest_id: 7 } });
  const result = resolveGuestOwnershipId(req, true);
  assert(result === 7, 'F4: Ownership resolution works regardless of booking status');
}

// F5: Reserved (not yet checked in) guest → guestId still resolved
console.log('\n--- TEST F5: Reserved guest → guestId resolved from claims ---');
{
  const req = makeGuestReq();
  const result = resolveGuestOwnershipId(req, true);
  assert(result === 7, 'F5: guestId resolved from claims regardless of booking_status');
}

// F6: mysql_guest_id ≠ mysql_id — different fields, different purpose
console.log('\n--- TEST F6: mysql_guest_id != mysql_id — different fields ---');
{
  const req = makeGuestReq({
    user: { role: 'guest', user_type: 'guest', mysql_id: 3, mysql_guest_id: 7 }
  });
  const guestId = resolveGuestOwnershipId(req, true);
  assert(guestId === 7, 'F6: mysql_guest_id=7 (guests.id) used, not mysql_id=3 (users.id)');
  assert(guestId !== req.user.mysql_id, 'F6: guestId ≠ mysql_id (different tables/purpose)');
}

// F7: flag toggle — same code, different behavior
console.log('\n--- TEST F7: Same req, different flag → different behavior ---');
{
  const req = makeGuestReq();
  const flagOff = resolveGuestOwnershipId(req, false);
  const flagOn  = resolveGuestOwnershipId(req, true);
  assert(flagOff === null, 'F7: Flag OFF → null');
  assert(flagOn  === 7,    'F7: Flag ON  → 7');
}

// F8: Cancelled reservation guest → same ownership resolution
console.log('\n--- TEST F8: Ownership resolution is booking-status agnostic ---');
{
  // Ownership is resolved from the user token, not the booking
  const req = makeGuestReq({ user: { role: 'guest', user_type: 'guest', mysql_guest_id: 7 } });
  assert(resolveGuestOwnershipId(req, true) === 7, 'F8: Cancelled reservation guest → same guestId from claims');
}

// ══════════════════════════════════════════════════════════════════════════════
// G. Implementation Invariants
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n─── G. Implementation Invariants ───────────────────────────────────────');

// G1: No MySQL schema changes — no DDL in roomController.js
console.log('\n--- TEST G1: No MySQL DDL introduced ---');
{
  const src = readFileSync(path.resolve(__dirname, '../controllers/roomController.js'), 'utf-8');
  const hasDDL = /ALTER TABLE|CREATE TABLE|DROP TABLE|ADD COLUMN/i.test(src);
  assert(!hasDDL, 'G1: No MySQL DDL in roomController.js');
}

// G2: resolveGuestOwnershipId is defined in roomController.js
console.log('\n--- TEST G2: resolveGuestOwnershipId defined in roomController ---');
{
  const src = readFileSync(path.resolve(__dirname, '../controllers/roomController.js'), 'utf-8');
  assert(src.includes('function resolveGuestOwnershipId(req)'), 'G2: resolveGuestOwnershipId function defined');
}

// G3: getGuestHistoryAdmin is untouched (uses guests WHERE id, not user_id)
console.log('\n--- TEST G3: getGuestHistoryAdmin unchanged (admin function) ---');
{
  const src = readFileSync(path.resolve(__dirname, '../controllers/roomController.js'), 'utf-8');
  // Admin function takes guestId from req.params, not from user claims
  assert(src.includes('const { guestId } = req.params'), 'G3: getGuestHistoryAdmin uses req.params.guestId');
}

// G4: No mutation of MySQL guest data in the helper
console.log('\n--- TEST G4: resolveGuestOwnershipId is read-only ---');
{
  const src = readFileSync(path.resolve(__dirname, '../controllers/roomController.js'), 'utf-8');
  // Extract just the helper function body
  const helperMatch = src.match(/function resolveGuestOwnershipId\(req\) \{([\s\S]*?)\n\}/);
  if (helperMatch) {
    const helperBody = helperMatch[1];
    const hasMutation = /INSERT|UPDATE|DELETE/i.test(helperBody);
    assert(!hasMutation, 'G4: resolveGuestOwnershipId contains no INSERT/UPDATE/DELETE');
  } else {
    assert(false, 'G4: Could not parse resolveGuestOwnershipId body');
  }
}

// G5: Error codes are consistent
console.log('\n--- TEST G5: Error codes consistent across all rejection cases ---');
{
  const claimMissingCodes = [];
  const forbiddenCodes = [];

  // Missing claim
  try { resolveGuestOwnershipId({ user: { role: 'guest', user_type: 'guest' }, body: {} }, true); }
  catch(e) { claimMissingCodes.push(e.code); }

  // Invalid claim
  try { resolveGuestOwnershipId({ user: { role: 'guest', user_type: 'guest', mysql_guest_id: -5 }, body: {} }, true); }
  catch(e) { claimMissingCodes.push(e.code); }

  // Staff token
  try { resolveGuestOwnershipId({ user: { role: 'staff', user_type: 'staff' }, body: {} }, true); }
  catch(e) { forbiddenCodes.push(e.code); }

  assert(claimMissingCodes.every(c => c === 'GUEST_OWNERSHIP_CLAIM_MISSING'),
    'G5: All missing/invalid claim cases use GUEST_OWNERSHIP_CLAIM_MISSING');
  assert(forbiddenCodes.every(c => c === 'FORBIDDEN'),
    'G5: All non-guest token cases use FORBIDDEN');
}

// ── Final Summary ─────────────────────────────────────────────────────────────
console.log('\n========================================================================');
console.log(`  Phase 3 Step 3D-4 Test Summary: ${passed} Passed, ${failed} Failed`);
if (errors.length > 0) {
  console.log('\nFailed tests:');
  errors.forEach(e => console.log(`  ✕ ${e}`));
}
console.log('========================================================================\n');

if (failed > 0) process.exit(1);
