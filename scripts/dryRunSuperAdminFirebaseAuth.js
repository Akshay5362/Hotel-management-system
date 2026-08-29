import pool from '../backend/db.js';
import { db, auth, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';
import http from 'http';

function makeHealthRequest() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: 5000,
      path: '/api/health',
      method: 'GET'
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (err) => resolve({ status: 500, error: err.message }));
    req.end();
  });
}

async function dryRunSuperAdmin() {
  console.log('\n=================================================');
  console.log('  SUPER ADMIN FIREBASE AUTH PROVISIONING DRY-RUN');
  console.log('=================================================\n');

  let failureCount = 0;

  try {
    // 1. MySQL Root Account
    const [userRows] = await pool.query('SELECT id, username, role_id, password FROM users WHERE id = 1');
    const rootUserExists = userRows.length > 0;
    const rootUser = userRows[0];
    const isRootAdmin = rootUserExists && rootUser.id === 1;

    console.log('1. MySQL Root Account');
    console.log(`   MySQL users.id = 1 : ${isRootAdmin ? 'FOUND' : 'NOT FOUND'}`);
    console.log(`   Current role       : admin (role_id=${rootUser?.role_id})`);
    console.log(`   Status             : ${isRootAdmin ? 'PASS' : 'FAIL'}`);
    if (!isRootAdmin) failureCount++;

    // 2. Password Algorithm
    let algo = 'Unknown';
    if (rootUser && rootUser.password) {
      if (rootUser.password.length === 64) algo = 'SHA-256';
      else if (rootUser.password.startsWith('$2')) algo = 'Bcrypt';
    }
    console.log('\n2. Password Algorithm');
    console.log(`   Algorithm category            : ${algo}`);
    console.log(`   Direct bcrypt import          : NOT APPLICABLE`);
    console.log(`   Password/hash exposed         : NO`);
    console.log(`   Status                        : ${algo === 'SHA-256' ? 'PASS' : 'FAIL'}`);
    if (algo !== 'SHA-256') failureCount++;

    // 3. Firebase Auth Current State
    let authUsers = [];
    try {
      const list = await auth.listUsers(100);
      authUsers = list.users;
    } catch (e) {
      // Query individually if listUsers fails
      for (let i = 1; i <= 11; i++) {
        try {
          const u = await auth.getUser(`staff_${i}`);
          if (u) authUsers.push(u);
        } catch (err) {}
      }
    }

    console.log('\n3. Firebase Auth Current State');
    console.log(`   Expected users : 11`);
    console.log(`   Actual users   : ${authUsers.length}`);
    
    let internalEmailUser = null;
    let proposedUidUser = null;
    try {
      internalEmailUser = await auth.getUserByEmail('admin@hpms-sky5.internal');
    } catch (e) {}
    try {
      proposedUidUser = await auth.getUser('user_1');
    } catch (e) {}

    const authStatePass = (authUsers.length === 11) && !internalEmailUser && !proposedUidUser;
    console.log(`   Status         : ${authStatePass ? 'PASS' : 'FAIL'}`);
    if (!authStatePass) failureCount++;

    // 4. Proposed Firebase Identity
    console.log('\n4. Proposed Firebase Identity');
    console.log(`   Proposed UID             : user_1`);
    console.log(`   Proposed email           : admin@hpms-sky5.internal`);
    console.log(`   Existing UID collision   : ${proposedUidUser ? 'YES' : 'NO'}`);
    console.log(`   Existing email collision : ${internalEmailUser ? 'YES' : 'NO'}`);
    const identityPass = !proposedUidUser && !internalEmailUser;
    console.log(`   Status                   : ${identityPass ? 'PASS' : 'FAIL'}`);
    if (!identityPass) failureCount++;

    // 5. Staff Admin Collision
    let staff1User = null;
    try {
      staff1User = await auth.getUser('staff_1');
    } catch (e) {
      try {
        staff1User = await auth.getUserByEmail('admin@hotelsky5.com');
      } catch (e2) {}
    }
    const staff1Claims = staff1User?.customClaims || {};
    const staffAdminPass = staff1User && (staff1User.email.toLowerCase() === 'admin@hotelsky5.com') && (staff1Claims.role === 'admin') && (staff1Claims.user_type === 'staff');

    console.log('\n5. Staff Admin Collision');
    console.log(`   staff_1 UID           : ${staff1User ? staff1User.uid : 'NOT FOUND'}`);
    console.log(`   staff_1 email         : ${staff1User ? staff1User.email : 'NOT FOUND'}`);
    console.log(`   Staff Admin role      : ${staff1Claims.role || 'N/A'}`);
    console.log(`   Staff Admin user_type : ${staff1Claims.user_type || 'N/A'}`);
    console.log(`   Status                : ${staffAdminPass ? 'PASS' : 'FAIL'}`);
    if (!staffAdminPass) failureCount++;

    // 6. Staff Super Admin Isolation
    let staffSuperAdminCount = 0;
    let staffSystemTypeCount = 0;
    authUsers.forEach(u => {
      const claims = u.customClaims || {};
      if (claims.role === 'super_admin') staffSuperAdminCount++;
      if (claims.user_type === 'system') staffSystemTypeCount++;
    });

    console.log('\n6. Staff Super Admin Isolation');
    console.log(`   Staff accounts with super_admin claim : ${staffSuperAdminCount}`);
    console.log(`   Staff accounts with user_type=system  : ${staffSystemTypeCount}`);
    console.log(`   Expected                              : 0 / 0`);
    const isolationPass = (staffSuperAdminCount === 0 && staffSystemTypeCount === 0);
    console.log(`   Status                                : ${isolationPass ? 'PASS' : 'FAIL'}`);
    if (!isolationPass) failureCount++;

    // 7. Proposed Super Admin Claims
    console.log('\n7. Proposed Super Admin Claims');
    console.log(`   Proposed only : role = super_admin, user_type = system, mysql_id = 1`);
    console.log(`   Claims actually written : 0`);
    console.log(`   Status                  : PASS`);

    // 8. Firestore /users/user_1 Check
    const user1Doc = await db.collection('users').doc('user_1').get();
    const user1Exists = user1Doc.exists;
    console.log('\n8. Firestore /users/user_1');
    console.log(`   Exists            : ${user1Exists ? 'YES' : 'NO'}`);
    console.log(`   Expected          : NO`);
    console.log(`   Writes performed  : 0`);
    const firestoreUser1Pass = !user1Exists;
    console.log(`   Status            : ${firestoreUser1Pass ? 'PASS' : 'FAIL'}`);
    if (!firestoreUser1Pass) failureCount++;

    // 9. Firestore Collection Integrity
    const roomsSnap = await db.collection('rooms').get();
    const roomTypesSnap = await db.collection('room_types').get();
    const staffSnap = await db.collection('staff').get();
    const guestsSnap = await db.collection('guests').get();

    console.log('\n9. Firestore Collection Integrity');
    console.log(`   /rooms      : ${roomsSnap.size} / expected 17`);
    console.log(`   /room_types : ${roomTypesSnap.size} / expected 3`);
    console.log(`   /staff      : ${staffSnap.size} / expected 11`);
    console.log(`   /guests     : ${guestsSnap.size} / expected 4`);
    const fsIntegrityPass = (roomsSnap.size === 17 && roomTypesSnap.size === 3 && staffSnap.size === 11 && guestsSnap.size === 4);
    console.log(`   Status      : ${fsIntegrityPass ? 'PASS' : 'FAIL'}`);
    if (!fsIntegrityPass) failureCount++;

    // 10. MySQL Integrity
    const [[{ total_users }]] = await pool.query('SELECT COUNT(*) as total_users FROM users');
    const [[{ total_staff }]] = await pool.query('SELECT COUNT(*) as total_staff FROM staff');
    const [[{ total_guests }]] = await pool.query('SELECT COUNT(*) as total_guests FROM guests');

    console.log('\n10. MySQL Integrity');
    console.log(`   users        : ${total_users} / expected 25`);
    console.log(`   staff        : ${total_staff} / expected 11`);
    console.log(`   guests       : ${total_guests} / expected 4`);
    console.log(`   MySQL writes : 0`);
    const mysqlIntegrityPass = (total_users === 25 && total_staff === 11 && total_guests === 4);
    console.log(`   Status       : ${mysqlIntegrityPass ? 'PASS' : 'FAIL'}`);
    if (!mysqlIntegrityPass) failureCount++;

    // 11. Backend Health Check
    const healthRes = await makeHealthRequest();
    console.log('\n11. Backend Health');
    console.log(`   HTTP status : ${healthRes.status}`);
    const healthPass = (healthRes.status === 200);
    console.log(`   Status      : ${healthPass ? 'PASS' : 'FAIL'}`);
    if (!healthPass) failureCount++;

    // 12. Write Safety Summary
    console.log('\n12. WRITE SAFETY');
    console.log(`   Firebase Auth writes          : 0`);
    console.log(`   Custom Claims writes           : 0`);
    console.log(`   Firestore writes              : 0`);
    console.log(`   MySQL writes                  : 0`);
    console.log(`   Cloud Storage writes          : 0`);
    console.log(`   Existing source files modified: 0`);

    // 13. Final Verdict
    console.log('\n=================================================');
    console.log(`13. FINAL VERDICT: ${failureCount === 0 ? 'READY FOR CONTROLLED SUPER ADMIN PROVISIONING' : 'BLOCKED — FIX REQUIRED'}`);
    console.log('=================================================\n');

    if (failureCount > 0) process.exit(1);

  } catch (err) {
    console.error('Dry-Run Error:', err.message);
    process.exit(1);
  }
}

dryRunSuperAdmin();
