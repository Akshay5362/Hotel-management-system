import {
  getDoc,
  listDocs,
  setDoc,
  validateRequiredFields
} from './firestoreUtils.js';

const COLLECTION = 'cash_submissions';

export async function getCashSubmissionByIdFirestore(id, options = {}) {
  if (!id) return null;
  const docId = String(id).startsWith('cash_sub_') ? String(id) : `cash_sub_${id}`;
  return await getDoc(COLLECTION, docId, options);
}

export async function getAllCashSubmissionsFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'created_at', direction: 'desc' }], limit = 50, cursor = null, transaction = null } = options;
  return await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

export async function createCashSubmissionFirestore(subData, options = {}) {
  validateRequiredFields(subData, ['amount', 'user_id'], 'CashSubmission');

  const subId = subData.sub_id || `cash_sub_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  const payload = {
    sub_id: subId,
    amount: Number(subData.amount),
    user_id: String(subData.user_id),
    staff_name: subData.staff_name || '',
    shift: subData.shift || 'General',
    notes: subData.notes || '',
    business_date: subData.business_date || new Date().toISOString().split('T')[0],
    mysql_submission_id: subData.mysql_submission_id || subData.id || null,
    created_at: new Date().toISOString()
  };

  return await setDoc(COLLECTION, subId, payload, { ...options, merge: true });
}
