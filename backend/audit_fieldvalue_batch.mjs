import { db } from '../backend/config/firebaseAdmin.js';
import { FieldValue } from 'firebase-admin/firestore';

// AUDIT ONLY — verify FieldValue.increment() API surface within WriteBatch
// NO batch.commit() is called. Zero Firestore writes are made.

async function verifyBatchFieldValue() {
  console.log('[FieldValueAudit] Testing WriteBatch API surface...\n');

  const testRef = db.collection('_audit_scratch_').doc('_never_committed_');

  // Test 1: batch.set() + FieldValue.increment()
  const batch1 = db.batch();
  try {
    batch1.set(testRef, { counter: FieldValue.increment(1), name: 'test' }, { merge: true });
    console.log('✅ TEST 1 PASS: batch.set(ref, { counter: FieldValue.increment(1) }, { merge: true }) — VALID API');
  } catch (e) {
    console.error('❌ TEST 1 FAIL:', e.message);
  }

  // Test 2: batch.update() + FieldValue.increment()
  const batch2 = db.batch();
  try {
    batch2.update(testRef, { counter: FieldValue.increment(1) });
    console.log('✅ TEST 2 PASS: batch.update(ref, { counter: FieldValue.increment(1) }) — VALID API');
  } catch (e) {
    console.error('❌ TEST 2 FAIL:', e.message);
  }

  // Test 3: Mixed — FieldValue.increment() + regular fields in same batch
  const batch3 = db.batch();
  try {
    const ref2 = db.collection('_audit_scratch_').doc('_another_never_committed_');
    batch3.set(testRef, { counter: FieldValue.increment(1), status: 'active' }, { merge: true });
    batch3.set(ref2, { name: 'other_doc', updated_at: new Date().toISOString() }, { merge: true });
    console.log('✅ TEST 3 PASS: Mixed FieldValue.increment() + regular fields across multiple docs in same batch — VALID API');
  } catch (e) {
    console.error('❌ TEST 3 FAIL:', e.message);
  }

  console.log('\n[FieldValueAudit] All tests completed. batch.commit() was NOT called. Zero Firestore writes made.');
  process.exit(0);
}

verifyBatchFieldValue();
