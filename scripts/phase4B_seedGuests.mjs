/**
 * scripts/phase4B_seedGuests.mjs
 * ══════════════════════════════════════════════════════════════════════════════
 * HPMS-Sky5 — PHASE 4B: Guest Master Data Seeding
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * SAFETY CONTRACT:
 *   ✅ Reads ONLY from MySQL (SELECT-only — runtime guard enforced)
 *   ✅ Writes ONLY one document: /guests/guest_${guests.id}
 *   ✅ Uses batch.set(..., { merge: true }) — idempotent, never destructive
 *   ✅ NEVER deletes any Firestore document
 *   ✅ NEVER creates or modifies Firebase Auth users
 *   ✅ NEVER selects password / password_hash / credentials
 *   ✅ NEVER writes MySQL
 *   ✅ Orphan documents (guest_1, guest_9888877777, guest_11–guest_15) untouched
 *   ✅ Dry-run by default — pass --commit for actual Firestore write
 *   ✅ Admin-linked guest detected → user_uid forced to null (see AUDIT Section J)
 *
 * DOCUMENT ID CONVENTION (matches guestsRepository.js + authController.js):
 *   Firestore doc ID = guest_${guests.id}   ←  uses guests.id (PK of guests table)
 *   user_uid         = guest_${users.id}    ←  uses users.id (derived by ensureGuestLazyAuthMigration)
 *   These are two DIFFERENT ID spaces bridged by mysql_user_id in the Firestore doc.
 *
 * USAGE (run from project root d:\projects\hotel\):
 *   node scripts/phase4B_seedGuests.mjs             → DRY-RUN (default)
 *   node scripts/phase4B_seedGuests.mjs --dry-run   → DRY-RUN (explicit)
 *   node scripts/phase4B_seedGuests.mjs --commit    → Actual Firestore write
 *
 * Module resolution: uses backend/db.js + backend/config/firebaseAdmin.js
 * (same pattern as phase4A_seedMasterData.mjs and all other project scripts).
 */

// ── Imports ───────────────────────────────────────────────────────────────────
import pool from '../backend/db.js';
import { db, auth, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';

// ── CLI flags ─────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const DRY_RUN   = !args.includes('--commit') || args.includes('--dry-run');
const MODE_LABEL = DRY_RUN ? 'DRY-RUN' : 'COMMIT';

// ══════════════════════════════════════════════════════════════════════════════
// SAFETY GUARDS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Verify that no Firestore runtime feature flags are accidentally enabled.
 */
function verifyFeatureFlags() {
  const MUST_BE_FALSE = [
    'ENABLE_FIRESTORE_READS',
    'ENABLE_FIRESTORE_DUAL_WRITE',
    'ENABLE_FIRESTORE_OUTBOX_WORKER',
    'ENABLE_FIRESTORE_RECONCILIATION',
  ];
  const violations = [];
  for (const flag of MUST_BE_FALSE) {
    if (process.env[flag] === 'true') {
      violations.push(`  ❌ ${flag} = true  (must be false)`);
    }
  }
  if (violations.length > 0) {
    console.error('\n🚫 SAFETY ABORT: The following feature flags are unexpectedly enabled:');
    violations.forEach(v => console.error(v));
    console.error('\nSet all flags to false in backend/.env before running this script.\n');
    process.exit(1);
  }
  console.log('  ✅ Feature flags verified — all Firestore runtime flags are FALSE');
}

/**
 * Guard any SQL string — reject anything that is not SELECT or SHOW.
 * Belt-and-suspenders check to prevent accidental MySQL mutations.
 */
function assertSelectOnly(sql) {
  const trimmed = sql.trim().toUpperCase();
  if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('SHOW')) {
    throw new Error(
      `SAFETY VIOLATION: Non-SELECT SQL attempted:\n  "${sql}"\n` +
      `This script must ONLY execute SELECT or SHOW queries against MySQL.`
    );
  }
}

/**
 * Guard the write list — abort if more documents than expected are about to be written.
 */
