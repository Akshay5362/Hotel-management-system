/**
 * dualReadVerificationService.js — Asynchronous Read Shadow Comparison Service
 * ==============================================================================
 * Non-blocking service to compare MySQL authoritative read results against
 * Firestore shadow reads. Logs matches, mismatches, or errors without impacting
 * HTTP responses or database authority.
 */

import { isDualReadShadowEnabled } from '../config/featureFlags.js';

function normalizeItem(item) {
  if (!item || typeof item !== 'object') return item;
  const copy = Array.isArray(item) ? [] : {};
  for (const key of Object.keys(item)) {
    if (key.startsWith('_') || key === 'updated_at' || key === 'created_at' || key === 'firestore_id') continue;
    let val = item[key];
    if (val instanceof Date) val = val.toISOString();
    if (typeof val === 'number') val = Number(val);
    copy[key] = val;
  }
  return copy;
}

export async function executeShadowReadComparison(resourceName, mysqlResult, fetchFirestoreFn) {
  if (!isDualReadShadowEnabled()) return;

  setImmediate(async () => {
    try {
      const firestoreResult = await fetchFirestoreFn();
      
      const mysqlArr = Array.isArray(mysqlResult) ? mysqlResult : [mysqlResult];
      const firestoreArr = Array.isArray(firestoreResult) ? firestoreResult : [firestoreResult];

      const countMatch = mysqlArr.length === firestoreArr.length;
      let fieldMismatchCount = 0;
      const sampleMismatches = [];

      if (!countMatch) {
        sampleMismatches.push(`Count mismatch: MySQL count = ${mysqlArr.length}, Firestore count = ${firestoreArr.length}`);
      } else if (mysqlArr.length > 0) {
        for (let i = 0; i < Math.min(mysqlArr.length, 10); i++) {
          const m = normalizeItem(mysqlArr[i]);
          const f = normalizeItem(firestoreArr[i]);

          for (const key of Object.keys(m)) {
            if (f[key] !== undefined && String(m[key]) !== String(f[key])) {
              fieldMismatchCount++;
              if (sampleMismatches.length < 5) {
                sampleMismatches.push(`Field '${key}' mismatch at index ${i}: MySQL='${m[key]}' vs Firestore='${f[key]}'`);
              }
            }
          }
        }
      }

      if (countMatch && fieldMismatchCount === 0) {
        console.log(`[SHADOW_READ_MATCH] resource=${resourceName} mysqlCount=${mysqlArr.length} firestoreCount=${firestoreArr.length}`);
      } else {
        console.warn(`[SHADOW_READ_MISMATCH] resource=${resourceName} countMatch=${countMatch} fieldMismatches=${fieldMismatchCount} details=${sampleMismatches.join(' | ')}`);
      }
    } catch (error) {
      console.error(`[SHADOW_READ_ERROR] resource=${resourceName} error=${error.message}`);
    }
  });
}

export async function executeReadCanary({
  flagCheckFn,
  endpointName,
  fetchFirestoreFn,
  validateAndFormatFn,
  timeoutMs = 500
}) {
  if (!flagCheckFn || !flagCheckFn()) return null;

  try {
    const firestorePromise = fetchFirestoreFn();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('FIRESTORE_CANARY_TIMEOUT')), timeoutMs)
    );

    const rawResult = await Promise.race([firestorePromise, timeoutPromise]);
    const formattedResult = validateAndFormatFn(rawResult);

    if (formattedResult !== null && formattedResult !== undefined) {
      const count = Array.isArray(formattedResult) ? formattedResult.length : (typeof formattedResult === 'object' ? Object.keys(formattedResult).length : 1);
      console.log(`[FIRESTORE_READ_CANARY_SUCCESS] endpoint=${endpointName} count=${count}`);
      return formattedResult;
    } else {
      console.warn(`[FIRESTORE_READ_CANARY_MISMATCH] endpoint=${endpointName} Validation guard returned null. Falling back to MySQL.`);
      return null;
    }
  } catch (err) {
    console.warn(`[FIRESTORE_READ_CANARY_FALLBACK] endpoint=${endpointName} reason=${err.message}. Falling back to MySQL.`);
    return null;
  }
}
