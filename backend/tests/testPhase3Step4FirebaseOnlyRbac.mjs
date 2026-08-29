/**
 * testPhase3Step4FirebaseOnlyRbac.mjs
 * ============================================================================
 * HPMS Phase 3 Step 4 — Firebase-Only RBAC & Root Admin Resolution Test Suite
 *
 * Hard requirements:
 *   1. When ENABLE_FIREBASE_ONLY_RBAC=false (default):
 *      - hasPermission() queries MySQL permissions/role_permissions/roles tables.
 *      - Root admin user_1 resolution uses MySQL users table.
 *   2. When ENABLE_FIREBASE_ONLY_RBAC=true:
 *      - hasPermission() queries Firestore RBAC repository (/roles, /role_permissions).
 *      - MySQL permission query count MUST EQUAL 0.
 *      - Root admin user_1 resolves from verified Firebase claims with 0 MySQL users queries.
 *   3. 100% Parity across all 7 master permissions and roles.
 *   4. Zero accidental MySQL fallback on Firestore error when flag is true.
 *   5. Instant rollback to MySQL when flag is set back to false.
 */

import pool from '../db.js';
import {
  hasPermission,
  resolveCanonicalFirebaseUser,
  requireRole,
  requireAdmin,
  requireSuperAdmin,
  requireGuest,
  normalizeUserRole
} from '../controllers/authController.js';
import {
  hasFirestorePermission
} from '../repositories/firestore/rbacRepository.js';

// ── Test Harness Setup ────────────────────────────────────────────────────────

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures = [];

