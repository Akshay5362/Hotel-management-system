import mysql from 'mysql2/promise';

async function run() {
  try {
    const connection = await mysql.createConnection({
      host: '127.0.0.1', user: 'root', password: 'Akshu@5362', database: 'hotel_pms'
    });
    const limit = 25; const offset = 0;
    const [res] = await connection.query('SELECT id FROM guests LIMIT ? OFFSET ?', [limit, offset]);
    console.log('Success:', res.length);
    connection.end();
  } catch (e) { console.error('ERROR:', e.message); }
}
run();
