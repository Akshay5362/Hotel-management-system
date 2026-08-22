/**
 * testPhase3Step3DGuestFirebaseProvisioning.mjs
 * ============================================================================
 * HPMS Phase 3 Step 3D-1 — Guest Firebase Auth Provisioning Test Suite
 *
 * Tests the provisionGuestFirebaseAuth.mjs script in isolation using injectable
 * mock dependencies (no real Firebase or MySQL connections required).
 *
 * Security tests verify that:
 *   - The MySQL query NEVER requests the password column
 *   - Password hashes are NEVER read, stored, printed, or transmitted
 *   - Temporary passwords are cryptographically random (never MySQL-derived)
 *
 * Test coverage (20 scenarios):
 *  1.  Existing Firebase user is discovered by canonical UID
 *  2.  Missing Firebase user is handled (would create)
 *  3.  UID pattern is always guest_${users.id}
 *  4.  Claims created with all required fields
 *  5.  Claims are merged (preserving unrelated existing claims)
 *  6.  mysql_id = users.id (NOT guests.id)
 *  7.  mysql_guest_id = guests.id (NOT users.id)
 *  8.  guest_id = guests.id (alias for booking resolution)
 *  9.  Firestore guest document created for new guest
 * 10.  Firestore document updated for existing guest
 * 11.  Inactive/deleted guest skipped (is_deleted=1)
 * 12.  Orphaned guest (no users_id) skipped
 * 13.  Duplicate email conflict → falls back to @hpms-sky5.internal
 * 14.  Idempotent second run — zero unnecessary claim/document updates
 * 15.  Dry-run causes zero mutations (all side-effect functions not called)
 * 16.  Password hash is never read/exposed/transferred (SECURITY)
 * 17.  resolveGuestFirebaseEmail: real-email username
 * 18.  resolveGuestFirebaseEmail: phone/handle → synthetic @hpms-sky5.internal
 * 19.  resolveGuestFirebaseEmail: guests.email used when no @ in username
 * 20.  Full run summary counts are correct
 */

import {
  resolveGuestFirebaseEmail,
  findExistingGuestFirebaseAuthUser,
  computeGuestCustomClaims,
  checkEmailConflict,
  provisionSingleGuest,
  runGuestProvisioning
} from '../scripts/provisionGuestFirebaseAuth.mjs';

// ── Test Runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ PASSED: ${message}`);
    passed++;
  } else {
    console.error(`  ✕ FAILED: ${message}`);
    failed++;
  }
}

