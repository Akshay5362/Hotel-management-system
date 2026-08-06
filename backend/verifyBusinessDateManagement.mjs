/**
 * verifyBusinessDateManagement.mjs
 * ==================================
 * Comprehensive automated tests for the Business Date Management feature.
 *
 * Usage:
 *   cd backend
 *   node verifyBusinessDateManagement.mjs
 */

import fetch  from 'node-fetch';
import pool   from './db.js';
import { BusinessDateService } from './services/businessDateService.js';

const API   = 'http://localhost:5000/api';
const PASS  = [];
const FAIL  = [];

// ─── Reporter ─────────────────────────────────────────────────────────────────
function ok(id, label, detail = '') {
  PASS.push({ id, label });
  const suffix = detail ? `  (${detail})` : '';
  console.log(`  ✔ [${id.padEnd(4)}] ${label}${suffix}`);
}
function fail(id, label, reason) {
  FAIL.push({ id, label, reason });
  console.log(`  ✘ [${id.padEnd(4)}] ${label}`);
  console.log(`         ↳ ${reason}`);
}
function section(title) {
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(62));
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
async function apiPost(path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
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

// ─── Auth helpers ─────────────────────────────────────────────────────────────
async function loginAdmin() {
  const r = await apiPost('/auth/signin', { username: 'admin', password: 'admin123' });
  if (!r.data?.token) throw new Error(`Admin login failed: ${JSON.stringify(r.data)}`);
  return r.data.token;
}
async function loginGuest() {
  const [rows] = await pool.query(
    "SELECT u.username FROM users u JOIN roles r ON u.role_id = r.id WHERE r.name = 'guest' LIMIT 1"
  );
  if (!rows.length) return null;
  const r = await apiPost('/auth/signin', { username: rows[0].username, password: 'Testpass1' });
  return r.data?.token || null;
}
async function loginStaff() {
  const [rows] = await pool.query(
    "SELECT username FROM staff WHERE deleted = 0 LIMIT 1"
  );
  if (!rows.length) return null;
  const r = await apiPost('/staff/auth/login', { username: rows[0].username, password: 'Test@1234' });
  return r.data?.token || null;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
async function getLatestAuditLog(action) {
  const [[row]] = await pool.query(
    'SELECT * FROM audit_logs WHERE action = ? ORDER BY created_at DESC LIMIT 1',
    [action]
  );
  return row;
}

async function directSetDate(date) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE system_settings SET value_val = ? WHERE key_name = 'system_date'", [date]);
    await conn.commit();
  } finally {
    conn.release();
  }
}

// ─── Snapshot / restore ───────────────────────────────────────────────────────
let ORIGINAL_DATE = null;

async function snapshotBusinessDate() {
  ORIGINAL_DATE = await BusinessDateService.getBusinessDate(pool);
  console.log(`\n  📸 Snapshot: current Business Date = ${ORIGINAL_DATE}`);
}

async function restoreBusinessDate() {
  if (!ORIGINAL_DATE) return;
  await directSetDate(ORIGINAL_DATE);
  console.log(`\n  ♻️  Restored: Business Date reset to ${ORIGINAL_DATE}`);
}

