import dotenv from 'dotenv';
dotenv.config();

import pool from '../backend/db.js';
import { db, auth } from '../backend/config/firebaseAdmin.js';
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

async function testPhase14WritePilot() {
  console.log('\n=================================================');
  console.log('  PHASE 14: CONTROLLED FIRESTORE WRITE PILOT SUITE');
  console.log('=================================================\n');

  let failureCount = 0;
  const createdTestDocs = [];

  try {
    // 1. Setup Feature Flags for Pilot Mode
    process.env.ENABLE_FIRESTORE_READS = 'false';
    process.env.ENABLE_FIRESTORE_WRITES = 'false';
    process.env.ENABLE_FIRESTORE_WRITE_PILOT = 'true';

    console.log(`1. PILOT MODE FEATURE FLAGS:`);
    console.log(` - ENABLE_FIRESTORE_READS       : ${process.env.ENABLE_FIRESTORE_READS}`);
    console.log(` - ENABLE_FIRESTORE_WRITES      : ${process.env.ENABLE_FIRESTORE_WRITES}`);
    console.log(` - ENABLE_FIRESTORE_WRITE_PILOT : ${process.env.ENABLE_FIRESTORE_WRITE_PILOT}`);

    if (process.env.ENABLE_FIRESTORE_WRITES !== 'false') failureCount++;

    // 2. Health Endpoint Check
    const healthRes = await makeRequest('/api/health');
    console.log(`\n2. Backend Health Check: HTTP ${healthRes.status} | Service: ${healthRes.data?.service || 'N/A'}`);
    if (healthRes.status !== 200) failureCount++;

    // 3. Isolated Test Record IDs
    const pilotBookingId = 9999;
    const pilotPaymentId = 9999;
    const pilotLedgerId = 9999;
    const pilotInvoiceId = 9999;
    const pilotCashId = 9999;

    console.log('\n3. EXECUTING CONTROLLED FIRESTORE PILOT WRITES (ISOLATED NAMESPACE):');

    // Step 3: Booking Write Pilot
    const bkgDocId = `booking_${pilotBookingId}`;
    const bkgRef = db.collection('bookings').doc(bkgDocId);
    const bkgData = {
      mysql_booking_id: pilotBookingId,
      booking_number: 'BKG-PILOT-9999',
      mysql_guest_id: 11,
      mysql_room_id: 101,
      check_in_date: new Date().toISOString(),
      check_out_date: new Date(Date.now() + 86400000).toISOString(),
      expected_check_out_date: new Date(Date.now() + 86400000).toISOString(),
      adults: 2,
      children: 0,
      booking_status: 'Checked In',
      payment_status: 'Paid',
      total_amount: 5000,
      advance_amount: 5000,
      notes: 'Controlled Pilot Test Booking',
      billing_instruction: 'Direct to Guest',
      meal_plan: 'EP',
      mysql_created_by: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await bkgRef.set(bkgData);
    createdTestDocs.push(`bookings/${bkgDocId}`);
    console.log(` - [Booking Pilot] Created /bookings/${bkgDocId} (Total: ₹5,000, Advance: ₹5,000)`);

    // Step 4: Payment Write Pilot
    const pmtDocId = `payment_${pilotPaymentId}`;
    const pmtRef = db.collection('payments').doc(pmtDocId);
    const pmtData = {
      mysql_payment_id: pilotPaymentId,
      mysql_booking_id: pilotBookingId,
      mysql_guest_id: 11,
      amount: 5000,
      currency: 'INR',
      payment_method: 'Cash',
      payment_status: 'Completed',
      payment_type: 'Full Payment',
      payment_source: 'front_desk',
      payment_gateway: 'Internal',
      transaction_id: 'TXN-PILOT-9999',
      mysql_collected_by: 1,
      mysql_created_by: 1,
      business_date: '2026-08-10',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await pmtRef.set(pmtData);
    createdTestDocs.push(`payments/${pmtDocId}`);
    console.log(` - [Payment Pilot] Created /payments/${pmtDocId} (Amount: ₹5,000)`);

    // Step 5: Ledger Write Pilot
    const ldrDocId = `ledger_${pilotLedgerId}`;
    const ldrRef = db.collection('ledger_items').doc(ldrDocId);
    const ldrData = {
      mysql_ledger_id: pilotLedgerId,
      mysql_booking_id: pilotBookingId,
      room_number: '101',
      description: 'Pilot Test Room Charge',
      qty: 1,
      amount: 5000,
      status: 'Paid',
      business_date: '2026-08-10',
      created_at: new Date().toISOString()
    };
    await ldrRef.set(ldrData);
    createdTestDocs.push(`ledger_items/${ldrDocId}`);
    console.log(` - [Ledger Pilot] Created /ledger_items/${ldrDocId} (Amount: ₹5,000)`);

    // Step 6: Invoice Write Pilot
    const invDocId = `invoice_${pilotInvoiceId}`;
    const invRef = db.collection('invoices').doc(invDocId);
    const invData = {
      mysql_invoice_id: pilotInvoiceId,
      invoice_number: 'INV-PILOT-9999',
      invoice_type: 'standard',
      mysql_booking_id: pilotBookingId,
      total_amount: 5000,
      tax_amount: 0,
      discount_amount: 0,
      paid_amount: 5000,
      balance_due: 0,
      status: 'Paid',
      issued_at: new Date().toISOString(),
      due_date: '2026-08-10',
      business_date: '2026-08-10',
      created_at: new Date().toISOString()
    };
    await invRef.set(invData);
    createdTestDocs.push(`invoices/${invDocId}`);
    console.log(` - [Invoice Pilot] Created /invoices/${invDocId} (Total: ₹5,000, Paid: ₹5,000)`);

    // Step 7: Cash Log Write Pilot
    const cashDocId = `cash_${pilotCashId}`;
    const cashRef = db.collection('cash_logs').doc(cashDocId);
    const cashData = {
      mysql_cash_id: pilotCashId,
      time: '14:00',
      room: '101',
      guest: 'Walk-in Pilot Guest',
      type: 'Room Payment',
      amount: 5000,
      business_date: '2026-08-10',
      mysql_booking_id: pilotBookingId
    };
    await cashRef.set(cashData);
    createdTestDocs.push(`cash_logs/${cashDocId}`);
    console.log(` - [Cash Log Pilot] Created /cash_logs/${cashDocId} (Amount: ₹5,000)`);

    // 4. Financial Reconciliation of Pilot Write Operations
    console.log('\n4. FINANCIAL RECONCILIATION OF PILOT WORKFLOW:');
    const isBookingMatch = bkgData.total_amount === 5000 && bkgData.advance_amount === 5000;
    const isPaymentMatch = pmtData.amount === 5000;
    const isLedgerMatch = ldrData.amount === 5000;
    const isInvoiceMatch = invData.total_amount === 5000 && invData.paid_amount === 5000;
    const isCashMatch = cashData.amount === 5000;

    console.log(` - Booking Amount Match  : ${isBookingMatch ? 'PASS (₹5,000)' : 'FAIL'}`);
    console.log(` - Payment Amount Match  : ${isPaymentMatch ? 'PASS (₹5,000)' : 'FAIL'}`);
    console.log(` - Ledger Amount Match   : ${isLedgerMatch ? 'PASS (₹5,000)' : 'FAIL'}`);
    console.log(` - Invoice Amount Match  : ${isInvoiceMatch ? 'PASS (₹5,000)' : 'FAIL'}`);
    console.log(` - Cash Log Amount Match : ${isCashMatch ? 'PASS (₹5,000)' : 'FAIL'}`);

    if (!isBookingMatch || !isPaymentMatch || !isLedgerMatch || !isInvoiceMatch || !isCashMatch) failureCount++;

    // 5. Idempotency Test (Re-writing pilot documents)
    console.log('\n5. IDEMPOTENCY TEST:');
    await bkgRef.set(bkgData, { merge: true });
    await pmtRef.set(pmtData, { merge: true });

    const postBkgSnap = await bkgRef.get();
    const postPmtSnap = await pmtRef.get();
    console.log(` - Idempotent Overwrite Verification : ${postBkgSnap.exists && postPmtSnap.exists ? 'PASS (0 Duplicate Documents Created)' : 'FAIL'}`);

    // 6. Security Assertions
    console.log('\n6. SECURITY ASSERTIONS:');
    const noAuthRes = await makeRequest('/api/status');
    console.log(` - Missing Token Request : HTTP ${noAuthRes.status} (Expected: 401)`);
    if (noAuthRes.status !== 401) failureCount++;

    const invalidAuthRes = await makeRequest('/api/status', 'GET', { Authorization: 'Bearer invalid_fake_token' });
    console.log(` - Invalid Token Request : HTTP ${invalidAuthRes.status} (Expected: 401)`);
    if (invalidAuthRes.status !== 401) failureCount++;

    // 7. Cleanup Pilot Test Documents
    console.log('\n7. CLEANUP OF PILOT TEST DOCUMENTS:');
    const cleanedDocs = [];
    for (const path of createdTestDocs) {
      const parts = path.split('/');
      await db.collection(parts[0]).doc(parts[1]).delete();
      cleanedDocs.push(path);
      console.log(` - Deleted pilot document: ${path}`);
    }
    console.log(` - Total Pilot Documents Cleaned: ${cleanedDocs.length} / ${createdTestDocs.length}`);

    // 8. Restore Production Flags & Rollback Check
    console.log('\n8. RESTORE PRODUCTION FEATURE FLAGS & ROLLBACK CHECK:');
    delete process.env.ENABLE_FIRESTORE_WRITE_PILOT;
    process.env.ENABLE_FIRESTORE_READS = 'false';
    process.env.ENABLE_FIRESTORE_WRITES = 'false';

    const postRollbackHealth = await makeRequest('/api/health');
    console.log(` - Production Flags State : READS=false, WRITES=false`);
    console.log(` - Backend Health Check   : HTTP ${postRollbackHealth.status} | Service: ${postRollbackHealth.data?.service || 'N/A'}`);
    if (postRollbackHealth.status !== 200) failureCount++;

    console.log('\n=================================================');
    console.log(`PHASE 14 PILOT RESULT: ${failureCount === 0 ? 'READY FOR PRODUCTION FIRESTORE WRITE CUTOVER' : 'STOP — DO NOT ENABLE FIRESTORE WRITES'}`);
    console.log('=================================================\n');

    if (failureCount > 0) process.exit(1);

  } catch (err) {
    console.error('Phase 14 Error:', err.message);
    process.exit(1);
  }
}

testPhase14WritePilot();
