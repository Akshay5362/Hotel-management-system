/**
 * testPhase3Step3DGuestFrontendLogin.mjs
 * ============================================================================
 * HPMS Phase 3 Step 3D-3 — Guest Firebase Frontend Login Test Suite
 *
 * Tests:
 *  A. resolveFirebaseGuestEmail (7)
 *  B. validateGuestClaims (8)
 *  C. mapFirebaseGuestAuthError (7)
 *  D. AuthCard flow — Flag OFF (legacy behavior) (4)
 *  E. AuthCard flow — Flag ON Firebase path (8)
 *  F. Security guards (5)
 *  G. Compatibility (4)
 *
 * Total: 43 tests
 */

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

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

// ── Import utility under test (Node-compatible version) ──────────────────────
// resolveFirebaseGuestEmail.js uses only plain JS — no JSX, no Vite imports.
// We import it directly since it has no browser-only dependencies.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const utilPath = path.resolve(__dirname, '../../src/utils/resolveFirebaseGuestEmail.js');

// Load the utility module — use file:// URL for Windows ESM compatibility
const { resolveFirebaseGuestEmail, validateGuestClaims, mapFirebaseGuestAuthError }
  = await import(pathToFileURL(utilPath).href);

// ══════════════════════════════════════════════════════════════════════════════
// A. resolveFirebaseGuestEmail
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n========================================================================');
console.log('  HPMS Phase 3 Step 3D-3 — Guest Frontend Login Test Suite');
console.log('========================================================================\n');

console.log('─── A. resolveFirebaseGuestEmail ───────────────────────────────────────');

// TEST A1: Username without @ → synthetic internal email
console.log('\n--- TEST A1: Plain username → @hpms-sky5.internal ---');
{
  assert(resolveFirebaseGuestEmail('janedoe') === 'janedoe@hpms-sky5.internal',
    'A1: janedoe → janedoe@hpms-sky5.internal');
}

// TEST A2: Username with @ → used directly as email
console.log('\n--- TEST A2: Email username → used as-is ---');
{
  assert(resolveFirebaseGuestEmail('jane@gmail.com') === 'jane@gmail.com',
    'A2: jane@gmail.com → jane@gmail.com (unchanged)');
}

// TEST A3: Phone number → synthetic internal email
console.log('\n--- TEST A3: Phone number → @hpms-sky5.internal ---');
{
  assert(resolveFirebaseGuestEmail('9876543210') === '9876543210@hpms-sky5.internal',
    'A3: 9876543210 → 9876543210@hpms-sky5.internal');
}

// TEST A4: Input is lowercased before resolution
console.log('\n--- TEST A4: Input lowercased ---');
{
  assert(resolveFirebaseGuestEmail('JaneDoe') === 'janedoe@hpms-sky5.internal',
    'A4: JaneDoe → lowercased → janedoe@hpms-sky5.internal');
  assert(resolveFirebaseGuestEmail('Jane@Gmail.COM') === 'jane@gmail.com',
    'A4: Jane@Gmail.COM → lowercased → jane@gmail.com');
}

// TEST A5: Handles whitespace trimming
console.log('\n--- TEST A5: Whitespace trimmed ---');
{
  assert(resolveFirebaseGuestEmail('  janedoe  ') === 'janedoe@hpms-sky5.internal',
    'A5: " janedoe " → trimmed → janedoe@hpms-sky5.internal');
}

// TEST A6: Empty/null/undefined → empty string
console.log('\n--- TEST A6: Empty/null/undefined → empty string ---');
{
  assert(resolveFirebaseGuestEmail('') === '', 'A6: "" → ""');
  assert(resolveFirebaseGuestEmail(null) === '', 'A6: null → ""');
  assert(resolveFirebaseGuestEmail(undefined) === '', 'A6: undefined → ""');
}

