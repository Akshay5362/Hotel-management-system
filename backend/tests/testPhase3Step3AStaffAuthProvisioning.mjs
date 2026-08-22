/**
 * testPhase3Step3AStaffAuthProvisioning.mjs
 * =========================================================================
 * Test suite for HPMS Phase 3 Step 3A: Staff Firebase Auth Provisioning
 *
 * Test Scenarios:
 *  1. Existing Firebase user discovery & matching (by UID staff_<username>, staff_<id>, email)
 *  2. Missing Firebase user creation (generates safe temp password, creates user)
 *  3. Existing custom claims preservation (never overwrites unrelated custom claims)
 *  4. Missing/outdated custom claims update (merges required fields)
 *  5. Existing Firestore staff document detection & update
 *  6. Missing Firestore staff document creation
 *  7. Inactive staff skipped (status === 'Inactive')
 *  8. Deleted staff skipped (deleted === 1 or deleted === true)
 *  9. Rerunning provisioning causes no duplicate users (idempotency)
 *  10. Dry-run mode produces zero mutations on Auth and Firestore
 */

import {
  findExistingFirebaseAuthUser,
  computeStaffCustomClaims,
  provisionSingleStaff,
  runStaffProvisioning
} from '../scripts/provisionStaffFirebaseAuth.mjs';

