/**
 * backend/tests/inspectAuditDeepDetails.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Deep inspection of bookings, reservations, payments, invoices, ledger_items
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from '../config/firebaseAdmin.js';

async function deepInspect() {
  console.log('=== BOOKINGS ===');
  const bSnap = await db.collection('bookings').get();
  bSnap.forEach(d => console.log(d.id, JSON.stringify(d.data())));

  console.log('\n=== RESERVATIONS ===');
  const rSnap = await db.collection('reservations').get();
  rSnap.forEach(d => console.log(d.id, JSON.stringify(d.data())));

  console.log('\n=== INVOICES ===');
  const iSnap = await db.collection('invoices').get();
  iSnap.forEach(d => console.log(d.id, JSON.stringify(d.data())));

  console.log('\n=== PAYMENTS ===');
  const pSnap = await db.collection('payments').get();
  pSnap.forEach(d => console.log(d.id, JSON.stringify(d.data())));
}

deepInspect().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
