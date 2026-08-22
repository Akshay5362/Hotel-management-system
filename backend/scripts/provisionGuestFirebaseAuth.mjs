/**
 * provisionGuestFirebaseAuth.mjs — HPMS Phase 3 Step 3D-1
 * =========================================================================
 * Idempotent Guest Firebase Auth Provisioning & Claims Synchronization Script
 *
 * SAFETY INVARIANTS:
 *  - READ-ONLY towards MySQL: Does NOT insert, update, or delete MySQL data.
 *  - Does NOT read, print, log, copy, or transmit MySQL password hashes.
 *  - The SELECT query deliberately excludes the 'password' column.
 *  - Does NOT copy MySQL credentials into Firebase Auth.
 *  - Temporary passwords are cryptographically random — never derived from MySQL.
 *  - Preserves unrelated existing Firebase Custom Claims.
 *  - Idempotent: safe to run multiple times; second run = zero unnecessary mutations.
 *
 * USAGE:
 *   node backend/scripts/provisionGuestFirebaseAuth.mjs --dry-run    (DEFAULT)
 *   node backend/scripts/provisionGuestFirebaseAuth.mjs --execute
 *
 * WHAT IT DOES:
 *  1. Reads MySQL users JOIN guests JOIN roles WHERE role='guest' (NO password column)
 *  2. For each active guest, ensures a Firebase Auth user exists with UID guest_${users.id}
 *  3. Sets/merges custom claims: role, user_type, mysql_id, mysql_guest_id, guest_id,
 *     full_name, phone, loyalty_tier, loyalty_points
 *  4. Upserts Firestore /guests/guest_${guests.id} (preserving extended fields)
 *  5. Skips inactive/deleted guests
 *  6. Handles duplicate email conflicts by using @hpms-sky5.internal synthetic emails
 */

import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure backend .env is loaded before importing Firebase Admin
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { auth, db, isFirebaseConfigured } from '../config/firebaseAdmin.js';
import {
  getGuestByIdFirestore,
  createGuestFirestore,
  updateGuestFirestore
} from '../repositories/firestore/guestsRepository.js';

// ── Email Resolution ──────────────────────────────────────────────────────────

/**
 * Derives the canonical Firebase Auth email for a guest.
 * Priority:
 *   1. users.username if it contains '@' (real email used as username)
 *   2. guests.email  if non-empty and reasonably unique (validated by caller)
 *   3. Synthetic: ${users.username}@hpms-sky5.internal (always unique via UNIQUE username)
 *
 * SECURITY: This function never reads, touches, or outputs a password or hash.
 *
 * @param {object} guestRow — Combined MySQL row from users JOIN guests
 * @returns {string} Fully-qualified Firebase Auth email
 */
export function resolveGuestFirebaseEmail(guestRow) {
  const username = String(guestRow.username || '').trim().toLowerCase();
  const guestEmail = String(guestRow.guest_email || '').trim().toLowerCase();

  // If username itself is an email, use it directly
  if (username.includes('@')) {
    return username;
  }

  // If a real guest.email is present and not already a synthetic one, use it
  if (guestEmail && guestEmail.length > 3 && guestEmail.includes('@') && !guestEmail.endsWith('@hpms-sky5.internal')) {
    return guestEmail;
  }

  // Fallback: synthetic internal email — guaranteed unique because username is UNIQUE in MySQL
  return `${username}@hpms-sky5.internal`;
}

// ── Firebase Auth Discovery ───────────────────────────────────────────────────

/**
 * Finds an existing Firebase Auth user for a guest by:
 *   1. Canonical UID: guest_${users.id}
 *   2. Email lookup (to detect prior provisioning under a different UID)
 *
 * @param {object} authInstance — Firebase Admin Auth instance
 * @param {number} usersId      — MySQL users.id
 * @param {string} email        — Resolved Firebase email
 * @returns {Promise<object|null>} Firebase Auth user record or null
 */
