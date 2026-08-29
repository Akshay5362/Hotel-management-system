import pool from '../db.js';
import { isFirebaseConfigured } from '../config/firebaseAdmin.js';
import { createProduct, updateProduct, deleteProduct } from '../controllers/inventoryController.js';
import { processOutboxBatch } from '../services/outboxWorker.js';
import { enqueue } from '../services/outboxService.js';
import { dispatchEvent } from '../services/outboxDispatcher.js';
import {
  getInventoryProductByIdFirestore, getInventoryProductBySkuFirestore, updateInventoryProductFirestore, deleteInventoryProductFirestore
} from '../repositories/firestore/inventoryProductsRepository.js';

async function runInventoryProductsDualWritePilotTests() {
  console.log('========================================================================');
  console.log('  HPMS-Sky5 Phase 3G Inventory Products Dual-Write Pilot Test Suite');
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

  const rand = Math.random().toString(36).substring(2, 7).toUpperCase();
  const testSku = `SKU_P3G_${rand}`;
  const testProductName = `phase3g_prod_${rand}`;
  let createdProductId = null;
  let testCategoryId = null;
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

    // Get an existing category ID for test
    const [cats] = await conn.query('SELECT id FROM inventory_categories LIMIT 1');
    if (cats.length === 0) {
      const [newCat] = await conn.query("INSERT INTO inventory_categories (name, department) VALUES ('TestCatP3G', 'Kitchen')");
      testCategoryId = newCat.insertId;
    } else {
      testCategoryId = cats[0].id;
    }

    // Scenario A, E & I: Create Product + Outbox Staging + MySQL Commit
    console.log('--- Scenario A, E & I: INVENTORY_PRODUCT_CREATED & Outbox Staging ---');
    const reqCreate = {
      body: {
        sku: testSku,
        name: testProductName,
        category_id: testCategoryId,
        unit_of_measure: 'Kg',
        minimum_stock_level: 10,
        current_stock: 50,
        unit_price: 15.50,
        status: 'Active'
      }
    };
    const resCreate = createMockRes();
    await createProduct(reqCreate, resCreate);
    assert(resCreate.statusCode === 201, 'createProduct returned 201 Created');

    createdProductId = resCreate.jsonData?.productId;
    assert(createdProductId !== undefined, 'Created MySQL product ID retrieved');

    const [outboxCreateRows] = await conn.query(
      `SELECT * FROM dual_write_outbox WHERE aggregate_id = ? AND event_type = 'INVENTORY_PRODUCT_CREATED'`,
      [testSku]
    );
    assert(outboxCreateRows.length === 1, 'Exactly one INVENTORY_PRODUCT_CREATED outbox event staged inside transaction');

    // Scenario J: Create Rollback Guard
    console.log('\n--- Scenario J: Create Rollback Guard ---');
    const failSku = `SKU_FAIL_${rand}`;
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO inventory_products (sku, name, category_id, unit_of_measure, minimum_stock_level, current_stock, unit_price, status)
         VALUES (?, 'FailProd', ?, 'Piece', 5, 10, 5.0, 'Active')`,
        [failSku, testCategoryId]
      );
      await enqueue(conn, {
        event_type: 'INVENTORY_PRODUCT_CREATED',
        aggregate_type: 'INVENTORY_PRODUCT',
        aggregate_id: failSku,
        payload: { sku: failSku, name: 'FailProd' }
      });
      await conn.rollback();
      assert(true, 'Rolled back failed product transaction');
    } catch (e) {
      if (conn) await conn.rollback();
    }

    const [failEvts] = await conn.query(`SELECT * FROM dual_write_outbox WHERE aggregate_id = ?`, [failSku]);
    assert(failEvts.length === 0, 'Zero outbox events committed for rolled-back transaction');

    // Scenario K: Worker Dispatch to Firestore
    console.log('\n--- Scenario K: Worker Dispatch to Firestore ---');
    if (isFirebaseConfigured) {
      const batchResultK = await processOutboxBatch(10, 5);
      assert(batchResultK.processed > 0, 'Outbox worker processed pending INVENTORY_PRODUCT_CREATED event');

      const firestoreProdK = await getInventoryProductBySkuFirestore(testSku);
      assert(firestoreProdK && firestoreProdK.name === testProductName, 'Firestore inventory product document created successfully');
    } else {
      console.log('  ~ Firebase not configured, skipped live Firestore dispatch assertion.');
    }

    // Scenario B & F: Update Product
    console.log('\n--- Scenario B & F: INVENTORY_PRODUCT_UPDATED Integration ---');
    const reqUpdate = {
      params: { id: createdProductId },
      body: { name: `${testProductName}_updated`, unit_price: 18.75 }
    };
    const resUpdate = createMockRes();
    await updateProduct(reqUpdate, resUpdate);
    assert(resUpdate.statusCode === 200, 'updateProduct returned 200 OK');

    const [outboxUpdateRows] = await conn.query(
      `SELECT * FROM dual_write_outbox WHERE aggregate_id = ? AND event_type = 'INVENTORY_PRODUCT_UPDATED'`,
      [testSku]
    );
    assert(outboxUpdateRows.length > 0, 'INVENTORY_PRODUCT_UPDATED outbox event staged');

    if (isFirebaseConfigured) {
      await processOutboxBatch(10, 5);
      const firestoreProdB = await getInventoryProductBySkuFirestore(testSku);
      assert(firestoreProdB && firestoreProdB.name === `${testProductName}_updated`, 'Firestore product name updated');
    }

    // Scenario M: Stale Event Protection
    console.log('\n--- Scenario M: Stale Event Protection (Older Event Arrives Late) ---');
    if (isFirebaseConfigured) {
      const currentDoc = await getInventoryProductBySkuFirestore(testSku);
      const currentName = currentDoc ? currentDoc.name : `${testProductName}_updated`;

      const olderTime = new Date(Date.now() - 60000).toISOString(); // 1 minute in the past
      const staleEvent = {
        event_type: 'INVENTORY_PRODUCT_UPDATED',
        payload: {
          sku: testSku,
          name: 'Product_T2_Stale',
          updated_at: olderTime
        }
      };

      await dispatchEvent(staleEvent);

      const firestoreStaleCheck = await getInventoryProductBySkuFirestore(testSku);
      assert(
        firestoreStaleCheck && firestoreStaleCheck.name === currentName,
        'Stale Event Guard rejected older event T2 and preserved newer state T3'
      );
    } else {
      console.log('  ~ Firebase not configured, skipped live Stale Event Guard assertion.');
    }

    // Scenario L & P: Idempotency Replay
    console.log('\n--- Scenario L & P: Idempotency Replay ---');
    if (isFirebaseConfigured) {
      const dupEvent = {
        event_type: 'INVENTORY_PRODUCT_CREATED',
        payload: {
          sku: testSku,
          name: `${testProductName}_updated`,
          updated_at: new Date().toISOString()
        }
      };
      await dispatchEvent(dupEvent);
      await dispatchEvent(dupEvent);
      const dupCheck = await getInventoryProductBySkuFirestore(testSku);
      assert(dupCheck && dupCheck.name === `${testProductName}_updated`, 'Idempotent replay executed cleanly');
    }

    // Scenario D & H: Product Deactivation & Outbox Event
    console.log('\n--- Scenario D & H: INVENTORY_PRODUCT_DEACTIVATED & Soft Delete ---');
    const reqDelete = { params: { id: createdProductId } };
    const resDelete = createMockRes();
    await deleteProduct(reqDelete, resDelete);
    assert(resDelete.statusCode === 200, 'deleteProduct returned 200 OK');

    const [mySqlDeactCheck] = await conn.query('SELECT status FROM inventory_products WHERE id = ?', [createdProductId]);
    assert(mySqlDeactCheck.length > 0 && mySqlDeactCheck[0].status === 'Inactive', 'MySQL record status set to Inactive');

    if (isFirebaseConfigured) {
      await processOutboxBatch(10, 5);
      const firestoreDeactDoc = await getInventoryProductBySkuFirestore(testSku);
      assert(firestoreDeactDoc && firestoreDeactDoc.status === 'Inactive', 'Firestore product status updated to Inactive');
    }

    // Scenario T: Automated Test Cleanup
    console.log('\n--- Scenario T: CLEANUP PHASE ---');
    await conn.query('DELETE FROM inventory_products WHERE sku = ?', [testSku]);
    await conn.query('DELETE FROM dual_write_outbox WHERE aggregate_id = ?', [testSku]);
    assert(true, 'Cleaned up MySQL test product and outbox records');

    if (isFirebaseConfigured) {
      await deleteInventoryProductFirestore(testSku).catch(() => {});
      console.log('  ✓ Cleaned up test Firestore inventory product document.');
    }

  } catch (err) {
    console.error('Unhandled error during Inventory Product Dual-Write Pilot test:', err);
    failed++;
  } finally {
    process.env.ENABLE_FIRESTORE_DUAL_WRITE = 'false';
    if (conn) conn.release();
  }

  console.log('\n========================================================================');
  console.log(`  Phase 3G Inventory Product Pilot Test Results: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runInventoryProductsDualWritePilotTests();
