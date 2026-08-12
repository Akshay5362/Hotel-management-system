/**
 * scripts/phase4A_seedMasterData.mjs
 * ══════════════════════════════════════════════════════════════════════════════
 * HPMS-Sky5 — PHASE 4A: Master Data Seeding (room_types + system_settings)
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * SAFETY CONTRACT:
 *   ✅ Reads ONLY from MySQL (SELECT statements only — enforced at runtime)
 *   ✅ Writes ONLY to Firestore (Admin SDK — bypasses client security rules)
 *   ✅ Uses batch.set(..., { merge: true }) — idempotent, never destructive
 *   ✅ Never deletes any Firestore document
 *   ✅ Never modifies any MySQL data
 *   ✅ Dry-run by default — pass no args or --dry-run for zero-write preview
 *   ✅ Feature flags ENABLE_FIRESTORE_READS / ENABLE_FIRESTORE_DUAL_WRITE
 *      remain FALSE — this script does NOT toggle any application feature flags
 *
 * DOCUMENT ID CONVENTIONS (matches existing Firestore repositories exactly):
 *   room_types   → /room_types/type_{CODE}
 *                  (roomTypesRepository.js line 44: const docId = `type_${codeStr}`)
 *   system_date  → /settings/system_date
 *                  (systemSettingsRepository.js: COLLECTION='settings', SYSTEM_DATE_DOC_ID='system_date')
 *   other keys   → /settings/{key_name}
 *
 * USAGE (run from project root d:\projects\hotel\):
 *   node scripts/phase4A_seedMasterData.mjs             → DRY-RUN (default)
 *   node scripts/phase4A_seedMasterData.mjs --dry-run   → DRY-RUN (explicit)
 *   node scripts/phase4A_seedMasterData.mjs --commit    → Actual Firestore write
 *
 * Module resolution: reuses backend/db.js and backend/config/firebaseAdmin.js
 * (same pattern as all other scripts in this directory).
 */

// ── Imports — reuse existing backend modules ──────────────────────────────────
import pool from '../backend/db.js';
import { db, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';

// ── CLI flags ─────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const DRY_RUN   = !args.includes('--commit') || args.includes('--dry-run');
const MODE_LABEL = DRY_RUN ? 'DRY-RUN' : 'COMMIT';

// ════════════════════════════════════════════════════════════════════════════════
// SAFETY GUARDS
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Verify that no Firestore runtime feature flags are accidentally enabled.
 * This script is a one-shot seed tool; it does NOT depend on these flags.
 * But we enforce them are false to confirm the system is in the correct state.
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
      violations.push(`  ❌ ${flag} = true  (must be false for Phase 4A)`);
    }
  }
  if (violations.length > 0) {
    console.error('\n🚫 SAFETY ABORT: The following feature flags are unexpectedly enabled:');
    violations.forEach(v => console.error(v));
    console.error('\nSet all flags to false in backend/.env before running this script.\n');
    process.exit(1);
  }
  console.log('  ✅ Feature flags verified — ENABLE_FIRESTORE_READS=false, ENABLE_FIRESTORE_DUAL_WRITE=false');
}

/**
 * Guard any SQL statement — reject anything that is not SELECT or SHOW.
 * This is a belt-and-suspenders check to ensure MySQL remains read-only.
 */
