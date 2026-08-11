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
  const parentId = String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId);
  const rawId = String(bookingId).replace(/^bkg_/, '');

  // 1. Query root collection by booking_id or mysql_booking_id
  const rootByDocId = await listDocs(COLLECTION, {
    filters: [{ field: 'booking_id', op: '==', value: parentId }],
    transaction: options.transaction
  });

  const rootByRawId = await listDocs(COLLECTION, {
    filters: [{ field: 'booking_id', op: '==', value: rawId }],
    transaction: options.transaction
  });

  const rootByMysqlId = !isNaN(Number(rawId))
    ? await listDocs(COLLECTION, {
        filters: [{ field: 'mysql_booking_id', op: '==', value: Number(rawId) }],
        transaction: options.transaction
      })
    : [];

  // 2. Query subcollection
  const subDocs = await listDocs(PARENT_COLLECTION, {
    parentDocId: parentId,
    subcollectionName: COLLECTION,
    transaction: options.transaction
  });

  const map = new Map();
  [...rootByDocId, ...rootByRawId, ...rootByMysqlId, ...subDocs].forEach(item => {
    if (item && item.id) {
      // Normalize description field from legacy 'desc'
      item.description = item.description || item.desc || '';
      item.qty = item.qty !== undefined ? item.qty : (item.quantity !== undefined ? item.quantity : 1);
      map.set(item.id, item);
    }
  });

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
    type: itemData.type || 'CHARGE',
    status: itemData.status || 'Pending',
    business_date: itemData.business_date || new Date().toISOString().split('T')[0],
    mysql_ledger_id: itemData.mysql_ledger_id || itemData.id || null,
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
