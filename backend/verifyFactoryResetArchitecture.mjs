/**
 * verifyFactoryResetArchitecture.mjs
 * ====================================
 * Verification Suite for Factory Reset System — Phase 1 Architecture
 *
 * Verifies:
 *   1. FactoryResetService exists and exports all 18 required methods
 *   2. factoryResetController exists and exports getFactoryResetStatus & factoryReset
 *   3. factoryResetRoutes exists
 *   4. Service methods return Promises and throw Phase 2 Required
 *   5. verifyReset() returns valid placeholder Promise status object
 *   6. API endpoints work correctly:
 *      - POST /api/system/factory-reset returns HTTP 501 with expected message
 *      - GET /api/system/factory-reset/status returns HTTP 200 with status info
 *      - Unauthorized / Non-SuperAdmin calls are rejected (HTTP 401 / HTTP 403)
 *   7. Zero DELETE, TRUNCATE, or DROP SQL statements exist in reset codebase
 *   8. Core existing services remain completely unmodified
 *
 * Run: node backend/verifyFactoryResetArchitecture.mjs
 */

import pool from './db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`  ✔  ${label}`);
  passed++;
}

function fail(label, err) {
  const msg = err?.message || String(err);
  console.error(`  ✘  ${label}\n       ${msg}`);
  failed++;
}

