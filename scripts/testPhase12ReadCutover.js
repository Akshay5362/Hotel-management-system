import dotenv from 'dotenv';
dotenv.config();

import pool from '../backend/db.js';
import { db, auth } from '../backend/config/firebaseAdmin.js';
import { isFirestoreReadsEnabled } from '../backend/config/featureFlags.js';
import { getAllRoomsFirestore } from '../backend/repositories/firestore/roomsRepository.js';
import { getAllRoomTypesFirestore } from '../backend/repositories/firestore/roomTypesRepository.js';
import { getAllStaffFirestore } from '../backend/repositories/firestore/staffRepository.js';
import { getAllGuestsFirestore } from '../backend/repositories/firestore/guestsRepository.js';
import { getAllReservationsFirestore } from '../backend/repositories/firestore/reservationsRepository.js';
import { getAllBookingsFirestore } from '../backend/repositories/firestore/bookingsRepository.js';
import { getAllPaymentsFirestore } from '../backend/repositories/firestore/paymentsRepository.js';
import { getAllLedgerItemsFirestore } from '../backend/repositories/firestore/ledgerRepository.js';
import { getAllCashLogsFirestore } from '../backend/repositories/firestore/cashLogsRepository.js';
import { getAllInvoicesFirestore } from '../backend/repositories/firestore/invoicesRepository.js';
import { getAllBookingHistoryFirestore } from '../backend/repositories/firestore/bookingHistoryRepository.js';
import { getAllAuditLogsFirestore } from '../backend/repositories/firestore/auditLogsRepository.js';
import http from 'http';

