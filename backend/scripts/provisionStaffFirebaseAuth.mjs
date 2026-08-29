/**
 * provisionStaffFirebaseAuth.mjs — HPMS Phase 3 Step 3A
 * =========================================================================
 * Idempotent Staff Firebase Auth Provisioning & Claims Synchronization Script
 *
 * SAFETY INVARIANTS:
 *  - READ-ONLY towards MySQL: Does NOT insert, update, or delete MySQL data.
 *  - Does NOT alter legacy JWT or login behavior.
 *  - Does NOT copy or inspect password hashes into Firebase.
 *  - Preserves unrelated existing Firebase Custom Claims.
 *  - Idempotent: safe to run multiple times.
 *
 * USAGE:
 *   node backend/scripts/provisionStaffFirebaseAuth.mjs --dry-run
 *   node backend/scripts/provisionStaffFirebaseAuth.mjs --execute
 */

import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure backend .env is loaded
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { auth, db, isFirebaseConfigured } from '../config/firebaseAdmin.js';
import {
  getStaffByIdFirestore,
  createStaffFirestore,
  updateStaffFirestore
} from '../repositories/firestore/staffRepository.js';

/**
 * Finds an existing Firebase Auth user for a staff member by:
 *  1. UID: staff_<username>
 *  2. UID: staff_<mysql_id>
 *  3. Email: staff.email
 *
 * @param {object} authInstance Firebase Admin Auth instance
 * @param {object} staff Staff record from MySQL
 * @returns {Promise<object|null>} Firebase Auth user record or null
 */
export async function findExistingFirebaseAuthUser(authInstance, staff) {
  if (!authInstance || !staff) return null;

  // 1. Try UID: staff_<username>
  if (staff.username) {
    try {
      const user = await authInstance.getUser(`staff_${String(staff.username).toLowerCase().trim()}`);
      if (user) return user;
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
    }
  }

  // 2. Try UID: staff_<id>
  if (staff.id !== undefined && staff.id !== null) {
    try {
      const user = await authInstance.getUser(`staff_${staff.id}`);
      if (user) return user;
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
    }
  }

  // 3. Try Email lookup
  if (staff.email) {
    try {
      const user = await authInstance.getUserByEmail(String(staff.email).toLowerCase().trim());
      if (user) return user;
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
    }
  }

  return null;
}

/**
 * Computes the target custom claims merged with existing claims.
 * Preserves any unrelated existing custom claims.
 *
 * @param {object} existingClaims Current claims on Firebase user
 * @param {object} staff Staff member record
 * @returns {{ mergedClaims: object, needsUpdate: boolean }}
 */
export function computeStaffCustomClaims(existingClaims = {}, staff) {
  const requiredClaims = {
    role: staff.role,
    user_type: 'staff',
    mysql_id: Number(staff.id),
    mysql_staff_id: Number(staff.id),
    staff_username: String(staff.username).toLowerCase().trim(),
    status: staff.status || 'Active',
    deleted: staff.deleted ? 1 : 0
  };

  const mergedClaims = {
    ...existingClaims,
    ...requiredClaims
  };

  let needsUpdate = false;
  for (const [k, v] of Object.entries(requiredClaims)) {
    if (existingClaims[k] !== v) {
      needsUpdate = true;
      break;
    }
  }

  return { mergedClaims, needsUpdate };
}

/**
 * Provisions or synchronizes a single staff member.
 *
 * @param {object} staff MySQL staff record
 * @param {object} options
 * @returns {Promise<object>} Result record
 */
