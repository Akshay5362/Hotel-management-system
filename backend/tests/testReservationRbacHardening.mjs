/**
 * testReservationRbacHardening.mjs
 * ============================================================================
 * HPMS STEP 5.1 — RESERVATION RBAC HARDENING TEST SUITE
 *
 * Tests that:
 * 1. Guest tokens are rejected with HTTP 403 on all management routes:
 *    - GET    /api/reservations/
 *    - GET    /api/reservations/:id
 *    - PUT    /api/reservations/:id
 *    - POST   /api/reservations/:id/cancel
 *    - POST   /api/reservations/:id/checkin
 *    - GET    /api/reservations/report
 * 2. Receptionist & Admin tokens are authorized on management routes.
 * 3. Unauthenticated requests are rejected with HTTP 401.
 * 4. Invalid/forged tokens are rejected with HTTP 401.
 * 5. Available-rooms remains accessible to authenticated users.
 * ============================================================================
 */

import express from 'express';
import reservationRoutes from '../routes/reservationRoutes.js';
import {
  getAdminTestToken,
  getReceptionistTestToken,
  getGuestTestToken
} from './helpers/firebaseTestTokenHelper.mjs';

const app = express();
app.use(express.json());
app.use('/api/reservations', reservationRoutes);

// Custom supertest-like fetch against in-memory express app
import { createServer } from 'http';

let server;
let baseUrl;

async function startServer() {
  return new Promise((resolve) => {
    server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

async function closeServer() {
  return new Promise((resolve) => {
    server.close(resolve);
  });
}

async function apiRequest(method, path, { token, body } = {}) {
  const headers = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  let data = null;
  try {
    data = await res.json();
  } catch (_) {}

  return { status: res.status, body: data };
}

async function runTests() {
  console.log('========================================================================');
  console.log('HPMS STEP 5.1 — RESERVATION RBAC HARDENING TEST SUITE');
  console.log('========================================================================\n');

  await startServer();

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(` ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(` ❌ FAIL: ${message}`);
      failed++;
    }
  }

  try {
    console.log('--- 1. MINT AUTHENTIC TEST TOKENS ---');
    const adminToken = await getAdminTestToken();
    const receptionistToken = await getReceptionistTestToken();
    const guestToken = await getGuestTestToken();
    console.log('Tokens successfully minted.\n');

    console.log('--- 2. GUEST ROLE REJECTION TESTS (Expected: HTTP 403) ---');

    // Test 1: Guest GET /api/reservations/
    const res1 = await apiRequest('GET', '/api/reservations/', { token: guestToken });
    assert(res1.status === 403, `Guest GET /api/reservations/ → HTTP ${res1.status} (Expected 403)`);

    // Test 2: Guest GET /api/reservations/:id
    const res2 = await apiRequest('GET', '/api/reservations/1', { token: guestToken });
    assert(res2.status === 403, `Guest GET /api/reservations/1 → HTTP ${res2.status} (Expected 403)`);

    // Test 3: Guest PUT /api/reservations/:id
    const res3 = await apiRequest('PUT', '/api/reservations/1', { token: guestToken, body: { guestName: 'Hacker' } });
    assert(res3.status === 403, `Guest PUT /api/reservations/1 → HTTP ${res3.status} (Expected 403)`);

    // Test 4: Guest POST /api/reservations/:id/cancel
    const res4 = await apiRequest('POST', '/api/reservations/1/cancel', { token: guestToken });
    assert(res4.status === 403, `Guest POST /api/reservations/1/cancel → HTTP ${res4.status} (Expected 403)`);

    // Test 5: Guest POST /api/reservations/:id/checkin
    const res5 = await apiRequest('POST', '/api/reservations/1/checkin', { token: guestToken });
    assert(res5.status === 403, `Guest POST /api/reservations/1/checkin → HTTP ${res5.status} (Expected 403)`);

    // Test 6: Guest GET /api/reservations/report
    const res6 = await apiRequest('GET', '/api/reservations/report', { token: guestToken });
    assert(res6.status === 403, `Guest GET /api/reservations/report → HTTP ${res6.status} (Expected 403)`);

    console.log('\n--- 3. RECEPTIONIST ROLE AUTHORIZATION TESTS (Expected: Authorized / Not 403) ---');

    // Test 7: Receptionist GET /api/reservations/
    const res7 = await apiRequest('GET', '/api/reservations/', { token: receptionistToken });
    assert(res7.status !== 403 && res7.status !== 401, `Receptionist GET /api/reservations/ → HTTP ${res7.status} (Authorized)`);

    // Test 8: Receptionist GET /api/reservations/report
    const res8 = await apiRequest('GET', '/api/reservations/report', { token: receptionistToken });
    assert(res8.status !== 403 && res8.status !== 401, `Receptionist GET /api/reservations/report → HTTP ${res8.status} (Authorized)`);

    console.log('\n--- 4. ADMIN ROLE AUTHORIZATION TESTS (Expected: Authorized / Not 403) ---');

    // Test 9: Admin GET /api/reservations/
    const res9 = await apiRequest('GET', '/api/reservations/', { token: adminToken });
    assert(res9.status !== 403 && res9.status !== 401, `Admin GET /api/reservations/ → HTTP ${res9.status} (Authorized)`);

    // Test 10: Admin GET /api/reservations/report
    const res10 = await apiRequest('GET', '/api/reservations/report', { token: adminToken });
    assert(res10.status !== 403 && res10.status !== 401, `Admin GET /api/reservations/report → HTTP ${res10.status} (Authorized)`);

    console.log('\n--- 5. UNAUTHENTICATED & FORGED TOKEN REJECTION TESTS (Expected: HTTP 401) ---');

    // Test 11: Missing Authorization Header
    const res11 = await apiRequest('GET', '/api/reservations/');
    assert(res11.status === 401, `Missing Authorization header → HTTP ${res11.status} (Expected 401)`);

    // Test 12: Forged / Invalid Bearer Token
    const res12 = await apiRequest('GET', '/api/reservations/', { token: 'forged.invalid.token' });
    assert(res12.status === 401, `Forged / Invalid Token → HTTP ${res12.status} (Expected 401)`);

    console.log('\n--- 6. SHARED ENDPOINT AVAILABILITY ---');

    // Test 13: Available rooms with guest token (accessible, validates query params)
    const res13 = await apiRequest('GET', '/api/reservations/available-rooms', { token: guestToken });
    assert(res13.status === 400 && res13.body?.error?.includes('Arrival date'), `Guest GET /api/reservations/available-rooms → HTTP ${res13.status} (Passes RBAC, hits controller validation)`);

    console.log('\n========================================================================');
    console.log(`TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
    console.log('========================================================================');

    await closeServer();

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Test error:', err);
    await closeServer();
    process.exit(1);
  }
}

runTests();
