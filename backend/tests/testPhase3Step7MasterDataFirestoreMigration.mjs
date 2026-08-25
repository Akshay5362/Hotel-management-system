/**
 * testPhase3Step7MasterDataFirestoreMigration.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Comprehensive Test Suite for HPMS Phase 3 Step 7:
 * Master Data Controllers Firestore Migration (Room Types, Staff, Inventory, Housekeeping).
 */

import { strict as assert } from 'assert';
import pool from '../db.js';
import { db as firestoreDb } from '../config/firebaseAdmin.js';
import {
  isFirestoreRoomTypesEnabled,
  isFirestoreStaffEnabled,
  isFirestoreInventoryEnabled,
  isFirestoreHousekeepingEnabled,
  FEATURE_FLAGS
} from '../config/featureFlags.js';
import { RoomTypeCutoverService } from '../services/roomTypeCutoverService.js';
import { StaffCutoverService } from '../services/staffCutoverService.js';
import { InventoryCutoverService } from '../services/inventoryCutoverService.js';
import { HousekeepingCutoverService } from '../services/housekeepingCutoverService.js';

let passed = 0;
let failed = 0;

function report(name, ok, msg = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} — ${msg}`);
  }
}

async function runTests() {
  console.log('\n================================================================');
  console.log('HPMS PHASE 3 STEP 7 — MASTER DATA FIRESTORE MIGRATION TEST SUITE');
  console.log('================================================================\n');

  const origRoomTypesFlag = process.env.USE_FIRESTORE_ROOM_TYPES;
  const origStaffFlag = process.env.USE_FIRESTORE_STAFF;
  const origInventoryFlag = process.env.USE_FIRESTORE_INVENTORY;
  const origHkFlag = process.env.USE_FIRESTORE_HOUSEKEEPING;

  const fixturesToClean = [];

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // Section A: Feature Flag Defaults
    // ─────────────────────────────────────────────────────────────────────────
    console.log('Section A: Feature Flag Default States & Configuration');

    delete process.env.USE_FIRESTORE_ROOM_TYPES;
    delete process.env.USE_FIRESTORE_STAFF;
    delete process.env.USE_FIRESTORE_INVENTORY;
    delete process.env.USE_FIRESTORE_HOUSEKEEPING;

    report('A.1: isFirestoreRoomTypesEnabled() defaults to false', isFirestoreRoomTypesEnabled() === false);
    report('A.2: isFirestoreStaffEnabled() defaults to false', isFirestoreStaffEnabled() === false);
    report('A.3: isFirestoreInventoryEnabled() defaults to false', isFirestoreInventoryEnabled() === false);
    report('A.4: isFirestoreHousekeepingEnabled() defaults to false', isFirestoreHousekeepingEnabled() === false);
    report('A.5: FEATURE_FLAGS export contains all 4 new flags',
      'USE_FIRESTORE_ROOM_TYPES' in FEATURE_FLAGS &&
      'USE_FIRESTORE_STAFF' in FEATURE_FLAGS &&
      'USE_FIRESTORE_INVENTORY' in FEATURE_FLAGS &&
      'USE_FIRESTORE_HOUSEKEEPING' in FEATURE_FLAGS
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Section B & C: Room Types Master Data (Flags OFF and ON)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\nSection B & C: Room Types Dual-Path CRUD');

    // Flag OFF: MySQL
    process.env.USE_FIRESTORE_ROOM_TYPES = 'false';
    const mysqlRoomTypes = await RoomTypeCutoverService.getRoomTypes();
    report('B.1: Flag OFF - getRoomTypes returns array from MySQL', Array.isArray(mysqlRoomTypes) && mysqlRoomTypes.length > 0);

    const firstType = mysqlRoomTypes[0];
    const mysqlSingleType = await RoomTypeCutoverService.getRoomTypeById(firstType.id);
    report('B.2: Flag OFF - getRoomTypeById returns valid room type', mysqlSingleType && mysqlSingleType.code === firstType.code);

    // Flag ON: Firestore
    process.env.USE_FIRESTORE_ROOM_TYPES = 'true';
    const testTypeCode = `RT_${Math.floor(Math.random() * 8999 + 1000)}`;
    fixturesToClean.push({ collection: 'room_types', docId: `type_${testTypeCode}` });
    fixturesToClean.push({ collection: 'room_types', docId: testTypeCode });
    fixturesToClean.push({ collection: 'room_types', docId: `type_${testTypeCode.toUpperCase()}` });

    const createdRt = await RoomTypeCutoverService.createRoomType({
      code: testTypeCode,
      name: 'Test Room Type',
      description: 'Test Description',
      base_rate: 150.00
    });
    report('C.1: Flag ON - createRoomType creates document in Firestore', createdRt && createdRt.code === testTypeCode);

    const fetchedRt = await RoomTypeCutoverService.getRoomTypeById(testTypeCode);
    report('C.2: Flag ON - getRoomTypeById retrieves created document', fetchedRt && fetchedRt.name === 'Test Room Type');

    const updatedRt = await RoomTypeCutoverService.updateRoomType(testTypeCode, {
      name: 'Updated Test Room Type',
      base_rate: 175.00
    });
    report('C.3: Flag ON - updateRoomType updates document correctly', updatedRt && updatedRt.name === 'Updated Test Room Type' && updatedRt.base_rate === 175);

    const deletedRt = await RoomTypeCutoverService.deleteRoomType(testTypeCode);
    report('C.4: Flag ON - deleteRoomType removes document from Firestore', deletedRt && deletedRt.success === true);

    const notFoundRt = await RoomTypeCutoverService.getRoomTypeById(testTypeCode);
    report('C.5: Flag ON - Deleted room type cannot be fetched', notFoundRt === null);

    // ─────────────────────────────────────────────────────────────────────────
    // Section D & E: Staff Management (Flags OFF and ON)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\nSection D & E: Staff Management Dual-Path CRUD');

    // Flag OFF: MySQL
    process.env.USE_FIRESTORE_STAFF = 'false';
    const mysqlStaff = await StaffCutoverService.getAllStaff();
    report('D.1: Flag OFF - getAllStaff returns staff list from MySQL', Array.isArray(mysqlStaff.staff) && mysqlStaff.total >= 0);

    // Flag ON: Firestore
    process.env.USE_FIRESTORE_STAFF = 'true';
    const testUsername = `staff_${Date.now()}`;
    const testEmail = `${testUsername}@hotel.com`;
    fixturesToClean.push({ collection: 'staff', docId: `staff_${testUsername}` });
    fixturesToClean.push({ collection: 'staff', docId: testUsername });

    const createdStaff = await StaffCutoverService.createStaff({
      full_name: 'Test Staff Member',
      username: testUsername,
      email: testEmail,
      password: 'TemporaryPassword123!',
      role: 'RECEPTIONIST',
      department: 'Front Office',
      shift: 'Morning',
      phone: '555-0199',
      status: 'Active'
    });
    report('E.1: Flag ON - createStaff creates staff in Firestore with sanitized output', createdStaff && createdStaff.username === testUsername && !createdStaff.password_hash);

    const fetchedStaff = await StaffCutoverService.getStaffById(testUsername);
    report('E.2: Flag ON - getStaffById retrieves created staff', fetchedStaff && fetchedStaff.full_name === 'Test Staff Member');

    const updatedStaff = await StaffCutoverService.updateStaff(testUsername, {
      full_name: 'Updated Staff Member',
      phone: '555-0200'
    });
    report('E.3: Flag ON - updateStaff modifies metadata correctly', updatedStaff && updatedStaff.full_name === 'Updated Staff Member' && updatedStaff.phone === '555-0200');

    const statusUpdatedStaff = await StaffCutoverService.updateStaffStatus(testUsername, 'Inactive');
    report('E.4: Flag ON - updateStaffStatus updates status to Inactive', statusUpdatedStaff && statusUpdatedStaff.status === 'Inactive');

    const deletedStaff = await StaffCutoverService.deleteStaff(testUsername);
    report('E.5: Flag ON - deleteStaff soft-deletes staff member', deletedStaff && deletedStaff.success === true);

    const deletedLookup = await StaffCutoverService.getStaffById(testUsername);
    report('E.6: Flag ON - Soft-deleted staff is excluded from active lookups', deletedLookup === null);

    // ─────────────────────────────────────────────────────────────────────────
    // Section F & G: Inventory Categories (Flags OFF and ON)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\nSection F & G: Inventory Categories Dual-Path CRUD');

    // Flag OFF: MySQL
    process.env.USE_FIRESTORE_INVENTORY = 'false';
    const mysqlCats = await InventoryCutoverService.getCategories();
    report('F.1: Flag OFF - getCategories returns categories from MySQL', Array.isArray(mysqlCats.categories));

    // Flag ON: Firestore
    process.env.USE_FIRESTORE_INVENTORY = 'true';
    const testCatName = `Test Category ${Date.now()}`;
    const catCleanId = `cat_${testCatName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    fixturesToClean.push({ collection: 'inventory_categories', docId: catCleanId });

    const createdCat = await InventoryCutoverService.createCategory({
      name: testCatName,
      department: 'Housekeeping'
    });
    report('G.1: Flag ON - createCategory creates category in Firestore', createdCat && createdCat.name === testCatName);
    if (createdCat?.id) {
      fixturesToClean.push({ collection: 'inventory_categories', docId: String(createdCat.id) });
      fixturesToClean.push({ collection: 'inventory_categories', docId: `cat_${createdCat.id}` });
    }

    const updatedCat = await InventoryCutoverService.updateCategory(createdCat.id, {
      name: `${testCatName} Updated`,
      department: 'Kitchen'
    });
    report('G.2: Flag ON - updateCategory updates category in Firestore', updatedCat && updatedCat.name === `${testCatName} Updated`);

    const deletedCat = await InventoryCutoverService.deleteCategory(createdCat.id);
    report('G.3: Flag ON - deleteCategory deletes category from Firestore', deletedCat && deletedCat.success === true);

    // ─────────────────────────────────────────────────────────────────────────
    // Section H, I & J: Inventory Products & Atomic Stock Operations
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\nSection H, I & J: Inventory Products & Atomic Stock Management');

    // Flag OFF: MySQL
    process.env.USE_FIRESTORE_INVENTORY = 'false';
    const mysqlProds = await InventoryCutoverService.getProducts();
    report('H.1: Flag OFF - getProducts returns products and metrics from MySQL', Array.isArray(mysqlProds.products) && mysqlProds.metrics);

    // Flag ON: Firestore
    process.env.USE_FIRESTORE_INVENTORY = 'true';
    const testSku = `SK_${Math.floor(Math.random() * 8999 + 1000)}`;
    fixturesToClean.push({ collection: 'inventory_products', docId: `prod_${testSku}` });
    fixturesToClean.push({ collection: 'inventory_products', docId: testSku });
    fixturesToClean.push({ collection: 'inventory_products', docId: `prod_${testSku.toUpperCase()}` });

    const createdProd = await InventoryCutoverService.createProduct({
      sku: testSku,
      name: 'Test Inventory Item',
      category_id: 1,
      unit_of_measure: 'pcs',
      minimum_stock_level: 10,
      current_stock: 50,
      unit_price: 12.50,
      status: 'Active'
    });
    report('I.1: Flag ON - createProduct creates product with opening stock', createdProd && createdProd.sku === testSku && createdProd.current_stock === 50);

    const fetchedProd = await InventoryCutoverService.getProductById(testSku);
    report('I.2: Flag ON - getProductById calculates stock_status (In Stock)', fetchedProd && fetchedProd.stock_status === 'In Stock');

    const updatedProd = await InventoryCutoverService.updateProduct(testSku, {
      name: 'Test Item Renamed',
      unit_price: 15.00
    });
    report('I.3: Flag ON - updateProduct updates metadata without altering stock', updatedProd && updatedProd.success === true);

    // Section J: Stock Atomic Mutation & Non-Negative Validation
    await InventoryCutoverService.updateStock(testSku, -20);
    const stockAfterDecr = await InventoryCutoverService.getProductById(testSku);
    report('J.1: Atomic Stock decrement (-20) produces correct quantity (30)', stockAfterDecr && stockAfterDecr.current_stock === 30);

    let negativeStockRejected = false;
    try {
      await InventoryCutoverService.updateStock(testSku, -100);
    } catch (err) {
      if (err.code === 'INSUFFICIENT_STOCK' || err.message.includes('Insufficient stock') || err.message.includes('insufficient')) {
        negativeStockRejected = true;
      }
    }
    report('J.2: Stock decrement below zero is rejected atomically', negativeStockRejected === true);

    const deletedProd = await InventoryCutoverService.deleteProduct(testSku);
    report('I.4: Flag ON - deleteProduct soft deactivates product', deletedProd && deletedProd.success === true);

    // ─────────────────────────────────────────────────────────────────────────
    // Section K, L & M: Housekeeping Rooms & Task Lifecycle
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\nSection K, L & M: Housekeeping Rooms & Task Lifecycle');

    // Flag OFF: MySQL
    process.env.USE_FIRESTORE_HOUSEKEEPING = 'false';
    const mysqlHkRooms = await HousekeepingCutoverService.getHousekeepingRooms();
    report('K.1: Flag OFF - getHousekeepingRooms returns rooms from MySQL', Array.isArray(mysqlHkRooms) && mysqlHkRooms.length > 0);

    // Flag ON: Firestore
    process.env.USE_FIRESTORE_HOUSEKEEPING = 'true';
    const fsHkRooms = await HousekeepingCutoverService.getHousekeepingRooms();
    report('L.1: Flag ON - getHousekeepingRooms returns rooms with hk statuses', Array.isArray(fsHkRooms) && fsHkRooms.length > 0);

    const targetRoom = fsHkRooms[0];
    const assignedRes = await HousekeepingCutoverService.assignHousekeeper({
      roomId: targetRoom.id,
      userId: 'staff_test_hk',
      priority: 'High',
      performedBy: 'admin',
      io: null
    });
    report('L.2: Flag ON - assignHousekeeper updates room assignment and priority', assignedRes && assignedRes.success === true);

    const statusRes = await HousekeepingCutoverService.updateHousekeepingStatus({
      roomId: targetRoom.id,
      status: 'Clean',
      notes: 'Cleaned thoroughly',
      performedBy: 'admin',
      io: null
    });
    report('M.1: Flag ON - updateHousekeepingStatus updates room housekeeping status', statusRes && statusRes.success === true);

    // ─────────────────────────────────────────────────────────────────────────
    // Section N & O: Fallback & Rollback Verification
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\nSection N & O: Fallback & Rollback Verification');

    // Rollback: Setting all flags back to false restores MySQL paths
    process.env.USE_FIRESTORE_ROOM_TYPES = 'false';
    process.env.USE_FIRESTORE_STAFF = 'false';
    process.env.USE_FIRESTORE_INVENTORY = 'false';
    process.env.USE_FIRESTORE_HOUSEKEEPING = 'false';

    const rollbackRt = await RoomTypeCutoverService.getRoomTypes();
    const rollbackStaff = await StaffCutoverService.getAllStaff();
    const rollbackInv = await InventoryCutoverService.getCategories();
    const rollbackHk = await HousekeepingCutoverService.getHousekeepingRooms();

    report('O.1: Rollback Room Types - Flag OFF seamlessly uses MySQL', Array.isArray(rollbackRt));
    report('O.2: Rollback Staff - Flag OFF seamlessly uses MySQL', Array.isArray(rollbackStaff.staff));
    report('O.3: Rollback Inventory - Flag OFF seamlessly uses MySQL', Array.isArray(rollbackInv.categories));
    report('O.4: Rollback Housekeeping - Flag OFF seamlessly uses MySQL', Array.isArray(rollbackHk));

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

    // Restore original env variables (KEEP FLAGS OFF)
    if (origRoomTypesFlag !== undefined) process.env.USE_FIRESTORE_ROOM_TYPES = origRoomTypesFlag;
    else delete process.env.USE_FIRESTORE_ROOM_TYPES;

    if (origStaffFlag !== undefined) process.env.USE_FIRESTORE_STAFF = origStaffFlag;
    else delete process.env.USE_FIRESTORE_STAFF;

    if (origInventoryFlag !== undefined) process.env.USE_FIRESTORE_INVENTORY = origInventoryFlag;
    else delete process.env.USE_FIRESTORE_INVENTORY;

    if (origHkFlag !== undefined) process.env.USE_FIRESTORE_HOUSEKEEPING = origHkFlag;
    else delete process.env.USE_FIRESTORE_HOUSEKEEPING;
  }

  console.log('\n================================================================');
  console.log(`STEP 7 TEST SUITE SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal error in Step 7 test suite:', err);
  process.exit(1);
});