export async function provisionSingleStaff(staff, {
  authInstance = auth,
  dbInstance = db,
  dryRun = false,
  getStaffFn = getStaffByIdFirestore,
  createStaffFn = createStaffFirestore,
  updateStaffFn = updateStaffFirestore
} = {}) {
  const result = {
    username: staff.username,
    mysql_id: staff.id,
    firebase_uid: `staff_${String(staff.username).toLowerCase().trim()}`,
    auth_exists: false,
    auth_created: false,
    claims_updated: false,
    firestore_exists: false,
    firestore_synced: false,
    status: 'PENDING',
    details: ''
  };

  // Check active/deleted status
  const isInactive = staff.status === 'Inactive';
  const isDeleted = Boolean(staff.deleted === 1 || staff.deleted === true);

  if (isInactive || isDeleted) {
    result.status = 'SKIPPED';
    result.details = `Staff is ${isDeleted ? 'deleted' : 'inactive'} in MySQL`;
    return result;
  }

  try {
    // 1. Firebase Auth user check / creation
    let authUser = await findExistingFirebaseAuthUser(authInstance, staff);

    if (authUser) {
      result.auth_exists = true;
      result.firebase_uid = authUser.uid;
    } else {
      result.auth_exists = false;
      if (!dryRun) {
        const tempPassword = crypto.randomBytes(16).toString('hex') + 'Aa1!';
        authUser = await authInstance.createUser({
          uid: result.firebase_uid,
          email: String(staff.email).toLowerCase().trim(),
          displayName: staff.full_name || staff.username,
          password: tempPassword,
          emailVerified: true
        });
        result.auth_created = true;
        result.firebase_uid = authUser.uid;
      } else {
        result.details = '(dry-run: would create auth user)';
      }
    }

    // 2. Firebase Custom Claims
    const currentClaims = authUser?.customClaims || {};
    const { mergedClaims, needsUpdate } = computeStaffCustomClaims(currentClaims, staff);

    if (needsUpdate) {
      if (!dryRun && authUser) {
        await authInstance.setCustomUserClaims(authUser.uid, mergedClaims);
        result.claims_updated = true;
      } else if (dryRun) {
        result.claims_updated = true; // Would update
      }
    } else {
      result.claims_updated = false;
    }

    // 3. Firestore Staff Document Sync
    const docId = `staff_${String(staff.username).toLowerCase().trim()}`;
    let existingDoc = null;
    let fsError = null;

    if (dbInstance) {
      try {
        existingDoc = await getStaffFn(docId);
        if (existingDoc) {
          result.firestore_exists = true;
        }
      } catch (err) {
        if (err.code === 8 || err.message?.includes('Quota') || err.message?.includes('RESOURCE_EXHAUSTED')) {
          fsError = 'Firestore quota exceeded (read skipped)';
        } else {
          fsError = `Firestore read warning: ${err.message}`;
        }
      }

      if (!dryRun && !fsError) {
        const staffPayload = {
          id: staff.id,
          mysql_staff_id: staff.id,
          user_uid: result.firebase_uid,
          username: String(staff.username).toLowerCase().trim(),
          full_name: String(staff.full_name || staff.username).trim(),
          email: staff.email ? String(staff.email).toLowerCase().trim() : null,
          phone: staff.phone || null,
          role: String(staff.role).toLowerCase().trim(),
          department: staff.department || 'Front Office',
          shift: staff.shift || 'Morning',
          status: staff.status || 'Active',
          deleted: staff.deleted ? 1 : 0,
          created_at: staff.created_at ? new Date(staff.created_at).toISOString() : new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        try {
          if (existingDoc) {
            await updateStaffFn(docId, staffPayload);
            result.firestore_synced = true;
          } else {
            await createStaffFn(staffPayload);
            result.firestore_synced = true;
          }
        } catch (err) {
          if (err.code === 8 || err.message?.includes('Quota') || err.message?.includes('RESOURCE_EXHAUSTED')) {
            fsError = 'Firestore quota exceeded (write skipped)';
          } else {
            fsError = `Firestore write warning: ${err.message}`;
          }
        }
      }
    }

    // Determine final status
    if (result.auth_created) {
      result.status = dryRun ? 'WOULD_PROVISION' : 'PROVISIONED';
    } else if (result.claims_updated) {
      result.status = dryRun ? 'WOULD_UPDATE_CLAIMS' : 'CLAIMS_UPDATED';
    } else {
      result.status = 'VERIFIED_OK';
    }

    if (fsError) {
      result.details = result.details ? `${result.details}; ${fsError}` : fsError;
    }
  } catch (error) {
    result.status = 'ERROR';
    result.details = error.message;
  }

  return result;
}

/**
 * Runs the full staff provisioning flow from MySQL.
 *
 * @param {object} options
 * @returns {Promise<object>} Summary results
 */
export async function runStaffProvisioning({
  pool = null,
  authInstance = auth,
  dbInstance = db,
  dryRun = false,
  getStaffFn = getStaffByIdFirestore,
  createStaffFn = createStaffFirestore,
  updateStaffFn = updateStaffFirestore
} = {}) {
  let localPool = pool;
  let shouldClosePool = false;

  if (!localPool) {
    localPool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'hotel_pms',
      port: parseInt(process.env.DB_PORT || '3306'),
      waitForConnections: true,
      connectionLimit: 5
    });
    shouldClosePool = true;
  }

  console.log('\n========================================================================');
  console.log(`  HPMS Phase 3 Step 3A — Staff Firebase Auth Provisioning [${dryRun ? 'DRY-RUN' : 'EXECUTE'}]`);
  console.log('========================================================================\n');

  try {
    // 1. Fetch all staff records from MySQL (Read-Only)
    const [staffRows] = await localPool.query(
      `SELECT id, full_name, username, email, role, department, shift, phone, status, deleted, created_at, updated_at
       FROM staff
       ORDER BY id ASC`
    );

    console.log(`Discovered ${staffRows.length} total staff records in MySQL.\n`);

    const results = [];
    let provisionedCount = 0;
    let existingAuthCount = 0;
    let claimsUpdatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const staff of staffRows) {
      const res = await provisionSingleStaff(staff, {
        authInstance,
        dbInstance,
        dryRun,
        getStaffFn,
        createStaffFn,
        updateStaffFn
      });

      results.push(res);

      if (res.status === 'SKIPPED') skippedCount++;
      else if (res.status === 'ERROR') errorCount++;
      else {
        if (res.auth_created || res.status === 'WOULD_PROVISION') provisionedCount++;
        if (res.auth_exists) existingAuthCount++;
        if (res.claims_updated) claimsUpdatedCount++;
      }
    }

    // 2. Print Reconciliation Table
    console.log('--- RECONCILIATION TABLE ---');
    console.log('-------------------------------------------------------------------------------------------------------------------------');
    console.log(
      'username'.padEnd(20) + ' | ' +
      'mysql_id'.padEnd(8) + ' | ' +
      'firebase_uid'.padEnd(22) + ' | ' +
      'auth_exists'.padEnd(11) + ' | ' +
      'claims_upd'.padEnd(10) + ' | ' +
      'fs_exists'.padEnd(9) + ' | ' +
      'status'.padEnd(16)
    );
    console.log('-------------------------------------------------------------------------------------------------------------------------');

    for (const r of results) {
      console.log(
        String(r.username).padEnd(20) + ' | ' +
        String(r.mysql_id).padEnd(8) + ' | ' +
        String(r.firebase_uid).padEnd(22) + ' | ' +
        String(r.auth_exists).padEnd(11) + ' | ' +
        String(r.claims_updated).padEnd(10) + ' | ' +
        String(r.firestore_exists).padEnd(9) + ' | ' +
        String(r.status).padEnd(16)
      );
      if (r.details) {
        console.log(`  └─ Details: ${r.details}`);
      }
    }
    console.log('-------------------------------------------------------------------------------------------------------------------------\n');

    const summary = {
      totalDiscovered: staffRows.length,
      activeProcessed: staffRows.length - skippedCount,
      skippedCount,
      existingAuthCount,
      provisionedCount,
      claimsUpdatedCount,
      errorCount,
      results
    };

    console.log('--- SUMMARY ---');
    console.log(`Total Staff in MySQL:    ${summary.totalDiscovered}`);
    console.log(`Skipped (Inactive/Del):  ${summary.skippedCount}`);
    console.log(`Active Processed:        ${summary.activeProcessed}`);
    console.log(`Existing in Auth:        ${summary.existingAuthCount}`);
    console.log(`Newly Provisioned:       ${summary.provisionedCount}`);
    console.log(`Claims Updated:          ${summary.claimsUpdatedCount}`);
    console.log(`Errors:                  ${summary.errorCount}`);
    console.log(`Execution Mode:          ${dryRun ? 'DRY-RUN (no mutations made)' : 'EXECUTE (mutations applied)'}`);
    console.log('========================================================================\n');

    return summary;
  } finally {
    if (shouldClosePool && localPool) {
      await localPool.end();
    }
  }
}

// ── CLI Execution Entry Point ────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const isExecute = args.includes('--execute');

  if (!isDryRun && !isExecute) {
    console.log(`
HPMS Phase 3 Step 3A — Staff Firebase Auth Provisioning Script
========================================================================
Usage:
  node backend/scripts/provisionStaffFirebaseAuth.mjs --dry-run
  node backend/scripts/provisionStaffFirebaseAuth.mjs --execute

Flags:
  --dry-run   Preview operations without writing to Firebase Auth or Firestore
  --execute   Execute provisioning, create missing auth users, update custom claims
`);
    process.exit(0);
  }

  if (!isFirebaseConfigured || !auth) {
    console.error('[FATAL] Firebase Admin SDK is not properly configured. Check .env variables.');
    process.exit(1);
  }

  runStaffProvisioning({ dryRun: isDryRun })
    .then((summary) => {
      if (summary.errorCount > 0) {
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('[FATAL] Script failed with error:', err);
      process.exit(1);
    });
}
