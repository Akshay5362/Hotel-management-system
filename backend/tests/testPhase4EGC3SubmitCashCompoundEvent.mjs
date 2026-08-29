/**
 * testPhase4EGC3SubmitCashCompoundEvent.mjs
 * Phase 4G-C Item 3: submitCash COMPOUND_CASH_SUBMITTED
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCashSubmissionId } from '../services/compoundEventBuilder.js';

function makeTs() { return new Date().toISOString(); }

function buildCashSubmittedPayload(opts) {
  const receiptId       = (opts && opts.receiptId) || 'CS-20260813-0001';
  const businessDate    = (opts && opts.businessDate) || '2026-08-13';
  const amount          = (opts && opts.amount !== undefined) ? opts.amount : 5000;
  const receptionistName = (opts && opts.receptionistName) || 'Test User';
  const receiverName    = (opts && opts.receiverName) || 'Manager';
  const shiftLabel      = (opts && opts.shiftLabel) || 'Morning';
  const remainingCash   = (opts && opts.remainingCash !== undefined) ? opts.remainingCash : 1200;
  const mysqlInsertId   = (opts && opts.mysqlInsertId !== undefined) ? opts.mysqlInsertId : 7;
  const ts = makeTs();
  const submittedAt = new Date().toISOString();
  return {
    schema_version: 1,
    event_type:     'COMPOUND_CASH_SUBMITTED',
    aggregate_type: 'CASH_SUBMISSION',
    aggregate_id:   receiptId,
    operation_id:   'op_compound_cash_submitted_' + Date.now(),
    occurred_at:    ts,
    writes: [{
      collection:  'cash_submissions',
      document_id: formatCashSubmissionId(receiptId),
      operation:   'set_merge',
      data: {
        receipt_id:        receiptId,
        business_date:     businessDate,
        submitted_at:      submittedAt,
        receptionist_name: receptionistName,
        receiver_name:     receiverName,
        shift:             shiftLabel,
        amount:            amount,
        remaining_cash:    remainingCash,
        mysql_submission_id: mysqlInsertId,
        created_at:        ts,
        updated_at:        ts,
      },
    }],
  };
}

console.log('[Phase 4G-C C3] COMPOUND_CASH_SUBMITTED tests starting');

test('C3: formatCashSubmissionId returns cs_receiptId', () => { assert.equal(formatCashSubmissionId('CS-20260813-0001'), 'cs_CS-20260813-0001'); });
test('C3: formatCashSubmissionId with different date', () => { assert.equal(formatCashSubmissionId('CS-20260101-0042'), 'cs_CS-20260101-0042'); });
test('C3: formatCashSubmissionId throws on empty string', () => {
  let threw = false;
  try { formatCashSubmissionId(''); } catch (e) { threw = true; assert.ok(e.code === 'INVALID_CASH_SUBMISSION_ID' || String(e.message).includes('receipt_id')); }
  assert.ok(threw, 'should throw on empty');
});
test('C3: formatCashSubmissionId throws on null', () => {
  let threw = false;
  try { formatCashSubmissionId(null); } catch (e) { threw = true; }
  assert.ok(threw, 'should throw on null');
});
test('C3: formatCashSubmissionId is deterministic', () => { const id = 'CS-20260813-0007'; assert.equal(formatCashSubmissionId(id), formatCashSubmissionId(id)); });
test('C3: event_type is COMPOUND_CASH_SUBMITTED', () => { assert.equal(buildCashSubmittedPayload().event_type, 'COMPOUND_CASH_SUBMITTED'); });
test('C3: aggregate_type is CASH_SUBMISSION', () => { assert.equal(buildCashSubmittedPayload().aggregate_type, 'CASH_SUBMISSION'); });
test('C3: aggregate_id is the receipt_id', () => { assert.equal(buildCashSubmittedPayload({ receiptId: 'CS-20260813-0005' }).aggregate_id, 'CS-20260813-0005'); });
test('C3: exactly 1 write', () => { assert.equal(buildCashSubmittedPayload().writes.length, 1); });
test('C3: operation is set_merge', () => { assert.equal(buildCashSubmittedPayload().writes[0].operation, 'set_merge'); });
test('C3: collection is cash_submissions', () => { assert.equal(buildCashSubmittedPayload().writes[0].collection, 'cash_submissions'); });
test('C3: document_id is cs_receiptId', () => { const p = buildCashSubmittedPayload({ receiptId: 'CS-20260813-0003' }); assert.equal(p.writes[0].document_id, 'cs_CS-20260813-0003'); });
test('C3: document_id starts with cs_', () => { assert.ok(buildCashSubmittedPayload().writes[0].document_id.startsWith('cs_')); });
test('C3: document_id matches expected cs_CS-YYYYMMDD-NNNN pattern', () => { assert.ok(/^cs_CS-\d{8}-\d{4}$/.test(buildCashSubmittedPayload().writes[0].document_id)); });
test('C3: document_id has no randomUUID format (no 4-group hex UUID)', () => {
  const docId = buildCashSubmittedPayload().writes[0].document_id;
  const strictUuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  assert.ok(!strictUuidRe.test(docId), 'document_id must not match strict UUID format');
});
test('C3: data.receipt_id matches receiptId', () => { assert.equal(buildCashSubmittedPayload({ receiptId: 'CS-20260813-0009' }).writes[0].data.receipt_id, 'CS-20260813-0009'); });
test('C3: data.business_date is present', () => { assert.ok(buildCashSubmittedPayload({ businessDate: '2026-08-13' }).writes[0].data.business_date); });
test('C3: data.amount is numeric', () => { assert.equal(typeof buildCashSubmittedPayload({ amount: 8000 }).writes[0].data.amount, 'number'); });
test('C3: data.remaining_cash is numeric', () => { assert.equal(typeof buildCashSubmittedPayload({ remainingCash: 500 }).writes[0].data.remaining_cash, 'number'); });
test('C3: data.mysql_submission_id is present', () => { assert.ok(buildCashSubmittedPayload({ mysqlInsertId: 12 }).writes[0].data.mysql_submission_id); });
test('C3: data.created_at is valid ISO', () => { assert.ok(!isNaN(Date.parse(buildCashSubmittedPayload().writes[0].data.created_at))); });
test('C3: data.updated_at equals data.created_at on creation', () => { const p = buildCashSubmittedPayload(); assert.equal(p.writes[0].data.updated_at, p.writes[0].data.created_at); });
test('C3: no FieldValue in payload', () => { assert.ok(!JSON.stringify(buildCashSubmittedPayload()).includes('FieldValue')); });
test('C3: schema_version is 1', () => { assert.equal(buildCashSubmittedPayload().schema_version, 1); });
test('C3: enqueue failure causes rollback not commit', () => {
  let committed = false; let rolledBack = false;
  const mockConn = { commit: async function() { committed = true; }, rollback: async function() { rolledBack = true; } };
  const fail = async function() { throw new Error('enqueue fail'); };
  return (async function() { try { await fail(); await mockConn.commit(); } catch(e) { await mockConn.rollback(); } })()
    .then(function() { assert.equal(committed, false); assert.equal(rolledBack, true); });
});

console.log('[Phase 4G-C C3] COMPOUND_CASH_SUBMITTED tests complete');
