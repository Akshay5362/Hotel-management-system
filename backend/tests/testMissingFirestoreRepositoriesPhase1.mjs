import { db, isFirebaseConfigured } from '../config/firebaseAdmin.js';
import {
  createMaintenanceRecordFirestore,
  getMaintenanceByIdFirestore,
  getMaintenanceByRoomFirestore,
  getAllMaintenanceFirestore,
  updateMaintenanceRecordFirestore,
  deleteMaintenanceRecordFirestore,

  createNotificationFirestore,
  getNotificationByIdFirestore,
  getNotificationsByUserFirestore,
  getAllNotificationsFirestore,
  updateNotificationFirestore,
  markNotificationReadFirestore,
  deleteNotificationFirestore,

  createFeedbackFirestore,
  getFeedbackByIdFirestore,
  getFeedbackByBookingFirestore,
  getFeedbackByGuestFirestore,
  getAllFeedbackFirestore,
  updateFeedbackFirestore,
  deleteFeedbackFirestore,

  createStayExtensionRequestFirestore,
  getStayExtensionRequestByIdFirestore,
  getStayExtensionRequestsByBookingFirestore,
  getStayExtensionRequestsByGuestFirestore,
  getAllStayExtensionRequestsFirestore,
  updateStayExtensionRequestStatusFirestore,
  deleteStayExtensionRequestFirestore,

  createRoomStatusHistoryFirestore,
  getRoomStatusHistoryByIdFirestore,
  getRoomStatusHistoryByRoomFirestore,
  getAllRoomStatusHistoryFirestore,
  deleteRoomStatusHistoryFirestore,

  RepositoryError
} from '../repositories/firestore/index.js';

