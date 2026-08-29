import pool from '../backend/db.js';
import { reclaimStaleProcessing } from '../backend/services/outboxService.js';
import { isWorkerRunning } from '../backend/services/outboxWorker.js';

const [pending] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='PENDING'");
const [processing] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='PROCESSING'");
const [processed] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='PROCESSED'");
const [failed] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='FAILED'");
const [dead] = await pool.query("SELECT COUNT(*) as cnt FROM dual_write_outbox WHERE status='DEAD_LETTER'");
const [rooms] = await pool.query('SELECT COUNT(*) as cnt FROM rooms');
const [bookings] = await pool.query('SELECT COUNT(*) as cnt FROM bookings');
const [invoices] = await pool.query('SELECT COUNT(*) as cnt FROM invoices');
const [payments] = await pool.query('SELECT COUNT(*) as cnt FROM payments');
const [staff] = await pool.query('SELECT COUNT(*) as cnt FROM staff WHERE deleted=0');
const [guests] = await pool.query('SELECT COUNT(*) as cnt FROM guests');
const stale = await reclaimStaleProcessing();

console.log(JSON.stringify({
  outbox: {
    pending: pending[0].cnt, processing: processing[0].cnt,
    processed: processed[0].cnt, failed: failed[0].cnt,
    dead_letter: dead[0].cnt, stale_reclaimed: stale
  },
  mysql: {
    rooms: rooms[0].cnt, bookings: bookings[0].cnt, invoices: invoices[0].cnt,
    payments: payments[0].cnt, staff: staff[0].cnt, guests: guests[0].cnt
  },
  worker_running: isWorkerRunning()
}, null, 2));

await pool.end();