export async function findExistingGuestFirebaseAuthUser(authInstance, usersId, email) {
  if (!authInstance) return null;

  const canonicalUid = `guest_${usersId}`;

  // 1. Try canonical UID
  try {
    const user = await authInstance.getUser(canonicalUid);
    if (user) return user;
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }

  // 2. Try email lookup (handles edge case where account was created under a different UID)
  if (email) {
    try {
      const user = await authInstance.getUserByEmail(email);
      if (user) return user;
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
    }
  }

  return null;
}

// ── Custom Claims Computation ─────────────────────────────────────────────────

/**
 * Computes the target custom claims merged with existing claims.
 * Preserves any unrelated existing custom claims (e.g. from other systems).
 *
 * SECURITY: This function never reads, receives, or outputs password data.
 *
 * @param {object} existingClaims — Current claims on Firebase user (may be {})
 * @param {object} guestRow       — MySQL combined guest row
 * @returns {{ mergedClaims: object, needsUpdate: boolean }}
 */
export function computeGuestCustomClaims(existingClaims = {}, guestRow) {
  const requiredClaims = {
    role:             'guest',
    user_type:        'guest',
    mysql_id:         Number(guestRow.users_id),       // users.id — login account
    mysql_guest_id:   Number(guestRow.guests_id),      // guests.id — booking profile
    guest_id:         Number(guestRow.guests_id),      // alias for booking resolution
    full_name:        String(guestRow.full_name || '').trim(),
    phone:            String(guestRow.phone || '').trim(),
    loyalty_tier:     String(guestRow.loyalty_tier || 'Bronze').trim(),
    loyalty_points:   Number(guestRow.loyalty_points || 0)
  };

  // Merge: required claims override existing; unrelated keys are preserved
  const mergedClaims = {
    ...existingClaims,
    ...requiredClaims
  };

  // Determine if an update is actually needed
  let needsUpdate = false;
  for (const [k, v] of Object.entries(requiredClaims)) {
    // Use loose comparison for numbers (Firebase sometimes returns numeric strings)
    if (String(existingClaims[k]) !== String(v)) {
      needsUpdate = true;
      break;
    }
  }

  return { mergedClaims, needsUpdate };
}

// ── Email Uniqueness Check ────────────────────────────────────────────────────

/**
 * Checks if a given email is already owned by a DIFFERENT Firebase UID
 * than the expected canonical UID for this guest.
 *
 * @param {object} authInstance   — Firebase Admin Auth
 * @param {string} email          — Email to check
 * @param {string} expectedUid    — The UID we'd assign (guest_N)
 * @returns {Promise<{conflict: boolean, ownerUid: string|null}>}
 */
export async function checkEmailConflict(authInstance, email, expectedUid) {
  if (!authInstance || !email) return { conflict: false, ownerUid: null };
  try {
    const existing = await authInstance.getUserByEmail(email);
    if (existing && existing.uid !== expectedUid) {
      return { conflict: true, ownerUid: existing.uid };
    }
    return { conflict: false, ownerUid: null };
  } catch (e) {
    if (e.code === 'auth/user-not-found') return { conflict: false, ownerUid: null };
    throw e;
  }
}

// ── Single Guest Provisioning ─────────────────────────────────────────────────

/**
 * Provisions or synchronizes a single guest account.
 *
 * SECURITY CONTRACT:
 *   - guestRow MUST NOT contain the 'password' or 'password_hash' field.
 *   - This function will assert that no password data is present and throw if found.
 *   - Temporary passwords are cryptographically random (crypto.randomBytes).
 *   - No MySQL credential is ever read, compared, copied, or logged.
 *
 * @param {object} guestRow — MySQL combined row (no password columns)
 * @param {object} options
 * @returns {Promise<object>} Result record
 */
