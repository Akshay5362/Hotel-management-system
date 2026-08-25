/**
 * backend/tests/testRoomTypeDualWritePilot.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * HPMS Native Firestore Room Types Master Data Regression Test Suite.
 *
 * Fully modernized for current production architecture:
 * - Direct Firestore cutover authority (USE_FIRESTORE_ROOM_TYPES=true)
 * - Decommissioned MySQL outbox and dual-write infrastructure
 * - Fail-closed error handling (DISABLE_MYSQL_CUTOVER_FALLBACKS=true)
 * - Guaranteed scoped fixture tracking and cleanup
 * ─────────────────────────────────────────────────────────────────────────────
 */

import assert from 'assert';
import { db as firestoreDb } from '../config/firebaseAdmin.js';
import {
  isFirestoreRoomTypesEnabled,
  isMysqlCutoverFallbacksDisabled,
  isFirestoreOutboxWorkerEnabled
} from '../config/featureFlags.js';
import { RoomTypeCutoverService } from '../services/roomTypeCutoverService.js';
import {
  getRoomTypeByIdFirestore,
  getRoomTypeByCodeFirestore,
  getAllRoomTypesFirestore,
  createRoomTypeFirestore,
  updateRoomTypeFirestore,
  deleteRoomTypeFirestore
} from '../repositories/firestore/roomTypesRepository.js';

let passed = 0;
let failed = 0;
let total = 0;

function report(name, ok, msg = '') {
  total++;
  if (ok) {
    passed++;
    console.log(`  ✓ [TEST ${total}] ${name}`);
  } else {
    failed++;
    console.error(`  ✗ [TEST ${total}] ${name} — ${msg}`);
  }
}

