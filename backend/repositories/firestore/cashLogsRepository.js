import {
  getDoc,
  listDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'cash_logs';

export async function getCashLogByIdFirestore(logId, options = {}) {
  if (!logId) return null;
  const docId = String(logId).startsWith('cash_log_') ? String(logId) : `cash_log_${logId}`;
  return await getDoc(COLLECTION, docId, options);
}

export async function getAllCashLogsFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'created_at', direction: 'desc' }], limit = 50, cursor = null, transaction = null } = options;
  return await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

export async function createCashLogFirestore(cashData, options = {}) {
  validateRequiredFields(cashData, ['amount', 'type'], 'CashLog');

  const logId = cashData.log_id || `cash_log_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  const payload = {
    log_id: logId,
    amount: Number(cashData.amount),
    type: String(cashData.type), // 'IN' or 'OUT'
    category: cashData.category || 'General',
    description: cashData.description || '',
    user_id: cashData.user_id ? String(cashData.user_id) : null,
    mysql_user_id: cashData.mysql_user_id || null,
    booking_id: cashData.booking_id ? String(cashData.booking_id) : null,
    business_date: cashData.business_date || new Date().toISOString().split('T')[0],
    mysql_cash_log_id: cashData.mysql_cash_log_id || cashData.id || null,
    created_at: new Date().toISOString()
  };

  return await setDoc(COLLECTION, logId, payload, { ...options, merge: true });
}

export async function updateCashLogFirestore(logId, cashData, options = {}) {
  if (!logId) throw new RepositoryError('Cash log ID is required for update', 'VALIDATION_ERROR', 400);
  const docId = String(logId).startsWith('cash_log_') ? String(logId) : `cash_log_${logId}`;
  return await updateDoc(COLLECTION, docId, cashData, options);
}