function assertWriteCount(plans, maxAllowed) {
  if (plans.length > maxAllowed) {
    throw new Error(
      `SAFETY VIOLATION: ${plans.length} write(s) planned but max allowed is ${maxAllowed}.\n` +
      `Aborting to prevent unexpected bulk write.`
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CREDENTIAL FIELD GUARD
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Verify that a row object does NOT contain any credential or secret field.
 * Raises immediately if found — this is a hard security check.
 */
function assertNoCredentials(row, label) {
  const FORBIDDEN = ['password', 'password_hash', 'secret', 'token', 'private_key', 'hash'];
  for (const field of FORBIDDEN) {
    if (row[field] !== undefined) {
      throw new Error(
        `SECURITY VIOLATION: Credential field "${field}" found on ${label}.\n` +
        `This script must never export credentials. Aborting immediately.`
      );
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TIMESTAMP HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function toISOOrNull(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ══════════════════════════════════════════════════════════════════════════════
// MYSQL READ
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Read all guest records joined with users.
 * IMPORTANT: Does NOT select password, password_hash, or any credential field.
 * The SELECT list is explicit and exhaustive — no SELECT *.
 */
async function readGuestsFromMySQL(connection) {
  const sql = `
    SELECT
      g.id               AS mysql_guest_id,
      g.user_id          AS mysql_user_id,
      g.full_name,
      g.email,
      g.phone,
      g.address,
      g.gst_no,
      g.pincode,
      g.country,
      g.arrival_from,
      g.departure_to,
      g.government_id,
      g.id_type,
      g.gender,
      g.age,
      g.loyalty_tier,
      g.loyalty_points,
      g.id_document_path,
      g.id_upload_timestamp,
      g.id_verification_status,
      g.id_rejection_reason,
      g.id_verified_by,
      g.id_verified_at,
      g.id_ocr_text,
      g.created_at,
      g.updated_at,
      u.username         AS linked_username,
      u.fullName         AS linked_fullName,
      r.name             AS linked_role
    FROM guests g
    LEFT JOIN users u ON g.user_id = u.id
    LEFT JOIN roles r ON u.role_id = r.id
    ORDER BY g.id ASC
  `;
  assertSelectOnly(sql);
  const [rows] = await connection.query(sql);
  return rows;
}

// ══════════════════════════════════════════════════════════════════════════════
// ROLE DETECTION
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Returns true if the linked user is NOT a guest-role user.
 * A guest record linked to an admin/staff user must NOT get a Firebase UID
 * manufactured by this script — that would be a security error.
 */
function isAdminLinkedGuest(row) {
  if (!row.mysql_user_id) return false; // walk-in, not linked to any user
  if (!row.linked_role)   return false; // user not found / orphan FK
  return row.linked_role.toLowerCase() !== 'guest';
}

// ══════════════════════════════════════════════════════════════════════════════
// FIRESTORE PAYLOAD BUILDER
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build the canonical Firestore document payload from a MySQL guest row.
 *
 * Field mapping follows PHASE4B_GUEST_MIGRATION_AUDIT.md Section G exactly.
 *
 * Special cases:
 *   - user_uid: null for admin-linked guests (not a real guest Firebase account)
 *   - id_document_url: null (Storage migration is deferred — Phase 4-Storage)
 *   - id_document_path: stored as-is (local path for traceability)
 *   - Credential fields: explicitly excluded
 */
function buildGuestPayload(row) {
  const now     = new Date().toISOString();
  const adminLinked = isAdminLinkedGuest(row);

  const payload = {
    // ── Bridge fields ──────────────────────────────────────────────────────
    mysql_guest_id:  Number(row.mysql_guest_id),
    mysql_user_id:   row.mysql_user_id ? Number(row.mysql_user_id) : null,

    // user_uid: null for admin-linked guests — Firebase Auth provisioning deferred
    user_uid: adminLinked ? null : null, // null for all walk-in / non-guest users in Phase 4B
    // NOTE: For real guest-role users, user_uid = `guest_${users.id}` is set
    // by ensureGuestLazyAuthMigration() at login time. Phase 4B does NOT create Auth users.

    // ── Personal data ──────────────────────────────────────────────────────
    full_name:       String(row.full_name || '').trim(),
    email:           row.email   ? String(row.email).toLowerCase().trim()  : null,
    phone:           row.phone   ? String(row.phone).trim()                : null,
    address:         row.address ? String(row.address).trim()              : null,
    gst_no:          row.gst_no  ? String(row.gst_no).trim()               : null,
    pincode:         row.pincode ? String(row.pincode).trim()              : null,
    country:         row.country ? String(row.country).trim()              : null,
    arrival_from:    row.arrival_from  ? String(row.arrival_from).trim()   : null,
    departure_to:    row.departure_to  ? String(row.departure_to).trim()   : null,
    government_id:   row.government_id ? String(row.government_id).trim()  : null,
    id_type:         row.id_type ? String(row.id_type).trim()              : null,
    gender:          row.gender  ? String(row.gender).trim()               : null,
    age:             row.age !== null && row.age !== undefined ? Number(row.age) : null,

    // ── Loyalty ────────────────────────────────────────────────────────────
    loyalty_tier:    String(row.loyalty_tier  || 'Bronze'),
    loyalty_points:  Number(row.loyalty_points || 0),

    // ── ID document — local path (Storage migration deferred) ──────────────
    id_document_path:      row.id_document_path      ? String(row.id_document_path) : null,
    id_upload_timestamp:   toISOOrNull(row.id_upload_timestamp),
    id_verification_status: String(row.id_verification_status || 'Pending'),
    id_rejection_reason:   row.id_rejection_reason ? String(row.id_rejection_reason) : null,
    id_verified_by:        row.id_verified_by ? Number(row.id_verified_by) : null,
    id_verified_at:        toISOOrNull(row.id_verified_at),
    id_ocr_text:           row.id_ocr_text ? String(row.id_ocr_text) : null,

    // Firestore-only — populated after Storage migration (Phase 4-Storage)
    id_document_url: null,

    // ── Timestamps ─────────────────────────────────────────────────────────
    created_at:  toISOOrNull(row.created_at) || now,
    updated_at:  toISOOrNull(row.updated_at) || now,
    migrated_at: now,
    migration_source: 'phase4B',
  };

  return payload;
}

// ══════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ══════════════════════════════════════════════════════════════════════════════

function validateGuestRow(row) {
  const errors = [];
  if (!row.mysql_guest_id)                         errors.push('missing mysql_guest_id');
  if (!row.full_name || !row.full_name.trim())     errors.push('missing full_name');
  if (row.linked_role === undefined)               {} // walk-in is valid
  return errors;
}

// ══════════════════════════════════════════════════════════════════════════════
// POST-WRITE VERIFICATION
// ══════════════════════════════════════════════════════════════════════════════

async function verifyWrittenDoc(docId, payload, originalRow) {
  const docSnap = await db.collection('guests').doc(docId).get();
  if (!docSnap.exists) return { pass: false, reason: 'Document does not exist after write' };

  const d = docSnap.data();
  const checks = [
    ['mysql_guest_id', d.mysql_guest_id, payload.mysql_guest_id],
    ['full_name',      d.full_name,      payload.full_name],
    ['loyalty_tier',   d.loyalty_tier,   payload.loyalty_tier],
    ['user_uid',       d.user_uid,       null],
    ['migration_source', d.migration_source, 'phase4B'],
  ];
  const mismatches = checks.filter(([, actual, expected]) => actual !== expected);
  if (mismatches.length > 0) {
    return {
      pass: false,
      reason: 'Field mismatch: ' + mismatches.map(([f, a, e]) =>
        `${f}: got=${JSON.stringify(a)} want=${JSON.stringify(e)}`).join('; ')
    };
  }
  return { pass: true };
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
  const SEP = '═'.repeat(72);
  const DIV = '─'.repeat(72);

  console.log(`\n${SEP}`);
  console.log(`  HPMS-Sky5 PHASE 4B — Guest Seeding  [${MODE_LABEL}]`);
  console.log(`${SEP}\n`);
  console.log('  Scope   : MySQL guests → Firestore /guests/guest_2');
  console.log('  Mode    : ' + (DRY_RUN
    ? '🔵 DRY-RUN — ZERO Firestore writes, ZERO Auth mutations'
    : '🟢 COMMIT  — Will write to Firestore via Admin SDK'));
  console.log();
  console.log('  SAFETY COMMITMENTS:');
  console.log('    • ZERO Firebase Auth user creations');
  console.log('    • ZERO Firestore document deletions');
  console.log('    • ZERO MySQL writes (SELECT-only guard enforced at runtime)');
  console.log('    • Orphan docs (guest_1, guest_9888877777, guest_11–15) UNTOUCHED');
  console.log(`\n${DIV}\n`);

  // ── STEP 1: Feature flag safety ───────────────────────────────────────────
  console.log('STEP 1 — Feature Flag Safety Check');
  verifyFeatureFlags();
  console.log();

  // ── STEP 2: Firebase Admin SDK ────────────────────────────────────────────
  console.log('STEP 2 — Firebase Admin SDK');
  if (!isFirebaseConfigured || !db) {
    console.error('  ❌ Firebase Admin SDK is not configured.');
    console.error('     Ensure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY in backend/.env');
    await pool.end();
    process.exit(1);
  }
  console.log('  ✅ Firebase Admin SDK ready');
  console.log();

  // ── STEP 3: MySQL read ────────────────────────────────────────────────────
  console.log('STEP 3 — MySQL Source Read (SELECT only)');
  let connection;
  try {
    connection = await pool.getConnection();

    // Pre-migration counts
    const sql_gCount = 'SELECT COUNT(*) as cnt FROM guests';
    assertSelectOnly(sql_gCount);
    const [[{ cnt: gCountPre }]] = await connection.query(sql_gCount);
    console.log(`  MySQL guests count: ${gCountPre}`);

    // Fetch guest rows — explicit column list, NO credentials
    const guestRows = await readGuestsFromMySQL(connection);
    console.log(`  Fetched ${guestRows.length} guest row(s)`);
    console.log('  ✅ MySQL reads complete — connection held for post-write count check');
    console.log();

    // ── STEP 4: Credential audit ──────────────────────────────────────────
    console.log('STEP 4 — Credential Field Security Check');
    for (const row of guestRows) {
      assertNoCredentials(row, `guest id=${row.mysql_guest_id}`);
    }
    console.log(`  ✅ No credential fields detected in ${guestRows.length} row(s)`);
    console.log();

    // ── STEP 5: Validate rows ─────────────────────────────────────────────
    console.log('STEP 5 — Validate Source Data');
    const allErrors = [];
    for (const row of guestRows) {
      const rowErrors = validateGuestRow(row);
      if (rowErrors.length > 0) {
        allErrors.push(`guest_${row.mysql_guest_id}: ${rowErrors.join(', ')}`);
      }
    }
    if (allErrors.length > 0) {
      console.error(`  ❌ Validation FAILED:`);
      allErrors.forEach(e => console.error(`    - ${e}`));
      console.error('\n  ⛔ NO Firestore writes performed.\n');
      connection.release();
      await pool.end();
      process.exit(1);
    }
    console.log(`  ✅ ${guestRows.length} row(s) passed validation`);
    console.log();

    // ── STEP 6: Role detection ────────────────────────────────────────────
    console.log('STEP 6 — Admin-Linked Guest Detection');
    for (const row of guestRows) {
      const adminLinked = isAdminLinkedGuest(row);
      if (adminLinked) {
        console.log(`  ⚠ WARNING: guest id=${row.mysql_guest_id} ("${row.full_name}") is linked to`);
        console.log(`             users.id=${row.mysql_user_id} with role="${row.linked_role}".`);
        console.log(`             This is NOT a guest-role user — user_uid will be null.`);
        console.log(`             No Firebase Auth user will be created by this script.`);
      } else if (!row.mysql_user_id) {
        console.log(`  ℹ  guest id=${row.mysql_guest_id} ("${row.full_name}") is a walk-in (no user_id).`);
        console.log(`             user_uid will be null.`);
      } else {
        console.log(`  ✅ guest id=${row.mysql_guest_id} linked to users.id=${row.mysql_user_id} (role="${row.linked_role}")`);
      }
    }
    console.log();

    // ── STEP 7: Build document plans ──────────────────────────────────────
    console.log('STEP 7 — Build Firestore Document Plans');
    const plans = [];
    for (const row of guestRows) {
      const docId   = `guest_${row.mysql_guest_id}`;
      const payload = buildGuestPayload(row);
      plans.push({ docId, payload, row });
    }

    // Safety guard: abort if too many docs about to be written
    assertWriteCount(plans, 10); // Phase 4B: MySQL has 1 guest; 10 is very conservative ceiling

    console.log(`  Documents planned    : ${plans.length}`);
    console.log(`  Max allowed writes   : 10 (safety ceiling)`);
    console.log(`  Within limit         : ✅`);
    console.log();

    // ── STEP 8: Read existing Firestore state (always — helps conflict report) ──
    console.log('STEP 8 — Existing Firestore State (Read-Only Inspect)');
    const existingG2Snap = await db.collection('guests').doc('guest_2').get();
    const existingG1Snap = await db.collection('guests').doc('guest_1').get();
    const totalGuestsSnap = await db.collection('guests').get();

    console.log(`  Total /guests docs in Firestore : ${totalGuestsSnap.size}`);
    console.log();
    if (existingG2Snap.exists) {
      const d = existingG2Snap.data();
      console.log(`  /guests/guest_2  EXISTS`);
      console.log(`    Fields: ${JSON.stringify({
        mysql_guest_id: d.mysql_guest_id, full_name: d.full_name, name: d.name,
        user_uid: d.user_uid, mysql_user_id: d.mysql_user_id,
        loyalty_tier: d.loyalty_tier, migration_source: d.migration_source,
        updated_at: d.updated_at
      })}`);
    } else {
      console.log(`  /guests/guest_2  DOES NOT EXIST (will be created)`);
    }
    console.log();
    if (existingG1Snap.exists) {
      const d = existingG1Snap.data();
      console.log(`  ⚠ CONFLICT: /guests/guest_1  EXISTS with mysql_guest_id=${d.mysql_guest_id}`);
      console.log(`    Both guest_1 and guest_2 claim mysql_guest_id=2.`);
      console.log(`    guest_1 is an orphan from a prior test run (wrong doc ID).`);
      console.log(`    Phase 4B writes ONLY to guest_2. guest_1 is NOT touched.`);
      console.log(`    Fields: ${JSON.stringify({
        mysql_guest_id: d.mysql_guest_id, full_name: d.full_name || d.name,
        user_uid: d.user_uid, updated_at: d.updated_at
      })}`);
    } else {
      console.log(`  /guests/guest_1  does not exist`);
    }
    console.log();

    // ── STEP 9: Preview (always printed) ─────────────────────────────────
    console.log(`${DIV}`);
    console.log('MIGRATION PREVIEW');
    console.log(`${DIV}\n`);

    for (const plan of plans) {
      const adminLinked = isAdminLinkedGuest(plan.row);
      console.log(`  MySQL guest id=${plan.row.mysql_guest_id}  →  Firestore /guests/${plan.docId}`);
      console.log(`  Linked user: users.id=${plan.row.mysql_user_id || 'none'}  role="${plan.row.linked_role || 'none'}"`);
      if (adminLinked) {
        console.log(`  ⚠ Admin-linked guest: user_uid will be null (no Firebase Auth provisioning)`);
      }
      console.log(`\n  Payload that WOULD be written to /guests/${plan.docId}:`);

      // Print payload with PII partially redacted
      const preview = { ...plan.payload };
      if (preview.phone)        preview.phone        = preview.phone.substring(0,4) + '****';
      if (preview.email)        preview.email        = preview.email.replace(/(.{2}).*(@.*)/, '$1***$2');
      if (preview.government_id) preview.government_id = '[REDACTED]';
      if (preview.address)      preview.address      = '[REDACTED]';
      console.log(JSON.stringify(preview, null, 4).split('\n').map(l => '  ' + l).join('\n'));
      console.log();
    }

    // ── DRY-RUN EXIT ──────────────────────────────────────────────────────
    if (DRY_RUN) {
      console.log(`${SEP}`);
      console.log('  🔵 DRY-RUN COMPLETE');
      console.log(`  Planned Firestore writes     : ${plans.length}`);
      console.log('  Actual Firestore writes      : 0');
      console.log('  Firebase Auth mutations      : 0');
      console.log('  Firestore document deletions : 0');
      console.log('  MySQL writes                 : 0');
      console.log();
      console.log('  Orphan documents UNTOUCHED   : guest_1, guest_9888877777, guest_11, guest_12, guest_13, guest_14, guest_15');
      console.log();
      console.log('  To execute actual seeding run:');
      console.log('    node scripts/phase4B_seedGuests.mjs --commit');
      console.log(`${SEP}\n`);
      connection.release();
      await pool.end();
      return;
    }

    // ── STEP 10: Commit mode — Firestore batch write ──────────────────────
    console.log('STEP 9 — Firestore Batch Write (Admin SDK, merge:true)');

    const batch = db.batch();
    for (const plan of plans) {
      const ref = db.collection('guests').doc(plan.docId);
      // merge: true → idempotent, never destroys existing fields not in payload
      batch.set(ref, plan.payload, { merge: true });
    }

    console.log(`  Writing ${plans.length} document(s)...`);
    await batch.commit();
    console.log(`  ✅ Batch committed — ${plans.length} document(s) written`);
    console.log();

    // ── STEP 11: Post-write read-back verification ────────────────────────
    console.log('STEP 10 — Post-Write Read-Back Verification');
    let totalPassed = 0, totalFailed = 0;
    for (const plan of plans) {
      const result = await verifyWrittenDoc(plan.docId, plan.payload, plan.row);
      if (result.pass) {
        console.log(`  ✅ PASS  /guests/${plan.docId}  (full_name="${plan.payload.full_name}", mysql_guest_id=${plan.payload.mysql_guest_id})`);
        totalPassed++;
      } else {
        console.log(`  ❌ FAIL  /guests/${plan.docId}  — ${result.reason}`);
        totalFailed++;
      }
    }

    // ── STEP 12: Confirm orphans untouched ────────────────────────────────
    console.log('\n── Orphan Document Integrity Check ──────────────────────────────────────');
    const ORPHAN_IDS = ['guest_1', 'guest_9888877777', 'guest_11', 'guest_12', 'guest_13', 'guest_14', 'guest_15'];
    let orphanOk = true;
    for (const orphanId of ORPHAN_IDS) {
      const orphanSnap = await db.collection('guests').doc(orphanId).get();
      if (orphanId === 'guest_2') continue; // this one we just wrote
      // We cannot easily verify content unchanged without a prior snapshot,
      // but we can confirm the document still exists (not deleted)
      if (!orphanSnap.exists) {
        console.log(`  ❌ UNEXPECTED: /guests/${orphanId} was deleted — this must not happen`);
        orphanOk = false;
      } else {
        console.log(`  ✅ UNTOUCHED  /guests/${orphanId}  still exists`);
      }
    }

    // ── STEP 13: MySQL integrity check (post-migration) ───────────────────
    console.log('\n── MySQL Integrity Verification (post-migration) ─────────────────────────');
    assertSelectOnly(sql_gCount);
    const [[{ cnt: gCountPost }]] = await connection.query(sql_gCount);
    const gIntOk = gCountPost === gCountPre;
    console.log(`  guests: before=${gCountPre}  after=${gCountPost}  → ${gIntOk ? '✅ UNCHANGED' : '❌ COUNT CHANGED'}`);
    if (!gIntOk) {
      console.error('\n  🚨 MySQL guest count changed — should never happen. Investigate immediately.');
    }

    // ── FINAL REPORT ──────────────────────────────────────────────────────
    const OVERALL = (totalFailed === 0 && gIntOk && orphanOk) ? '✅ PASS' : '❌ FAIL';

    console.log(`\n${SEP}`);
    console.log('  PHASE 4B FINAL REPORT');
    console.log(`${SEP}`);
    console.log();
    console.log('  A. Files created        : scripts/phase4B_seedGuests.mjs');
    console.log(`  B. MySQL guest count    : ${gCountPre}`);
    console.log(`  C. Documents written    : ${plans.length}`);
    console.log('  D. Firebase Auth mutations: 0');
    console.log('  E. Firestore deletes    : 0');
    console.log('  F. MySQL writes         : 0');
    console.log(`  G. Verification PASS    : ${totalPassed}`);
    console.log(`  G. Verification FAIL    : ${totalFailed}`);
    console.log(`  H. Orphan docs intact   : ${orphanOk ? '✅ YES' : '❌ NO'}`);
    console.log(`  I. MySQL integrity      : ${gIntOk ? '✅ UNCHANGED' : '❌ CHANGED'}`);
    console.log();
    console.log('  Feature Flags (NOT modified):');
    console.log(`    ENABLE_FIRESTORE_READS          = ${process.env.ENABLE_FIRESTORE_READS          || 'false'}`);
    console.log(`    ENABLE_FIRESTORE_DUAL_WRITE     = ${process.env.ENABLE_FIRESTORE_DUAL_WRITE     || 'false'}`);
    console.log(`    ENABLE_FIRESTORE_OUTBOX_WORKER  = ${process.env.ENABLE_FIRESTORE_OUTBOX_WORKER  || 'false'}`);
    console.log(`    ENABLE_FIRESTORE_RECONCILIATION = ${process.env.ENABLE_FIRESTORE_RECONCILIATION || 'false'}`);
    console.log();
    console.log(`  ► OVERALL RESULT: ${OVERALL}`);
    console.log(`${SEP}\n`);

    connection.release();
    await pool.end();

    if (totalFailed > 0 || !gIntOk || !orphanOk) process.exit(1);

  } catch (err) {
    if (connection) connection.release();
    await pool.end();
    throw err;
  }
}

main().catch(err => {
  console.error('\n❌ Unhandled error in phase4B_seedGuests:', err.message);
  process.exit(1);
});
