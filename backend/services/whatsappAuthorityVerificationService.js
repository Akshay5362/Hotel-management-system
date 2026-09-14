/**
 * backend/services/whatsappAuthorityVerificationService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H6 — the state machine behind an EXTERNAL approval authority.
 *
 * An external authority is a person who will approve purchase requests over
 * WhatsApp and who never logs into HPMS. They have no Firebase account, no
 * staff document, no role and no password. Their identity is a server-issued
 * authority_id, and the credential that proves it is control of a WhatsApp
 * number, established once by proof of possession and re-established every
 * 180 days.
 *
 *   register            PENDING_VERIFICATION, inactive, number bound
 *   issue challenge     a code the administrator hands over out of band
 *   redeem              the code arrives FROM the registered number → VERIFIED
 *   activate            a separate administrative decision, needs VERIFIED
 *   revoke / change     back to unverified; nothing transfers to a new number
 *
 * WHY REGISTERED IS NOT VERIFIED
 * An administrator can mistype a number. If verification meant "send a code to
 * the typed number and accept it back", the stranger holding the mistyped
 * number would become an approval authority. Here the code never goes to the
 * number: it goes to the administrator, who gives it to the intended person in
 * person. Only a message FROM the registered number carrying that code
 * verifies. A stranger receives nothing, and the intended person's own number
 * fails to match the typo — which exposes the typo instead of hiding it.
 *
 * EVERY WRITE THAT SPANS THE TWO COLLECTIONS IS ONE TRANSACTION
 * The authority document and its number binding can never disagree about
 * whether a number is verified, because they only ever change together.
 * Reads precede writes inside every transaction, as Firestore requires.
 *
 * NEVER LOGGED, NEVER AUDITED: the plaintext code, its HMAC, the HMAC secret.
 * Numbers reach the audit trail masked.
 */

import crypto from 'crypto';
import { db } from '../config/firebaseAdmin.js';
import { RepositoryError } from '../repositories/firestore/firestoreUtils.js';
import { createAuditLogFirestore } from '../repositories/firestore/auditLogsRepository.js';
import { getStaffByUidFirestore } from '../repositories/firestore/staffRepository.js';
import { isWhatsAppVerificationEnabled } from '../config/featureFlags.js';
import {
  authorityRef,
  newApprovalAuthorityDoc,
  getApprovalAuthorityByIdFirestore,
  assessAuthorityVerification,
  readApprovalAuthorityInTxn,
  updateApprovalAuthorityDisplayFirestore,
  setApprovalAuthorityActiveFirestore,
  assertUsableAuthorityId,
  normalizeWhatsAppNumber,
  maskWhatsAppNumber
} from '../repositories/firestore/inventoryApprovalAuthoritiesRepository.js';
import {
  newNumberBindingDoc,
  readNumberBindingInTxn,
  getNumberBindingByNumberFirestore,
  clearedChallengeFields,
  BINDING_STATUS
} from '../repositories/firestore/whatsappNumberBindingsRepository.js';
import {
  generateVerificationCode,
  verificationCodeHmac,
  verificationCodeMatches,
  extractVerificationCode,
  challengeState,
  CHALLENGE_STATE,
  normalizeSenderToE164,
  verificationSecretFromEnv
} from '../utils/whatsappVerificationCode.js';
import {
  APPROVAL_AUTHORITY_TYPES,
  APPROVAL_AUTHORITY_VERIFICATION,
  WHATSAPP_VERIFICATION_METHOD,
  WHATSAPP_VERIFICATION_VALIDITY_MS,
  WHATSAPP_VERIFICATION_CHALLENGE_TTL_MS,
  WHATSAPP_VERIFICATION_MAX_ATTEMPTS
} from '../utils/inventoryConstants.js';

