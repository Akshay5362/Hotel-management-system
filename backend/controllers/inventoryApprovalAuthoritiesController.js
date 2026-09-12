/**
 * inventoryApprovalAuthoritiesController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H1 — administrator management of WhatsApp approval authorities.
 *
 * An authority record says "this staff member can be SENT a purchase-request
 * approval, at this number". It does not say "this staff member may approve".
 * That remains `roleCanApprove()` against settings/inventory_pr_approval,
 * evaluated at decision time by purchaseRequestApprovalService, which this
 * phase does not touch.
 *
 * WHY THE ROLE IS CHECKED HERE BUT NOT STORED
 * A write is refused when the staff member's current role is not one the
 * approval configuration permits — configuring a notification for someone who
 * could never act on it is a mistake worth catching early. The role is NOT
 * copied into the document: the configuration may widen or narrow later, and a
 * frozen copy would answer with yesterday's permissions. The stored record is
 * reachability; the live configuration is authority.
 *
 * Routes are mounted behind INVENTORY_ROLES.MANAGE (admin, super_admin), so a
 * receptionist, chef, kitchen helper, pantry boy or cleaner cannot reach them
 * and cannot self-register.
 */

import { getActor, sendError, auditInventory } from './inventoryController.js';
import { normalizeUserRole } from './authController.js';
import { getStaffByUidFirestore } from '../repositories/firestore/staffRepository.js';
import {
  getInventoryApprovalConfigFirestore,
  roleCanApprove
} from '../repositories/firestore/inventoryApprovalConfigRepository.js';
import {
  getApprovalAuthorityByUidFirestore,
  listApprovalAuthoritiesFirestore,
  upsertApprovalAuthorityFirestore,
  setApprovalAuthorityActiveFirestore,
  maskWhatsAppNumber
} from '../repositories/firestore/inventoryApprovalAuthoritiesRepository.js';

/** The staff-record shape HPMS uses for "this person is still employed here". */
function isStaffActive(staff) {
  if (!staff) return false;
  if (staff.deleted === true || staff.deleted === 1 || staff.is_deleted === true || staff.is_deleted === 1 || staff.deleted_at) return false;
  if (staff.is_active === false || staff.is_active === 0 || staff.active === false || staff.active === 0) return false;
  if (staff.status === 'Inactive' || staff.status === 'Disabled' || staff.status === 'Deleted') return false;
  return true;
}

/**
 * Resolves the staff member behind a uid and refuses anything that could not
 * legitimately act on an approval. Exactly one staff read.
 */
async function resolveEligibleStaff(userUid) {
  const staff = await getStaffByUidFirestore(userUid);
  if (!staff) {
    return { error: { message: `No staff member found for user_uid '${userUid}'.`, code: 'STAFF_NOT_FOUND', status: 404 } };
  }
  if (!isStaffActive(staff)) {
    return { error: { message: `Staff member '${staff.full_name || userUid}' is not active.`, code: 'STAFF_INACTIVE', status: 409 } };
  }
  if (!staff.user_uid) {
    return { error: { message: `Staff member '${staff.full_name || userUid}' has no linked user_uid and cannot be an approval authority.`, code: 'STAFF_UID_MISSING', status: 409 } };
  }

  const role = normalizeUserRole({ ...staff, type: 'staff' });
  const config = await getInventoryApprovalConfigFirestore();
  if (!roleCanApprove(config, role)) {
    return {
      error: {
        message: `Role '${role || 'unknown'}' is not currently permitted to approve purchase requests, so it cannot be an approval authority.`,
        code: 'ROLE_NOT_APPROVER',
        status: 409
      }
    };
  }
  return { staff, role };
}

function reply(res, err) {
  return res.status(err.status || 400).json({ error: err.message, code: err.code });
}

/** GET /api/inventory/approval-authorities */
export const getApprovalAuthorities = async (req, res) => {
  try {
    const includeInactive = String(req.query.include_inactive) === 'true';
    const authorities = await listApprovalAuthoritiesFirestore({ includeInactive });
    return res.json({ authorities, count: authorities.length });
  } catch (error) {
    return sendError(res, error, 'Failed to load approval authorities');
  }
};

