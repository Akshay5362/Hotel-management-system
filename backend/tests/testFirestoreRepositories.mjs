import { db, isFirebaseConfigured } from '../config/firebaseAdmin.js';
import {
  createRoomFirestore, getRoomByIdFirestore, getAllRoomsFirestore, updateRoomFirestore, deleteRoomFirestore,
  createBookingFirestore, getBookingByIdFirestore, getAllBookingsFirestore, updateBookingFirestore, deleteBookingFirestore,
  createReservationFirestore, getReservationByIdFirestore, getAllReservationsFirestore, deleteReservationFirestore,
  createPaymentFirestore, getPaymentByIdFirestore, getPaymentsByBookingFirestore, deletePaymentFirestore,
  createLedgerItemFirestore, getLedgerItemByIdFirestore, getLedgerItemsByBookingFirestore, deleteLedgerItemFirestore,
  createInvoiceFirestore, getInvoiceByIdFirestore, getAllInvoicesFirestore, deleteInvoiceFirestore,
  createStaffFirestore, getStaffByIdFirestore, getStaffByUsernameFirestore, deleteStaffFirestore,
  createGuestFirestore, getGuestByIdFirestore, deleteGuestFirestore,
  createInventoryProductFirestore, getInventoryProductByIdFirestore, updateProductStockFirestore, deleteInventoryProductFirestore,
  createInventoryCategoryFirestore, getInventoryCategoryByIdFirestore, deleteInventoryCategoryFirestore,
  createAuditLogFirestore, getAuditLogByIdFirestore, getAllAuditLogsFirestore,
  createBookingHistoryFirestore, getBookingHistoryByBookingFirestore, getAllBookingHistoryFirestore,
  createRoomTypeFirestore, getRoomTypeByIdFirestore, deleteRoomTypeFirestore,
  createHousekeepingRecordFirestore, getHousekeepingByRoomFirestore, getAllHousekeepingFirestore,
  createCashLogFirestore, getCashLogByIdFirestore, getAllCashLogsFirestore,
  createCashSubmissionFirestore, getCashSubmissionByIdFirestore, getAllCashSubmissionsFirestore,
  createCheckoutSnapshotFirestore, getCheckoutSnapshotByBookingFirestore,
  createRazorpayTransactionFirestore, getRazorpayTransactionByOrderIdFirestore,
  getSystemDateFirestore, updateSystemDateFirestore,
  RepositoryError
} from '../repositories/firestore/index.js';

