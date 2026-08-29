/**
 * backend/services/factoryResetCutoverService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HPMS Production Firestore Factory Reset Cutover Service
 *
 * Enforces:
 *   - Pure Cloud Firestore execution via FirestoreFactoryResetService
 *   - Strict fail-closed isolation if Firestore Factory Reset is disabled
 *   - Absolute prohibition of silent fallback to MySQL
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { isFirestoreFactoryResetEnabled } from '../config/featureFlags.js';
import { FirestoreFactoryResetService } from './firestoreFactoryResetService.js';

export class FactoryResetCutoverService {
  /**
   * Status / preflight check (read-only count verification).
   */
  static async verifyReset() {
    if (!isFirestoreFactoryResetEnabled()) {
      const err = new Error('FACTORY_RESET_NOT_AVAILABLE: Firestore Factory Reset is currently disabled (USE_FIRESTORE_FACTORY_RESET=false). Fallback to legacy database is strictly prohibited.');
      err.status = 503;
      err.code = 'FIRESTORE_FACTORY_RESET_DISABLED';
      throw err;
    }

    return await FirestoreFactoryResetService.verifyReset();
  }

  /**
   * Full factory reset execution against authoritative Firestore.
   */
  static async factoryReset(operatorId = 'system') {
    if (!isFirestoreFactoryResetEnabled()) {
      const err = new Error('FACTORY_RESET_NOT_AVAILABLE: Firestore Factory Reset is currently disabled (USE_FIRESTORE_FACTORY_RESET=false). Fallback to legacy database is strictly prohibited.');
      err.status = 503;
      err.code = 'FIRESTORE_FACTORY_RESET_DISABLED';
      throw err;
    }

    try {
      return await FirestoreFactoryResetService.factoryReset(operatorId);
    } catch (err) {
      console.error('[FactoryResetCutover] Firestore factoryReset error:', err.message);
      // Fail closed — NEVER fall back to legacy MySQL database
      throw err;
    }
  }
}