async function runTests() {
  console.log('========================================================================');
  console.log('  HPMS Phase 3 Step 3A — Staff Firebase Auth Provisioning Test Suite');
  console.log('========================================================================\n');

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

  // --- Mock Firebase Auth Implementation ---
  class MockFirebaseAuth {
    constructor(initialUsers = []) {
      this.users = new Map();
      this.createdUsers = [];
      this.claimsUpdates = [];

      for (const u of initialUsers) {
        this.users.set(u.uid, { ...u, customClaims: { ...(u.customClaims || {}) } });
      }
    }

    async getUser(uid) {
      if (this.users.has(uid)) {
        return this.users.get(uid);
      }
      const err = new Error(`User not found: ${uid}`);
      err.code = 'auth/user-not-found';
      throw err;
    }

    async getUserByEmail(email) {
      const lower = String(email).toLowerCase().trim();
      for (const u of this.users.values()) {
        if (u.email && u.email.toLowerCase().trim() === lower) {
          return u;
        }
      }
      const err = new Error(`User not found with email: ${email}`);
      err.code = 'auth/user-not-found';
      throw err;
    }

    async createUser(properties) {
      if (this.users.has(properties.uid)) {
        const err = new Error(`User already exists: ${properties.uid}`);
        err.code = 'auth/uid-already-exists';
        throw err;
      }
      const newUser = {
        uid: properties.uid,
        email: properties.email,
        displayName: properties.displayName,
        customClaims: {}
      };
      this.users.set(properties.uid, newUser);
      this.createdUsers.push(newUser);
      return newUser;
    }

    async setCustomUserClaims(uid, claims) {
      if (!this.users.has(uid)) {
        const err = new Error(`User not found: ${uid}`);
        err.code = 'auth/user-not-found';
        throw err;
      }
      const user = this.users.get(uid);
      user.customClaims = { ...claims };
      this.claimsUpdates.push({ uid, claims });
    }
  }

  // --- Mock Firestore Implementation ---
  class MockFirestoreDb {
    constructor(initialDocs = {}) {
      this.docs = new Map(Object.entries(initialDocs));
      this.creates = [];
      this.updates = [];
    }

    async getStaffDoc(docId) {
      return this.docs.get(docId) || null;
    }

    async createStaffDoc(data) {
      const docId = `staff_${data.username}`;
      this.docs.set(docId, { ...data });
      this.creates.push({ docId, data });
      return { id: docId, ...data };
    }

    async updateStaffDoc(docId, data) {
      const existing = this.docs.get(docId) || {};
      const updated = { ...existing, ...data };
      this.docs.set(docId, updated);
      this.updates.push({ docId, data });
      return { id: docId, ...updated };
    }
  }

  // =========================================================================
  // TEST 1: Existing Firebase User Discovery
  // =========================================================================
  console.log('--- TEST 1: Existing Firebase User Discovery ---');
  {
    const mockAuth = new MockFirebaseAuth([
      { uid: 'staff_reception_morning', email: 'reception.morning@hotelsky5.com' },
      { uid: 'staff_5', email: 'chef@hotelsky5.com' },
      { uid: 'custom_uid_99', email: 'pantry1@hotelsky5.com' }
    ]);

    // 1a: Found by username UID
    const staff1 = { id: 2, username: 'reception_morning', email: 'reception.morning@hotelsky5.com' };
    const user1 = await findExistingFirebaseAuthUser(mockAuth, staff1);
    assert(user1 && user1.uid === 'staff_reception_morning', 'Found user by staff_<username> UID');

    // 1b: Found by mysql_id UID
    const staff2 = { id: 5, username: 'chef_user', email: 'chef@hotelsky5.com' };
    const user2 = await findExistingFirebaseAuthUser(mockAuth, staff2);
    assert(user2 && user2.uid === 'staff_5', 'Found user by staff_<id> UID');

    // 1c: Found by email
    const staff3 = { id: 7, username: 'pantry1', email: 'pantry1@hotelsky5.com' };
    const user3 = await findExistingFirebaseAuthUser(mockAuth, staff3);
    assert(user3 && user3.uid === 'custom_uid_99', 'Found user by email fallback');

    // 1d: Not found
    const staffMissing = { id: 99, username: 'nonexistent', email: 'none@hotel.test' };
    const userMissing = await findExistingFirebaseAuthUser(mockAuth, staffMissing);
    assert(userMissing === null, 'Returns null when user does not exist');
  }

  // =========================================================================
  // TEST 2: Missing Firebase User Creation
  // =========================================================================
  console.log('\n--- TEST 2: Missing Firebase User Creation ---');
  {
    const mockAuth = new MockFirebaseAuth([]);
    const mockDb = new MockFirestoreDb();

    const staff = {
      id: 8,
      username: 'pantry2',
      full_name: 'Pantry Boy 2',
      email: 'pantry2@hotelsky5.com',
      role: 'PANTRY_BOY',
      department: 'Pantry',
      shift: 'Night',
      status: 'Active',
      deleted: 0
    };

    const res = await provisionSingleStaff(staff, {
      authInstance: mockAuth,
      dbInstance: mockDb,
      dryRun: false,
      getStaffFn: (id) => mockDb.getStaffDoc(id),
      createStaffFn: (data) => mockDb.createStaffDoc(data),
      updateStaffFn: (id, data) => mockDb.updateStaffDoc(id, data)
    });

    assert(res.auth_created === true, 'Created new Firebase Auth user');
    assert(res.firebase_uid === 'staff_pantry2', 'Assigned canonical UID staff_pantry2');
    assert(mockAuth.createdUsers.length === 1, 'Auth create user was called exactly once');
    assert(mockAuth.createdUsers[0].email === 'pantry2@hotelsky5.com', 'Created user has correct email');
  }

  // =========================================================================
  // TEST 3 & 4: Custom Claims Preservation and Update
  // =========================================================================
  console.log('\n--- TEST 3 & 4: Custom Claims Preservation & Update ---');
  {
    const existingClaims = {
      legacy_custom_scope: 'reports_readonly',
      role: 'staff' // Outdated
    };

    const staff = {
      id: 3,
      username: 'reception_evening',
      role: 'RECEPTIONIST',
      status: 'Active',
      deleted: 0
    };

    const { mergedClaims, needsUpdate } = computeStaffCustomClaims(existingClaims, staff);

    assert(needsUpdate === true, 'Identified that claims need update');
    assert(mergedClaims.legacy_custom_scope === 'reports_readonly', 'Preserved unrelated existing claim (legacy_custom_scope)');
    assert(mergedClaims.role === 'RECEPTIONIST', 'Updated role claim to RECEPTIONIST');
    assert(mergedClaims.user_type === 'staff', 'Set user_type to staff');
    assert(mergedClaims.mysql_id === 3, 'Set mysql_id to 3');
    assert(mergedClaims.mysql_staff_id === 3, 'Set mysql_staff_id to 3');
    assert(mergedClaims.staff_username === 'reception_evening', 'Set staff_username to reception_evening');
    assert(mergedClaims.status === 'Active', 'Set status to Active');
    assert(mergedClaims.deleted === 0, 'Set deleted to 0');

    // Test when claims already match
    const secondCheck = computeStaffCustomClaims(mergedClaims, staff);
    assert(secondCheck.needsUpdate === false, 'Recognized that claims already match (idempotent)');
  }

  // =========================================================================
  // TEST 5 & 6: Firestore Document Creation and Update
  // =========================================================================
  console.log('\n--- TEST 5 & 6: Firestore Document Creation & Update ---');
  {
    const mockAuth = new MockFirebaseAuth([
      { uid: 'staff_cleaner1', email: 'cleaner1@hotelsky5.com' }
    ]);
    const mockDb = new MockFirestoreDb(); // Empty

    const staff = {
      id: 9,
      username: 'cleaner1',
      full_name: 'Cleaner One',
      email: 'cleaner1@hotelsky5.com',
      role: 'CLEANER',
      department: 'Housekeeping',
      shift: 'Morning',
      status: 'Active',
      deleted: 0
    };

    // First run: Creates Firestore doc
    const res1 = await provisionSingleStaff(staff, {
      authInstance: mockAuth,
      dbInstance: mockDb,
      dryRun: false,
      getStaffFn: (id) => mockDb.getStaffDoc(id),
      createStaffFn: (data) => mockDb.createStaffDoc(data),
      updateStaffFn: (id, data) => mockDb.updateStaffDoc(id, data)
    });

    assert(res1.firestore_exists === false, 'Recognized Firestore doc was initially missing');
    assert(res1.firestore_synced === true, 'Synced Firestore doc via create');
    assert(mockDb.creates.length === 1, 'Firestore create called once');

    // Second run: Updates existing Firestore doc
    const res2 = await provisionSingleStaff(staff, {
      authInstance: mockAuth,
      dbInstance: mockDb,
      dryRun: false,
      getStaffFn: (id) => mockDb.getStaffDoc(id),
      createStaffFn: (data) => mockDb.createStaffDoc(data),
      updateStaffFn: (id, data) => mockDb.updateStaffDoc(id, data)
    });

    assert(res2.firestore_exists === true, 'Recognized Firestore doc now exists');
    assert(mockDb.updates.length === 1, 'Firestore update called');
  }

  // =========================================================================
  // TEST 7 & 8: Inactive and Deleted Staff Skipped
  // =========================================================================
  console.log('\n--- TEST 7 & 8: Inactive & Deleted Staff Skipped ---');
  {
    const mockAuth = new MockFirebaseAuth([]);
    const mockDb = new MockFirestoreDb();

    // 7: Inactive staff
    const inactiveStaff = {
      id: 11,
      username: 'inactive_staff',
      email: 'inactive@hotelsky5.com',
      role: 'RECEPTIONIST',
      status: 'Inactive',
      deleted: 0
    };

    const resInactive = await provisionSingleStaff(inactiveStaff, {
      authInstance: mockAuth,
      dbInstance: mockDb,
      dryRun: false,
      getStaffFn: (id) => mockDb.getStaffDoc(id),
      createStaffFn: (data) => mockDb.createStaffDoc(data),
      updateStaffFn: (id, data) => mockDb.updateStaffDoc(id, data)
    });

    assert(resInactive.status === 'SKIPPED', 'Inactive staff skipped');
    assert(mockAuth.createdUsers.length === 0, 'No auth user created for inactive staff');

    // 8: Deleted staff
    const deletedStaff = {
      id: 12,
      username: 'deleted_staff',
      email: 'deleted@hotelsky5.com',
      role: 'CLEANER',
      status: 'Active',
      deleted: 1
    };

    const resDeleted = await provisionSingleStaff(deletedStaff, {
      authInstance: mockAuth,
      dbInstance: mockDb,
      dryRun: false,
      getStaffFn: (id) => mockDb.getStaffDoc(id),
      createStaffFn: (data) => mockDb.createStaffDoc(data),
      updateStaffFn: (id, data) => mockDb.updateStaffDoc(id, data)
    });

    assert(resDeleted.status === 'SKIPPED', 'Deleted staff skipped');
    assert(mockAuth.createdUsers.length === 0, 'No auth user created for deleted staff');
  }

  // =========================================================================
  // TEST 9: Idempotency (Rerunning causes zero duplicate users)
  // =========================================================================
  console.log('\n--- TEST 9: Idempotency (Rerunning causes no duplicate users) ---');
  {
    const mockAuth = new MockFirebaseAuth([]);
    const mockDb = new MockFirestoreDb();

    const staffList = [
      { id: 1, username: 'admin', full_name: 'Admin', email: 'admin@hotelsky5.com', role: 'ADMIN', status: 'Active', deleted: 0 },
      { id: 2, username: 'reception_morning', full_name: 'Reception 1', email: 'rec1@hotelsky5.com', role: 'RECEPTIONIST', status: 'Active', deleted: 0 }
    ];

    // First Run
    for (const staff of staffList) {
      await provisionSingleStaff(staff, {
        authInstance: mockAuth,
        dbInstance: mockDb,
        dryRun: false,
        getStaffFn: (id) => mockDb.getStaffDoc(id),
        createStaffFn: (data) => mockDb.createStaffDoc(data),
        updateStaffFn: (id, data) => mockDb.updateStaffDoc(id, data)
      });
    }

    assert(mockAuth.createdUsers.length === 2, 'First run created 2 auth users');

    // Second Run
    const rerunResults = [];
    for (const staff of staffList) {
      const res = await provisionSingleStaff(staff, {
        authInstance: mockAuth,
        dbInstance: mockDb,
        dryRun: false,
        getStaffFn: (id) => mockDb.getStaffDoc(id),
        createStaffFn: (data) => mockDb.createStaffDoc(data),
        updateStaffFn: (id, data) => mockDb.updateStaffDoc(id, data)
      });
      rerunResults.push(res);
    }

    assert(mockAuth.createdUsers.length === 2, 'Second run created 0 additional auth users (no duplicates)');
    assert(rerunResults.every(r => r.auth_exists === true), 'All staff recognized as already existing in Auth');
    assert(rerunResults.every(r => r.status === 'VERIFIED_OK'), 'All staff verified with status VERIFIED_OK');
  }

  // =========================================================================
  // TEST 10: Dry-run Mode Produces Zero Mutations
  // =========================================================================
  console.log('\n--- TEST 10: Dry-Run Mode Produces Zero Mutations ---');
  {
    const mockAuth = new MockFirebaseAuth([
      { uid: 'staff_1', email: 'admin@hotelsky5.com', customClaims: { role: 'old' } }
    ]);
    const mockDb = new MockFirestoreDb();

    const staffList = [
      { id: 1, username: 'admin', full_name: 'Admin', email: 'admin@hotelsky5.com', role: 'ADMIN', status: 'Active', deleted: 0 },
      { id: 2, username: 'new_staff', full_name: 'New Staff', email: 'new@hotelsky5.com', role: 'RECEPTIONIST', status: 'Active', deleted: 0 }
    ];

    for (const staff of staffList) {
      await provisionSingleStaff(staff, {
        authInstance: mockAuth,
        dbInstance: mockDb,
        dryRun: true,
        getStaffFn: (id) => mockDb.getStaffDoc(id),
        createStaffFn: (data) => mockDb.createStaffDoc(data),
        updateStaffFn: (id, data) => mockDb.updateStaffDoc(id, data)
      });
    }

    assert(mockAuth.createdUsers.length === 0, 'Dry-run: Zero users created in Firebase Auth');
    assert(mockAuth.claimsUpdates.length === 0, 'Dry-run: Zero custom claims updated in Firebase Auth');
    assert(mockDb.creates.length === 0, 'Dry-run: Zero documents created in Firestore');
    assert(mockDb.updates.length === 0, 'Dry-run: Zero documents updated in Firestore');
  }

  console.log('\n========================================================================');
  console.log(`  Phase 3 Step 3A Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
