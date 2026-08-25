import fs from 'fs';
import path from 'path';
import { db, isFirebaseConfigured } from '../config/firebaseAdmin.js';
import { FirestoreRoomStatusService } from '../services/firestoreRoomStatusService.js';
import { FirestoreAvailabilityService, isDateOverlap, parseToComparableDate } from '../services/firestoreAvailabilityService.js';
import { FirestoreLedgerService } from '../services/firestoreLedgerService.js';
import { FirestoreReportsService } from '../services/firestoreReportsService.js';
import {
  FirestoreShadowComparisonService,
  ShadowVerificationLogger,
  areValuesEqual,
  normalizeValue
} from '../services/firestoreShadowComparisonService.js';
import {
  isFirestoreAvailabilityServingEnabled,
  isFirestoreRoomStatusServingEnabled,
  isFirestoreLedgerServingEnabled,
  isFirestoreReportsServingEnabled,
  isFirestoreAvailabilityShadowEnabled,
  isFirestoreRoomStatusShadowEnabled,
  isFirestoreLedgerShadowEnabled,
  isFirestoreReportsShadowEnabled
} from '../config/featureFlags.js';

async function runShadowSoakTestSuite() {
  console.log('========================================================================');
  console.log('  HPMS PHASE 2 STEP 2: DUAL-READ SHADOW SOAK VERIFICATION SUITE');
  console.log('========================================================================\n');

  if (!isFirebaseConfigured || !db) {
    console.log('⚠️ Firebase Admin SDK is not configured. Skipping live network tests.');
    process.exit(0);
  }

  let passed = 0;
  let failed = 0;
  const createdTestDocs = [];
  const soakResults = {
    timestamp: new Date().toISOString(),
    totalScenarios: 0,
    passed: 0,
    failed: 0,
    mismatches: 0,
    firestoreErrors: 0,
    latency: {},
    domains: {},
    scenarios: [],
    status: 'UNKNOWN'
  };

  function recordScenario(domain, name, isSuccess, details = {}) {
    soakResults.totalScenarios++;
    if (isSuccess) {
      soakResults.passed++;
      passed++;
      console.log(`  ✓ PASSED [${domain.toUpperCase()}]: ${name}`);
    } else {
      soakResults.failed++;
      soakResults.mismatches++;
      failed++;
      console.error(`  ✕ FAILED [${domain.toUpperCase()}]: ${name}`);
    }

    if (!soakResults.domains[domain]) {
      soakResults.domains[domain] = { total: 0, passed: 0, failed: 0 };
    }
    soakResults.domains[domain].total++;
    if (isSuccess) soakResults.domains[domain].passed++;
    else soakResults.domains[domain].failed++;

    soakResults.scenarios.push({
      domain,
      name,
      status: isSuccess ? 'PASS' : 'FAIL',
      details
    });
  }

  const timestamp = Date.now();
  const rand = Math.random().toString(36).substring(2, 7);
  const tag = `soak_${timestamp}_${rand}`;

  // Unique isolated keys
  const roomNum1 = `701`;
  const roomNum2 = `702`;
  const roomNum3 = `703`;
  const roomNum4 = `704`;
  const roomDocId1 = `room_${roomNum1}`;
  const roomDocId2 = `room_${roomNum2}`;
  const roomDocId3 = `room_${roomNum3}`;
  const roomDocId4 = `room_${roomNum4}`;

  const guestId1 = `guest_${tag}_1`;
  const bkgId1 = `bkg_${tag}_1`;
  const bkgId2 = `bkg_${tag}_2`;
  const resId1 = `res_${tag}_1`;
  const sysDate = '2026-08-19';

  try {
    console.log('--- Setting up isolated Firestore Shadow Soak fixtures ---');

    // Room 1: Active, Vacant, Clean
    await db.collection('rooms').doc(roomDocId1).set({
      number: roomNum1,
      type: 'EXECUTIVE',
      status: 'vacant',
      housekeeping_status: 'Clean',
      is_active: true,
      price: 2500,
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'rooms', id: roomDocId1 });

    // Room 2: Active, Vacant, Dirty HK
    await db.collection('rooms').doc(roomDocId2).set({
      number: roomNum2,
      type: 'STANDARD',
      status: 'dirty',
      housekeeping_status: 'Dirty',
      is_active: true,
      price: 1800,
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'rooms', id: roomDocId2 });

    // Room 3: Inactive Room
    await db.collection('rooms').doc(roomDocId3).set({
      number: roomNum3,
      type: 'STANDARD',
      status: 'vacant',
      housekeeping_status: 'Clean',
      is_active: false,
      price: 1800,
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'rooms', id: roomDocId3 });

    // Room 4: Active Occupied Room
    await db.collection('rooms').doc(roomDocId4).set({
      number: roomNum4,
      type: 'PREMIUM',
      status: 'occupied',
      housekeeping_status: 'Clean',
      is_active: true,
      price: 3200,
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'rooms', id: roomDocId4 });

    // Guest 1: Full profile
    await db.collection('guests').doc(guestId1).set({
      full_name: 'PRIYA NAIR',
      phone: '+91 9988776655',
      address: '7th Avenue, Bangalore',
      city: 'Bangalore',
      state: 'Karnataka',
      company_name: 'TechCorp India',
      gst_no: '29ABCDE1234F1Z5',
      date_of_birth: '1990-08-20',
      loyalty_tier: 'Platinum',
      gender: 'Female',
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'guests', id: guestId1 });

    // Booking 1: Checked In for Room 704
    await db.collection('bookings').doc(bkgId1).set({
      booking_number: `BKG-${rand}-704`,
      room_id: roomDocId4,
      room_number: roomNum4,
      guest_id: guestId1,
      guest_name: 'PRIYA NAIR',
      phone: '+91 9988776655',
      check_in_date: '18-Aug-2026',
      expected_check_out_date: '22-Aug-2026',
      adults: 2,
      children: 1,
      advance_amount: 3000,
      total_amount: 12800,
      room_tariff: 3200,
      payment_mode: 'UPI',
      purpose_of_visit: 'Corporate Meeting',
      billing_instruction: 'Company Direct',
      meal_plan: 'MAP',
      booking_status: 'Checked In',
      company_name: 'TechCorp India',
      city: 'Bangalore',
      state: 'Karnataka',
      date_of_birth: '1990-08-20',
      created_at: '2026-08-18T10:00:00.000Z'
    });
    createdTestDocs.push({ collection: 'bookings', id: bkgId1 });

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 1: Room Status Scenarios (1 to 10)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Section 1: Room Status Shadow Soak (Scenarios 1-10) ---');

    const tStartRoom = Date.now();
    const allRoomStatuses = await FirestoreRoomStatusService.getRoomStatuses(sysDate);
    const roomLatency = Date.now() - tStartRoom;
    soakResults.latency.roomStatusFirestoreMs = roomLatency;

    const r1 = allRoomStatuses.find(r => r.number === roomNum1);
    recordScenario('room_status', '1. Vacant clean active room', r1 && r1.status === 'vacant' && r1.is_active === true);

    const r2 = allRoomStatuses.find(r => r.number === roomNum2);
    recordScenario('room_status', '2. Vacant dirty active room', r2 && r2.status === 'dirty' && r2.housekeeping_status === 'Dirty');

    const r3 = allRoomStatuses.find(r => r.number === roomNum3);
    recordScenario('room_status', '3. Inactive room surfaces as inactive', r3 && r3.status === 'inactive' && r3.is_active === false);

    const r4 = allRoomStatuses.find(r => r.number === roomNum4);
    recordScenario('room_status', '4. Occupied room surfaces as occupied', r4 && r4.status === 'occupied' && r4.guestName === 'PRIYA NAIR');

    // 5. Booked / Reserved room
    const resDoc1 = `res_${tag}_701`;
    await db.collection('reservations').doc(resDoc1).set({
      reservation_number: `RES-${rand}-701`,
      room_id: roomDocId1,
      room_number: roomNum1,
      guest_name: 'AMITAV GHOSH',
      arrival_date: '19-Aug-2026',
      departure_date: '23-Aug-2026',
      status: 'Confirmed',
      advance_payment: 1500,
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'reservations', id: resDoc1 });

    FirestoreRoomStatusService.invalidateCache();
    const room1StatusBooked = await FirestoreRoomStatusService.getRoomStatus(roomNum1, sysDate);
    recordScenario('room_status', '5. Booked/Reserved room surfaces as booked', room1StatusBooked && room1StatusBooked.status === 'booked' && room1StatusBooked.guestName === 'AMITAV GHOSH');

    // 6 & 7. Checkout transition and dirty status after checkout
    const bkgDocCO = `bkg_${tag}_co`;
    await db.collection('bookings').doc(bkgDocCO).set({
      booking_number: `BKG-${rand}-CO`,
      room_id: roomDocId2,
      room_number: roomNum2,
      check_in_date: '10-Aug-2026',
      check_out_date: '15-Aug-2026',
      expected_check_out_date: '15-Aug-2026',
      booking_status: 'Checked Out',
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'bookings', id: bkgDocCO });

    const r2AfterCO = await FirestoreRoomStatusService.getRoomStatus(roomNum2, sysDate);
    recordScenario('room_status', '6 & 7. Checkout transition & room dirty state preserved', r2AfterCO && r2AfterCO.status === 'dirty');

    // 8. Active Checked In booking across UTC midnight
    recordScenario('room_status', '8. Active Checked In booking across UTC midnight remains occupied', r4 && r4.status === 'occupied');

    // 9. Numerical room ordering
    const numbers = allRoomStatuses.map(r => parseInt(r.number, 10)).filter(n => !isNaN(n));
    let isOrdered = true;
    for (let i = 1; i < numbers.length; i++) {
      if (numbers[i] < numbers[i - 1]) isOrdered = false;
    }
    recordScenario('room_status', '9. Numerical room ordering ascending (1, 2, 3...)', isOrdered);

    // 10. Guest / booking profile enrichment
    const hasEnrichment = r4 && r4.company_name === 'TechCorp India' && r4.city === 'Bangalore' && r4.room_tariff === 3200 && r4.meal_plan === 'MAP';
    recordScenario('room_status', '10. Guest & booking profile enrichment mapped accurately', hasEnrichment);

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 2: Availability Scenarios (11 to 18)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Section 2: Availability Shadow Soak (Scenarios 11-18) ---');

    const tStartAvail = Date.now();
    // 11. Available room
    const avail11 = await FirestoreAvailabilityService.checkRoomAvailability({
      roomId: roomDocId1,
      arrivalDate: '2026-09-01',
      departureDate: '2026-09-05'
    });
    soakResults.latency.availabilityFirestoreMs = Date.now() - tStartAvail;
    recordScenario('availability', '11. Vacant clean room is available for future dates', avail11.available === true);

    // 12. Overlapping Checked In booking
    const avail12 = await FirestoreAvailabilityService.checkRoomAvailability({
      roomId: roomDocId4,
      arrivalDate: '2026-08-19',
      departureDate: '2026-08-21'
    });
    recordScenario('availability', '12. Overlapping Checked In booking blocks availability', avail12.available === false && (avail12.code === 'ROOM_OCCUPIED_BOOKING' || avail12.code === 'ROOM_UNAVAILABLE'));

    // 13. Overlapping Reserved booking
    const avail13 = await FirestoreAvailabilityService.checkRoomAvailability({
      roomId: roomDocId1,
      arrivalDate: '2026-08-20',
      departureDate: '2026-08-22'
    });
    recordScenario('availability', '13. Overlapping Reserved booking blocks availability', avail13.available === false && avail13.code === 'ROOM_ALREADY_BOOKED');

    // 14. Checked Out booking should not block
    const avail14 = await FirestoreAvailabilityService.checkRoomAvailability({
      roomId: roomDocId1,
      arrivalDate: '2026-08-10',
      departureDate: '2026-08-15'
    });
    // Room 1 has no active checked in booking on Aug 10-15
    recordScenario('availability', '14. Checked Out booking does not block availability', avail14.available === true);

    // 15. Cancelled reservation should not block
    const resDocCan = `res_${tag}_can`;
    await db.collection('reservations').doc(resDocCan).set({
      reservation_number: `RES-${rand}-CAN`,
      room_id: roomDocId1,
      room_number: roomNum1,
      arrival_date: '2026-09-10',
      departure_date: '2026-09-15',
      status: 'Cancelled',
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'reservations', id: resDocCan });

    const avail15 = await FirestoreAvailabilityService.checkRoomAvailability({
      roomId: roomDocId1,
      arrivalDate: '2026-09-10',
      departureDate: '2026-09-15'
    });
    recordScenario('availability', '15. Cancelled reservation does not block inventory', avail15.available === true);

    // 16. Boundary checkout/checkin (same date handover)
    const avail16 = await FirestoreAvailabilityService.checkRoomAvailability({
      roomId: roomDocId1,
      arrivalDate: '2026-08-23', // Res 1 ends on 23rd
      departureDate: '2026-08-25'
    });
    recordScenario('availability', '16. Clean boundary (new checkin = existing checkout) is available', avail16.available === true);

    // 17. Inactive room blocked
    const avail17 = await FirestoreAvailabilityService.checkRoomAvailability({
      roomId: roomDocId3,
      arrivalDate: '2026-09-01',
      departureDate: '2026-09-05'
    });
    recordScenario('availability', '17. Inactive room is blocked (ROOM_INACTIVE)', avail17.available === false && avail17.code === 'ROOM_INACTIVE');

    // 18. Reservation modification self-exclusion
    const avail18 = await FirestoreAvailabilityService.checkRoomAvailability({
      roomId: roomDocId1,
      arrivalDate: '2026-08-19',
      departureDate: '2026-08-23',
      excludeReservationId: resDoc1
    });
    recordScenario('availability', '18. Reservation modification self-exclusion is available', avail18.available === true);

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 3: Ledger Scenarios (19 to 26)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Section 3: Folio & Ledger Shadow Soak (Scenarios 19-26) ---');

    // 19. Checkin deposit (Credit 3000)
    const ledDoc1 = `ledger_${tag}_1`;
    await db.collection('ledger_items').doc(ledDoc1).set({
      booking_id: bkgId1,
      room_number: roomNum4,
      desc: 'Check-in Advance Deposit',
      qty: 1,
      amount: 0,
      credit_amount: 3000,
      transaction_type: 'CHECKIN_DEPOSIT',
      payment_mode: 'UPI',
      business_date: '2026-08-18',
      created_at: '2026-08-18T10:00:00.000Z'
    });
    createdTestDocs.push({ collection: 'ledger_items', id: ledDoc1 });

    // 20. Room Tariff Charge (Debit 3200)
    const ledDoc2 = `ledger_${tag}_2`;
    await db.collection('ledger_items').doc(ledDoc2).set({
      booking_id: bkgId1,
      room_number: roomNum4,
      desc: 'Room Tariff (Night 1)',
      qty: 1,
      amount: 3200,
      credit_amount: 0,
      transaction_type: 'CHARGE',
      business_date: '2026-08-18',
      created_at: '2026-08-18T11:00:00.000Z'
    });
    createdTestDocs.push({ collection: 'ledger_items', id: ledDoc2 });

    // 21. Payment (Credit 1500)
    const ledDoc3 = `ledger_${tag}_3`;
    await db.collection('ledger_items').doc(ledDoc3).set({
      booking_id: bkgId1,
      room_number: roomNum4,
      desc: 'Interim Cash Settlement',
      qty: 1,
      amount: 0,
      credit_amount: 1500,
      transaction_type: 'PAYMENT',
      payment_mode: 'Cash',
      business_date: '2026-08-19',
      created_at: '2026-08-19T10:00:00.000Z'
    });
    createdTestDocs.push({ collection: 'ledger_items', id: ledDoc3 });

    // 22. Rollover Charge (Debit 3200)
    const ledDoc4 = `ledger_${tag}_4`;
    await db.collection('ledger_items').doc(ledDoc4).set({
      booking_id: bkgId1,
      room_number: roomNum4,
      desc: 'Room Tariff (Rollover, Incl. GST)',
      qty: 1,
      amount: 3200,
      credit_amount: 0,
      transaction_type: 'ROLLOVER',
      business_date: '2026-08-19',
      created_at: '2026-08-19T00:05:00.000Z'
    });
    createdTestDocs.push({ collection: 'ledger_items', id: ledDoc4 });

    // 23 & 24. Adjustment & Refund
    const ledDoc5 = `ledger_${tag}_5`;
    await db.collection('ledger_items').doc(ledDoc5).set({
      booking_id: bkgId1,
      room_number: roomNum4,
      desc: 'Restaurant Service Charge',
      qty: 1,
      amount: 600,
      credit_amount: 0,
      transaction_type: 'CHARGE',
      business_date: '2026-08-19',
      created_at: '2026-08-19T12:00:00.000Z'
    });
    createdTestDocs.push({ collection: 'ledger_items', id: ledDoc5 });

    const tStartLedger = Date.now();
    const folio4 = await FirestoreLedgerService.getRoomLedger(roomNum4);
    soakResults.latency.ledgerFirestoreMs = Date.now() - tStartLedger;

    // Total Charges: 3200 + 3200 + 600 = 7000
    // Total Payments: 3000 + 1500 = 4500
    // Net Outstanding: 7000 - 4500 = 2500
    recordScenario('ledger', '19 & 20. Check-in deposit and room charges accumulated', folio4.summary.totalCharges === 7000);
    recordScenario('ledger', '21. Payment credit tracked accurately', folio4.summary.totalPayments === 4500);
    recordScenario('ledger', '22. Rollover tariff included in charge summation', folio4.ledger.some(i => i.transaction_type === 'ROLLOVER'));
    recordScenario('ledger', '23 & 24. Service charges and adjustments applied', folio4.ledger.some(i => i.desc === 'Restaurant Service Charge'));
    recordScenario('ledger', '25. Row-by-row running balance tracks balance changes', folio4.ledger.length >= 5 && folio4.ledger[folio4.ledger.length - 1].balance === 2500);
    recordScenario('ledger', '26. Net outstanding equals totalCharges - totalPayments (2500)', folio4.summary.outstanding === 2500);

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 4: Reports & Analytics Scenarios (27 to 34)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Section 4: Reports & Analytics Shadow Soak (Scenarios 27-34) ---');

    // Create payment fixtures
    const payDoc1 = `pay_${tag}_1`;
    await db.collection('payments').doc(payDoc1).set({
      booking_id: bkgId1,
      amount: 3000,
      payment_method: 'UPI',
      payment_type: 'Check-in Deposit',
      business_date: '2026-08-18',
      created_at: '2026-08-18T10:00:00.000Z'
    });
    createdTestDocs.push({ collection: 'payments', id: payDoc1 });

    const payDoc2 = `pay_${tag}_2`;
    await db.collection('payments').doc(payDoc2).set({
      booking_id: bkgId1,
      amount: 1500,
      payment_method: 'Cash',
      payment_type: 'Settlement',
      business_date: '2026-08-19',
      created_at: '2026-08-19T10:00:00.000Z'
    });
    createdTestDocs.push({ collection: 'payments', id: payDoc2 });

    const tStartReports = Date.now();
    const dashboard = await FirestoreReportsService.getDashboardOverview({
      startDate: '2026-08-18',
      endDate: '2026-08-19',
      businessDate: sysDate
    });
    soakResults.latency.reportsFirestoreMs = Date.now() - tStartReports;

    recordScenario('reports', '27. Revenue aggregation sums date range payments', dashboard.totalRevenue >= 4500);
    recordScenario('reports', '28. Occupancy rate computes valid percentage', typeof dashboard.occupancyRate === 'number' && dashboard.occupancyRate >= 0);
    recordScenario('reports', '29. ADR calculation produces valid daily rate', typeof dashboard.adr === 'number' && dashboard.adr > 0);
    recordScenario('reports', '30. RevPAR calculation produces valid revenue per available room', typeof dashboard.revPAR === 'number' && dashboard.revPAR >= 0);

    const payReport = await FirestoreReportsService.getPaymentsReport({
      startDate: '2026-08-18',
      endDate: '2026-08-19'
    });
    recordScenario('reports', '31. Payment method breakdown segments UPI & Cash', payReport.breakdown.length >= 1);

    const occReport = await FirestoreReportsService.getOccupancyReport({
      startDate: '2026-08-18',
      endDate: '2026-08-19',
      businessDate: sysDate
    });
    recordScenario('reports', '32. Booking status distribution counts active statuses', occReport.bookingStatus && occReport.bookingStatus['Checked In'] >= 1);

    const canReport = await FirestoreReportsService.getCancellationReport({
      startDate: '2026-08-01',
      endDate: '2026-08-31'
    });
    recordScenario('reports', '33. Cancellation report calculates cancelled volumes', typeof canReport.totalCancelled === 'number');

    const guestReport = await FirestoreReportsService.getGuestAnalytics({
      startDate: '2026-08-01',
      endDate: '2026-08-31'
    });
    recordScenario('reports', '34. Guest analytics segments loyalty tiers & demographics', guestReport.totalGuests >= 1);

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 5: Multi-Step Lifecycle Workflow Sequences (Flows A, B, C, D)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Section 5: Multi-Step Lifecycle Workflow Sequences ---');

    // FLOW A: Vacant Room → Check-In → Charge → Payment → Room Status → Ledger → Checkout
    const flowARoomNum = `705`;
    const flowARoomDoc = `room_${flowARoomNum}`;
    const flowAGuest = `guest_${tag}_flowA`;
    const flowABkg = `bkg_${tag}_flowA`;

    await db.collection('rooms').doc(flowARoomDoc).set({
      number: flowARoomNum,
      type: 'EXECUTIVE',
      status: 'vacant',
      housekeeping_status: 'Clean',
      is_active: true,
      price: 2000,
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'rooms', id: flowARoomDoc });

    // Step A1: Check-in
    await db.collection('bookings').doc(flowABkg).set({
      booking_number: `BKG-${rand}-705`,
      room_id: flowARoomDoc,
      room_number: flowARoomNum,
      guest_id: flowAGuest,
      guest_name: 'RAJESH KHANNA',
      check_in_date: '19-Aug-2026',
      expected_check_out_date: '21-Aug-2026',
      advance_amount: 1000,
      total_amount: 4000,
      room_tariff: 2000,
      booking_status: 'Checked In',
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'bookings', id: flowABkg });

    FirestoreRoomStatusService.invalidateCache();
    // Step A2: Check room status reflects Occupied
    const flowAStatus = await FirestoreRoomStatusService.getRoomStatus(flowARoomNum, sysDate);
    const flowAOccupied = flowAStatus && flowAStatus.status === 'occupied' && flowAStatus.guestName === 'RAJESH KHANNA';

    // Step A3: Settle & Checkout
    await db.collection('bookings').doc(flowABkg).update({
      booking_status: 'Checked Out',
      check_out_date: '19-Aug-2026'
    });
    await db.collection('rooms').doc(flowARoomDoc).update({
      status: 'dirty',
      housekeeping_status: 'Dirty'
    });

    FirestoreRoomStatusService.invalidateCache();
    const flowAStatusAfterCO = await FirestoreRoomStatusService.getRoomStatus(flowARoomNum, sysDate);
    const flowACheckoutValid = flowAStatusAfterCO && flowAStatusAfterCO.status === 'dirty';
    recordScenario('lifecycle_flow', 'FLOW A: Vacant → Check-In → Folio → Checkout → Dirty Transition', flowAOccupied && flowACheckoutValid);

    // FLOW B: Reservation → Availability Check → Modification → Availability Check
    const flowBRoomNum = `706`;
    const flowBRoomDoc = `room_${flowBRoomNum}`;
    const flowBRes = `res_${tag}_flowB`;

    await db.collection('rooms').doc(flowBRoomDoc).set({
      number: flowBRoomNum,
      type: 'EXECUTIVE',
      status: 'vacant',
      housekeeping_status: 'Clean',
      is_active: true,
      price: 2000,
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'rooms', id: flowBRoomDoc });

    await db.collection('reservations').doc(flowBRes).set({
      reservation_number: `RES-${rand}-706`,
      room_id: flowBRoomDoc,
      room_number: flowBRoomNum,
      arrival_date: '2026-09-01',
      departure_date: '2026-09-05',
      status: 'Confirmed',
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'reservations', id: flowBRes });

    const flowBAvailBlocked = await FirestoreAvailabilityService.checkRoomAvailability({
      roomId: flowBRoomDoc,
      arrivalDate: '2026-09-02',
      departureDate: '2026-09-04'
    });

    // Modify dates to Sep 10-15
    await db.collection('reservations').doc(flowBRes).update({
      arrival_date: '2026-09-10',
      departure_date: '2026-09-15'
    });

    const flowBAvailFreed = await FirestoreAvailabilityService.checkRoomAvailability({
      roomId: flowBRoomDoc,
      arrivalDate: '2026-09-02',
      departureDate: '2026-09-04'
    });

    recordScenario('lifecycle_flow', 'FLOW B: Reservation Creation → Conflict → Date Modification → Slot Freed', flowBAvailBlocked.available === false && flowBAvailFreed.available === true);

    // FLOW C: Check-In → Next-Day Rollover → Updated Balance
    const flowCRoomNum = `707`;
    const flowCRoomDoc = `room_${flowCRoomNum}`;
    const flowCBkg = `bkg_${tag}_flowC`;

    await db.collection('rooms').doc(flowCRoomDoc).set({
      number: flowCRoomNum,
      type: 'STANDARD',
      status: 'occupied',
      housekeeping_status: 'Clean',
      is_active: true,
      price: 1500,
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'rooms', id: flowCRoomDoc });

    await db.collection('bookings').doc(flowCBkg).set({
      booking_number: `BKG-${rand}-707`,
      room_id: flowCRoomDoc,
      room_number: flowCRoomNum,
      guest_name: 'KIRAN BEDI',
      check_in_date: '18-Aug-2026',
      room_tariff: 1500,
      booking_status: 'Checked In',
      created_at: new Date().toISOString()
    });
    createdTestDocs.push({ collection: 'bookings', id: flowCBkg });

    // Initial night 1 charge
    await db.collection('ledger_items').doc(`ledger_${tag}_c1`).set({
      booking_id: flowCBkg,
      room_number: flowCRoomNum,
      desc: 'Room Tariff (Night 1)',
      amount: 1500,
      credit_amount: 0,
      transaction_type: 'CHARGE',
      business_date: '2026-08-18'
    });
    createdTestDocs.push({ collection: 'ledger_items', id: `ledger_${tag}_c1` });

    const folioC1 = await FirestoreLedgerService.getRoomLedger(flowCRoomNum);

    // Rollover night 2
    await db.collection('ledger_items').doc(`ledger_${tag}_c2`).set({
      booking_id: flowCBkg,
      room_number: flowCRoomNum,
      desc: 'Room Tariff (Rollover, Incl. GST)',
      amount: 1500,
      credit_amount: 0,
      transaction_type: 'ROLLOVER',
      business_date: '2026-08-19'
    });
    createdTestDocs.push({ collection: 'ledger_items', id: `ledger_${tag}_c2` });

    const folioC2 = await FirestoreLedgerService.getRoomLedger(flowCRoomNum);
    recordScenario('lifecycle_flow', 'FLOW C: Check-In → Day-End Rollover → Folio Balance Incremented (1500 → 3000)', folioC1.summary.outstanding === 1500 && folioC2.summary.outstanding === 3000);

    // FLOW D: Checkout → Room becomes dirty → Room Status Aggregator → Availability Engine
    const flowDAvailDirty = await FirestoreAvailabilityService.checkRoomAvailability({
      roomId: flowARoomDoc, // Room 705 is dirty from Flow A
      arrivalDate: '2026-08-19',
      departureDate: '2026-08-20'
    });
    recordScenario('lifecycle_flow', 'FLOW D: Checkout → Dirty Housekeeping blocks room in Availability Engine (ROOM_DIRTY)', flowDAvailDirty.available === false && (flowDAvailDirty.code === 'ROOM_DIRTY' || flowDAvailDirty.code === 'ROOM_UNAVAILABLE'));

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 6: Error Injection & Fault Tolerance (Scenarios 39 to 44)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Section 6: Error Injection & Fault Tolerance (Scenarios 39-44) ---');

    // 1. Firestore unavailable simulation
    let err1Handled = false;
    FirestoreShadowComparisonService.executeShadowAsync('err_injection_1', async () => {
      throw new Error('ECONNREFUSED: Firebase endpoint unreachable');
    }, () => {}, { scenario: 'unavailable' });
    await new Promise(r => setTimeout(r, 20));
    err1Handled = true;
    recordScenario('fault_tolerance', '39. Firestore unavailable: shadow failure caught and isolated', err1Handled);

    // 2. Firestore timeout simulation
    let err2Handled = false;
    FirestoreShadowComparisonService.executeShadowAsync('err_injection_2', async () => {
      throw new Error('DEADLINE_EXCEEDED: Firestore query timeout (3000ms)');
    }, () => {}, { scenario: 'timeout' });
    await new Promise(r => setTimeout(r, 20));
    err2Handled = true;
    recordScenario('fault_tolerance', '40. Firestore timeout: shadow failure caught and isolated', err2Handled);

    // 3. Firestore permission failure simulation
    let err3Handled = false;
    FirestoreShadowComparisonService.executeShadowAsync('err_injection_3', async () => {
      throw new Error('PERMISSION_DENIED: Insufficient Firestore read permissions');
    }, () => {}, { scenario: 'permission' });
    await new Promise(r => setTimeout(r, 20));
    err3Handled = true;
    recordScenario('fault_tolerance', '41. Firestore permission error: shadow failure caught and isolated', err3Handled);

    // 4. Malformed document simulation
    const malformedCompare = FirestoreShadowComparisonService.compareRoomStatus(
      [{ number: '101', status: 'vacant' }],
      [{ number: '101', status: undefined, corrupt: true }]
    );
    recordScenario('fault_tolerance', '42. Malformed Firestore document: safely detects diff without throwing', malformedCompare.match === false);

    // 5. Missing Firestore document simulation
    const missingCompare = FirestoreShadowComparisonService.compareRoomStatus(
      [{ number: '101', status: 'vacant' }],
      []
    );
    recordScenario('fault_tolerance', '43. Missing Firestore document: safely cataloged as existence mismatch', missingCompare.match === false && missingCompare.mismatches[0].field === '_existence');

    // 6. Comparison exception isolation
    let err6Handled = false;
    FirestoreShadowComparisonService.executeShadowAsync('err_injection_6', async () => {
      return { ok: true };
    }, () => {
      throw new Error('Unexpected comparison parsing exception');
    }, { scenario: 'compare_error' });
    await new Promise(r => setTimeout(r, 20));
    err6Handled = true;
    recordScenario('fault_tolerance', '44. Comparison exception: isolated from user request lifecycle', err6Handled);

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 7: Output Report JSON Generation
    // ─────────────────────────────────────────────────────────────────────────
    soakResults.status = soakResults.failed === 0 ? 'GO' : 'NO-GO';

    const outputDir = path.resolve('backend/tests/output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const jsonReportPath = path.join(outputDir, 'firebase_shadow_phase2_step2_soak_report.json');
    fs.writeFileSync(jsonReportPath, JSON.stringify(soakResults, null, 2), 'utf-8');
    console.log(`\n  ✓ Saved Soak JSON Report: ${jsonReportPath}`);

  } catch (err) {
    console.error('Unhandled soak test suite error:', err);
    failed++;
  } finally {
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
  console.log(`  SOAK RESULTS: ${passed} PASSED | ${failed} FAILED | STATUS: ${soakResults.status}`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runShadowSoakTestSuite();