async function runRoomTypeRegressionTests() {
  console.log('========================================================================');
  console.log('  HPMS Room Types Master Data: Native Firestore Regression Suite');
  console.log('========================================================================\n');

  const rand = Math.random().toString(36).substring(2, 7).toUpperCase();
  const testCode = `RT_P3B_${rand}`;
  const testName = `Phase 3B Suite Room ${rand}`;
  const fixturesToClean = [];

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // 1. Production Architecture & Feature Flag Invariants
    // ─────────────────────────────────────────────────────────────────────────
    console.log('--- SECTION 1: Production Architecture & Feature Flags ---');
    report(
      '1.1 Firestore room types serving is enabled',
      isFirestoreRoomTypesEnabled() === true,
      'USE_FIRESTORE_ROOM_TYPES must be enabled'
    );
    report(
      '1.2 MySQL cutover fallbacks are strictly disabled (Fail-Closed)',
      isMysqlCutoverFallbacksDisabled() === true,
      'DISABLE_MYSQL_CUTOVER_FALLBACKS must be true'
    );
    report(
      '1.3 MySQL outbox worker daemon is decommissioned/disabled',
      isFirestoreOutboxWorkerEnabled() === false,
      'ENABLE_FIRESTORE_OUTBOX_WORKER must be false'
    );

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Direct Firestore Room Type Creation
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- SECTION 2: Room Type Creation & Shape Validation ---');
    
    // Pre-register all expected fixture ID variants for guaranteed cleanup
    fixturesToClean.push({ collection: 'room_types', docId: `type_${testCode}` });
    fixturesToClean.push({ collection: 'room_types', docId: testCode });
    fixturesToClean.push({ collection: 'room_types', docId: `type_${testCode.toLowerCase()}` });

    const createPayload = {
      code: testCode,
      name: testName,
      title: testName,
      description: 'Native Firestore regression test room type',
      base_rate: 4500.00
    };

    const createResult = await RoomTypeCutoverService.createRoomType(createPayload);
    report(
      '2.1 createRoomType succeeds and returns expected schema',
      createResult && createResult.success === true && createResult.code === testCode && createResult.base_rate === 4500,
      `Received: ${JSON.stringify(createResult)}`
    );

    if (createResult?.id) {
      fixturesToClean.push({ collection: 'room_types', docId: String(createResult.id) });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Retrieval via Service & Repository Layers
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- SECTION 3: Room Type Retrieval ---');
    const fetchedById = await RoomTypeCutoverService.getRoomTypeById(testCode);
    report(
      '3.1 getRoomTypeById retrieves document by code',
      fetchedById !== null && fetchedById.code === testCode && fetchedById.name === testName && fetchedById.base_rate === 4500,
      `Fetched: ${JSON.stringify(fetchedById)}`
    );

    const directRepoDoc = await getRoomTypeByIdFirestore(`type_${testCode}`);
    report(
      '3.2 Direct repository lookup returns exact persisted document',
      directRepoDoc !== null && directRepoDoc.code === testCode,
      `Direct Doc: ${JSON.stringify(directRepoDoc)}`
    );

    const allRoomTypes = await RoomTypeCutoverService.getRoomTypes();
    const foundInList = Array.isArray(allRoomTypes) && allRoomTypes.some(r => r.code === testCode);
    report(
      '3.3 getRoomTypes includes newly created test fixture',
      foundInList === true,
      `Total returned room types: ${Array.isArray(allRoomTypes) ? allRoomTypes.length : 'none'}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Duplicate Handling
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- SECTION 4: Duplicate Code & Conflict Handling ---');
    let duplicateRejected = false;
    let duplicateErrorCode = null;
    try {
      await RoomTypeCutoverService.createRoomType({
        code: testCode,
        name: `${testName} Duplicate`,
        base_rate: 5000.00
      });
    } catch (dupErr) {
      duplicateRejected = true;
      duplicateErrorCode = dupErr.code || dupErr.status;
    }
    report(
      '4.1 Duplicate room type code is rejected with DUPLICATE_KEY / 400',
      duplicateRejected === true && (duplicateErrorCode === 'DUPLICATE_KEY' || duplicateErrorCode === 400 || duplicateErrorCode === 409),
      `ErrorCode: ${duplicateErrorCode}`
    );

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Invalid Input / Validation
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- SECTION 5: Business Validation on Invalid Input ---');
    let invalidInputRejected = false;
    try {
      await createRoomTypeFirestore({
        code: `INVALID_${rand}`,
        // Missing required 'name' and 'base_rate'
        description: 'Missing required fields'
      });
    } catch (valErr) {
      invalidInputRejected = true;
    }
    report(
      '5.1 Missing required fields rejected by repository schema validation',
      invalidInputRejected === true
    );

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Sequential Updates
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- SECTION 6: Sequential Updates & State Convergence ---');
    const update1 = await RoomTypeCutoverService.updateRoomType(testCode, {
      name: `${testName} V2`,
      description: 'Updated Description V2',
      base_rate: 5200.00
    });
    report(
      '6.1 Update V1 modifies name, description, and base_rate',
      update1 && update1.success === true && update1.base_rate === 5200
    );

    const update2 = await RoomTypeCutoverService.updateRoomType(testCode, {
      name: `${testName} V3`,
      description: 'Updated Description V3',
      base_rate: 5800.00
    });
    report(
      '6.2 Update V2 modifies state again to final authoritative values',
      update2 && update2.success === true && update2.base_rate === 5800
    );

    const fetchedAfterUpdates = await RoomTypeCutoverService.getRoomTypeById(testCode);
    report(
      '6.3 getRoomTypeById reflects latest authoritative values (V3 / 5800)',
      fetchedAfterUpdates !== null && fetchedAfterUpdates.name === `${testName} V3` && fetchedAfterUpdates.base_rate === 5800
    );

    // ─────────────────────────────────────────────────────────────────────────
    // 7. Deletion & 404 Lifecycle
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- SECTION 7: Deletion Lifecycle ---');
    const deleteRes = await RoomTypeCutoverService.deleteRoomType(testCode);
    report(
      '7.1 deleteRoomType removes document cleanly',
      deleteRes && deleteRes.success === true
    );

    const fetchedAfterDelete = await RoomTypeCutoverService.getRoomTypeById(testCode);
    report(
      '7.2 getRoomTypeById returns null for deleted document',
      fetchedAfterDelete === null
    );

    let secondDeleteThrew404 = false;
    try {
      await RoomTypeCutoverService.deleteRoomType(testCode);
    } catch (delErr) {
      if (delErr.status === 404 || delErr.message.includes('not found') || delErr.message.includes('Room type not found')) {
        secondDeleteThrew404 = true;
      }
    }
    report(
      '7.3 Second deletion attempt throws 404 Not Found',
      secondDeleteThrew404 === true
    );

    // ─────────────────────────────────────────────────────────────────────────
    // 8. Fail-Closed & Non-Existent Lookups
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- SECTION 8: Fail-Closed & Non-Existent Entity Safety ---');
    const nonExistentLookup = await RoomTypeCutoverService.getRoomTypeById(`NON_EXISTENT_RT_${rand}`);
    report(
      '8.1 Non-existent room type lookup returns null safely without throwing',
      nonExistentLookup === null
    );

  } catch (err) {
    console.error('Unhandled Error during Room Type regression test:', err);
    failed++;
  } finally {
    console.log('\n--- EXECUTING GUARANTEED FIXTURE CLEANUP ---');
    let cleanupAttempts = 0;
    let cleanupSuccess = 0;
    let cleanupFailures = 0;

    if (firestoreDb) {
      for (const item of fixturesToClean) {
        cleanupAttempts++;
        try {
          await firestoreDb.collection(item.collection).doc(item.docId).delete();
          cleanupSuccess++;
        } catch (cleanErr) {
          cleanupFailures++;
          console.warn(`[Cleanup Warning] Failed to delete ${item.collection}/${item.docId}:`, cleanErr.message);
        }
      }
    }

    console.log('\n===============================================================');
    console.log('CLEANUP SUMMARY:');
    console.log(`  CREATED FIXTURES : ${fixturesToClean.length}`);
    console.log(`  CLEANUP ATTEMPTS : ${cleanupAttempts}`);
    console.log(`  CLEANUP SUCCESS  : ${cleanupSuccess}`);
    console.log(`  CLEANUP FAILURES : ${cleanupFailures}`);
    console.log('===============================================================');
  }

  console.log('\n========================================================================');
  console.log(`  Room Types Regression Test Results: ${passed} PASSED, ${failed} FAILED (Total: ${total})`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runRoomTypeRegressionTests().catch(err => {
  console.error('Fatal room type regression test error:', err);
  process.exit(1);
});
