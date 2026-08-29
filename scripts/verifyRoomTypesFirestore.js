import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';

async function verifyRoomTypes() {
  console.log('\n=== READ-ONLY FIRESTORE ROOM_TYPES VERIFICATION ===\n');

  let connection;
  try {
    connection = await pool.getConnection();
    const [mysqlRows] = await connection.query(`
      SELECT id, code, title, description, base_rate, image
      FROM room_types
      ORDER BY id ASC
    `);

    const snapshot = await db.collection('room_types').get();
    const roomsSnapshot = await db.collection('rooms').get();

    console.log(`[Firestore] Total Documents in /room_types: ${snapshot.size}`);
    console.log(`[MySQL] Total Records in MySQL room_types: ${mysqlRows.length}`);
    console.log(`[Firestore] Total Documents in /rooms (Untouched Check): ${roomsSnapshot.size}`);

    if (snapshot.size !== mysqlRows.length) {
      console.error(`❌ Mismatch! Firestore room_types docs (${snapshot.size}) != MySQL room_types (${mysqlRows.length})`);
      process.exit(1);
    }

    if (roomsSnapshot.size !== 17) {
      console.error(`❌ Unexpected alteration of /rooms collection! Count is ${roomsSnapshot.size}, expected 17.`);
      process.exit(1);
    }

    let mismatchCount = 0;
    const firestoreDocsMap = new Map();
    snapshot.forEach(doc => firestoreDocsMap.set(doc.id, doc.data()));

    for (const mysqlRt of mysqlRows) {
      const expectedDocId = `room_type_${mysqlRt.id}`;
      const firestoreData = firestoreDocsMap.get(expectedDocId);

      if (!firestoreData) {
        console.error(`❌ Missing Firestore Document: ${expectedDocId}`);
        mismatchCount++;
        continue;
      }

      if (
        firestoreData.mysql_id !== Number(mysqlRt.id) ||
        firestoreData.code !== String(mysqlRt.code) ||
        firestoreData.title !== String(mysqlRt.title || '') ||
        firestoreData.description !== String(mysqlRt.description || '') ||
        Number(firestoreData.default_base_rate) !== Number(mysqlRt.base_rate) ||
        firestoreData.image !== String(mysqlRt.image || '')
      ) {
        console.error(`❌ Field Mismatch for ${expectedDocId}:`, { mysqlRt, firestoreData });
        mismatchCount++;
      }
    }

    console.log(`\nDocument IDs Verified : ${Array.from(firestoreDocsMap.keys()).join(', ')}`);
    console.log(`Field Comparison Mismatches: ${mismatchCount}`);
    
    if (mismatchCount === 0 && snapshot.size === mysqlRows.length && roomsSnapshot.size === 17) {
      console.log(`\n✔ VERIFICATION SUCCESS: All ${snapshot.size} room_type documents match MySQL records cleanly, and /rooms collection is untouched.`);
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

verifyRoomTypes();
