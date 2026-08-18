/**
 * dualRbacShadowMiddleware.js — Express Middleware Wrapper for Dual-RBAC Shadow Verification
 * =========================================================================================
 * Non-blocking middleware wrapper that triggers asynchronous shadow RBAC comparison.
 * Never interrupts request flow, never returns HTTP errors, and leaves MySQL 100% authoritative.
 */

import { executeShadowRbacVerification } from '../services/dualRbacShadowService.js';
import { hasPermission } from '../controllers/authController.js';

/**
 * Express middleware helper to evaluate permission against MySQL and trigger shadow check
 * @param {string} permissionName
 */
export function dualRbacShadowMiddleware(permissionName) {
  return async (req, res, next) => {
    try {
      // Evaluate MySQL permission result (ground truth)
      const mysqlAllowed = await hasPermission(req, permissionName);

      // Trigger background shadow check asynchronously
      executeShadowRbacVerification(req, permissionName, mysqlAllowed);

      // Store in req context for downstream controllers if needed
      req.shadowRbacEvaluated = true;
    } catch (err) {
      // Never fail the request if shadow evaluation encounters an issue
    }

    next();
  };
}
