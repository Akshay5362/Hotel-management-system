import { auth, db } from '../backend/config/firebaseAdmin.js';
import pool from '../backend/db.js';

async function verifyStaffAuthIntegration() {
  console.log('\n=== READ-ONLY STAFF FIREBASE AUTH INTEGRATION VERIFICATION ===\n');

  try {
    const staffSnap = await db.collection('staff').get();
    console.log(`1. Firestore /staff Documents Count: ${staffSnap.size}`);

    let linkedUidCount = 0;
    const docSummary = [];

    staffSnap.forEach(doc => {
      const d = doc.data();
      if (d.user_uid && d.user_uid.startsWith('staff_')) {
        linkedUidCount++;
      }
      docSummary.push({
        docId: doc.id,
        mysql_staff_id: d.mysql_staff_id,
        username: d.username,
        role: d.role,
        user_uid: d.user_uid
      });
    });

    console.table(docSummary);
    console.log(`\n2. Firestore /staff Documents Linked: ${linkedUidCount} / ${staffSnap.size}`);

    const roomsSnap = await db.collection('rooms').get();
    const roomTypesSnap = await db.collection('room_types').get();
    const guestsSnap = await db.collection('guests').get();

    console.log(`3. Firestore /rooms Count            : ${roomsSnap.size} (Expected: 17)`);
    console.log(`4. Firestore /room_types Count       : ${roomTypesSnap.size} (Expected: 3)`);
    console.log(`5. Firestore /guests Count           : ${guestsSnap.size} (Expected: 4)`);

    // Check Firebase Auth API Status
    try {
      const list = await auth.listUsers(1);
      console.log(`6. Firebase Auth Service API Status  : ENABLED (${list.users.length} users returned)`);
    } catch (authErr) {
      console.log(`6. Firebase Auth Service API Status  : UNCONFIGURED IN CONSOLE (${authErr.message})`);
    }

    if (linkedUidCount === 11 && staffSnap.size === 11 && roomsSnap.size === 17 && roomTypesSnap.size === 3 && guestsSnap.size === 4) {
      console.log('\n✔ FIRESTORE STAFF LINKING VERIFICATION SUCCESS: All 11 /staff documents cleanly linked with user_uid (staff_1..staff_11).');
    } else {
      console.error('\n❌ VERIFICATION FAILED!');
      process.exit(1);
    }
  } catch (err) {
    console.error('Integration Error:', err.message);
    process.exit(1);
  }
}

verifyStaffAuthIntegration();