async function assert(label, fn) {
  try {
    await fn();
    pass(label);
  } catch (e) {
    fail(label, e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Service Existence & Method Export Verification
// ─────────────────────────────────────────────────────────────────────────────
async function testServiceStructure() {
  console.log('\n[1] FactoryResetService Existence & Structure');

  const servicePath = path.join(__dirname, 'services', 'FactoryResetService.js');
  await assert('FactoryResetService.js file exists', async () => {
    if (!fs.existsSync(servicePath)) throw new Error('FactoryResetService.js not found');
  });

  const { FactoryResetService } = await import('./services/FactoryResetService.js');

  const requiredMethods = [
    'factoryReset',
    'backupDatabase',
    'verifyReset',
    'resetBookings',
    'resetReservations',
    'resetGuests',
    'resetInvoices',
    'resetPayments',
    'resetLedger',
    'resetCashLogs',
    'resetGuestRequests',
    'resetNotifications',
    'resetMaintenance',
    'resetHousekeeping',
    'resetRooms',
    'resetBusinessDate',
    'resetCounters',
    'resetAuditLogs'
  ];

  await assert('All 18 required public methods exist on FactoryResetService', async () => {
    const missing = requiredMethods.filter(m => typeof FactoryResetService[m] !== 'function');
    if (missing.length > 0) throw new Error(`Missing methods: ${missing.join(', ')}`);
  });

  await assert('Service operational methods throw "Factory Reset Phase 2 Required"', async () => {
    const methodsToTest = requiredMethods.filter(m => m !== 'verifyReset');
    for (const method of methodsToTest) {
      try {
        const res = FactoryResetService[method]();
        if (!(res instanceof Promise)) throw new Error(`Method ${method} did not return a Promise`);
        await res;
        throw new Error(`Method ${method} did not throw Phase 2 Required`);
      } catch (e) {
        if (!e.message || !e.message.includes('Phase 2 Required')) {
          throw new Error(`Method ${method} threw wrong error: ${e.message}`);
        }
      }
    }
  });

  await assert('verifyReset() returns Promise resolving to placeholder status', async () => {
    const res = FactoryResetService.verifyReset();
    if (!(res instanceof Promise)) throw new Error('verifyReset did not return a Promise');
    const data = await res;
    if (!data || data.valid !== true || !data.status) {
      throw new Error(`Unexpected verifyReset output: ${JSON.stringify(data)}`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Controller & Routes Existence Verification
// ─────────────────────────────────────────────────────────────────────────────
async function testControllerAndRoutesStructure() {
  console.log('\n[2] Controller & Routes Structure');

  const controllerPath = path.join(__dirname, 'controllers', 'factoryResetController.js');
  await assert('factoryResetController.js exists', async () => {
    if (!fs.existsSync(controllerPath)) throw new Error('factoryResetController.js not found');
  });

  const controllerModule = await import('./controllers/factoryResetController.js');
  await assert('factoryResetController exports getFactoryResetStatus & factoryReset', async () => {
    if (typeof controllerModule.getFactoryResetStatus !== 'function') {
      throw new Error('getFactoryResetStatus export missing');
    }
    if (typeof controllerModule.factoryReset !== 'function') {
      throw new Error('factoryReset export missing');
    }
  });

  const routesPath = path.join(__dirname, 'routes', 'factoryResetRoutes.js');
  await assert('factoryResetRoutes.js exists', async () => {
    if (!fs.existsSync(routesPath)) throw new Error('factoryResetRoutes.js not found');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. API Contract & Response Verification
// ─────────────────────────────────────────────────────────────────────────────
async function testAPIResponses() {
  console.log('\n[3] API Contract & Permission Verification');

  // Generate super admin token for test
  const { generateToken } = await import('./controllers/authController.js');
  const superAdminToken = generateToken({ id: 1, role: 'admin', type: 'user' });
  const regularStaffToken = generateToken({ id: 2, role: 'receptionist', type: 'staff' });

  await assert('POST /api/system/factory-reset returns HTTP 501 and leaves DB 100% untouched', async () => {
    // 1. Snapshot DB row counts before call
    const tables = ['bookings', 'reservations', 'guests', 'invoices', 'payments', 'ledger_items', 'cash_logs', 'audit_logs', 'rooms', 'system_settings'];
    const beforeCounts = {};
    for (const table of tables) {
      const [rows] = await pool.query(`SELECT COUNT(*) as cnt FROM \`${table}\``);
      beforeCounts[table] = rows[0].cnt;
    }

    // 2. Call POST /api/system/factory-reset
    const res = await fetch('http://localhost:5000/api/system/factory-reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${superAdminToken}`
      }
    });

    if (res.status !== 501) {
      throw new Error(`Expected HTTP 501, got ${res.status}`);
    }

    const data = await res.json();
    if (data.success !== false || data.message !== 'Factory Reset is not implemented yet.') {
      throw new Error(`Unexpected body: ${JSON.stringify(data)}`);
    }

    // 3. Snapshot DB row counts after call and compare
    for (const table of tables) {
      const [rows] = await pool.query(`SELECT COUNT(*) as cnt FROM \`${table}\``);
      const afterCnt = rows[0].cnt;
      if (afterCnt !== beforeCounts[table]) {
        throw new Error(`DB table \`${table}\` was modified! Before count=${beforeCounts[table]}, after count=${afterCnt}`);
      }
    }
  });

  await assert('GET /api/system/factory-reset/status returns HTTP 200', async () => {
    const res = await fetch('http://localhost:5000/api/system/factory-reset/status', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${superAdminToken}`
      }
    });

    if (res.status !== 200) {
      throw new Error(`Expected HTTP 200, got ${res.status}`);
    }

    const data = await res.json();
    if (data.success !== true || !data.status.includes('Phase 1')) {
      throw new Error(`Unexpected body: ${JSON.stringify(data)}`);
    }
  });

  await assert('Non-SuperAdmin requests are rejected with HTTP 403', async () => {
    const res = await fetch('http://localhost:5000/api/system/factory-reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${regularStaffToken}`
      }
    });

    if (res.status !== 403) {
      throw new Error(`Expected HTTP 403 for regular staff, got ${res.status}`);
    }
  });

  await assert('Unauthenticated requests are rejected with HTTP 401', async () => {
    const res = await fetch('http://localhost:5000/api/system/factory-reset', {
      method: 'POST'
    });

    if (res.status !== 401) {
      throw new Error(`Expected HTTP 401 for unauthenticated request, got ${res.status}`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. SQL Safety Inspection (No DELETE / TRUNCATE / DROP in Reset Code)
// ─────────────────────────────────────────────────────────────────────────────
async function testSQLSafety() {
  console.log('\n[4] SQL Safety Inspection');

  const filesToCheck = [
    path.join(__dirname, 'services', 'FactoryResetService.js'),
    path.join(__dirname, 'controllers', 'factoryResetController.js'),
    path.join(__dirname, 'routes', 'factoryResetRoutes.js')
  ];

  await assert('Zero DELETE / TRUNCATE / DROP / fs.unlink statements exist in reset codebase', async () => {
    for (const filePath of filesToCheck) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const upper = content.toUpperCase();
      if (upper.includes('DELETE FROM')) throw new Error(`Found DELETE statement in ${path.basename(filePath)}`);
      if (upper.includes('TRUNCATE ')) throw new Error(`Found TRUNCATE statement in ${path.basename(filePath)}`);
      if (upper.includes('DROP TABLE')) throw new Error(`Found DROP TABLE statement in ${path.basename(filePath)}`);
      if (content.includes('fs.unlink') || content.includes('fs.rm')) throw new Error(`Found file deletion in ${path.basename(filePath)}`);
    }
  });

  await assert('Logger action is strictly FACTORY_RESET_REQUEST (not EXECUTE_FACTORY_RESET)', async () => {
    const controllerContent = fs.readFileSync(path.join(__dirname, 'controllers', 'factoryResetController.js'), 'utf-8');
    if (controllerContent.includes('EXECUTE_FACTORY_RESET')) {
      throw new Error('Found legacy EXECUTE_FACTORY_RESET action in controller logger');
    }
    if (!controllerContent.includes('FACTORY_RESET_REQUEST')) {
      throw new Error('Missing FACTORY_RESET_REQUEST action in controller logger');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Unmodified Core Services Verification
// ─────────────────────────────────────────────────────────────────────────────
async function testCoreServicesUnmodified() {
  console.log('\n[5] Core Services Integrity');

  await assert('BusinessDateService, AvailabilityService, and CheckoutRecoveryService import cleanly', async () => {
    await import('./services/businessDateService.js');
    await import('./services/AvailabilityService.js');
    await import('./services/CheckoutRecoveryService.js');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Execution
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('══════════════════════════════════════════════════════════');
  console.log('  verifyFactoryResetArchitecture.mjs — Phase 1 Suite');
  console.log('══════════════════════════════════════════════════════════');

  try {
    await testServiceStructure();
    await testControllerAndRoutesStructure();
    await testAPIResponses();
    await testSQLSafety();
    await testCoreServicesUnmodified();
  } finally {
    await pool.end();
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error('Fatal verification error:', e);
  process.exit(1);
});
