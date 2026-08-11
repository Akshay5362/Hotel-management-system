import {
  getDoc,
  listDocs,
  setDoc,
  deleteDoc,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'audit_logs';

export async function getAuditLogByIdFirestore(logId, options = {}) {
  if (!logId) return null;
  const docId = String(logId).startsWith('audit_') ? String(logId) : `audit_${logId}`;
  return await getDoc(COLLECTION, docId, options);
}

export async function getAllAuditLogsFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'created_at', direction: 'desc' }], limit = 100, cursor = null, transaction = null } = options;
  return await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

export async function createAuditLogFirestore(logData, options = {}) {
  validateRequiredFields(logData, ['action', 'details'], 'AuditLog');

  const rawId = logData.mysql_audit_id || logData.id || logData.log_id || Date.now();
  const docId = String(rawId).startsWith('audit_') ? String(rawId) : `audit_${rawId}`;

  const payload = {
    log_id: docId,
    user_id: logData.user_id ? String(logData.user_id) : null,
    mysql_user_id: logData.mysql_user_id || logData.user_id || null,
    action: String(logData.action),
    details: typeof logData.details === 'object' ? JSON.stringify(logData.details) : String(logData.details),
    business_date: logData.business_date || new Date().toISOString().split('T')[0],
    mysql_audit_id: logData.mysql_audit_id || logData.id || null,
    created_at: logData.created_at || new Date().toISOString()
  };

  // Security sanitization - strip any password/secret if present
  delete payload.password;
  delete payload.password_hash;
  delete payload.token;

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function deleteAuditLogFirestore(logId, options = {}) {
  if (!logId) throw new RepositoryError('Audit log ID is required for deletion', 'VALIDATION_ERROR', 400);
  const docId = String(logId).startsWith('audit_') ? String(logId) : `audit_${logId}`;
  return await deleteDoc(COLLECTION, docId, options);
}
