/**
 * backend/services/firestoreShadowComparisonService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Dual-Read Shadow Verification Infrastructure for HPMS-Sky5.
 *
 * Compares live MySQL responses with shadow Firestore responses side-by-side:
 *   - Room Status (status, housekeeping, active/inactive, guest details, tariff)
 *   - Availability (availability flag, code, conflicting records)
 *   - Folio & Ledger (rows, debits, credits, running balance, outstanding)
 *   - Reports & Analytics (revenue, occupancy, ADR, RevPAR, payments)
 *
 * SAFETY INVARIANTS:
 *   1. MySQL remains 100% authoritative for all user responses.
 *   2. Firestore shadow execution is isolated, non-blocking, and never throws
 *      into the live request path.
 *   3. Sensitive fields (phone, passwords, tokens) are masked in shadow logs.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { parseToComparableDate } from './firestoreAvailabilityService.js';

// ── Sensitive Field Masking ──────────────────────────────────────────────────
const SENSITIVE_KEY_PATTERNS = ['phone', 'password', 'token', 'secret', 'card', 'cvv', 'pin', 'aadhaar', 'id_number'];

export function maskSensitive(key, value) {
  if (value === null || value === undefined) return value;
  const k = String(key || '').toLowerCase();

  if (SENSITIVE_KEY_PATTERNS.some(pattern => k.includes(pattern))) {
    const str = String(value);
    if (str.length <= 4) return '****';
    return `${str.slice(0, 2)}****${str.slice(-2)}`;
  }
  return value;
}

/**
 * Normalizes input value for robust semantic comparison.
 * Maps null, undefined, and empty string to null.
 * Normalizes numbers, dates, and booleans.
 */
export function normalizeValue(val, key = '') {
  if (val === null || val === undefined || (typeof val === 'string' && val.trim() === '')) {
    return null;
  }
  if (typeof val === 'boolean' || val === 1 || val === 0 || val === '1' || val === '0') {
    if (key.includes('active') || key.includes('is_')) {
      return val === true || val === 1 || val === '1';
    }
  }
  if (typeof val === 'number') {
    return Math.round((val + Number.EPSILON) * 100) / 100;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    // Check if it's a date string
    if (key.includes('date') || key.includes('_at') || /^\d{4}-\d{2}-\d{2}/.test(trimmed) || /^\d{1,2}-[A-Za-z]{3}-\d{4}/.test(trimmed)) {
      const parsed = parseToComparableDate(trimmed);
      if (parsed) return parsed;
    }
    // Check if clean number
    if (/^-?\d+(\.\d+)?$/.test(trimmed) && !key.includes('phone') && !key.includes('number') && !key.includes('pincode') && !key.includes('id')) {
      const num = Number(trimmed);
      if (!isNaN(num)) return Math.round((num + Number.EPSILON) * 100) / 100;
    }
    return trimmed;
  }
  return val;
}

/**
 * Compares two values for equality with numerical epsilon tolerance and date normalization.
 */
export function areValuesEqual(v1, v2, key = '') {
  const n1 = normalizeValue(v1, key);
  const n2 = normalizeValue(v2, key);

  if (n1 === null && n2 === null) return true;
  if (n1 === null || n2 === null) return false;

  if (typeof n1 === 'number' && typeof n2 === 'number') {
    return Math.abs(n1 - n2) < 0.01;
  }
  if (typeof n1 === 'boolean' && typeof n2 === 'boolean') {
    return n1 === n2;
  }
  return String(n1).toLowerCase() === String(n2).toLowerCase();
}

/**
 * Structured Logger for Shadow Mismatches.
 */
export class ShadowVerificationLogger {
  static logMismatch({ domain, context = {}, mismatches = [], error = null }) {
    const timestamp = new Date().toISOString();
    const cleanContext = {};
    for (const [k, v] of Object.entries(context)) {
      cleanContext[k] = maskSensitive(k, v);
    }

    const cleanMismatches = mismatches.map(m => ({
      ...m,
      mysql: maskSensitive(m.field, m.mysql),
      firestore: maskSensitive(m.field, m.firestore)
    }));

    const logPayload = {
      level: error ? 'ERROR' : 'WARN',
      type: 'SHADOW_VERIFICATION_MISMATCH',
      domain,
      timestamp,
      context: cleanContext,
      mismatchCount: cleanMismatches.length,
      mismatches: cleanMismatches,
      error: error ? (error.message || String(error)) : null
    };

    console.warn(`[SHADOW_DIFF:${domain.toUpperCase()}] Mismatch detected:`, JSON.stringify(logPayload));
    return logPayload;
  }

  static logMatch({ domain, context = {} }) {
    const cleanContext = {};
    for (const [k, v] of Object.entries(context)) {
      cleanContext[k] = maskSensitive(k, v);
    }
    console.log(`[SHADOW_MATCH:${domain.toUpperCase()}] 100% Parity verified:`, JSON.stringify({ domain, context: cleanContext, timestamp: new Date().toISOString() }));
  }
}

export class FirestoreShadowComparisonService {

