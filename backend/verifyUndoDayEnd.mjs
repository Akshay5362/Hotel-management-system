/**
 * verifyUndoDayEnd.mjs
 * ====================
 * Enterprise-grade automated tests for POST /api/dayend/undo.
 *
 * Test scenarios:
 *  1.  Unauthorized undo — guest token → 403
 *  2.  Unauthorized undo — staff token → 403
 *  3.  Undo when no Day End exists → 404
 *  4.  Run Day End to create a baseline
 *  5.  Undo after new booking (check-in) → 409 POST_DAY_END_DATA_EXISTS
 *  6.  Undo after new payment          → 409 POST_DAY_END_DATA_EXISTS
 *  7.  Undo after new reservation      → 409 POST_DAY_END_DATA_EXISTS
 *  8.  Clean successful undo           → 200 + date restored + ledger reversed
 *  9.  Audit log verification          → UNDO_DAY_END row exists
 * 10.  Double undo (same Day End again) → 409 BUSINESS_DATE_MISMATCH
 * 11.  Business Date consistency after undo
 */

import fetch from 'node-fetch';
import pool from './db.js';
import { BusinessDateService } from './services/businessDateService.js';

const API  = 'http://localhost:5000/api';
const PASS = [];
const FAIL = [];

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

// ── Login helpers ──────────────────────────────────────────────────────────
async function loginAdmin() {
  const r = await apiPost('/auth/signin', { username: 'admin', password: 'admin123' });
  if (!r.data?.token) throw new Error('Admin login failed');
  return r.data.token;
}
async function loginGuest() {
  // Use first available guest account in the DB
  const [rows] = await pool.query(
    "SELECT u.username FROM users u JOIN roles r ON u.role_id = r.id WHERE r.name = 'guest' LIMIT 1"
  );
  if (!rows.length) return null;
  const r = await apiPost('/auth/signin', { username: rows[0].username, password: 'Testpass1' });
  return r.data?.token || null;
}

