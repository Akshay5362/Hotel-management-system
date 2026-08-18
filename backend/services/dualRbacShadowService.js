/**
 * dualRbacShadowService.js — Asynchronous Non-Blocking Dual-RBAC Shadow Verifier
 * ==============================================================================
 * Performs background comparison of MySQL authorization decisions against Firestore
 * RBAC without altering live request processing or delaying API responses.
 *
 * SAFETY RULES:
 *  - Shadow Only: MySQL remains 100% authoritative for all live requests.
 *  - Non-blocking: Runs asynchronously in a safe try/catch wrapper.
 *  - Read-Only: Zero writes to Firestore or MySQL.
 *  - Zero credential leaks: Never logs tokens, passwords, or secrets.
 */

import { isDualRbacShadowEnabled } from '../config/featureFlags.js';
import { hasFirestorePermission, getPermissionsForRoleFirestore } from '../repositories/firestore/rbacRepository.js';

/**
 * Format clean user identifier for shadow logging
 */
function resolveUserIdentifier(user) {
  if (!user) return 'anonymous';
  if (user.type === 'staff') return `staff_${user.id}`;
  if (user.role === 'guest') return `guest_${user.id}`;
  return `user_${user.id}`;
}

/**
 * Execute asynchronous shadow verification comparing MySQL allowed decision against Firestore
 * @param {object} req Express request object
 * @param {string} permissionName Permission or action name being evaluated
 * @param {boolean} mysqlAllowed Actual MySQL authorization result (true/false)
 */
export async function executeShadowRbacVerification(req, permissionName, mysqlAllowed) {
  if (!isDualRbacShadowEnabled()) {
    return;
  }

  // Asynchronous non-blocking wrapper using setImmediate
  setImmediate(async () => {
    const userIdentifier = resolveUserIdentifier(req?.user);
    const roleName = (req?.user?.role || '').toLowerCase().trim();

    try {
      if (!roleName) {
        console.log(`[SHADOW_RBAC_ERROR] user=${userIdentifier} permission=${permissionName} error=Missing user role in request context`);
        return;
      }

      // Query Firestore RBAC repository for permission
      const firestoreAllowed = await hasFirestorePermission(roleName, permissionName);
      const match = (Boolean(mysqlAllowed) === Boolean(firestoreAllowed));

      if (match) {
        console.log(`[SHADOW_RBAC_MATCH] user=${userIdentifier} role=${roleName} permission=${permissionName} mysql=${mysqlAllowed} firestore=${firestoreAllowed}`);
      } else {
        console.warn(`[SHADOW_RBAC_MISMATCH] user=${userIdentifier} role=${roleName} permission=${permissionName} mysql=${mysqlAllowed} firestore=${firestoreAllowed}`);
      }
    } catch (err) {
      console.error(`[SHADOW_RBAC_ERROR] user=${userIdentifier} permission=${permissionName} error=${err?.message || 'Unknown shadow error'}`);
    }
  });
}
