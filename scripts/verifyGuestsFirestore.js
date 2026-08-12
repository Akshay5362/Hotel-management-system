import pool from '../backend/db.js';
import { db, auth } from '../backend/config/firebaseAdmin.js';

async function verifyGuests() {
  console.log('\n=== READ-ONLY FIRESTORE GUEST VERIFICATION ===\n');

  let connection;
  try {
    connection = await pool.getConnection();
    const [mysqlRows] = await connection.query(`
      SELECT id AS mysql_guest_id, user_id AS mysql_user_id, full_name, email, phone, address, gst_no, pincode, country, arrival_from, departure_to, government_id, id_type, gender, age, loyalty_tier, loyalty_points, created_at, updated_at
      FROM guests
      ORDER BY id ASC
    `);

    const guestsSnapshot = await db.collection('guests').get();
    const roomsSnapshot = await db.collection('rooms').get();
    const roomTypesSnapshot = await db.collection('room_types').get();
    const staffSnapshot = await db.collection('staff').get();

    console.log(`[Firestore] Total Documents in /guests      : ${guestsSnapshot.size}`);
    console.log(`[MySQL] Total Records in MySQL guests       : ${mysqlRows.length}`);
    console.log(`[Firestore] Total Documents in /rooms      : ${roomsSnapshot.size} (Expected: 17)`);
    console.log(`[Firestore] Total Documents in /room_types : ${roomTypesSnapshot.size} (Expected: 3)`);
    console.log(`[Firestore] Total Documents in /staff      : ${staffSnapshot.size} (Expected: 11)`);

    if (guestsSnapshot.size !== mysqlRows.length) {
      console.error(`❌ Mismatch! Firestore guests docs (${guestsSnapshot.size}) != MySQL guests (${mysqlRows.length})`);
      process.exit(1);
    }

    if (roomsSnapshot.size !== 17 || roomTypesSnapshot.size !== 3 || staffSnapshot.size !== 11) {
      console.error(`❌ Unexpected alteration of pre-existing Firestore collections!`);
      process.exit(1);
    }

    let authUserCount = 0;
    if (auth) {
      try {
        const list = await auth.listUsers(10);
        authUserCount = list.users.length;
      } catch (e) {
        authUserCount = 0;
      }
    }
    console.log(`[Firebase Auth] Total Provisioned Users: ${authUserCount} (Expected: 0)`);

    if (authUserCount !== 0) {
      console.error(`❌ SECURITY ALERT: Firebase Auth users count is ${authUserCount}, expected 0.`);
      process.exit(1);
    }

    let mismatchCount = 0;
    let passwordHashFound = false;
    const firestoreDocsMap = new Map();
    guestsSnapshot.forEach(doc => firestoreDocsMap.set(doc.id, doc.data()));

    for (const mysqlGuest of mysqlRows) {
      const expectedDocId = `guest_${mysqlGuest.mysql_guest_id}`;
      const data = firestoreDocsMap.get(expectedDocId);

      if (!data) {
        console.error(`❌ Missing Firestore Document: ${expectedDocId}`);
        mismatchCount++;
        continue;
      }

      // Check credential fields
      if (data.password || data.password_hash || data.hash || data.secret) {
        passwordHashFound = true;
        console.error(`❌ SECURITY FAILURE: Password or secret field found in document ${expectedDocId}`);
      }

      if (
        data.mysql_guest_id !== mysqlGuest.mysql_guest_id ||
        data.full_name !== mysqlGuest.full_name ||
        data.user_uid !== null
      ) {
        console.error(`❌ Mismatch for document ${expectedDocId}:`, { mysqlGuest, firestoreData: data });
        mismatchCount++;
      }
    }

    console.log(`\nDocument IDs Verified      : ${Array.from(firestoreDocsMap.keys()).join(', ')}`);
    console.log(`Field Mismatches           : ${mismatchCount}`);
    console.log(`Credential Leak Detected   : ${passwordHashFound ? 'YES' : 'NO'}`);

    if (mismatchCount === 0 && !passwordHashFound && guestsSnapshot.size === 4 && authUserCount === 0) {
      console.log('\n✔ VERIFICATION SUCCESS: All 4 guest documents match MySQL cleanly. Passwords EXCLUDED. Firebase Auth = 0.');
    } else {
      console.error('\n❌ VERIFICATION FAILED!');
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Verification Error:', err.message);
    process.exit(1);
  } finally {
    if (connection) connection.release();
  }
}

verifyGuests();
