/**
 * inventoryApprovalAuthoritiesRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H1, re-keyed in Phase H6 — who may be REACHED for purchase-request
 * approval over WhatsApp, and on which number.
 *
 * Document id: a server-generated, opaque authority_id.
 *
 *   inventory_approval_authorities/{authority_id}
 *     authority_id, authority_type, display_name, whatsapp_e164,
 *     verification_status, whatsapp_verified_at, whatsapp_verification_method,
 *     verified_sender_id, verification_expires_at,
 *     linked_staff_uid, is_active,
 *     created_by, updated_by, created_at, updated_at
 *
 * WHY NOT A FIREBASE UID (H6)
 * An approval authority is an EXTERNAL person: they approve over WhatsApp and
 * never log into HPMS. They have no Firebase account, no staff document, no
 * role and no password, so a uid cannot be their identity. The id is minted
 * here, from the CSPRNG, and is immutable. `linked_staff_uid` may point at a
 * staff member for one purpose only — the self-approval guard — and grants
 * nothing.
 *
 * WHAT THIS COLLECTION IS NOT
 * A role. External authority is never expressed as a staff role, and the
 * approval engine branches on the stored `authority_type`, never on whether a
 * staff lookup happens to succeed.
 *
 * REGISTERED IS NOT VERIFIED
 * A record is created PENDING_VERIFICATION and inactive. Only the verification
 * service, after a code arrives FROM the registered number over the signed
 * webhook, may write VERIFIED. Activation is a separate administrative step
 * and is refused unless the verification is current. `upsert` no longer
 * exists: identity is created once, and every later change goes through a
 * path that knows what it invalidates.
 *
 * Phone numbers and verification metadata live here, so Firestore rules deny
 * clients both read and write. Every access goes through the Admin SDK.
 */

import crypto from 'crypto';
import { db } from '../../config/firebaseAdmin.js';
import { getDoc, listDocs, updateDoc, RepositoryError } from './firestoreUtils.js';
import {
  MASTER_LIST_FETCH_CAP,
  APPROVAL_AUTHORITY_TYPES,
  APPROVAL_AUTHORITY_VERIFICATION
} from '../../utils/inventoryConstants.js';

export const APPROVAL_AUTHORITIES_COLLECTION = 'inventory_approval_authorities';

/**
 * E.164: a leading +, a non-zero country code, then 7–14 more digits.
 * Format only. It proves the string is shaped like a dialable number, not that
 * the number exists, answers, or belongs to this person — that is verification.
 */
const E164 = /^\+[1-9]\d{7,14}$/;

/** A Firestore document id may not be empty, contain '/', or be a path token. */
export function assertUsableAuthorityId(id) {
  const s = String(id || '').trim();
  if (!s) throw new RepositoryError('An authority_id is required', 'VALIDATION_ERROR', 400);
  if (s.length > 128) throw new RepositoryError('authority_id is too long', 'VALIDATION_ERROR', 400);
  if (s.includes('/') || s === '.' || s === '..') {
    throw new RepositoryError(`authority_id '${s}' is not a usable document id`, 'VALIDATION_ERROR', 400);
  }
  return s;
}

/** 128 bits from the CSPRNG. Opaque, unguessable, and unrelated to any login. */
export function generateAuthorityId() {
  return `aa_${crypto.randomBytes(16).toString('hex')}`;
}

function cleanString(v, max = 300) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

/** Normalises a WhatsApp number to E.164, or null. Throws on a malformed one. */
export function normalizeWhatsAppNumber(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  // Spaces, dashes and brackets are how people actually type numbers; strip the
  // punctuation but never invent a country code.
  const compact = raw.replace(/[\s\-()]/g, '');
  if (!E164.test(compact)) {
    throw new RepositoryError(
      `WhatsApp number must be in E.164 format, for example +919876543210 (got '${raw}')`,
      'VALIDATION_ERROR',
      400
    );
  }
  return compact;
}

/** Masks a number for logs and audit details: +9198****3210. */
export function maskWhatsAppNumber(e164) {
  const s = String(e164 || '');
  if (s.length < 8) return s ? '****' : null;
  return `${s.slice(0, 5)}****${s.slice(-4)}`;
}

export function authorityRef(id) {
  return db.collection(APPROVAL_AUTHORITIES_COLLECTION).doc(assertUsableAuthorityId(id));
}

/**
 * The document a registration creates. Always EXTERNAL, always
 * PENDING_VERIFICATION, always inactive. The type is set here and nowhere
 * else, and no write path below ever changes it.
 */