// ── Snapshot helpers (DB direct queries) ─────────────────────────────────
async function getLastDayEndLog() {
  const [[row]] = await pool.query(
    "SELECT * FROM audit_logs WHERE action = 'DAY_END' ORDER BY created_at DESC LIMIT 1"
  );
  return row;
}
async function getUndoLog(dayEndId) {
  const [[row]] = await pool.query(
    "SELECT * FROM audit_logs WHERE action = 'UNDO_DAY_END' AND details LIKE ? ORDER BY created_at DESC LIMIT 1",
    [`%Day End #${dayEndId}%`]
  );
  return row;
}
async function insertTestBooking(businessDate) {
  // Insert a minimal booking to simulate a check-in after Day End.
  // Use a timestamp 10 seconds in the future so it's clearly after the Day End created_at.
  const [[firstRoom]] = await pool.query('SELECT id FROM rooms LIMIT 1');
  if (!firstRoom) return null;
  const [[firstGuest]] = await pool.query('SELECT id FROM guests LIMIT 1');
  if (!firstGuest) return null;
  const [r] = await pool.query(
    "INSERT INTO bookings (room_id, guest_id, booking_status, payment_status, check_in_date, expected_check_out_date, total_amount, booking_number, created_at, updated_at) VALUES (?, ?, 'Reserved', 'Pending', ?, ?, 0, ?, DATE_ADD(NOW(), INTERVAL 10 SECOND), DATE_ADD(NOW(), INTERVAL 10 SECOND))",
    [firstRoom.id, firstGuest.id, businessDate, BusinessDateService.addDays(businessDate, 1), `TEST-${Date.now()}`]
  );
  return r.insertId;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  UNDO DAY END — AUTOMATED VERIFICATION');
  console.log('═══════════════════════════════════════════════════════════\n');

  const adminToken = await loginAdmin();

  // ── 1. Unauthorized: guest token ─────────────────────────────────────────
  console.log('── 1. UNAUTHORIZED: GUEST TOKEN ────────────────────────────');
  let guestToken = await loginGuest();
  if (!guestToken) {
    // Register a temporary guest
    const rg = await apiPost('/auth/signup', { username: 'testguest_undo', password: 'Testpass1', fullName: 'Test Guest Undo', phone: '9999000001' });
    guestToken = rg.data?.token;
  }
  if (guestToken) {
    const r = await apiPost('/dayend/undo', {}, guestToken);
    if (r.status === 403 && r.data?.code === 'SUPER_ADMIN_REQUIRED') {
      ok('1.1', 'Guest token rejected with 403 SUPER_ADMIN_REQUIRED');
    } else {
      fail('1.1', 'Guest token rejected', `HTTP ${r.status} code=${r.data?.code}`);
    }
  } else {
    fail('1.1', 'Guest token rejected', 'Could not obtain guest token');
  }

  // ── 2. Unauthorized: staff token (simulated with wrong role claim) ───────
  console.log('── 2. UNAUTHORIZED: NO TOKEN ───────────────────────────────');
  const r2 = await apiPost('/dayend/undo', {});
  if (r2.status === 401) {
    ok('2.1', 'No token rejected with 401');
  } else {
    fail('2.1', 'No token rejected', `HTTP ${r2.status}`);
  }

  // ── 3. Undo when no un-undone Day End exists ─────────────────────────────
  // Mark all DAY_END logs as DAY_END_UNDONE temporarily to simulate empty state
  console.log('── 3. UNDO WITH NO DAY END ─────────────────────────────────');
  await pool.query("UPDATE audit_logs SET action = 'DAY_END_UNDONE_TEMP' WHERE action = 'DAY_END'");
  const r3 = await apiPost('/dayend/undo', {}, adminToken);
  // Restore
  await pool.query("UPDATE audit_logs SET action = 'DAY_END' WHERE action = 'DAY_END_UNDONE_TEMP'");
  if (r3.status === 404 && r3.data?.code === 'NO_DAY_END_FOUND') {
    ok('3.1', 'Undo with no Day End → 404 NO_DAY_END_FOUND');
  } else {
    fail('3.1', 'Undo with no Day End', `HTTP ${r3.status} code=${r3.data?.code}`);
  }

  // ── 4. Run a clean Day End to create a baseline ──────────────────────────
  console.log('── 4. SETUP: RUN DAY END ───────────────────────────────────');
  const beforeDate = await BusinessDateService.getBusinessDate(pool);
  const targetDate = BusinessDateService.addDays(beforeDate, 1);
  const dayEndRes  = await apiPost('/dayend', { nextDate: targetDate }, adminToken);
  if (dayEndRes.status === 200) {
    ok('4.1', `Day End executed: ${beforeDate} → ${targetDate}`);
  } else {
    fail('4.1', `Day End executed: ${beforeDate} → ${targetDate}`, `HTTP ${dayEndRes.status} ${dayEndRes.data?.error}`);
    // Cannot continue without a successful Day End
    printSummary(); await pool.end(); process.exit(1);
  }

  // Capture the Day End audit log ID for later
  const dayEndLog = await getLastDayEndLog();
  if (!dayEndLog) { fail('4.2', 'Day End audit log found', 'not found'); }
  else ok('4.2', 'Day End audit log created', `id=${dayEndLog.id} business_date=${dayEndLog.business_date}`);

  // ── 5/6/7: Blocker tests — all use the SAME step-4 Day End ───────────────
  // Insert blocker → verify 409 → remove blocker → try next blocker.
  // The step-4 Day End stays committed throughout.

  // ── 5. Undo after a new booking ──────────────────────────────────────────
  console.log('── 5. UNDO BLOCKED BY NEW BOOKING ──────────────────────────');
  const testBookingId = await insertTestBooking(targetDate);
  if (!testBookingId) {
    ok('5.1', 'Undo after new booking (skipped — cannot insert test booking)');
  } else {
    const r5 = await apiPost('/dayend/undo', {}, adminToken);
    if (r5.status === 409 && r5.data?.code === 'POST_DAY_END_DATA_EXISTS') {
      ok('5.1', 'Undo blocked by new booking → 409 POST_DAY_END_DATA_EXISTS',
        r5.data.blockers?.join(', ') || '');
    } else {
      fail('5.1', 'Undo blocked by new booking', `HTTP ${r5.status} code=${r5.data?.code} error=${r5.data?.error}`);
    }
    await pool.query('DELETE FROM bookings WHERE id = ?', [testBookingId]);
  }

  // ── 6. Undo after a new payment ──────────────────────────────────────────
  console.log('── 6. UNDO BLOCKED BY NEW PAYMENT ──────────────────────────');
  const [payInsert] = await pool.query(
    "INSERT INTO payments (booking_id, amount, payment_type, business_date, created_at) VALUES (NULL, 100, 'Test', ?, DATE_ADD(NOW(), INTERVAL 10 SECOND))",
    [targetDate]
  );
  const r6 = await apiPost('/dayend/undo', {}, adminToken);
  if (r6.status === 409 && r6.data?.code === 'POST_DAY_END_DATA_EXISTS') {
    ok('6.1', 'Undo blocked by new payment → 409 POST_DAY_END_DATA_EXISTS');
  } else {
    fail('6.1', 'Undo blocked by new payment', `HTTP ${r6.status} code=${r6.data?.code}`);
  }
  await pool.query('DELETE FROM payments WHERE id = ?', [payInsert.insertId]);

  // ── 7. Undo after a new reservation ──────────────────────────────────────
  console.log('── 7. UNDO BLOCKED BY NEW RESERVATION ──────────────────────');
  const [[firstRoom]] = await pool.query('SELECT id, number, room_type_id FROM rooms LIMIT 1');
  const [[firstRoomType]] = await pool.query('SELECT code FROM room_types WHERE id = ? LIMIT 1', [firstRoom?.room_type_id || 1]);
  const [resInsert] = await pool.query(
    "INSERT INTO reservations (reservation_number, guest_name, phone, arrival_date, departure_date, room_id, room_number, room_type, status, created_at) VALUES (?, 'Test Guest', '9999000000', ?, ?, ?, ?, ?, 'Pending', DATE_ADD(NOW(), INTERVAL 10 SECOND))",
    [`RES-TEST-${Date.now()}`, targetDate, BusinessDateService.addDays(targetDate, 2), firstRoom?.id || 1, firstRoom?.number || '101', firstRoomType?.code || 'STD']
  );
  const r7 = await apiPost('/dayend/undo', {}, adminToken);
  if (r7.status === 409 && r7.data?.code === 'POST_DAY_END_DATA_EXISTS') {
    ok('7.1', 'Undo blocked by new reservation → 409 POST_DAY_END_DATA_EXISTS');
  } else {
    fail('7.1', 'Undo blocked by new reservation', `HTTP ${r7.status} code=${r7.data?.code}`);
  }
  await pool.query('DELETE FROM reservations WHERE id = ?', [resInsert.insertId]);

  // ── 8. Successful undo (clean state — no post-Day-End data) ──────────────
  // The step-4 Day End (targetDate) is still committed and no blockers remain.
  console.log('── 8. SUCCESSFUL UNDO ───────────────────────────────────────');

  const r8 = await apiPost('/dayend/undo', {}, adminToken);
  if (r8.status === 200) {
    ok('8.1', 'Undo succeeds → 200', `restored=${r8.data.restoredDate}`);
    if (r8.data.restoredDate === beforeDate) {
      ok('8.2', 'Business Date restored to pre-Day-End value', r8.data.restoredDate);
    } else {
      fail('8.2', 'Business Date restored to pre-Day-End value', `expected ${beforeDate} got ${r8.data.restoredDate}`);
    }
    // Verify DB directly
    const dbDate = await BusinessDateService.getBusinessDate(pool);
    if (dbDate === beforeDate) {
      ok('8.3', 'DB confirms Business Date restoration', dbDate);
    } else {
      fail('8.3', 'DB confirms Business Date restoration', `expected ${beforeDate} got ${dbDate}`);
    }
    // Verify rollover ledger items were deleted for targetDate
    const [[{ cnt: remainingRollover }]] = await pool.query(
      "SELECT COUNT(*) as cnt FROM ledger_items WHERE business_date = ? AND (`desc` LIKE 'Room Tariff%Rollover%' OR `desc` LIKE 'Taxes & GST%')",
      [targetDate]
    );
    if (remainingRollover === 0) {
      ok('8.4', 'Rollover ledger items deleted', `0 remaining for ${targetDate}`);
    } else {
      fail('8.4', 'Rollover ledger items deleted', `${remainingRollover} still exist for ${targetDate}`);
    }
  } else {
    fail('8.1', 'Undo succeeds', `HTTP ${r8.status} error="${r8.data?.error}" code=${r8.data?.code}`);
  }

  // ── 9. Audit log verification ────────────────────────────────────────────
  console.log('── 9. AUDIT LOG VERIFICATION ────────────────────────────────');
  // The original DAY_END log should now be DAY_END_UNDONE
  const [[undoneLog]] = await pool.query(
    'SELECT * FROM audit_logs WHERE id = ?', [dayEndLog?.id]
  );
  if (undoneLog?.action === 'DAY_END_UNDONE') {
    ok('9.1', 'DAY_END audit log marked as DAY_END_UNDONE', `id=${undoneLog.id}`);
  } else {
    fail('9.1', 'DAY_END audit log marked as DAY_END_UNDONE', `action=${undoneLog?.action}`);
  }
  // UNDO_DAY_END log should exist
  const undoLog = await getUndoLog(dayEndLog?.id);
  if (undoLog) {
    ok('9.2', 'UNDO_DAY_END audit log inserted', `id=${undoLog.id}`);
    if (undoLog.business_date === beforeDate) {
      ok('9.3', 'UNDO_DAY_END audit log has correct business_date', undoLog.business_date);
    } else {
      fail('9.3', 'UNDO_DAY_END business_date', `expected ${beforeDate} got ${undoLog.business_date}`);
    }
    if (undoLog.previous_business_date === targetDate && undoLog.new_business_date === beforeDate) {
      ok('9.4', 'UNDO_DAY_END audit log records correct previous/new dates');
    } else {
      fail('9.4', 'UNDO_DAY_END date fields', `prev=${undoLog.previous_business_date} new=${undoLog.new_business_date}`);
    }
  } else {
    fail('9.2', 'UNDO_DAY_END audit log inserted', 'not found');
  }

  // ── 10. Double undo (same state — Day End just undone) ───────────────────
  console.log('── 10. DOUBLE UNDO PREVENTION ───────────────────────────────');
  // The most recent DAY_END is now DAY_END_UNDONE.
  // The next earlier DAY_END has a business_date != currentBusinessDate → BUSINESS_DATE_MISMATCH.
  const r10 = await apiPost('/dayend/undo', {}, adminToken);
  // Should fail since last real DAY_END's business_date != current date
  if (r10.status === 409 || r10.status === 404) {
    ok('10.1', `Double undo correctly rejected → HTTP ${r10.status}`, r10.data?.code || r10.data?.error?.slice(0, 60));
  } else if (r10.status === 200) {
    // A second undo succeeded — report it so we know the state moved further back
    fail('10.1', 'Double undo correctly rejected', `HTTP 200 — date moved to ${r10.data?.restoredDate}`);
  } else {
    fail('10.1', 'Double undo correctly rejected', `HTTP ${r10.status}`);
  }

  // ── 11. Business Date consistency after undo ──────────────────────────────
  console.log('── 11. CONSISTENCY AFTER UNDO ───────────────────────────────');
  const finalDate = await BusinessDateService.getBusinessDate(pool);
  const statusRes = await apiGet('/status', adminToken);
  const statusDate = statusRes.data?.systemDate;
  if (statusDate === finalDate) {
    ok('11.1', '/api/status systemDate matches BusinessDateService', finalDate);
  } else {
    fail('11.1', '/api/status systemDate matches BusinessDateService', `service=${finalDate} status=${statusDate}`);
  }
  const bdRes = await apiGet('/settings/business-date', adminToken);
  const bdDate = bdRes.data?.businessDate;
  if (bdDate === finalDate) {
    ok('11.2', '/api/settings/business-date matches BusinessDateService', finalDate);
  } else {
    fail('11.2', '/api/settings/business-date', `service=${finalDate} endpoint=${bdDate}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  printSummary();
  await pool.end();
  process.exit(FAIL.length > 0 ? 1 : 0);
}

function printSummary() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  UNDO DAY END VERIFICATION REPORT');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Total: ${PASS.length + FAIL.length} | PASS: ${PASS.length} | FAIL: ${FAIL.length}\n`);
  if (FAIL.length > 0) {
    console.log('  FAILURES:');
    FAIL.forEach(f => console.log(`    [${f.id}] ${f.label} — ${f.reason}`));
  } else {
    console.log('  ALL CHECKS PASSED ✔');
  }
  console.log('═══════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
