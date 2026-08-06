/**
 * fix_orphaned_room_status.mjs
 * ============================
 * Finds rooms with status='occupied' or 'dirty' that have NO active
 * 'Checked In' booking in the bookings table, and resets them to 'vacant'.
 *
 * This is the same reconciliation logic RoomStatusService uses for the
 * dashboard — applied directly to the DB so checkInService sees a clean state.
 *
 * Safe to run multiple times (idempotent).
 */
import pool from '../db.js';

async function fix() {
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    // Find all rooms whose DB status is 'occupied' but have no Checked In booking
    const [orphaned] = await conn.query(`
      SELECT r.id, r.number, r.status, r.housekeeping_status
      FROM rooms r
      WHERE r.status = 'occupied'
        AND NOT EXISTS (
          SELECT 1 FROM bookings b
          WHERE b.room_id = r.id
            AND b.booking_status = 'Checked In'
        )
    `);

    if (orphaned.length === 0) {
      console.log('✔  No orphaned occupied rooms found.');
      await conn.rollback();
      conn.release();
      await pool.end();
      return;
    }

    console.log(`Found ${orphaned.length} orphaned room(s):`);
    orphaned.forEach(r => console.log(`  Room ${r.number} (id=${r.id}) status=${r.status} hk=${r.housekeeping_status}`));

    for (const r of orphaned) {
      // Keep housekeeping_status as-is — only reset occupancy status
      // If HK is Dirty, set to 'dirty' so housekeeping knows to clean it
      const newStatus = r.housekeeping_status === 'Dirty' ? 'dirty' : 'vacant';

      await conn.query(
        `UPDATE rooms SET status = ? WHERE id = ?`,
        [newStatus, r.id]
      );

      await conn.query(
        `INSERT INTO audit_logs (user_id, action, details, business_date)
         VALUES (NULL, 'SYSTEM_RECONCILE',
           ?,
           (SELECT value_val FROM system_settings WHERE key_name = 'system_date' LIMIT 1)
         )`,
        [`Auto-reconcile: Room ${r.number} had status='occupied' with no active booking. Reset to '${newStatus}'.`]
      );

      console.log(`  ✔  Room ${r.number}: occupied → ${newStatus}`);
    }

    await conn.commit();
    console.log('\n✔  Reconciliation complete. All orphaned rooms fixed.');
  } catch (e) {
    await conn.rollback();
    console.error('Fix failed, rolled back:', e.message);
    process.exit(1);
  } finally {
    conn.release();
    await pool.end();
  }
}

fix();
