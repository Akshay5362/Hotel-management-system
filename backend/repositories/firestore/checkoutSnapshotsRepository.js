import {
  getDoc,
  setDoc,
  formatBookingId,
  validateRequiredFields
} from './firestoreUtils.js';

const COLLECTION = 'checkout_snapshots';

export async function getCheckoutSnapshotByBookingFirestore(bookingId, options = {}) {
  if (!bookingId) return null;
  const parentId = String(bookingId).startsWith('bkg_') ? String(bookingId) : formatBookingId(bookingId);
  const docId = `snap_${parentId}`;
  return await getDoc(COLLECTION, docId, options);
}

export async function createCheckoutSnapshotFirestore(snapshotData, options = {}) {
  validateRequiredFields(snapshotData, ['booking_id', 'snapshot_data'], 'CheckoutSnapshot');

  const parentId = String(snapshotData.booking_id).startsWith('bkg_') ? String(snapshotData.booking_id) : formatBookingId(snapshotData.booking_id);
  const docId = `snap_${parentId}`;

  const payload = {
    snapshot_id: docId,
    booking_id: parentId,
    mysql_booking_id: snapshotData.mysql_booking_id || null,
    snapshot_data: snapshotData.snapshot_data,
    created_at: new Date().toISOString()
  };

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}