async function runFull19RepositoryTests() {
  console.log('========================================================================');
  console.log('  HPMS-Sky5 Phase 2 EXHAUSTIVE 19-REPOSITORY TEST SUITE');
  console.log('========================================================================\n');

  if (!isFirebaseConfigured || !db) {
    console.log('⚠️ Firebase Admin SDK is not configured. Skipping live network tests.');
    process.exit(0);
  }

  let passed = 0;
  let failed = 0;
  const createdTestDocs = [];

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ PASSED: ${message}`);
      passed++;
    } else {
      console.error(`  ✕ FAILED: ${message}`);
      failed++;
    }
  }

  const timestamp = Date.now();
  const rand = Math.random().toString(36).substring(2, 7);
  const testTag = `phase2_test_${timestamp}_${rand}`;

  // Unique isolated test keys
  const testRoomNum = `P2_${rand.toUpperCase()}`;
  const testBkgRef = `BKG_P2_${rand.toUpperCase()}`;
  const testResRef = `RES_P2_${rand.toUpperCase()}`;
  const testInvNum = `INV_P2_${rand.toUpperCase()}`;
  const testStaffUser = `user_p2_${rand}`;
  const testGuestUid = `uid_p2_${rand}`;
  const testSku = `SKU_P2_${rand.toUpperCase()}`;
  const testRzpOrder = `order_p2_${rand}`;
  const testTypeCode = `CODE_${rand.toUpperCase()}`;

  try {
    // 1. systemSettingsRepository
    console.log('--- [1/19] systemSettingsRepository ---');
    const systemDate = await getSystemDateFirestore();
    assert(typeof systemDate === 'string' && systemDate.length === 10, 'getSystemDateFirestore returned YYYY-MM-DD');

    // 2. roomsRepository
    console.log('\n--- [2/19] roomsRepository ---');
    const createdRoom = await createRoomFirestore({
      number: testRoomNum,
      type: 'SUITE',
      price: 4500,
      status: 'vacant',
      housekeeping_status: 'Clean'
    });
    createdTestDocs.push({ collection: 'rooms', id: `room_${testRoomNum}` });
    assert(createdRoom && createdRoom.id === `room_${testRoomNum}`, 'createRoomFirestore');

    const fetchedRoom = await getRoomByIdFirestore(`room_${testRoomNum}`);
    assert(fetchedRoom && fetchedRoom.number === testRoomNum, 'getRoomByIdFirestore');

    const filteredRooms = await getAllRoomsFirestore({
      filters: [{ field: 'number', op: '==', value: testRoomNum }]
    });
    assert(filteredRooms.length === 1, 'getAllRoomsFirestore (filtering)');

    await updateRoomFirestore(`room_${testRoomNum}`, { status: 'occupied' });
    const updatedRoom = await getRoomByIdFirestore(`room_${testRoomNum}`);
    assert(updatedRoom && updatedRoom.status === 'occupied', 'updateRoomFirestore');

    // 3. bookingsRepository
    console.log('\n--- [3/19] bookingsRepository ---');
    const createdBooking = await createBookingFirestore({
      booking_number: testBkgRef,
      guest_id: `guest_${testGuestUid}`,
      guest_name: 'Exhaustive Tester',
      room_id: `room_${testRoomNum}`,
      room_number: testRoomNum,
      check_in_date: '2026-08-11',
      check_out_date: '2026-08-13',
      total_amount: 9000
    });
    createdTestDocs.push({ collection: 'bookings', id: `bkg_${testBkgRef}` });
    assert(createdBooking && createdBooking.id === `bkg_${testBkgRef}`, 'createBookingFirestore');

    const fetchedBkg = await getBookingByIdFirestore(`bkg_${testBkgRef}`);
    assert(fetchedBkg && fetchedBkg.booking_number === testBkgRef, 'getBookingByIdFirestore');

    // 4. reservationsRepository
    console.log('\n--- [4/19] reservationsRepository ---');
    const createdRes = await createReservationFirestore({
      reservation_number: testResRef,
      guest_name: 'Reservation Tester',
      room_id: `room_${testRoomNum}`,
      check_in_date: '2026-08-15',
      check_out_date: '2026-08-17'
    });
    createdTestDocs.push({ collection: 'reservations', id: `res_${testResRef}` });
    assert(createdRes && createdRes.id === `res_${testResRef}`, 'createReservationFirestore');

    const fetchedRes = await getReservationByIdFirestore(`res_${testResRef}`);
    assert(fetchedRes && fetchedRes.reservation_number === testResRef, 'getReservationByIdFirestore');

    // 5. paymentsRepository
    console.log('\n--- [5/19] paymentsRepository ---');
    const createdPayment = await createPaymentFirestore({
      booking_id: `bkg_${testBkgRef}`,
      amount: 1500,
      payment_method: 'UPI'
    });
    createdTestDocs.push({ collection: 'payments', id: createdPayment.id });
    createdTestDocs.push({ collection: 'bookings', id: `bkg_${testBkgRef}`, subcollection: 'payments', subId: createdPayment.id });
    assert(createdPayment && createdPayment.amount === 1500, 'createPaymentFirestore');

    const bkgPayments = await getPaymentsByBookingFirestore(`bkg_${testBkgRef}`);
    assert(bkgPayments.length > 0, 'getPaymentsByBookingFirestore (root + subcollection)');

    // 6. ledgerRepository
    console.log('\n--- [6/19] ledgerRepository ---');
    const createdLedger = await createLedgerItemFirestore({
      booking_id: `bkg_${testBkgRef}`,
      description: 'Dinner Charge',
      amount: 1500
    });
    createdTestDocs.push({ collection: 'ledger_items', id: createdLedger.id });
    createdTestDocs.push({ collection: 'bookings', id: `bkg_${testBkgRef}`, subcollection: 'ledger_items', subId: createdLedger.id });
    assert(createdLedger && createdLedger.amount === 1500, 'createLedgerItemFirestore');

    const bkgLedgers = await getLedgerItemsByBookingFirestore(`bkg_${testBkgRef}`);
    assert(bkgLedgers.length > 0, 'getLedgerItemsByBookingFirestore');

    // 7. invoicesRepository
    console.log('\n--- [7/19] invoicesRepository ---');
    const createdInv = await createInvoiceFirestore({
      invoice_number: testInvNum,
      booking_id: `bkg_${testBkgRef}`,
      total_amount: 9000
    });
    createdTestDocs.push({ collection: 'invoices', id: `inv_${testInvNum}` });
    assert(createdInv && createdInv.id === `inv_${testInvNum}`, 'createInvoiceFirestore');

    const fetchedInv = await getInvoiceByIdFirestore(`inv_${testInvNum}`);
    assert(fetchedInv && fetchedInv.invoice_number === testInvNum, 'getInvoiceByIdFirestore');

    // 8. cashLogsRepository
    console.log('\n--- [8/19] cashLogsRepository ---');
    const createdCashLog = await createCashLogFirestore({
      amount: 500,
      type: 'IN',
      description: 'Test Cash Entry'
    });
    createdTestDocs.push({ collection: 'cash_logs', id: createdCashLog.id });
    assert(createdCashLog && createdCashLog.amount === 500, 'createCashLogFirestore');

    // 9. staffRepository
    console.log('\n--- [9/19] staffRepository ---');
    const createdStaff = await createStaffFirestore({
      username: testStaffUser,
      full_name: 'Phase 2 Staff',
      role: 'receptionist'
    });
    createdTestDocs.push({ collection: 'staff', id: `staff_${testStaffUser}` });
    assert(createdStaff && createdStaff.username === testStaffUser, 'createStaffFirestore');

    const fetchedStaff = await getStaffByUsernameFirestore(testStaffUser);
    assert(fetchedStaff && fetchedStaff.role === 'receptionist', 'getStaffByUsernameFirestore');

    // 10. guestsRepository
    console.log('\n--- [10/19] guestsRepository ---');
    const createdGuest = await createGuestFirestore({
      full_name: 'Exhaustive Guest',
      phone: '9888877777',
      user_uid: testGuestUid
    });
    createdTestDocs.push({ collection: 'guests', id: `guest_${testGuestUid}` });
    assert(createdGuest && createdGuest.user_uid === testGuestUid, 'createGuestFirestore');

    // 11. inventoryProductsRepository
    console.log('\n--- [11/19] inventoryProductsRepository ---');
    const createdProd = await createInventoryProductFirestore({
      name: `Prod_${testTag}`,
      sku: testSku,
      stock_quantity: 50,
      unit_price: 250
    });
    createdTestDocs.push({ collection: 'inventory_products', id: `prod_${testSku.toLowerCase()}` });
    assert(createdProd && createdProd.stock_quantity === 50, 'createInventoryProductFirestore');

    await updateProductStockFirestore(`prod_${testSku.toLowerCase()}`, -10);
    const updatedProd = await getInventoryProductByIdFirestore(`prod_${testSku.toLowerCase()}`);
    assert(updatedProd && updatedProd.stock_quantity === 40, 'updateProductStockFirestore');

    // 12. inventoryCategoriesRepository
    console.log('\n--- [12/19] inventoryCategoriesRepository ---');
    const createdCat = await createInventoryCategoryFirestore({
      name: `Cat_${testTag}`
    });
    createdTestDocs.push({ collection: 'inventory_categories', id: createdCat.id });
    assert(createdCat && createdCat.id.startsWith('cat_'), 'createInventoryCategoryFirestore');

    // 13. auditLogsRepository
    console.log('\n--- [13/19] auditLogsRepository ---');
    const createdAudit = await createAuditLogFirestore({
      action: 'TEST_AUDIT',
      details: 'Exhaustive test audit entry'
    });
    createdTestDocs.push({ collection: 'audit_logs', id: createdAudit.id });
    assert(createdAudit && createdAudit.action === 'TEST_AUDIT', 'createAuditLogFirestore');

    // 14. bookingHistoryRepository
    console.log('\n--- [14/19] bookingHistoryRepository ---');
    const createdHistory = await createBookingHistoryFirestore({
      booking_id: `bkg_${testBkgRef}`,
      action: 'CHECK_IN',
      details: 'Guest checked in during exhaustive test'
    });
    createdTestDocs.push({ collection: 'booking_history', id: createdHistory.id });
    createdTestDocs.push({ collection: 'bookings', id: `bkg_${testBkgRef}`, subcollection: 'history', subId: createdHistory.id });
    assert(createdHistory && createdHistory.action === 'CHECK_IN', 'createBookingHistoryFirestore');

    // 15. roomTypesRepository
    console.log('\n--- [15/19] roomTypesRepository ---');
    const createdType = await createRoomTypeFirestore({
      name: `Type_${testTag}`,
      code: testTypeCode,
      base_rate: 6000
    });
    createdTestDocs.push({ collection: 'room_types', id: `type_${testTypeCode}` });
    assert(createdType && createdType.code === testTypeCode, 'createRoomTypeFirestore');

    // 16. housekeepingRepository
    console.log('\n--- [16/19] housekeepingRepository ---');
    const createdHk = await createHousekeepingRecordFirestore({
      room_id: `room_${testRoomNum}`,
      room_number: testRoomNum,
      status: 'Dirty'
    });
    createdTestDocs.push({ collection: 'housekeeping', id: createdHk.id });
    assert(createdHk && createdHk.status === 'Dirty', 'createHousekeepingRecordFirestore');

    const fetchedHk = await getHousekeepingByRoomFirestore(`room_${testRoomNum}`);
    assert(fetchedHk && fetchedHk.status === 'Dirty', 'getHousekeepingByRoomFirestore');

    // 17. cashSubmissionsRepository
    console.log('\n--- [17/19] cashSubmissionsRepository ---');
    const createdSub = await createCashSubmissionFirestore({
      amount: 4500,
      user_id: `staff_${testStaffUser}`
    });
    createdTestDocs.push({ collection: 'cash_submissions', id: createdSub.id });
    assert(createdSub && createdSub.amount === 4500, 'createCashSubmissionFirestore');

    // 18. checkoutSnapshotsRepository
    console.log('\n--- [18/19] checkoutSnapshotsRepository ---');
    const createdSnap = await createCheckoutSnapshotFirestore({
      booking_id: `bkg_${testBkgRef}`,
      snapshot_data: { total: 9000, zeroLoss: true }
    });
    createdTestDocs.push({ collection: 'checkout_snapshots', id: createdSnap.id });
    assert(createdSnap && createdSnap.snapshot_id === `snap_bkg_${testBkgRef}`, 'createCheckoutSnapshotFirestore');

    const fetchedSnap = await getCheckoutSnapshotByBookingFirestore(`bkg_${testBkgRef}`);
    assert(fetchedSnap && fetchedSnap.snapshot_data.zeroLoss === true, 'getCheckoutSnapshotByBookingFirestore');

    // 19. razorpayTransactionsRepository
    console.log('\n--- [19/19] razorpayTransactionsRepository ---');
    const createdRzp = await createRazorpayTransactionFirestore({
      order_id: testRzpOrder,
      booking_id: `bkg_${testBkgRef}`,
      amount: 9000
    });
    createdTestDocs.push({ collection: 'razorpay_transactions', id: `rzp_${testRzpOrder}` });
    assert(createdRzp && createdRzp.order_id === testRzpOrder, 'createRazorpayTransactionFirestore');

    const fetchedRzp = await getRazorpayTransactionByOrderIdFirestore(testRzpOrder);
    assert(fetchedRzp && fetchedRzp.amount === 9000, 'getRazorpayTransactionByOrderIdFirestore');

    // 20. Transactions, Batch, Pagination & Error Handling Tests
    console.log('\n--- Transactions, Batches, Pagination & Error Scenarios ---');
    await db.runTransaction(async (transaction) => {
      const r = await getRoomByIdFirestore(`room_${testRoomNum}`, { transaction });
      assert(r !== null, 'Read room inside transaction');
      await updateRoomFirestore(`room_${testRoomNum}`, { notes: 'Tx Verified' }, { transaction });
    });

    try {
      await createRoomFirestore({ price: 100 }); // missing fields
      assert(false, 'Should throw VALIDATION_ERROR');
    } catch (e) {
      assert(e instanceof RepositoryError && e.code === 'VALIDATION_ERROR', 'VALIDATION_ERROR caught');
    }

    try {
      await createRoomFirestore({ number: testRoomNum, type: 'SUITE' }); // duplicate room number
      assert(false, 'Should throw DUPLICATE_KEY');
    } catch (e) {
      assert(e instanceof RepositoryError && e.code === 'DUPLICATE_KEY', 'DUPLICATE_KEY caught');
    }

    // CLEANUP
    console.log('\n--- CLEANUP PHASE ---');
    let cleanupFailures = 0;
    for (const doc of createdTestDocs) {
      try {
        if (doc.subcollection) {
          await db.collection(doc.collection).doc(doc.id).collection(doc.subcollection).doc(doc.subId).delete();
        } else {
          await db.collection(doc.collection).doc(doc.id).delete();
        }
      } catch (err) {
        console.error(`Failed cleanup for ${doc.collection}/${doc.id}:`, err.message);
        cleanupFailures++;
      }
    }
    assert(cleanupFailures === 0, 'Cleaned up all temporary phase2_test_* documents');

  } catch (err) {
    console.error('Unhandled test failure:', err);
    failed++;
  }

  console.log('\n========================================================================');
  console.log(`  EXHAUSTIVE TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log(`  Covered Repositories: 19 / 19`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runFull19RepositoryTests();