export function newApprovalAuthorityDoc({ display_name, whatsapp_e164, linked_staff_uid = null, actor_uid = null, now = new Date().toISOString() } = {}) {
  const displayName = cleanString(display_name, 200);
  if (!displayName) throw new RepositoryError('A display_name is required', 'VALIDATION_ERROR', 400);
  const e164 = normalizeWhatsAppNumber(whatsapp_e164);
  if (!e164) throw new RepositoryError('A WhatsApp number is required', 'VALIDATION_ERROR', 400);
  return {
    authority_id: generateAuthorityId(),
    authority_type: APPROVAL_AUTHORITY_TYPES.EXTERNAL,
    display_name: displayName,
    whatsapp_e164: e164,
    verification_status: APPROVAL_AUTHORITY_VERIFICATION.PENDING_VERIFICATION,
    whatsapp_verified_at: null,
    whatsapp_verification_method: null,
    verified_sender_id: null,
    verification_expires_at: null,
    linked_staff_uid: cleanString(linked_staff_uid, 128),
    is_active: false,
    created_by: actor_uid,
    updated_by: actor_uid,
    created_at: now,
    updated_at: now
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getApprovalAuthorityByIdFirestore(id, options = {}) {
  return await getDoc(APPROVAL_AUTHORITIES_COLLECTION, assertUsableAuthorityId(id), options);
}

/** Read half for a transaction: the raw document plus its reference. */
export async function readApprovalAuthorityInTxn(txn, id) {
  const ref = authorityRef(id);
  const snap = await txn.get(ref);
  return { ref, doc: snap.exists ? { id: snap.id, ...snap.data() } : null };
}

/**
 * One bounded query. Authority records carry their own display_name, so a list
 * never needs a per-row staff lookup — there is no N+1 here by construction.
 */
export async function listApprovalAuthoritiesFirestore(options = {}) {
  const { includeInactive = false, transaction = null } = options;
  const docs = await listDocs(APPROVAL_AUTHORITIES_COLLECTION, {
    orderBy: [{ field: 'display_name', direction: 'asc' }],
    limit: MASTER_LIST_FETCH_CAP,
    transaction
  });
  return includeInactive ? docs : docs.filter(a => a && a.is_active !== false);
}

// ── Predicates (pure) ────────────────────────────────────────────────────────

/**
 * The ONE definition of "this authority's WhatsApp identity is currently
 * proven": external, verified, not revoked, and inside its 180-day validity.
 * Used by activation here and, at decision time, by the approval engine.
 * Returns a verdict rather than throwing so each caller chooses its status.
 * Lives with the document it describes, so the approval engine depends on the
 * authority repository and on nothing WhatsApp-specific.
 */
export function assessAuthorityVerification(authority, nowMs = Date.now()) {
  if (!authority) return { ok: false, code: 'AUTHORITY_NOT_FOUND', message: 'Approval authority not found.' };
  if (authority.authority_type !== APPROVAL_AUTHORITY_TYPES.EXTERNAL) {
    return { ok: false, code: 'AUTHORITY_TYPE_INVALID', message: 'This authority is not an external WhatsApp authority.' };
  }
  if (authority.verification_status === APPROVAL_AUTHORITY_VERIFICATION.REVOKED) {
    return { ok: false, code: 'AUTHORITY_REVOKED', message: 'This authority\'s WhatsApp verification has been revoked.' };
  }
  if (authority.verification_status !== APPROVAL_AUTHORITY_VERIFICATION.VERIFIED) {
    return { ok: false, code: 'AUTHORITY_NOT_VERIFIED', message: 'This authority\'s WhatsApp number has not been verified.' };
  }
  const exp = Date.parse(authority.verification_expires_at || '');
  if (!Number.isFinite(exp) || exp <= nowMs) {
    return { ok: false, code: 'AUTHORITY_VERIFICATION_EXPIRED', message: 'This authority\'s WhatsApp verification has expired and must be renewed.' };
  }
  return { ok: true, code: null, message: null };
}

/**
 * May this authority decide RIGHT NOW: external, verified, current, active.
 * The engine performs the same checks with distinct error codes; this is the
 * one-word answer for lists and pickers.
 */
export function isAuthorityDecisionEligible(authority, nowMs = Date.now()) {
  return !!authority && assessAuthorityVerification(authority, nowMs).ok && authority.is_active === true;
}

// ── Writes (Admin SDK only; Firestore rules deny clients entirely) ───────────

/** Display metadata only. Cannot touch the number, the verification, or activation. */
export async function updateApprovalAuthorityDisplayFirestore(id, { display_name, linked_staff_uid, actor_uid = null } = {}, options = {}) {
  const docId = assertUsableAuthorityId(id);
  const existing = await getDoc(APPROVAL_AUTHORITIES_COLLECTION, docId, options);
  if (!existing) throw new RepositoryError(`No approval authority exists for '${docId}'`, 'NOT_FOUND', 404);

  const updates = { updated_by: actor_uid, updated_at: new Date().toISOString() };
  if (display_name !== undefined) {
    const displayName = cleanString(display_name, 200);
    if (!displayName) throw new RepositoryError('A display_name is required', 'VALIDATION_ERROR', 400);
    updates.display_name = displayName;
  }
  if (linked_staff_uid !== undefined) updates.linked_staff_uid = cleanString(linked_staff_uid, 128);

  const result = await updateDoc(APPROVAL_AUTHORITIES_COLLECTION, docId, updates, options);
  return { ...existing, ...result };
}

/**
 * Activation is refused unless the WhatsApp identity is currently proven —
 * verified, not revoked, not past its 180-day validity. Deactivation has no
 * precondition: switching someone off must always be possible. Soft only;
 * nothing here deletes.
 */
export async function setApprovalAuthorityActiveFirestore(id, isActive, actorUid, options = {}) {
  const docId = assertUsableAuthorityId(id);
  const existing = await getDoc(APPROVAL_AUTHORITIES_COLLECTION, docId, options);
  if (!existing) throw new RepositoryError(`No approval authority exists for '${docId}'`, 'NOT_FOUND', 404);

  if (isActive) {
    const verdict = assessAuthorityVerification(existing);
    if (!verdict.ok) throw new RepositoryError(verdict.message, verdict.code, 409);
  }

  const result = await updateDoc(APPROVAL_AUTHORITIES_COLLECTION, docId, {
    is_active: Boolean(isActive),
    updated_by: actorUid || null,
    updated_at: new Date().toISOString()
  }, options);
  return { ...existing, ...result };
}
