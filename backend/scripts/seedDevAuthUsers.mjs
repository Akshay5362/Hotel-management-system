/**
 * backend/scripts/seedDevAuthUsers.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Creates the minimum Firebase Auth accounts needed to functionally test
 * Chef KDS, Cleaner/Housekeeping, and Admin Housekeeping against the
 * ISOLATED DEV Firebase project (sky5-development) ONLY.
 *
 * SAFETY — identical quadruple guard to seedDevFirestore.mjs:
 *   1. HPMS_ENV must literally be "development" (else: throw, exit 1).
 *   2. Firebase Admin is initialized from backend/.env.development only.
 *   3. The resolved project id must be exactly "sky5-development".
 *   4. Any resolved project id containing "hpms" (case-insensitive) is
 *      rejected outright, regardless of #3.
 * The resolved project id is printed before any write is attempted.
 *
 * Dry-run by default. Pass --execute to actually create/update accounts.
 *
 * Idempotent: auth.getUser(uid) is checked first. An EXISTING user's
 * password is NEVER touched — only a brand-new user receives the password
 * from DEV_SEED_STAFF_PASSWORD. Custom claims are (re)written only when
 * they differ from what is already set.
 *
 * Password handling:
 *   - Read ONLY from process.env.DEV_SEED_STAFF_PASSWORD.
 *   - NEVER printed to any log line, NEVER written to any file, NEVER
 *     stored in Firestore, NEVER included in any object that gets logged.
 *   - If unset and --execute is passed while new users would need to be
 *     created, the script aborts before creating anything.
 *
 * Run:
 *   npm run dev:seed:auth -- --dry-run                              (default)
 *   DEV_SEED_STAFF_PASSWORD=<value> npm run dev:seed:auth -- --execute
 * ─────────────────────────────────────────────────────────────────────────────
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.join(__dirname, '..');

// ── Guard 1: HPMS_ENV must be explicitly "development" ──────────────────────
const HPMS_ENV = process.env.HPMS_ENV;
if (HPMS_ENV !== 'development') {
  console.error(
    `[SAFETY_ABORT] HPMS_ENV must be exactly "development" (got: ${JSON.stringify(HPMS_ENV)}). ` +
    `This script only ever provisions sky5-development. Refusing to proceed. ` +
    `Run via: npm run dev:seed:auth -- --dry-run`
  );
  process.exit(1);
}

// Load ONLY backend/.env.development — never backend/.env (production).
dotenv.config({ path: path.join(BACKEND_ROOT, '.env.development') });

const { initializeApp, cert, getApps, getApp } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');
const { isProductionProject } = await import('../config/productionSafetyGuard.js');

const EXECUTE = process.argv.includes('--execute');
const DRY_RUN = !EXECUTE;

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;
const privateKey = rawPrivateKey ? rawPrivateKey.replace(/\\n/g, '\n') : undefined;

// ── Guard 2 — this script CREATES Auth users; the single most important
// place for this check to run, before any credential is used. ──────────────
if (isProductionProject()) {
  console.error(
    `[SAFETY_ABORT] FIREBASE_PROJECT_ID resolved to the PRODUCTION project ("${projectId}"). ` +
    `This script CREATES Firebase Auth users — refusing to run against production. ` +
    `Fix backend/.env.development and retry.`
  );
  process.exit(1);
}

if (!projectId || !clientEmail || !privateKey ||
    String(clientEmail).startsWith('REPLACE_WITH_') || String(rawPrivateKey).startsWith('REPLACE_WITH_')) {
  console.error('[FATAL] Missing or placeholder Firebase Admin credentials in backend/.env.development — nothing was contacted, no users created.');
  process.exit(1);
}

const firebaseApp = !getApps().length
  ? initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) })
  : getApp();

const resolvedProjectId = firebaseApp?.options?.projectId || firebaseApp?.options?.credential?.projectId || projectId;

// ── Guard 3 + 4 ───────────────────────────────────────────────────────────
if (resolvedProjectId !== 'sky5-development') {
  console.error(`[SAFETY_ABORT] Resolved Firebase project is "${resolvedProjectId}", expected exactly "sky5-development". Refusing to create any user.`);
  process.exit(1);
}
if (/hpms/i.test(resolvedProjectId)) {
  console.error(`[SAFETY_ABORT] Resolved Firebase project id "${resolvedProjectId}" contains "hpms" — refusing unconditionally, regardless of the exact-match check above.`);
  process.exit(1);
}

console.log('═'.repeat(78));
console.log('  DEV AUTH SEEDER — backend/scripts/seedDevAuthUsers.mjs');
console.log('═'.repeat(78));
console.log(`  Resolved Firebase project : ${resolvedProjectId}`);
console.log(`  HPMS_ENV                  : ${HPMS_ENV}`);
console.log(`  Mode                      : ${DRY_RUN ? 'DRY-RUN (no writes)' : 'EXECUTE (writing)'}`);
console.log('═'.repeat(78) + '\n');

const auth = getAuth(firebaseApp);

// Raw uppercase roles — matches normalizeUserRole()'s exact input contract:
// staff + role "CLEANER" -> housekeeper ; "CHEF"/"KITCHEN_HELPER" -> kitchen.
const ACCOUNTS = [
  { uid: 'staff_5', username: 'chef', email: 'chef@hotelsky5.com', role: 'CHEF', mysqlId: 5, displayName: 'DEV Chef' },
  { uid: 'staff_6', username: 'helper', email: 'helper@hotelsky5.com', role: 'KITCHEN_HELPER', mysqlId: 6, displayName: 'DEV Kitchen Helper' },
  { uid: 'staff_2', username: 'reception_morning', email: 'reception.morning@hotelsky5.com', role: 'RECEPTIONIST', mysqlId: 2, displayName: 'DEV Reception Morning' },
  { uid: 'staff_9', username: 'cleaner1', email: 'cleaner1@hotelsky5.com', role: 'CLEANER', mysqlId: 9, displayName: 'DEV Cleaner 1' },
  { uid: 'staff_10', username: 'cleaner2', email: 'cleaner2@hotelsky5.com', role: 'CLEANER', mysqlId: 10, displayName: 'DEV Cleaner 2' }
];

function claimsFor(acct) {
  return {
    role: acct.role,
    user_type: 'staff',
    staff_username: acct.username,
    staff_id: acct.username,
    mysql_id: acct.mysqlId,
    mysql_staff_id: acct.mysqlId,
    status: 'Active',
    deleted: 0
  };
}

function claimsDiffer(current, desired) {
  const cur = current || {};
  return Object.keys(desired).some(k => cur[k] !== desired[k]);
}

async function main() {
  // Determine up front whether any account is missing, so we can fail closed
  // on a missing password BEFORE creating anything (not partway through).
  const existing = new Map();
  for (const acct of ACCOUNTS) {
    try {
      existing.set(acct.uid, await auth.getUser(acct.uid));
    } catch {
      existing.set(acct.uid, null);
    }
  }
  const missing = ACCOUNTS.filter(a => !existing.get(a.uid));

  if (!DRY_RUN && missing.length > 0 && !process.env.DEV_SEED_STAFF_PASSWORD) {
    console.error(
      `[SAFETY_ABORT] ${missing.length} account(s) do not exist yet (${missing.map(a => a.username).join(', ')}) ` +
      `and DEV_SEED_STAFF_PASSWORD is not set. Refusing to create any user without an explicit password. ` +
      `Nothing was created.`
    );
    process.exit(1);
  }

  const summary = { created: 0, existing: 0, claimsUpdated: 0, unchanged: 0 };

  for (const acct of ACCOUNTS) {
    const desiredClaims = claimsFor(acct);
    const current = existing.get(acct.uid);

    if (!current) {
      if (DRY_RUN) {
        console.log(`  [DRY-RUN] would CREATE ${acct.username} (uid=${acct.uid}, email=${acct.email}) with claims role=${acct.role}`);
        summary.created++;
        continue;
      }
      // Password is read directly from env at the point of use and never
      // assigned to any variable that gets logged or persisted elsewhere.
      const newUser = await auth.createUser({
        uid: acct.uid,
        email: acct.email,
        emailVerified: true,
        displayName: acct.displayName,
        password: process.env.DEV_SEED_STAFF_PASSWORD,
        disabled: false
      });
      await auth.setCustomUserClaims(newUser.uid, desiredClaims);
      console.log(`  [CREATED] ${acct.username} (uid=${acct.uid}) — claims set, password set from DEV_SEED_STAFF_PASSWORD (not logged)`);
      summary.created++;
      continue;
    }

    summary.existing++;
    // Existing user: password is NEVER touched. Only claims are reconciled.
    if (claimsDiffer(current.customClaims, desiredClaims)) {
      if (DRY_RUN) {
        console.log(`  [DRY-RUN] would UPDATE CLAIMS for existing ${acct.username} (uid=${acct.uid}) — password left untouched`);
      } else {
        await auth.setCustomUserClaims(acct.uid, desiredClaims);
        console.log(`  [CLAIMS UPDATED] ${acct.username} (uid=${acct.uid}) — password left untouched`);
      }
      summary.claimsUpdated++;
    } else {
      console.log(`  [UNCHANGED] ${acct.username} (uid=${acct.uid}) — claims already correct, password untouched`);
      summary.unchanged++;
    }
  }

  console.log('\n' + '═'.repeat(78));
  console.log(`  ${DRY_RUN ? 'DRY-RUN COMPLETE — zero Auth writes performed' : 'PROVISIONING COMPLETE'}`);
  console.log(`  ${DRY_RUN ? 'Would create' : 'Created'}        : ${summary.created}`);
  console.log(`  Already existed           : ${summary.existing}`);
  console.log(`  Claims ${DRY_RUN ? '(would be) updated' : 'updated'}       : ${summary.claimsUpdated}`);
  console.log(`  Unchanged                 : ${summary.unchanged}`);
  console.log('═'.repeat(78));
  if (DRY_RUN) {
    console.log('\n  Re-run with DEV_SEED_STAFF_PASSWORD=<value> and --execute to actually provision.');
  }
}

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
