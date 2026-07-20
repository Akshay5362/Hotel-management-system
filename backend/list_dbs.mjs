import mysql from 'mysql2/promise';

async function listDbs() {
  try {
    const pool = mysql.createPool({
      host: '127.0.0.1',
      user: 'root',
      password: '',
      port: 3306,
    });
    const conn = await pool.getConnection();
    const [rows] = await conn.query("SHOW DATABASES");
    console.log("Databases on 3306 (empty pass):", rows.map(r => r.Database));
    conn.release();
    process.exit(0);
  } catch (err) {
    console.error("Failed empty pass on 3306:", err.message);
  }
}

listDbs();
