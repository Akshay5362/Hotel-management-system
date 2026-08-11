import {
  getDoc,
  listDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  formatInvoiceId,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'invoices';

export async function getInvoiceByIdFirestore(invId, options = {}) {
  if (!invId) return null;
  const docId = String(invId).startsWith('inv_') ? String(invId) : formatInvoiceId(invId);
  return await getDoc(COLLECTION, docId, options);
}

export async function getInvoiceByNumberFirestore(invNumber, options = {}) {
  if (!invNumber) return null;
  const results = await listDocs(COLLECTION, {
    filters: [{ field: 'invoice_number', op: '==', value: String(invNumber) }],
    limit: 1,
    transaction: options.transaction
  });
  return results[0] || null;
}

export async function getAllInvoicesFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'created_at', direction: 'desc' }], limit = 50, cursor = null, transaction = null } = options;
  return await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

export async function createInvoiceFirestore(invData, options = {}) {
  validateRequiredFields(invData, ['invoice_number', 'booking_id', 'total_amount'], 'Invoice');

  const docId = formatInvoiceId(invData.invoice_number);

  const existing = await getDoc(COLLECTION, docId, options);
  if (existing) {
    throw new RepositoryError(`Invoice '${invData.invoice_number}' already exists`, 'DUPLICATE_KEY', 400);
  }

  const payload = {
    invoice_number: String(invData.invoice_number),
    booking_id: String(invData.booking_id),
    mysql_booking_id: invData.mysql_booking_id || null,
    guest_name: invData.guest_name || '',
    room_number: invData.room_number || '',
    total_amount: Number(invData.total_amount),
    tax_amount: Number(invData.tax_amount || 0),
    paid_amount: Number(invData.paid_amount || 0),
    outstanding_amount: Number(invData.outstanding_amount || 0),
    invoice_status: invData.invoice_status || 'Issued',
    business_date: invData.business_date || new Date().toISOString().split('T')[0],
    mysql_invoice_id: invData.mysql_invoice_id || invData.id || null,
    created_at: new Date().toISOString()
  };

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function updateInvoiceFirestore(invId, invData, options = {}) {
  if (!invId) throw new RepositoryError('Invoice ID is required for update', 'VALIDATION_ERROR', 400);
  const docId = String(invId).startsWith('inv_') ? String(invId) : formatInvoiceId(invId);

  const existing = await getDoc(COLLECTION, docId, options);
  if (!existing) {
    throw new RepositoryError(`Invoice '${invId}' not found`, 'NOT_FOUND', 404);
  }

  return await updateDoc(COLLECTION, docId, invData, options);
}

export async function deleteInvoiceFirestore(invId, options = {}) {
  if (!invId) throw new RepositoryError('Invoice ID is required for deletion', 'VALIDATION_ERROR', 400);
  const docId = String(invId).startsWith('inv_') ? String(invId) : formatInvoiceId(invId);
  return await deleteDoc(COLLECTION, docId, options);
}
