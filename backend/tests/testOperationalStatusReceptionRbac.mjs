/**
 * testOperationalStatusReceptionRbac.mjs
 * ============================================================================
 * HPMS STEP 5.3 — H3 OPERATIONAL STATUS & RECEPTION GUEST RBAC TEST SUITE
 *
 * Tests that:
 * 1. GET /api/status without token → 401
 * 2. GET /api/status with forged token → 401
 * 3. GET /api/status with guest token → 403
 * 4. GET /api/status with kitchen token → 403
 * 5. GET /api/status with housekeeping token → 403
 * 6. GET /api/status with receptionist token → 200
 * 7. GET /api/status with admin token → 200
 *
 * 8. GET /api/reception/guests/search?q=a with guest token → 403
 * 9. GET /api/reception/guests/search?q=a with kitchen token → 403
 * 10. GET /api/reception/guests/search?q=a with housekeeping token → 403
 * 11. GET /api/reception/guests/search?q=test with receptionist token → Authorized (passes RBAC)
 * 12. GET /api/reception/guests/search?q=test with admin token → Authorized (passes RBAC)
 *
 * 13. GET /api/reception/guests/history/1 with guest token → 403
 * 14. GET /api/reception/guests/history/1 with kitchen token → 403
 * 15. GET /api/reception/guests/history/1 with housekeeping token → 403
 * 16. GET /api/reception/guests/history/1 with receptionist token → Authorized (passes RBAC)
 * 17. GET /api/reception/guests/history/1 with admin token → Authorized (passes RBAC)
 * ============================================================================
 */

import express from 'express';
import { createServer } from 'http';
import apiRouter from '../routes/api.js';
import {
  getAdminTestToken,
  getReceptionistTestToken,
  getGuestTestToken,
  getHousekeeperTestToken,
  getTestFirebaseToken
} from './helpers/firebaseTestTokenHelper.mjs';

const app = express();
app.use(express.json());
app.use('/api', apiRouter);

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

async function apiRequest(method, urlPath, { token } = {}) {
  const headers = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers
  });

  let body = null;
  try {
    body = await res.json();
  } catch (_) {}

  return { status: res.status, headers: res.headers, body };
}

async function runTests() {
  console.log('========================================================================');
  console.log('HPMS STEP 5.3 — OPERATIONAL STATUS & RECEPTION GUEST RBAC TEST SUITE');
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
    const kitchenToken = await getTestFirebaseToken({ role: 'kitchen', uid: 'staff_5', id: 5, type: 'staff' });
    const housekeeperToken = await getHousekeeperTestToken();
    console.log('Test tokens minted successfully.\n');

    console.log('--- 2. GET /api/status RBAC TESTS ---');

    // TEST 1: No Authorization header
    const res1 = await apiRequest('GET', '/api/status');
    assert(res1.status === 401, `No Authorization header GET /api/status → HTTP ${res1.status} (Expected 401)`);

    // TEST 2: Forged/malformed token
    const res2 = await apiRequest('GET', '/api/status', { token: 'invalid.forged.jwt.token' });
    assert(res2.status === 401, `Forged token GET /api/status → HTTP ${res2.status} (Expected 401)`);

    // TEST 3: Guest token
    const res3 = await apiRequest('GET', '/api/status', { token: guestToken });
    assert(res3.status === 403, `Guest token GET /api/status → HTTP ${res3.status} (Expected 403)`);

    // TEST 4: Kitchen token
    const res4 = await apiRequest('GET', '/api/status', { token: kitchenToken });
    assert(res4.status === 403, `Kitchen token GET /api/status → HTTP ${res4.status} (Expected 403)`);

    // TEST 5: Housekeeping token
    const res5 = await apiRequest('GET', '/api/status', { token: housekeeperToken });
    assert(res5.status === 403, `Housekeeping token GET /api/status → HTTP ${res5.status} (Expected 403)`);

    // TEST 6: Receptionist token
    const res6 = await apiRequest('GET', '/api/status', { token: receptionistToken });
    assert(res6.status === 200, `Receptionist token GET /api/status → HTTP ${res6.status} (Expected 200)`);

    // TEST 7: Admin token
    const res7 = await apiRequest('GET', '/api/status', { token: adminToken });
    assert(res7.status === 200, `Admin token GET /api/status → HTTP ${res7.status} (Expected 200)`);

    console.log('\n--- 3. GET /api/reception/guests/search RBAC TESTS ---');

    // TEST 8: Guest token
    const res8 = await apiRequest('GET', '/api/reception/guests/search?q=test', { token: guestToken });
    assert(res8.status === 403, `Guest token GET /api/reception/guests/search → HTTP ${res8.status} (Expected 403)`);

    // TEST 9: Kitchen token
    const res9 = await apiRequest('GET', '/api/reception/guests/search?q=test', { token: kitchenToken });
    assert(res9.status === 403, `Kitchen token GET /api/reception/guests/search → HTTP ${res9.status} (Expected 403)`);

    // TEST 10: Housekeeping token
    const res10 = await apiRequest('GET', '/api/reception/guests/search?q=test', { token: housekeeperToken });
    assert(res10.status === 403, `Housekeeping token GET /api/reception/guests/search → HTTP ${res10.status} (Expected 403)`);

    // TEST 11: Receptionist token
    const res11 = await apiRequest('GET', '/api/reception/guests/search?q=test', { token: receptionistToken });
    assert(res11.status === 200, `Receptionist token GET /api/reception/guests/search → HTTP ${res11.status} (Authorized)`);

    // TEST 12: Admin token
    const res12 = await apiRequest('GET', '/api/reception/guests/search?q=test', { token: adminToken });
    assert(res12.status === 200, `Admin token GET /api/reception/guests/search → HTTP ${res12.status} (Authorized)`);

    console.log('\n--- 4. GET /api/reception/guests/history/:guestId RBAC TESTS ---');

    // TEST 13: Guest token
    const res13 = await apiRequest('GET', '/api/reception/guests/history/1', { token: guestToken });
    assert(res13.status === 403, `Guest token GET /api/reception/guests/history/1 → HTTP ${res13.status} (Expected 403)`);

    // TEST 14: Kitchen token
    const res14 = await apiRequest('GET', '/api/reception/guests/history/1', { token: kitchenToken });
    assert(res14.status === 403, `Kitchen token GET /api/reception/guests/history/1 → HTTP ${res14.status} (Expected 403)`);

    // TEST 15: Housekeeping token
    const res15 = await apiRequest('GET', '/api/reception/guests/history/1', { token: housekeeperToken });
    assert(res15.status === 403, `Housekeeping token GET /api/reception/guests/history/1 → HTTP ${res15.status} (Expected 403)`);

    // TEST 16: Receptionist token
    const res16 = await apiRequest('GET', '/api/reception/guests/history/1', { token: receptionistToken });
    assert(res16.status !== 401 && res16.status !== 403, `Receptionist token GET /api/reception/guests/history/1 → HTTP ${res16.status} (Passes RBAC)`);

    // TEST 17: Admin token
    const res17 = await apiRequest('GET', '/api/reception/guests/history/1', { token: adminToken });
    assert(res17.status !== 401 && res17.status !== 403, `Admin token GET /api/reception/guests/history/1 → HTTP ${res17.status} (Passes RBAC)`);

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
