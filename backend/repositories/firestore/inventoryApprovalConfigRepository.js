/**
 * inventoryApprovalConfigRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase C — which roles may approve inventory purchase requests.
 *
 * Stored as ONE document in the EXISTING `settings` collection
 * (settings/inventory_pr_approval) — no new collection — following the same
 * shape as systemSettingsRepository's hotel_config: defaults merged over the
 * stored doc, a TTL cache, and an explicit invalidator on write.
 *
 *   settings/inventory_pr_approval
 *     { enabled: boolean, allowed_roles: string[], updated_at, updated_by }
 *
 * FAIL-SAFE: if the document is missing, unreadable or malformed, the config
 * collapses to DEFAULT_PR_APPROVER_ROLES (administrators only). It never
 * widens to "anyone", and it never inherits the Phase B REQUEST role set —
 * raising a request must never imply the right to approve one.
 *
 * Role names are the NORMALIZED ones produced by
 * authController.normalizeUserRole (admin, super_admin, receptionist,
 * kitchen, housekeeper), so this configuration plugs directly into the
 * existing RBAC vocabulary rather than inventing a parallel one.
 */

import { getDoc, setDoc, RepositoryError } from './firestoreUtils.js';
import { globalTtlCache } from '../../utils/ttlCache.js';
import { DEFAULT_PR_APPROVER_ROLES, VALID_APPROVER_ROLES } from '../../utils/inventoryConstants.js';

const COLLECTION = 'settings';
export const PR_APPROVAL_CONFIG_DOC_ID = 'inventory_pr_approval';
const CACHE_KEY = 'inventory_pr_approval_config';

export const DEFAULT_PR_APPROVAL_CONFIG = Object.freeze({
  enabled: true,
  allowed_roles: [...DEFAULT_PR_APPROVER_ROLES]
});

export function invalidateInventoryApprovalConfigCache() {
  globalTtlCache.delete(CACHE_KEY);
}

/** Coerces whatever is stored into a safe, well-formed config. */
function normalizeConfig(doc) {
  const safe = { ...DEFAULT_PR_APPROVAL_CONFIG };
  if (!doc || typeof doc !== 'object') return { ...safe, source: 'default' };

  if (typeof doc.enabled === 'boolean') safe.enabled = doc.enabled;

  if (Array.isArray(doc.allowed_roles)) {
    const roles = doc.allowed_roles
      .filter(r => typeof r === 'string' && r.trim())
      .map(r => r.trim().toLowerCase());
    // An empty or all-garbage list must not silently disable authorization;
    // fall back to the administrator-only default instead.
    safe.allowed_roles = roles.length > 0 ? [...new Set(roles)] : [...DEFAULT_PR_APPROVER_ROLES];
  }

  return { ...safe, source: 'settings' };
}

/**
 * Reads the approval configuration. Never throws — a Firestore failure
 * degrades to the administrator-only default so approvals stay locked down
 * rather than opening up.
 */
export async function getInventoryApprovalConfigFirestore(options = {}) {
  const { transaction = null, skipCache = false } = options;

  const load = async () => {
    try {
      const doc = await getDoc(COLLECTION, PR_APPROVAL_CONFIG_DOC_ID, options);
      return normalizeConfig(doc);
    } catch (err) {
      console.warn(`[InventoryApprovalConfig] falling back to defaults: ${err.message}`);
      return { ...DEFAULT_PR_APPROVAL_CONFIG, source: 'default-on-error' };
    }
  };

  if (transaction || skipCache) return await load();
  return await globalTtlCache.getOrSet(CACHE_KEY, load, 600000); // 10 minutes
}

/**
 * Writes the configuration. Not exposed through any Phase C route — the
 * document is managed by an administrator directly (or by a later phase's
 * settings screen); this exists so tooling and tests use one code path.
 */
/**
 * Validates an incoming configuration payload. Rejects unknown or arbitrary
 * role strings so a client can never grant itself (or anyone) a privilege that
 * is not part of the defined role vocabulary, de-duplicates, and refuses an
 * empty approver list while approvals are enabled (which would leave requests
 * permanently un-approvable).
 *
 * Only `enabled` and `allowed_roles` are ever accepted — any other field a
 * client sends is dropped, so privileged fields cannot be injected.
 *
 * @returns {{ enabled: boolean, allowed_roles: string[] }}
 */
export function validateApprovalConfigPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RepositoryError('A configuration object is required.', 'INVALID_APPROVAL_CONFIG', 400);
  }
  if (input.enabled === undefined || typeof input.enabled !== 'boolean') {
    throw new RepositoryError('`enabled` must be true or false.', 'INVALID_APPROVAL_CONFIG', 400);
  }
  if (!Array.isArray(input.allowed_roles)) {
    throw new RepositoryError('`allowed_roles` must be an array of role names.', 'INVALID_APPROVAL_CONFIG', 400);
  }

  const seen = new Set();
  const roles = [];
  for (const raw of input.allowed_roles) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new RepositoryError('Each allowed role must be a non-empty string.', 'INVALID_APPROVAL_CONFIG', 400);
    }
    const role = raw.trim().toLowerCase();
    if (!VALID_APPROVER_ROLES.includes(role)) {
      throw new RepositoryError(
        `Unknown role '${raw}'. Allowed roles are: ${VALID_APPROVER_ROLES.join(', ')}.`,
        'INVALID_APPROVER_ROLE', 400
      );
    }
    if (seen.has(role)) continue;   // duplicates collapse deterministically
    seen.add(role);
    roles.push(role);
  }

  if (input.enabled === true && roles.length === 0) {
    throw new RepositoryError(
      'At least one approver role is required while approvals are enabled.',
      'APPROVER_ROLES_REQUIRED', 400
    );
  }

  return { enabled: input.enabled, allowed_roles: roles };
}

/**
 * Writes the configuration. The payload is validated first, so the document is
 * either fully replaced with a valid configuration or not written at all —
 * there is no partial update.
 */
export async function updateInventoryApprovalConfigFirestore(configData, options = {}) {
  const validated = validateApprovalConfigPayload(configData);

  const payload = {
    enabled: validated.enabled,
    allowed_roles: validated.allowed_roles,
    updated_at: new Date().toISOString()
  };
  if (configData.updated_by) payload.updated_by = String(configData.updated_by);
  if (configData.updated_by_role) payload.updated_by_role = String(configData.updated_by_role);

  const result = await setDoc(COLLECTION, PR_APPROVAL_CONFIG_DOC_ID, payload, { ...options, merge: true });
  // Immediate invalidation: a stale cache would keep notifications and
  // approval checks targeting the OLD role list for up to the TTL.
  invalidateInventoryApprovalConfigCache();
  return { ...payload };
}

/** True when `normalizedRole` may approve, given the supplied config. */
export function roleCanApprove(config, normalizedRole) {
  if (!config || config.enabled === false) return false;
  if (!normalizedRole) return false;
  return (config.allowed_roles || []).includes(String(normalizedRole).toLowerCase());
}
