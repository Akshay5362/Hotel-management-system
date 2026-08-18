import pool from '../backend/db.js';
import { db, auth, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';

async function auditAndFixStaffUidMapping() {
  console.log('\n=================================================');
  console.log('  AUDITING & VERIFYING STAFF FIREBASE UID MAPPING');
  console.log('=================================================\n');

  if (!isFirebaseConfigured || !db || !auth) {
    throw new Error('Firebase Admin SDK is not initialized.');
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const [mysqlStaff] = await connection.query(
      'SELECT id, username, email, role, status, deleted FROM staff ORDER BY id ASC'
    );

    console.log(`[MySQL Staff Records] Total: ${mysqlStaff.length}`);

    let auditPassed = true;
    let updatedCount = 0;

    for (const staff of mysqlStaff) {
      const expectedDocId = `staff_${staff.id}`;
      const expectedUid = `staff_${staff.id}`;

      // Read Firestore doc
      const docRef = db.collection('staff').doc(expectedDocId);
      const docSnap = await docRef.get();

      if (!docSnap.exists) {
        console.error(`❌ Mismatch: Firestore document /staff/${expectedDocId} does NOT exist!`);
        auditPassed = false;
        continue;
      }

      const docData = docSnap.data();

      // Read Firebase Auth user
      let authUser = null;
      try {
        authUser = await auth.getUser(expectedUid);
      } catch (err) {
        console.error(`❌ Mismatch: Firebase Auth user '${expectedUid}' not found!`);
        auditPassed = false;
        continue;
      }

      const mysqlIdMatch = Number(docData.mysql_staff_id || staff.id) === staff.id;
      const uidMatch = docData.user_uid === expectedUid;
      const authUidMatch = authUser.uid === expectedUid;

      if (!mysqlIdMatch || !authUidMatch) {
        console.error(`❌ Mismatch for Staff ID ${staff.id}: mysql_staff_id match: ${mysqlIdMatch}, authUid match: ${authUidMatch}`);
        auditPassed = false;
      }

      if (!uidMatch) {
        console.log(`[Updating] Populating missing user_uid: '${expectedUid}' in Firestore /staff/${expectedDocId}`);
        await docRef.update({
          user_uid: expectedUid,
          updated_at: new Date().toISOString()
        });
        updatedCount++;
      } else {
        console.log(`✔ [100% Aligned] /staff/${expectedDocId} -> mysql_id: ${staff.id}, user_uid: '${expectedUid}', authUid: '${authUser.uid}', status: '${docData.status}'`);
      }
    }

    console.log(`\nStaff UID Parity Audit Summary: Updated ${updatedCount} Firestore documents.`);
    if (auditPassed) {
      console.log('✔ Staff UID Mapping 100% PARITY VERIFIED!\n');
    } else {
      console.error('❌ Staff UID Mapping Mismatches Detected!\n');
      process.exitCode = 1;
    }

  } catch (err) {
    console.error('❌ Audit Failed:', err.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
}

auditAndFixStaffUidMapping();
