import mysql from 'mysql2/promise';

async function testDatabase() {
  let connection;
  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'db',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'hotel_pms'
    });

    console.log('Connected successfully');

    const [[{ c: guests }]] = await connection.query('SELECT COUNT(*) as c FROM guests');
    const [[{ c: bookings }]] = await connection.query('SELECT COUNT(*) as c FROM bookings');
    const [[{ c: rooms }]] = await connection.query('SELECT COUNT(*) as c FROM rooms');
    const [[{ c: payments }]] = await connection.query('SELECT COUNT(*) as c FROM payments');

    console.log(`Total guests: ${guests}`);
    console.log(`Total bookings: ${bookings}`);
    console.log(`Total rooms: ${rooms}`);
    console.log(`Total payments: ${payments}`);

    await connection.end();
    process.exit(0);
  } catch (error) {
    console.error('Database connection error:', error.message);
    if (connection) {
      await connection.end();
    }
    process.exit(1);
  }
}

testDatabase();
