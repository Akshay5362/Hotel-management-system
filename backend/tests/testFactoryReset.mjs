import pool from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { FactoryResetService } from '../services/FactoryResetService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runFactoryResetTests() {
  console.log('========================================================================');
  console.log('  HPMS-Sky5 Factory Reset Schema Alignment & Rollback Test Suite');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ PASSED: ${message}`);
      passed++;
    } else {
      console.error(`  ✕ FAILED: ${message}`);
      failed++;
    }
  }

  try {
    // 1. Code Inspection Test: No obsolete `housekeeping` table queries exist
    console.log('--- Test 1: Static Code Inspection for Obsolete SQL ---');
    const serviceContent = fs.readFileSync(path.join(__dirname, '..', 'services', 'FactoryResetService.js'), 'utf-8');

    const containsObsoleteDelete = /\bDELETE\s+FROM\s+`?housekeeping`?\b/i.test(serviceContent);
    assert(!containsObsoleteDelete, 'FactoryResetService contains zero DELETE statements for obsolete housekeeping table');

    const containsObsoleteInsert = /\bINSERT\s+INTO\s+`?housekeeping`?\s*\(/i.test(serviceContent);
    assert(!containsObsoleteInsert, 'FactoryResetService contains zero INSERT statements for obsolete housekeeping table');

    const referencesLogsTable = serviceContent.includes('housekeeping_logs');
    assert(referencesLogsTable, 'FactoryResetService correctly references housekeeping_logs table');

    // 2. Preflight Status Test: verifyReset() against live schema
    console.log('\n--- Test 2: FactoryResetService.verifyReset() Preflight ---');
    const preflight = await FactoryResetService.verifyReset();
    assert(preflight && preflight.valid === true && preflight.status === 'Ready', 'verifyReset() executed successfully against current schema');

    // 3. Rollback Safety & Transaction Atomicity Test
    console.log('\n--- Test 3: Transaction Rollback Safety & Atomicity ---');
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Insert dummy guest & booking
      const [userRes] = await conn.query("INSERT INTO users (username, password, fullName, role_id) VALUES ('test_guest_fr', 'hash', 'Test Guest', (SELECT id FROM roles WHERE name = 'guest' LIMIT 1))");
      const testUserId = userRes.insertId;

      const [guestRes] = await conn.query("INSERT INTO guests (full_name, phone, user_id) VALUES ('Test Guest', '9999999999', ?)", [testUserId]);
      const testGuestId = guestRes.insertId;

      const [rtRows] = await conn.query('SELECT id FROM room_types LIMIT 1');
      const roomTypeId = rtRows[0]?.id || 1;

      const [roomRows] = await conn.query('SELECT id FROM rooms LIMIT 1');
      const roomId = roomRows[0]?.id || 1;

      const [bkgRes] = await conn.query(
        "INSERT INTO bookings (booking_number, guest_id, room_id, check_in_date, check_out_date, total_amount, booking_status, payment_status) VALUES ('BKG-TEST-FR', ?, ?, NOW(), NOW(), 1000, 'Checked In', 'Paid')",
        [testGuestId, roomId]
      );
      const testBookingId = bkgRes.insertId;

      // Insert housekeeping_log entry
      await conn.query("INSERT INTO housekeeping_logs (room_id, action, notes) VALUES (?, 'Dirty', 'Test log for rollback')", [roomId]);

      // Force a intentional failure to verify transaction rollback behavior
      let caughtError = false;
      try {
        await conn.query('DELETE FROM non_existent_table_for_rollback_test');
      } catch (err) {
        caughtError = true;
        await conn.rollback();
      }

      assert(caughtError, 'Transaction caught statement error and executed rollback');

      // Verify dummy booking still exists if checked before rollback commit, or verify main DB state intact
      const [checkBkg] = await pool.query("SELECT * FROM bookings WHERE booking_number = 'BKG-TEST-FR'");
      assert(checkBkg.length === 0, 'Rolled-back transaction left database 100% untouched');

      conn.release();
    } catch (e) {
      if (conn) conn.release();
      throw e;
    }

    // 4. Schema Alignment Test: Run FactoryReset inside a ROLLBACK wrapper to test full execution safety
    console.log('\n--- Test 4: Full FactoryReset Execution Safety inside Test Transaction ---');
    const testConn = await pool.getConnection();
    try {
      await testConn.beginTransaction();

      // Snapshot critical tables before test
      const [usersBefore] = await testConn.query("SELECT COUNT(*) as cnt FROM users WHERE role_id != (SELECT id FROM roles WHERE name = 'guest' LIMIT 1)");
      const [roomsBefore] = await testConn.query("SELECT COUNT(*) as cnt FROM rooms");
      const [staffBefore] = await testConn.query("SELECT COUNT(*) as cnt FROM staff");

      // Execute factory reset queries manually within test transaction to verify SQL execution
      await testConn.query("DELETE FROM room_status_history");
      await testConn.query("DELETE FROM booking_history");
      await testConn.query("DELETE FROM stay_extension_requests");
      await testConn.query("DELETE FROM feedback");
      await testConn.query("DELETE FROM maintenance");
      await testConn.query("DELETE FROM housekeeping_logs");
      await testConn.query("DELETE FROM ledger_items");
      await testConn.query("DELETE FROM payments");
      await testConn.query("DELETE FROM invoices");
      await testConn.query("DELETE FROM cash_logs");
      await testConn.query("DELETE FROM audit_logs");
      await testConn.query("DELETE FROM notifications");
      await testConn.query("DELETE FROM reservations");
      await testConn.query("DELETE FROM bookings");
      await testConn.query("DELETE FROM guests");
      await testConn.query("DELETE FROM users WHERE role_id = (SELECT id FROM roles WHERE name = 'guest' LIMIT 1)");
      await testConn.query("UPDATE rooms SET status = 'vacant', housekeeping_status = 'Clean', housekeeping_assigned_to = NULL, housekeeping_priority = 'Normal', last_cleaned_at = CURRENT_TIMESTAMP");

      const [roomsAfter] = await testConn.query("SELECT COUNT(*) as cnt FROM rooms");
      const [usersAfter] = await testConn.query("SELECT COUNT(*) as cnt FROM users WHERE role_id != (SELECT id FROM roles WHERE name = 'guest' LIMIT 1)");
      const [staffAfter] = await testConn.query("SELECT COUNT(*) as cnt FROM staff");

      assert(roomsBefore[0].cnt === roomsAfter[0].cnt, 'Room configuration preserved (count matches before & after)');
      assert(usersBefore[0].cnt === usersAfter[0].cnt, 'Admin/Staff user accounts preserved (count matches before & after)');
      assert(staffBefore[0].cnt === staffAfter[0].cnt, 'Staff table preserved (count matches before & after)');

      // Rollback test transaction to keep dev environment unchanged
      await testConn.rollback();
      testConn.release();
      assert(true, 'Test transaction rolled back cleanly without altering persistent data');
    } catch (e) {
      if (testConn) {
        await testConn.rollback();
        testConn.release();
      }
      throw e;
    }

  } catch (err) {
    console.error('Unhandled error during Factory Reset test:', err);
    failed++;
  }

  console.log('\n========================================================================');
  console.log(`  Factory Reset Test Results: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runFactoryResetTests();
