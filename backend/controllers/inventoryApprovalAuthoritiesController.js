/**
 * inventoryApprovalAuthoritiesController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H1, reshaped in Phase H6 — administrator management of EXTERNAL
 * WhatsApp approval authorities.
 *
 * An authority is a person who approves over WhatsApp and never logs into
 * HPMS. Nothing here looks them up as staff, checks a role for them, or gives
 * them a login. What an administrator can do: register a name and a number,
 * request a one-time code to hand over in person, activate once the number is
 * verified, deactivate, revoke, and change the number.
 *
 * WHAT THIS LAYER IS
 * Thin. Every rule lives in whatsappAuthorityVerificationService, which owns
 * the state machine and the audit trail. This file parses the request, calls
 * the service, and answers.
 *
 * Routes are mounted behind INVENTORY_ROLES.MANAGE (admin, super_admin), so no
 * other staff role can reach them, and there is no self-service route at all —
 * the authority's only interaction with the system is over WhatsApp.
 *
 * The one-time code is returned ONCE, from the challenge route, to the
 * administrator who asked for it. It is never stored in plaintext and never
 * appears again.
 */

import { getActor, sendError } from './inventoryController.js';
import {
  getApprovalAuthorityByIdFirestore,
  listApprovalAuthoritiesFirestore
} from '../repositories/firestore/inventoryApprovalAuthoritiesRepository.js';
import {
  registerApprovalAuthority,
  updateApprovalAuthorityDisplay,
  issueVerificationChallenge,
  revokeApprovalAuthorityVerification as revokeVerificationService,
  changeApprovalAuthorityNumber,
  activateApprovalAuthority as activateAuthorityService,
  deactivateApprovalAuthority as deactivateAuthorityService
} from '../services/whatsappAuthorityVerificationService.js';

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

/** GET /api/inventory/approval-authorities/:authorityId */
export const getApprovalAuthorityById = async (req, res) => {
  try {
    const authority = await getApprovalAuthorityByIdFirestore(req.params.authorityId);
    if (!authority) {
      return res.status(404).json({ error: 'Approval authority not found.', code: 'AUTHORITY_NOT_FOUND' });
    }
    return res.json({ authority });
  } catch (error) {
    return sendError(res, error, 'Failed to load the approval authority');
  }
};

/**
 * POST /api/inventory/approval-authorities   { display_name, whatsapp_e164, linked_staff_uid? }
 * Creates an EXTERNAL authority, PENDING_VERIFICATION and inactive.
 */
export const createApprovalAuthority = async (req, res) => {
  try {
    const body = req.body || {};
    const { authority, warnings } = await registerApprovalAuthority({
      display_name: body.display_name,
      whatsapp_e164: body.whatsapp_e164,
      linked_staff_uid: body.linked_staff_uid ?? null,
      actor: getActor(req)
    });
    return res.status(201).json({ message: 'Approval authority registered; verification pending.', authority, warnings });
  } catch (error) {
    return sendError(res, error, 'Failed to register the approval authority');
  }
};

/** PATCH /api/inventory/approval-authorities/:authorityId   { display_name?, linked_staff_uid? } */
export const updateApprovalAuthority = async (req, res) => {
  try {
    const body = req.body || {};
    const { authority, warnings } = await updateApprovalAuthorityDisplay({
      authority_id: req.params.authorityId,
      display_name: body.display_name,
      linked_staff_uid: body.linked_staff_uid,
      actor: getActor(req)
    });
    return res.json({ message: 'Approval authority updated.', authority, warnings });
  } catch (error) {
    return sendError(res, error, 'Failed to update the approval authority');
  }
};

/**
 * POST /api/inventory/approval-authorities/:authorityId/verification-challenge
 * Returns the one-time code EXACTLY ONCE, to this administrator.
 */
export const issueApprovalAuthorityVerificationChallenge = async (req, res) => {
  try {
    const challenge = await issueVerificationChallenge({
      authority_id: req.params.authorityId,
      actor: getActor(req)
    });
    return res.status(201).json({ message: 'Verification code issued. Hand it to the authority out of band.', ...challenge });
  } catch (error) {
    return sendError(res, error, 'Failed to issue a verification challenge');
  }
};

/** POST /api/inventory/approval-authorities/:authorityId/activate — refused unless verified and current. */
export const activateApprovalAuthority = async (req, res) => {
  try {
    const authority = await activateAuthorityService({ authority_id: req.params.authorityId, actor: getActor(req) });
    return res.json({ message: 'Approval authority activated.', authority });
  } catch (error) {
    return sendError(res, error, 'Failed to activate the approval authority');
  }
};

/** POST /api/inventory/approval-authorities/:authorityId/deactivate — always allowed. */
export const deactivateApprovalAuthority = async (req, res) => {
  try {
    const authority = await deactivateAuthorityService({ authority_id: req.params.authorityId, actor: getActor(req) });
    return res.json({ message: 'Approval authority deactivated.', authority });
  } catch (error) {
    return sendError(res, error, 'Failed to deactivate the approval authority');
  }
};

/** POST /api/inventory/approval-authorities/:authorityId/revoke-verification */
export const revokeApprovalAuthorityVerification = async (req, res) => {
  try {
    const authority = await revokeVerificationService({ authority_id: req.params.authorityId, actor: getActor(req) });
    return res.json({ message: 'WhatsApp verification revoked; the authority is inactive until re-verified.', authority });
  } catch (error) {
    return sendError(res, error, 'Failed to revoke the verification');
  }
};

/** POST /api/inventory/approval-authorities/:authorityId/number   { whatsapp_e164 } */
export const changeApprovalAuthorityWhatsAppNumber = async (req, res) => {
  try {
    const authority = await changeApprovalAuthorityNumber({
      authority_id: req.params.authorityId,
      whatsapp_e164: (req.body || {}).whatsapp_e164,
      actor: getActor(req)
    });
    return res.json({ message: 'WhatsApp number changed; the authority must be verified again.', authority });
  } catch (error) {
    return sendError(res, error, 'Failed to change the WhatsApp number');
  }
};
