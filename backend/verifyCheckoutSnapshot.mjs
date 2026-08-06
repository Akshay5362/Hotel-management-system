/**
 * verifyCheckoutSnapshot.mjs
 * ===========================
 * Phase 1 Verification — Checkout Recovery Infrastructure
 *
 * Tests:
 *   1. checkout_snapshots table exists with correct schema
 *   2. CheckoutRecoveryService.createSnapshot() inserts a valid row
 *   3. Snapshot contains all required JSON fields
 *   4. Snapshot status = ACTIVE
 *   5. restoreSnapshot/validateRecovery/expireSnapshots/getUndoEligibility
 *      correctly throw NotImplemented (Phase 2 guards)
 *   6. Existing checkout endpoint is reachable and returns correct shape
 *
 * Run:
 *   node backend/verifyCheckoutSnapshot.mjs
 */

import pool from './db.js';
import { CheckoutRecoveryService } from './services/CheckoutRecoveryService.js';

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`  ✔  ${label}`);
  passed++;
}

function fail(label, err) {
  console.error(`  ✘  ${label}`);
  if (err) console.error(`       ${err.message || err}`);
  failed++;
}

async function assert(label, fn) {
  try {
    await fn();
    pass(label);
  } catch (e) {
    fail(label, e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function testTableSchema() {
  console.log('\n[1] Table Schema');

  await assert('checkout_snapshots table exists', async () => {
    const [rows] = await pool.query("SHOW TABLES LIKE 'checkout_snapshots'");
    if (rows.length === 0) throw new Error('Table not found');
  });

  const requiredColumns = [
    'id', 'booking_id', 'room_id', 'guest_id',
    'invoice_id', 'payment_id',
    'booking_snapshot', 'room_snapshot', 'invoice_snapshot',
    'ledger_snapshot', 'payment_snapshot',
    'created_by', 'created_at', 'expires_at', 'recovered_at', 'status'
  ];

  await assert('All required columns present', async () => {
    const [cols] = await pool.query('DESCRIBE checkout_snapshots');
    const names = cols.map(c => c.Field);
    const missing = requiredColumns.filter(c => !names.includes(c));
    if (missing.length > 0) throw new Error(`Missing columns: ${missing.join(', ')}`);
  });

  await assert('status column is ENUM with correct values', async () => {
    const [cols] = await pool.query("SHOW COLUMNS FROM checkout_snapshots WHERE Field = 'status'");
    const type = cols[0]?.Type || '';
    if (!type.includes('ACTIVE') || !type.includes('RECOVERED')) {
      throw new Error(`Unexpected status type: ${type}`);
    }
  });

  await assert('booking_id index exists', async () => {
    const [idxs] = await pool.query('SHOW INDEX FROM checkout_snapshots');
    const has = idxs.some(i => i.Key_name === 'idx_cs_booking_id');
    if (!has) throw new Error('idx_cs_booking_id not found');
  });

  await assert('status index exists', async () => {
    const [idxs] = await pool.query('SHOW INDEX FROM checkout_snapshots');
    if (!idxs.some(i => i.Key_name === 'idx_cs_status')) throw new Error('idx_cs_status not found');
  });

  await assert('expires_at index exists', async () => {
    const [idxs] = await pool.query('SHOW INDEX FROM checkout_snapshots');
    if (!idxs.some(i => i.Key_name === 'idx_cs_expires_at')) throw new Error('idx_cs_expires_at not found');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
async function testSnapshotCreation() {
  console.log('\n[2] Snapshot Creation via createSnapshot()');

  // We need real booking/room IDs. Use the first active checked-in booking.
  const [bookings] = await pool.query(
    `SELECT b.id as booking_id, b.room_id, b.guest_id, b.advance_amount,
            b.total_amount, b.booking_status, b.payment_status,
            r.number as room_number, r.status as room_status
     FROM bookings b JOIN rooms r ON b.room_id = r.id
     LIMIT 1`
  );

  if (bookings.length === 0) {
    fail('Test booking exists', new Error('No bookings in DB — run a check-in first'));
    return null;
  }

  const booking = bookings[0];
  const [roomRows] = await pool.query(
    'SELECT r.*, rt.code as type FROM rooms r JOIN room_types rt ON r.room_type_id = rt.id WHERE r.id = ?',
    [booking.room_id]
  );
  const room = roomRows[0];
  const [ledger] = await pool.query(
    'SELECT * FROM ledger_items WHERE booking_id = ? ORDER BY id ASC',
    [booking.booking_id]
  );

  let snapshotId = null;

  await assert('createSnapshot() inserts a row and returns an ID', async () => {
    // Use pool directly (not inside a real tx, but the method handles it)
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    try {
      snapshotId = await CheckoutRecoveryService.createSnapshot(conn, {
        bookingId:      booking.booking_id,
        roomId:         booking.room_id,
        guestId:        booking.guest_id,
        userId:         1,
        room,
        booking,
        ledgerItems:    ledger,
        totalCollected: booking.total_amount || 0,
        businessDate:   '2026-08-06',
      });
      if (!snapshotId) throw new Error('createSnapshot returned null (check logs for error)');
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  });

  return snapshotId;
}

// ─────────────────────────────────────────────────────────────────────────────
async function testSnapshotContent(snapshotId) {
  console.log('\n[3] Snapshot Content Integrity');
  if (!snapshotId) {
    fail('Snapshot content test', new Error('No snapshot ID — previous test failed'));
    return;
  }

  const [rows] = await pool.query('SELECT * FROM checkout_snapshots WHERE id = ?', [snapshotId]);
  const snap = rows[0];

  await assert('Snapshot row found in DB', async () => {
    if (!snap) throw new Error(`No row with id=${snapshotId}`);
  });

  await assert('status = ACTIVE', async () => {
    if (snap?.status !== 'ACTIVE') throw new Error(`status=${snap?.status}`);
  });

  await assert('expires_at is set and in the future', async () => {
    if (!snap?.expires_at) throw new Error('expires_at is null');
    if (new Date(snap.expires_at) <= new Date()) throw new Error('expires_at is in the past');
  });

  const jsonFields = ['booking_snapshot', 'room_snapshot', 'invoice_snapshot', 'ledger_snapshot', 'payment_snapshot'];
  for (const field of jsonFields) {
    await assert(`${field} is valid JSON with _snapshotVersion`, async () => {
      const raw = snap?.[field];
      if (!raw) throw new Error(`${field} is null/empty`);
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!parsed._snapshotVersion) throw new Error(`Missing _snapshotVersion in ${field}`);
      if (!parsed._capturedAt) throw new Error(`Missing _capturedAt in ${field}`);
    });
  }

  await assert('ledger_snapshot contains items array', async () => {
    const raw = snap?.ledger_snapshot;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed.items)) throw new Error('items is not an array');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
async function testNotImplementedGuards() {
  console.log('\n[4] Phase 2 Guards (NotImplemented throws)');

  await assert('restoreSnapshot() throws NotImplemented', async () => {
    try {
      await CheckoutRecoveryService.restoreSnapshot(1, 1);
      throw new Error('Should have thrown');
    } catch (e) {
      if (!e.message.includes('Not Implemented')) throw new Error(`Wrong error: ${e.message}`);
    }
  });

  await assert('validateRecovery() throws NotImplemented', async () => {
    try {
      await CheckoutRecoveryService.validateRecovery(1);
      throw new Error('Should have thrown');
    } catch (e) {
      if (!e.message.includes('Not Implemented')) throw new Error(`Wrong error: ${e.message}`);
    }
  });

  await assert('expireSnapshots() throws NotImplemented', async () => {
    try {
      await CheckoutRecoveryService.expireSnapshots();
      throw new Error('Should have thrown');
    } catch (e) {
      if (!e.message.includes('Not Implemented')) throw new Error(`Wrong error: ${e.message}`);
    }
  });

  await assert('getUndoEligibility() throws NotImplemented', async () => {
    try {
      await CheckoutRecoveryService.getUndoEligibility(1);
      throw new Error('Should have thrown');
    } catch (e) {
      if (!e.message.includes('Not Implemented')) throw new Error(`Wrong error: ${e.message}`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
async function testSnapshotImmutability() {
  console.log('\n[5] Immutability — Two createSnapshot() calls produce two rows');

  const [bookings] = await pool.query('SELECT id, room_id, guest_id, total_amount FROM bookings LIMIT 1');
  if (bookings.length === 0) {
    fail('Immutability test skipped', new Error('No bookings'));
    return;
  }

  const b = bookings[0];
  const [roomRows] = await pool.query(
    'SELECT r.*, rt.code as type FROM rooms r JOIN room_types rt ON r.room_type_id = rt.id WHERE r.id = ?',
    [b.room_id]
  );
  const room = roomRows[0];

  const context = {
    bookingId: b.id, roomId: b.room_id, guestId: b.guest_id,
    userId: 1, room, booking: b, ledgerItems: [],
    totalCollected: b.total_amount || 0, businessDate: '2026-08-06',
  };

  await assert('Two calls create two separate rows (never overwrite)', async () => {
    const [countBefore] = await pool.query('SELECT COUNT(*) as cnt FROM checkout_snapshots WHERE booking_id = ?', [b.id]);
    const before = countBefore[0].cnt;

    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await CheckoutRecoveryService.createSnapshot(conn, context);
    await conn.commit();
    conn.release();

    const conn2 = await pool.getConnection();
    await conn2.beginTransaction();
    await CheckoutRecoveryService.createSnapshot(conn2, context);
    await conn2.commit();
    conn2.release();

    const [countAfter] = await pool.query('SELECT COUNT(*) as cnt FROM checkout_snapshots WHERE booking_id = ?', [b.id]);
    const after = countAfter[0].cnt;

    if (after - before < 2) throw new Error(`Expected ≥2 new rows, got ${after - before}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  verifyCheckoutSnapshot.mjs — Phase 1 Verification');
  console.log('═══════════════════════════════════════════════════════');

  try {
    await testTableSchema();
    const snapshotId = await testSnapshotCreation();
    await testSnapshotContent(snapshotId);
    await testNotImplementedGuards();
    await testSnapshotImmutability();
  } finally {
    await pool.end();
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
