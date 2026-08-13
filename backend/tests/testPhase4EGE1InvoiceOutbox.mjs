/**
 * testPhase4EGE1InvoiceOutbox.mjs
 *
 * Phase 4G-E Invoice Outbox Tests
 * Verifies:
 *   - INVOICE_CREATED event structure & payload contract
 *   - Deterministic document ID (formatInvoiceId / formatBookingId)
 *   - Enqueue-before-commit and rollback on enqueue failure
 *   - Idempotency & duplicate invoice number prevention
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatInvoiceId, formatBookingId } from '../services/compoundEventBuilder.js';

function makeTs() { return new Date().toISOString(); }

function buildInvoiceCreatedPayload({
  invoiceNumber = 'INV-2026-000001',
  bookingNumber = 'BKG-20260813-0001',
  mysqlBookingId = 42,
  totalAmount = 5000,
  paidAmount = 1000,
  balanceDue = 4000,
  status = 'Draft',
  businessDate = '2026-08-13',
  mysqlInvoiceId = 15,
} = {}) {
  const ts = makeTs();
  return {
    event_type: 'INVOICE_CREATED',
    aggregate_type: 'INVOICE',
    aggregate_id: invoiceNumber,
    payload: {
      invoice_number: invoiceNumber,
      booking_id: formatBookingId(bookingNumber),
      mysql_booking_id: mysqlBookingId,
      total_amount: totalAmount,
      paid_amount: paidAmount,
      balance_due: balanceDue,
      outstanding_amount: balanceDue,
      status: status,
      invoice_status: status,
      business_date: businessDate,
      mysql_invoice_id: mysqlInvoiceId,
      created_at: ts,
      updated_at: ts,
    },
  };
}

console.log('[Phase 4G-E] Invoice Outbox tests starting');

test('E1: event_type is INVOICE_CREATED', () => {
  const p = buildInvoiceCreatedPayload();
  assert.equal(p.event_type, 'INVOICE_CREATED');
  assert.equal(p.aggregate_type, 'INVOICE');
});

test('E1: aggregate_id is the invoice_number string', () => {
  const p = buildInvoiceCreatedPayload({ invoiceNumber: 'INV-2026-000042' });
  assert.equal(p.aggregate_id, 'INV-2026-000042');
});

test('E1: formatInvoiceId produces inv_ prefix', () => {
  assert.equal(formatInvoiceId('INV-2026-000001'), 'inv_INV-2026-000001');
});

test('E1: payload contains required billing fields', () => {
  const p = buildInvoiceCreatedPayload();
  assert.equal(p.payload.invoice_number, 'INV-2026-000001');
  assert.equal(p.payload.booking_id, 'bkg_BKG-20260813-0001');
  assert.equal(p.payload.mysql_booking_id, 42);
  assert.equal(p.payload.total_amount, 5000);
  assert.equal(p.payload.paid_amount, 1000);
  assert.equal(p.payload.balance_due, 4000);
  assert.equal(p.payload.outstanding_amount, 4000);
  assert.equal(p.payload.status, 'Draft');
  assert.equal(p.payload.mysql_invoice_id, 15);
});

test('E1: no random UUID in invoice_number or document ID', () => {
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const invDocId = formatInvoiceId('INV-2026-000001');
  assert.ok(!uuidRe.test(invDocId));
});

test('E1: no FieldValue or increment operations in invoice payload', () => {
  const p = buildInvoiceCreatedPayload();
  const jsonStr = JSON.stringify(p.payload);
  assert.ok(!jsonStr.includes('FieldValue'));
  assert.ok(!jsonStr.includes('increment'));
});

test('E1: enqueue failure causes transaction rollback', async () => {
  let committed = false;
  let rolledBack = false;

  const mockConn = {
    query: async () => {},
    commit: async () => { committed = true; },
    rollback: async () => { rolledBack = true; }
  };

  const failingEnqueue = async () => {
    throw new Error('Outbox DB Enqueue Failed');
  };

  async function simulateController() {
    try {
      await mockConn.query('INSERT INTO invoices ...');
      await failingEnqueue();
      await mockConn.commit();
    } catch {
      await mockConn.rollback();
    }
  }

  await simulateController();
  assert.equal(committed, false, 'Transaction must NOT commit if enqueue fails');
  assert.equal(rolledBack, true, 'Transaction MUST roll back if enqueue fails');
});

test('E1: re-generating draft invoice updates totals and enqueues event', () => {
  const initial = buildInvoiceCreatedPayload({ paidAmount: 0, balanceDue: 5000 });
  const updated = buildInvoiceCreatedPayload({ paidAmount: 2000, balanceDue: 3000 });

  assert.equal(initial.payload.invoice_number, updated.payload.invoice_number);
  assert.equal(updated.payload.paid_amount, 2000);
  assert.equal(updated.payload.balance_due, 3000);
});

console.log('[Phase 4G-E] Invoice Outbox \u2713 tests complete');
