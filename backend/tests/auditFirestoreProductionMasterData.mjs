/**
 * backend/tests/auditFirestoreProductionMasterData.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * STRICT READ-ONLY PRODUCTION MASTER DATA AUDIT SCRIPT
 *
 * Scans Cloud Firestore collections:
 *   - room_types
 *   - rooms
 *
 * Performs zero writes, updates, deletions, or schema mutations.
 * Classifies documents into REAL/CANONICAL, TEST/SUSPECT, and UNKNOWN based
 * on observable fields and identifier patterns.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from '../config/firebaseAdmin.js';

// Suspicion pattern matchers (with word boundaries to avoid false positives like 'soaking')
const TEST_KEYWORD_REGEX = /\b(test|phase|pilot|scratch|soak|fixture|p3b|dummy|mock|temp|fake|sample)\b/i;
const RT_PATTERN_REGEX = /^type_rt_/i;
const ROOM_9XX_REGEX = /^(room_)?9\d{2}/i;
const RANDOM_ID_REGEX = /^[a-zA-Z0-9]{20,}$/; // 20+ char auto-generated Firestore IDs

function classifyRoomType(docId, data) {
  const code = String(data.code || docId || '').trim();
  const title = String(data.title || data.name || '').trim();
  const description = String(data.description || '').trim();

  const reasons = [];

  if (TEST_KEYWORD_REGEX.test(docId) || TEST_KEYWORD_REGEX.test(code) || TEST_KEYWORD_REGEX.test(title) || TEST_KEYWORD_REGEX.test(description)) {
    reasons.push('Contains test/phase/pilot/fixture keyword or code');
  }

  if (RT_PATTERN_REGEX.test(docId) || /^RT_\d+/i.test(code)) {
    reasons.push('Matches synthetic RT_* fixture code pattern');
  }

  if (RANDOM_ID_REGEX.test(docId)) {
    reasons.push('Auto-generated 20+ char Firestore random ID');
  }

  if (reasons.length > 0) {
    return {
      classification: 'TEST/SUSPECT',
      evidence: reasons.join('; ')
    };
  }

  // Canonical room types in PMS master data (e.g. STANDARD, DELUXE, EXECUTIVE, PREMIUM, SUITE)
  const canonicalCodes = ['STANDARD', 'DELUXE', 'SUPER_DELUXE', 'SUITE', 'EXECUTIVE', 'PREMIUM', 'PRESIDENTIAL_SUITE', 'ECONOMY', 'FAMILY'];
  const normalizedCode = code.toUpperCase().replace(/^TYPE_/, '');
  if (canonicalCodes.includes(normalizedCode)) {
    return {
      classification: 'REAL/CANONICAL',
      evidence: `Canonical hotel room type '${normalizedCode}' (MySQL master ID: ${data.mysql_id || data.mysql_room_type_id || 'N/A'})`
    };
  }

  return {
    classification: 'UNKNOWN',
    evidence: 'Non-standard identifier requiring manual review'
  };
}

function classifyRoom(docId, data) {
  const roomNumberStr = String(data.number || data.room_number || data.roomNumber || data.room_no || docId.replace(/^room_/, '')).trim();
  const roomNumberNum = parseInt(roomNumberStr, 10);
  const type = String(data.type || data.room_type || '').trim();
  const reasons = [];

  if (TEST_KEYWORD_REGEX.test(docId) || TEST_KEYWORD_REGEX.test(roomNumberStr) || TEST_KEYWORD_REGEX.test(type)) {
    reasons.push('Contains test/phase/soak/fixture keyword');
  }

  if (ROOM_9XX_REGEX.test(docId) || (!isNaN(roomNumberNum) && roomNumberNum >= 900 && roomNumberNum <= 999) || /_\d{4}$/.test(roomNumberStr)) {
    reasons.push('9xx / timestamped room identifier (commonly used in test fixtures; inspect data to confirm)');
  }

  if (RANDOM_ID_REGEX.test(docId)) {
    reasons.push('Auto-generated 20+ char Firestore random ID');
  }

  if (data.is_test === true || data.test_fixture === true) {
    reasons.push('Explicit test flag field present');
  }

  if (reasons.length > 0) {
    return {
      classification: 'TEST/SUSPECT',
      evidence: reasons.join('; ')
    };
  }

  if (data.migration_source === 'MYSQL_INITIAL_MIGRATION' || data.mysql_room_id !== undefined || data.mysql_id !== undefined) {
    return {
      classification: 'REAL/CANONICAL',
      evidence: `Canonical inventory room #${roomNumberStr} (migrated from MySQL room #${data.mysql_room_id || data.mysql_id})`
    };
  }

  if (!isNaN(roomNumberNum) && roomNumberNum >= 1 && roomNumberNum <= 899) {
    return {
      classification: 'REAL/CANONICAL',
      evidence: `Standard hotel room number #${roomNumberStr}`
    };
  }

  return {
    classification: 'UNKNOWN',
    evidence: 'Non-numeric or non-standard room identifier requiring manual review'
  };
}

async function auditMasterData() {
  console.log('================================================================================');
  console.log('       HPMS CLOUD FIRESTORE PRODUCTION MASTER DATA INVENTORY AUDIT (READ-ONLY)   ');
  console.log('================================================================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('Mode: STRICT READ-ONLY. Zero mutations will be performed.\n');

  if (!db) {
    console.error('ERROR: Firebase Admin db is not initialized.');
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Audit Collection: room_types
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('>>> [1/2] FETCHING COLLECTION: room_types ...');
  const roomTypesSnapshot = await db.collection('room_types').get();
  const roomTypes = [];

  roomTypesSnapshot.forEach(docSnap => {
    const data = docSnap.data();
    const docId = docSnap.id;
    const { classification, evidence } = classifyRoomType(docId, data);

    roomTypes.push({
      collection: 'room_types',
      docId,
      code: data.code || 'N/A',
      name: data.name || data.title || 'N/A',
      base_rate: data.base_rate !== undefined ? data.base_rate : (data.rate !== undefined ? data.rate : (data.default_base_rate !== undefined ? data.default_base_rate : 'N/A')),
      max_occupancy: data.max_occupancy !== undefined ? data.max_occupancy : 'N/A',
      is_active: data.is_active !== undefined ? Boolean(data.is_active) : (data.status ? data.status !== 'Inactive' : 'N/A'),
      created_at: data.created_at || data.createdAt || 'N/A',
      updated_at: data.updated_at || data.updatedAt || 'N/A',
      classification,
      evidence,
      rawKeys: Object.keys(data).sort().join(', ')
    });
  });

  // Sort room_types alphabetically by code/name/docId
  roomTypes.sort((a, b) => String(a.code || a.docId).localeCompare(String(b.code || b.docId)));

  console.log(`\nFound ${roomTypes.length} document(s) in 'room_types':\n`);
  console.log(
    '| #  | Document ID               | Code         | Name/Title             | Rate   | Active | Classification | Evidence'
  );
  console.log(
    '|----|---------------------------|--------------|------------------------|--------|--------|----------------|--------------------------------------------------'
  );

  roomTypes.forEach((rt, idx) => {
    const num = String(idx + 1).padStart(2, ' ');
    const docId = String(rt.docId).padEnd(25, ' ');
    const code = String(rt.code).padEnd(12, ' ');
    const name = String(rt.name).slice(0, 22).padEnd(22, ' ');
    const rate = String(rt.base_rate).padEnd(6, ' ');
    const active = String(rt.is_active).padEnd(6, ' ');
    const cls = String(rt.classification).padEnd(14, ' ');
    const ev = rt.evidence;
    console.log(`| ${num} | ${docId} | ${code} | ${name} | ${rate} | ${active} | ${cls} | ${ev}`);
  });

  console.log('\nDetailed room_types metadata:\n');
  roomTypes.forEach((rt, idx) => {
    console.log(`[RT-${idx + 1}] ID: ${rt.docId}`);
    console.log(`      Code: ${rt.code} | Name: ${rt.name} | Rate: ${rt.base_rate} | MaxOccupancy: ${rt.max_occupancy}`);
    console.log(`      Active: ${rt.is_active} | CreatedAt: ${rt.created_at} | UpdatedAt: ${rt.updated_at}`);
    console.log(`      Classification: ${rt.classification} (${rt.evidence})`);
    console.log(`      Document Fields: [${rt.rawKeys}]`);
    console.log('');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Audit Collection: rooms
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('────────────────────────────────────────────────────────────────────────────────');
  console.log('>>> [2/2] FETCHING COLLECTION: rooms ...');
  const roomsSnapshot = await db.collection('rooms').get();
  const rooms = [];

  roomsSnapshot.forEach(docSnap => {
    const data = docSnap.data();
    const docId = docSnap.id;
    const roomNumber = String(data.number || data.room_number || data.roomNumber || data.room_no || docId.replace(/^room_/, '')).trim();
    const { classification, evidence } = classifyRoom(docId, data);

    rooms.push({
      collection: 'rooms',
      docId,
      roomNumber,
      numericRoomNumber: parseInt(roomNumber, 10),
      type: data.type || data.room_type || 'N/A',
      status: data.status || data.occupancy_status || 'N/A',
      housekeeping_status: data.housekeeping_status || 'N/A',
      current_booking_id: data.current_booking_id || null,
      is_active: data.is_active !== undefined ? Boolean(data.is_active) : (data.status !== 'Inactive'),
      price: data.price !== undefined ? data.price : (data.rate !== undefined ? data.rate : (data.room_tariff !== undefined ? data.room_tariff : (data.base_rate !== undefined ? data.base_rate : 'N/A'))),
      created_at: data.created_at || data.createdAt || 'N/A',
      updated_at: data.updated_at || data.updatedAt || 'N/A',
      classification,
      evidence,
      rawKeys: Object.keys(data).sort().join(', ')
    });
  });

  // Sort rooms numerically by room number (fallback to docId string compare)
  rooms.sort((a, b) => {
    const numA = isNaN(a.numericRoomNumber) ? Infinity : a.numericRoomNumber;
    const numB = isNaN(b.numericRoomNumber) ? Infinity : b.numericRoomNumber;
    if (numA !== numB) return numA - numB;
    return String(a.docId).localeCompare(String(b.docId));
  });

  console.log(`\nFound ${rooms.length} document(s) in 'rooms':\n`);
  console.log(
    '| #   | Document ID      | Room #    | Type           | Status   | HK Status | Active | Classification | Evidence'
  );
  console.log(
    '|-----|------------------|-----------|----------------|----------|-----------|--------|----------------|--------------------------------------------------'
  );

  rooms.forEach((r, idx) => {
    const num = String(idx + 1).padStart(3, ' ');
    const docId = String(r.docId).padEnd(16, ' ');
    const roomNum = String(r.roomNumber).padEnd(9, ' ');
    const type = String(r.type).slice(0, 14).padEnd(14, ' ');
    const status = String(r.status).padEnd(8, ' ');
    const hk = String(r.housekeeping_status).padEnd(9, ' ');
    const active = String(r.is_active).padEnd(6, ' ');
    const cls = String(r.classification).padEnd(14, ' ');
    const ev = r.evidence;
    console.log(`| ${num} | ${docId} | ${roomNum} | ${type} | ${status} | ${hk} | ${active} | ${cls} | ${ev}`);
  });

  console.log('\nDetailed rooms metadata:\n');
  rooms.forEach((r, idx) => {
    console.log(`[ROOM-${idx + 1}] ID: ${r.docId}`);
    console.log(`        RoomNumber: ${r.roomNumber} | Type: ${r.type} | Rate/Price: ${r.price}`);
    console.log(`        OccupancyStatus: ${r.status} | Housekeeping: ${r.housekeeping_status} | Active: ${r.is_active}`);
    console.log(`        CurrentBookingId: ${r.current_booking_id || 'NONE'}`);
    console.log(`        CreatedAt: ${r.created_at} | UpdatedAt: ${r.updated_at}`);
    console.log(`        Classification: ${r.classification} (${r.evidence})`);
    console.log(`        Document Fields: [${r.rawKeys}]`);
    console.log('');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Totals & Aggregate Metrics
  // ─────────────────────────────────────────────────────────────────────────────
  const totalRoomTypes = roomTypes.length;
  const canonicalRoomTypes = roomTypes.filter(rt => rt.classification === 'REAL/CANONICAL').length;
  const suspectRoomTypes = roomTypes.filter(rt => rt.classification === 'TEST/SUSPECT').length;
  const unknownRoomTypes = roomTypes.filter(rt => rt.classification === 'UNKNOWN').length;

  const totalRooms = rooms.length;
  const activeRooms = rooms.filter(r => r.is_active === true).length;
  const inactiveRooms = rooms.filter(r => r.is_active === false).length;
  const canonicalRooms = rooms.filter(r => r.classification === 'REAL/CANONICAL').length;
  const suspectRooms = rooms.filter(r => r.classification === 'TEST/SUSPECT').length;
  const unknownRooms = rooms.filter(r => r.classification === 'UNKNOWN').length;

  console.log('================================================================================');
  console.log('                         AUDIT SUMMARY TOTALS                                   ');
  console.log('================================================================================');
  console.log(`TOTAL ROOM TYPES IN FIRESTORE       : ${totalRoomTypes}`);
  console.log(`  - Real / Canonical Room Types     : ${canonicalRoomTypes}`);
  console.log(`  - Suspicious / Test Room Types    : ${suspectRoomTypes}`);
  console.log(`  - Unknown / Unclassified          : ${unknownRoomTypes}`);
  console.log('');
  console.log(`TOTAL ROOMS IN FIRESTORE            : ${totalRooms}`);
  console.log(`  - Active Rooms                    : ${activeRooms}`);
  console.log(`  - Inactive Rooms                  : ${inactiveRooms}`);
  console.log(`  - Real / Canonical Rooms          : ${canonicalRooms}`);
  console.log(`  - Suspicious / Test Rooms         : ${suspectRooms}`);
  console.log(`  - Unknown / Unclassified          : ${unknownRooms}`);
  console.log('================================================================================');
  console.log('NO DATA WAS MODIFIED.');
  console.log('================================================================================');
}

auditMasterData()
  .then(() => {
    process.exit(0);
  })
  .catch(err => {
    console.error('Master data audit encountered an error:', err);
    console.log('NO DATA WAS MODIFIED.');
    process.exit(1);
  });