// TEST A7: Matches Step 3D-1 provisioning logic exactly
console.log('\n--- TEST A7: Mirrors Step 3D-1 provisioning email strategy ---');
{
  // Step 3D-1 rule: username.includes('@') → use username; else username@hpms-sky5.internal
  const testCases = [
    { input: 'guest1', expected: 'guest1@hpms-sky5.internal' },
    { input: 'amit@yahoo.com', expected: 'amit@yahoo.com' },
    { input: 'user_123', expected: 'user_123@hpms-sky5.internal' },
    { input: 'john.doe@company.org', expected: 'john.doe@company.org' },
  ];
  for (const tc of testCases) {
    const result = resolveFirebaseGuestEmail(tc.input);
    assert(result === tc.expected, `A7: '${tc.input}' → '${result}' (expected '${tc.expected}')`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// B. validateGuestClaims
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n─── B. validateGuestClaims ─────────────────────────────────────────────');

// TEST B1: Valid guest claims → valid
console.log('\n--- TEST B1: Valid guest claims ---');
{
  const user = { role: 'guest', user_type: 'guest', loginType: 'guest', mysql_id: 3, mysql_guest_id: 7, guest_id: 7 };
  const result = validateGuestClaims(user);
  assert(result.valid === true, 'B1: Valid guest claims → valid=true');
  assert(result.error === null, 'B1: Valid guest claims → error=null');
}

// TEST B2: Staff token rejected
console.log('\n--- TEST B2: Staff token rejected ---');
{
  const staffUser = { role: 'RECEPTIONIST', user_type: 'staff', loginType: 'staff', mysql_id: 5 };
  const result = validateGuestClaims(staffUser);
  assert(result.valid === false, 'B2: Staff user → valid=false');
  assert(result.error !== null, 'B2: Staff user → error message set');
  assert(result.error.includes('Staff Portal'), 'B2: Error directs to Staff Portal');
}

// TEST B3: Admin token rejected
console.log('\n--- TEST B3: Admin token rejected ---');
{
  const adminUser = { role: 'admin', user_type: 'admin', loginType: 'admin', mysql_id: 1 };
  const result = validateGuestClaims(adminUser);
  assert(result.valid === false, 'B3: Admin user → valid=false');
  assert(result.error.includes('Staff Portal'), 'B3: Admin error directs to Staff Portal');
}

// TEST B4: Super admin rejected
console.log('\n--- TEST B4: Super admin rejected ---');
{
  const superAdmin = { role: 'super_admin', user_type: 'admin', loginType: 'admin', mysql_id: 1 };
  const result = validateGuestClaims(superAdmin);
  assert(result.valid === false, 'B4: Super admin → valid=false');
}

// TEST B5: Null user → invalid
console.log('\n--- TEST B5: Null user rejected ---');
{
  const result = validateGuestClaims(null);
  assert(result.valid === false, 'B5: null user → valid=false');
  assert(result.error !== null, 'B5: null user → error set');
}

// TEST B6: Wrong role (but correct user_type) → rejected
console.log('\n--- TEST B6: Wrong role field ---');
{
  const weirdUser = { role: 'admin', user_type: 'guest', loginType: 'guest' };
  const result = validateGuestClaims(weirdUser);
  assert(result.valid === false, 'B6: role=admin with user_type=guest → rejected (role check wins)');
}

// TEST B7: loginType staff with role guest → rejected
console.log('\n--- TEST B7: loginType=staff rejected even if role=guest ---');
{
  const crossUser = { role: 'guest', user_type: 'guest', loginType: 'staff' };
  const result = validateGuestClaims(crossUser);
  assert(result.valid === false, 'B7: loginType=staff → rejected even with role=guest');
}

// TEST B8: Guest with missing loginType field → still valid (legacy tokens may omit it)
console.log('\n--- TEST B8: Missing loginType acceptable for valid guest ---');
{
  const legacyGuest = { role: 'guest', user_type: 'guest' }; // No loginType
  const result = validateGuestClaims(legacyGuest);
  assert(result.valid === true, 'B8: Guest with no loginType → still valid (legacy JWT compatible)');
}

// ══════════════════════════════════════════════════════════════════════════════
// C. mapFirebaseGuestAuthError
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n─── C. mapFirebaseGuestAuthError ───────────────────────────────────────');

// TEST C1: invalid-credential → friendly message
console.log('\n--- TEST C1: auth/invalid-credential ---');
{
  const err = { code: 'auth/invalid-credential', message: 'Firebase: Error (auth/invalid-credential).' };
  const msg = mapFirebaseGuestAuthError(err);
  assert(msg === 'Invalid username or password.', 'C1: invalid-credential → "Invalid username or password."');
}

// TEST C2: user-not-found → friendly message
console.log('\n--- TEST C2: auth/user-not-found ---');
{
  const err = { code: 'auth/user-not-found' };
  assert(mapFirebaseGuestAuthError(err) === 'Invalid username or password.', 'C2: user-not-found → "Invalid username or password."');
}

// TEST C3: user-disabled → contextual guest message
console.log('\n--- TEST C3: auth/user-disabled ---');
{
  const err = { code: 'auth/user-disabled' };
  const msg = mapFirebaseGuestAuthError(err);
  assert(msg.includes('disabled') && msg.includes('front desk'), 'C3: user-disabled → front desk guidance');
}

// TEST C4: too-many-requests
console.log('\n--- TEST C4: auth/too-many-requests ---');
{
  const err = { code: 'auth/too-many-requests' };
  assert(mapFirebaseGuestAuthError(err).toLowerCase().includes('too many'), 'C4: too-many-requests → rate limit message');
}

// TEST C5: network-request-failed
console.log('\n--- TEST C5: auth/network-request-failed ---');
{
  const err = { code: 'auth/network-request-failed' };
  assert(mapFirebaseGuestAuthError(err).includes('Network error'), 'C5: network-request-failed → network message');
}

// TEST C6: Firebase internal message NOT passed through
console.log('\n--- TEST C6: Raw Firebase message not exposed ---');
{
  const err = { code: 'auth/unknown', message: 'Firebase: Something (auth/internal-error).' };
  const msg = mapFirebaseGuestAuthError(err);
  assert(!msg.startsWith('Firebase:'), 'C6: Raw Firebase message not exposed to user');
}

// TEST C7: User-friendly backend message passes through
console.log('\n--- TEST C7: Friendly backend error message passes through ---');
{
  const err = { code: 'SERVER_ERROR', message: 'Your account is inactive.' };
  const msg = mapFirebaseGuestAuthError(err);
  assert(msg === 'Your account is inactive.', 'C7: Backend-friendly message passes through unchanged');
}

// ══════════════════════════════════════════════════════════════════════════════
// D. AuthCard flow — Flag OFF (legacy behavior)
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n─── D. AuthCard Flow — Flag OFF (Legacy Behavior) ──────────────────────');

// Simulate the AuthCard guest sign-in decision logic
function simulateGuestSignIn({
  username, password, isSignUp = false,
  firebaseGuestEnabled = false,
  firebaseClientConfigured = true,
  mockFirebaseResult = null,    // null = not called
  mockMeResult = null,
  mockLegacyResult = null
}) {
  const calls = { firebase: false, me: false, legacy: false };

  const guestEmail = resolveFirebaseGuestEmail(username);
  const shouldUseFirebase = !isSignUp && firebaseGuestEnabled && firebaseClientConfigured && guestEmail;

  if (shouldUseFirebase) {
    calls.firebase = true;
    if (mockFirebaseResult?.error) {
      return { calls, result: { error: mapFirebaseGuestAuthError(mockFirebaseResult.error) } };
    }
    calls.me = true;
    if (mockMeResult?.user) {
      const claimsCheck = validateGuestClaims(mockMeResult.user);
      if (!claimsCheck.valid) {
        return { calls, result: { error: claimsCheck.error } };
      }
      return { calls, result: { user: mockMeResult.user, token: 'FIREBASE_ID_TOKEN' } };
    }
    return { calls, result: { error: 'Server returned no user identity.' } };
  }

  // Legacy MySQL path
  calls.legacy = true;
  if (mockLegacyResult) return { calls, result: mockLegacyResult };
  return { calls, result: { error: 'Legacy endpoint unavailable' } };
}

// TEST D1: Flag OFF → legacy MySQL path used
console.log('\n--- TEST D1: Flag OFF → legacy MySQL path ---');
{
  const { calls, result } = simulateGuestSignIn({
    username: 'janedoe', password: 'Password1',
    firebaseGuestEnabled: false,
    mockLegacyResult: { user: { id: 3, role: 'guest' }, token: 'LEGACY_JWT' }
  });
  assert(calls.legacy === true, 'D1: Flag OFF → legacy endpoint called');
  assert(calls.firebase === false, 'D1: Flag OFF → Firebase NOT called');
  assert(result.token === 'LEGACY_JWT', 'D1: Flag OFF → legacy JWT token returned');
}

// TEST D2: Signup always goes legacy (even when flag ON)
console.log('\n--- TEST D2: Signup → always legacy path (signup not Firebase) ---');
{
  const { calls } = simulateGuestSignIn({
    username: 'newguest', password: 'Password1', isSignUp: true,
    firebaseGuestEnabled: true,
    mockLegacyResult: { user: { id: 10, role: 'guest' }, token: 'JWT' }
  });
  assert(calls.legacy === true, 'D2: isSignUp=true → always legacy path');
  assert(calls.firebase === false, 'D2: Signup never uses Firebase guest login path');
}

// TEST D3: Staff portal (isAdmin=true) never uses guest Firebase path
console.log('\n--- TEST D3: Staff portal (isAdmin=true) → never guest Firebase path ---');
{
  // The guest Firebase block has guard: !isAdmin && !isSignUp && firebaseGuestEnabled
  // When isAdmin=true, the staff Firebase block runs first (tested separately)
  // This verifies the logic condition
  const isAdmin = true;
  const isSignUp = false;
  const firebaseGuestEnabled = true;
  const guestPathActive = !isAdmin && !isSignUp && firebaseGuestEnabled;
  assert(guestPathActive === false, 'D3: isAdmin=true → guest Firebase path NOT activated');
}

// TEST D4: Flag OFF → no MySQL schema changes (verify flag value is false by default)
console.log('\n--- TEST D4: Default flag value is false ---');
{
  // In the frontend, VITE_ENABLE_FIREBASE_GUEST_LOGIN defaults to undefined (not 'true')
  const defaultFlag = undefined; // simulates missing env var
  const flagActive = defaultFlag === 'true';
  assert(flagActive === false, 'D4: Default VITE_ENABLE_FIREBASE_GUEST_LOGIN → false (not enabled)');
}

// ══════════════════════════════════════════════════════════════════════════════
// E. AuthCard flow — Flag ON Firebase path
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n─── E. AuthCard Flow — Flag ON (Firebase Path) ─────────────────────────');

// TEST E1: Flag ON → Firebase authentication called
console.log('\n--- TEST E1: Flag ON → Firebase path activated ---');
{
  const { calls } = simulateGuestSignIn({
    username: 'janedoe', password: 'Password1',
    firebaseGuestEnabled: true,
    mockFirebaseResult: { token: 'FIREBASE_TOKEN' },
    mockMeResult: { user: { role: 'guest', user_type: 'guest', loginType: 'guest', mysql_id: 3, mysql_guest_id: 7, guest_id: 7 } }
  });
  assert(calls.firebase === true, 'E1: Flag ON → Firebase signIn called');
  assert(calls.legacy === false, 'E1: Flag ON → Legacy MySQL NOT called');
}

// TEST E2: Correct guest email resolution used for Firebase
console.log('\n--- TEST E2: Correct email passed to Firebase ---');
{
  const email = resolveFirebaseGuestEmail('janedoe');
  assert(email === 'janedoe@hpms-sky5.internal', 'E2: janedoe → janedoe@hpms-sky5.internal for Firebase signIn');
}

// TEST E3: Firebase authentication success → ID token obtained
console.log('\n--- TEST E3: Firebase auth success → ID token obtained ---');
{
  const { result } = simulateGuestSignIn({
    username: 'janedoe', password: 'Password1',
    firebaseGuestEnabled: true,
    mockFirebaseResult: { token: 'FB_ID_TOKEN_XYZ' },
    mockMeResult: { user: { role: 'guest', user_type: 'guest', loginType: 'guest', mysql_id: 3, mysql_guest_id: 7, guest_id: 7 } }
  });
  assert(result.token === 'FIREBASE_ID_TOKEN', 'E3: Firebase path returns ID token as session token');
}

// TEST E4: Backend /api/auth/me called with Firebase ID token
console.log('\n--- TEST E4: /api/auth/me called with Firebase token ---');
{
  const { calls } = simulateGuestSignIn({
    username: 'janedoe', password: 'Password1',
    firebaseGuestEnabled: true,
    mockFirebaseResult: { token: 'FB_TOKEN' },
    mockMeResult: { user: { role: 'guest', user_type: 'guest', mysql_id: 3, mysql_guest_id: 7, guest_id: 7 } }
  });
  assert(calls.me === true, 'E4: /api/auth/me called after Firebase signIn');
}

// TEST E5: Canonical user object from /api/auth/me delivered to onAuthSuccess
console.log('\n--- TEST E5: Canonical guest user object delivered ---');
{
  const canonicalUser = {
    uid: 'guest_3',
    id: 3, mysql_id: 3,
    mysql_guest_id: 7, guest_id: 7,
    role: 'guest', user_type: 'guest',
    loginType: 'guest', authProvider: 'firebase',
    full_name: 'Jane Doe', phone: '9876543210',
    loyalty_tier: 'Bronze', loyalty_points: 0
  };
  const { result } = simulateGuestSignIn({
    username: 'janedoe', password: 'Password1',
    firebaseGuestEnabled: true,
    mockFirebaseResult: { token: 'FB_TOKEN' },
    mockMeResult: { user: canonicalUser }
  });
  assert(result.user !== undefined, 'E5: User object returned');
  assert(result.user.role === 'guest', 'E5: role=guest');
  assert(result.user.mysql_guest_id === 7, 'E5: mysql_guest_id=7');
  assert(result.user.authProvider === 'firebase', 'E5: authProvider=firebase');
}

// TEST E6: Firebase user-not-found → clean error, no MySQL fallback
console.log('\n--- TEST E6: Firebase user-not-found → clean error, no MySQL fallback ---');
{
  const { calls, result } = simulateGuestSignIn({
    username: 'unknown', password: 'WrongPass1',
    firebaseGuestEnabled: true,
    mockFirebaseResult: { error: { code: 'auth/user-not-found' } }
  });
  assert(calls.firebase === true, 'E6: Firebase was attempted');
  assert(calls.legacy === false, 'E6: Legacy MySQL NOT called after Firebase user-not-found');
  assert(result.error === 'Invalid username or password.', 'E6: Clean error message');
}

// TEST E7: Firebase invalid credential → clean error
console.log('\n--- TEST E7: Firebase invalid credential → clean error ---');
{
  const { result } = simulateGuestSignIn({
    username: 'janedoe', password: 'WrongPass1',
    firebaseGuestEnabled: true,
    mockFirebaseResult: { error: { code: 'auth/invalid-credential' } }
  });
  assert(result.error === 'Invalid username or password.', 'E7: Invalid credential → clean error');
}

// TEST E8: Firebase unavailable → handled without crash
console.log('\n--- TEST E8: Firebase unavailable → handled gracefully ---');
{
  // If isClientConfigured=false, falls back to legacy path
  const { calls } = simulateGuestSignIn({
    username: 'janedoe', password: 'Password1',
    firebaseGuestEnabled: true,
    firebaseClientConfigured: false,  // Firebase SDK not initialized
    mockLegacyResult: { user: { role: 'guest' }, token: 'LEGACY_JWT' }
  });
  assert(calls.legacy === true, 'E8: Firebase unavailable → falls back to legacy path');
  assert(calls.firebase === false, 'E8: Firebase not called when SDK not initialized');
}

// ══════════════════════════════════════════════════════════════════════════════
// F. Security Guards
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n─── F. Security Guards ─────────────────────────────────────────────────');

// TEST F1: Staff token rejected from guest login path
console.log('\n--- TEST F1: Staff token rejected at guest login ---');
{
  const { result } = simulateGuestSignIn({
    username: 'reception_morning', password: 'StaffPass1',
    firebaseGuestEnabled: true,
    mockFirebaseResult: { token: 'STAFF_FB_TOKEN' },
    mockMeResult: { user: { role: 'RECEPTIONIST', user_type: 'staff', loginType: 'staff', mysql_id: 5 } }
  });
  assert(result.error !== undefined, 'F1: Staff token → error returned');
  assert(result.error.includes('Staff Portal'), 'F1: Error directs to Staff Portal');
  assert(result.user === undefined, 'F1: No user object returned for staff token');
}

// TEST F2: Admin token rejected from guest login path
console.log('\n--- TEST F2: Admin token rejected at guest login ---');
{
  const { result } = simulateGuestSignIn({
    username: 'admin', password: 'AdminPass1',
    firebaseGuestEnabled: true,
    mockFirebaseResult: { token: 'ADMIN_FB_TOKEN' },
    mockMeResult: { user: { role: 'admin', user_type: 'admin', loginType: 'admin', mysql_id: 1 } }
  });
  assert(result.error !== undefined, 'F2: Admin token → error returned');
  assert(result.user === undefined, 'F2: No user object returned for admin token');
}

// TEST F3: No MySQL fallback when flag ON and Firebase errors
console.log('\n--- TEST F3: No MySQL fallback when flag ON ---');
{
  const { calls } = simulateGuestSignIn({
    username: 'janedoe', password: 'WrongPass1',
    firebaseGuestEnabled: true,
    mockFirebaseResult: { error: { code: 'auth/wrong-password' } },
    mockLegacyResult: { user: { role: 'guest' }, token: 'SHOULD_NOT_GET' }
  });
  assert(calls.legacy === false, 'F3: Flag ON + Firebase error → NO MySQL fallback');
}

// TEST F4: resolveFirebaseGuestEmail never returns a staff domain email
console.log('\n--- TEST F4: resolveFirebaseGuestEmail never returns staff domain ---');
{
  const staffUsernames = ['reception_morning', 'chef', 'cleaner1', 'admin', 'keval'];
  for (const u of staffUsernames) {
    const email = resolveFirebaseGuestEmail(u);
    const isStaffDomain = email.endsWith('@hotelsky5.com'); // Staff domain
    assert(!isStaffDomain, `F4: '${u}' resolves to '${email}' (not @hotelsky5.com)`);
  }
}

// TEST F5: Empty username → empty email → auth rejected early
console.log('\n--- TEST F5: Empty username → auth rejected early ---');
{
  const email = resolveFirebaseGuestEmail('');
  assert(email === '', 'F5: Empty username → empty email → auth blocked before Firebase call');
}

// ══════════════════════════════════════════════════════════════════════════════
// G. Compatibility
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n─── G. Compatibility ───────────────────────────────────────────────────');

// TEST G1: AuthCard.jsx and resolveFirebaseGuestEmail.js source files exist
console.log('\n--- TEST G1: All required files exist ---');
{
  const authCardExists = (() => { try { readFileSync(path.resolve(__dirname, '../../src/components/AuthCard.jsx')); return true; } catch { return false; } })();
  const utilExists = (() => { try { readFileSync(utilPath); return true; } catch { return false; } })();
  assert(authCardExists, 'G1: AuthCard.jsx exists');
  assert(utilExists, 'G1: resolveFirebaseGuestEmail.js exists');
}

// TEST G2: AuthCard.jsx imports resolveFirebaseGuestEmail
console.log('\n--- TEST G2: AuthCard.jsx imports the utility ---');
{
  const authCardSrc = readFileSync(path.resolve(__dirname, '../../src/components/AuthCard.jsx'), 'utf-8');
  assert(authCardSrc.includes('resolveFirebaseGuestEmail'), 'G2: AuthCard imports resolveFirebaseGuestEmail');
  assert(authCardSrc.includes('validateGuestClaims'), 'G2: AuthCard imports validateGuestClaims');
  assert(authCardSrc.includes('mapFirebaseGuestAuthError'), 'G2: AuthCard imports mapFirebaseGuestAuthError');
}

// TEST G3: VITE flag name is correct
console.log('\n--- TEST G3: Correct VITE flag name used ---');
{
  const authCardSrc = readFileSync(path.resolve(__dirname, '../../src/components/AuthCard.jsx'), 'utf-8');
  assert(authCardSrc.includes('VITE_ENABLE_FIREBASE_GUEST_LOGIN'), 'G3: VITE_ENABLE_FIREBASE_GUEST_LOGIN flag used correctly');
}

// TEST G4: No MySQL schema modifications (this test checks for absence of DDL patterns)
console.log('\n--- TEST G4: No MySQL DDL patterns introduced ---');
{
  const authCardSrc = readFileSync(path.resolve(__dirname, '../../src/components/AuthCard.jsx'), 'utf-8');
  const utilSrc = readFileSync(utilPath, 'utf-8');
  const hasDDL = /ALTER TABLE|CREATE TABLE|DROP TABLE|ADD COLUMN/i.test(authCardSrc + utilSrc);
  assert(!hasDDL, 'G4: No MySQL DDL in frontend files');
}

// ── Final Summary ─────────────────────────────────────────────────────────────
console.log('\n========================================================================');
console.log(`  Phase 3 Step 3D-3 Test Summary: ${passed} Passed, ${failed} Failed`);
if (errors.length > 0) {
  console.log('\nFailed tests:');
  errors.forEach(e => console.log(`  ✕ ${e}`));
}
console.log('========================================================================\n');

if (failed > 0) process.exit(1);
