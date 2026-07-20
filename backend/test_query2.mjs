import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'hotel_pms',
  port: 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

async function test() {
  let conn;
  try {
    conn = await pool.getConnection();
    const [rooms] = await conn.query(`SELECT 
        rt.id as category_id,
        rt.code as category,
        rt.title,
        rt.description,
        rt.base_rate as price,
        rt.image,
        COUNT(r.id) as total_rooms,
        SUM(CASE WHEN r.status = 'VACANT' THEN 1 ELSE 0 END) as available_rooms
      FROM room_types rt
      JOIN rooms r ON r.room_type_id = rt.id
      GROUP BY rt.id`);
    console.log("SUCCESS!");
    console.log(rooms);
  } catch (e) {
    console.error('SQL ERROR:', e.message);
  } finally {
    if (conn) conn.release();
    process.exit(0);
  }
}
test();
