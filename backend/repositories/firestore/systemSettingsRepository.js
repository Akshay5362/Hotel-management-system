import {
  getDoc,
  setDoc,
  updateDoc,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'settings';
const SYSTEM_DATE_DOC_ID = 'system_date';

/**
 * Checks whether an incoming payload is stale compared to the existing Firestore document.
 */
function isStaleUpdate(existingDoc, incomingData) {
  if (!existingDoc || !existingDoc.updated_at || !incomingData || !incomingData.updated_at) {
    return false;
  }
  const existingTime = new Date(existingDoc.updated_at).getTime();
  const incomingTime = new Date(incomingData.updated_at).getTime();
  return !isNaN(existingTime) && !isNaN(incomingTime) && existingTime > incomingTime;
}

export async function getSystemSettingsFirestore(settingId = 'system_date', options = {}) {
  return await getDoc(COLLECTION, String(settingId), options);
}

export async function getSystemDateFirestore(options = {}) {
  const doc = await getDoc(COLLECTION, SYSTEM_DATE_DOC_ID, options);
  if (!doc) {
    const today = new Date().toISOString().split('T')[0];
    const defaultData = {
      current_date: today,
      today_checkins: 0,
      today_checkouts: 0,
      continued_rooms: 0,
      day_end_status: 'IDLE',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await setDoc(COLLECTION, SYSTEM_DATE_DOC_ID, defaultData, options);
    return today;
  }
  return doc.current_date || doc.system_date || new Date().toISOString().split('T')[0];
}

export async function updateSystemDateFirestore(nextDateStr, options = {}) {
  const dateVal = typeof nextDateStr === 'object' && nextDateStr !== null
    ? (nextDateStr.current_date || nextDateStr.system_date)
    : nextDateStr;

  if (!dateVal || typeof dateVal !== 'string') {
    throw new RepositoryError('Valid next date string (YYYY-MM-DD) is required', 'VALIDATION_ERROR', 400);
  }

  const existing = await getDoc(COLLECTION, SYSTEM_DATE_DOC_ID, options);
  const incomingTime = typeof nextDateStr === 'object' && nextDateStr.updated_at ? nextDateStr.updated_at : new Date().toISOString();
  const payload = {
    current_date: dateVal,
    system_date: dateVal,
    updated_at: incomingTime
  };

  if (existing && isStaleUpdate(existing, payload)) {
    console.log(`[OutboxGuard] Ignored stale system_date update for ${SYSTEM_DATE_DOC_ID}`);
    return existing;
  }

  return await setDoc(COLLECTION, SYSTEM_DATE_DOC_ID, payload, { ...options, merge: true });
}

export async function updateSystemSettingFirestore(settingId, settingData, options = {}) {
  if (!settingId) throw new RepositoryError('Setting ID is required', 'VALIDATION_ERROR', 400);
  const docId = String(settingId);
  const existing = await getDoc(COLLECTION, docId, options);

  const payload = typeof settingData === 'object' && settingData !== null ? { ...settingData } : { value: settingData };
  payload.updated_at = payload.updated_at || new Date().toISOString();

  if (existing && isStaleUpdate(existing, payload)) {
    console.log(`[OutboxGuard] Ignored stale system setting update for ${docId}`);
    return existing;
  }

  return await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
}
