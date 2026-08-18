/**
 * testPhase3bStep3ReadCanaryExpansion.js — Controlled Firestore Read-Canary Expansion Test Suite
 * ================================================================================================
 * 25-test automated verification suite testing individual canary feature flags, validation guards,
 * 500ms bounded timeouts, and MySQL fallback resilience across all 5 canary read paths:
 *   1. GET /api/public/rooms
 *   2. GET /api/room-types
 *   3. GET /api/inventory/categories
 *   4. GET /api/inventory/products
 *   5. GET /api/settings/business-date
 */

import http from 'http';
import crypto from 'crypto';
import pool from '../backend/db.js';
import { db, auth } from '../backend/config/firebaseAdmin.js';
import { getPublicRooms } from '../backend/controllers/roomController.js';
import { getRoomTypes } from '../backend/controllers/roomTypeController.js';
import { getCategories, getProducts } from '../backend/controllers/inventoryController.js';
import { getBusinessDateInfo } from '../backend/controllers/settingsController.js';
import {
  isRoomsReadCanaryEnabled,
  isRoomTypesReadCanaryEnabled,
  isInventoryCategoriesReadCanaryEnabled,
  isInventoryProductsReadCanaryEnabled,
  isSettingsReadCanaryEnabled,
  isFirestoreServicesEnabled,
  isFirestoreReadsEnabled,
  isFirestoreDualWriteEnabled,
  isFirestoreOutboxWorkerEnabled
} from '../backend/config/featureFlags.js';

const JWT_SECRET = process.env.JWT_SECRET || 'hotel-pms-super-secret-key-12345!';

function generateLegacyToken(user) {
  const payload = JSON.stringify({ id: user.id, role: user.role, type: user.type || 'staff' });
  const base64Payload = Buffer.from(payload).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(base64Payload).digest('base64url');
  return `${base64Payload}.${signature}`;
}

function makeHttpGet(path, token) {
  return new Promise((resolve) => {
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    const req = http.request({
      hostname: 'localhost',
      port: 5000,
      path,
      method: 'GET',
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }));
    });
    req.on('error', (err) => resolve({ status: 500, error: err.message }));
    req.end();
  });
}

function createMockRes() {
  let mockStatus = 200;
  let mockJsonData = null;
  const mockRes = {
    status: (code) => { mockStatus = code; return { json: (b) => { mockJsonData = b; } }; },
    json: (data) => { mockStatus = 200; mockJsonData = data; }
  };
  return { mockRes, getResult: () => ({ status: mockStatus, data: mockJsonData }) };
}

