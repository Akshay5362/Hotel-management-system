/**
 * backend/tests/fixRoom4RoomTypeDenormalization.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE-TIME STRICTLY SCOPED FIRESTORE DATA CORRECTION
 *
 * Target: hpms-sky5 Cloud Firestore
 * Scope : EXACTLY one document: rooms/room_4
 * Field : type: "DELUXE" -> "EXECUTIVE"
 *
 * Safety Constraints:
 * - Scoped exclusively to rooms/room_4.
 * - Strict multi-field precondition validation before mutation.
 * - Confirms room_types/room_type_2 exists with code "EXECUTIVE".
 * - Modifies ONLY the 'type' field.
 * - Post-update snapshot comparison ensuring zero other fields changed.
 * - Fails closed on any unexpected state.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import assert from 'assert';
import { db } from '../config/firebaseAdmin.js';

const TARGET_ROOM_DOC_ID = 'room_4';
const CANONICAL_ROOM_TYPE_DOC_ID = 'room_type_2';

async function normalizeRoom4Type() {
  console.log('===============================================================');
  console.log('HPMS ROOM_4 ROOM-TYPE NORMALIZATION');
  console.log('===============================================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('PROJECT: hpms-sky5');
  console.log(`TARGET : rooms/${TARGET_ROOM_DOC_ID}\n`);

  if (!db) {
    console.error('CRITICAL: Firebase Admin DB is not initialized.');
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 1: Precondition Checks
  // ─────────────────────────────────────────────────────────────────────────
  console.log('>>> [1/3] VALIDATING STRICT PRECONDITIONS ...');

  // 1. Check room_types/room_type_2
  const rtSnap = await db.collection('room_types').doc(CANONICAL_ROOM_TYPE_DOC_ID).get();
  if (!rtSnap.exists) {
    console.error(`PRECONDITION FAILED: room_types/${CANONICAL_ROOM_TYPE_DOC_ID} does not exist in Firestore!`);
    process.exit(1);
  }
  const rtData = rtSnap.data();
  if (rtData.code !== 'EXECUTIVE') {
    console.error(`PRECONDITION FAILED: room_types/${CANONICAL_ROOM_TYPE_DOC_ID}.code is '${rtData.code}', expected 'EXECUTIVE'!`);
    process.exit(1);
  }

  // 2. Check rooms/room_4
  const roomSnap = await db.collection('rooms').doc(TARGET_ROOM_DOC_ID).get();
  if (!roomSnap.exists) {
    console.error(`PRECONDITION FAILED: rooms/${TARGET_ROOM_DOC_ID} does not exist in Firestore!`);
    process.exit(1);
  }
  const preUpdateData = roomSnap.data();

  const failedChecks = [];
  if (preUpdateData.room_type_id !== 2) {
    failedChecks.push(`room_type_id (${preUpdateData.room_type_id}) !== 2`);
  }
  if (preUpdateData.mysql_room_type_id !== 2) {
    failedChecks.push(`mysql_room_type_id (${preUpdateData.mysql_room_type_id}) !== 2`);
  }
  if (preUpdateData.room_type_code !== 'EXECUTIVE') {
    failedChecks.push(`room_type_code ('${preUpdateData.room_type_code}') !== 'EXECUTIVE'`);
  }
  if (preUpdateData.room_type_title !== 'Executive Work Room') {
    failedChecks.push(`room_type_title ('${preUpdateData.room_type_title}') !== 'Executive Work Room'`);
  }
  if (preUpdateData.type !== 'DELUXE') {
    failedChecks.push(`type ('${preUpdateData.type}') !== 'DELUXE'`);
  }

  if (failedChecks.length > 0) {
    console.error('PRECONDITION CHECKS FAILED:');
    failedChecks.forEach(c => console.error(`  ✗ ${c}`));
    console.error('Aborting. Zero mutations performed.');
    process.exit(1);
  }

  console.log('PRECONDITION CHECK:');
  console.log(`  room_type_id        : ${preUpdateData.room_type_id}`);
  console.log(`  mysql_room_type_id  : ${preUpdateData.mysql_room_type_id}`);
  console.log(`  room_type_code      : ${preUpdateData.room_type_code}`);
  console.log(`  room_type_title     : ${preUpdateData.room_type_title}`);
  console.log(`  current type        : ${preUpdateData.type}`);
  console.log(`  canonical type      : ${rtData.code}`);
  console.log('  ✓ All preconditions satisfied.');

  // ─────────────────────────────────────────────────────────────────────────
  // Step 2: Perform Scoped Update
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [2/3] EXECUTING SCOPED UPDATE ...');
  console.log('UPDATE:');
  console.log('  ONLY field changed: type');
  console.log('  DELUXE -> EXECUTIVE');

  await db.collection('rooms').doc(TARGET_ROOM_DOC_ID).update({
    type: 'EXECUTIVE'
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Step 3: Post-Update Verification
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n>>> [3/3] EXECUTING POST-UPDATE VERIFICATION ...');
  const postSnap = await db.collection('rooms').doc(TARGET_ROOM_DOC_ID).get();
  if (!postSnap.exists) {
    console.error('CRITICAL: rooms/room_4 missing after update!');
    process.exit(1);
  }
  const postUpdateData = postSnap.data();

  // Validate expected values
  assert.strictEqual(postUpdateData.type, 'EXECUTIVE', "room_4.type must be 'EXECUTIVE'");
  assert.strictEqual(postUpdateData.room_type_id, 2, 'room_type_id must remain 2');
  assert.strictEqual(postUpdateData.mysql_room_type_id, 2, 'mysql_room_type_id must remain 2');
  assert.strictEqual(postUpdateData.room_type_code, 'EXECUTIVE', "room_type_code must remain 'EXECUTIVE'");
  assert.strictEqual(postUpdateData.room_type_title, 'Executive Work Room', "room_type_title must remain 'Executive Work Room'");

  // Verify that NO other fields changed
  const preKeys = Object.keys(preUpdateData).filter(k => k !== 'type');
  const postKeys = Object.keys(postUpdateData).filter(k => k !== 'type');

  assert.strictEqual(preKeys.length, postKeys.length, 'Total non-type field count must remain identical');

  for (const key of preKeys) {
    const preVal = JSON.stringify(preUpdateData[key]);
    const postVal = JSON.stringify(postUpdateData[key]);
    assert.strictEqual(
      preVal,
      postVal,
      `Field '${key}' unexpectedly changed during update: before=${preVal}, after=${postVal}`
    );
  }

  console.log('POST-UPDATE VERIFICATION:');
  console.log('  ✓ room_4.type === EXECUTIVE');
  console.log('  ✓ authoritative room type fields unchanged');
  console.log('  ✓ no other fields changed');
  console.log('\nFINAL STATUS:');
  console.log('SUCCESS\n');
  console.log('===============================================================');
  process.exit(0);
}

normalizeRoom4Type().catch(err => {
  console.error('Fatal error during room_4 type normalization:', err);
  process.exit(1);
});
