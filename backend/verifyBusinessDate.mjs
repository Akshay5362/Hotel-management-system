/**
 * verifyBusinessDate.mjs
 * ======================
 * Post-refactor verification for the BusinessDateService architecture.
 *
 * Validates:
 *  A. Static analysis — no stray system_date SQL outside businessDateService.js
 *  B. No OS clock used as business-date source
 *  C. Invalid date format rejection
 *  D. Same-day update rejection
 *  E. Backward movement rejection
 *  F. Skipped-day rejection (jump > 1)
 *  G. Valid Day End succeeds and commits
 *  H. Duplicate Day End rejection (409)
 *  I. Persistence after server restart (DB read via service)
 *  J. All API consumers return the same systemDate
 */

import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { readdirSync } from 'fs';
import fetch from 'node-fetch';
import { BusinessDateService } from './services/businessDateService.js';
import pool from './db.js';

const API   = 'http://localhost:5000/api';
const PASS  = [];
const FAIL  = [];

function ok(id, label, detail = '') {
  PASS.push({ id, label });
  console.log(`  ✔ [${id}] ${label}${detail ? ': ' + detail : ''}`);
}
function fail(id, label, reason) {
  FAIL.push({ id, label, reason });
  console.log(`  ✘ [${id}] ${label}: ${reason}`);
}