function makeRequest(path, method = 'GET', headers = {}, body = null) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: 5000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : {}; } catch (e) { parsed = { raw: data }; }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', (err) => resolve({ status: 500, error: err.message }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function testPhase12ReadCutover() {
  console.log('\n=================================================');
  console.log('  PHASE 12: CONTROLLED FIRESTORE READ CUTOVER SUITE');
  console.log('=================================================\n');

  let failureCount = 0;

  try {
    // 1. Feature Flag Assertions
    process.env.ENABLE_FIRESTORE_READS = 'true';
    process.env.ENABLE_FIRESTORE_WRITES = 'false';

    console.log(`1. FEATURE FLAGS STATE:`);
    console.log(` - ENABLE_FIRESTORE_READS  : ${process.env.ENABLE_FIRESTORE_READS} (isFirestoreReadsEnabled: ${isFirestoreReadsEnabled()})`);
    console.log(` - ENABLE_FIRESTORE_WRITES : ${process.env.ENABLE_FIRESTORE_WRITES}`);
    console.log(` - ENABLE_FIREBASE_AUTH    : ${process.env.ENABLE_FIREBASE_AUTH}`);
    console.log(` - ENABLE_STRICT_RBAC      : ${process.env.ENABLE_STRICT_RBAC}`);

    if (!isFirestoreReadsEnabled()) failureCount++;

    // 2. Health Check
    const healthRes = await makeRequest('/api/health');
    console.log(`\n2. Backend Health Check: HTTP ${healthRes.status} | Service: ${healthRes.data?.service || 'N/A'}`);
    if (healthRes.status !== 200) failureCount++;

    // 3. READ TEST MATRIX ACROSS ALL 12 FIRESTORE COLLECTIONS
    console.log('\n3. READ TEST MATRIX ACROSS ALL 12 FIRESTORE COLLECTIONS:');

    // 1. Rooms
    const [mysqlRooms] = await pool.query('SELECT * FROM rooms');
    const fsRooms = await getAllRoomsFirestore();
    console.log(` [1/12] /rooms          : MySQL ${mysqlRooms.length} <-> Firestore Adapter ${fsRooms.length} (${mysqlRooms.length === fsRooms.length ? 'PASS' : 'FAIL'})`);
    if (mysqlRooms.length !== fsRooms.length || fsRooms.length !== 17) failureCount++;

    // 2. Room Types
    const [mysqlRoomTypes] = await pool.query('SELECT * FROM room_types');
    const fsRoomTypes = await getAllRoomTypesFirestore();
    console.log(` [2/12] /room_types     : MySQL ${mysqlRoomTypes.length} <-> Firestore Adapter ${fsRoomTypes.length} (${mysqlRoomTypes.length === fsRoomTypes.length ? 'PASS' : 'FAIL'})`);
    if (mysqlRoomTypes.length !== fsRoomTypes.length || fsRoomTypes.length !== 3) failureCount++;

    // 3. Staff
    const [mysqlStaff] = await pool.query('SELECT * FROM staff');
    const fsStaff = await getAllStaffFirestore();
    console.log(` [3/12] /staff          : MySQL ${mysqlStaff.length} <-> Firestore Adapter ${fsStaff.length} (${mysqlStaff.length === fsStaff.length ? 'PASS' : 'FAIL'})`);
    if (mysqlStaff.length !== fsStaff.length || fsStaff.length !== 11) failureCount++;

    // 4. Guests
    const [mysqlGuests] = await pool.query('SELECT * FROM guests');
    const fsGuests = await getAllGuestsFirestore();
    console.log(` [4/12] /guests         : MySQL ${mysqlGuests.length} <-> Firestore Adapter ${fsGuests.length} (${mysqlGuests.length === fsGuests.length ? 'PASS' : 'FAIL'})`);
    if (mysqlGuests.length !== fsGuests.length || fsGuests.length !== 5) failureCount++;

    // 5. Reservations
    const [mysqlReservations] = await pool.query('SELECT * FROM reservations');
    const fsReservations = await getAllReservationsFirestore();
    console.log(` [5/12] /reservations   : MySQL ${mysqlReservations.length} <-> Firestore Adapter ${fsReservations.length} (${mysqlReservations.length === fsReservations.length ? 'PASS' : 'FAIL'})`);
    if (mysqlReservations.length !== fsReservations.length || fsReservations.length !== 3) failureCount++;

    // 6. Bookings
    const [mysqlBookings] = await pool.query('SELECT * FROM bookings');
    const fsBookings = await getAllBookingsFirestore();
    let mysqlBkgTot = 0, fsBkgTot = 0;
    mysqlBookings.forEach(b => mysqlBkgTot += Number(b.total_amount || 0));
    fsBookings.forEach(b => fsBkgTot += Number(b.total_amount || 0));
    console.log(` [6/12] /bookings       : MySQL ${mysqlBookings.length} <-> Firestore Adapter ${fsBookings.length} (${mysqlBookings.length === fsBookings.length && mysqlBkgTot === fsBkgTot ? 'PASS' : 'FAIL'}) [Total: ₹${fsBkgTot}]`);
    if (mysqlBookings.length !== fsBookings.length || fsBookings.length !== 4 || mysqlBkgTot !== fsBkgTot) failureCount++;

    // 7. Payments
    const [mysqlPayments] = await pool.query('SELECT * FROM payments');
    const fsPayments = await getAllPaymentsFirestore();
    let mysqlPmtTot = 0, fsPmtTot = 0;
    mysqlPayments.forEach(p => mysqlPmtTot += Number(p.amount || 0));
    fsPayments.forEach(p => fsPmtTot += Number(p.amount || 0));
    console.log(` [7/12] /payments       : MySQL ${mysqlPayments.length} <-> Firestore Adapter ${fsPayments.length} (${mysqlPayments.length === fsPayments.length && mysqlPmtTot === fsPmtTot ? 'PASS' : 'FAIL'}) [Total: ₹${fsPmtTot}]`);
    if (mysqlPayments.length !== fsPayments.length || fsPayments.length !== 5 || mysqlPmtTot !== fsPmtTot) failureCount++;

    // 8. Ledger Items
    const [mysqlLedger] = await pool.query('SELECT * FROM ledger_items');
    const fsLedger = await getAllLedgerItemsFirestore();
    let mysqlLdrTot = 0, fsLdrTot = 0;
    mysqlLedger.forEach(l => mysqlLdrTot += Number(l.amount || 0));
    fsLedger.forEach(l => fsLdrTot += Number(l.amount || 0));
    console.log(` [8/12] /ledger_items   : MySQL ${mysqlLedger.length} <-> Firestore Adapter ${fsLedger.length} (${mysqlLedger.length === fsLedger.length && mysqlLdrTot === fsLdrTot ? 'PASS' : 'FAIL'}) [Total: ₹${fsLdrTot}]`);
    if (mysqlLedger.length !== fsLedger.length || fsLedger.length !== 17 || mysqlLdrTot !== fsLdrTot) failureCount++;

    // 9. Cash Logs
    const [mysqlCash] = await pool.query('SELECT * FROM cash_logs');
    const fsCash = await getAllCashLogsFirestore();
    let mysqlCashTot = 0, fsCashTot = 0;
    mysqlCash.forEach(c => mysqlCashTot += Number(c.amount || 0));
    fsCash.forEach(c => fsCashTot += Number(c.amount || 0));
    console.log(` [9/12] /cash_logs      : MySQL ${mysqlCash.length} <-> Firestore Adapter ${fsCash.length} (${mysqlCash.length === fsCash.length && mysqlCashTot === fsCashTot ? 'PASS' : 'FAIL'}) [Total: ₹${fsCashTot}]`);
    if (mysqlCash.length !== fsCash.length || fsCash.length !== 15 || mysqlCashTot !== fsCashTot) failureCount++;

    // 10. Invoices
    const [mysqlInvoices] = await pool.query('SELECT * FROM invoices');
    const fsInvoices = await getAllInvoicesFirestore();
    let mysqlInvTot = 0, fsInvTot = 0;
    mysqlInvoices.forEach(i => mysqlInvTot += Number(i.total_amount || 0));
    fsInvoices.forEach(i => fsInvTot += Number(i.total_amount || 0));
    console.log(`[10/12] /invoices       : MySQL ${mysqlInvoices.length} <-> Firestore Adapter ${fsInvoices.length} (${mysqlInvoices.length === fsInvoices.length && mysqlInvTot === fsInvTot ? 'PASS' : 'FAIL'}) [Total: ₹${fsInvTot}]`);
    if (mysqlInvoices.length !== fsInvoices.length || fsInvoices.length !== 3 || mysqlInvTot !== fsInvTot) failureCount++;

    // 11. Booking History
    const [mysqlHistory] = await pool.query('SELECT * FROM booking_history');
    const fsHistory = await getAllBookingHistoryFirestore();
    console.log(`[11/12] /booking_history: MySQL ${mysqlHistory.length} <-> Firestore Adapter ${fsHistory.length} (${mysqlHistory.length === fsHistory.length ? 'PASS' : 'FAIL'})`);
    if (mysqlHistory.length !== fsHistory.length || fsHistory.length !== 4) failureCount++;

    // 12. Audit Logs
    const [mysqlAudit] = await pool.query('SELECT * FROM audit_logs');
    const fsAudit = await getAllAuditLogsFirestore();
    console.log(`[12/12] /audit_logs     : MySQL ${mysqlAudit.length} <-> Firestore Adapter ${fsAudit.length} (${mysqlAudit.length === fsAudit.length ? 'PASS' : 'FAIL'})`);
    if (mysqlAudit.length !== fsAudit.length || fsAudit.length !== 59) failureCount++;

    const totalFsDocs = fsRooms.length + fsRoomTypes.length + fsStaff.length + fsGuests.length +
                        fsReservations.length + fsBookings.length + fsPayments.length + fsLedger.length +
                        fsCash.length + fsInvoices.length + fsHistory.length + fsAudit.length;

    console.log(`\nTOTAL FIRESTORE DOCUMENTS VERIFIED: ${totalFsDocs} / 146`);
    if (totalFsDocs !== 146) failureCount++;

    // 4. Security & RBAC Assertions
    console.log('\n4. RBAC & SECURITY VERIFICATION:');
    const noAuthRes = await makeRequest('/api/status');
    console.log(` - Missing Token Request : HTTP ${noAuthRes.status} (Expected: 401)`);
    if (noAuthRes.status !== 401) failureCount++;

    const invalidAuthRes = await makeRequest('/api/status', 'GET', { Authorization: 'Bearer invalid_fake_token' });
    console.log(` - Invalid Token Request : HTTP ${invalidAuthRes.status} (Expected: 401)`);
    if (invalidAuthRes.status !== 401) failureCount++;

    // 5. Rollback Test (Reset ENABLE_FIRESTORE_READS = false)
    console.log('\n5. ROLLBACK VERIFICATION (Setting ENABLE_FIRESTORE_READS = false):');
    process.env.ENABLE_FIRESTORE_READS = 'false';
    const postRollbackHealth = await makeRequest('/api/health');
    console.log(` - ENABLE_FIRESTORE_READS: ${process.env.ENABLE_FIRESTORE_READS} (isFirestoreReadsEnabled: ${isFirestoreReadsEnabled()})`);
    console.log(` - Backend Health Check   : HTTP ${postRollbackHealth.status} | Service: ${postRollbackHealth.data?.service || 'N/A'}`);
    if (isFirestoreReadsEnabled() !== false || postRollbackHealth.status !== 200) failureCount++;

    console.log('\n=================================================');
    console.log(`PHASE 12 READ CUTOVER RESULT: ${failureCount === 0 ? 'READY FOR CONTROLLED FIRESTORE WRITE/CUTOVER TEST' : 'PHASE 12 FAILED'}`);
    console.log('=================================================\n');

    if (failureCount > 0) process.exit(1);

  } catch (err) {
    console.error('Phase 12 Error:', err.message);
    process.exit(1);
  }
}

testPhase12ReadCutover();