export const WHATSAPP_AUTHORITY_AUDIT_ACTIONS = Object.freeze({
  CREATED: 'INVENTORY_APPROVAL_AUTHORITY_CREATED',
  UPDATED: 'INVENTORY_APPROVAL_AUTHORITY_UPDATED',
  CHALLENGE_ISSUED: 'INVENTORY_APPROVAL_AUTHORITY_CHALLENGE_ISSUED',
  VERIFIED: 'INVENTORY_APPROVAL_AUTHORITY_VERIFIED',
  VERIFICATION_FAILED: 'INVENTORY_APPROVAL_AUTHORITY_VERIFICATION_FAILED',
  VERIFICATION_REVOKED: 'INVENTORY_APPROVAL_AUTHORITY_VERIFICATION_REVOKED',
  ACTIVATED: 'INVENTORY_APPROVAL_AUTHORITY_ACTIVATED',
  DEACTIVATED: 'INVENTORY_APPROVAL_AUTHORITY_DEACTIVATED',
  NUMBER_CHANGED: 'INVENTORY_APPROVAL_AUTHORITY_NUMBER_CHANGED'
});

/** Outcomes of an inbound redemption. Only VERIFIED changes an authority. */
export const REDEEM_OUTCOME = Object.freeze({
  DISABLED: 'DISABLED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  IGNORED_UNPARSEABLE_SENDER: 'IGNORED_UNPARSEABLE_SENDER',
  IGNORED_NOT_A_CODE: 'IGNORED_NOT_A_CODE',
  UNKNOWN_SENDER: 'UNKNOWN_SENDER',
  BINDING_INCONSISTENT: 'BINDING_INCONSISTENT',
  NO_CHALLENGE: 'NO_CHALLENGE',
  REPLAY: 'REPLAY',
  EXPIRED: 'EXPIRED',
  EXHAUSTED: 'EXHAUSTED',
  WRONG_CODE: 'WRONG_CODE',
  VERIFIED: 'VERIFIED'
});

const SYSTEM_ACTOR = 'system:whatsapp';

function fail(message, code, status = 400) {
  return new RepositoryError(message, code, status);
}

function nowIso() {
  return new Date().toISOString();
}

function assertActor(actor) {
  if (!actor || !actor.uid) throw fail('An authenticated administrator is required.', 'ACTOR_REQUIRED', 401);
}

function cleanString(v, max = 300) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

/** Firestore/gRPC signals a create() precondition failure as ALREADY_EXISTS (6). */
function isAlreadyExists(err) {
  return err && (err.code === 6 || err.code === 'already-exists' || /ALREADY_EXISTS/i.test(String(err.message || '')));
}

/**
 * A transaction that may txn.create() a number binding. The in-transaction
 * existence check gives a clean error; the create() precondition is what makes
 * it airtight under a race, and this maps that outcome to the same error.
 */
async function runBindingTransaction(fn) {
  try {
    return await db.runTransaction(fn);
  } catch (err) {
    if (isAlreadyExists(err)) {
      throw fail('That WhatsApp number is already registered to an approval authority.', 'NUMBER_ALREADY_BOUND', 409);
    }
    throw err;
  }
}

/**
 * Audit, in the existing convention. There is no request object on the
 * webhook path, so this writes through the repository directly, as the
 * approval service does. Ids carry the authority id so a test can find and
 * remove exactly its own rows.
 */