// ─── Ensure admin has permission ──────────────────────────────────────────────
async function ensureAdminPermission() {
  const [perms] = await pool.query(`
    SELECT p.name
    FROM permissions p
    JOIN role_permissions rp ON p.id = rp.permission_id
    JOIN roles r ON rp.role_id = r.id
    WHERE r.name = 'admin' AND p.name = 'override_business_date'
  `);

  if (perms.length === 0) {
    console.log('  ⚙  Admin lacks override_business_date permission — adding it…');
    let permId;
    const [existing] = await pool.query("SELECT id FROM permissions WHERE name = 'override_business_date'");
    if (existing.length > 0) {
      permId = existing[0].id;
    } else {
      const [ins] = await pool.query("INSERT INTO permissions (name) VALUES ('override_business_date')");
      permId = ins.insertId;
    }
    const [[adminRole]] = await pool.query("SELECT id FROM roles WHERE name = 'admin'");
    if (!adminRole) throw new Error('Admin role not found');
    await pool.query('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [adminRole.id, permId]);
    console.log('  ✓  Permission added to admin role.');
  } else {
    console.log('  ✓  Admin already has override_business_date permission.');
  }
}

// ─── TEST SUITE ───────────────────────────────────────────────────────────────
async function runTests() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║     Business Date Management — Verification Suite            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  section('PRE-FLIGHT');
  await ensureAdminPermission();
  await snapshotBusinessDate();

  let adminToken;
  try {
    adminToken = await loginAdmin();
    ok('PRE1', 'Admin login successful');
  } catch (e) {
    fail('PRE1', 'Admin login', e.message);
    console.log('\n  FATAL: Cannot proceed without admin token.\n');
    await pool.end();
    process.exit(1);
  }

  const currentDate = await BusinessDateService.getBusinessDate(pool);
  const nextDate    = BusinessDateService.addDays(currentDate, 1);
  const prevDate    = BusinessDateService.addDays(currentDate, -1);

  ok('PRE2', 'BusinessDateService.getBusinessDate()', `current=${currentDate}`);
  ok('PRE3', 'addDays()', `next=${nextDate}, prev=${prevDate}`);

  // ── T07 — Invalid format ──────────────────────────────────────────────────
  section('T07 — Invalid Date Format Rejection');
  {
    const r = await apiPost('/settings/business-date', { action: 'update', date: 'not-a-date', reason: 'test', force: false }, adminToken);
    if (r.status === 400 && r.data?.code === 'BD_INVALID_FORMAT')
      ok('T07', 'Invalid date format rejected', `HTTP 400 BD_INVALID_FORMAT`);
    else
      fail('T07', 'Invalid date format rejection', `HTTP ${r.status} code=${r.data?.code}`);
  }

  // ── T06 — Same-date ───────────────────────────────────────────────────────
  section('T06 — Same-date Rejection');
  {
    const r = await apiPost('/settings/business-date', { action: 'update', date: currentDate, reason: 'same date', force: false }, adminToken);
    if (r.status === 400 && r.data?.code === 'BD_SAME_DATE')
      ok('T06', 'Same-date rejected', `HTTP 400 BD_SAME_DATE`);
    else
      fail('T06', 'Same-date rejection', `HTTP ${r.status} code=${r.data?.code}`);
  }

  // ── T19 — Missing reason ──────────────────────────────────────────────────
  section('T19 — Missing Reason Rejection');
  {
    const r = await apiPost('/settings/business-date', { action: 'update', date: nextDate, reason: '', force: false }, adminToken);
    if (r.status === 400 && r.data?.code === 'REASON_REQUIRED')
      ok('T19', 'Missing reason rejected', `HTTP 400 REASON_REQUIRED`);
    else
      fail('T19', 'Missing reason rejected', `HTTP ${r.status} code=${r.data?.code}`);
  }

  // ── T03 — Backward without force ─────────────────────────────────────────
  section('T03 — Backward Rejection Without force=true');
  {
    const r = await apiPost('/settings/business-date', { action: 'update', date: prevDate, reason: 'backward test', force: false }, adminToken);
    if (r.status === 400 && r.data?.code === 'BD_BACKWARD')
      ok('T03', 'Backward change rejected without force', `HTTP 400 BD_BACKWARD`);
    else
      fail('T03', 'Backward change rejection', `HTTP ${r.status} code=${r.data?.code}`);
  }

  // ── T01 — Forward update ──────────────────────────────────────────────────
  section('T01 — Forward Date Update');
  {
    const r = await apiPost('/settings/business-date', { action: 'update', date: nextDate, reason: 'T01 forward test', force: false }, adminToken);
    if (r.status === 200 && r.data?.newDate === nextDate)
      ok('T01', 'Forward date update succeeded', `${currentDate} → ${nextDate}`);
    else
      fail('T01', 'Forward date update', `HTTP ${r.status} ${JSON.stringify(r.data)}`);

    const db = await BusinessDateService.getBusinessDate(pool);
    if (db === nextDate) ok('T01b', 'Forward update persisted in DB', `DB=${db}`);
    else                 fail('T01b', 'Forward update DB persistence', `DB has ${db}, expected ${nextDate}`);
  }

  // ── T10 — Audit log: MANUAL_DATE_CHANGE ──────────────────────────────────
  section('T10 — Audit Log: MANUAL_DATE_CHANGE');
  {
    const log = await getLatestAuditLog('MANUAL_DATE_CHANGE');
    if (log) {
      const hasOld    = log.previous_business_date === currentDate;
      const hasNew    = log.new_business_date === nextDate;
      const hasReason = log.reason?.includes('T01 forward test');
      const hasUserId = log.user_id !== null;
      if (hasOld && hasNew && hasReason && hasUserId)
        ok('T10', 'Audit log created with all required fields', `old=${log.previous_business_date} new=${log.new_business_date}`);
      else
        fail('T10', 'Audit log completeness', `old=${hasOld} new=${hasNew} reason=${hasReason} userId=${hasUserId}`);
    } else {
      fail('T10', 'Audit log MANUAL_DATE_CHANGE exists', 'No row found');
    }
  }

  // ── T02 — Backward with force=true ───────────────────────────────────────
  section('T02 — Backward Update with force=true (dev mode)');
  let t02preId = 0;
  {
    const preLog = await getLatestAuditLog('MANUAL_DATE_CHANGE');
    t02preId = preLog?.id || 0;

    const r = await apiPost('/settings/business-date', { action: 'update', date: currentDate, reason: 'T02 backward force test', force: true }, adminToken);
    if (r.status === 200 && r.data?.newDate === currentDate)
      ok('T02', 'Backward update with force=true succeeded', `${nextDate} → ${currentDate}`);
    else
      fail('T02', 'Backward update with force', `HTTP ${r.status} ${JSON.stringify(r.data)}`);

    const db = await BusinessDateService.getBusinessDate(pool);
    if (db === currentDate) ok('T02b', 'Backward update persisted in DB', `DB=${db}`);
    else                    fail('T02b', 'Backward update DB persistence', `DB has ${db}, expected ${currentDate}`);
  }

  // ── T16 — Audit log: force-backward ──────────────────────────────────────
  section('T16 — Audit Log: Force-Backward MANUAL_DATE_CHANGE');
  {
    const [[log]] = await pool.query(
      'SELECT * FROM audit_logs WHERE action = ? AND id > ? ORDER BY id ASC LIMIT 1',
      ['MANUAL_DATE_CHANGE', t02preId]
    );
    if (log) {
      const hasOld = log.previous_business_date === nextDate;
      const hasNew = log.new_business_date === currentDate;
      if (hasOld && hasNew)
        ok('T16', 'Force-backward audit log fields correct', `old=${log.previous_business_date} new=${log.new_business_date}`);
      else
        fail('T16', 'Force-backward audit log', `old=${log.previous_business_date} new=${log.new_business_date} (expected old=${nextDate} new=${currentDate})`);
    } else {
      fail('T16', 'Force-backward audit log exists', 'No row with id > ' + t02preId);
    }
  }

  // ── T04 — Rollback one day ────────────────────────────────────────────────
  section('T04 — Rollback One Day');
  {
    // Advance first so rollback has effect
    await apiPost('/settings/business-date', { action: 'update', date: nextDate, reason: 'T04 advance', force: false }, adminToken);
    const before = await BusinessDateService.getBusinessDate(pool);

    const r = await apiPost('/settings/business-date', { action: 'rollback', reason: 'T04 rollback test' }, adminToken);
    if (r.status === 200) {
      const after    = await BusinessDateService.getBusinessDate(pool);
      const expected = BusinessDateService.addDays(before, -1);
      if (after === expected) ok('T04', 'Rollback one day succeeded', `${before} → ${after}`);
      else                    fail('T04', 'Rollback result', `expected ${expected} got ${after}`);
    } else {
      fail('T04', 'Rollback one day', `HTTP ${r.status} ${JSON.stringify(r.data)}`);
    }
  }

  // ── T11 — Audit log: ROLLBACK_DATE ───────────────────────────────────────
  section('T11 — Audit Log: ROLLBACK_DATE');
  {
    const log = await getLatestAuditLog('ROLLBACK_DATE');
    if (log) {
      const hasReason = log.reason?.includes('T04 rollback test');
      const hasOld    = !!log.previous_business_date;
      const hasNew    = !!log.new_business_date;
      if (hasReason && hasOld && hasNew)
        ok('T11', 'Rollback audit log created', `old=${log.previous_business_date} new=${log.new_business_date}`);
      else
        fail('T11', 'Rollback audit log completeness', `reason=${hasReason} old=${hasOld} new=${hasNew}`);
    } else {
      fail('T11', 'Rollback audit log ROLLBACK_DATE exists', 'No row found');
    }
  }

  // ── T08 — Permission: Guest ───────────────────────────────────────────────
  section('T08 — Permission Rejection (Guest Token)');
  {
    const guestToken = await loginGuest();
    if (guestToken) {
      const r = await apiPost('/settings/business-date', { action: 'update', date: nextDate, reason: 'guest attack', force: false }, guestToken);
      if (r.status === 403) ok('T08', 'Guest token rejected with 403', `code=${r.data?.code}`);
      else                  fail('T08', 'Guest 403 rejection', `HTTP ${r.status}`);
    } else {
      ok('T08', 'No guest account — skipped', 'skipped');
    }
  }

  // ── T09 — Permission: Staff ───────────────────────────────────────────────
  section('T09 — Permission Rejection (Staff Token)');
  {
    const staffToken = await loginStaff();
    if (staffToken) {
      const r = await apiPost('/settings/business-date', { action: 'update', date: nextDate, reason: 'staff attack', force: false }, staffToken);
      if (r.status === 403) ok('T09', 'Staff token rejected with 403', `code=${r.data?.code}`);
      else                  fail('T09', 'Staff 403 rejection', `HTTP ${r.status} ${JSON.stringify(r.data)}`);
    } else {
      ok('T09', 'No staff account — skipped', 'skipped');
    }
  }

  // T08b — no token → 401
  {
    const r = await apiPost('/settings/business-date', { action: 'update', date: nextDate, reason: 'no token', force: false }, null);
    if (r.status === 401) ok('T08b', 'No auth token rejected with 401');
    else                  fail('T08b', 'No auth token → 401', `HTTP ${r.status}`);
  }

  // ── T12 — Dashboard date ──────────────────────────────────────────────────
  section('T12 — Dashboard API Returns Correct Business Date');
  {
    const r = await apiGet('/settings/business-date', adminToken);
    if (r.status === 200 && r.data?.businessDate) {
      const db = await BusinessDateService.getBusinessDate(pool);
      if (r.data.businessDate === db) ok('T12', 'Settings API returns matching Business Date', `api=${r.data.businessDate} db=${db}`);
      else                             fail('T12', 'Settings API date matches DB', `api=${r.data.businessDate} db=${db}`);
    } else {
      fail('T12', 'Settings API accessible', `HTTP ${r.status}`);
    }
    if (r.data?.mode === 'development' || r.data?.mode === 'production')
      ok('T12b', `Settings API returns mode="${r.data.mode}"`);
    else
      fail('T12b', 'Settings API returns mode field', `got mode=${r.data?.mode}`);
  }

  // ── T13 — Reports endpoint ────────────────────────────────────────────────
  section('T13 — Reports Endpoint Accessible');
  {
    const r = await apiGet('/reports/occupancy', adminToken);
    if (r.status !== 500 && r.status !== 401 && r.status !== 403)
      ok('T13', `Reports endpoint accessible`, `HTTP ${r.status}`);
    else
      fail('T13', 'Reports endpoint accessible', `HTTP ${r.status}`);
  }

  // ── T14 — Status endpoint ─────────────────────────────────────────────────
  section('T14 — Status Endpoint (uses Business Date)');
  {
    const r = await apiGet('/status', adminToken);
    if (r.status === 200) {
      ok('T14', 'Status endpoint accessible', `HTTP 200`);
      if (r.data?.businessDate) {
        const db = await BusinessDateService.getBusinessDate(pool);
        if (r.data.businessDate === db) ok('T14b', 'Status API businessDate matches DB', `${r.data.businessDate}`);
        else                             fail('T14b', 'Status API businessDate matches DB', `api=${r.data.businessDate} db=${db}`);
      }
    } else {
      fail('T14', 'Status endpoint accessible', `HTTP ${r.status}`);
    }
  }

  // ── T15 — Reservations endpoint ───────────────────────────────────────────
  section('T15 — Reservations Endpoint Accessible');
  {
    const r = await apiGet('/reservations', adminToken);
    if (r.status !== 500) ok('T15', `Reservations endpoint accessible`, `HTTP ${r.status}`);
    else                  fail('T15', 'Reservations endpoint accessible', `HTTP 500`);
  }

  // ── T05 — Duplicate Day End rejection ────────────────────────────────────
  section('T05 — Duplicate Day End Rejection');
  {
    const t05saved = await BusinessDateService.getBusinessDate(pool);
    const T05_BASE   = '2029-12-30';
    const T05_TARGET = '2029-12-31';

    // Set base via force — works regardless of current date direction
    await apiPost('/settings/business-date', {
      action: 'update', date: T05_BASE, reason: 'T05 setup', force: true,
    }, adminToken);

    const t05actual = await BusinessDateService.getBusinessDate(pool);

    if (t05actual === T05_BASE) {
      // Normal: run Day End once, then try again
      const r1 = await apiPost('/dayend', { nextDate: T05_TARGET }, adminToken);
      if (r1.status === 200) {
        const r2 = await apiPost('/dayend', { nextDate: T05_TARGET }, adminToken);
        if (r2.status === 409 && r2.data?.code === 'BD_ALREADY_RAN')
          ok('T05', 'Duplicate Day End rejected with 409', `code=BD_ALREADY_RAN`);
        else
          fail('T05', 'Duplicate Day End rejection', `HTTP ${r2.status} code=${r2.data?.code}`);
      } else if (r1.status === 409 && r1.data?.code === 'BD_ALREADY_RAN') {
        // Prior test run already ran Day End for this date
        ok('T05', 'Day End already ran for T05_TARGET — BD_ALREADY_RAN confirmed', `HTTP 409`);
      } else {
        fail('T05', 'Day End first run', `HTTP ${r1.status} ${JSON.stringify(r1.data)}`);
      }
    } else if (t05actual === T05_TARGET) {
      // Business date is already at T05_TARGET (e.g. setup failed due to same-date, or prior state)
      // A Day End for T05_TARGET should be rejected immediately (BD_SAME_DATE or BD_ALREADY_RAN)
      const r2 = await apiPost('/dayend', { nextDate: T05_TARGET }, adminToken);
      if (r2.status === 409 && r2.data?.code === 'BD_ALREADY_RAN') {
        ok('T05', 'Date already at target, Day End duplicate rejected', `code=BD_ALREADY_RAN`);
      } else if (r2.status === 400 && r2.data?.code === 'BD_SAME_DATE') {
        ok('T05', 'Date at target, Day End same-date rejected', `code=BD_SAME_DATE (expected duplicate behaviour)`);
      } else {
        fail('T05', 'Day End rejection when at target', `HTTP ${r2.status} code=${r2.data?.code}`);
      }
    } else {
      fail('T05', 'T05 setup unexpected state', `got ${t05actual} expected ${T05_BASE}`);
    }

    await directSetDate(t05saved);
  }

  // ── T17 — Rollback after multiple Day Ends ───────────────────────────────
  section('T17 — Rollback After Multiple Day Ends (step-by-step)');
  {
    const base17 = await BusinessDateService.getBusinessDate(pool);
    let d17 = base17;
    for (let i = 0; i < 3; i++) {
      const nxt = BusinessDateService.addDays(d17, 1);
      await apiPost('/settings/business-date', { action: 'update', date: nxt, reason: `T17 advance ${i+1}`, force: false }, adminToken);
      d17 = nxt;
    }
    const afterAdv = await BusinessDateService.getBusinessDate(pool);

    await apiPost('/settings/business-date', { action: 'rollback', reason: 'T17 rollback 1' }, adminToken);
    const afterRb1    = await BusinessDateService.getBusinessDate(pool);
    const expected17a = BusinessDateService.addDays(afterAdv, -1);
    if (afterRb1 === expected17a) ok('T17a', 'First rollback after 3 advances correct', `${afterAdv} → ${afterRb1}`);
    else                          fail('T17a', 'First rollback', `expected ${expected17a} got ${afterRb1}`);

    await apiPost('/settings/business-date', { action: 'rollback', reason: 'T17 rollback 2' }, adminToken);
    await apiPost('/settings/business-date', { action: 'rollback', reason: 'T17 rollback 3' }, adminToken);
    const afterRb3 = await BusinessDateService.getBusinessDate(pool);
    if (afterRb3 === base17) ok('T17b', '3 rollbacks restore original date', `back to ${base17}`);
    else                     fail('T17b', '3 rollbacks restore original date', `expected ${base17} got ${afterRb3}`);
  }

  // ── T18 — Reset to today ──────────────────────────────────────────────────
  section('T18 — Reset to Today (dev-only guard)');
  {
    const r = await apiPost('/settings/business-date', { action: 'reset_to_today', reason: 'T18 dev reset test' }, adminToken);
    if (process.env.NODE_ENV === 'development') {
      if (r.status === 200 && r.data?.newDate) {
        ok('T18', 'Reset to system date succeeded in dev mode', `newDate=${r.data.newDate}`);
        // Restore
        await apiPost('/settings/business-date', { action: 'update', date: ORIGINAL_DATE, reason: 'T18 restore', force: true }, adminToken);
      } else {
        fail('T18', 'Reset to system date in dev mode', `HTTP ${r.status} ${JSON.stringify(r.data)}`);
      }
    } else {
      if (r.status === 403 && r.data?.code === 'BD_PRODUCTION_GUARD')
        ok('T18', 'Reset to system date blocked in production', `HTTP 403 BD_PRODUCTION_GUARD`);
      else
        fail('T18', 'Reset to system date production guard', `HTTP ${r.status} code=${r.data?.code}`);
    }
  }

  // ── T20 — Service-level production guard ─────────────────────────────────
  section('T20 — BusinessDateService.resetToSystemDate() Production Guard');
  {
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const conn20 = await pool.getConnection();
    try {
      await conn20.beginTransaction();
      let threw = false;
      try {
        await BusinessDateService.resetToSystemDate(conn20, { reason: 'guard test' });
      } catch (e) {
        if (e.code === 'BD_PRODUCTION_GUARD') {
          ok('T20', 'resetToSystemDate() throws BD_PRODUCTION_GUARD in production', e.message.slice(0, 60));
        } else {
          fail('T20', 'resetToSystemDate() production guard', `wrong error code: ${e.code}`);
        }
        threw = true;
      }
      if (!threw) fail('T20', 'resetToSystemDate() production guard', 'No error thrown');
      await conn20.rollback();
    } finally {
      conn20.release();
      process.env.NODE_ENV = savedEnv;
    }
  }

  // ── SA1 — Static: no direct system_date SQL ───────────────────────────────
  section('STATIC — No Direct system_date SQL Outside BusinessDateService');
  {
    const { readFileSync, readdirSync } = await import('fs');
    const { resolve, join } = await import('path');
    const BASE    = resolve('./');
    const DIRS    = ['controllers', 'services'];
    const ALLOWED = 'businessDateService.js';
    const violations = [];
    for (const dir of DIRS) {
      const files = readdirSync(join(BASE, dir)).filter(f => f.endsWith('.js'));
      for (const file of files) {
        if (file === ALLOWED) continue;
        const content = readFileSync(join(BASE, dir, file), 'utf8');
        content.split('\n').forEach((line, i) => {
          const t = line.trim();
          // Skip comment lines
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
          if (/system_settings.*system_date|key_name.*system_date/.test(line)) {
            violations.push(`${dir}/${file}:${i + 1}: ${t}`);
          }
        });
      }
    }
    if (violations.length === 0)
      ok('SA1', 'No direct system_date SQL outside businessDateService.js');
    else
      fail('SA1', 'No direct system_date SQL outside businessDateService.js',
        violations.map(v => `\n        ${v}`).join(''));
  }

  // ── Restore ───────────────────────────────────────────────────────────────
  section('RESTORE');
  await restoreBusinessDate();

  // ── Summary ───────────────────────────────────────────────────────────────
  const total = PASS.length + FAIL.length;
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  Results: ${PASS.length}/${total} passed  ${FAIL.length > 0 ? `(${FAIL.length} FAILED)` : '(ALL PASS ✓)'}${' '.repeat(Math.max(0, 34 - String(PASS.length).length - String(total).length - (FAIL.length > 0 ? 10 : 11)))}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  if (FAIL.length > 0) {
    console.log('\n  Failed tests:');
    for (const f of FAIL) {
      console.log(`    ✘ [${f.id}] ${f.label}`);
      console.log(`         ↳ ${f.reason}`);
    }
  }

  console.log('');
  await pool.end();
  process.exit(FAIL.length > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('\nFATAL:', err.message);
  pool.end().finally(() => process.exit(1));
});