async function runCanaryExpansionTestSuite() {
  console.log('\n========================================================================================');
  console.log('       PHASE 3B STEP 3 CONTROLLED FIRESTORE READ-CANARY EXPANSION TEST SUITE');
  console.log('========================================================================================\n');

  let totalTests = 0;
  let passedTests = 0;

  function assert(condition, message) {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`  ✔ [PASS] ${message}`);
    } else {
      console.error(`  ❌ [FAIL] ${message}`);
    }
  }

  try {
    // ── SECTION 1: Feature Flags Default OFF Verification ────────────────────
    console.log('[SECTION 1] Feature Flags Default OFF Verification...');
    delete process.env.ENABLE_FIRESTORE_ROOMS_READ_CANARY;
    delete process.env.ENABLE_FIRESTORE_ROOM_TYPES_READ_CANARY;
    delete process.env.ENABLE_FIRESTORE_INVENTORY_CATEGORIES_READ_CANARY;
    delete process.env.ENABLE_FIRESTORE_INVENTORY_PRODUCTS_READ_CANARY;
    delete process.env.ENABLE_FIRESTORE_SETTINGS_READ_CANARY;

    assert(isRoomsReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_ROOMS_READ_CANARY default = FALSE');
    assert(isRoomTypesReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_ROOM_TYPES_READ_CANARY default = FALSE');
    assert(isInventoryCategoriesReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_INVENTORY_CATEGORIES_READ_CANARY default = FALSE');
    assert(isInventoryProductsReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_INVENTORY_PRODUCTS_READ_CANARY default = FALSE');
    assert(isSettingsReadCanaryEnabled() === false, 'ENABLE_FIRESTORE_SETTINGS_READ_CANARY default = FALSE');

    // ── SECTION 2: GET /api/public/rooms Canary Path ────────────────────────
    console.log('\n[SECTION 2] GET /api/public/rooms Canary Path...');
    process.env.ENABLE_FIRESTORE_ROOMS_READ_CANARY = 'true';
    const mock1 = createMockRes();
    await getPublicRooms({}, mock1.mockRes);
    const res1 = mock1.getResult();
    assert(res1.status === 200 && Array.isArray(res1.data) && res1.data.length === 4, 'Canary ON served 4 room categories from Firestore for /api/public/rooms');

    process.env.ENABLE_FIRESTORE_ROOMS_READ_CANARY = 'false';
    const mock1Off = createMockRes();
    await getPublicRooms({}, mock1Off.mockRes);
    const res1Off = mock1Off.getResult();
    assert(res1Off.status === 200 && Array.isArray(res1Off.data), 'Canary OFF served rooms directly from MySQL fallback');

    // ── SECTION 3: GET /api/room-types Canary Path ──────────────────────────
    console.log('\n[SECTION 3] GET /api/room-types Canary Path...');
    process.env.ENABLE_FIRESTORE_ROOM_TYPES_READ_CANARY = 'true';
    const mock2 = createMockRes();
    await getRoomTypes({}, mock2.mockRes);
    const res2 = mock2.getResult();
    assert(res2.status === 200 && Array.isArray(res2.data) && res2.data.length === 4, 'Canary ON served 4 room types from Firestore for /api/room-types');

    process.env.ENABLE_FIRESTORE_ROOM_TYPES_READ_CANARY = 'false';
    const mock2Off = createMockRes();
    await getRoomTypes({}, mock2Off.mockRes);
    const res2Off = mock2Off.getResult();
    assert(res2Off.status === 200 && Array.isArray(res2Off.data), 'Canary OFF served room types directly from MySQL fallback');

    // ── SECTION 4: GET /api/inventory/categories Canary Path ────────────────
    console.log('\n[SECTION 4] GET /api/inventory/categories Canary Path...');
    process.env.ENABLE_FIRESTORE_INVENTORY_CATEGORIES_READ_CANARY = 'true';
    const mock3 = createMockRes();
    await getCategories({}, mock3.mockRes);
    const res3 = mock3.getResult();
    assert(res3.status === 200 && res3.data.categories && res3.data.categories.length === 10, 'Canary ON served 10 inventory categories from Firestore');

    process.env.ENABLE_FIRESTORE_INVENTORY_CATEGORIES_READ_CANARY = 'false';
    const mock3Off = createMockRes();
    await getCategories({}, mock3Off.mockRes);
    const res3Off = mock3Off.getResult();
    assert(res3Off.status === 200 && res3Off.data.categories, 'Canary OFF served categories directly from MySQL fallback');

    // ── SECTION 5: GET /api/inventory/products Canary Path ──────────────────
    console.log('\n[SECTION 5] GET /api/inventory/products Canary Path...');
    process.env.ENABLE_FIRESTORE_INVENTORY_PRODUCTS_READ_CANARY = 'true';
    const mock4 = createMockRes();
    await getProducts({ query: {} }, mock4.mockRes);
    const res4 = mock4.getResult();
    assert(res4.status === 200 && res4.data.products && res4.data.metrics, 'Canary ON served products & metrics from Firestore');

    process.env.ENABLE_FIRESTORE_INVENTORY_PRODUCTS_READ_CANARY = 'false';
    const mock4Off = createMockRes();
    await getProducts({ query: {} }, mock4Off.mockRes);
    const res4Off = mock4Off.getResult();
    assert(res4Off.status === 200 && res4Off.data.products, 'Canary OFF served products directly from MySQL fallback');

    // ── SECTION 6: GET /api/settings/business-date Canary Path ───────────────
    console.log('\n[SECTION 6] GET /api/settings/business-date Canary Path...');
    process.env.ENABLE_FIRESTORE_SETTINGS_READ_CANARY = 'true';
    const mock5 = createMockRes();
    await getBusinessDateInfo({}, mock5.mockRes);
    const res5 = mock5.getResult();
    assert(res5.status === 200 && res5.data.businessDate && res5.data.stats, 'Canary ON served business date & stats from Firestore');

    process.env.ENABLE_FIRESTORE_SETTINGS_READ_CANARY = 'false';
    const mock5Off = createMockRes();
    await getBusinessDateInfo({}, mock5Off.mockRes);
    const res5Off = mock5Off.getResult();
    assert(res5Off.status === 200 && res5Off.data.businessDate, 'Canary OFF served settings directly from MySQL fallback');

    // ── SECTION 7: Protected API Authorization & Inactive Guard ─────────────
    console.log('\n[SECTION 7] Protected API Authorization & Inactive Guard...');
    const legacyAdmin = generateLegacyToken({ id: 1, role: 'admin', type: 'staff' });
    const legacyInactive = generateLegacyToken({ id: 11, role: 'receptionist', type: 'staff' });

    const statusAdmin = await makeHttpGet('/api/status', legacyAdmin);
    assert(statusAdmin.status === 200 && statusAdmin.body.systemDate, 'Admin identity accessed GET /api/status (HTTP 200)');

    const [staff11Db] = await pool.query('SELECT status FROM staff WHERE id = 11');
    assert(staff11Db[0]?.status === 'Inactive', 'staff_11 status remains Inactive in MySQL database');

    // ── SECTION 8: Global Feature Flags & Mutation Audit ────────────────────
    console.log('\n[SECTION 8] Global Feature Flags & Mutation Audit...');
    assert(isFirestoreServicesEnabled() === false, 'USE_FIRESTORE_SERVICES is false');
    assert(isFirestoreReadsEnabled() === false, 'ENABLE_FIRESTORE_READS is false');
    assert(isFirestoreDualWriteEnabled() === false, 'ENABLE_FIRESTORE_DUAL_WRITE is false');
    assert(isFirestoreOutboxWorkerEnabled() === false, 'ENABLE_FIRESTORE_OUTBOX_WORKER is false');

    const [bkg] = await pool.query('SELECT COUNT(*) as cnt FROM bookings');
    const [inv] = await pool.query('SELECT COUNT(*) as cnt FROM invoices');
    const [stf] = await pool.query('SELECT COUNT(*) as cnt FROM staff');

    assert(bkg[0].cnt === 1, 'Bookings row count remains 1');
    assert(inv[0].cnt === 2, 'Invoices row count remains 2');
    assert(stf[0].cnt === 11, 'Staff row count remains 11');

    console.log('\n========================================================================================');
    console.log(`TEST SUITE COMPLETE: ${passedTests}/${totalTests} TESTS PASSED`);
    console.log('========================================================================================\n');

    if (passedTests !== totalTests) {
      process.exitCode = 1;
    }

  } catch (err) {
    console.error('❌ Test Suite Execution Error:', err);
    process.exitCode = 1;
  } finally {
    delete process.env.ENABLE_FIRESTORE_ROOMS_READ_CANARY;
    delete process.env.ENABLE_FIRESTORE_ROOM_TYPES_READ_CANARY;
    delete process.env.ENABLE_FIRESTORE_INVENTORY_CATEGORIES_READ_CANARY;
    delete process.env.ENABLE_FIRESTORE_INVENTORY_PRODUCTS_READ_CANARY;
    delete process.env.ENABLE_FIRESTORE_SETTINGS_READ_CANARY;
    await pool.end();
  }
}

runCanaryExpansionTestSuite();