async function runMissingRepositoriesTestSuite() {
  console.log('========================================================================');
  console.log('  HPMS PHASE 1 STEP 1: MISSING FIRESTORE REPOSITORIES TEST SUITE');
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
  const testTag = `phase1_test_${timestamp}_${rand}`;

  // Unique isolated keys
  const testRoomNum = `TEST_${rand.toUpperCase()}`;
  const testBkgRef = `BKG_TEST_${rand.toUpperCase()}`;
  const testGuestId = `guest_test_${rand}`;
  const testUserId = `user_test_${rand}`;

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // 1. MAINTENANCE REPOSITORY TESTS
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- [1/5] maintenanceRepository ---');
    const maintId = `test_maint_${rand}`;
    const createdMaint = await createMaintenanceRecordFirestore({
      id: maintId,
      room_id: `room_${testRoomNum}`,
      room_number: testRoomNum,
      reported_by: testUserId,
      issue: 'AC leaking water on floor',
      status: 'Pending',
      business_date: '19-Aug-2026'
    });
    createdTestDocs.push({ collection: 'maintenance', id: `maint_${maintId}` });
    assert(createdMaint && createdMaint.maintenance_id === `maint_${maintId}`, 'createMaintenanceRecordFirestore');

    const fetchedMaint = await getMaintenanceByIdFirestore(`maint_${maintId}`);
    assert(fetchedMaint && fetchedMaint.issue === 'AC leaking water on floor' && fetchedMaint.status === 'Pending', 'getMaintenanceByIdFirestore');

    const byRoomMaint = await getMaintenanceByRoomFirestore(`room_${testRoomNum}`);
    assert(byRoomMaint.length >= 1 && byRoomMaint.some(m => m.maintenance_id === `maint_${maintId}`), 'getMaintenanceByRoomFirestore');

    await updateMaintenanceRecordFirestore(`maint_${maintId}`, {
      status: 'Resolved',
      assigned_to: 'staff_101',
      resolved_at: new Date().toISOString()
    });
    const updatedMaint = await getMaintenanceByIdFirestore(`maint_${maintId}`);
    assert(updatedMaint && updatedMaint.status === 'Resolved' && updatedMaint.assigned_to === 'staff_101', 'updateMaintenanceRecordFirestore (resolve)');

    // Test missing required field
    let threwMaintVal = false;
    try {
      await createMaintenanceRecordFirestore({ room_id: `room_${testRoomNum}` }); // missing issue
    } catch (e) {
      if (e instanceof RepositoryError && e.code === 'VALIDATION_ERROR') threwMaintVal = true;
    }
    assert(threwMaintVal, 'createMaintenanceRecordFirestore validation error on missing issue');

    // ─────────────────────────────────────────────────────────────────────────
    // 2. NOTIFICATIONS REPOSITORY TESTS
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- [2/5] notificationsRepository ---');
    const notifId = `test_notif_${rand}`;
    const createdNotif = await createNotificationFirestore({
      id: notifId,
      user_id: testUserId,
      title: 'Booking Confirmed',
      message: `Your booking ${testBkgRef} is confirmed.`,
      is_read: false,
      type: 'booking'
    });
    createdTestDocs.push({ collection: 'notifications', id: `notif_${notifId}` });
    assert(createdNotif && createdNotif.notification_id === `notif_${notifId}`, 'createNotificationFirestore');

    const fetchedNotif = await getNotificationByIdFirestore(`notif_${notifId}`);
    assert(fetchedNotif && fetchedNotif.is_read === false && fetchedNotif.title === 'Booking Confirmed', 'getNotificationByIdFirestore');

    const userNotifs = await getNotificationsByUserFirestore(testUserId, { onlyUnread: true });
    assert(userNotifs.length >= 1 && userNotifs.some(n => n.notification_id === `notif_${notifId}`), 'getNotificationsByUserFirestore (unread filter)');

    await markNotificationReadFirestore(`notif_${notifId}`);
    const readNotif = await getNotificationByIdFirestore(`notif_${notifId}`);
    assert(readNotif && readNotif.is_read === true && readNotif.read_at, 'markNotificationReadFirestore');

    // Test missing required fields
    let threwNotifVal = false;
    try {
      await createNotificationFirestore({ user_id: testUserId }); // missing title and message
    } catch (e) {
      if (e instanceof RepositoryError && e.code === 'VALIDATION_ERROR') threwNotifVal = true;
    }
    assert(threwNotifVal, 'createNotificationFirestore validation error on missing title/message');

    // ─────────────────────────────────────────────────────────────────────────
    // 3. FEEDBACK REPOSITORY TESTS
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- [3/5] feedbackRepository ---');
    const fbId = `test_fb_${rand}`;
    const createdFb = await createFeedbackFirestore({
      id: fbId,
      booking_id: testBkgRef,
      guest_id: testGuestId,
      overall_rating: 5,
      room_cleanliness: 5,
      service_quality: 4,
      value_for_money: 5,
      comments: 'Exceptional hospitality and clean rooms!',
      would_recommend: true
    });
    createdTestDocs.push({ collection: 'feedback', id: `fb_${fbId}` });
    assert(createdFb && createdFb.feedback_id === `fb_${fbId}`, 'createFeedbackFirestore');

    const fetchedFb = await getFeedbackByIdFirestore(`fb_${fbId}`);
    assert(fetchedFb && fetchedFb.overall_rating === 5 && fetchedFb.would_recommend === true, 'getFeedbackByIdFirestore');

    const bookingFb = await getFeedbackByBookingFirestore(testBkgRef);
    assert(bookingFb && bookingFb.feedback_id === `fb_${fbId}`, 'getFeedbackByBookingFirestore');

    const guestFb = await getFeedbackByGuestFirestore(testGuestId);
    assert(guestFb.length >= 1 && guestFb.some(f => f.feedback_id === `fb_${fbId}`), 'getFeedbackByGuestFirestore');

    // Test missing required fields
    let threwFbVal = false;
    try {
      await createFeedbackFirestore({ booking_id: testBkgRef }); // missing guest_id and overall_rating
    } catch (e) {
      if (e instanceof RepositoryError && e.code === 'VALIDATION_ERROR') threwFbVal = true;
    }
    assert(threwFbVal, 'createFeedbackFirestore validation error on missing required fields');

    // ─────────────────────────────────────────────────────────────────────────
    // 4. STAY EXTENSION REQUESTS REPOSITORY TESTS
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- [4/5] stayExtensionRequestsRepository ---');
    const extId = `test_ext_${rand}`;
    const createdExt = await createStayExtensionRequestFirestore({
      id: extId,
      booking_id: testBkgRef,
      guest_id: testGuestId,
      room_id: `room_${testRoomNum}`,
      room_number: testRoomNum,
      current_checkout_date: '20-Aug-2026',
      requested_checkout_date: '22-Aug-2026',
      status: 'Pending',
      remarks: 'Flight delayed, requesting 2 extra nights.'
    });
    createdTestDocs.push({ collection: 'stay_extension_requests', id: `ext_${extId}` });
    assert(createdExt && createdExt.request_id === `ext_${extId}`, 'createStayExtensionRequestFirestore');

    const fetchedExt = await getStayExtensionRequestByIdFirestore(`ext_${extId}`);
    assert(fetchedExt && fetchedExt.status === 'Pending' && fetchedExt.requested_checkout_date === '22-Aug-2026', 'getStayExtensionRequestByIdFirestore');

    const bkgExtList = await getStayExtensionRequestsByBookingFirestore(testBkgRef);
    assert(bkgExtList.length >= 1 && bkgExtList.some(e => e.request_id === `ext_${extId}`), 'getStayExtensionRequestsByBookingFirestore');

    await updateStayExtensionRequestStatusFirestore(`ext_${extId}`, 'Approved', {
      admin_id: 'user_1',
      remarks: 'Approved by front desk manager'
    });
    const updatedExt = await getStayExtensionRequestByIdFirestore(`ext_${extId}`);
    assert(updatedExt && updatedExt.status === 'Approved' && updatedExt.admin_id === 'user_1', 'updateStayExtensionRequestStatusFirestore');

    // Test missing required fields
    let threwExtVal = false;
    try {
      await createStayExtensionRequestFirestore({ booking_id: testBkgRef }); // missing current and requested checkout dates
    } catch (e) {
      if (e instanceof RepositoryError && e.code === 'VALIDATION_ERROR') threwExtVal = true;
    }
    assert(threwExtVal, 'createStayExtensionRequestFirestore validation error on missing dates');

    // ─────────────────────────────────────────────────────────────────────────
    // 5. ROOM STATUS HISTORY REPOSITORY TESTS
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- [5/5] roomStatusHistoryRepository ---');
    const rshId = `test_rsh_${rand}`;
    const createdRsh = await createRoomStatusHistoryFirestore({
      id: rshId,
      room_id: `room_${testRoomNum}`,
      room_number: testRoomNum,
      old_status: 'vacant',
      new_status: 'occupied',
      changed_by: 'user_1',
      business_date: '19-Aug-2026',
      reason: 'Guest check-in'
    });
    createdTestDocs.push({ collection: 'room_status_history', id: `rsh_${rshId}` });
    assert(createdRsh && createdRsh.history_id === `rsh_${rshId}`, 'createRoomStatusHistoryFirestore');

    const fetchedRsh = await getRoomStatusHistoryByIdFirestore(`rsh_${rshId}`);
    assert(fetchedRsh && fetchedRsh.old_status === 'vacant' && fetchedRsh.new_status === 'occupied', 'getRoomStatusHistoryByIdFirestore');

    const roomHistList = await getRoomStatusHistoryByRoomFirestore(`room_${testRoomNum}`);
    assert(roomHistList.length >= 1 && roomHistList.some(h => h.history_id === `rsh_${rshId}`), 'getRoomStatusHistoryByRoomFirestore');

    // Test missing required fields
    let threwRshVal = false;
    try {
      await createRoomStatusHistoryFirestore({ room_id: `room_${testRoomNum}` }); // missing new_status
    } catch (e) {
      if (e instanceof RepositoryError && e.code === 'VALIDATION_ERROR') threwRshVal = true;
    }
    assert(threwRshVal, 'createRoomStatusHistoryFirestore validation error on missing new_status');

    // ─────────────────────────────────────────────────────────────────────────
    // 6. NONEXISTENT DOCUMENT & NULL INPUT TESTS
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- [Edge Cases] Nonexistent & Null Handling ---');
    const nullMaint = await getMaintenanceByIdFirestore(null);
    assert(nullMaint === null, 'getMaintenanceByIdFirestore(null) returns null');

    const nullNotif = await getNotificationByIdFirestore(null);
    assert(nullNotif === null, 'getNotificationByIdFirestore(null) returns null');

    const nullFb = await getFeedbackByIdFirestore(null);
    assert(nullFb === null, 'getFeedbackByIdFirestore(null) returns null');

    const nullExt = await getStayExtensionRequestByIdFirestore(null);
    assert(nullExt === null, 'getStayExtensionRequestByIdFirestore(null) returns null');

    const nullRsh = await getRoomStatusHistoryByIdFirestore(null);
    assert(nullRsh === null, 'getRoomStatusHistoryByIdFirestore(null) returns null');

    const nonExistentDoc = await getMaintenanceByIdFirestore('maint_non_existent_999999');
    assert(nonExistentDoc === null, 'getMaintenanceByIdFirestore(nonexistent) returns null');

  } catch (err) {
    console.error('Unhandled test suite error:', err);
    failed++;
  } finally {
    // ─────────────────────────────────────────────────────────────────────────
    // CLEANUP: Clean up only isolated test documents
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Test Document Cleanup ---');
    for (const doc of createdTestDocs) {
      try {
        await db.collection(doc.collection).doc(doc.id).delete();
        console.log(`  ✓ Cleaned test doc: /${doc.collection}/${doc.id}`);
      } catch (cleanErr) {
        console.warn(`  ⚠️ Failed to delete test doc /${doc.collection}/${doc.id}:`, cleanErr.message);
      }
    }
  }

  console.log('\n========================================================================');
  console.log(`  TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runMissingRepositoriesTestSuite();
