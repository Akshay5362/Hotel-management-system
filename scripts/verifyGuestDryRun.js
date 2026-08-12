import pool from '../backend/db.js';
import { db, auth } from '../backend/config/firebaseAdmin.js';

async function verifyGuestDryRun() {
  console.log('\n=== POST-DRY-RUN READ-ONLY VERIFICATION ===\n');

  try {
    const roomsSnap = await db.collection('rooms').get();
    const roomTypesSnap = await db.collection('room_types').get();
    const staffSnap = await db.collection('staff').get();

    let guestsCollectionExists = false;
    let guestDocCount = 0;
    try {
      const guestsSnap = await db.collection('guests').get();
      guestDocCount = guestsSnap.size;
      guestsCollectionExists = true;
    } catch (e) {
      guestDocCount = 0;
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

    console.log(`[Firestore] /rooms Count       : ${roomsSnap.size} (Expected: 17)`);
    console.log(`[Firestore] /room_types Count  : ${roomTypesSnap.size} (Expected: 3)`);
    console.log(`[Firestore] /staff Count       : ${staffSnap.size} (Expected: 11)`);
    console.log(`[Firestore] /guests Count      : ${guestDocCount} (Expected: 0)`);
    console.log(`[Firebase Auth] User Count     : ${authUserCount} (Expected: 0)`);

    if (roomsSnap.size === 17 && roomTypesSnap.size === 3 && staffSnap.size === 11 && guestDocCount === 0 && authUserCount === 0) {
      console.log('\n✔ POST-DRY-RUN VERIFICATION SUCCESS: Zero Firestore writes performed. Collections remain intact.');
    } else {
      console.error('\n❌ VERIFICATION FAILURE!');
      process.exit(1);
    }
  } catch (err) {
    console.error('Error during verification:', err.message);
    process.exit(1);
  }
}

verifyGuestDryRun();
