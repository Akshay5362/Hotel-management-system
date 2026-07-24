import mysql from 'mysql2/promise';

async function run() {
  try {
    const connection = await mysql.createConnection({
      host: '127.0.0.1',
      user: 'root',
      password: 'Akshu@5362',
      database: 'hotel_pms'
    });
    
    const [guestsCount] = await connection.query('SELECT COUNT(*) as c FROM guests');
    const [bookingsCount] = await connection.query('SELECT COUNT(*) as c FROM bookings');
    console.log('Guests Count:', guestsCount[0].c);
    console.log('Bookings Count:', bookingsCount[0].c);
    
    const [statsResult] = await connection.query(`
      SELECT 
        COUNT(g.id) as total,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM bookings ab WHERE ab.guest_id = g.id AND ab.booking_status IN ('Checked In','Reserved')) THEN 1 ELSE 0 END) as inhouse,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM bookings ab WHERE ab.guest_id = g.id AND ab.booking_status = 'Checked Out') AND NOT EXISTS (SELECT 1 FROM bookings ab2 WHERE ab2.guest_id = g.id AND ab2.booking_status IN ('Checked In','Reserved')) THEN 1 ELSE 0 END) as checkedout,
        SUM(CASE WHEN g.loyalty_tier IN ('Gold','Platinum') THEN 1 ELSE 0 END) as vip,
        SUM(CASE WHEN g.loyalty_tier = 'Blacklisted' THEN 1 ELSE 0 END) as blacklisted,
        SUM(CASE WHEN DATE(g.created_at) = CURDATE() THEN 1 ELSE 0 END) as new_today
      FROM guests g
    `);
    console.log('Stats Result:', statsResult[0]);
    
    // Also run the actual list query to see what it returns
    const [guests] = await connection.query(`
      SELECT
         g.id, g.full_name, g.phone, g.email, g.address, g.gst_no, g.pincode, g.country,
         g.arrival_from, g.departure_to,
         g.government_id, g.id_type, g.gender, g.age,
         g.id_verification_status,
         g.loyalty_tier, g.loyalty_points,
         g.created_at, g.updated_at,
         COUNT(b.id)                                                 AS total_bookings,
         COALESCE(SUM(b.total_amount), 0)                           AS lifetime_spend,
         MAX(b.created_at)                                          AS last_booking_at,
         (SELECT r.number FROM bookings ab JOIN rooms r ON ab.room_id = r.id
          WHERE ab.guest_id = g.id AND ab.booking_status IN ('Checked In','Reserved') LIMIT 1) AS current_room,
         (SELECT ab.booking_status FROM bookings ab
          WHERE ab.guest_id = g.id AND ab.booking_status IN ('Checked In','Reserved') LIMIT 1) AS current_status,
         (SELECT ab.booking_number FROM bookings ab
          WHERE ab.guest_id = g.id AND ab.booking_status IN ('Checked In','Reserved') LIMIT 1) AS current_booking_number
       FROM guests g
       LEFT JOIN bookings b ON b.guest_id = g.id
       
       GROUP BY g.id
       ORDER BY last_booking_at DESC, g.id DESC
       LIMIT 25 OFFSET 0
    `);
    console.log('Query returns', guests.length, 'guests.');
    
    connection.end();
  } catch (e) { console.error(e); }
}
run();
