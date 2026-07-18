import mysql from 'mysql2/promise';

async function run() {
  const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'Akshu@5362',
    database: 'hotel_pms'
  });

  const [rows] = await pool.query(`
    SELECT room_id, COUNT(*) as cnt 
    FROM bookings 
    WHERE booking_status IN ('Reserved', 'Checked In') 
    GROUP BY room_id 
    HAVING cnt > 1
  `);
  
  console.log("Rooms with duplicates:", rows);
  
  for (const row of rows) {
    const roomId = row.room_id;
    console.log("Fixing room", roomId);
    
    // Get all active bookings for this room ordered by Checked In first, then ID DESC
    const [bookings] = await pool.query(`
      SELECT id, booking_status 
      FROM bookings 
      WHERE room_id = ? AND booking_status IN ('Reserved', 'Checked In')
      ORDER BY 
        CASE WHEN booking_status = 'Checked In' THEN 1 ELSE 2 END,
        id DESC
    `, [roomId]);
    
    console.log("Bookings for room", roomId, ":", bookings);
    
    // Keep the first one, cancel the rest
    for (let i = 1; i < bookings.length; i++) {
      const b = bookings[i];
      console.log("Cancelling booking", b.id);
      await pool.query("UPDATE bookings SET booking_status = 'Cancelled' WHERE id = ?", [b.id]);
    }
  }
  console.log("Done");
  process.exit(0);
}

run();
