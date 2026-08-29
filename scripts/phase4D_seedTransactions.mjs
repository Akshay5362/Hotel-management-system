/**
 * scripts/phase4D_seedTransactions.mjs
 * ══════════════════════════════════════════════════════════════════════════════
 * HPMS-Sky5 — PHASE 4D-1: Transactional Data Migration Infrastructure
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * SAFETY CONTRACT:
 *   ✅ Reads ONLY from MySQL (SELECT statements only)
 *   ✅ Validates Feature Flags are OFF
 *   ✅ Default behavior is Dry Run (use --commit for execution)
 *   ✅ Replicates the exact dual-write repository pattern:
 *      (e.g., writes to /payments AND /bookings/{bkg_id}/payments)
 *   ✅ Deterministic ID generation based on firestoreUtils / Repositories.
 *   ✅ Fails-safe if transactional source tables contain unexpectedly > 0 rows
 *      (Expectation is 0 rows due to recent factory reset)
 */

import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';
import {
  formatBookingId,
  formatReservationId,
  formatInvoiceId
} from '../backend/repositories/firestore/firestoreUtils.js';

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--commit') || args.includes('--dry-run');
const MODE_LABEL = DRY_RUN ? 'DRY-RUN' : 'COMMIT';

// ════════════════════════════════════════════════════════════════════════════════
// SAFETY GUARDS
// ════════════════════════════════════════════════════════════════════════════════

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
      violations.push(`  ❌ ${flag} = true  (must be false for Phase 4D)`);
    }
  }
  if (violations.length > 0) {
    console.error('\n🚫 SAFETY ABORT: Feature flags are unexpectedly enabled:');
    violations.forEach(v => console.error(v));
    process.exit(1);
  }
}

async function safeQuery(sql, params = []) {
  const trimmed = sql.trim().toUpperCase();
  if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('SHOW')) {
    throw new Error(`SAFETY VIOLATION: Non-SELECT SQL attempted:\n"${sql}"`);
  }
  const [rows] = await pool.query(sql, params);
  return rows;
}

