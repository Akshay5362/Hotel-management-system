/**
 * inventoryApprovalAuthoritiesRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H1 — which staff members may be REACHED for purchase-request approval
 * over WhatsApp, and on which number.
 *
 * Document id: the staff member's Firebase Auth uid, verbatim.
 *
 *   inventory_approval_authorities/{user_uid}
 *     user_uid, display_name,
 *     whatsapp_e164, whatsapp_verified_at, whatsapp_verification_method,
 *     is_active, created_by, updated_by, created_at, updated_at
 *
 * Unlike the other inventory masters this id carries NO prefix. The identity of
 * an authority IS the staff uid — one record per person, enforced by the id
 * itself rather than by a lookup — so a `auth_` prefix would only create a
 * second spelling of the same fact and a chance for the two to disagree.
 *
 * WHAT THIS COLLECTION IS NOT
 * It does not grant permission to approve anything. Approval authority is, and
 * remains, `roleCanApprove()` against settings/inventory_pr_approval, evaluated
 * at decision time by purchaseRequestApprovalService. A record here says only
 * "this person can be sent an approval request, at this number". A stale record
 * must never become an authorization bypass, which is why the role is validated
 * on write but deliberately NOT copied into the document: copying it would
 * freeze a permission that the configuration is entitled to revoke later.
 *
 * Phone numbers and verification metadata live here, so Firestore rules deny
 * clients both read and write. Every access goes through the Admin SDK.
 *
 * H1 STORES a number; it never verifies one. `whatsapp_verified_at` and
 * `whatsapp_verification_method` stay null until a later phase performs real
 * verification. Nothing in this file may set them.
 */

import { getDoc, listDocs, setDoc, updateDoc, RepositoryError } from './firestoreUtils.js';
import { MASTER_LIST_FETCH_CAP } from '../../utils/inventoryConstants.js';

export const APPROVAL_AUTHORITIES_COLLECTION = 'inventory_approval_authorities';

/**
 * E.164: a leading +, a non-zero country code, then 7–14 more digits.
 * Format only. It proves the string is shaped like a dialable number, not that
 * the number exists, answers, or belongs to this person — that is verification,
 * and verification is a later phase.
 */
const E164 = /^\+[1-9]\d{7,14}$/;

/** A Firestore document id may not be empty, contain '/', or be a path token. */
export function assertUsableUid(uid) {
  const s = String(uid || '').trim();
  if (!s) throw new RepositoryError('A staff user_uid is required', 'VALIDATION_ERROR', 400);
  if (s.length > 128) throw new RepositoryError('user_uid is too long', 'VALIDATION_ERROR', 400);
  if (s.includes('/') || s === '.' || s === '..') {
    throw new RepositoryError(`user_uid '${s}' is not a usable document id`, 'VALIDATION_ERROR', 400);
  }
  return s;
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

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getApprovalAuthorityByUidFirestore(uid, options = {}) {
  const docId = assertUsableUid(uid);
  return await getDoc(APPROVAL_AUTHORITIES_COLLECTION, docId, options);
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

// ── Writes (Admin SDK only; Firestore rules deny clients entirely) ───────────

/**
 * Creates or updates the single record for this uid.
 *
 * Idempotent by construction: the document id is the uid, so calling this twice
 * for the same person updates one record rather than creating a second. On an
 * update only the supplied fields move; `created_at` and `created_by` are
 * preserved from the existing document.
 */
export async function upsertApprovalAuthorityFirestore(data, options = {}) {
  const docId = assertUsableUid(data.user_uid);
  const displayName = cleanString(data.display_name, 200);
  if (!displayName) {
    throw new RepositoryError('A display_name is required', 'VALIDATION_ERROR', 400);
  }

  const existing = await getDoc(APPROVAL_AUTHORITIES_COLLECTION, docId, options);
  const now = new Date().toISOString();

  // Only touch the number when the caller actually supplied the key, so an
  // update that changes a name cannot silently erase a stored number.
  const whatsapp = data.whatsapp_e164 !== undefined
    ? normalizeWhatsAppNumber(data.whatsapp_e164)
    : (existing?.whatsapp_e164 ?? null);

  // A changed number invalidates any verification the old one carried.
  const numberChanged = !!existing && existing.whatsapp_e164 !== whatsapp;

  const payload = {
    user_uid: docId,
    display_name: displayName,
    whatsapp_e164: whatsapp,
    // H1 never writes verification metadata. It is carried forward untouched,
    // and reset whenever the number it referred to changes.
    whatsapp_verified_at: numberChanged ? null : (existing?.whatsapp_verified_at ?? null),
    whatsapp_verification_method: numberChanged ? null : (existing?.whatsapp_verification_method ?? null),
    is_active: data.is_active === undefined
      ? (existing?.is_active === undefined ? true : existing.is_active)
      : Boolean(data.is_active),
    created_by: existing?.created_by ?? (data.actor_uid || null),
    updated_by: data.actor_uid || null,
    created_at: existing?.created_at ?? now,
    updated_at: now
  };

  await setDoc(APPROVAL_AUTHORITIES_COLLECTION, docId, payload, { ...options, merge: false });
  return { authority: payload, created: !existing, number_changed: numberChanged };
}

/**
 * Soft deactivate. The record is kept so the audit trail of who was once an
 * approval authority survives; nothing here deletes.
 */
export async function setApprovalAuthorityActiveFirestore(uid, isActive, actorUid, options = {}) {
  const docId = assertUsableUid(uid);
  const existing = await getDoc(APPROVAL_AUTHORITIES_COLLECTION, docId, options);
  if (!existing) {
    throw new RepositoryError(`No approval authority exists for '${docId}'`, 'NOT_FOUND', 404);
  }
  const result = await updateDoc(APPROVAL_AUTHORITIES_COLLECTION, docId, {
    is_active: Boolean(isActive),
    updated_by: actorUid || null,
    updated_at: new Date().toISOString()
  }, options);
  return { ...existing, ...result };
}
