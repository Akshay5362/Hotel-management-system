import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';

async function verifyRooms() {
  console.log('\n=== READ-ONLY FIRESTORE ROOMS VERIFICATION ===\n');

  let connection;
  try {
    connection = await pool.getConnection();
    const [mysqlRows] = await connection.query(`
      SELECT 
        r.id AS mysql_room_id,
        r.number,
        r.status,
        COALESCE(r.housekeeping_status, 'Clean') AS housekeeping_status,
        rt.code AS room_type_code,
        rt.title AS room_type_title,
        rt.base_rate
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      ORDER BY r.id ASC
    `);

    const snapshot = await db.collection('rooms').get();
    console.log(`[Firestore] Total Documents in /rooms: ${snapshot.size}`);
    console.log(`[MySQL] Total Records in MySQL rooms: ${mysqlRows.length}`);

    if (snapshot.size !== mysqlRows.length) {
      console.error(`❌ Mismatch! Firestore docs (${snapshot.size}) != MySQL rooms (${mysqlRows.length})`);
      process.exit(1);
    }

    let mismatchCount = 0;
    const firestoreDocsMap = new Map();
    snapshot.forEach(doc => firestoreDocsMap.set(doc.id, doc.data()));

    for (const mysqlRoom of mysqlRows) {
      const expectedDocId = `room_${mysqlRoom.mysql_room_id}`;
      const firestoreData = firestoreDocsMap.get(expectedDocId);

      if (!firestoreData) {
        console.error(`❌ Missing Firestore Document: ${expectedDocId}`);
        mismatchCount++;
        continue;
      }

      if (
        firestoreData.mysql_id !== mysqlRoom.mysql_room_id ||
        String(firestoreData.number) !== String(mysqlRoom.number) ||
        firestoreData.status !== mysqlRoom.status ||
        firestoreData.room_type_code !== mysqlRoom.room_type_code ||
        firestoreData.housekeeping_status !== mysqlRoom.housekeeping_status ||
        Number(firestoreData.base_rate) !== Number(mysqlRoom.base_rate)
      ) {
        console.error(`❌ Field Mismatch for ${expectedDocId}:`, { mysqlRoom, firestoreData });
        mismatchCount++;
      }
    }

    console.log(`\nDocument IDs Verified : ${Array.from(firestoreDocsMap.keys()).join(', ')}`);
    console.log(`Field Comparison Mismatches: ${mismatchCount}`);
    
    if (mismatchCount === 0 && snapshot.size === 17) {
      console.log('\n✔ VERIFICATION SUCCESS: All 17 room documents perfectly match MySQL records.');
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

verifyRooms();
