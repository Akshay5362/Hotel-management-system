import mysql from 'mysql2/promise';

async function testEmptyPassword() {
  try {
    const pool = mysql.createPool({
      host: '127.0.0.1',
      user: 'root',
      password: '',
      database: 'hotel_pms',
      port: 3306,
    });
    const conn = await pool.getConnection();
    console.log("Connected successfully with empty password!");
    conn.release();
    process.exit(0);
  } catch (err) {
    console.error("Failed with empty password:", err.message);
  }
}

testEmptyPassword();
