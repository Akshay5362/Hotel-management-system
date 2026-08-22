import {
  getDoc,
  listDocs,
  setDoc,
  deleteDoc,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'notifications';

export function formatNotificationId(id) {
  if (!id) return null;
  const str = String(id).trim();
  if (str.startsWith('notif_') || str.startsWith('notification_')) return str;
  return `notif_${str}`;
}

export async function getNotificationByIdFirestore(notificationId, options = {}) {
  if (!notificationId) return null;
  const docId = formatNotificationId(notificationId);
  return await getDoc(COLLECTION, docId, options);
}

export async function getNotificationsByUserFirestore(userId, options = {}) {
  if (!userId) return [];
  const { onlyUnread = false, limit = 50, transaction = null } = options;
  const userIdStr = String(userId);
  const rawId = userIdStr.replace(/^user_/, '');

  const byUserId = await listDocs(COLLECTION, {
    filters: [{ field: 'user_id', op: '==', value: userIdStr }],
    transaction
  });

  let byRawId = [];
  if (rawId !== userIdStr) {
    byRawId = await listDocs(COLLECTION, {
      filters: [{ field: 'user_id', op: '==', value: rawId }],
      transaction
    });
  }

  let byMysqlId = [];
  if (!isNaN(Number(rawId))) {
    byMysqlId = await listDocs(COLLECTION, {
      filters: [{ field: 'mysql_user_id', op: '==', value: Number(rawId) }],
      transaction
    });
  }

  const map = new Map();
  [...byUserId, ...byRawId, ...byMysqlId].forEach(item => {
    if (item && item.id) {
      if (onlyUnread && (item.is_read === true || item.is_read === 1 || item.is_read === '1')) {
        return;
      }
      map.set(item.id, item);
    }
  });

  return Array.from(map.values())
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .slice(0, limit);
}

export async function getAllNotificationsFirestore(options = {}) {
  const { filters = [], orderBy = [{ field: 'created_at', direction: 'desc' }], limit = 100, cursor = null, transaction = null } = options;
  return await listDocs(COLLECTION, {
    filters,
    orderBy,
    limit,
    startAfterDoc: cursor,
    transaction
  });
}

export async function createNotificationFirestore(data, options = {}) {
  validateRequiredFields(data, ['title', 'message'], 'Notification');

  const rawId = data.mysql_notification_id || data.id || data.notification_id || Date.now();
  const docId = formatNotificationId(rawId);

  const userIdVal = data.user_id ? String(data.user_id) : null;
  const isReadBool = data.is_read === true || data.is_read === 1 || data.is_read === '1';

  const payload = {
    notification_id: docId,
    user_id: userIdVal,
    mysql_user_id: data.mysql_user_id || (userIdVal && !isNaN(Number(userIdVal.replace(/^user_/, ''))) ? Number(userIdVal.replace(/^user_/, '')) : null),
    title: String(data.title),
    message: String(data.message),
    is_read: isReadBool,
    type: data.type || 'general',
    mysql_notification_id: data.mysql_notification_id || (data.id && !isNaN(Number(data.id)) ? Number(data.id) : null),
    created_at: data.created_at || new Date().toISOString(),
    read_at: isReadBool ? (data.read_at || new Date().toISOString()) : null
  };

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function updateNotificationFirestore(notificationId, updateData, options = {}) {
  if (!notificationId) throw new RepositoryError('Notification ID is required for update', 'VALIDATION_ERROR', 400);
  const docId = formatNotificationId(notificationId);

  const payload = { ...updateData };
  if (payload.is_read === true || payload.is_read === 1 || payload.is_read === '1') {
    payload.is_read = true;
    if (!payload.read_at) payload.read_at = new Date().toISOString();
  }

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}

export async function markNotificationReadFirestore(notificationId, options = {}) {
  return await updateNotificationFirestore(notificationId, { is_read: true }, options);
}

export async function deleteNotificationFirestore(notificationId, options = {}) {
  if (!notificationId) throw new RepositoryError('Notification ID is required for deletion', 'VALIDATION_ERROR', 400);
  const docId = formatNotificationId(notificationId);
  return await deleteDoc(COLLECTION, docId, options);
}
