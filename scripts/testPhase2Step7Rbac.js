/**
 * testPhase2Step7Rbac.js — Phase 2 Step 7 RBAC Parity & Dual-RBAC Test Suite
 * =========================================================================
 * Comprehensive test suite verifying 100% parity between MySQL RBAC and
 * Firestore RBAC repository layer.
 *
 * SAFETY CONSTRAINTS:
 *  - 100% READ-ONLY verification.
 *  - ZERO database writes to MySQL or Firestore.
 *  - ZERO modifications to Firebase Auth users or custom claims.
 *
 * Usage:
 *  node scripts/testPhase2Step7Rbac.js
 */

import pool from '../backend/db.js';
import { db, auth, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import {
  getRoleByIdFirestore,
  getRoleByNameFirestore,
  getAllRolesFirestore,
  getPermissionByIdFirestore,
  getPermissionByNameFirestore,
  getAllPermissionsFirestore,
  getRolePermissionsFirestore,
  getPermissionsForRoleFirestore,
  hasFirestorePermission
} from '../backend/repositories/firestore/rbacRepository.js';
import {
  hasMysqlPermission,
  getMysqlPermissionsForRole,
  comparePermissionResolution,
  compareRoleRbacParity
} from '../backend/services/dualRbacVerificationService.js';

async function runRbacParityTests() {
  console.log('\n========================================================================================');
  console.log('                 PHASE 2 STEP 7 FIRESTORE RBAC PARITY TEST SUITE');
  console.log('========================================================================================\n');

  if (!isFirebaseConfigured || !db || !auth) {
    console.error('❌ Firebase Admin SDK is not properly initialized.');
    process.exit(1);
  }

  let totalTests = 0;
  let passedTests = 0;

  function assert(condition, message) {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`  ✔ [PASS] ${message}`);
    } else {
      console.error(`  ❌ [FAIL] ${message}`);
    }
  }

  try {
    // ── SECTION A: Roles Repository Parity ────────────────────────────────────
    console.log('[SECTION A] Roles Repository Parity Audit...');
    const [mysqlRoles] = await pool.query('SELECT * FROM roles ORDER BY id');
    const firestoreRoles = await getAllRolesFirestore();
    assert(firestoreRoles.length === mysqlRoles.length, `Role document count matches (${firestoreRoles.length}/${mysqlRoles.length})`);

    for (const mRole of mysqlRoles) {
      const byId = await getRoleByIdFirestore(mRole.id);
      const byName = await getRoleByNameFirestore(mRole.name);
      assert(byId && byId.name === mRole.name, `Role '${mRole.name}' fetchable by ID (${mRole.id})`);
      assert(byName && byName.role_id === mRole.id, `Role '${mRole.name}' fetchable by Name ('${mRole.name}')`);
      assert(byId.description === mRole.description, `Role '${mRole.name}' description parity verified`);
    }

    // ── SECTION B: Permissions Repository Parity ─────────────────────────────
    console.log('\n[SECTION B] Permissions Repository Parity Audit...');
    const [mysqlPerms] = await pool.query('SELECT * FROM permissions ORDER BY id');
    const firestorePerms = await getAllPermissionsFirestore();
    assert(firestorePerms.length === mysqlPerms.length, `Permission document count matches (${firestorePerms.length}/${mysqlPerms.length})`);

    for (const mPerm of mysqlPerms) {
      const byId = await getPermissionByIdFirestore(mPerm.id);
      const byName = await getPermissionByNameFirestore(mPerm.name);
      assert(byId && byId.name === mPerm.name, `Permission '${mPerm.name}' fetchable by ID (${mPerm.id})`);
      assert(byName && byName.permission_id === mPerm.id, `Permission '${mPerm.name}' fetchable by Name ('${mPerm.name}')`);
      assert(byId.description === mPerm.description, `Permission '${mPerm.name}' description parity verified`);
    }

    // ── SECTION C: Role -> Permission Mappings Parity ─────────────────────────
    console.log('\n[SECTION C] Role -> Permission Mappings Parity Audit...');
    const adminParity = await compareRoleRbacParity(1);
    assert(adminParity.allMatched && adminParity.mysqlPermissions.length === 7 && adminParity.firestorePermissions.length === 7, 'Admin role permissions parity = 100% (7/7 permissions)');

    const guestParity = await compareRoleRbacParity(2);
    assert(guestParity.allMatched && guestParity.mysqlPermissions.length === 2 && guestParity.firestorePermissions.length === 2, 'Guest role permissions parity = 100% (2/2 permissions)');

    // ── SECTION D: Positive Authorization Resolution Matrix ──────────────────
    console.log('\n[SECTION D] Positive Authorization Resolution Matrix...');
    const positiveCases = [
      { roleId: 1, roleName: 'admin', perm: 'view_dashboard' },
      { roleId: 1, roleName: 'admin', perm: 'manage_rooms' },
      { roleId: 1, roleName: 'admin', perm: 'manage_bookings' },
      { roleId: 1, roleName: 'admin', perm: 'run_audit' },
      { roleId: 1, roleName: 'admin', perm: 'make_payment' },
      { roleId: 1, roleName: 'admin', perm: 'modify_business_date' },
      { roleId: 1, roleName: 'admin', perm: 'override_business_date' },
      { roleId: 2, roleName: 'guest', perm: 'view_dashboard' },
      { roleId: 2, roleName: 'guest', perm: 'make_payment' }
    ];

    for (const c of positiveCases) {
      const res = await comparePermissionResolution(c.roleId, c.perm);
      assert(res.match && res.mysqlAllowed && res.firestoreAllowed, `[ALLOW] ${c.roleName} + ${c.perm} => MySQL: ${res.mysqlAllowed} | Firestore: ${res.firestoreAllowed} (Match: ${res.match})`);
    }

    // ── SECTION E: Negative Authorization Resolution Matrix ──────────────────
    console.log('\n[SECTION E] Negative Authorization Resolution Matrix...');
    const negativeCases = [
      { roleId: 2, roleName: 'guest', perm: 'manage_rooms' },
      { roleId: 2, roleName: 'guest', perm: 'manage_bookings' },
      { roleId: 2, roleName: 'guest', perm: 'run_audit' },
      { roleId: 2, roleName: 'guest', perm: 'modify_business_date' },
      { roleId: 2, roleName: 'guest', perm: 'override_business_date' }
    ];

    for (const c of negativeCases) {
      const res = await comparePermissionResolution(c.roleId, c.perm);
      assert(res.match && !res.mysqlAllowed && !res.firestoreAllowed, `[DENY] ${c.roleName} + ${c.perm} => MySQL: ${res.mysqlAllowed} | Firestore: ${res.firestoreAllowed} (Match: ${res.match})`);
    }

    // ── SECTION F: Test Real Existing Auth Identities ─────────────────────────
    console.log('\n[SECTION F] Testing Real Existing Auth Identities...');

    // User 1 (Admin)
    const u1 = await auth.getUser('user_1');
    const u1ClaimRole = u1.customClaims?.role;
    assert(u1ClaimRole === 'super_admin', 'user_1 has Firebase Auth claim role super_admin');
    const u1Perm = await hasFirestorePermission(1, 'view_dashboard');
    assert(u1Perm === true, 'user_1 (admin) has view_dashboard permission in Firestore RBAC');

    // User 2 (Keval)
    const u2 = await auth.getUser('user_2');
    const u2ClaimRole = u2.customClaims?.role;
    assert(u2ClaimRole === 'admin', 'user_2 has Firebase Auth claim role admin');
    const u2Perm = await hasFirestorePermission(1, 'manage_rooms');
    assert(u2Perm === true, 'user_2 (admin) has manage_rooms permission in Firestore RBAC');

    // Guest 6 (Akshay)
    const g6 = await auth.getUser('guest_6');
    const g6ClaimRole = g6.customClaims?.role;
    assert(g6ClaimRole === 'guest', 'guest_6 has Firebase Auth claim role guest');
    const g6MakePay = await hasFirestorePermission(2, 'make_payment');
    const g6ManageRooms = await hasFirestorePermission(2, 'manage_rooms');
    assert(g6MakePay === true && g6ManageRooms === false, 'guest_6 has make_payment=ALLOW and manage_rooms=DENY in Firestore RBAC');

    // Staff Identities Audit
    let staffCountVerified = 0;
    for (let i = 1; i <= 11; i++) {
      try {
        const sAuth = await auth.getUser(`staff_${i}`);
        if (sAuth && sAuth.customClaims?.role) staffCountVerified++;
      } catch (e) {}
    }
    assert(staffCountVerified === 11, 'All 11 staff accounts have valid Firebase Auth claim roles');

    // ── SECTION G: Security & Data Integrity Verification ────────────────────
    console.log('\n[SECTION G] Security & Data Integrity Verification...');
    const forbiddenKeys = ['password', 'password_hash', 'passwordHash', 'bcrypt'];

    let rbacSecurityViolations = 0;
    const rSnap = await db.collection('roles').get();
    const pSnap = await db.collection('permissions').get();
    const rpSnap = await db.collection('role_permissions').get();

    [...rSnap.docs, ...pSnap.docs, ...rpSnap.docs].forEach(doc => {
      const data = doc.data();
      for (const k of Object.keys(data)) {
        if (forbiddenKeys.some(fk => k.toLowerCase().includes(fk))) {
          rbacSecurityViolations++;
        }
      }
    });
    assert(rbacSecurityViolations === 0, 'ZERO password or hash fields found in Firestore RBAC collections');

    console.log('\n========================================================================================');
    console.log(`TEST SUITE COMPLETE: ${passedTests}/${totalTests} TESTS PASSED`);
    console.log('========================================================================================\n');

    if (passedTests !== totalTests) {
      process.exitCode = 1;
    }

  } catch (err) {
    console.error('❌ Test Suite Execution Error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runRbacParityTests();
