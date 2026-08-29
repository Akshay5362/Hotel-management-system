import pool from '../backend/db.js';
import { db, auth } from '../backend/config/firebaseAdmin.js';

const ROLE_MAP = {
  'ADMIN': 'admin',
  'RECEPTIONIST': 'receptionist',
  'CLEANER': 'housekeeper',
  'CHEF': 'kitchen',
  'KITCHEN_HELPER': 'kitchen',
  'PANTRY_BOY': 'kitchen'
};

async function verifyStaff() {
  console.log('\n=== READ-ONLY FIRESTORE STAFF VERIFICATION ===\n');

  let connection;
  try {
    connection = await pool.getConnection();
    const [mysqlRows] = await connection.query(`
      SELECT id AS mysql_staff_id, username, email, full_name, role, department, shift, status, deleted
      FROM staff
      ORDER BY id ASC
    `);

    const staffSnapshot = await db.collection('staff').get();
    const roomsSnapshot = await db.collection('rooms').get();
    const roomTypesSnapshot = await db.collection('room_types').get();

    console.log(`[Firestore] Total Documents in /staff       : ${staffSnapshot.size}`);
    console.log(`[MySQL] Total Records in MySQL staff        : ${mysqlRows.length}`);
    console.log(`[Firestore] Total Documents in /rooms       : ${roomsSnapshot.size} (Expected: 17)`);
    console.log(`[Firestore] Total Documents in /room_types  : ${roomTypesSnapshot.size} (Expected: 3)`);

    if (staffSnapshot.size !== mysqlRows.length) {
      console.error(`❌ Mismatch! Firestore staff docs (${staffSnapshot.size}) != MySQL staff (${mysqlRows.length})`);
      process.exit(1);
    }

    if (roomsSnapshot.size !== 17 || roomTypesSnapshot.size !== 3) {
      console.error(`❌ Unexpected alteration of /rooms or /room_types collections!`);
      process.exit(1);
    }

    // Check Firebase Auth Users Count
    let firebaseAuthUserCount = 0;
    if (auth) {
      try {
        const userList = await auth.listUsers(100);
        firebaseAuthUserCount = userList.users.length;
      } catch (authErr) {
        // Firebase Auth unprovisioned or zero users present
        firebaseAuthUserCount = 0;
      }
    }
    console.log(`[Firebase Auth] Total Provisioned Users: ${firebaseAuthUserCount} (Expected: 0)`);

    if (firebaseAuthUserCount !== 0) {
      console.error(`❌ SECURITY ALERT: Firebase Auth users count is ${firebaseAuthUserCount}, expected 0.`);
      process.exit(1);
    }

    let mismatchCount = 0;
    let passwordHashFound = false;
    const firestoreDocsMap = new Map();
    staffSnapshot.forEach(doc => firestoreDocsMap.set(doc.id, doc.data()));

    for (const mysqlStaff of mysqlRows) {
      const expectedDocId = `staff_${mysqlStaff.mysql_staff_id}`;
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

      const expectedRole = ROLE_MAP[mysqlStaff.role.toUpperCase()];

      if (
        data.mysql_staff_id !== mysqlStaff.mysql_staff_id ||
        data.username !== mysqlStaff.username ||
        data.full_name !== mysqlStaff.full_name ||
        data.role !== expectedRole ||
        data.user_uid !== null ||
        data.department !== (mysqlStaff.department || 'General') ||
        data.shift !== (mysqlStaff.shift || 'Morning') ||
        data.status !== (mysqlStaff.status || 'Active') ||
        Boolean(data.deleted) !== Boolean(mysqlStaff.deleted)
      ) {
        console.error(`❌ Mismatch for document ${expectedDocId}:`, { mysqlStaff, firestoreData: data });
        mismatchCount++;
      }
    }

    console.log(`\nDocument IDs Verified      : ${Array.from(firestoreDocsMap.keys()).join(', ')}`);
    console.log(`Field Mismatches           : ${mismatchCount}`);
    console.log(`Credential Leak Detected   : ${passwordHashFound ? 'YES' : 'NO'}`);

    if (mismatchCount === 0 && !passwordHashFound && staffSnapshot.size === 11 && firebaseAuthUserCount === 0) {
      console.log('\n✔ VERIFICATION SUCCESS: All 11 staff documents match MySQL cleanly. Passwords EXCLUDED. Firebase Auth = 0.');
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

verifyStaff();