/** GET /api/inventory/approval-authorities/:uid */
export const getApprovalAuthorityByUid = async (req, res) => {
  try {
    const authority = await getApprovalAuthorityByUidFirestore(req.params.uid);
    if (!authority) {
      return res.status(404).json({ error: 'Approval authority not found.', code: 'AUTHORITY_NOT_FOUND' });
    }
    return res.json({ authority });
  } catch (error) {
    return sendError(res, error, 'Failed to load the approval authority');
  }
};

/**
 * PUT /api/inventory/approval-authorities/:uid
 *
 * Create or update, keyed by uid, so a repeated call updates one record rather
 * than creating a second. PUT rather than POST for exactly that reason.
 */
export const upsertApprovalAuthority = async (req, res) => {
  try {
    const userUid = String(req.params.uid || '').trim();
    const body = req.body || {};

    // Self-registration is not a thing: an administrator configures who may be
    // notified, including themselves, but the route is admin-gated either way.
    const { staff, error } = await resolveEligibleStaff(userUid);
    if (error) return reply(res, error);

    const actor = getActor(req);
    const result = await upsertApprovalAuthorityFirestore({
      user_uid: staff.user_uid,
      display_name: body.display_name || staff.full_name || staff.username,
      // `undefined` means "leave whatever is stored alone"; null clears it.
      ...(body.whatsapp_e164 !== undefined ? { whatsapp_e164: body.whatsapp_e164 } : {}),
      ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
      actor_uid: actor.uid
    });

    await auditInventory(
      req,
      result.created ? 'INVENTORY_APPROVAL_AUTHORITY_CREATED' : 'INVENTORY_APPROVAL_AUTHORITY_UPDATED',
      {
        user_uid: result.authority.user_uid,
        display_name: result.authority.display_name,
        // Never the full number.
        whatsapp_masked: maskWhatsAppNumber(result.authority.whatsapp_e164),
        number_changed: result.number_changed,
        is_active: result.authority.is_active
      }
    );

    return res.status(result.created ? 201 : 200).json({
      message: result.created ? 'Approval authority created.' : 'Approval authority updated.',
      created: result.created,
      authority: result.authority
    });
  } catch (error) {
    return sendError(res, error, 'Failed to save the approval authority');
  }
};

/** POST /api/inventory/approval-authorities/:uid/activate */
export const activateApprovalAuthority = async (req, res) => {
  try {
    const actor = getActor(req);
    // Reactivating re-checks eligibility; a role revoked in the meantime must
    // not be restored by flipping a flag.
    const { error } = await resolveEligibleStaff(String(req.params.uid || '').trim());
    if (error) return reply(res, error);

    const authority = await setApprovalAuthorityActiveFirestore(req.params.uid, true, actor.uid);
    await auditInventory(req, 'INVENTORY_APPROVAL_AUTHORITY_ACTIVATED', {
      user_uid: authority.user_uid,
      display_name: authority.display_name
    });
    return res.json({ message: 'Approval authority activated.', authority });
  } catch (error) {
    return sendError(res, error, 'Failed to activate the approval authority');
  }
};

/**
 * POST /api/inventory/approval-authorities/:uid/deactivate
 *
 * Soft only. The record is retained so the trail of who was once an approval
 * authority survives, and deactivation deliberately does not re-check staff
 * eligibility — switching someone off must always be possible.
 */
export const deactivateApprovalAuthority = async (req, res) => {
  try {
    const actor = getActor(req);
    const authority = await setApprovalAuthorityActiveFirestore(req.params.uid, false, actor.uid);
    await auditInventory(req, 'INVENTORY_APPROVAL_AUTHORITY_DEACTIVATED', {
      user_uid: authority.user_uid,
      display_name: authority.display_name
    });
    return res.json({ message: 'Approval authority deactivated.', authority });
  } catch (error) {
    return sendError(res, error, 'Failed to deactivate the approval authority');
  }
};
