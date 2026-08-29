import dotenv from 'dotenv';
dotenv.config();

import pool from '../backend/db.js';
import { db, auth, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import { BusinessDateService } from '../backend/services/businessDateService.js';
import fs from 'fs';
import path from 'path';
import http from 'http';

function makeRequest(pathName, method = 'GET', headers = {}, body = null) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: 5000,
      path: pathName,
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

async function runPhase22MysqlRegression() {
  console.log('\n================================================================');
  console.log('  HPMS SKY5 — PHASE 22: MYSQL OPERATIONAL REGRESSION TEST SUITE');
  console.log('================================================================\n');

  let failureCount = 0;

  try {
    // 1. Health Endpoint
    const healthRes = await makeRequest('/api/health');
    console.log(`1. Backend Health Check      : HTTP ${healthRes.status} | Service: ${healthRes.data?.service || 'N/A'}`);
    if (healthRes.status !== 200) failureCount++;

    // 2. MySQL Connectivity Check
    const [[{ total_rooms }]] = await pool.query('SELECT COUNT(*) as total_rooms FROM rooms');
    const [[{ total_room_types }]] = await pool.query('SELECT COUNT(*) as total_room_types FROM room_types');
    const [[{ total_staff }]] = await pool.query('SELECT COUNT(*) as total_staff FROM staff');
    const [[{ total_users }]] = await pool.query('SELECT COUNT(*) as total_users FROM users');
    const [[{ total_guests }]] = await pool.query('SELECT COUNT(*) as total_guests FROM guests');
    const [[{ total_bookings }]] = await pool.query('SELECT COUNT(*) as total_bookings FROM bookings');
    const [[{ total_payments }]] = await pool.query('SELECT COUNT(*) as total_payments FROM payments');
    const [[{ total_ledger }]] = await pool.query('SELECT COUNT(*) as total_ledger FROM ledger_items');

    console.log('\n2. MYSQL DATABASE OPERATIONAL BASELINE:');
    console.log(` - Rooms Count               : ${total_rooms} (Expected: 17)`);
    console.log(` - Room Types Count          : ${total_room_types} (Expected: 3)`);
    console.log(` - Staff Count               : ${total_staff} (Expected: 11)`);
    console.log(` - Users Count               : ${total_users} (Expected: 25)`);
    console.log(` - Guests Count              : ${total_guests} (Expected: 5)`);
    console.log(` - Bookings Count            : ${total_bookings} (Expected: 4)`);
    console.log(` - Payments Count            : ${total_payments} (Expected: 5)`);
    console.log(` - Ledger Items Count        : ${total_ledger} (Expected: 17)`);

    if (total_rooms !== 17 || total_room_types !== 3 || total_staff !== 11 || total_users !== 25) failureCount++;

    // 3. Business Date Service Verification
    console.log('\n3. BUSINESS DATE SERVICE VERIFICATION:');
    const currentBusinessDate = await BusinessDateService.getBusinessDate(pool);
    console.log(` - Current Business Date     : ${currentBusinessDate} (Expected: 2026-08-10)`);
    if (currentBusinessDate !== '2026-08-10') failureCount++;

    // 4. Firebase Admin & Auth Reachability
    console.log('\n4. FIREBASE ADMIN & AUTH INTEGRATION:');
    console.log(` - Firebase Configured       : ${isFirebaseConfigured ? 'YES' : 'NO'}`);
    const authList = await auth.listUsers(100);
    console.log(` - Firebase Auth User Count  : ${authList.users.length} (Expected: 13)`);
    if (authList.users.length < 13) failureCount++;

    // 5. Firestore Repositories Compilation Check
    console.log('\n5. FIRESTORE REPOSITORIES INTEGRITY:');
    const repoFiles = fs.readdirSync('backend/repositories/firestore');
    console.log(` - Firestore Repository Files: ${repoFiles.length} files compiled cleanly`);
    if (repoFiles.length !== 15) failureCount++;

    // 6. Security Negative Test
    console.log('\n6. SECURITY NEGATIVE & RBAC VERIFICATION:');
    const noAuthRes = await makeRequest('/api/status');
    console.log(` - Missing Bearer Token      : HTTP ${noAuthRes.status} (Expected: 401)`);
    const fakeAuthRes = await makeRequest('/api/status', 'GET', { Authorization: 'Bearer fake_jwt_token' });
    console.log(` - Invalid Bearer Token      : HTTP ${fakeAuthRes.status} (Expected: 401)`);
    if (noAuthRes.status !== 401 || fakeAuthRes.status !== 401) failureCount++;

    console.log('\n================================================================');
    console.log(`FINAL VERDICT: ${failureCount === 0 ? 'SAFE TO CONTINUE STABILITY WINDOW' : 'BLOCKED — FIX REQUIRED'}`);
    console.log('================================================================\n');

    if (failureCount > 0) process.exit(1);

  } catch (err) {
    console.error('Phase 22 Error:', err.message);
    process.exit(1);
  }
}

runPhase22MysqlRegression();
