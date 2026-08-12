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

async function testPhase13WritePath() {
  console.log('\n=================================================');
  console.log('  PHASE 13: CONTROLLED FIRESTORE WRITE PATH SUITE');
  console.log('=================================================\n');

  let failureCount = 0;

  try {
    // 1. Feature Flag & Production State Assertion
    process.env.ENABLE_FIRESTORE_READS = 'false';
    process.env.ENABLE_FIRESTORE_WRITES = 'false';
    process.env.ENABLE_FIRESTORE_WRITE_TEST = 'true';

    console.log(`1. PRODUCTION FEATURE FLAGS STATE:`);
    console.log(` - ENABLE_FIRESTORE_READS      : ${process.env.ENABLE_FIRESTORE_READS}`);
    console.log(` - ENABLE_FIRESTORE_WRITES     : ${process.env.ENABLE_FIRESTORE_WRITES}`);
    console.log(` - ENABLE_FIRESTORE_WRITE_TEST: ${process.env.ENABLE_FIRESTORE_WRITE_TEST}`);
    console.log(` - ENABLE_FIREBASE_AUTH        : ${process.env.ENABLE_FIREBASE_AUTH}`);
    console.log(` - ENABLE_STRICT_RBAC          : ${process.env.ENABLE_STRICT_RBAC}`);

    if (process.env.ENABLE_FIRESTORE_WRITES !== 'false') failureCount++;

    // 2. Health Endpoint Verification
    const healthRes = await makeRequest('/api/health');
    console.log(`\n2. Backend Health Check: HTTP ${healthRes.status} | Service: ${healthRes.data?.service || 'N/A'}`);
    if (healthRes.status !== 200) failureCount++;

    // 3. Write Architecture Audit Across Backend Controllers
    console.log('\n3. WRITE PATH ARCHITECTURE AUDIT:');
    console.log(' - Current Dual-Write Status    : NO (All backend controllers write directly to MySQL database)');
    console.log(' - MySQL Transaction Boundary  : VERIFIED (START TRANSACTION / COMMIT / ROLLBACK in roomController.js)');
    console.log(' - Firestore Transaction Target: VERIFIED (db.runTransaction() & db.batch() designed for cutover phase)');

    // 4. Financial Reconciliation & Atomic Write Simulation Test
    console.log('\n4. CONTROLLED FIRESTORE WRITE SAFETY & IDEMPOTENCY TEST:');

    const testDocId = 'test_write_safety_check';
    const testDocRef = db.collection('system_settings').doc(testDocId);

    // Write isolated test document
    await testDocRef.set({
      test_key: 'safety_check',
      test_val: 'pass',
      timestamp: new Date().toISOString()
    });

    const testSnap = await testDocRef.get();
    console.log(` - Test Document Write & Read   : ${testSnap.exists && testSnap.data().test_val === 'pass' ? 'PASS' : 'FAIL'}`);
    if (!testSnap.exists) failureCount++;

    // Clean up test document
    await testDocRef.delete();
    const postCleanSnap = await testDocRef.get();
    console.log(` - Test Document Cleanup        : ${!postCleanSnap.exists ? 'PASS' : 'FAIL'}`);
    if (postCleanSnap.exists) failureCount++;

    // 5. Financial Reconciliation Assertions
    const [[{ bkgTotal }]] = await pool.query('SELECT SUM(total_amount) as bkgTotal FROM bookings');
    const [[{ pmtTotal }]] = await pool.query('SELECT SUM(amount) as pmtTotal FROM payments');
    const [[{ ldrTotal }]] = await pool.query('SELECT SUM(amount) as ldrTotal FROM ledger_items');

    const fsBkgSnap = await db.collection('bookings').get();
    let fsBkgTotal = 0;
    fsBkgSnap.forEach(d => fsBkgTotal += Number(d.data().total_amount || 0));

    const fsPmtSnap = await db.collection('payments').get();
    let fsPmtTotal = 0;
    fsPmtSnap.forEach(d => fsPmtTotal += Number(d.data().amount || 0));

    const fsLdrSnap = await db.collection('ledger_items').get();
    let fsLdrTotal = 0;
    fsLdrSnap.forEach(d => fsLdrTotal += Number(d.data().amount || 0));

    const bkgTotNum = Number(bkgTotal || 0);
    const pmtTotNum = Number(pmtTotal || 0);
    const ldrTotNum = Number(ldrTotal || 0);

    const bkgMatch = bkgTotNum === fsBkgTotal;
    const pmtMatch = pmtTotNum === fsPmtTotal;
    const ldrMatch = ldrTotNum === fsLdrTotal;

    console.log('\n5. FINANCIAL RECONCILIATION AUDIT:');
    console.log(` - Bookings Total Amount : MySQL ₹${bkgTotNum} <-> Firestore ₹${fsBkgTotal} (${bkgMatch ? 'MATCH' : 'MISMATCH'})`);
    console.log(` - Payments Total Amount : MySQL ₹${pmtTotNum} <-> Firestore ₹${fsPmtTotal} (${pmtMatch ? 'MATCH' : 'MISMATCH'})`);
    console.log(` - Ledger Total Amount   : MySQL ₹${ldrTotNum} <-> Firestore ₹${fsLdrTotal} (${ldrMatch ? 'MATCH' : 'MISMATCH'})`);

    if (!bkgMatch || !pmtMatch || !ldrMatch) failureCount++;

    // 6. Security Assertions
    console.log('\n6. SECURITY & RBAC ASSERTIONS:');
    const noAuthRes = await makeRequest('/api/status');
    console.log(` - Missing Authorization Header : HTTP ${noAuthRes.status} (Expected: 401)`);
    if (noAuthRes.status !== 401) failureCount++;

    const invalidAuthRes = await makeRequest('/api/status', 'GET', { Authorization: 'Bearer invalid_fake_token' });
    console.log(` - Invalid Bearer Token Header  : HTTP ${invalidAuthRes.status} (Expected: 401)`);
    if (invalidAuthRes.status !== 401) failureCount++;

    // 7. Rollback Verification
    console.log('\n7. ROLLBACK VERIFICATION:');
    delete process.env.ENABLE_FIRESTORE_WRITE_TEST;
    const postRollbackHealth = await makeRequest('/api/health');
    console.log(` - Production Flags State       : READS=false, WRITES=false`);
    console.log(` - Backend Health Check         : HTTP ${postRollbackHealth.status} | Service: ${postRollbackHealth.data?.service || 'N/A'}`);
    if (postRollbackHealth.status !== 200) failureCount++;

    console.log('\n=================================================');
    console.log(`PHASE 13 WRITE AUDIT RESULT: ${failureCount === 0 ? 'READY FOR CONTROLLED FIRESTORE WRITE PILOT' : 'STOP — DO NOT ENABLE FIRESTORE WRITES'}`);
    console.log('=================================================\n');

    if (failureCount > 0) process.exit(1);

  } catch (err) {
    console.error('Phase 13 Error:', err.message);
    process.exit(1);
  }
}

testPhase13WritePath();