function assertSelectOnly(sql) {
  const trimmed = sql.trim().toUpperCase();
  if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('SHOW')) {
    throw new Error(
      `SAFETY VIOLATION: Non-SELECT SQL attempted:\n  "${sql}"\n` +
      `This script must only execute SELECT or SHOW queries against MySQL.`
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// DATE CONVERSION
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Converts MySQL system_date formats to YYYY-MM-DD.
 * MySQL stores: "11-Aug-2026" (DD-Mon-YYYY)
 * Firestore repository expects: "2026-08-11" (YYYY-MM-DD)
 */
function parseBusinessDate(rawDate) {
  if (!rawDate) return null;
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(rawDate).trim())) return String(rawDate).trim();
  // DD-Mon-YYYY (e.g. "11-Aug-2026")
  const MONTHS = {
    jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
    jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12'
  };
  const m = String(rawDate).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m) {
    const day   = String(m[1]).padStart(2, '0');
    const month = MONTHS[m[2].toLowerCase()];
    const year  = m[3];
    if (month) return `${year}-${month}-${day}`;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 1: ROOM TYPES
// Target: /room_types/type_{CODE}   ← roomTypesRepository.js convention
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Build the Firestore document ID for a room type.
 *
 * MUST MATCH roomTypesRepository.js exactly (line 43–44):
 *   const codeStr = String(typeData.code).toUpperCase().trim();
 *   const docId   = `type_${codeStr}`;
 */
function buildRoomTypeDocId(code) {
  return `type_${String(code).toUpperCase().trim()}`;
}

/**
 * Map a MySQL room_type row to the Firestore payload.
 *
 * Repository createRoomTypeFirestore() stores:
 *   name, code, description, base_rate, max_occupancy, amenities,
 *   mysql_room_type_id, created_at, updated_at
 *
 * MySQL room_types columns:
 *   id, code, title, description, base_rate, image
 *
 * "title" → "name"  (MySQL uses "title"; repository canonical field is "name")
 * We preserve "title" as an alias field for frontend compatibility.
 * outboxDispatcher.js ROOM_TYPE_CREATED handler already maps:
 *   name: payload.name || payload.title
 */
function mapRoomTypeToFirestore(row) {
  const codeStr = String(row.code || '').toUpperCase().trim();
  const docId   = buildRoomTypeDocId(codeStr);
  const now     = new Date().toISOString();

  const payload = {
    // ── Canonical fields (required by roomTypesRepository.js) ──
    name:               String(row.title || row.name || '').trim(),
    code:               codeStr,
    description:        String(row.description || '').trim(),
    base_rate:          Number(row.base_rate || 0),
    max_occupancy:      2,    // MySQL has no capacity column; default per repo
    amenities:          [],   // MySQL has no amenities column; default per repo

    // ── MySQL source alias fields ──
    title:              String(row.title || '').trim(),  // preserve for frontend
    image:              String(row.image  || '').trim(),  // emoji icon

    // ── Bridge field (links Firestore doc back to MySQL) ──
    mysql_room_type_id: Number(row.id),

    // ── Metadata ──
    updated_at:         now,
    migrated_at:        now,
    migration_source:   'phase4A',
  };

  return { docId, payload };
}

function validateRoomTypeRow(row, index) {
  const errors = [];
  if (!row.id)    errors.push(`row[${index}] missing id`);
  if (!row.code)  errors.push(`row[${index}] (id=${row.id}) missing code`);
  if (!row.title) errors.push(`row[${index}] (id=${row.id}) missing title`);
  const rate = Number(row.base_rate);
  if (row.base_rate === undefined || row.base_rate === null || isNaN(rate)) {
    errors.push(`row[${index}] (id=${row.id}) invalid base_rate: ${row.base_rate}`);
  }
  return errors;
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 2: SYSTEM SETTINGS
// Target: /settings/system_date + /settings/{key_name}
// systemSettingsRepository.js: COLLECTION = 'settings', SYSTEM_DATE_DOC_ID = 'system_date'
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Build Firestore document plans for all system_settings rows.
 *
 * system_date row → /settings/system_date  (canonical business date doc)
 * other rows      → /settings/{key_name}   (individual setting docs)
 *
 * Counter keys (today_checkins, today_checkouts, continued_rooms) are embedded
 * into the system_date document AND also written as their own docs so the
 * /settings/ collection has a 1:1 representation of each MySQL row.
 */
function mapSystemSettingsToFirestore(rows) {
  const plans = [];
  const now   = new Date().toISOString();

  const systemDateRow = rows.find(r => r.key_name === 'system_date');

  // ── /settings/system_date ─────────────────────────────────────────────────
  if (systemDateRow) {
    const rawDate = systemDateRow.value_val;
    const isoDate = parseBusinessDate(rawDate);

    if (!isoDate) {
      plans.push({ docId: 'system_date', payload: null, error: `Cannot parse date: "${rawDate}"` });
    } else {
      const findVal = (key) => {
        const r = rows.find(row => row.key_name === key);
        return r ? Number(r.value_val || 0) : 0;
      };

      plans.push({
        docId: 'system_date',
        isSystemDate: true,
        mysqlRawDate: rawDate,
        payload: {
          // Fields expected by systemSettingsRepository.js
          current_date:    isoDate,
          system_date:     isoDate,           // legacy alias used by some callers
          today_checkins:  findVal('today_checkins'),
          today_checkouts: findVal('today_checkouts'),
          continued_rooms: findVal('continued_rooms'),
          day_end_status:  'IDLE',
          // Metadata
          updated_at:       now,
          migrated_at:      now,
          migration_source: 'phase4A',
          mysql_raw_date:   rawDate,          // traceability — original MySQL format
        },
      });
    }
  }

  // ── /settings/{key_name} — one doc per non-date setting ──────────────────
  const NON_DATE_KEYS = rows.filter(r => r.key_name !== 'system_date');
  for (const row of NON_DATE_KEYS) {
    const numVal = Number(row.value_val);
    const isNum  = !isNaN(numVal) && row.value_val !== null && row.value_val !== '';

    plans.push({
      docId: row.key_name,
      isSystemDate: false,
      payload: {
        key_name:         row.key_name,
        value_val:        row.value_val,
        ...(isNum && { value_num: numVal }),
        updated_at:       now,
        migrated_at:      now,
        migration_source: 'phase4A',
      },
    });
  }

  return plans;
}

// ════════════════════════════════════════════════════════════════════════════════
// POST-WRITE VERIFICATION
// ════════════════════════════════════════════════════════════════════════════════

async function verifyRoomTypes(originalRows) {
  console.log('\n── POST-WRITE VERIFICATION: /room_types ──────────────────────────────────');
  let passed = 0, failed = 0;

  for (const row of originalRows) {
    const docId   = buildRoomTypeDocId(row.code);
    const docSnap = await db.collection('room_types').doc(docId).get();

    if (!docSnap.exists) {
      console.log(`  ❌ FAIL  /room_types/${docId}  — document does not exist`);
      failed++;
      continue;
    }

    const d = docSnap.data();
    const checks = [
      ['code',               d.code,               String(row.code || '').toUpperCase().trim()],
      ['name',               d.name,               String(row.title || '').trim()],
      ['base_rate',          Number(d.base_rate),  Number(row.base_rate)],
      ['mysql_room_type_id', d.mysql_room_type_id, Number(row.id)],
    ];

    const mismatches = checks.filter(([, actual, expected]) => actual !== expected);
    if (mismatches.length > 0) {
      console.log(`  ❌ FAIL  /room_types/${docId}  — field mismatches:`);
      mismatches.forEach(([field, actual, expected]) =>
        console.log(`         ${field}: got=${JSON.stringify(actual)}  want=${JSON.stringify(expected)}`)
      );
      failed++;
    } else {
      console.log(`  ✅ PASS  /room_types/${docId}  (code=${d.code}, name="${d.name}", base_rate=${d.base_rate})`);
      passed++;
    }
  }
  return { passed, failed };
}

async function verifySettings(settingPlans) {
  console.log('\n── POST-WRITE VERIFICATION: /settings ────────────────────────────────────');
  let passed = 0, failed = 0;

  for (const plan of settingPlans) {
    if (!plan.payload) {
      console.log(`  ⚠ SKIP  /settings/${plan.docId}  — skipped (validation error)`);
      continue;
    }

    const docSnap = await db.collection('settings').doc(plan.docId).get();

    if (!docSnap.exists) {
      console.log(`  ❌ FAIL  /settings/${plan.docId}  — document does not exist`);
      failed++;
      continue;
    }

    const d = docSnap.data();

    if (plan.isSystemDate) {
      // Verify date fields
      const ok = d.current_date === plan.payload.current_date &&
                 d.system_date  === plan.payload.system_date;
      if (!ok) {
        console.log(`  ❌ FAIL  /settings/${plan.docId}  — date mismatch`);
        console.log(`         current_date: got=${d.current_date}  want=${plan.payload.current_date}`);
        console.log(`         system_date:  got=${d.system_date}   want=${plan.payload.system_date}`);
        failed++;
      } else {
        console.log(`  ✅ PASS  /settings/${plan.docId}  (current_date=${d.current_date})`);
        passed++;
      }
    } else {
      // Verify key_name + value_val
      const ok = d.key_name === plan.payload.key_name &&
                 d.value_val === plan.payload.value_val;
      if (!ok) {
        console.log(`  ❌ FAIL  /settings/${plan.docId}  — value mismatch`);
        console.log(`         key_name:  got=${d.key_name}   want=${plan.payload.key_name}`);
        console.log(`         value_val: got=${d.value_val}  want=${plan.payload.value_val}`);
        failed++;
      } else {
        console.log(`  ✅ PASS  /settings/${plan.docId}  (key_name=${d.key_name}, value_val=${d.value_val})`);
        passed++;
      }
    }
  }
  return { passed, failed };
}

// ════════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════════

async function main() {
  const SEP = '═'.repeat(72);
  const DIV = '─'.repeat(72);

  console.log(`\n${SEP}`);
  console.log(`  HPMS-Sky5 PHASE 4A — Master Data Seeding  [${MODE_LABEL}]`);
  console.log(`${SEP}\n`);
  console.log('  Scope   : room_types + system_settings → Firestore');
  console.log('  Mode    : ' + (DRY_RUN
    ? '🔵 DRY-RUN — ZERO Firestore writes will be performed'
    : '🟢 COMMIT  — Will write to Firestore via Admin SDK'));
  console.log(`\n${DIV}\n`);

  // ── STEP 1: Feature flag safety check ────────────────────────────────────
  console.log('STEP 1 — Feature Flag Safety Check');
  verifyFeatureFlags();
  console.log();

  // ── STEP 2: Verify Firebase Admin SDK ────────────────────────────────────
  console.log('STEP 2 — Firebase Admin SDK');
  if (!isFirebaseConfigured || !db) {
    console.error('  ❌ Firebase Admin SDK is not configured.');
    console.error('     Ensure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY');
    console.error('     are set in backend/.env');
    await pool.end();
    process.exit(1);
  }
  console.log(`  ✅ Firebase Admin SDK ready`);
  console.log();

  // ── STEP 3: MySQL — capture pre-migration counts ──────────────────────────
  console.log('STEP 3 — MySQL Source Read (SELECT only)');
  let connection;
  try {
    connection = await pool.getConnection();

    // Pre-migration count capture
    const sql_rtCount = 'SELECT COUNT(*) as cnt FROM room_types';
    const sql_ssCount = 'SELECT COUNT(*) as cnt FROM system_settings';
    assertSelectOnly(sql_rtCount);
    assertSelectOnly(sql_ssCount);
    const [[{ cnt: rtCountPre }]] = await connection.query(sql_rtCount);
    const [[{ cnt: ssCountPre }]] = await connection.query(sql_ssCount);

    // Read source data
    const sql_rt = 'SELECT id, code, title, description, base_rate, image FROM room_types ORDER BY id ASC';
    const sql_ss = 'SELECT key_name, value_val FROM system_settings ORDER BY key_name ASC';
    assertSelectOnly(sql_rt);
    assertSelectOnly(sql_ss);
    const [rtRows] = await connection.query(sql_rt);
    const [ssRows] = await connection.query(sql_ss);

    console.log(`  room_types count     : ${rtCountPre}`);
    console.log(`  system_settings count: ${ssCountPre}`);
    console.log('  ✅ MySQL reads complete');
    console.log();

    // ── STEP 4: Validate source data ───────────────────────────────────────
    console.log('STEP 4 — Validate Source Data');
    const validationErrors = [];

    // Room types
    const seenCodes = new Set();
    for (let i = 0; i < rtRows.length; i++) {
      const rowErrs = validateRoomTypeRow(rtRows[i], i);
      validationErrors.push(...rowErrs);
      if (rtRows[i].code) {
        const cu = String(rtRows[i].code).toUpperCase().trim();
        if (seenCodes.has(cu)) {
          validationErrors.push(`Duplicate room_type code "${cu}" at row[${i}]`);
        }
        seenCodes.add(cu);
      }
    }

    if (validationErrors.length > 0) {
      console.error(`  ❌ Validation FAILED — ${validationErrors.length} error(s):`);
      validationErrors.forEach(e => console.error(`    - ${e}`));
      console.error('\n  ⛔ NO Firestore writes performed.\n');
      connection.release();
      await pool.end();
      process.exit(1);
    }

    console.log(`  ✅ ${rtRows.length} room_type rows — all valid`);
    console.log(`  ✅ ${ssRows.length} system_settings rows — all present`);
    console.log();

    // ── STEP 5: Build document plans ───────────────────────────────────────
    console.log('STEP 5 — Build Firestore Document Plans');
    const rtPlans = rtRows.map(row => mapRoomTypeToFirestore(row));
    const ssPlans = mapSystemSettingsToFirestore(ssRows);

    const ssPlanErrors = ssPlans.filter(p => !p.payload);
    if (ssPlanErrors.length > 0) {
      console.error('  ❌ System settings plan errors:');
      ssPlanErrors.forEach(e => console.error(`    /settings/${e.docId}: ${e.error}`));
      console.error('\n  ⛔ NO Firestore writes performed.\n');
      connection.release();
      await pool.end();
      process.exit(1);
    }

    const totalWrites = rtPlans.length + ssPlans.length;
    console.log(`  room_type docs planned   : ${rtPlans.length}`);
    console.log(`  settings docs planned    : ${ssPlans.length}`);
    console.log(`  Total docs planned       : ${totalWrites}  (Firestore batch limit: 500 ✅)`);
    console.log();

    // ── STEP 6: Preview (always printed) ───────────────────────────────────
    console.log(`${DIV}`);
    console.log('MIGRATION PREVIEW');
    console.log(`${DIV}\n`);

    console.log('  ROOM TYPES → Firestore /room_types/');
    console.log(`  MySQL source rows    : ${rtRows.length}`);
    console.log(`  Firestore docs       : ${rtPlans.length}`);
    console.log();
    for (const plan of rtPlans) {
      console.log(`  MySQL id=${plan.payload.mysql_room_type_id}  code=${plan.payload.code}`);
      console.log(`    → /room_types/${plan.docId}`);
      console.log(`       name="${plan.payload.name}"  base_rate=${plan.payload.base_rate}`);
      console.log();
    }

    console.log('  SYSTEM SETTINGS → Firestore /settings/');
    console.log(`  MySQL source rows    : ${ssRows.length}`);
    console.log(`  Firestore docs       : ${ssPlans.length}`);
    console.log();
    for (const plan of ssPlans) {
      if (plan.isSystemDate) {
        console.log(`  MySQL key="system_date"  raw="${plan.mysqlRawDate}"`);
        console.log(`    → /settings/${plan.docId}`);
        console.log(`       current_date="${plan.payload.current_date}"`);
        console.log(`       today_checkins=${plan.payload.today_checkins}  today_checkouts=${plan.payload.today_checkouts}  continued_rooms=${plan.payload.continued_rooms}`);
      } else {
        console.log(`  MySQL key="${plan.docId}"  value="${plan.payload.value_val}"`);
        console.log(`    → /settings/${plan.docId}`);
      }
      console.log();
    }

    // ── DRY-RUN EXIT ──────────────────────────────────────────────────────
    if (DRY_RUN) {
      console.log(`${SEP}`);
      console.log('  🔵 DRY-RUN COMPLETE');
      console.log(`  Planned writes      : ${totalWrites}  (${rtPlans.length} room_types + ${ssPlans.length} settings)`);
      console.log('  ZERO Firestore writes performed.');
      console.log('  ZERO MySQL writes performed.');
      console.log();
      console.log('  To execute actual seeding run:');
      console.log('    node scripts/phase4A_seedMasterData.mjs --commit');
      console.log(`${SEP}\n`);
      connection.release();
      await pool.end();
      return;
    }

    // ── STEP 7: Batched Firestore write ────────────────────────────────────
    console.log('STEP 6 — Firestore Batch Write (Admin SDK)');
    const batch = db.batch();

    for (const plan of rtPlans) {
      const ref = db.collection('room_types').doc(plan.docId);
      batch.set(ref, plan.payload, { merge: true });
    }
    for (const plan of ssPlans) {
      if (!plan.payload) continue;
      const ref = db.collection('settings').doc(plan.docId);
      batch.set(ref, plan.payload, { merge: true });
    }

    console.log(`  Writing ${totalWrites} documents...`);
    await batch.commit();
    console.log(`  ✅ Batch committed — ${totalWrites} documents written`);
    console.log();

    // ── STEP 8: Post-write read-back verification ──────────────────────────
    console.log('STEP 7 — Post-Write Read-Back Verification');
    const rtVerify = await verifyRoomTypes(rtRows);
    const ssVerify = await verifySettings(ssPlans);
    const totalPassed = rtVerify.passed + ssVerify.passed;
    const totalFailed = rtVerify.failed + ssVerify.failed;

    // ── STEP 9: MySQL integrity check (post-migration) ─────────────────────
    console.log('\n── MySQL Integrity Verification (post-migration) ─────────────────────────');
    const [[{ cnt: rtCountPost }]] = await connection.query('SELECT COUNT(*) as cnt FROM room_types');
    const [[{ cnt: ssCountPost }]] = await connection.query('SELECT COUNT(*) as cnt FROM system_settings');
    const rtIntOk = rtCountPost === rtCountPre;
    const ssIntOk = ssCountPost === ssCountPre;
    console.log(`  room_types     : before=${rtCountPre}  after=${rtCountPost}  → ${rtIntOk ? '✅ UNCHANGED' : '❌ COUNT CHANGED'}`);
    console.log(`  system_settings: before=${ssCountPre}  after=${ssCountPost}  → ${ssIntOk ? '✅ UNCHANGED' : '❌ COUNT CHANGED'}`);
    if (!rtIntOk || !ssIntOk) {
      console.error('\n  🚨 MySQL count changed — should never happen. Investigate immediately.');
    }

    // ── FINAL REPORT ──────────────────────────────────────────────────────
    const OVERALL = (totalFailed === 0 && rtIntOk && ssIntOk) ? '✅ PASS' : '❌ FAIL';

    console.log(`\n${SEP}`);
    console.log('  PHASE 4A FINAL REPORT');
    console.log(`${SEP}`);
    console.log();
    console.log('  A. Source counts (MySQL):');
    console.log(`       room_types      : ${rtCountPre}`);
    console.log(`       system_settings : ${ssCountPre}`);
    console.log();
    console.log('  B. Target counts (Firestore):');
    console.log(`       /room_types/    : ${rtPlans.length} documents written`);
    console.log(`       /settings/      : ${ssPlans.length} documents written`);
    console.log(`       Total written   : ${totalWrites}`);
    console.log();
    console.log('  C. Verification:');
    console.log(`       /room_types PASS : ${rtVerify.passed}    FAIL : ${rtVerify.failed}`);
    console.log(`       /settings   PASS : ${ssVerify.passed}    FAIL : ${ssVerify.failed}`);
    console.log(`       Total PASS       : ${totalPassed}`);
    console.log(`       Total FAIL       : ${totalFailed}`);
    console.log();
    console.log('  D. MySQL Integrity:');
    console.log(`       room_types unchanged     : ${rtIntOk ? '✅ YES' : '❌ NO'}`);
    console.log(`       system_settings unchanged: ${ssIntOk ? '✅ YES' : '❌ NO'}`);
    console.log();
    console.log('  E. Feature Flags (NOT modified):');
    console.log(`       ENABLE_FIRESTORE_READS          = ${process.env.ENABLE_FIRESTORE_READS          || 'false'}`);
    console.log(`       ENABLE_FIRESTORE_DUAL_WRITE     = ${process.env.ENABLE_FIRESTORE_DUAL_WRITE     || 'false'}`);
    console.log(`       ENABLE_FIRESTORE_OUTBOX_WORKER  = ${process.env.ENABLE_FIRESTORE_OUTBOX_WORKER  || 'false'}`);
    console.log(`       ENABLE_FIRESTORE_RECONCILIATION = ${process.env.ENABLE_FIRESTORE_RECONCILIATION || 'false'}`);
    console.log();
    console.log(`  ► OVERALL RESULT: ${OVERALL}`);
    console.log(`${SEP}\n`);

    connection.release();
    await pool.end();

    if (totalFailed > 0 || !rtIntOk || !ssIntOk) process.exit(1);

  } catch (err) {
    if (connection) connection.release();
    await pool.end();
    throw err;
  }
}

main().catch(err => {
  console.error('\n❌ Unhandled error in phase4A_seedMasterData:', err.message);
  process.exit(1);
});
