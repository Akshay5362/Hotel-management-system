/**
 * dualRbacShadowMiddleware.js — Decommissioned Shadow Middleware (No-Op)
 * =======================================================================
 * Preserved for backwards compatibility. Safely invokes next().
 */

export function dualRbacShadowMiddleware() {
  return (req, res, next) => {
    next();
  };
}

export default dualRbacShadowMiddleware;