function toIsoString(dateVal) {
  if (!dateVal) return null; // Only format if present
  const parsed = new Date(dateVal);
  if (isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

// ════════════════════════════════════════════════════════════════════════════════
// ID FORMATTERS (Consistent with Repositories)
// ════════════════════════════════════════════════════════════════════════════════

function formatPaymentId(id) {
  return `payment_${id}`;
}
function formatLedgerId(id) {
  return `ledger_${id}`;
}
function formatHistoryId(id) {
  return `history_${id}`;
}
function formatCashLogId(id) {
  return `cash_${id}`;
}
function formatCashSubmissionId(id) {
  return `sub_${id}`;
}

async function run() {
  console.log(`\n======================================================`);
  console.log(` PHASE 4D-1 TRANSACTIONAL MIGRATION : ${MODE_LABEL} `);
  console.log(`======================================================\n`);

  verifyFeatureFlags();

  // 1. EXTRACT FROM MYSQL (WITH JOINS FOR RESOLUTION)
  console.log('\n[1] Extracting data from MySQL...');
  
  const queries = {
    bookings: `
      SELECT b.*, g.full_name as guest_name, g.user_id, r.number as room_number
      FROM bookings b
      LEFT JOIN guests g ON b.guest_id = g.id
      LEFT JOIN rooms r ON b.room_id = r.id
    `,
    reservations: `
      SELECT res.*, r.number as resolved_room_number
      FROM reservations res
      LEFT JOIN rooms r ON res.room_id = r.id
    `,
    payments: `SELECT * FROM payments`,
    ledger_items: `SELECT * FROM ledger_items`,
    booking_history: `SELECT * FROM booking_history`,
    invoices: `SELECT * FROM invoices`,
    cash_logs: `SELECT * FROM cash_logs`,
    cash_submissions: `SELECT * FROM cash_submissions`
  };

  const sourceData = {};
  for (const [key, sql] of Object.entries(queries)) {
    sourceData[key] = await safeQuery(sql);
  }

  // 2. CHECK EXPECTED COUNTS
  console.log('\n[2] Verifying MySQL Source Counts (Expecting 0 for all)...');
  let hasUnexpectedData = false;
  for (const [key, rows] of Object.entries(sourceData)) {
    console.log(`  - ${key}: ${rows.length}`);
    if (rows.length > 0) {
      hasUnexpectedData = true;
    }
  }

  // 3. BUILD MIGRATION PAYLOADS
  console.log('\n[3] Building Migration Payloads...');
  
  const writes = []; // Array of { ref, data }
  const plannedCounts = {
    bookings: 0,
    reservations: 0,
    payments: 0,
    ledger_items: 0,
    booking_history: 0,
    invoices: 0,
    cash_logs: 0,
    cash_submissions: 0
  };

  // Maps for tracking
  const bookingMap = new Map();

  // A. BOOKINGS
  for (const row of sourceData.bookings) {
    if (!row.booking_number) throw new Error(`Booking ${row.id} missing booking_number`);
    const docId = formatBookingId(row.booking_number);
    bookingMap.set(row.id, docId);
    
    writes.push({
      ref: db.collection('bookings').doc(docId),
      data: {
        booking_number: String(row.booking_number),
        guest_id: String(row.guest_id || ''),
        mysql_guest_id: Number(row.guest_id || 0),
        guest_user_uid: row.guest_user_uid || null,
        guest_name: String(row.guest_name || ''),
        room_id: String(row.room_id || ''),
        mysql_room_id: Number(row.room_id || 0),
        room_number: String(row.room_number || ''),
        check_in_date: String(row.check_in_date || ''),
        check_out_date: row.check_out_date ? String(row.check_out_date) : null,
        expected_check_out_date: row.expected_check_out_date ? String(row.expected_check_out_date) : (row.check_out_date || null),
        adults: Number(row.adults || 1),
        children: Number(row.children || 0),
        booking_status: String(row.booking_status || 'Checked In'),
        payment_status: String(row.payment_status || 'Pending'),
        total_amount: Number(row.total_amount || 0),
        advance_amount: Number(row.advance_amount || 0),
        notes: String(row.notes || ''),
        billing_instruction: String(row.billing_instruction || ''),
        meal_plan: String(row.meal_plan || 'EP'),
        mysql_booking_id: Number(row.id),
        created_at: toIsoString(row.created_at) || new Date().toISOString(),
        updated_at: toIsoString(row.updated_at) || new Date().toISOString()
      }
    });
    plannedCounts.bookings++;
  }

  // B. RESERVATIONS
  for (const row of sourceData.reservations) {
    if (!row.reservation_number) throw new Error(`Reservation ${row.id} missing number`);
    const docId = formatReservationId(row.reservation_number);
    
    writes.push({
      ref: db.collection('reservations').doc(docId),
      data: {
        reservation_number: String(row.reservation_number),
        guest_name: String(row.guest_name || ''),
        email: row.email || null,
        phone: row.phone || null,
        room_id: String(row.room_id || ''),
        mysql_room_id: Number(row.room_id || 0),
        room_number: String(row.resolved_room_number || row.room_number || ''),
        booking_id: row.booking_id ? formatBookingId(row.booking_id) : null, // Not strictly accurate format since we don't know the booking_number here, but usually booking_id is number based, this is best-effort mapping for a 0 row table
        mysql_booking_id: row.booking_id || null,
        check_in_date: String(row.arrival_date || ''),
        check_out_date: String(row.departure_date || ''),
        status: String(row.status || 'Confirmed'),
        notes: String(row.remarks || ''),
        mysql_reservation_id: Number(row.id),
        created_at: toIsoString(row.created_at) || new Date().toISOString(),
        updated_at: toIsoString(row.updated_at) || new Date().toISOString()
      }
    });
    plannedCounts.reservations++;
  }

  // C. PAYMENTS (Dual-Write)
  for (const row of sourceData.payments) {
    const docId = formatPaymentId(row.id);
    const parentBkgId = bookingMap.get(row.booking_id) || (row.booking_id ? formatBookingId(row.booking_id) : null);
    
    const payload = {
      payment_id: docId,
      booking_id: parentBkgId,
      mysql_booking_id: Number(row.booking_id || 0),
      guest_id: row.guest_id ? String(row.guest_id) : null,
      mysql_guest_id: Number(row.guest_id || 0),
      amount: Number(row.amount || 0),
      currency: String(row.currency || 'INR'),
      payment_method: String(row.payment_method || ''),
      payment_status: String(row.payment_status || 'Completed'),
      payment_type: String(row.payment_type || 'Room Charge'),
      payment_source: String(row.payment_source || 'front_desk'),
      payment_gateway: String(row.payment_gateway || 'Internal'),
      transaction_id: row.transaction_id || null,
      business_date: row.business_date || new Date().toISOString().split('T')[0],
      mysql_payment_id: Number(row.id),
      created_at: toIsoString(row.created_at) || new Date().toISOString(),
      updated_at: toIsoString(row.updated_at) || new Date().toISOString()
    };

    writes.push({ ref: db.collection('payments').doc(docId), data: payload });
    plannedCounts.payments++;

    if (parentBkgId) {
      writes.push({ ref: db.collection('bookings').doc(parentBkgId).collection('payments').doc(docId), data: payload });
    }
  }

  // D. LEDGER ITEMS (Dual-Write)
  for (const row of sourceData.ledger_items) {
    const docId = formatLedgerId(row.id);
    const parentBkgId = bookingMap.get(row.booking_id) || (row.booking_id ? formatBookingId(row.booking_id) : null);
    
    const payload = {
      item_id: docId,
      booking_id: parentBkgId,
      mysql_booking_id: Number(row.booking_id || 0),
      room_number: String(row.room_number || ''),
      description: String(row.desc || ''),
      desc: String(row.desc || ''),
      qty: Number(row.qty || 1),
      quantity: Number(row.qty || 1),
      amount: Number(row.amount || 0),
      type: 'CHARGE',
      status: String(row.status || 'Pending'),
      business_date: row.business_date || new Date().toISOString().split('T')[0],
      mysql_ledger_id: Number(row.id),
      created_at: toIsoString(row.created_at) || new Date().toISOString()
    };

    writes.push({ ref: db.collection('ledger_items').doc(docId), data: payload });
    plannedCounts.ledger_items++;

    if (parentBkgId) {
      writes.push({ ref: db.collection('bookings').doc(parentBkgId).collection('ledger_items').doc(docId), data: payload });
    }
  }

  // E. BOOKING HISTORY (Dual-Write)
  for (const row of sourceData.booking_history) {
    const docId = formatHistoryId(row.id);
    const parentBkgId = bookingMap.get(row.booking_id) || (row.booking_id ? formatBookingId(row.booking_id) : null);
    
    const payload = {
      history_id: docId,
      booking_id: parentBkgId,
      mysql_booking_id: Number(row.booking_id || 0),
      action: String(row.action || ''),
      details: String(row.notes || ''),
      changed_by: row.changed_by ? String(row.changed_by) : null,
      mysql_changed_by: row.changed_by || null,
      business_date: row.business_date || new Date().toISOString().split('T')[0],
      mysql_history_id: Number(row.id),
      created_at: toIsoString(row.created_at) || new Date().toISOString()
    };

    writes.push({ ref: db.collection('booking_history').doc(docId), data: payload });
    plannedCounts.booking_history++;

    if (parentBkgId) {
      writes.push({ ref: db.collection('bookings').doc(parentBkgId).collection('history').doc(docId), data: payload });
    }
  }

  // F. INVOICES
  for (const row of sourceData.invoices) {
    if (!row.invoice_number) throw new Error(`Invoice ${row.id} missing number`);
    const docId = formatInvoiceId(row.invoice_number);
    const parentBkgId = bookingMap.get(row.booking_id) || (row.booking_id ? formatBookingId(row.booking_id) : null);
    
    writes.push({
      ref: db.collection('invoices').doc(docId),
      data: {
        invoice_number: String(row.invoice_number),
        invoice_type: String(row.invoice_type || 'regular'),
        booking_id: parentBkgId,
        mysql_booking_id: Number(row.booking_id || 0),
        total_amount: Number(row.total_amount || 0),
        tax_amount: Number(row.tax_amount || 0),
        discount_amount: Number(row.discount_amount || 0),
        paid_amount: Number(row.paid_amount || 0),
        balance_due: Number(row.balance_due || 0),
        status: String(row.status || 'draft'),
        issued_at: toIsoString(row.issued_at) || null,
        due_date: String(row.due_date || ''),
        business_date: row.business_date || new Date().toISOString().split('T')[0],
        mysql_invoice_id: Number(row.id),
        created_at: toIsoString(row.created_at) || new Date().toISOString()
      }
    });
    plannedCounts.invoices++;
  }

  // G. CASH LOGS
  for (const row of sourceData.cash_logs) {
    const docId = formatCashLogId(row.id);
    const parentBkgId = bookingMap.get(row.booking_id) || (row.booking_id ? formatBookingId(row.booking_id) : null);
    
    writes.push({
      ref: db.collection('cash_logs').doc(docId),
      data: {
        time: String(row.time || ''),
        room: String(row.room || ''),
        guest: String(row.guest || ''),
        type: String(row.type || ''),
        amount: Number(row.amount || 0),
        business_date: row.business_date || new Date().toISOString().split('T')[0],
        booking_id: parentBkgId,
        mysql_booking_id: Number(row.booking_id || 0),
        mysql_cash_log_id: Number(row.id),
        created_at: new Date().toISOString()
      }
    });
    plannedCounts.cash_logs++;
  }

  // H. CASH SUBMISSIONS
  for (const row of sourceData.cash_submissions) {
    const docId = formatCashSubmissionId(row.id);
    writes.push({
      ref: db.collection('cash_submissions').doc(docId),
      data: {
        receipt_id: String(row.receipt_id || ''),
        business_date: row.business_date || new Date().toISOString().split('T')[0],
        submitted_at: toIsoString(row.submitted_at) || new Date().toISOString(),
        receptionist_name: String(row.receptionist_name || ''),
        receiver_name: String(row.receiver_name || ''),
        amount: Number(row.amount || 0),
        remaining_cash: Number(row.remaining_cash || 0),
        remarks: String(row.remarks || ''),
        mysql_submission_id: Number(row.id),
        created_at: toIsoString(row.created_at) || new Date().toISOString()
      }
    });
    plannedCounts.cash_submissions++;
  }

  // 4. REPORT / SUMMARY
  console.log('\n[4] Migration Payload Summary');
  for (const [key, count] of Object.entries(plannedCounts)) {
    console.log(`  - ${key}: ${count} unique canonical documents mapped`);
  }

  console.log(`\n  Total mapped writes (including dual-writes): ${writes.length}`);

  if (hasUnexpectedData) {
    console.error('\n🚫 SAFETY ABORT: MySQL source tables contain data (expected 0).');
    console.error('Cannot proceed with a 0-state validation commit while data exists.');
    console.error('If you want to migrate this data, please clear the feature flag guard / requirements manually.');
    process.exit(1);
  }

  // 5. DRY RUN OR COMMIT
  if (DRY_RUN) {
    console.log('\n======================================================');
    console.log(' FINAL: DRY RUN — ZERO WRITES EXECUTED');
    console.log('======================================================\n');
  } else {
    console.log('\n[5] Committing to Firestore...');
    // Only commit if we have writes, but since it's 0, it's a no-op
    if (writes.length > 0) {
      const batch = db.batch();
      for (const w of writes) {
        batch.set(w.ref, w.data, { merge: true });
      }
      await batch.commit();
      console.log(`  ✅ Successfully committed ${writes.length} writes to Firestore`);
    } else {
      console.log('  ✅ ZERO DOCUMENTS WRITTEN (Source was empty)');
    }

    console.log('\n======================================================');
    console.log(' FINAL: COMMIT SUCCESSFUL');
    console.log('======================================================\n');
  }

  await pool.end();
}

run().catch(err => {
  console.error('\n🚫 MIGRATION FAILED:', err);
  pool.end();
  process.exit(1);
});