async function writeAudit(action, authorityId, details, actor) {
  try {
    await createAuditLogFirestore({
      log_id: `inv_wa_${authorityId || 'unknown'}_${action.toLowerCase()}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      action,
      details: {
        authority_id: authorityId || null,
        ...details,
        actor_name: actor?.name ?? null,
        actor_role: actor?.role ?? null
      },
      user_id: actor?.uid || SYSTEM_ACTOR
    });
  } catch (err) {
    console.warn(`[WhatsAppVerification] audit log failed (${action}): ${err.message}`);
  }
}

function digitsOf(v) {
  return String(v || '').replace(/\D/g, '');
}

/**
 * A registration-time WARNING, never an authorization decision. When the
 * administrator links a staff member, and that staff record has a phone on
 * file, a clear mismatch is worth surfacing before anyone hands over a code.
 * Staff phones are free-form, so this compares trailing digits and stays
 * advisory.
 */
async function linkedStaffWarnings(linkedStaffUid, e164) {
  const warnings = [];
  if (!linkedStaffUid) return warnings;
  const staff = await getStaffByUidFirestore(linkedStaffUid);
  if (!staff) throw fail('No staff member found for linked_staff_uid.', 'STAFF_NOT_FOUND', 404);
  const onFile = digitsOf(staff.phone);
  const registered = digitsOf(e164);
  if (onFile.length >= 8 && !registered.endsWith(onFile.slice(-8)) && !onFile.endsWith(registered.slice(-8))) {
    warnings.push('LINKED_STAFF_PHONE_MISMATCH');
  }
  return warnings;
}

/** Everything a fresh, unverified authority carries — cleared on revoke, change and re-challenge. */
function unverifiedAuthorityFields(now, actorUid) {
  return {
    verification_status: APPROVAL_AUTHORITY_VERIFICATION.PENDING_VERIFICATION,
    whatsapp_verified_at: null,
    whatsapp_verification_method: null,
    verified_sender_id: null,
    verification_expires_at: null,
    is_active: false,
    updated_at: now,
    updated_by: actorUid
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ADMINISTRATION (MANAGE roles, authenticated). The authority never calls these.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates an EXTERNAL authority: PENDING_VERIFICATION, inactive, its number
 * bound atomically. A number already bound to anyone refuses the whole thing.
 */
export async function registerApprovalAuthority({ display_name, whatsapp_e164, linked_staff_uid = null, actor } = {}) {
  assertActor(actor);
  const e164 = normalizeWhatsAppNumber(whatsapp_e164);
  if (!e164) throw fail('A WhatsApp number is required.', 'VALIDATION_ERROR', 400);
  const linked = cleanString(linked_staff_uid, 128);
  const warnings = await linkedStaffWarnings(linked, e164);

  const now = nowIso();
  const authority = newApprovalAuthorityDoc({
    display_name, whatsapp_e164: e164, linked_staff_uid: linked, actor_uid: actor.uid, now
  });
  const binding = newNumberBindingDoc({ whatsapp_e164: e164, authority_id: authority.authority_id, actor_uid: actor.uid, now });

  await runBindingTransaction(async (txn) => {
    const { ref: bindingRef, doc: existing } = await readNumberBindingInTxn(txn, e164);
    if (existing) throw fail('That WhatsApp number is already registered to an approval authority.', 'NUMBER_ALREADY_BOUND', 409);
    txn.create(bindingRef, binding);
    txn.create(authorityRef(authority.authority_id), authority);
  });

  await writeAudit(WHATSAPP_AUTHORITY_AUDIT_ACTIONS.CREATED, authority.authority_id, {
    display_name: authority.display_name,
    whatsapp_masked: maskWhatsAppNumber(e164),
    linked_staff_uid: linked,
    warnings
  }, actor);

  return { authority, warnings };
}

/** Display metadata only. Number, verification and activation have their own paths. */
export async function updateApprovalAuthorityDisplay({ authority_id, display_name, linked_staff_uid, actor } = {}) {
  assertActor(actor);
  const id = assertUsableAuthorityId(authority_id);
  const existing = await getApprovalAuthorityByIdFirestore(id);
  if (!existing) throw fail('Approval authority not found.', 'AUTHORITY_NOT_FOUND', 404);

  const linked = linked_staff_uid === undefined ? undefined : cleanString(linked_staff_uid, 128);
  const warnings = linked ? await linkedStaffWarnings(linked, existing.whatsapp_e164) : [];

  const authority = await updateApprovalAuthorityDisplayFirestore(id, {
    display_name, linked_staff_uid: linked, actor_uid: actor.uid
  });
  await writeAudit(WHATSAPP_AUTHORITY_AUDIT_ACTIONS.UPDATED, id, {
    display_name: authority.display_name, linked_staff_uid: authority.linked_staff_uid, warnings
  }, actor);
  return { authority, warnings };
}

/**
 * Mints a one-time code and returns the plaintext EXACTLY ONCE, to the
 * administrator. Any previous challenge on the number is replaced. Issuing a
 * challenge also drops the authority back to PENDING_VERIFICATION and
 * inactive, so a re-verification cannot leave a stale VERIFIED state live.
 */
export async function issueVerificationChallenge({ authority_id, actor } = {}) {
  assertActor(actor);
  if (!isWhatsAppVerificationEnabled()) {
    throw fail('WhatsApp verification is disabled.', 'WHATSAPP_VERIFICATION_DISABLED', 409);
  }
  const secret = verificationSecretFromEnv();
  if (!secret) throw fail('WhatsApp verification is not configured.', 'WHATSAPP_VERIFICATION_NOT_CONFIGURED', 503);

  const id = assertUsableAuthorityId(authority_id);
  const code = generateVerificationCode();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + WHATSAPP_VERIFICATION_CHALLENGE_TTL_MS).toISOString();
  let masked = null;

  await db.runTransaction(async (txn) => {
    const { ref: aRef, doc: authority } = await readApprovalAuthorityInTxn(txn, id);
    if (!authority) throw fail('Approval authority not found.', 'AUTHORITY_NOT_FOUND', 404);
    if (authority.authority_type !== APPROVAL_AUTHORITY_TYPES.EXTERNAL) {
      throw fail('Only an external authority is verified over WhatsApp.', 'AUTHORITY_TYPE_INVALID', 409);
    }
    if (!authority.whatsapp_e164) throw fail('This authority has no WhatsApp number.', 'AUTHORITY_NUMBER_MISSING', 409);
    const { ref: bRef, doc: binding } = await readNumberBindingInTxn(txn, authority.whatsapp_e164);
    if (!binding || binding.authority_id !== id) {
      throw fail('The number binding is inconsistent; change the number to repair it.', 'NUMBER_BINDING_INCONSISTENT', 409);
    }
    masked = maskWhatsAppNumber(authority.whatsapp_e164);
    const hmac = verificationCodeHmac(code, secret, binding.number_key);

    txn.update(bRef, {
      ...clearedChallengeFields(now),
      challenge_code_hmac: hmac,
      challenge_expires_at: expiresAt,
      challenge_issued_at: now,
      challenge_issued_by: actor.uid,
      status: BINDING_STATUS.PENDING,
      verified_at: null,
      verified_sender_id: null,
      updated_by: actor.uid
    });
    txn.update(aRef, unverifiedAuthorityFields(now, actor.uid));
  });

  await writeAudit(WHATSAPP_AUTHORITY_AUDIT_ACTIONS.CHALLENGE_ISSUED, id, {
    whatsapp_masked: masked, expires_at: expiresAt
  }, actor);

  return {
    authority_id: id,
    code,
    expires_at: expiresAt,
    whatsapp_masked: masked,
    instructions: 'Give this code to the authority in person or by voice. They must send it from their own WhatsApp to the hotel number. Do not send it to their number.'
  };
}

/** Verified → REVOKED, inactive. The number stays bound so nobody else can claim it. */
export async function revokeApprovalAuthorityVerification({ authority_id, actor } = {}) {
  assertActor(actor);
  const id = assertUsableAuthorityId(authority_id);
  const now = nowIso();
  let masked = null;

  await db.runTransaction(async (txn) => {
    const { ref: aRef, doc: authority } = await readApprovalAuthorityInTxn(txn, id);
    if (!authority) throw fail('Approval authority not found.', 'AUTHORITY_NOT_FOUND', 404);
    let bindingRef = null;
    if (authority.whatsapp_e164) {
      const { ref, doc: binding } = await readNumberBindingInTxn(txn, authority.whatsapp_e164);
      if (binding && binding.authority_id === id) bindingRef = ref;
    }
    masked = maskWhatsAppNumber(authority.whatsapp_e164);

    txn.update(aRef, {
      ...unverifiedAuthorityFields(now, actor.uid),
      verification_status: APPROVAL_AUTHORITY_VERIFICATION.REVOKED
    });
    if (bindingRef) {
      txn.update(bindingRef, {
        ...clearedChallengeFields(now),
        status: BINDING_STATUS.PENDING,
        verified_at: null,
        verified_sender_id: null,
        updated_by: actor.uid
      });
    }
  });

  await writeAudit(WHATSAPP_AUTHORITY_AUDIT_ACTIONS.VERIFICATION_REVOKED, id, { whatsapp_masked: masked }, actor);
  return await getApprovalAuthorityByIdFirestore(id);
}

/**
 * A new number is a new identity claim. The old binding is released, the new
 * one is created, and NOTHING about the old verification survives.
 */
export async function changeApprovalAuthorityNumber({ authority_id, whatsapp_e164, actor } = {}) {
  assertActor(actor);
  const id = assertUsableAuthorityId(authority_id);
  const e164 = normalizeWhatsAppNumber(whatsapp_e164);
  if (!e164) throw fail('A WhatsApp number is required.', 'VALIDATION_ERROR', 400);
  const now = nowIso();
  let oldMasked = null;

  await runBindingTransaction(async (txn) => {
    const { ref: aRef, doc: authority } = await readApprovalAuthorityInTxn(txn, id);
    if (!authority) throw fail('Approval authority not found.', 'AUTHORITY_NOT_FOUND', 404);
    if (authority.whatsapp_e164 === e164) throw fail('That is already the registered number.', 'NUMBER_UNCHANGED', 400);
    const { ref: newRef, doc: taken } = await readNumberBindingInTxn(txn, e164);
    if (taken) throw fail('That WhatsApp number is already registered to an approval authority.', 'NUMBER_ALREADY_BOUND', 409);
    let oldRef = null;
    if (authority.whatsapp_e164) {
      const { ref, doc: old } = await readNumberBindingInTxn(txn, authority.whatsapp_e164);
      if (old && old.authority_id === id) oldRef = ref;
    }
    oldMasked = maskWhatsAppNumber(authority.whatsapp_e164);

    txn.create(newRef, newNumberBindingDoc({ whatsapp_e164: e164, authority_id: id, actor_uid: actor.uid, now }));
    if (oldRef) txn.delete(oldRef);
    txn.update(aRef, { whatsapp_e164: e164, ...unverifiedAuthorityFields(now, actor.uid) });
  });

  await writeAudit(WHATSAPP_AUTHORITY_AUDIT_ACTIONS.NUMBER_CHANGED, id, {
    old_whatsapp_masked: oldMasked, new_whatsapp_masked: maskWhatsAppNumber(e164)
  }, actor);
  return await getApprovalAuthorityByIdFirestore(id);
}

/** Activation is the administrator's separate decision; the repository refuses it unless verified and current. */
export async function activateApprovalAuthority({ authority_id, actor } = {}) {
  assertActor(actor);
  const authority = await setApprovalAuthorityActiveFirestore(authority_id, true, actor.uid);
  await writeAudit(WHATSAPP_AUTHORITY_AUDIT_ACTIONS.ACTIVATED, authority.authority_id, {
    display_name: authority.display_name
  }, actor);
  return authority;
}

/** Switching someone off must always be possible; no preconditions. */
export async function deactivateApprovalAuthority({ authority_id, actor } = {}) {
  assertActor(actor);
  const authority = await setApprovalAuthorityActiveFirestore(authority_id, false, actor.uid);
  await writeAudit(WHATSAPP_AUTHORITY_AUDIT_ACTIONS.DEACTIVATED, authority.authority_id, {
    display_name: authority.display_name
  }, actor);
  return authority;
}

// ═══════════════════════════════════════════════════════════════════════════
// SENDER RESOLUTION — the ONE canonical path from a WhatsApp number to an
// authority that may act. Every inbound caller uses this; there is deliberately
// no second, subtly different copy of these rules anywhere.
// ═══════════════════════════════════════════════════════════════════════════

/** Why a sender cannot act. UNKNOWN_SENDER is answered with silence, never a reply. */
export const SENDER_RESOLUTION = Object.freeze({
  UNPARSEABLE_SENDER: 'UNPARSEABLE_SENDER',
  UNKNOWN_SENDER: 'UNKNOWN_SENDER',
  BINDING_NOT_VERIFIED: 'BINDING_NOT_VERIFIED',
  BINDING_INCONSISTENT: 'BINDING_INCONSISTENT',
  AUTHORITY_INACTIVE: 'AUTHORITY_INACTIVE'
});

/**
 * Resolves a Meta-attested sender to the authority that may act as them.
 *
 * The chain is: number → whatsapp_number_bindings → authority_id →
 * inventory_approval_authorities → external, verified, unexpired, active.
 *
 * Reuses assessAuthorityVerification, so the 180-day policy and the
 * revoked/unverified distinctions are defined in exactly one place and cannot
 * drift between the verification path and the decision path.
 *
 * Never throws for an expected outcome, and never reveals to a caller which
 * numbers exist: an unregistered sender is simply UNKNOWN_SENDER.
 *
 * @returns {{ ok: true, authority: object, authority_id: string, sender_e164: string }}
 *        | {{ ok: false, code: string, authority_id: string|null, sender_e164: string|null }}
 */
export async function resolveAuthorityBySender(senderId) {
  const senderE164 = normalizeSenderToE164(senderId);
  if (!senderE164) {
    return { ok: false, code: SENDER_RESOLUTION.UNPARSEABLE_SENDER, authority_id: null, sender_e164: null };
  }

  const binding = await getNumberBindingByNumberFirestore(senderE164);
  if (!binding) {
    return { ok: false, code: SENDER_RESOLUTION.UNKNOWN_SENDER, authority_id: null, sender_e164: senderE164 };
  }
  if (binding.status !== BINDING_STATUS.VERIFIED) {
    return { ok: false, code: SENDER_RESOLUTION.BINDING_NOT_VERIFIED, authority_id: binding.authority_id, sender_e164: senderE164 };
  }

  const authority = await getApprovalAuthorityByIdFirestore(binding.authority_id);
  // The binding and the authority must still agree about the number; a
  // mismatch means a change is half-applied and nothing may act on it.
  if (!authority || authority.whatsapp_e164 !== senderE164) {
    return { ok: false, code: SENDER_RESOLUTION.BINDING_INCONSISTENT, authority_id: binding.authority_id, sender_e164: senderE164 };
  }

  const verdict = assessAuthorityVerification(authority);
  if (!verdict.ok) {
    return { ok: false, code: verdict.code, authority_id: authority.authority_id, sender_e164: senderE164 };
  }
  if (authority.is_active !== true) {
    return { ok: false, code: SENDER_RESOLUTION.AUTHORITY_INACTIVE, authority_id: authority.authority_id, sender_e164: senderE164 };
  }

  return { ok: true, authority, authority_id: authority.authority_id, sender_e164: senderE164 };
}

// ═══════════════════════════════════════════════════════════════════════════
// REDEMPTION — the only step the authority performs, and it is over WhatsApp.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A text message arrived from `sender_id`, attested by Meta and delivered
 * through the signed webhook. If it carries a code, redeem it against the
 * binding FOR THAT SENDER.
 *
 * That lookup is the wrong-sender defence. A code sent from any number other
 * than the registered one finds either no binding (a stranger) or somebody
 * else's binding (and counts as a wrong guess against THAT challenge). The
 * intended authority's challenge is never touched, never consumed.
 *
 * Never throws for an expected outcome, never replies, never reveals to an
 * unknown sender whether anything exists.
 */
export async function redeemVerificationFromSender({ sender_id, text, message_id = null } = {}) {
  if (!isWhatsAppVerificationEnabled()) return { outcome: REDEEM_OUTCOME.DISABLED };
  const senderE164 = normalizeSenderToE164(sender_id);
  if (!senderE164) return { outcome: REDEEM_OUTCOME.IGNORED_UNPARSEABLE_SENDER };
  const code = extractVerificationCode(text);
  if (!code) return { outcome: REDEEM_OUTCOME.IGNORED_NOT_A_CODE };
  const secret = verificationSecretFromEnv();
  if (!secret) {
    console.warn('[WhatsAppVerification] a code arrived but verification is not configured');
    return { outcome: REDEEM_OUTCOME.NOT_CONFIGURED };
  }

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const senderMasked = maskWhatsAppNumber(senderE164);

  const result = await db.runTransaction(async (txn) => {
    const { ref: bRef, doc: binding } = await readNumberBindingInTxn(txn, senderE164);
    if (!binding) return { outcome: REDEEM_OUTCOME.UNKNOWN_SENDER, authority_id: null };

    const { ref: aRef, doc: authority } = await readApprovalAuthorityInTxn(txn, binding.authority_id);
    if (!authority
      || authority.authority_type !== APPROVAL_AUTHORITY_TYPES.EXTERNAL
      || authority.whatsapp_e164 !== senderE164) {
      return { outcome: REDEEM_OUTCOME.BINDING_INCONSISTENT, authority_id: binding.authority_id };
    }

    const state = challengeState(binding, nowMs);
    if (state !== CHALLENGE_STATE.ACTIVE) {
      const outcome = state === CHALLENGE_STATE.CONSUMED ? REDEEM_OUTCOME.REPLAY
        : state === CHALLENGE_STATE.EXPIRED ? REDEEM_OUTCOME.EXPIRED
          : state === CHALLENGE_STATE.EXHAUSTED ? REDEEM_OUTCOME.EXHAUSTED
            : REDEEM_OUTCOME.NO_CHALLENGE;
      return { outcome, authority_id: binding.authority_id };
    }

    if (!verificationCodeMatches(code, binding.challenge_code_hmac, secret, binding.number_key)) {
      const attempts = Number(binding.challenge_attempts || 0) + 1;
      const exhausted = attempts >= WHATSAPP_VERIFICATION_MAX_ATTEMPTS;
      // Exhaustion DESTROYS the challenge rather than merely refusing it.
      txn.update(bRef, {
        challenge_attempts: attempts,
        ...(exhausted ? { challenge_code_hmac: null } : {}),
        updated_at: now
      });
      return {
        outcome: exhausted ? REDEEM_OUTCOME.EXHAUSTED : REDEEM_OUTCOME.WRONG_CODE,
        authority_id: binding.authority_id,
        attempts
      };
    }

    const verificationExpiresAt = new Date(nowMs + WHATSAPP_VERIFICATION_VALIDITY_MS).toISOString();
    txn.update(bRef, {
      status: BINDING_STATUS.VERIFIED,
      challenge_code_hmac: null,
      challenge_consumed_at: now,
      verified_at: now,
      verified_sender_id: String(sender_id),
      updated_at: now,
      updated_by: SYSTEM_ACTOR
    });
    // is_active is deliberately NOT touched: verification proves the number,
    // activation is the administrator's separate decision.
    txn.update(aRef, {
      verification_status: APPROVAL_AUTHORITY_VERIFICATION.VERIFIED,
      whatsapp_verified_at: now,
      whatsapp_verification_method: WHATSAPP_VERIFICATION_METHOD,
      verified_sender_id: String(sender_id),
      verification_expires_at: verificationExpiresAt,
      updated_at: now,
      updated_by: SYSTEM_ACTOR
    });
    return { outcome: REDEEM_OUTCOME.VERIFIED, authority_id: binding.authority_id, verification_expires_at: verificationExpiresAt };
  });

  if (result.outcome === REDEEM_OUTCOME.VERIFIED) {
    await writeAudit(WHATSAPP_AUTHORITY_AUDIT_ACTIONS.VERIFIED, result.authority_id, {
      sender_masked: senderMasked,
      verification_expires_at: result.verification_expires_at,
      meta_message_id: message_id
    }, null);
  } else {
    await writeAudit(WHATSAPP_AUTHORITY_AUDIT_ACTIONS.VERIFICATION_FAILED, result.authority_id, {
      reason: result.outcome,
      sender_masked: senderMasked,
      attempts: result.attempts ?? null,
      meta_message_id: message_id
    }, null);
  }
  return result;
}
