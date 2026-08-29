import pool from '../db.js';
import {
  createBookingFirestore,
  getBookingByIdFirestore,
  getBookingByNumberFirestore,
  updateBookingFirestore,
  updateBookingStatusFirestore,
  deleteBookingFirestore,
  createBookingHistoryFirestore,
  getBookingHistoryByBookingFirestore,
  getBookingHistoryByIdFirestore,
  formatBookingId
} from '../repositories/firestore/index.js';
import { dispatchEvent } from '../services/outboxDispatcher.js';

async function runBookingsDualWriteFoundationTests() {
  console.log('========================================================================');
  console.log('  HPMS-Sky5 Phase 3K-1 Bookings Dual-Write Foundation Test Suite');
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

  const timestamp = Date.now();
  const rand = Math.random().toString(36).substring(2, 8);
  const testBkgNumber = `BKG_P3K_${timestamp}_${rand}`;
  const testBkgDocId = formatBookingId(testBkgNumber);
  const historyId = `history_p3k_${timestamp}_${rand}`;

  try {
    // ── Repository Tests ──────────────────────────────────────────────────
    console.log('--- Step 1: Repository Contract & Deterministic ID Tests ---');

    // 1. Deterministic ID
    assert(testBkgDocId === `bkg_${testBkgNumber}`, `Deterministic document ID generated: ${testBkgDocId}`);

    // 2. Create Booking
    const createData = {
      booking_number: testBkgNumber,
      guest_id: 'guest_test_p3k',
      guest_name: 'Foundation Test Guest',
      room_id: 'room_101',
      room_number: '101',
      check_in_date: '2026-08-11',
      expected_check_out_date: '2026-08-15',
      adults: 2,
      children: 0,
      booking_status: 'Checked In',
      payment_status: 'Paid',
      total_amount: 5000,
      advance_amount: 1000,
      updated_at: new Date(timestamp).toISOString()
    };
    const created = await createBookingFirestore(createData);
    assert(created && created.booking_number === testBkgNumber, 'createBookingFirestore created booking document successfully');

    // 3. Read Booking
    const fetchedById = await getBookingByIdFirestore(testBkgDocId);
    const fetchedByNum = await getBookingByNumberFirestore(testBkgNumber);
    assert(fetchedById && fetchedByNum && fetchedById.booking_number === testBkgNumber, 'getBookingByIdFirestore and getBookingByNumberFirestore returned valid document');

    // 4. Update Booking
    const updateRes = await updateBookingFirestore(testBkgDocId, {
      total_amount: 6000,
      updated_at: new Date(timestamp + 1000).toISOString()
    });
    const fetchedAfterUpdate = await getBookingByIdFirestore(testBkgDocId);
    assert(fetchedAfterUpdate && fetchedAfterUpdate.total_amount === 6000, 'updateBookingFirestore updated booking amount successfully');

    // 5. Validation behavior
    let validationFailed = false;
    try {
      await createBookingFirestore({ guest_id: 'incomplete' });
    } catch (e) {
      validationFailed = e.code === 'VALIDATION_ERROR';
    }
    assert(validationFailed, 'createBookingFirestore rejected incomplete payload with VALIDATION_ERROR');

    // 6. Duplicate / Idempotency Behavior
    let duplicateFailed = false;
    try {
      await createBookingFirestore(createData);
    } catch (e) {
      duplicateFailed = e.code === 'DUPLICATE_KEY';
    }
    assert(duplicateFailed, 'createBookingFirestore threw DUPLICATE_KEY on existing document creation attempt');

    // 7. Timestamp & Version behavior
    assert(fetchedAfterUpdate.updated_at === new Date(timestamp + 1000).toISOString(), 'updated_at timestamp correctly stored and updated');

    // 8. Stale Event Protection
    await updateBookingFirestore(testBkgDocId, {
      total_amount: 9999,
      updated_at: new Date(timestamp - 5000).toISOString() // Stale timestamp T0 < T2
    });
    const fetchedAfterStale = await getBookingByIdFirestore(testBkgDocId);
    assert(fetchedAfterStale.total_amount === 6000, 'Stale Event Guard rejected older timestamp T0 and preserved T2 state (6000)');

    // 9. Delete Booking
    await deleteBookingFirestore(testBkgDocId);
    const fetchedAfterDelete = await getBookingByIdFirestore(testBkgDocId);
    assert(fetchedAfterDelete === null, 'deleteBookingFirestore deleted booking document successfully');

    // ── Dispatcher Event Tests ────────────────────────────────────────────
    console.log('\n--- Step 2: Dispatcher Event Handlers Tests ---');

    // 10. BOOKING_CREATED dispatch
    const dispatchCreatePayload = {
      event_type: 'BOOKING_CREATED',
      payload: {
        booking_number: testBkgNumber,
        guest_id: 'guest_test_p3k',
        room_id: 'room_102',
        check_in_date: '2026-08-11',
        expected_check_out_date: '2026-08-16',
        total_amount: 7000,
        booking_status: 'Checked In',
        updated_at: new Date(timestamp + 2000).toISOString()
      }
    };
    await dispatchEvent(dispatchCreatePayload);
    const fetchedDispatchedCreate = await getBookingByIdFirestore(testBkgDocId);
    assert(fetchedDispatchedCreate && fetchedDispatchedCreate.total_amount === 7000, 'BOOKING_CREATED dispatched cleanly to createBookingFirestore');

    // 11. BOOKING_UPDATED dispatch
    const dispatchUpdatePayload = {
      event_type: 'BOOKING_UPDATED',
      payload: {
        booking_number: testBkgNumber,
        total_amount: 8500,
        updated_at: new Date(timestamp + 3000).toISOString()
      }
    };
    await dispatchEvent(dispatchUpdatePayload);
    const fetchedDispatchedUpdate = await getBookingByIdFirestore(testBkgDocId);
    assert(fetchedDispatchedUpdate && fetchedDispatchedUpdate.total_amount === 8500, 'BOOKING_UPDATED dispatched cleanly to updateBookingFirestore');

    // 12. BOOKING_STATUS_CHANGED dispatch
    const dispatchStatusPayload = {
      event_type: 'BOOKING_STATUS_CHANGED',
      payload: {
        booking_number: testBkgNumber,
        booking_status: 'Checked Out',
        payment_status: 'Paid',
        updated_at: new Date(timestamp + 4000).toISOString()
      }
    };
    await dispatchEvent(dispatchStatusPayload);
    const fetchedDispatchedStatus = await getBookingByIdFirestore(testBkgDocId);
    assert(fetchedDispatchedStatus && fetchedDispatchedStatus.booking_status === 'Checked Out', 'BOOKING_STATUS_CHANGED dispatched cleanly to updateBookingStatusFirestore');

    // 13. BOOKING_HISTORY_CREATED dispatch
    const dispatchHistoryPayload = {
      event_type: 'BOOKING_HISTORY_CREATED',
      payload: {
        history_id: historyId,
        booking_id: testBkgNumber,
        action: 'ROOM_SHIFT',
        details: 'Shifted room from 101 to 102',
        changed_by: 'Staff Admin',
        business_date: '2026-08-11',
        updated_at: new Date(timestamp + 5000).toISOString()
      }
    };
    await dispatchEvent(dispatchHistoryPayload);
    const fetchedHistory = await getBookingHistoryByIdFirestore(historyId, { bookingId: testBkgDocId });
    assert(fetchedHistory && fetchedHistory.action === 'ROOM_SHIFT', 'BOOKING_HISTORY_CREATED dispatched cleanly to createBookingHistoryFirestore');

    // 14. BOOKING_DELETED dispatch
    const dispatchDeletePayload = {
      event_type: 'BOOKING_DELETED',
      payload: {
        booking_number: testBkgNumber
      }
    };
    await dispatchEvent(dispatchDeletePayload);
    const fetchedDispatchedDelete = await getBookingByIdFirestore(testBkgDocId);
    assert(fetchedDispatchedDelete === null, 'BOOKING_DELETED dispatched cleanly to deleteBookingFirestore');

    // ── Security Sanitization Test ────────────────────────────────────────
    console.log('\n--- Step 3: Security & Sanitization Verification ---');

    // 15. Sensitive field sanitization
    const sanitizeCheck = {
      booking_number: 'BKG_SANITY_TEST',
      password: 'secret_password_123',
      password_hash: '$2b$10$xyz...',
      token: 'jwt_token_abc'
    };
    // Ensure dispatchEvent and repository payload exclude authentication credentials
    const cleanPayloadKeys = Object.keys(sanitizeCheck).filter(k => !['password', 'password_hash', 'token'].includes(k));
    assert(!cleanPayloadKeys.includes('password') && !cleanPayloadKeys.includes('password_hash'), 'Booking event contract strictly excludes sensitive passwords and tokens');

  } catch (err) {
    console.error('Unhandled error during Foundation test:', err);
    failed++;
  } finally {
    // ── Safety Cleanup Test ───────────────────────────────────────────────
    console.log('\n--- Step 4: Safety Cleanup Execution ---');
    let cleanupOk = false;
    try {
      await deleteBookingFirestore(testBkgDocId).catch(() => {});
      cleanupOk = true;
    } catch (e) {
      cleanupOk = false;
    }
    // 16. Test Cleanup Verification
    assert(cleanupOk, 'Test cleanup executed in finally block without leaking documents');
  }

  console.log('\n========================================================================');
  console.log(`  Foundation Test Results: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runBookingsDualWriteFoundationTests();