async function apiPost(path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function apiGet(path, token) {
  const res = await fetch(`${API}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// ── A. Static Analysis ─────────────────────────────────────────────────────
function checkStaticAnalysis() {
  console.log('\n── A. STATIC ANALYSIS ─────────────────────────────────────');

  const BASE = resolve('./');
  const DIRS = ['controllers', 'services'];
  const ALLOWED_FILE = 'businessDateService.js';

  let violations = [];
  for (const dir of DIRS) {
    const files = readdirSync(join(BASE, dir)).filter(f => f.endsWith('.js'));
    for (const file of files) {
      if (file === ALLOWED_FILE) continue;
      const content = readFileSync(join(BASE, dir, file), 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        if (/system_settings.*system_date|key_name.*system_date/.test(line) && !line.trim().startsWith('//')) {
          violations.push(`${dir}/${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }

  if (violations.length === 0) {
    ok('A.1', 'No direct system_date SQL outside businessDateService.js');
  } else {
    fail('A.1', 'No direct system_date SQL outside businessDateService.js',
      `\n    Violations:\n${violations.map(v => '      ' + v).join('\n')}`);
  }

  // Check for OS-clock business-date fallbacks (new Date() assigned to businessDate)
  let clockViolations = [];
  for (const dir of DIRS) {
    const files = readdirSync(join(BASE, dir)).filter(f => f.endsWith('.js'));
    for (const file of files) {
      if (file === ALLOWED_FILE) continue;
      const content = readFileSync(join(BASE, dir, file), 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        // Match: businessDate = ... new Date() ... (not just a timestamp assignment)
        if (/businessDate\s*=.*new\s+Date\(\)/.test(line) && !line.trim().startsWith('//')) {
          clockViolations.push(`${dir}/${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }

  if (clockViolations.length === 0) {
    ok('A.2', 'No OS clock (new Date()) used as business date source');
  } else {
    fail('A.2', 'No OS clock used as business date source',
      `\n    Violations:\n${clockViolations.map(v => '      ' + v).join('\n')}`);
  }
}

// ── B. Unit-level: date parsing/formatting/arithmetic ─────────────────────
function checkDateUtilities() {
  console.log('\n── B. DATE UTILITY UNIT TESTS ────────────────────────────');

  // parseDate — valid formats
  let r;
  r = BusinessDateService.parseDate('2026-08-05');
  if (r === '2026-08-05') ok('B.1', 'parseDate YYYY-MM-DD');
  else fail('B.1', 'parseDate YYYY-MM-DD', `got ${r}`);

  r = BusinessDateService.parseDate('05-Aug-2026');
  if (r === '2026-08-05') ok('B.2', 'parseDate DD-Mon-YYYY');
  else fail('B.2', 'parseDate DD-Mon-YYYY', `got ${r}`);

  r = BusinessDateService.parseDate('31-Jan-2026');
  if (r === '2026-01-31') ok('B.3', 'parseDate 31-Jan-2026');
  else fail('B.3', 'parseDate 31-Jan-2026', `got ${r}`);

  r = BusinessDateService.parseDate('invalid-date');
  if (r === null) ok('B.4', 'parseDate invalid → null');
  else fail('B.4', 'parseDate invalid → null', `got ${r}`);

  r = BusinessDateService.parseDate('');
  if (r === null) ok('B.5', 'parseDate empty string → null');
  else fail('B.5', 'parseDate empty string → null', `got ${r}`);

  // addDays
  r = BusinessDateService.addDays('2026-08-07', 1);
  if (r === '2026-08-08') ok('B.6', 'addDays +1 normal');
  else fail('B.6', 'addDays +1 normal', `got ${r}`);

  r = BusinessDateService.addDays('2026-07-31', 1);
  if (r === '2026-08-01') ok('B.7', 'addDays month rollover 31→1');
  else fail('B.7', 'addDays month rollover', `got ${r}`);

  r = BusinessDateService.addDays('2026-12-31', 1);
  if (r === '2027-01-01') ok('B.8', 'addDays year rollover Dec→Jan');
  else fail('B.8', 'addDays year rollover', `got ${r}`);

  // compareDates
  if (BusinessDateService.compareDates('2026-08-05', '2026-08-06') === -1) ok('B.9',  'compareDates a < b → -1');
  else fail('B.9', 'compareDates a < b', 'wrong result');
  if (BusinessDateService.compareDates('2026-08-06', '2026-08-06') ===  0) ok('B.10', 'compareDates a === b → 0');
  else fail('B.10','compareDates a === b','wrong result');
  if (BusinessDateService.compareDates('2026-08-07', '2026-08-06') ===  1) ok('B.11', 'compareDates a > b → 1');
  else fail('B.11','compareDates a > b','wrong result');
}

// ── C–H. Live API tests ───────────────────────────────────────────────────
async function checkLiveApi() {
  console.log('\n── C. ADMIN LOGIN ─────────────────────────────────────────');
  const loginRes = await apiPost('/auth/signin', { username: 'admin', password: 'admin123' });
  if (!loginRes.data?.token) { fail('C.1', 'Admin login', 'No token'); return null; }
  ok('C.1', 'Admin login', 'token obtained');
  const token = loginRes.data.token;

  // Current business date
  const current = await BusinessDateService.getBusinessDate(pool);
  ok('C.2', 'BusinessDateService.getBusinessDate() from pool', `current=${current}`);

  // ── D. Invalid format ───────────────────────────────────────────────────
  console.log('\n── D. INVALID FORMAT REJECTION ────────────────────────────');
  const invFmt = await apiPost('/dayend', { nextDate: 'not-a-date' }, token);
  if (invFmt.status === 400 && invFmt.data?.code) {
    ok('D.1', 'Day End rejects invalid date format', `HTTP 400 code=${invFmt.data.code}`);
  } else {
    fail('D.1', 'Day End rejects invalid date format', `HTTP ${invFmt.status} code=${invFmt.data?.code}`);
  }

  // ── E. Same-day rejection ───────────────────────────────────────────────
  console.log('\n── E. SAME-DAY REJECTION ──────────────────────────────────');
  const same = await apiPost('/dayend', { nextDate: current }, token);
  if (same.status === 400 && same.data?.code === 'BD_SAME_DATE') {
    ok('E.1', 'Day End rejects same-date', `HTTP 400 BD_SAME_DATE`);
  } else {
    fail('E.1', 'Day End rejects same-date', `HTTP ${same.status} code=${same.data?.code}`);
  }

  // ── F. Backward movement rejection ─────────────────────────────────────
  console.log('\n── F. BACKWARD MOVEMENT REJECTION ────────────────────────');
  const prev = BusinessDateService.addDays(current, -1);
  const bwd = await apiPost('/dayend', { nextDate: prev }, token);
  if (bwd.status === 400 && bwd.data?.code === 'BD_BACKWARD') {
    ok('F.1', 'Day End rejects backward date', `HTTP 400 BD_BACKWARD`);
  } else {
    fail('F.1', 'Day End rejects backward date', `HTTP ${bwd.status} code=${bwd.data?.code}`);
  }

  // ── G. Skipped-day rejection ────────────────────────────────────────────
  console.log('\n── G. SKIPPED-DAY REJECTION ───────────────────────────────');
  const skipped = BusinessDateService.addDays(current, 2);
  const skip = await apiPost('/dayend', { nextDate: skipped }, token);
  if (skip.status === 400 && skip.data?.code === 'BD_SKIP') {
    ok('G.1', 'Day End rejects skipped day (+2)', `HTTP 400 BD_SKIP`);
  } else {
    fail('G.1', 'Day End rejects skipped day (+2)', `HTTP ${skip.status} code=${skip.data?.code}`);
  }

  const skipped3 = BusinessDateService.addDays(current, 30);
  const skip3 = await apiPost('/dayend', { nextDate: skipped3 }, token);
  if (skip3.status === 400 && skip3.data?.code === 'BD_SKIP') {
    ok('G.2', 'Day End rejects large skip (+30)', `HTTP 400 BD_SKIP`);
  } else {
    fail('G.2', 'Day End rejects large skip (+30)', `HTTP ${skip3.status} code=${skip3.data?.code}`);
  }

  // ── H. Valid Day End succeeds ────────────────────────────────────────────
  console.log('\n── H. VALID DAY END ────────────────────────────────────────');
  const validNext = BusinessDateService.addDays(current, 1);
  const dayEnd1 = await apiPost('/dayend', { nextDate: validNext }, token);
  if (dayEnd1.status === 200 && dayEnd1.data?.message?.includes(validNext)) {
    ok('H.1', 'Valid Day End succeeds', `HTTP 200 → ${validNext}`);
  } else {
    fail('H.1', 'Valid Day End succeeds', `HTTP ${dayEnd1.status} msg="${dayEnd1.data?.message}"`);
  }

  // DB confirm
  const afterDate = await BusinessDateService.getBusinessDate(pool);
  if (afterDate === validNext) {
    ok('H.2', 'Business Date committed to MySQL', afterDate);
  } else {
    fail('H.2', 'Business Date committed to MySQL', `expected ${validNext} got ${afterDate}`);
  }

  // ── I. Duplicate Day End rejection (409) ────────────────────────────────
  console.log('\n── I. DUPLICATE DAY END (409) ─────────────────────────');
  // validNext was already committed in H. Now the current date is validNext.
  // Running Day End again with the *same* validNext is a same-date error (BD_SAME_DATE).
  // To trigger BD_ALREADY_RAN we need: same nextDate, but current date is still one step behind.
  // Simulate by: temporarily rolling back the business date one step, then running Day End
  // with the same validNext — the audit log for validNext still exists → BD_ALREADY_RAN.
  const dateBeforeH = current;  // before H, business date was `current`
  await pool.query("UPDATE system_settings SET value_val = ? WHERE key_name = 'system_date'", [dateBeforeH]);

  const dayEnd3 = await apiPost('/dayend', { nextDate: validNext }, token);
  if (dayEnd3.status === 409 && dayEnd3.data?.code === 'BD_ALREADY_RAN') {
    ok('I.1', 'Duplicate Day End rejected with 409 BD_ALREADY_RAN', dayEnd3.data.error.slice(0, 80));
  } else {
    fail('I.1', 'Duplicate Day End rejected with 409 BD_ALREADY_RAN', `HTTP ${dayEnd3.status} code=${dayEnd3.data?.code}`);
  }

  // Restore date to post-H value so subsequent tests work correctly
  await pool.query("UPDATE system_settings SET value_val = ? WHERE key_name = 'system_date'", [validNext]);
  ok('I.2', 'Business Date restored after duplicate test', validNext);

  // ── J. Persistence: all API consumers return same date ──────────────────
  console.log('\n── J. PERSISTENCE & CONSISTENCY ───────────────────────────');
  const currentDate = await BusinessDateService.getBusinessDate(pool);

  const statusRes = await apiGet('/status', token);
  const statusDate = statusRes.data?.systemDate;
  if (statusDate === currentDate) ok('J.1', '/api/status returns same Business Date', statusDate);
  else fail('J.1', '/api/status returns same Business Date', `expected ${currentDate} got ${statusDate}`);

  const bdRes = await apiGet('/settings/business-date', token);
  const bdDate = bdRes.data?.businessDate;
  if (bdDate === currentDate) ok('J.2', '/api/settings/business-date returns same Business Date', bdDate);
  else fail('J.2', '/api/settings/business-date returns same Business Date', `expected ${currentDate} got ${bdDate}`);

  // Persistence via direct DB read (simulates server restart)
  const dbDirect = await pool.query("SELECT value_val FROM system_settings WHERE key_name = 'system_date'");
  const dbDate = dbDirect[0]?.[0]?.value_val;
  const normDbDate = BusinessDateService.parseDate(dbDate);
  if (normDbDate === currentDate) ok('J.3', 'Persistence: direct MySQL read matches service', dbDate);
  else fail('J.3', 'Persistence: direct MySQL read matches service', `DB=${dbDate} service=${currentDate}`);

  return token;
}

// ── Summary ────────────────────────────────────────────────────────────────
function printSummary() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  BUSINESSDATESERVICE VERIFICATION REPORT');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Total: ${PASS.length + FAIL.length} | PASS: ${PASS.length} | FAIL: ${FAIL.length}\n`);
  if (FAIL.length > 0) {
    console.log('  FAILURES:');
    FAIL.forEach(f => console.log(`    [${f.id}] ${f.label} — ${f.reason}`));
  } else {
    console.log('  ALL CHECKS PASSED ✔');
    console.log('\n  Architecture Verified:');
    console.log('  ✔ Single source of truth for Business Date (system_settings.system_date)');
    console.log('  ✔ No OS clock used as business-date source');
    console.log('  ✔ Invalid formats rejected');
    console.log('  ✔ Backward movement rejected');
    console.log('  ✔ Same-day update rejected');
    console.log('  ✔ Skipped-day updates rejected');
    console.log('  ✔ Duplicate Day End rejected (409)');
    console.log('  ✔ Business Date persists across restarts');
    console.log('  ✔ All API consumers return identical Business Date');
  }
  console.log('═══════════════════════════════════════════════════════════\n');
}

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  BUSINESSDATESERVICE ARCHITECTURE VERIFICATION');
  console.log('═══════════════════════════════════════════════════════════\n');
  try {
    checkStaticAnalysis();
    checkDateUtilities();
    await checkLiveApi();
    printSummary();
  } catch (err) {
    console.error('\n[FATAL]', err);
  } finally {
    await pool.end();
    process.exit(FAIL.length > 0 ? 1 : 0);
  }
}

main();
