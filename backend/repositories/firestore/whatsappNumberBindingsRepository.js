/**
 * backend/repositories/firestore/whatsappNumberBindingsRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H6 — one WhatsApp number, one approval authority.
 *
 *   whatsapp_number_bindings/{wa_<digits>}
 *     number_key, whatsapp_e164, authority_id, status,
 *     challenge_code_hmac, challenge_expires_at, challenge_attempts,
 *     challenge_issued_at, challenge_issued_by, challenge_consumed_at,
 *     verified_at, verified_sender_id,
 *     created_at, created_by, updated_at, updated_by
 *
 * THE DOCUMENT ID IS THE UNIQUENESS RULE
 * The id is derived from the normalised number, so two authorities registering
 * one number collide on one document, and a transactional create() refuses the
 * second. No query, no index, no race.
 *
 * WHAT IS STORED ABOUT THE CODE
 * Only its keyed HMAC. The plaintext exists for the length of one HTTP response
 * to the administrator and is never written anywhere. A client can neither read
 * nor write this collection; the Firestore rule is deny-all.
 *
 * This file holds primitives. The state machine that composes them into one
 * transaction lives in whatsappAuthorityVerificationService.
 */

import { db } from '../../config/firebaseAdmin.js';
import { getDoc, RepositoryError } from './firestoreUtils.js';
import { bindingKeyForNumber, E164_PATTERN } from '../../utils/whatsappVerificationCode.js';

export const WHATSAPP_NUMBER_BINDINGS_COLLECTION = 'whatsapp_number_bindings';

export const BINDING_STATUS = Object.freeze({
  PENDING: 'PENDING',
  VERIFIED: 'VERIFIED'
});

function assertE164(e164) {
  if (typeof e164 !== 'string' || !E164_PATTERN.test(e164)) {
    throw new RepositoryError('A normalised E.164 WhatsApp number is required', 'VALIDATION_ERROR', 400);
  }
  return e164;
}

export function numberBindingRef(e164) {
  return db.collection(WHATSAPP_NUMBER_BINDINGS_COLLECTION).doc(bindingKeyForNumber(assertE164(e164)));
}

/** The document a fresh registration creates. No challenge yet, nothing verified. */
export function newNumberBindingDoc({ whatsapp_e164, authority_id, actor_uid = null, now = new Date().toISOString() } = {}) {
  const e164 = assertE164(whatsapp_e164);
  const id = String(authority_id || '').trim();
  if (!id) throw new RepositoryError('authority_id is required', 'VALIDATION_ERROR', 400);
  return {
    number_key: bindingKeyForNumber(e164),
    whatsapp_e164: e164,
    authority_id: id,
    status: BINDING_STATUS.PENDING,
    challenge_code_hmac: null,
    challenge_expires_at: null,
    challenge_attempts: 0,
    challenge_issued_at: null,
    challenge_issued_by: null,
    challenge_consumed_at: null,
    verified_at: null,
    verified_sender_id: null,
    created_at: now,
    created_by: actor_uid,
    updated_at: now,
    updated_by: actor_uid
  };
}

/** Every challenge field back to "no challenge". Spread into a transactional update. */
export function clearedChallengeFields(now = new Date().toISOString()) {
  return {
    challenge_code_hmac: null,
    challenge_expires_at: null,
    challenge_attempts: 0,
    challenge_issued_at: null,
    challenge_issued_by: null,
    challenge_consumed_at: null,
    updated_at: now
  };
}

export async function getNumberBindingByNumberFirestore(e164, options = {}) {
  return await getDoc(WHATSAPP_NUMBER_BINDINGS_COLLECTION, bindingKeyForNumber(assertE164(e164)), options);
}

/**
 * Read half for a transaction. Returns the raw document, not the sanitised
 * view, because the HMAC is consumed here and nowhere else.
 */
export async function readNumberBindingInTxn(txn, e164) {
  const ref = numberBindingRef(e164);
  const snap = await txn.get(ref);
  return { ref, doc: snap.exists ? { id: snap.id, ...snap.data() } : null };
}

export async function deleteNumberBindingFirestore(e164) {
  await numberBindingRef(e164).delete();
}
