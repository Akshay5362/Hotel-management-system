import {
  getDoc,
  setDoc,
  updateDoc,
  RepositoryError
} from './firestoreUtils.js';

import { globalTtlCache } from '../../utils/ttlCache.js';

const COLLECTION = 'settings';
const SYSTEM_DATE_DOC_ID = 'system_date';

/**
 * Invalidate cached system date / settings immediately upon mutation.
 */
export function invalidateSystemDateCache() {
  globalTtlCache.deleteByPrefix('system_date');
  globalTtlCache.deleteByPrefix('system_settings');
  globalTtlCache.deleteByPrefix('room_status_');
}

/**
 * Invalidate cached hotel config immediately upon mutation.
 */
export function invalidateHotelConfigCache() {
  globalTtlCache.delete('hotel_config');
}

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
  const { transaction = null, skipCache = false } = options;
  const keyStr = String(settingId);

  if (transaction || skipCache) {
    return await getDoc(COLLECTION, keyStr, options);
  }

  return await globalTtlCache.getOrSet(
    `system_settings_${keyStr}`,
    () => getDoc(COLLECTION, keyStr, options),
    60000 // 60 seconds TTL
  );
}

export async function getSystemDateFirestore(options = {}) {
  const { transaction = null, skipCache = false } = options;

  if (transaction || skipCache) {
    const doc = await getDoc(COLLECTION, SYSTEM_DATE_DOC_ID, options);
    if (!doc) return null;
    return doc.current_date || doc.system_date || null;
  }

  return await globalTtlCache.getOrSet(
    'system_date_current',
    async () => {
      const doc = await getDoc(COLLECTION, SYSTEM_DATE_DOC_ID, options);
      if (!doc) return null;
      return doc.current_date || doc.system_date || null;
    },
    60000 // 60 seconds TTL
  );
}

export async function getSystemDateDetailsFirestore(options = {}) {
  const { transaction = null, skipCache = false } = options;

  if (transaction || skipCache) {
    const doc = await getDoc(COLLECTION, SYSTEM_DATE_DOC_ID, options);
    if (!doc) return null;
    return {
      current_date: doc.current_date || doc.system_date || null,
      system_date: doc.system_date || doc.current_date || null,
      today_checkins: Number(doc.today_checkins || 0),
      today_checkouts: Number(doc.today_checkouts || 0),
      continued_rooms: Number(doc.continued_rooms || 0),
      day_end_status: doc.day_end_status || 'IDLE',
      updated_at: doc.updated_at || null,
      created_at: doc.created_at || null
    };
  }

  return await globalTtlCache.getOrSet(
    'system_date_details',
    async () => {
      const doc = await getDoc(COLLECTION, SYSTEM_DATE_DOC_ID, options);
      if (!doc) return null;
      return {
        current_date: doc.current_date || doc.system_date || null,
        system_date: doc.system_date || doc.current_date || null,
        today_checkins: Number(doc.today_checkins || 0),
        today_checkouts: Number(doc.today_checkouts || 0),
        continued_rooms: Number(doc.continued_rooms || 0),
        day_end_status: doc.day_end_status || 'IDLE',
        updated_at: doc.updated_at || null,
        created_at: doc.created_at || null
      };
    },
    60000 // 60 seconds TTL
  );
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

  const result = await setDoc(COLLECTION, SYSTEM_DATE_DOC_ID, payload, { ...options, merge: true });
  invalidateSystemDateCache();
  return result;
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

  const result = await setDoc(COLLECTION, docId, payload, { ...options, merge: true });
  invalidateSystemDateCache();
  return result;
}

export const DEFAULT_HOTEL_CONFIG = {
  name: 'HOTEL SKY-5',
  hotel_name: 'HOTEL SKY-5',
  address: 'DISHA ARCADE, I.T PARK ROAD, SECTOR 4, MDC, PANCHKULA-134114',
  phone: '+91 8146470934',
  mobile: '+91 8146470934',
  email: 'Hotelsky71@gmail.com',
  gstin: '06AANFH0310B1Z5',
  state: 'Haryana',
  state_code: '06',
  hotel_reg_no: '9610',
  tax_rate: 0.05,
  terms_and_conditions: '1. Standard check-in time is 12:00 PM and check-out time is 11:00 AM.\n2. Valid government photo ID is mandatory at the time of check-in.\n3. Outside food and beverages are not allowed inside hotel premises.\n4. Disputes are subject to local jurisdiction only.',
  cancellation_policy: 'Cancellations made 24 hours prior to check-in will receive a full refund. Cancellations made within 24 hours are non-refundable.'
};

export async function getHotelConfigFirestore(options = {}) {
  const { transaction = null, skipCache = false } = options;

  if (transaction || skipCache) {
    try {
      const doc = await getDoc(COLLECTION, 'hotel_config', options);
      if (doc) return { ...DEFAULT_HOTEL_CONFIG, ...doc };
      return { ...DEFAULT_HOTEL_CONFIG };
    } catch (err) {
      console.warn('[getHotelConfigFirestore] Warning reading hotel_config:', err.message);
      return { ...DEFAULT_HOTEL_CONFIG };
    }
  }

  return await globalTtlCache.getOrSet(
    'hotel_config',
    async () => {
      try {
        const doc = await getDoc(COLLECTION, 'hotel_config', options);
        if (doc) return { ...DEFAULT_HOTEL_CONFIG, ...doc };
        return { ...DEFAULT_HOTEL_CONFIG };
      } catch (err) {
        console.warn('[getHotelConfigFirestore] Warning reading hotel_config:', err.message);
        return { ...DEFAULT_HOTEL_CONFIG };
      }
    },
    600000 // 10 minutes TTL
  );
}

export async function updateHotelConfigFirestore(configData, options = {}) {
  if (!configData || typeof configData !== 'object') {
    throw new RepositoryError('Valid config data object is required', 'VALIDATION_ERROR', 400);
  }
  const payload = {
    ...configData,
    updated_at: new Date().toISOString()
  };
  const result = await setDoc(COLLECTION, 'hotel_config', payload, { ...options, merge: true });
  invalidateHotelConfigCache();
  return result;
}

