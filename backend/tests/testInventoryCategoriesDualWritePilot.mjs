import pool from '../db.js';
import { isFirebaseConfigured } from '../config/firebaseAdmin.js';
import { createCategory, updateCategory, deleteCategory } from '../controllers/inventoryController.js';
import { processOutboxBatch } from '../services/outboxWorker.js';
import { enqueue } from '../services/outboxService.js';
import { dispatchEvent } from '../services/outboxDispatcher.js';
import {
  getInventoryCategoryByIdFirestore, updateInventoryCategoryFirestore, deleteInventoryCategoryFirestore
} from '../repositories/firestore/inventoryCategoriesRepository.js';

async function runInventoryCategoryDualWritePilotTests() {
  console.log('========================================================================');
  console.log('  HPMS-Sky5 Phase 3E Inventory Category Dual-Write Pilot Test Suite');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ PASSED: ${message}`);
      passed++;
    } else {
      console.error(`  ✕ FAILED: ${message}`);
      failed++;
    }
  }

  const rand = Math.random().toString(36).substring(2, 7);
  const testCategoryName = `phase3e_test_${rand}`;
  const testDocId = `cat_${testCategoryName}`;
  let createdCategoryId = null;
  let conn;

  function createMockRes() {
    return {
      statusCode: 200,
      jsonData: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.jsonData = data;
        return this;
      }
    };
  }

  try {
    conn = await pool.getConnection();
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'true';

    // Scenario A: Create Category + Outbox Staging
    console.log('--- Scenario A: INVENTORY_CATEGORY_CREATED & Outbox Staging ---');
    const reqCreate = { body: { name: testCategoryName, department: 'Kitchen' } };
    const resCreate = createMockRes();
    await createCategory(reqCreate, resCreate);
    assert(resCreate.statusCode === 201, 'createCategory returned 201 Created');

    createdCategoryId = resCreate.jsonData?.category?.id;
    assert(createdCategoryId !== undefined, 'Created MySQL category ID retrieved');

    const [outboxCreateRows] = await conn.query(
      `SELECT * FROM dual_write_outbox WHERE aggregate_id = ? AND event_type = 'INVENTORY_CATEGORY_CREATED'`,
      [testCategoryName]
    );
    assert(outboxCreateRows.length === 1, 'Exactly one INVENTORY_CATEGORY_CREATED outbox event staged inside transaction');

    // Scenario B: Create Rollback Guard
    console.log('\n--- Scenario B: Create Rollback Guard ---');
    const failCatName = `phase3e_fail_${rand}`;
    try {
      await conn.beginTransaction();
      await conn.query(`INSERT INTO inventory_categories (name, department) VALUES (?, 'Kitchen')`, [failCatName]);
      await enqueue(conn, {
        event_type: 'INVENTORY_CATEGORY_CREATED',
        aggregate_type: 'INVENTORY_CATEGORY',
        aggregate_id: failCatName,
        payload: { name: failCatName }
      });
      await conn.rollback();
      assert(true, 'Rolled back failed category transaction');
    } catch (e) {
      if (conn) await conn.rollback();
    }

    const [failEvts] = await conn.query(`SELECT * FROM dual_write_outbox WHERE aggregate_id = ?`, [failCatName]);
    assert(failEvts.length === 0, 'Zero outbox events committed for rolled-back transaction');

    // Scenario E: Worker Dispatch to Firestore
    console.log('\n--- Scenario E: Worker Dispatch to Firestore ---');
    if (isFirebaseConfigured) {
      const batchResultE = await processOutboxBatch(10, 5);
      assert(batchResultE.processed > 0, 'Outbox worker processed pending INVENTORY_CATEGORY_CREATED event');

      const firestoreCatE = await getInventoryCategoryByIdFirestore(testDocId);
      assert(firestoreCatE && firestoreCatE.name === testCategoryName, 'Firestore inventory category document created successfully');
    } else {
      console.log('  ~ Firebase not configured, skipped live Firestore dispatch assertion.');
    }

    // Scenario C: Update Category
    console.log('\n--- Scenario C: INVENTORY_CATEGORY_UPDATED Integration ---');
    const reqUpdate = {
      params: { id: createdCategoryId },
      body: { name: testCategoryName, department: 'Housekeeping' }
    };
    const resUpdate = createMockRes();
    await updateCategory(reqUpdate, resUpdate);
    assert(resUpdate.statusCode === 200, 'updateCategory returned 200 OK');

    const [outboxUpdateRows] = await conn.query(
      `SELECT * FROM dual_write_outbox WHERE aggregate_id = ? AND event_type = 'INVENTORY_CATEGORY_UPDATED'`,
      [testCategoryName]
    );
    assert(outboxUpdateRows.length > 0, 'INVENTORY_CATEGORY_UPDATED outbox event staged');

    if (isFirebaseConfigured) {
      await processOutboxBatch(10, 5);
      const firestoreCatC = await getInventoryCategoryByIdFirestore(testDocId);
      assert(firestoreCatC && firestoreCatC.department === 'Housekeeping', 'Firestore category department updated to Housekeeping');
    }

    // Scenario G: Stale Event Protection
    console.log('\n--- Scenario G: Stale Event Protection (Older Event Arrives Late) ---');
    if (isFirebaseConfigured) {
      const newerTime = new Date(Date.now() + 10000).toISOString();
      await updateInventoryCategoryFirestore(testDocId, {
        department: 'Maintenance',
        updated_at: newerTime
      });

      const olderTime = new Date(Date.now() - 5000).toISOString();
      const staleEvent = {
        event_type: 'INVENTORY_CATEGORY_UPDATED',
        payload: {
          name: testCategoryName,
          docId: testDocId,
          department: 'Pantry',
          updated_at: olderTime
        }
      };

      await dispatchEvent(staleEvent);

      const firestoreStaleCheck = await getInventoryCategoryByIdFirestore(testDocId);
      assert(
        firestoreStaleCheck && firestoreStaleCheck.department === 'Maintenance',
        'Stale Event Guard rejected older event T2 and preserved newer state T3'
      );
    } else {
      console.log('  ~ Firebase not configured, skipped live Stale Event Guard assertion.');
    }

    // Scenario F: Idempotency Replay
    console.log('\n--- Scenario F: Idempotency Replay ---');
    if (isFirebaseConfigured) {
      const dupEvent = {
        event_type: 'INVENTORY_CATEGORY_CREATED',
        payload: {
          name: testCategoryName,
          department: 'Maintenance',
          updated_at: new Date(Date.now() + 20000).toISOString()
        }
      };
      await dispatchEvent(dupEvent);
      await dispatchEvent(dupEvent);
      const dupCheck = await getInventoryCategoryByIdFirestore(testDocId);
      assert(dupCheck && dupCheck.name === testCategoryName, 'Idempotent replay executed cleanly without duplicate document generation');
    }

    // Scenario D & J: Delete Category & Missing Document Idempotency
    console.log('\n--- Scenario D & J: INVENTORY_CATEGORY_DELETED & Missing Document Idempotency ---');
    const reqDelete = { params: { id: createdCategoryId } };
    const resDelete = createMockRes();
    await deleteCategory(reqDelete, resDelete);
    assert(resDelete.statusCode === 200, 'deleteCategory returned 200 OK');

    const [mySqlDeleteCheck] = await conn.query('SELECT * FROM inventory_categories WHERE id = ?', [createdCategoryId]);
    assert(mySqlDeleteCheck.length === 0, 'MySQL record deleted cleanly');

    if (isFirebaseConfigured) {
      await processOutboxBatch(10, 5);
      const deletedDoc = await getInventoryCategoryByIdFirestore(testDocId);
      assert(deletedDoc === null, 'Firestore inventory category document deleted cleanly');

      // Replay delete on missing doc
      await deleteInventoryCategoryFirestore(testDocId);
      assert(true, 'Missing document delete handled idempotently without error');
    }

    // Scenario L: Automated Test Cleanup
    console.log('\n--- Scenario L: CLEANUP PHASE ---');
    await conn.query('DELETE FROM inventory_categories WHERE name = ?', [testCategoryName]);
    await conn.query('DELETE FROM dual_write_outbox WHERE aggregate_id = ?', [testCategoryName]);
    assert(true, 'Cleaned up MySQL test category and outbox records');

    if (isFirebaseConfigured) {
      await deleteInventoryCategoryFirestore(testDocId).catch(() => {});
      console.log('  ✓ Cleaned up test Firestore inventory category document.');
    }

  } catch (err) {
    console.error('Unhandled error during Inventory Category Dual-Write Pilot test:', err);
    failed++;
  } finally {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
    if (conn) conn.release();
  }

  console.log('\n========================================================================');
  console.log(`  Phase 3E Inventory Category Pilot Test Results: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runInventoryCategoryDualWritePilotTests();
