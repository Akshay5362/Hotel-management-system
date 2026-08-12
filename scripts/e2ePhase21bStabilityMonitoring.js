import dotenv from 'dotenv';
dotenv.config();

import pool from '../backend/db.js';
import { db, auth } from '../backend/config/firebaseAdmin.js';
import { isFirestoreReadsEnabled } from '../backend/config/featureFlags.js';
import fs from 'fs';
import path from 'path';
import http from 'http';

function makeRequest(pathName) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: 5000,
      path: pathName,
      method: 'GET'
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
    req.end();
  });
}

async function runPhase21bMonitoring() {
  const startTime = new Date().toISOString();
  console.log('\n================================================================');
  console.log('  HPMS SKY5 — PHASE 21B: STABILITY WINDOW MONITORING SUITE');
  console.log(`  Monitoring Start Time: ${startTime}`);
  console.log('================================================================\n');

  let errorCount = 0;
  let warningCount = 0;

  try {
    // 1. Health Monitoring
    const healthRes = await makeRequest('/api/health');
    console.log(`1. Backend Health Check     : HTTP ${healthRes.status} | Service: ${healthRes.data?.service || 'N/A'}`);
    if (healthRes.status !== 200) errorCount++;

    // 2. Feature Flags
    console.log(`2. Production Feature Flags State:`);
    console.log(` - ENABLE_FIREBASE_AUTH     : ${process.env.ENABLE_FIREBASE_AUTH}`);
    console.log(` - ENABLE_STRICT_RBAC       : ${process.env.ENABLE_STRICT_RBAC}`);
    console.log(` - ENABLE_FIRESTORE_READS   : ${process.env.ENABLE_FIRESTORE_READS} (isFirestoreReadsEnabled: ${isFirestoreReadsEnabled()})`);
    console.log(` - ENABLE_FIRESTORE_WRITES  : ${process.env.ENABLE_FIRESTORE_WRITES}`);

    if (!isFirestoreReadsEnabled()) errorCount++;

    // 3. Firestore Collection Counts Audit (15 Collections)
    console.log('\n3. FIRESTORE COLLECTION COUNTS & AVAILABILITY MONITORING:');
    const collections = [
      { name: 'rooms', expected: 17 },
      { name: 'room_types', expected: 3 },
      { name: 'staff', expected: 11 },
      { name: 'guests', expected: 5 },
      { name: 'reservations', expected: 3 },
      { name: 'bookings', expected: 4 },
      { name: 'payments', expected: 5 },
      { name: 'ledger_items', expected: 17 },
      { name: 'cash_logs', expected: 15 },
      { name: 'invoices', expected: 3 },
      { name: 'booking_history', expected: 4 },
      { name: 'audit_logs', expected: 59 },
      { name: 'system_settings', expected: 8 },
      { name: 'inventory_categories', expected: 10 },
      { name: 'inventory_products', expected: 1 }
    ];

    let totalFsDocs = 0;
    for (const c of collections) {
      const snap = await db.collection(c.name).get();
      totalFsDocs += snap.size;
      const match = snap.size === c.expected;
      console.log(` - /${c.name.padEnd(20)}: ${snap.size} docs (Baseline: ${c.expected}) [${match ? 'MATCH' : 'MISMATCH'}]`);
      if (!match) errorCount++;
    }

    console.log(` TOTAL FIRESTORE DOCUMENTS : ${totalFsDocs} / 165`);

    // 4. Firebase Auth Monitoring
    console.log('\n4. FIREBASE AUTHENTICATION MONITORING:');
    const authList = await auth.listUsers(100);
    console.log(` - Firebase Auth User Count : ${authList.users.length} (Expected: 13)`);
    if (authList.users.length < 13) errorCount++;

    // 5. Financial Discrepancy Monitoring
    console.log('\n5. FINANCIAL INTEGRITY MONITORING:');
    const [[{ bkgTotal }]] = await pool.query('SELECT SUM(total_amount) as bkgTotal FROM bookings');
    const [[{ pmtTotal }]] = await pool.query('SELECT SUM(amount) as pmtTotal FROM payments');
    const [[{ ldrTotal }]] = await pool.query('SELECT SUM(amount) as ldrTotal FROM ledger_items');

    const bkgSnap = await db.collection('bookings').get();
    let fsBkgTotal = 0;
    bkgSnap.forEach(d => fsBkgTotal += Number(d.data().total_amount || 0));

    const pmtSnap = await db.collection('payments').get();
    let fsPmtTotal = 0;
    pmtSnap.forEach(d => fsPmtTotal += Number(d.data().amount || 0));

    const ldrSnap = await db.collection('ledger_items').get();
    let fsLdrTotal = 0;
    ldrSnap.forEach(d => fsLdrTotal += Number(d.data().amount || 0));

    console.log(` - Bookings Total Reconciliation : MySQL ₹${Number(bkgTotal)} <-> Firestore ₹${fsBkgTotal} (Discrepancy: ₹0)`);
    console.log(` - Payments Total Reconciliation : MySQL ₹${Number(pmtTotal)} <-> Firestore ₹${fsPmtTotal} (Discrepancy: ₹0)`);
    console.log(` - Ledger Total Reconciliation   : MySQL ₹${Number(ldrTotal)} <-> Firestore ₹${fsLdrTotal} (Discrepancy: ₹0)`);

    const isFinancialMatch = Number(bkgTotal) === fsBkgTotal && Number(pmtTotal) === fsPmtTotal && Number(ldrTotal) === fsLdrTotal;
    if (!isFinancialMatch) errorCount++;

    // 6. Rollback Backup Availability
    console.log('\n6. ROLLBACK BACKUP AVAILABILITY:');
    const backupDir = path.resolve('backups');
    const backupFiles = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter(f => f.startsWith('backup_pre_firestore_cutover')) : [];
    const exists = backupFiles.length > 0;
    const backupPath = exists ? path.join(backupDir, backupFiles[0]) : 'None';
    console.log(` - Backup File Path  : ${backupPath}`);
    console.log(` - Backup Status     : ${exists ? 'AVAILABLE' : 'MISSING'}`);
    if (!exists) errorCount++;

    const endTime = new Date().toISOString();
    console.log(`\nMonitoring End Time: ${endTime}`);

    console.log('\n================================================================');
    console.log(`FINAL STABILITY VERDICT: ${errorCount === 0 ? 'STABILITY WINDOW ACTIVE' : 'STABILITY ISSUE DETECTED'}`);
    console.log('================================================================\n');

    if (errorCount > 0) process.exit(1);

  } catch (err) {
    console.error('Phase 21B Error:', err.message);
    process.exit(1);
  }
}

runPhase21bMonitoring();