function assert(condition, message) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✔ [PASS] ${message}`);
  } else {
    failedTests++;
    failures.push(message);
    console.error(`  ❌ [FAIL] ${message}`);
  }
}

// ── Intercept pool.query to count MySQL queries ────────────────────────────────

let mysqlRbacQueryCount = 0;
let mysqlUsersQueryCount = 0;
let mysqlTotalQueryCount = 0;

const originalPoolQuery = pool.query.bind(pool);

pool.query = async function (sql, params) {
  mysqlTotalQueryCount++;
  const sqlStr = String(sql);
  if (sqlStr.includes('FROM permissions') || sqlStr.includes('role_permissions') || sqlStr.includes('FROM roles')) {
    mysqlRbacQueryCount++;
  }
  if (sqlStr.includes('FROM users')) {
    mysqlUsersQueryCount++;
  }
  return originalPoolQuery(sql, params);
};

function resetQueryCounters() {
  mysqlRbacQueryCount = 0;
  mysqlUsersQueryCount = 0;
  mysqlTotalQueryCount = 0;
}

// ── Mock Firestore RBAC Resolver (Matches 100% Mirror in /role_permissions) ───

const FIRESTORE_RBAC_DATA = {
  admin: [
    'view_dashboard',
    'manage_rooms',
    'manage_bookings',
    'run_audit',
    'make_payment',
    'modify_business_date',
    'override_business_date'
  ],
  guest: [
    'view_dashboard',
    'make_payment'
  ]
};

async function mockFirestorePermissionFn(roleName, permName) {
  const allowed = FIRESTORE_RBAC_DATA[String(roleName).toLowerCase().trim()] || [];
  return allowed.includes(String(permName).toLowerCase().trim());
}

async function quotaExhaustedFirestoreFn(roleName, permName) {
  const err = new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.');
  err.code = 8;
  throw err;
}

async function genericErrorFirestoreFn(roleName, permName) {
  const err = new Error('Firestore connection timeout');
  err.code = 14;
  throw err;
}

// ── Helper Context Builders ───────────────────────────────────────────────────

function createReq(user) {
  return {
    user,
    headers: {},
    ip: '127.0.0.1'
  };
}

async function runStep4Tests() {
  console.log('\n========================================================================================');
  console.log('       HPMS PHASE 3 STEP 4 — FIREBASE-ONLY RBAC VERIFICATION TEST SUITE');
  console.log('========================================================================================\n');

  try {
    // ──────────────────────────────────────────────────────────────────────────
    // SECTION A: Feature Flag OFF — Existing MySQL RBAC Authoritative Behavior
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[SECTION A] Feature Flag OFF — Existing MySQL RBAC Path...');
    process.env.ENABLE_FIREBASE_ONLY_RBAC = 'false';

    resetQueryCounters();
    const adminReqOff = createReq({ id: 1, role: 'admin', type: 'admin' });
    const hasOverrideOff = await hasPermission(adminReqOff, 'override_business_date');
    assert(hasOverrideOff === true, 'Flag OFF: admin has override_business_date = true');
    assert(mysqlRbacQueryCount > 0, `Flag OFF: MySQL RBAC queries were executed (${mysqlRbacQueryCount} query)`);

    resetQueryCounters();
    const guestReqOff = createReq({ id: 2, role: 'guest', type: 'guest' });
    const guestOverrideOff = await hasPermission(guestReqOff, 'override_business_date');
    assert(guestOverrideOff === false, 'Flag OFF: guest has override_business_date = false');
    assert(mysqlRbacQueryCount > 0, `Flag OFF: guest check executed MySQL RBAC query (${mysqlRbacQueryCount} query)`);

    // ──────────────────────────────────────────────────────────────────────────
    // SECTION B: Feature Flag ON — Firebase-Only RBAC Path & 0 MySQL Queries
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[SECTION B] Feature Flag ON — Firebase-Only RBAC Path (0 MySQL RBAC Queries)...');
    process.env.ENABLE_FIREBASE_ONLY_RBAC = 'true';

    resetQueryCounters();
    const adminReqOn = createReq({ id: 1, role: 'admin', type: 'admin' });
    const hasOverrideOn = await hasPermission(adminReqOn, 'override_business_date', {
      hasFirestorePermissionFn: mockFirestorePermissionFn
    });
    assert(hasOverrideOn === true, 'Flag ON: admin has override_business_date = true from Firestore');
    assert(mysqlRbacQueryCount === 0, `Flag ON: MySQL RBAC query count === 0 (Actual: ${mysqlRbacQueryCount})`);

    resetQueryCounters();
    const guestReqOn = createReq({ id: 2, role: 'guest', type: 'guest' });
    const guestOverrideOn = await hasPermission(guestReqOn, 'override_business_date', {
      hasFirestorePermissionFn: mockFirestorePermissionFn
    });
    assert(guestOverrideOn === false, 'Flag ON: guest has override_business_date = false from Firestore');
    assert(mysqlRbacQueryCount === 0, `Flag ON: guest check produced 0 MySQL RBAC queries (Actual: ${mysqlRbacQueryCount})`);

    // ──────────────────────────────────────────────────────────────────────────
    // SECTION C: Full Permission Parity Across All 7 Master Permissions
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[SECTION C] Full Permission Parity Across All 7 Master Permissions...');
    const allPermissions = [
      'view_dashboard',
      'manage_rooms',
      'manage_bookings',
      'run_audit',
      'make_payment',
      'modify_business_date',
      'override_business_date'
    ];

    // Admin should have all 7 permissions in both MySQL (flag OFF) and Firestore (flag ON)
    for (const perm of allPermissions) {
      process.env.ENABLE_FIREBASE_ONLY_RBAC = 'false';
      const allowedMysql = await hasPermission(adminReqOff, perm);

      process.env.ENABLE_FIREBASE_ONLY_RBAC = 'true';
      resetQueryCounters();
      const allowedFirestore = await hasPermission(adminReqOn, perm, {
        hasFirestorePermissionFn: mockFirestorePermissionFn
      });

      assert(
        allowedMysql === true && allowedFirestore === true,
        `Admin permission '${perm}' matches: MySQL=${allowedMysql}, Firestore=${allowedFirestore}`
      );
      assert(mysqlRbacQueryCount === 0, `Admin '${perm}' Firestore check used 0 MySQL queries`);
    }

    // Guest should have view_dashboard and make_payment, but NOT the other 5
    for (const perm of allPermissions) {
      process.env.ENABLE_FIREBASE_ONLY_RBAC = 'false';
      const guestMysql = await hasPermission(guestReqOff, perm);

      process.env.ENABLE_FIREBASE_ONLY_RBAC = 'true';
      resetQueryCounters();
      const guestFirestore = await hasPermission(guestReqOn, perm, {
        hasFirestorePermissionFn: mockFirestorePermissionFn
      });

      const expectedGuest = ['view_dashboard', 'make_payment'].includes(perm);
      assert(
        guestMysql === expectedGuest && guestFirestore === expectedGuest,
        `Guest permission '${perm}' parity: expected=${expectedGuest}, MySQL=${guestMysql}, Firestore=${guestFirestore}`
      );
      assert(mysqlRbacQueryCount === 0, `Guest '${perm}' Firestore check used 0 MySQL queries`);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // SECTION D: Roles Normalization and Hierarchy Support
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[SECTION D] Roles Normalization & Hierarchy Support...');
    process.env.ENABLE_FIREBASE_ONLY_RBAC = 'true';

    // Super Admin role alias
    const superAdminReq = createReq({ id: 1, role: 'super_admin', type: 'system', isRootAdmin: true });
    resetQueryCounters();
    const superAdminCanOverride = await hasPermission(superAdminReq, 'override_business_date', {
      hasFirestorePermissionFn: mockFirestorePermissionFn
    });
    assert(superAdminCanOverride === true, 'super_admin role resolves permissions through admin role');
    assert(mysqlRbacQueryCount === 0, 'super_admin permission check used 0 MySQL queries');

    // Case-insensitivity support
    const mixedCaseReq = createReq({ id: 1, role: 'ADMIN' });
    const mixedCasePerm = await hasPermission(mixedCaseReq, 'OVERRIDE_BUSINESS_DATE', {
      hasFirestorePermissionFn: mockFirestorePermissionFn
    });
    assert(mixedCasePerm === true, 'Mixed case role/permission resolved cleanly');

    // Canonical role normalization helper
    assert(normalizeUserRole({ role: 'ADMIN', type: 'staff' }) === 'admin', 'Staff ADMIN normalizes to admin');
    assert(normalizeUserRole({ role: 'RECEPTIONIST', type: 'staff' }) === 'receptionist', 'Staff RECEPTIONIST normalizes to receptionist');
    assert(normalizeUserRole({ role: 'CLEANER', type: 'staff' }) === 'housekeeper', 'Staff CLEANER normalizes to housekeeper');
    assert(normalizeUserRole({ role: 'CHEF', type: 'staff' }) === 'kitchen', 'Staff CHEF normalizes to kitchen');
    assert(normalizeUserRole({ role: 'admin', type: 'admin', id: 1 }) === 'super_admin', 'Root admin normalizes to super_admin');

    // ──────────────────────────────────────────────────────────────────────────
    // SECTION E: Root Admin Resolution (Zero MySQL Users Table Queries)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[SECTION E] Root Admin Resolution from Firebase Claims (0 MySQL Queries)...');

    const rootAdminFirebaseDecoded = {
      uid: 'user_1',
      mysql_id: 1,
      role: 'super_admin',
      type: 'system',
      name: 'ADMINISTRATOR'
    };

    // Flag OFF -> queries MySQL users
    process.env.ENABLE_FIREBASE_ONLY_RBAC = 'false';
    resetQueryCounters();
    const rootUserOff = await resolveCanonicalFirebaseUser(rootAdminFirebaseDecoded);
    assert(rootUserOff && rootUserOff.id === 1 && rootUserOff.role === 'admin', 'Flag OFF: root admin resolved via MySQL');
    assert(mysqlUsersQueryCount > 0, `Flag OFF: MySQL users query executed (${mysqlUsersQueryCount} query)`);

    // Flag ON -> resolves directly from claims, 0 MySQL queries
    process.env.ENABLE_FIREBASE_ONLY_RBAC = 'true';
    resetQueryCounters();
    const rootUserOn = await resolveCanonicalFirebaseUser(rootAdminFirebaseDecoded);
    assert(rootUserOn && rootUserOn.id === 1 && rootUserOn.role === 'admin' && rootUserOn.isRootAdmin === true, 'Flag ON: root admin resolved cleanly from claims');
    assert(mysqlUsersQueryCount === 0, `Flag ON: MySQL users query count === 0 (Actual: ${mysqlUsersQueryCount})`);
    assert(rootUserOn.authProvider === 'firebase', 'Root admin authProvider is firebase');

    // ──────────────────────────────────────────────────────────────────────────
    // SECTION F: Negative Cases, Boundary Conditions, and Safe Error Handling
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[SECTION F] Negative Cases & Safe Error Handling...');
    process.env.ENABLE_FIREBASE_ONLY_RBAC = 'true';

    // 1. Missing user object
    resetQueryCounters();
    const nullUserReq = { headers: {} };
    const nullPerm = await hasPermission(nullUserReq, 'view_dashboard', {
      hasFirestorePermissionFn: mockFirestorePermissionFn
    });
    assert(nullPerm === false, 'Missing req.user returns false');
    assert(mysqlRbacQueryCount === 0, 'Missing user check used 0 MySQL queries');

    // 2. Unknown permission
    resetQueryCounters();
    const unknownPerm = await hasPermission(adminReqOn, 'non_existent_permission_xyz', {
      hasFirestorePermissionFn: mockFirestorePermissionFn
    });
    assert(unknownPerm === false, 'Unknown permission returns false');
    assert(mysqlRbacQueryCount === 0, 'Unknown permission check used 0 MySQL queries');

    // 3. Unknown role
    resetQueryCounters();
    const unknownRoleReq = createReq({ id: 999, role: 'anonymous_role' });
    const unknownRolePerm = await hasPermission(unknownRoleReq, 'view_dashboard', {
      hasFirestorePermissionFn: mockFirestorePermissionFn
    });
    assert(unknownRolePerm === false, 'Unknown role returns false');
    assert(mysqlRbacQueryCount === 0, 'Unknown role check used 0 MySQL queries');

    // 4. Empty / blank role
    resetQueryCounters();
    const blankRoleReq = createReq({ id: 999, role: '' });
    const blankRolePerm = await hasPermission(blankRoleReq, 'view_dashboard', {
      hasFirestorePermissionFn: mockFirestorePermissionFn
    });
    assert(blankRolePerm === false, 'Blank role returns false');
    assert(mysqlRbacQueryCount === 0, 'Blank role check used 0 MySQL queries');

    // 5. Firestore Quota Exhaustion (Code 8) Error Handling
    resetQueryCounters();
    const quotaPerm = await hasPermission(adminReqOn, 'view_dashboard', {
      hasFirestorePermissionFn: quotaExhaustedFirestoreFn
    });
    assert(quotaPerm === false, 'Firestore quota error handled gracefully (returns false)');
    assert(mysqlRbacQueryCount === 0, 'Firestore quota error did NOT fall back to MySQL');

    // 6. Generic Firestore Error Handling
    resetQueryCounters();
    const errorPerm = await hasPermission(adminReqOn, 'view_dashboard', {
      hasFirestorePermissionFn: genericErrorFirestoreFn
    });
    assert(errorPerm === false, 'Generic Firestore error handled gracefully (returns false)');
    assert(mysqlRbacQueryCount === 0, 'Generic Firestore error did NOT fall back to MySQL');

    // ──────────────────────────────────────────────────────────────────────────
    // SECTION G: Rollback Safety Verification
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[SECTION G] Rollback Safety (Toggling Flag Off Instantly Restores MySQL)...');
    process.env.ENABLE_FIREBASE_ONLY_RBAC = 'false';

    resetQueryCounters();
    const rollbackPerm = await hasPermission(adminReqOff, 'override_business_date');
    assert(rollbackPerm === true, 'Rollback: hasPermission returns true via MySQL');
    assert(mysqlRbacQueryCount > 0, `Rollback: MySQL query executed as expected (${mysqlRbacQueryCount} query)`);

    resetQueryCounters();
    const rollbackRoot = await resolveCanonicalFirebaseUser(rootAdminFirebaseDecoded);
    assert(rollbackRoot && rollbackRoot.id === 1, 'Rollback: root admin resolves via MySQL users table');
    assert(mysqlUsersQueryCount > 0, `Rollback: MySQL users query executed (${mysqlUsersQueryCount} query)`);

    // ──────────────────────────────────────────────────────────────────────────
    // SECTION H: Concurrency Test (50 Concurrent Permission Checks)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[SECTION H] Concurrency Stress Test (50 Concurrent Permission Checks)...');
    process.env.ENABLE_FIREBASE_ONLY_RBAC = 'true';
    resetQueryCounters();

    const concurrentPromises = [];
    for (let i = 0; i < 25; i++) {
      concurrentPromises.push(hasPermission(adminReqOn, 'override_business_date', {
        hasFirestorePermissionFn: mockFirestorePermissionFn
      }));
      concurrentPromises.push(hasPermission(guestReqOn, 'make_payment', {
        hasFirestorePermissionFn: mockFirestorePermissionFn
      }));
    }

    const results = await Promise.all(concurrentPromises);
    const allExpected = results.every(res => res === true);
    assert(allExpected, 'All 50 concurrent permission evaluations succeeded with true');
    assert(mysqlRbacQueryCount === 0, `50 concurrent evaluations executed exactly 0 MySQL queries (Actual: ${mysqlRbacQueryCount})`);

    // ──────────────────────────────────────────────────────────────────────────
    // SECTION I: Express Authorization Middleware Verification
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[SECTION I] Express Authorization Middlewares with Normalization...');

    function testMiddleware(middlewareFn, req) {
      return new Promise(resolve => {
        const res = {
          status(code) {
            this.statusCode = code;
            return this;
          },
          json(payload) {
            this.body = payload;
            resolve({ passed: false, statusCode: this.statusCode, body: payload });
          }
        };
        const next = () => resolve({ passed: true });
        middlewareFn(req, res, next);
      });
    }

    process.env.ENABLE_STRICT_RBAC = 'true';

    // requireRole
    const adminCheck = await testMiddleware(requireRole('admin'), adminReqOn);
    assert(adminCheck.passed === true, 'requireRole(admin) passes for admin');

    const guestCheckOnAdmin = await testMiddleware(requireRole('admin'), guestReqOn);
    assert(guestCheckOnAdmin.passed === false && guestCheckOnAdmin.statusCode === 403, 'requireRole(admin) rejects guest with 403');

    // requireSuperAdmin
    const superAdminPass = await testMiddleware(requireSuperAdmin, superAdminReq);
    assert(superAdminPass.passed === true, 'requireSuperAdmin passes for super_admin root account');

    const receptionistSuperAdminReject = await testMiddleware(requireSuperAdmin, createReq({ role: 'RECEPTIONIST', type: 'staff' }));
    assert(receptionistSuperAdminReject.passed === false && receptionistSuperAdminReject.statusCode === 403, 'requireSuperAdmin rejects receptionist with 403');

    // requireGuest
    const guestPass = await testMiddleware(requireGuest, guestReqOn);
    assert(guestPass.passed === true, 'requireGuest passes for guest');

    const adminGuestReject = await testMiddleware(requireGuest, adminReqOn);
    assert(adminGuestReject.passed === false && adminGuestReject.statusCode === 403, 'requireGuest rejects admin with 403');

  } catch (err) {
    console.error('❌ Unhandled Exception in Step 4 Test Suite:', err);
    failedTests++;
    failures.push(err.message);
  } finally {
    // Restore default state
    process.env.ENABLE_FIREBASE_ONLY_RBAC = 'false';
    pool.query = originalPoolQuery;
    await pool.end();
  }

  // ── Final Test Summary ───────────────────────────────────────────────────────
  console.log('\n========================================================================================');
  console.log(` PHASE 3 STEP 4 TEST SUMMARY: ${passedTests} Passed, ${failedTests} Failed (Total: ${totalTests})`);
  console.log('========================================================================================\n');

  if (failedTests > 0) {
    console.error('Failed Assertions:');
    failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
    process.exit(1);
  }
}

runStep4Tests();