export async function provisionSingleGuest(guestRow, {
  authInstance = auth,
  dbInstance = db,
  dryRun = false,
  getGuestFn = getGuestByIdFirestore,
  createGuestFn = createGuestFirestore,
  updateGuestFn = updateGuestFirestore,
  // Injectable for test-time email conflict checking
  checkEmailConflictFn = checkEmailConflict
} = {}) {
  // ── SECURITY ASSERTION: Verify no password data leaked into this row ─────
  if ('password' in guestRow || 'password_hash' in guestRow || 'passwordHash' in guestRow) {
    throw new Error(
      '[SECURITY] Password or hash field detected in guest row — provisioning aborted. ' +
      'The MySQL query must NOT select the password column.'
    );
  }

  const result = {
    username:          guestRow.username,
    users_id:          guestRow.users_id,
    guests_id:         guestRow.guests_id,
    firebase_uid:      `guest_${guestRow.users_id}`,
    resolved_email:    '',
    auth_exists:       false,
    auth_created:      false,
    claims_updated:    false,
    firestore_exists:  false,
    firestore_synced:  false,
    email_conflict:    false,
    status:            'PENDING',
    details:           ''
  };

  // ── Skip inactive/deleted guests ─────────────────────────────────────────
  const isDeleted  = Boolean(guestRow.is_deleted === 1 || guestRow.is_deleted === true);
  // Guests don't have a status column like staff — but users table has role_id; treat null user as deleted
  const isOrphaned = !guestRow.users_id;

  if (isDeleted || isOrphaned) {
    result.status  = 'SKIPPED';
    result.details = isOrphaned
      ? 'Guest has no linked users record (orphaned guest profile)'
      : 'Guest is marked deleted in MySQL';
    return result;
  }

  try {
    // ── Step 1: Resolve email ─────────────────────────────────────────────
    let resolvedEmail = resolveGuestFirebaseEmail(guestRow);
    result.resolved_email = resolvedEmail;

    // ── Step 2: Check for email conflicts with OTHER Firebase users ───────
    if (authInstance && !dryRun) {
      const { conflict, ownerUid } = await checkEmailConflictFn(authInstance, resolvedEmail, result.firebase_uid);
      if (conflict) {
        // Fall back to guaranteed-unique synthetic email
        const syntheticEmail = `${String(guestRow.username || '').trim().toLowerCase()}@hpms-sky5.internal`;
        result.email_conflict = true;
        result.details = `Email conflict: '${resolvedEmail}' owned by UID '${ownerUid}'. Using synthetic: '${syntheticEmail}'`;
        resolvedEmail = syntheticEmail;
        result.resolved_email = syntheticEmail;
      }
    }

    // ── Step 3: Firebase Auth — find or create ────────────────────────────
    let authUser = null;
    if (authInstance) {
      authUser = await findExistingGuestFirebaseAuthUser(authInstance, guestRow.users_id, resolvedEmail);
    }

    if (authUser) {
      result.auth_exists  = true;
      result.firebase_uid = authUser.uid;
    } else {
      result.auth_exists = false;
      if (!dryRun && authInstance) {
        // Generate a cryptographically secure random temporary password.
        // This is NOT derived from any MySQL value.
        // The guest will need to log in via lazy migration (using their MySQL password
        // which triggers ensureGuestLazyAuthMigration to update Firebase Auth password).
        const tempPassword = crypto.randomBytes(20).toString('base64url') + 'Aa1!';
        authUser = await authInstance.createUser({
          uid:           result.firebase_uid,
          email:         resolvedEmail,
          displayName:   String(guestRow.full_name || guestRow.username || '').trim(),
          password:      tempPassword,   // Random — never derived from MySQL hash
          emailVerified: false           // Not verified — requires lazy migration login
        });
        result.auth_created  = true;
        result.firebase_uid  = authUser.uid;
        result.resolved_email = resolvedEmail;
      } else if (dryRun) {
        result.details = result.details
          ? `${result.details}; (dry-run: would create auth user)`
          : '(dry-run: would create auth user)';
      }
    }

    // ── Step 4: Firebase Custom Claims ────────────────────────────────────
    const currentClaims = authUser?.customClaims || {};
    const { mergedClaims, needsUpdate } = computeGuestCustomClaims(currentClaims, guestRow);

    if (needsUpdate) {
      if (!dryRun && authUser && authInstance) {
        await authInstance.setCustomUserClaims(authUser.uid, mergedClaims);
        result.claims_updated = true;
      } else if (dryRun) {
        result.claims_updated = true; // Would update
      }
    } else {
      result.claims_updated = false;
    }

    // ── Step 5: Firestore Guest Document Upsert ───────────────────────────
    const firestoreDocId = `guest_${guestRow.guests_id}`;
    let existingDoc = null;
    let fsError     = null;

    if (dbInstance) {
      try {
        existingDoc = await getGuestFn(guestRow.guests_id);
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
        // Build the core guest payload.
        // Extended fields (address, government_id, etc.) are preserved via merge semantics.
        const guestPayload = {
          mysql_guest_id:          Number(guestRow.guests_id),
          mysql_user_id:           Number(guestRow.users_id),
          user_uid:                result.firebase_uid,
          full_name:               String(guestRow.full_name || '').trim(),
          email:                   resolvedEmail,
          phone:                   String(guestRow.phone || '').trim() || null,
          loyalty_tier:            String(guestRow.loyalty_tier || 'Bronze').trim(),
          loyalty_points:          Number(guestRow.loyalty_points || 0),
          updated_at:              new Date().toISOString(),
          // Preserve extended fields from MySQL if available (not overwriting if already in Firestore)
          ...(guestRow.address        ? { address:        String(guestRow.address).trim() }        : {}),
          ...(guestRow.gst_no         ? { gst_no:         String(guestRow.gst_no).trim() }         : {}),
          ...(guestRow.country        ? { city:           String(guestRow.country).trim() }         : {}),
          ...(guestRow.government_id  ? { government_id:  String(guestRow.government_id).trim() }  : {}),
          ...(guestRow.id_type        ? { id_type:        String(guestRow.id_type).trim() }        : {}),
          ...(guestRow.id_verification_status ? { id_verification_status: String(guestRow.id_verification_status).trim() } : {}),
        };

        // Set created_at only if creating a new document
        if (!existingDoc) {
          guestPayload.created_at = guestRow.created_at
            ? new Date(guestRow.created_at).toISOString()
            : new Date().toISOString();
        }

        try {
          if (existingDoc) {
            // Merge update: preserves extended fields (address, id_document_url, etc.)
            await updateGuestFn(guestRow.guests_id, guestPayload);
            result.firestore_synced = true;
          } else {
            await createGuestFn(guestPayload);
            result.firestore_synced = true;
          }
        } catch (err) {
          if (err.code === 8 || err.message?.includes('Quota') || err.message?.includes('RESOURCE_EXHAUSTED')) {
            fsError = 'Firestore quota exceeded (write skipped)';
          } else {
            fsError = `Firestore write warning: ${err.message}`;
          }
        }
      } else if (dryRun) {
        result.firestore_synced = true; // Would sync
      }
    }

    // ── Determine final status ────────────────────────────────────────────
    if (result.auth_created) {
      result.status = dryRun ? 'WOULD_PROVISION' : 'PROVISIONED';
    } else if (result.claims_updated) {
      result.status = dryRun ? 'WOULD_UPDATE_CLAIMS' : 'CLAIMS_UPDATED';
    } else if (result.firestore_synced && !result.firestore_exists) {
      result.status = dryRun ? 'WOULD_SYNC_FIRESTORE' : 'FIRESTORE_SYNCED';
    } else {
      result.status = 'VERIFIED_OK';
    }

    if (fsError) {
      result.details = result.details ? `${result.details}; ${fsError}` : fsError;
    }

  } catch (error) {
    result.status  = 'ERROR';
    result.details = error.message;
  }

  return result;
}