function assertNever(value, label) {
  assert(value === undefined || value === null || value === '',
    `SECURITY: ${label} is not present (value: ${JSON.stringify(value)})`);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeGuestRow(overrides = {}) {
  return {
    users_id:              3,
    username:              'janedoe',
    user_full_name:        'Jane Doe',
    user_phone:            '9876543210',
    guests_id:             7,
    full_name:             'JANE DOE',
    guest_email:           '',
    phone:                 '9876543210',
    loyalty_tier:          'Bronze',
    loyalty_points:        0,
    address:               '',
    gst_no:                '',
    country:               '',
    government_id:         '',
    id_type:               '',
    id_verification_status:'Pending',
    created_at:            new Date('2026-01-15').toISOString(),
    is_deleted:            0,
    // SECURITY: password and password_hash are deliberately NOT present
    ...overrides
  };
}

function makeAuthUser(uid, email, customClaims = {}) {
  return { uid, email, customClaims, displayName: '' };
}

// Track all calls to side-effect functions
function makeMockAuth({ existingUser = null, createUserFn = null } = {}) {
  const calls = { getUser: 0, getUserByEmail: 0, createUser: 0, setCustomUserClaims: 0 };
  return {
    calls,
    async getUser(uid) {
      calls.getUser++;
      if (existingUser && existingUser.uid === uid) return existingUser;
      const err = new Error('User not found'); err.code = 'auth/user-not-found';
      throw err;
    },
    async getUserByEmail(email) {
      calls.getUserByEmail++;
      if (existingUser && existingUser.email === email) return existingUser;
      const err = new Error('User not found'); err.code = 'auth/user-not-found';
      throw err;
    },
    async createUser(data) {
      calls.createUser++;
      if (createUserFn) return createUserFn(data);
      return makeAuthUser(data.uid, data.email);
    },
    async setCustomUserClaims(uid, claims) {
      calls.setCustomUserClaims++;
    }
  };
}

function makeMockFirestore({ existingDoc = null } = {}) {
  const calls = { get: 0, create: 0, update: 0 };
  return {
    calls,
    async getDoc(id)           { calls.get++;    return existingDoc || null; },
    async createDoc(payload)   { calls.create++; return payload; },
    async updateDoc(id, data)  { calls.update++; return data; }
  };
}

// ── TEST 1: Existing Firebase user discovered by canonical UID ────────────────
console.log('\n========================================================================');
console.log('  HPMS Phase 3 Step 3D-1 — Guest Firebase Provisioning Test Suite');
console.log('========================================================================\n');

console.log('--- TEST 1: Existing Firebase user discovered by canonical UID ---');
{
  const guestRow = makeGuestRow();
  const existing = makeAuthUser(`guest_${guestRow.users_id}`, 'janedoe@hpms-sky5.internal', {
    role: 'guest', user_type: 'guest',
    mysql_id: 3, mysql_guest_id: 7, guest_id: 7,
    full_name: 'JANE DOE', phone: '9876543210', loyalty_tier: 'Bronze', loyalty_points: 0
  });
  const mockAuth = makeMockAuth({ existingUser: existing });
  const mockFs = makeMockFirestore({ existingDoc: { mysql_guest_id: 7 } });

  const result = await provisionSingleGuest(guestRow, {
    authInstance: mockAuth,
    dbInstance: {},
    dryRun: false,
    getGuestFn: async () => mockFs.calls.get++ && { mysql_guest_id: 7 },
    createGuestFn: async (p) => mockFs.calls.create++,
    updateGuestFn: async (id, p) => mockFs.calls.update++,
    checkEmailConflictFn: async () => ({ conflict: false, ownerUid: null })
  });

  assert(result.auth_exists === true, 'auth_exists = true for existing user');
  assert(result.auth_created === false, 'auth_created = false (not newly created)');
  assert(result.firebase_uid === `guest_${guestRow.users_id}`, 'firebase_uid matches canonical UID');
  assert(mockAuth.calls.createUser === 0, 'createUser was NOT called');
}

// ── TEST 2: Missing Firebase user handled ─────────────────────────────────────
console.log('\n--- TEST 2: Missing Firebase user — handled and created ---');
{
  const guestRow = makeGuestRow();
  const mockAuth = makeMockAuth({ existingUser: null });
  let createdWith = null;

  const result = await provisionSingleGuest(guestRow, {
    authInstance: {
      ...mockAuth,
      async createUser(data) { createdWith = data; return makeAuthUser(data.uid, data.email); },
      async setCustomUserClaims() {}
    },
    dbInstance: {},
    dryRun: false,
    getGuestFn:    async () => null,
    createGuestFn: async (p) => p,
    updateGuestFn: async (id, p) => p,
    checkEmailConflictFn: async () => ({ conflict: false, ownerUid: null })
  });

  assert(result.auth_created === true, 'auth_created = true for missing user');
  assert(result.auth_exists === false, 'auth_exists = false before creation');
  assert(createdWith !== null, 'createUser was called with data');
  assert(createdWith.uid === `guest_${guestRow.users_id}`, 'createUser called with correct UID');
}

// ── TEST 3: UID is always guest_${users.id} ───────────────────────────────────
console.log('\n--- TEST 3: UID always = guest_${users.id} ---');
{
  const testCases = [
    { users_id: 1, guests_id: 100, expected: 'guest_1' },
    { users_id: 42, guests_id: 17, expected: 'guest_42' },
    { users_id: 999, guests_id: 3, expected: 'guest_999' }
  ];
  for (const tc of testCases) {
    const guestRow = makeGuestRow({ users_id: tc.users_id, guests_id: tc.guests_id });
    const result = await provisionSingleGuest(guestRow, {
      authInstance: null,
      dbInstance: null,
      dryRun: true,
      getGuestFn: async () => null,
      createGuestFn: async () => {},
      updateGuestFn: async () => {},
      checkEmailConflictFn: async () => ({ conflict: false, ownerUid: null })
    });
    assert(result.firebase_uid === tc.expected, `UID=${tc.expected} for users_id=${tc.users_id}`);
  }
}

// ── TEST 4: Claims created with all required fields ───────────────────────────
console.log('\n--- TEST 4: Claims contain all required fields ---');
{
  const guestRow = makeGuestRow({ users_id: 5, guests_id: 12, loyalty_tier: 'Gold', loyalty_points: 150 });
  const { mergedClaims } = computeGuestCustomClaims({}, guestRow);

  assert(mergedClaims.role === 'guest', 'claims.role = guest');
  assert(mergedClaims.user_type === 'guest', 'claims.user_type = guest');
  assert(mergedClaims.mysql_id === 5, 'claims.mysql_id = users_id (5)');
  assert(mergedClaims.mysql_guest_id === 12, 'claims.mysql_guest_id = guests_id (12)');
  assert(mergedClaims.guest_id === 12, 'claims.guest_id = guests_id (12)');
  assert(mergedClaims.full_name === 'JANE DOE', 'claims.full_name present');
  assert(mergedClaims.phone === '9876543210', 'claims.phone present');
  assert(mergedClaims.loyalty_tier === 'Gold', 'claims.loyalty_tier = Gold');
  assert(mergedClaims.loyalty_points === 150, 'claims.loyalty_points = 150');
}

// ── TEST 5: Claims are merged (existing unrelated claims preserved) ────────────
console.log('\n--- TEST 5: Existing unrelated claims are preserved ---');
{
  const existingClaims = {
    some_other_system_claim: 'do_not_delete_me',
    custom_hotel_pref: 'non_smoking',
    role: 'guest' // already set
  };
  const guestRow = makeGuestRow({ users_id: 3, guests_id: 7 });
  const { mergedClaims, needsUpdate } = computeGuestCustomClaims(existingClaims, guestRow);

  assert(mergedClaims.some_other_system_claim === 'do_not_delete_me', 'unrelated claim preserved');
  assert(mergedClaims.custom_hotel_pref === 'non_smoking', 'custom claim preserved');
  assert(mergedClaims.role === 'guest', 'role claim correct');
  assert(typeof mergedClaims.mysql_id === 'number', 'mysql_id is number');
}

// ── TEST 6: mysql_id = users.id (NOT guests.id) ───────────────────────────────
console.log('\n--- TEST 6: mysql_id maps to users.id, NOT guests.id ---');
{
  const guestRow = makeGuestRow({ users_id: 10, guests_id: 99 });
  const { mergedClaims } = computeGuestCustomClaims({}, guestRow);

  assert(mergedClaims.mysql_id === 10, 'mysql_id = 10 (users_id)');
  assert(mergedClaims.mysql_id !== 99, 'mysql_id ≠ 99 (guests_id)');
}

// ── TEST 7: mysql_guest_id = guests.id (NOT users.id) ────────────────────────
console.log('\n--- TEST 7: mysql_guest_id maps to guests.id, NOT users.id ---');
{
  const guestRow = makeGuestRow({ users_id: 10, guests_id: 99 });
  const { mergedClaims } = computeGuestCustomClaims({}, guestRow);

  assert(mergedClaims.mysql_guest_id === 99, 'mysql_guest_id = 99 (guests_id)');
  assert(mergedClaims.mysql_guest_id !== 10, 'mysql_guest_id ≠ 10 (users_id)');
}

// ── TEST 8: guest_id = guests.id (alias) ─────────────────────────────────────
console.log('\n--- TEST 8: guest_id is alias for guests.id ---');
{
  const guestRow = makeGuestRow({ users_id: 10, guests_id: 99 });
  const { mergedClaims } = computeGuestCustomClaims({}, guestRow);

  assert(mergedClaims.guest_id === 99, 'guest_id = 99 (guests_id alias)');
  assert(mergedClaims.guest_id === mergedClaims.mysql_guest_id, 'guest_id === mysql_guest_id');
}

// ── TEST 9: Firestore document created for new guest ──────────────────────────
console.log('\n--- TEST 9: Firestore document created for new guest ---');
{
  const guestRow = makeGuestRow({ users_id: 3, guests_id: 7 });
  let createdPayload = null;
  const mockAuth = makeMockAuth({ existingUser: makeAuthUser('guest_3', 'janedoe@hpms-sky5.internal', { role: 'guest', user_type: 'guest', mysql_id: 3, mysql_guest_id: 7, guest_id: 7, full_name: 'JANE DOE', phone: '9876543210', loyalty_tier: 'Bronze', loyalty_points: 0 }) });

  const result = await provisionSingleGuest(guestRow, {
    authInstance: mockAuth,
    dbInstance: {},
    dryRun: false,
    getGuestFn: async () => null, // No existing Firestore doc
    createGuestFn: async (payload) => { createdPayload = payload; return payload; },
    updateGuestFn: async () => {},
    checkEmailConflictFn: async () => ({ conflict: false, ownerUid: null })
  });

  assert(result.firestore_synced === true, 'firestore_synced = true');
  assert(result.firestore_exists === false, 'firestore_exists = false (was new)');
  assert(createdPayload !== null, 'createGuestFn was called');
  assert(createdPayload.mysql_guest_id === 7, 'Firestore doc has mysql_guest_id = 7');
  assert(createdPayload.mysql_user_id === 3, 'Firestore doc has mysql_user_id = 3');
  assert(createdPayload.user_uid === 'guest_3', 'Firestore doc has user_uid = guest_3');
  assert('created_at' in createdPayload, 'Firestore doc has created_at (new doc)');
}

// ── TEST 10: Firestore document updated for existing guest ────────────────────
console.log('\n--- TEST 10: Firestore document updated for existing guest ---');
{
  const guestRow = makeGuestRow({ users_id: 3, guests_id: 7, loyalty_tier: 'Silver', loyalty_points: 75 });
  let updatedId = null;
  let updatedPayload = null;
  const existingDoc = { mysql_guest_id: 7, mysql_user_id: 3, loyalty_tier: 'Bronze', loyalty_points: 0 };
  const mockAuth = makeMockAuth({ existingUser: makeAuthUser('guest_3', 'janedoe@hpms-sky5.internal', { role: 'guest', user_type: 'guest', mysql_id: 3, mysql_guest_id: 7, guest_id: 7, full_name: 'JANE DOE', phone: '9876543210', loyalty_tier: 'Silver', loyalty_points: 75 }) });

  const result = await provisionSingleGuest(guestRow, {
    authInstance: mockAuth,
    dbInstance: {},
    dryRun: false,
    getGuestFn: async () => existingDoc,
    createGuestFn: async () => { throw new Error('Should NOT call create on existing doc'); },
    updateGuestFn: async (id, payload) => { updatedId = id; updatedPayload = payload; return payload; },
    checkEmailConflictFn: async () => ({ conflict: false, ownerUid: null })
  });

  assert(result.firestore_exists === true, 'firestore_exists = true (was existing)');
  assert(result.firestore_synced === true, 'firestore_synced = true (updated)');
  assert(updatedId !== null, 'updateGuestFn was called');
  assert(updatedPayload.loyalty_tier === 'Silver', 'loyalty_tier updated to Silver');
  assert(updatedPayload.loyalty_points === 75, 'loyalty_points updated to 75');
  assert(!('created_at' in updatedPayload), 'created_at NOT set on update (preserved existing)');
}

// ── TEST 11: Inactive/deleted guest is skipped ───────────────────────────────
console.log('\n--- TEST 11: Deleted guest is skipped ---');
{
  const deletedGuest = makeGuestRow({ is_deleted: 1 });
  let createCalled = false;

  const result = await provisionSingleGuest(deletedGuest, {
    authInstance: { async getUser() { throw new Error('Should NOT call getUser for deleted guest'); } },
    dbInstance: {},
    dryRun: false,
    getGuestFn: async () => null,
    createGuestFn: async () => { createCalled = true; },
    updateGuestFn: async () => {},
    checkEmailConflictFn: async () => ({ conflict: false, ownerUid: null })
  });

  assert(result.status === 'SKIPPED', 'status = SKIPPED for deleted guest');
  assert(createCalled === false, 'createGuestFn NOT called for deleted guest');
  assert(result.auth_created === false, 'auth_created = false (skipped)');
}

// ── TEST 12: Orphaned guest (no users_id) is skipped ─────────────────────────
console.log('\n--- TEST 12: Orphaned guest (no users_id) is skipped ---');
{
  const orphan = makeGuestRow({ users_id: null });

  const result = await provisionSingleGuest(orphan, {
    authInstance: null,
    dbInstance: null,
    dryRun: false,
    getGuestFn: async () => null,
    createGuestFn: async () => {},
    updateGuestFn: async () => {},
    checkEmailConflictFn: async () => ({ conflict: false, ownerUid: null })
  });

  assert(result.status === 'SKIPPED', 'orphaned guest status = SKIPPED');
  assert(result.details.toLowerCase().includes('orphan') || result.details.toLowerCase().includes('users'), 'details mention orphan or users');
}

// ── TEST 13: Duplicate email conflict → synthetic fallback ────────────────────
console.log('\n--- TEST 13: Duplicate email conflict → @hpms-sky5.internal fallback ---');
{
  const guestRow = makeGuestRow({ users_id: 3, guests_id: 7, guest_email: 'shared@hotel.com', username: 'janedoe' });
  let createdWithEmail = null;
  const mockAuth = makeMockAuth({ existingUser: null });

  const result = await provisionSingleGuest(guestRow, {
    authInstance: {
      ...mockAuth,
      async createUser(data) { createdWithEmail = data.email; return makeAuthUser(data.uid, data.email); },
      async setCustomUserClaims() {}
    },
    dbInstance: {},
    dryRun: false,
    getGuestFn: async () => null,
    createGuestFn: async (p) => p,
    updateGuestFn: async () => {},
    // Simulates conflict: email is owned by a DIFFERENT Firebase user
    checkEmailConflictFn: async (authInst, email, expectedUid) => {
      if (email === 'shared@hotel.com') {
        return { conflict: true, ownerUid: 'guest_99' };
      }
      return { conflict: false, ownerUid: null };
    }
  });

  assert(result.email_conflict === true, 'email_conflict = true');
  assert(result.resolved_email === 'janedoe@hpms-sky5.internal', 'resolved to synthetic email');
  assert(createdWithEmail === 'janedoe@hpms-sky5.internal', 'Firebase created with synthetic email');
  assert(!createdWithEmail?.includes('shared'), 'conflicted email was NOT used');
}

// ── TEST 14: Idempotent second run — zero unnecessary updates ─────────────────
console.log('\n--- TEST 14: Idempotent second run — no unnecessary mutations ---');
{
  const guestRow = makeGuestRow({ users_id: 3, guests_id: 7 });
  // Simulate: user already exists, claims already correct, Firestore doc already exists
  const perfectClaims = {
    role: 'guest', user_type: 'guest',
    mysql_id: 3, mysql_guest_id: 7, guest_id: 7,
    full_name: 'JANE DOE', phone: '9876543210',
    loyalty_tier: 'Bronze', loyalty_points: 0
  };
  const existingAuth = makeAuthUser('guest_3', 'janedoe@hpms-sky5.internal', perfectClaims);
  const mockAuth = makeMockAuth({ existingUser: existingAuth });
  let claimsSetCalled = false;
  let updateFsCalled = false;

  const result = await provisionSingleGuest(guestRow, {
    authInstance: {
      ...mockAuth,
      async setCustomUserClaims() { claimsSetCalled = true; }
    },
    dbInstance: {},
    dryRun: false,
    getGuestFn: async () => ({ mysql_guest_id: 7, mysql_user_id: 3, user_uid: 'guest_3', full_name: 'JANE DOE', loyalty_tier: 'Bronze', loyalty_points: 0 }),
    createGuestFn: async () => { throw new Error('Should NOT create on second run'); },
    updateGuestFn: async (id, p) => { updateFsCalled = true; return p; }, // update is OK on existing doc
    checkEmailConflictFn: async () => ({ conflict: false, ownerUid: null })
  });

  assert(result.auth_created === false, 'Idempotent: auth NOT re-created');
  assert(claimsSetCalled === false, 'Idempotent: claims NOT re-set when already correct');
  assert(result.status === 'VERIFIED_OK' || result.status === 'FIRESTORE_SYNCED', `Idempotent: status is VERIFIED_OK or FIRESTORE_SYNCED (got: ${result.status})`);
}

// ── TEST 15: Dry-run causes zero mutations ────────────────────────────────────
console.log('\n--- TEST 15: Dry-run causes zero side-effect mutations ---');
{
  const guestRow = makeGuestRow({ users_id: 5, guests_id: 20 });
  const mutations = { createUser: 0, setClaims: 0, createDoc: 0, updateDoc: 0 };
  const mockAuth = {
    async getUser(uid) { const e = new Error(); e.code = 'auth/user-not-found'; throw e; },
    async getUserByEmail(email) { const e = new Error(); e.code = 'auth/user-not-found'; throw e; },
    async createUser(data) { mutations.createUser++; return makeAuthUser(data.uid, data.email); },
    async setCustomUserClaims() { mutations.setClaims++; }
  };

  const result = await provisionSingleGuest(guestRow, {
    authInstance: mockAuth,
    dbInstance: {},
    dryRun: true, // ← DRY RUN
    getGuestFn: async () => null,
    createGuestFn: async () => { mutations.createDoc++; },
    updateGuestFn: async () => { mutations.updateDoc++; },
    checkEmailConflictFn: async () => ({ conflict: false, ownerUid: null })
  });

  assert(mutations.createUser === 0, 'DRY-RUN: createUser NOT called');
  assert(mutations.setClaims === 0, 'DRY-RUN: setCustomUserClaims NOT called');
  assert(mutations.createDoc === 0, 'DRY-RUN: createGuestFn NOT called');
  assert(mutations.updateDoc === 0, 'DRY-RUN: updateGuestFn NOT called');
  assert(result.status.includes('WOULD') || result.status === 'PENDING', `DRY-RUN: status indicates no real change (got: ${result.status})`);
}

// ── TEST 16: SECURITY — password hash never read/exposed/transferred ──────────
console.log('\n--- TEST 16: SECURITY — password hash never read, exposed, or transferred ---');
{
  // Verify that provisionSingleGuest throws if a password field is detected in the row
  const rowWithPassword = makeGuestRow();
  rowWithPassword.password = 'should_never_be_here'; // Simulate accidental field inclusion

  let threw = false;
  let threwMessage = '';
  try {
    await provisionSingleGuest(rowWithPassword, {
      authInstance: null, dbInstance: null, dryRun: true,
      getGuestFn: async () => null, createGuestFn: async () => {},
      updateGuestFn: async () => {},
      checkEmailConflictFn: async () => ({ conflict: false, ownerUid: null })
    });
  } catch (e) {
    threw = true;
    threwMessage = e.message;
  }

  assert(threw === true, 'SECURITY: throws when password field detected in row');
  assert(threwMessage.includes('SECURITY') || threwMessage.includes('password'), 'SECURITY: error message mentions security/password');

  // Load script source to verify the SQL query does NOT select the password column.
  const scriptSrc = (await import('fs')).readFileSync(
    new URL('../scripts/provisionGuestFirebaseAuth.mjs', import.meta.url),
    'utf-8'
  );

  // Extract the actual SQL query string (the template literal passed to localPool.query())
  // and verify it does NOT contain 'u.password' or 'password_hash' as a selected column.
  // This avoids false-positives from the security assertion code that also mentions 'password_hash'.
  const sqlMatch = scriptSrc.match(/localPool\.query\(\s*`([\s\S]*?)`/);
  const sqlQueryText = sqlMatch ? sqlMatch[1] : '';
  assert(sqlQueryText.length > 0, 'SECURITY: SQL query string found in script source');
  const passwordInSelect = /\bu\.password\b/.test(sqlQueryText) || /\bpassword_hash\b/.test(sqlQueryText);
  assert(!passwordInSelect, 'SECURITY: MySQL SELECT does NOT include u.password or password_hash column');

  // Verify the security documentation and temp password approach
  assert(scriptSrc.includes('NOT selected'), 'SECURITY: script documents that password is NOT selected');
  assert(scriptSrc.includes('crypto.randomBytes'), 'SECURITY: temp passwords use crypto.randomBytes (not MySQL-derived)');
}


// ── TEST 17: resolveGuestFirebaseEmail — real email as username ───────────────
console.log('\n--- TEST 17: resolveGuestFirebaseEmail — username is real email ---');
{
  const row = makeGuestRow({ username: 'jane.smith@gmail.com' });
  const email = resolveGuestFirebaseEmail(row);
  assert(email === 'jane.smith@gmail.com', 'real email username used directly');
  assert(!email.includes('hpms-sky5'), 'not synthetic when real email given');
}

// ── TEST 18: resolveGuestFirebaseEmail — phone/handle → synthetic ─────────────
console.log('\n--- TEST 18: resolveGuestFirebaseEmail — phone username → synthetic email ---');
{
  const row = makeGuestRow({ username: '9876543210', guest_email: '' });
  const email = resolveGuestFirebaseEmail(row);
  assert(email === '9876543210@hpms-sky5.internal', 'phone username becomes synthetic email');
  assert(email.endsWith('@hpms-sky5.internal'), 'synthetic email has correct domain');
}

// ── TEST 19: resolveGuestFirebaseEmail — guests.email used when available ─────
console.log('\n--- TEST 19: resolveGuestFirebaseEmail — guests.email used when username has no @ ---');
{
  const row = makeGuestRow({ username: 'janedoe', guest_email: 'jane.doe@realmail.com' });
  const email = resolveGuestFirebaseEmail(row);
  assert(email === 'jane.doe@realmail.com', 'guests.email used when available and not synthetic');
  assert(!email.includes('hpms-sky5'), 'not synthetic when guests.email is available');
}

// ── TEST 20: Full run summary counts are correct ──────────────────────────────
console.log('\n--- TEST 20: Full run summary counts are correct ---');
{
  // 5 guests: 2 existing, 1 new, 1 deleted, 1 with claims to update
  const mockPool = {
    async query(sql) {
      // Security check: query must NOT include 'password'
      assert(!sql.toLowerCase().includes('u.password') && !sql.toLowerCase().includes('password_hash'),
        'SECURITY: pool.query SQL does NOT select password column');

      return [[
        makeGuestRow({ users_id: 1, guests_id: 101, username: 'existing1' }),
        makeGuestRow({ users_id: 2, guests_id: 102, username: 'existing2' }),
        makeGuestRow({ users_id: 3, guests_id: 103, username: 'newguest' }),
        makeGuestRow({ users_id: 4, guests_id: 104, username: 'deleted_user', is_deleted: 1 }),
        makeGuestRow({ users_id: 5, guests_id: 105, username: 'needs_claims_update', loyalty_tier: 'Gold' })
      ]];
    },
    async end() {}
  };

  const existingUsers = {
    'guest_1': makeAuthUser('guest_1', 'existing1@hpms-sky5.internal', { role: 'guest', user_type: 'guest', mysql_id: 1, mysql_guest_id: 101, guest_id: 101, full_name: 'JANE DOE', phone: '9876543210', loyalty_tier: 'Bronze', loyalty_points: 0 }),
    'guest_2': makeAuthUser('guest_2', 'existing2@hpms-sky5.internal', { role: 'guest', user_type: 'guest', mysql_id: 2, mysql_guest_id: 102, guest_id: 102, full_name: 'JANE DOE', phone: '9876543210', loyalty_tier: 'Bronze', loyalty_points: 0 }),
    'guest_5': makeAuthUser('guest_5', 'needs_claims_update@hpms-sky5.internal', { role: 'guest', user_type: 'guest', mysql_id: 5, mysql_guest_id: 105, guest_id: 105, full_name: 'JANE DOE', phone: '9876543210', loyalty_tier: 'Bronze', loyalty_points: 0 }) // Wrong loyalty_tier — will trigger update
  };

  let claimsSetCount = 0;
  let createUserCount = 0;

  const mockAuth = {
    async getUser(uid) {
      if (existingUsers[uid]) return existingUsers[uid];
      const e = new Error(); e.code = 'auth/user-not-found'; throw e;
    },
    async getUserByEmail(email) { const e = new Error(); e.code = 'auth/user-not-found'; throw e; },
    async createUser(data) { createUserCount++; return makeAuthUser(data.uid, data.email); },
    async setCustomUserClaims(uid, claims) { claimsSetCount++; }
  };

  const summary = await runGuestProvisioning({
    pool: mockPool,
    authInstance: mockAuth,
    dbInstance: {},
    dryRun: false,
    getGuestFn: async () => ({ mysql_guest_id: 1 }), // Simulate existing Firestore docs
    createGuestFn: async (p) => p,
    updateGuestFn: async (id, p) => p,
    checkEmailConflictFn: async () => ({ conflict: false, ownerUid: null })
  });

  assert(summary.totalDiscovered === 5, `totalDiscovered = 5 (got: ${summary.totalDiscovered})`);
  assert(summary.skippedCount === 1, `skippedCount = 1 (deleted) (got: ${summary.skippedCount})`);
  assert(summary.activeProcessed === 4, `activeProcessed = 4 (got: ${summary.activeProcessed})`);
  assert(summary.errorCount === 0, `errorCount = 0 (got: ${summary.errorCount})`);
  assert(createUserCount === 1, `Firebase user created for 1 new guest (got: ${createUserCount})`);
  assert(claimsSetCount === 2, `Claims set for 1 new + 1 needing update = 2 (got: ${claimsSetCount})`);
}

// ── Final Summary ─────────────────────────────────────────────────────────────
console.log('\n========================================================================');
console.log(`  Phase 3 Step 3D-1 Test Summary: ${passed} Passed, ${failed} Failed`);
console.log('========================================================================\n');

if (failed > 0) process.exit(1);