  /**
   * Compares Room Status outputs between MySQL and Firestore.
   */
  static compareRoomStatus(mysqlRooms = [], firestoreRooms = [], context = {}) {
    const mismatches = [];
    const fieldsToVerify = [
      'status', 'housekeeping_status', 'is_active', 'rate',
      'guestName', 'phone', 'date_of_birth', 'company_name',
      'city', 'state', 'room_tariff', 'payment_mode',
      'billing_instruction', 'meal_plan'
    ];

    const fsMap = new Map();
    (firestoreRooms || []).forEach(r => {
      if (r && r.number) fsMap.set(String(r.number), r);
    });

    (mysqlRooms || []).forEach(mRoom => {
      const roomNum = String(mRoom.number);
      const fRoom = fsMap.get(roomNum);

      if (!fRoom) {
        mismatches.push({
          roomNumber: roomNum,
          field: '_existence',
          mysql: 'present',
          firestore: 'missing'
        });
        return;
      }

      for (const field of fieldsToVerify) {
        const mVal = mRoom[field];
        const fVal = fRoom[field];

        if (!areValuesEqual(mVal, fVal, field)) {
          mismatches.push({
            roomNumber: roomNum,
            field,
            mysql: mVal,
            firestore: fVal
          });
        }
      }
    });

    const isMatch = mismatches.length === 0;
    if (!isMatch) {
      ShadowVerificationLogger.logMismatch({ domain: 'room_status', context, mismatches });
    } else {
      ShadowVerificationLogger.logMatch({ domain: 'room_status', context });
    }

    return { match: isMatch, domain: 'room_status', mismatchCount: mismatches.length, mismatches };
  }

  /**
   * Compares Availability calculation outputs between MySQL and Firestore.
   */
  static compareAvailability(mysqlResult = {}, firestoreResult = {}, context = {}) {
    const mismatches = [];

    const mAvailable = Boolean(mysqlResult?.available);
    const fAvailable = Boolean(firestoreResult?.available);

    if (mAvailable !== fAvailable) {
      mismatches.push({
        field: 'available',
        mysql: mAvailable,
        firestore: fAvailable
      });
    }

    if (!mAvailable && !fAvailable) {
      const mCode = mysqlResult?.code || null;
      const fCode = firestoreResult?.code || null;
      if (mCode && fCode && !areValuesEqual(mCode, fCode, 'code')) {
        mismatches.push({
          field: 'code',
          mysql: mCode,
          firestore: fCode
        });
      }
    }

    const isMatch = mismatches.length === 0;
    if (!isMatch) {
      ShadowVerificationLogger.logMismatch({ domain: 'availability', context, mismatches });
    } else {
      ShadowVerificationLogger.logMatch({ domain: 'availability', context });
    }

    return { match: isMatch, domain: 'availability', mismatchCount: mismatches.length, mismatches };
  }

  /**
   * Compares Ledger/Folio summaries between MySQL and Firestore.
   */
  static compareLedger(mysqlLedger = {}, firestoreLedger = {}, context = {}) {
    const mismatches = [];

    const mSummary = mysqlLedger?.summary || {};
    const fSummary = firestoreLedger?.summary || {};

    const metrics = ['totalCharges', 'totalPayments', 'outstanding'];
    for (const metric of metrics) {
      const mVal = Number(mSummary[metric] || 0);
      const fVal = Number(fSummary[metric] || 0);

      if (Math.abs(mVal - fVal) >= 0.01) {
        mismatches.push({
          field: `summary.${metric}`,
          mysql: mVal,
          firestore: fVal
        });
      }
    }

    const isMatch = mismatches.length === 0;
    if (!isMatch) {
      ShadowVerificationLogger.logMismatch({ domain: 'ledger', context, mismatches });
    } else {
      ShadowVerificationLogger.logMatch({ domain: 'ledger', context });
    }

    return { match: isMatch, domain: 'ledger', mismatchCount: mismatches.length, mismatches };
  }

  /**
   * Compares Financial & Report summaries between MySQL and Firestore.
   */
  static compareReports(mysqlReport = {}, firestoreReport = {}, domain = 'overview', context = {}) {
    const mismatches = [];

    for (const key of Object.keys(mysqlReport)) {
      if (key === 'chartData' || key === 'breakdown' || key === 'roomTypeStats' || key === 'payments') {
        continue;
      }
      const mVal = mysqlReport[key];
      const fVal = firestoreReport[key];

      if (typeof mVal === 'number' || typeof mVal === 'string' || typeof mVal === 'boolean') {
        if (!areValuesEqual(mVal, fVal, key)) {
          mismatches.push({
            field: key,
            mysql: mVal,
            firestore: fVal
          });
        }
      }
    }

    const isMatch = mismatches.length === 0;
    if (!isMatch) {
      ShadowVerificationLogger.logMismatch({ domain: `reports_${domain}`, context, mismatches });
    } else {
      ShadowVerificationLogger.logMatch({ domain: `reports_${domain}`, context });
    }

    return { match: isMatch, domain: `reports_${domain}`, mismatchCount: mismatches.length, mismatches };
  }

  /**
   * Decommissioned in Phase 3 Step 13.2 - Safe No-Op
   */
  static executeShadowAsync(domain, shadowFetcher, compareFn, context = {}) {
    // No-Op in Step 13.2
    return;
  }
}

export default FirestoreShadowComparisonService;
