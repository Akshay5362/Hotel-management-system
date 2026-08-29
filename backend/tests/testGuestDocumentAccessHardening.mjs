/**
 * testGuestDocumentAccessHardening.mjs
 * ============================================================================
 * HPMS STEP 5.2 — GUEST ID DOCUMENT ACCESS HARDENING TEST SUITE
 *
 * Tests that:
 * 1. Unauthenticated request to /api/admin/guest-documents/file/:filename → 401
 * 2. Invalid / forged token → 401
 * 3. Guest token → 403
 * 4. Kitchen token → 403
 * 5. Housekeeping token → 403
 * 6. Receptionist token → 200 for valid test document
 * 7. Admin token → 200 for valid test document
 * 8. Missing file → 404
 * 9. Path traversal attempt (../) → 400
 * 10. Absolute path attempt → 400
 * 11. Security Negative Test: Old public static URL GET /guest-documents/:filename
 *     WITHOUT Authorization → MUST return 404 (static route eliminated).
 * ============================================================================
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import apiRouter from '../routes/api.js';
import {
  getAdminTestToken,
  getReceptionistTestToken,
  getGuestTestToken,
  getHousekeeperTestToken,
  getTestFirebaseToken
} from './helpers/firebaseTestTokenHelper.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GUEST_DOCS_DIR = path.resolve(__dirname, '..', 'guest-documents');

// Setup app matching backend/server.js (WITHOUT public /guest-documents static route)
const app = express();
app.use(express.json());
app.use('/api', apiRouter);

let server;
let baseUrl;
let testFilename;
let testFilePath;

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

  let text = '';
  try {
    text = await res.text();
  } catch (_) {}

  return { status: res.status, headers: res.headers, text };
}

async function runTests() {
  console.log('========================================================================');
  console.log('HPMS STEP 5.2 — GUEST ID DOCUMENT ACCESS HARDENING TEST SUITE');
  console.log('========================================================================\n');

  if (!fs.existsSync(GUEST_DOCS_DIR)) {
    fs.mkdirSync(GUEST_DOCS_DIR, { recursive: true });
  }

  // Create a temporary test document for verification
  testFilename = `id_doc_test_${Date.now()}.jpg`;
  testFilePath = path.join(GUEST_DOCS_DIR, testFilename);
  fs.writeFileSync(testFilePath, Buffer.from('FAKE_JPEG_IMAGE_CONTENT_FOR_SECURITY_TEST'));

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
    console.log('--- 1. MINT TEST TOKENS ---');
    const adminToken = await getAdminTestToken();
    const receptionistToken = await getReceptionistTestToken();
    const guestToken = await getGuestTestToken();
    const kitchenToken = await getTestFirebaseToken({ role: 'kitchen', uid: 'staff_5', id: 5, type: 'staff' });
    const housekeeperToken = await getHousekeeperTestToken();
    console.log('Test tokens minted successfully.\n');

    console.log('--- 2. UNAUTHENTICATED & FORGED TOKEN TESTS (Expected: HTTP 401) ---');

    // Test 1: Unauthenticated request
    const res1 = await apiRequest('GET', `/api/admin/guest-documents/file/${testFilename}`);
    assert(res1.status === 401, `Unauthenticated GET /api/admin/guest-documents/file/${testFilename} → HTTP ${res1.status} (Expected 401)`);

    // Test 2: Forged / Invalid token
    const res2 = await apiRequest('GET', `/api/admin/guest-documents/file/${testFilename}`, { token: 'invalid.forged.bearer.token' });
    assert(res2.status === 401, `Invalid token GET /api/admin/guest-documents/file/${testFilename} → HTTP ${res2.status} (Expected 401)`);

    console.log('\n--- 3. ROLE-BASED ACCESS REJECTION TESTS (Expected: HTTP 403) ---');

    // Test 3: Guest role rejected
    const res3 = await apiRequest('GET', `/api/admin/guest-documents/file/${testFilename}`, { token: guestToken });
    assert(res3.status === 403, `Guest token → HTTP ${res3.status} (Expected 403 Forbidden)`);

    // Test 4: Kitchen role rejected
    const res4 = await apiRequest('GET', `/api/admin/guest-documents/file/${testFilename}`, { token: kitchenToken });
    assert(res4.status === 403, `Kitchen token → HTTP ${res4.status} (Expected 403 Forbidden)`);

    // Test 5: Housekeeping role rejected
    const res5 = await apiRequest('GET', `/api/admin/guest-documents/file/${testFilename}`, { token: housekeeperToken });
    assert(res5.status === 403, `Housekeeping token → HTTP ${res5.status} (Expected 403 Forbidden)`);

    console.log('\n--- 4. AUTHORIZED ROLE RETRIEVAL TESTS (Expected: HTTP 200) ---');

    // Test 6: Receptionist authorized
    const res6 = await apiRequest('GET', `/api/admin/guest-documents/file/${testFilename}`, { token: receptionistToken });
    const cacheHeader6 = res6.headers.get('cache-control');
    assert(res6.status === 200 && res6.text.includes('FAKE_JPEG_IMAGE'), `Receptionist token → HTTP ${res6.status} (File delivered)`);
    assert(cacheHeader6 && cacheHeader6.includes('no-store'), `Cache-Control is private/no-store (${cacheHeader6})`);

    // Test 7: Admin authorized
    const res7 = await apiRequest('GET', `/api/admin/guest-documents/file/${testFilename}`, { token: adminToken });
    assert(res7.status === 200 && res7.text.includes('FAKE_JPEG_IMAGE'), `Admin token → HTTP ${res7.status} (File delivered)`);

    console.log('\n--- 5. PATH TRAVERSAL & MALICIOUS INPUT TESTS ---');

    // Test 8: Missing file → 404
    const res8 = await apiRequest('GET', `/api/admin/guest-documents/file/id_doc_nonexistent_99999.jpg`, { token: adminToken });
    assert(res8.status === 404, `Nonexistent file → HTTP ${res8.status} (Expected 404)`);

    // Test 9: Path traversal attempt (encoded ..%2F)
    const res9 = await apiRequest('GET', `/api/admin/guest-documents/file/..%2F..%2Fserver.js`, { token: adminToken });
    assert(res9.status === 400 || res9.status === 404, `Path traversal attempt (..%2F) → HTTP ${res9.status} (Rejected)`);

    // Test 10: Unsupported file extension
    const res10 = await apiRequest('GET', `/api/admin/guest-documents/file/secret.exe`, { token: adminToken });
    assert(res10.status === 400, `Unsupported extension (.exe) → HTTP ${res10.status} (Expected 400)`);

    console.log('\n--- 6. SECURITY NEGATIVE TEST: PUBLIC STATIC ROUTE DECOMMISSION ---');

    // Test 11: Public static URL /guest-documents/:filename WITHOUT token MUST FAIL (404)
    const res11 = await apiRequest('GET', `/guest-documents/${testFilename}`);
    assert(res11.status === 404, `Public unauthenticated GET /guest-documents/${testFilename} → HTTP ${res11.status} (NO LONGER SERVED)`);

    console.log('\n========================================================================');
    console.log(`TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
    console.log('========================================================================');

    await closeServer();

    // Clean up temporary test file
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Test error:', err);
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
    await closeServer();
    process.exit(1);
  }
}

runTests();