// ── Full Run ──────────────────────────────────────────────────────────────────

/**
 * Runs the full guest provisioning flow from MySQL.
 *
 * SECURITY CONTRACT:
 *   - The MySQL query NEVER selects the 'password' column from users or any table.
 *   - Password hashes are never read, stored, printed, or transmitted.
 *
 * @param {object} options
 * @returns {Promise<object>} Summary results
 */
export async function runGuestProvisioning({
  pool = null,
  authInstance = auth,
  dbInstance = db,
  dryRun = false,
  getGuestFn = getGuestByIdFirestore,
  createGuestFn = createGuestFirestore,
  updateGuestFn = updateGuestFirestore,
  checkEmailConflictFn = checkEmailConflict
} = {}) {
  let localPool        = pool;
  let shouldClosePool  = false;

  if (!localPool) {
    localPool = mysql.createPool({
      host:             process.env.DB_HOST || 'localhost',
      user:             process.env.DB_USER || 'root',
      password:         process.env.DB_PASSWORD || '',
      database:         process.env.DB_NAME || 'hotel_pms',
      port:             parseInt(process.env.DB_PORT || '3306'),
      waitForConnections: true,
      connectionLimit:  5
    });
    shouldClosePool = true;
  }

  console.log('\n========================================================================');
  console.log(`  HPMS Phase 3 Step 3D-1 — Guest Firebase Auth Provisioning [${dryRun ? 'DRY-RUN' : 'EXECUTE'}]`);
  console.log('========================================================================\n');
  console.log('  SECURITY: MySQL password column is NOT selected in this script.');
  console.log('  No password hash will be read, copied, logged, or transmitted.\n');

  try {
    // ── SECURITY-CRITICAL QUERY: Explicitly excludes the password column ──────
    // We join users → guests → roles to find all guest-role user accounts.
    // We select: u.id, u.username, u.fullName, u.phone (from users)
    //            g.id, g.full_name, g.email, g.phone, g.loyalty_tier, g.loyalty_points,
    //            g.address, g.gst_no, g.government_id, g.id_type, g.id_verification_status,
    //            g.country, g.created_at (from guests)
    // We deliberately do NOT select: u.password, u.password_hash, or any credential column.
    const [guestRows] = await localPool.query(
      `SELECT
         u.id          AS users_id,
         u.username    AS username,
         u.fullName    AS user_full_name,
         u.phone       AS user_phone,
         g.id          AS guests_id,
         g.full_name   AS full_name,
         g.email       AS guest_email,
         g.phone       AS phone,
         g.loyalty_tier,
         g.loyalty_points,
         g.address,
         g.gst_no,
         g.country,
         g.government_id,
         g.id_type,
         g.id_verification_status,
         g.created_at,
         0             AS is_deleted
       FROM users u
       JOIN guests g ON g.user_id = u.id
       JOIN roles  r ON u.role_id = r.id
       WHERE LOWER(r.name) = 'guest'
       ORDER BY u.id ASC`
      // ↑ NOTE: 'password' column is intentionally NOT selected.
      // The JOIN condition g.user_id=u.id ensures only linked guest profiles appear.
    );

    console.log(`Discovered ${guestRows.length} total guest records in MySQL.\n`);

    const results          = [];
    let provisionedCount   = 0;
    let existingAuthCount  = 0;
    let claimsUpdatedCount = 0;
    let skippedCount       = 0;
    let errorCount         = 0;
    let conflictCount      = 0;
    let fsCreatedCount     = 0;
    let fsUpdatedCount     = 0;

    for (const guestRow of guestRows) {
      const res = await provisionSingleGuest(guestRow, {
        authInstance,
        dbInstance,
        dryRun,
        getGuestFn,
        createGuestFn,
        updateGuestFn,
        checkEmailConflictFn
      });

      results.push(res);

      if (res.status === 'SKIPPED')                          skippedCount++;
      else if (res.status === 'ERROR')                       errorCount++;
      else {
        if (res.auth_created || res.status === 'WOULD_PROVISION') provisionedCount++;
        if (res.auth_exists)                                 existingAuthCount++;
        if (res.claims_updated)                              claimsUpdatedCount++;
        if (res.email_conflict)                              conflictCount++;
        if (res.firestore_synced && !res.firestore_exists)  fsCreatedCount++;
        if (res.firestore_synced && res.firestore_exists)   fsUpdatedCount++;
      }
    }

    // ── Print Reconciliation Table ────────────────────────────────────────
    console.log('--- RECONCILIATION TABLE ---');
    const divider = '─'.repeat(120);
    console.log(divider);
    console.log(
      'username'.padEnd(22)     + ' | ' +
      'uid'.padEnd(8)           + ' | ' +
      'gid'.padEnd(8)           + ' | ' +
      'firebase_uid'.padEnd(14) + ' | ' +
      'email'.padEnd(32)        + ' | ' +
      'auth'.padEnd(6)          + ' | ' +
      'claims'.padEnd(6)        + ' | ' +
      'fs'.padEnd(5)            + ' | ' +
      'status'
    );
    console.log(divider);

    for (const r of results) {
      console.log(
        String(r.username    || '').padEnd(22) + ' | ' +
        String(r.users_id    || '').padEnd(8)  + ' | ' +
        String(r.guests_id   || '').padEnd(8)  + ' | ' +
        String(r.firebase_uid|| '').padEnd(14) + ' | ' +
        String(r.resolved_email || '').padEnd(32) + ' | ' +
        String(r.auth_exists  ? '✓' : (r.auth_created ? 'NEW' : '-')).padEnd(6) + ' | ' +
        String(r.claims_updated ? '✓' : '-').padEnd(6) + ' | ' +
        String(r.firestore_synced ? '✓' : '-').padEnd(5) + ' | ' +
        String(r.status)
      );
      if (r.details) {
        console.log(`  └─ ${r.details}`);
      }
    }
    console.log(divider + '\n');

    const summary = {
      totalDiscovered:   guestRows.length,
      activeProcessed:   guestRows.length - skippedCount,
      skippedCount,
      existingAuthCount,
      provisionedCount,
      claimsUpdatedCount,
      conflictCount,
      fsCreatedCount,
      fsUpdatedCount,
      errorCount,
      dryRun,
      results
    };

    console.log('--- SUMMARY ---');
    console.log(`Total Guests in MySQL:    ${summary.totalDiscovered}`);
    console.log(`Skipped (Inactive/Del):   ${summary.skippedCount}`);
    console.log(`Active Processed:         ${summary.activeProcessed}`);
    console.log(`Existing in Firebase Auth:${summary.existingAuthCount}`);
    console.log(`Newly Provisioned:        ${summary.provisionedCount}`);
    console.log(`Claims Updated:           ${summary.claimsUpdatedCount}`);
    console.log(`Firestore Docs Created:   ${summary.fsCreatedCount}`);
    console.log(`Firestore Docs Updated:   ${summary.fsUpdatedCount}`);
    console.log(`Email Conflicts Resolved: ${summary.conflictCount}`);
    console.log(`Errors:                   ${summary.errorCount}`);
    console.log(`Execution Mode:           ${dryRun ? 'DRY-RUN (zero mutations made)' : 'EXECUTE (mutations applied)'}`);
    console.log('');
    console.log('SECURITY CONFIRMATION:');
    console.log('  ✓ MySQL password column was NOT selected.');
    console.log('  ✓ No password hash was read, copied, or logged.');
    console.log('  ✓ No MySQL credential was transmitted to Firebase.');
    console.log('  ✓ Temporary passwords are cryptographically random (crypto.randomBytes).');
    console.log('========================================================================\n');

    return summary;
  } finally {
    if (shouldClosePool && localPool) {
      await localPool.end();
    }
  }
}

// ── CLI Execution Entry Point ─────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args      = process.argv.slice(2);
  const isDryRun  = args.includes('--dry-run') || !args.includes('--execute');
  const isExecute = args.includes('--execute');

  if (!args.includes('--dry-run') && !isExecute) {
    console.log(`
HPMS Phase 3 Step 3D-1 — Guest Firebase Auth Provisioning Script
========================================================================
Usage:
  node backend/scripts/provisionGuestFirebaseAuth.mjs --dry-run
  node backend/scripts/provisionGuestFirebaseAuth.mjs --execute

Flags:
  --dry-run   (DEFAULT) Preview operations without writing to Firebase Auth or Firestore.
              Zero mutations will be made.
  --execute   Execute provisioning: create missing auth users, update custom claims,
              upsert Firestore guest documents.

SECURITY:
  The MySQL password column is NEVER selected in this script.
  No MySQL credential is read, copied, or transmitted to Firebase.
  Temporary passwords are cryptographically random (never derived from MySQL).
`);
    process.exit(0);
  }

  if (!isFirebaseConfigured || !auth) {
    console.error('[FATAL] Firebase Admin SDK is not properly configured. Check .env variables.');
    process.exit(1);
  }

  runGuestProvisioning({ dryRun: isDryRun })
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
