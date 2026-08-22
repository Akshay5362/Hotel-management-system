import {
  getDoc,
  listDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  formatBookingId,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'ledger_items';
const PARENT_COLLECTION = 'bookings';

export async function getLedgerItemByIdFirestore(itemId, options = {}) {
  if (!itemId) return null;
  const docId = String(itemId).startsWith('ledger_') ? String(itemId) : `ledger_${itemId}`;

  const rootDoc = await getDoc(COLLECTION, docId, options);
  if (rootDoc) return rootDoc;

  const { bookingId } = options;
  if (bookingId) {
    const parentId = String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId);
    return await getDoc(PARENT_COLLECTION, parentId, {
      ...options,
      subcollectionName: COLLECTION,
      subDocId: docId
    });
  }

  return null;
}

export async function getLedgerItemsByBookingFirestore(bookingId, options = {}) {
  if (!bookingId) return [];
  const strId = String(bookingId).trim();
  const rawId = strId.replace(/^(booking_|bkg_)/, '');
  const bookingNumber = rawId.startsWith('BKG-') ? rawId : `BKG-${rawId}`;

  const queryIds = Array.from(new Set([
    strId,
    rawId,
    `booking_${rawId}`,
    `bkg_${rawId}`,
    `booking_${bookingNumber}`,
    `bkg_${bookingNumber}`,
    bookingNumber,
    formatBookingId(strId)
  ]));

  const map = new Map();

  for (const idVal of queryIds) {
    const rootByBookingId = await listDocs(COLLECTION, {
      filters: [{ field: 'booking_id', op: '==', value: idVal }],
      transaction: options.transaction
    });
    rootByBookingId.forEach(item => {
      if (item && item.id) {
        item.description = item.description || item.desc || '';
        item.qty = item.qty !== undefined ? item.qty : (item.quantity !== undefined ? item.quantity : 1);
        map.set(item.id, item);
      }
    });

    const rootByBookingNumber = await listDocs(COLLECTION, {
      filters: [{ field: 'booking_number', op: '==', value: idVal }],
      transaction: options.transaction
    });
    rootByBookingNumber.forEach(item => {
      if (item && item.id) {
        item.description = item.description || item.desc || '';
        item.qty = item.qty !== undefined ? item.qty : (item.quantity !== undefined ? item.quantity : 1);
        map.set(item.id, item);
      }
    });

    if (!isNaN(Number(idVal))) {
      const rootByMysql = await listDocs(COLLECTION, {
        filters: [{ field: 'mysql_booking_id', op: '==', value: Number(idVal) }],
        transaction: options.transaction
      });
      rootByMysql.forEach(item => {
        if (item && item.id) {
          item.description = item.description || item.desc || '';
          item.qty = item.qty !== undefined ? item.qty : (item.quantity !== undefined ? item.quantity : 1);
          map.set(item.id, item);
        }
      });
    }
  }

  // Also query subcollections if parent booking exists
  for (const pId of queryIds) {
    try {
      const subDocs = await listDocs(PARENT_COLLECTION, {
        parentDocId: pId,
        subcollectionName: COLLECTION,
        transaction: options.transaction
      });
      subDocs.forEach(item => {
        if (item && item.id) {
          item.description = item.description || item.desc || '';
          item.qty = item.qty !== undefined ? item.qty : (item.quantity !== undefined ? item.quantity : 1);
          map.set(item.id, item);
        }
      });
    } catch (_) {}
  }

  return Array.from(map.values()).sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
}

export async function getAllLedgerItemsFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'created_at', direction: 'desc' }], limit = 100, cursor = null, transaction = null } = options;
  const results = await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
  return results.map(item => ({
    ...item,
    description: item.description || item.desc || '',
    qty: item.qty !== undefined ? item.qty : (item.quantity !== undefined ? item.quantity : 1)
  }));
}

export async function createLedgerItemFirestore(itemData, options = {}) {
  validateRequiredFields(itemData, ['amount'], 'LedgerItem');
  const descriptionStr = itemData.description || itemData.desc || 'Folio Charge';

  const itemId = itemData.item_id || `ledger_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const bookingId = itemData.booking_id;
  const parentId = bookingId ? (String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId)) : null;

  const payload = {
    item_id: itemId,
    booking_id: parentId,
    mysql_booking_id: itemData.mysql_booking_id || (bookingId && !isNaN(Number(bookingId)) ? Number(bookingId) : null),
    room_number: itemData.room_number || '',
    description: descriptionStr,
    desc: descriptionStr, // Preserved for legacy schema compatibility
    qty: Number(itemData.qty || itemData.quantity || 1),
    quantity: Number(itemData.quantity || itemData.qty || 1),
    amount: Number(itemData.amount),
    type: itemData.type || itemData.transaction_type || 'CHARGE',
    status: itemData.status || 'Pending',
    business_date: itemData.business_date || new Date().toISOString().split('T')[0],
    mysql_ledger_id: itemData.mysql_ledger_id || itemData.id || null,
    // ── New fields (Phase D) ────────────────────────────────────────────────
    transaction_type: itemData.transaction_type || 'CHARGE',
    credit_amount:    Number(itemData.credit_amount || 0),
    payment_mode:     itemData.payment_mode || null,
    time_of_entry:    itemData.time_of_entry || null,
    created_by:       itemData.created_by    || null,
    created_at: itemData.created_at || new Date().toISOString()
  };

  await setDoc(COLLECTION, itemId, payload, { ...options, merge: true });

  if (parentId) {
    await setDoc(PARENT_COLLECTION, parentId, payload, {
      ...options,
      subcollectionName: COLLECTION,
      subDocId: itemId,
      merge: true
    });
  }

  return { id: itemId, ...payload };
}

export async function updateLedgerItemFirestore(itemId, itemData, options = {}) {
  if (!itemId) throw new RepositoryError('Ledger Item ID is required for update', 'VALIDATION_ERROR', 400);

  const docId = String(itemId).startsWith('ledger_') ? String(itemId) : `ledger_${itemId}`;

  const { bookingId } = options;
  if (bookingId) {
    const parentId = String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId);
    await updateDoc(PARENT_COLLECTION, parentId, itemData, {
      ...options,
      subcollectionName: COLLECTION,
      subDocId: docId
    });
  }

  return await updateDoc(COLLECTION, docId, itemData, options);
}

export async function deleteLedgerItemFirestore(itemId, options = {}) {
  if (!itemId) throw new RepositoryError('Ledger Item ID is required for deletion', 'VALIDATION_ERROR', 400);

  const docId = String(itemId).startsWith('ledger_') ? String(itemId) : `ledger_${itemId}`;

  const { bookingId } = options;
  if (bookingId) {
    const parentId = String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId);
    await deleteDoc(PARENT_COLLECTION, parentId, {
      ...options,
      subcollectionName: COLLECTION,
      subDocId: docId
    });
  }

  return await deleteDoc(COLLECTION, docId, options);
}
