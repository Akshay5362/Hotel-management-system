/**
 * Phase 4B Audit — READ ONLY — zero writes
 */
import pool from '../backend/db.js';
import { db, auth, isFirebaseConfigured } from '../backend/config/firebaseAdmin.js';

async function audit() {
  let conn;
  try {
    conn = await pool.getConnection();

    // ── 1. guests table columns
    const [cols] = await conn.query('SHOW COLUMNS FROM guests');
    console.log('=== GUESTS TABLE COLUMNS ===');
    cols.forEach(c => console.log(`  ${c.Field.padEnd(30)} ${c.Type.padEnd(25)} NULL=${c.Null} DEFAULT=${c.Default}`));

    // ── 2. users table columns
    const [ucols] = await conn.query('SHOW COLUMNS FROM users');
    console.log('\n=== USERS TABLE COLUMNS ===');
    ucols.forEach(c => console.log(`  ${c.Field.padEnd(30)} ${c.Type.padEnd(25)} NULL=${c.Null}`));

    // ── 3. All guest rows
    const [guests] = await conn.query(`
      SELECT
        g.id AS mysql_guest_id,
        g.user_id AS mysql_user_id,
        g.full_name,
        g.email,
        g.phone,
        g.address,
        g.gst_no,
        g.pincode,
        g.country,
        g.arrival_from,
        g.departure_to,
        g.government_id,
        g.id_type,
        g.gender,
        g.age,
        g.loyalty_tier,
        g.loyalty_points,
        g.id_document_path,
        g.id_upload_timestamp,
        g.id_verification_status,
        g.id_rejection_reason,
        g.id_verified_by,
        g.id_verified_at,
        g.created_at,
        g.updated_at,
        u.username AS linked_username,
        u.fullName AS linked_fullName,
        u.phone AS user_phone
      FROM guests g
      LEFT JOIN users u ON g.user_id = u.id
      ORDER BY g.id ASC
    `);
    console.log('\n=== MYSQL GUESTS (FULL SCAN) ===');
    console.log(`Total: ${guests.length}`);
    guests.forEach(g => {
      const uid = g.mysql_user_id ? `guest_${g.mysql_user_id}` : 'NO_FIREBASE_UID';
      console.log(JSON.stringify({
        mysql_guest_id: g.mysql_guest_id,
        mysql_user_id: g.mysql_user_id,
        expected_firebase_uid: uid,
        full_name: g.full_name,
        email: g.email ? g.email.replace(/(.{2}).*(@.*)/, '$1***$2') : null,
        phone_present: !!g.phone,
        govt_id_present: !!g.government_id,
        id_type: g.id_type,
        id_document_path: g.id_document_path,
        id_verification_status: g.id_verification_status,
        loyalty_tier: g.loyalty_tier,
        loyalty_points: g.loyalty_points,
        linked_username: g.linked_username,
        created_at: g.created_at,
        updated_at: g.updated_at
      }));
    });

    // ── 4. Users relevant to guests
    const [guestUsers] = await conn.query(`
      SELECT u.id, u.username, u.fullName, u.phone,
             r.name as role
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      WHERE r.name = 'guest'
      ORDER BY u.id ASC
    `);
    console.log('\n=== USERS WITH GUEST ROLE ===');
    console.log(`Total guest-role users: ${guestUsers.length}`);
    guestUsers.forEach(u => console.log(JSON.stringify({
      user_id: u.id,
      username: u.username,
      fullName: u.fullName,
      has_phone: !!u.phone,
      role: u.role,
      expected_firebase_uid: `guest_${u.id}`
    })));

    // ── 5. Counts
    const [[{gCnt}]]   = await conn.query('SELECT COUNT(*) as gCnt FROM guests');
    const [[{walkin}]] = await conn.query('SELECT COUNT(*) as walkin FROM guests WHERE user_id IS NULL');
    const [[{reg}]]    = await conn.query('SELECT COUNT(*) as reg FROM guests WHERE user_id IS NOT NULL');
    const [[{hasDoc}]] = await conn.query("SELECT COUNT(*) as hasDoc FROM guests WHERE id_document_path IS NOT NULL AND id_document_path != ''");
    const [[{dupPh}]]  = await conn.query("SELECT COUNT(*) as dupPh FROM (SELECT phone FROM guests WHERE phone IS NOT NULL AND phone != '' GROUP BY phone HAVING COUNT(*) > 1) t");
    const [[{dupEm}]]  = await conn.query("SELECT COUNT(*) as dupEm FROM (SELECT email FROM guests WHERE email IS NOT NULL AND email != '' GROUP BY email HAVING COUNT(*) > 1) t");
    const [[{noName}]] = await conn.query("SELECT COUNT(*) as noName FROM guests WHERE full_name IS NULL OR full_name = ''");
    const [[{orphan}]] = await conn.query("SELECT COUNT(*) as orphan FROM guests g LEFT JOIN users u ON g.user_id = u.id WHERE g.user_id IS NOT NULL AND u.id IS NULL");
    console.log('\n=== MYSQL GUEST COUNTS ===');
    console.log(`  Total guests          : ${gCnt}`);
    console.log(`  Walk-in (no user_id)  : ${walkin}`);
    console.log(`  Registered (user_id)  : ${reg}`);
    console.log(`  Has id_document_path  : ${hasDoc}`);
    console.log(`  Duplicate phones      : ${dupPh}`);
    console.log(`  Duplicate emails      : ${dupEm}`);
    console.log(`  Missing full_name     : ${noName}`);
    console.log(`  Orphan user_id refs   : ${orphan}`);

    // ── 6. Firestore /guests
    console.log('\n=== FIRESTORE /guests COLLECTION ===');
    if (!isFirebaseConfigured || !db) {
      console.log('  Firebase not configured');
    } else {
      const snap = await db.collection('guests').get();
      console.log(`  Firestore /guests count: ${snap.size}`);
      snap.forEach(doc => {
        const d = doc.data();
        console.log(JSON.stringify({
          docId: doc.id,
          mysql_guest_id: d.mysql_guest_id,
          mysql_user_id: d.mysql_user_id,
          user_uid: d.user_uid,
          full_name: d.full_name,
          has_email: !!d.email,
          has_phone: !!d.phone,
          loyalty_tier: d.loyalty_tier,
          id_ver_status: d.id_verification_status,
          has_id_doc_path: !!d.id_document_path,
          has_id_doc_url: !!d.id_document_url,
          migration_source: d.migration_source,
          created_at: d.created_at,
          updated_at: d.updated_at
        }));
      });
    }

    // ── 7. Firebase Auth users
    console.log('\n=== FIREBASE AUTH USERS ===');
    if (!isFirebaseConfigured || !auth) {
      console.log('  Auth not configured');
    } else {
      let pageToken;
      let allUsers = [];
      do {
        const result = await auth.listUsers(1000, pageToken);
        allUsers.push(...result.users);
        pageToken = result.pageToken;
      } while (pageToken);
      console.log(`  Total Firebase Auth users: ${allUsers.length}`);
      const guestAuthUsers = allUsers.filter(u => {
        const c = u.customClaims || {};
        return c.role === 'guest' || c.user_type === 'guest' || u.uid.startsWith('guest_');
      });
      const staffAuthUsers = allUsers.filter(u => {
        const c = u.customClaims || {};
        return c.role !== 'guest' && c.user_type !== 'guest' && !u.uid.startsWith('guest_');
      });
      console.log(`  Guest Firebase Auth users: ${guestAuthUsers.length}`);
      console.log(`  Staff Firebase Auth users: ${staffAuthUsers.length}`);
      guestAuthUsers.forEach(u => {
        const c = u.customClaims || {};
        console.log(JSON.stringify({
          uid: u.uid,
          email: u.email,
          displayName: u.displayName,
          role: c.role,
          user_type: c.user_type,
          mysql_id: c.mysql_id,
          disabled: u.disabled
        }));
      });

      // ── 8. Cross-reference: MySQL guest_id → Firebase UID → Firestore doc
      console.log('\n=== CROSS-REFERENCE: MySQL guest ↔ Firebase Auth ↔ Firestore ===');
      const firestoreSnap = await db.collection('guests').get();
      const firestoreDocs = new Map();
      firestoreSnap.forEach(doc => firestoreDocs.set(doc.id, doc.data()));
      const authUidMap = new Map();
      guestAuthUsers.forEach(u => {
        const c = u.customClaims || {};
        if (c.mysql_id) authUidMap.set(Number(c.mysql_id), u.uid);
        // Also try uid pattern guest_{mysql_user_id}
        if (u.uid.startsWith('guest_')) {
          const mId = parseInt(u.uid.replace('guest_', ''), 10);
          if (!isNaN(mId)) authUidMap.set(mId, u.uid);
        }
      });

      for (const g of guests) {
        const expectedDocId = `guest_${g.mysql_guest_id}`;
        const firestoreDoc = firestoreDocs.get(expectedDocId);
        // Auth UID: ensureGuestLazyAuthMigration sets uid = `guest_${user.id}` (users.id, NOT guests.id)
        const authUidByUserId = g.mysql_user_id ? `guest_${g.mysql_user_id}` : null;
        let authUser = null;
        if (authUidByUserId) {
          authUser = allUsers.find(u => u.uid === authUidByUserId);
        }

        console.log(JSON.stringify({
          mysql_guest_id: g.mysql_guest_id,
          mysql_user_id: g.mysql_user_id,
          expected_auth_uid: authUidByUserId,
          auth_user_exists: !!authUser,
          auth_uid_actual: authUser?.uid || null,
          firestore_doc_id: expectedDocId,
          firestore_doc_exists: !!firestoreDoc,
          firestore_user_uid: firestoreDoc?.user_uid || null,
          uid_matches_firestore: firestoreDoc ? (firestoreDoc.user_uid === authUidByUserId) : null,
          STATUS: (() => {
            if (!g.mysql_user_id) return 'WALK_IN';
            if (!authUser) return 'MISSING_FIREBASE_AUTH';
            if (!firestoreDoc) return 'MISSING_FIRESTORE_DOC';
            if (firestoreDoc.user_uid !== authUidByUserId) return 'UID_MISMATCH';
            return 'FULLY_LINKED';
          })()
        }));
      }
    }

  } catch(err) {
    console.error('Audit error:', err.message, err.stack);
  } finally {
    if (conn) conn.release();
    await pool.end();
  }
}

audit();
