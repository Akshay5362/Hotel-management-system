/**
 * backend/repositories/firestore/whatsappMessagesRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H8-A — the correlation record for one OUTBOUND WhatsApp dispatch.
 *
 *   whatsapp_messages/{dispatch_id}
 *     dispatch_id, direction, purpose, authority_id, request_id,
 *     request_number, template_name, send_state, provider_message_id,
 *     delivery_status, delivery_updated_at, bridge_consumed_at,
 *     bridge_mint_count, created_at, updated_at
 *
 * WHY THIS EXISTS
 * A business-initiated template cannot carry an approval token: Meta's
 * quick-reply button schema has no developer payload, and the tap webhook
 * returns the button LABEL in both `button.payload` and `button.text`. What a
 * tap does carry is `context.id` — the message id of the outbound message the
 * button belonged to. This collection is what turns that id back into "which
 * request, and which authority". Without it a tap is unattributable.
 *
 * WHY THE DOCUMENT ID IS NOT THE PROVIDER MESSAGE ID
 * Meta's send API has no idempotency key, and the provider id only exists
 * AFTER a successful send. Keying on it would leave the one case that matters
 * unprotected: Meta accepted the message and we timed out before learning its
 * id. So the id is derived from the dispatch itself — request, authority,
 * purpose — and claimed with create() BEFORE the send. A second attempt then
 * collides instead of sending twice, and the provider id is recorded as an
 * ordinary field once it is known.
 *
 * The hash is for SHAPE, not secrecy. Request ids, authority ids and purposes
 * are not secrets; they are hashed so the id is a fixed length and free of the
 * '/' that Firestore forbids. Nothing secret may ever be fed into it.
 *
 * THIS FILE IS PERSISTENCE ONLY
 * It decides nothing. It does not choose who is notified, does not mint or read
 * an approval token, does not build a message, does not call Meta, and does not
 * retry. It imports no transport and performs no network I/O of any kind.
 *
 * NEVER STORED HERE
 * No raw approval token, no verification code, no access token, no app secret,
 * and no phone number in any form. The authority id resolves to a number
 * elsewhere, in memory, at send time. Because nothing here is a secret, the
 * rows are safe to keep for as long as the audit trail is useful.
 *
 * Firestore rules deny clients both read and write; every access is Admin SDK.
 */

import crypto from 'crypto';
import { FieldPath } from 'firebase-admin/firestore';
import { db } from '../../config/firebaseAdmin.js';
import { getDoc, updateDoc, formatDocSnapshot, RepositoryError } from './firestoreUtils.js';
import {
  WHATSAPP_DISPATCH_DIRECTION,
  WHATSAPP_DISPATCH_PURPOSE,
  WHATSAPP_SEND_STATE,
  WHATSAPP_DELIVERY_STATUS
} from '../../utils/inventoryConstants.js';

export const WHATSAPP_MESSAGES_COLLECTION = 'whatsapp_messages';

/** Prefix so a dispatch id is recognisable on sight, like every other doc id here. */
export const DISPATCH_ID_PREFIX = 'wmd_';

/**
 * Keys that must never reach this collection. The document is built from an
 * explicit shape below, so an extra key is already dropped rather than written
 * — this list exists so that a future caller passing one FAILS LOUDLY instead
 * of being quietly ignored. A silent drop would hide the mistake until an audit
 * discovered the field had been arriving for months.
 */
const FORBIDDEN_KEYS = Object.freeze([
  'raw_token', 'rawToken', 'token', 'token_hash',
  'raw_code', 'challenge_code', 'verification_code', 'code',
  'access_token', 'accessToken', 'app_secret', 'appSecret',
  'whatsapp_e164', 'phone', 'phone_number', 'phoneNumber',
  'msisdn', 'sender_id', 'senderId', 'to', 'recipient'
]);

/** Firestore/gRPC signals an existing document on create() as ALREADY_EXISTS (6). */
function isAlreadyExists(err) {
  return err && (err.code === 6 || err.code === 'already-exists' || /ALREADY_EXISTS/i.test(String(err.message || '')));
}

function requiredString(value, label, max = 400) {
  const s = String(value ?? '').trim();
  if (!s) throw new RepositoryError(`${label} is required`, 'VALIDATION_ERROR', 400);
  if (s.length > max) throw new RepositoryError(`${label} is too long`, 'VALIDATION_ERROR', 400);
  return s;
}

function optionalString(value, max = 400) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > max) throw new RepositoryError('value is too long', 'VALIDATION_ERROR', 400);
  return s;
}

/**
 * hasOwnProperty, never a bare lookup: a bare lookup resolves through the
 * prototype chain, so 'constructor', 'toString' and '__proto__' would pass as
 * valid enum members and be written as a state no query ever matches. This is
 * the same defect that was found and fixed in the H5 event repository.
 */
function assertMember(enumObject, value, label) {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(enumObject, value)) {
    throw new RepositoryError(`Unknown ${label} '${value}'`, 'VALIDATION_ERROR', 400);
  }
  return enumObject[value];
}

/** Refuses a payload carrying anything secret, by name, before it can be written. */
function assertNoForbiddenKeys(data) {
  if (!data || typeof data !== 'object') return;
  for (const key of Object.keys(data)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new RepositoryError(
        `'${key}' must never be stored on a WhatsApp dispatch record`,
        'FORBIDDEN_FIELD',
        400
      );
    }
  }
}

// ── Deterministic id ─────────────────────────────────────────────────────────

/**
 * The dispatch id for one (request, authority, purpose).
 *
 * Deterministic: the same three inputs always produce the same id, which is
 * what makes create() a duplicate-send guard rather than a race. Different
 * purposes, authorities or requests produce different ids, so a review
 * notification and a decision prompt for the same pair never collide.
 *
 * The components are joined with NUL, which cannot occur in any of them. A
 * plain concatenation would make ("ab","c") and ("a","bc") the same dispatch.
 */
export function buildDispatchId({ request_id, authority_id, purpose } = {}) {
  const requestId = requiredString(request_id, 'request_id');
  const authorityId = requiredString(authority_id, 'authority_id');
  const validPurpose = assertMember(WHATSAPP_DISPATCH_PURPOSE, purpose, 'dispatch purpose');

  const material = [validPurpose, requestId, authorityId].join('\u0000');
  const digest = crypto.createHash('sha256').update(material, 'utf8').digest('hex');
  return `${DISPATCH_ID_PREFIX}${digest}`;
}

/** Validates an id that is being read back, without recomputing it. */
export function assertUsableDispatchId(value) {
  const id = requiredString(value, 'dispatch_id');
  if (!new RegExp(`^${DISPATCH_ID_PREFIX}[0-9a-f]{64}$`).test(id)) {
    throw new RepositoryError(`'${id}' is not a usable dispatch id`, 'VALIDATION_ERROR', 400);
  }
  return id;
}

export function dispatchRef(dispatchId) {
  return db.collection(WHATSAPP_MESSAGES_COLLECTION).doc(assertUsableDispatchId(dispatchId));
}

// ── The claim ────────────────────────────────────────────────────────────────

/**
 * Claims one outbound dispatch, exactly once, BEFORE anything is sent.
 *
 * create() — not set() — because set() would overwrite an existing claim and
 * hand the same recipient a second copy of the same notification.
 *
 * Returns rather than throws on a duplicate, because a duplicate is a normal
 * outcome: two workers, a retried request, or a redelivered job all reach here
 * legitimately and all must result in exactly one message.
 *
 * @returns {{ claimed: boolean, duplicate: boolean, dispatch_id: string }}
 */
export async function claimDispatchFirestore(data = {}) {
  assertNoForbiddenKeys(data);

  const purpose = assertMember(WHATSAPP_DISPATCH_PURPOSE, data.purpose, 'dispatch purpose');
  const requestId = requiredString(data.request_id, 'request_id');
  const authorityId = requiredString(data.authority_id, 'authority_id');
  const dispatchId = buildDispatchId({ request_id: requestId, authority_id: authorityId, purpose });
  const now = new Date().toISOString();

  // Built from an explicit shape: a key not named here cannot be written, so a
  // caller cannot extend this collection by accident.
  const doc = {
    dispatch_id: dispatchId,
    direction: WHATSAPP_DISPATCH_DIRECTION.OUTBOUND,
    purpose,
    authority_id: authorityId,
    request_id: requestId,
    request_number: optionalString(data.request_number, 64),
    template_name: optionalString(data.template_name, 200),
    send_state: WHATSAPP_SEND_STATE.CLAIMED,
    provider_message_id: null,
    delivery_status: null,
    delivery_updated_at: null,
    bridge_consumed_at: null,
    bridge_mint_count: 0,
    created_at: now,
    updated_at: now
  };

  try {
    await db.collection(WHATSAPP_MESSAGES_COLLECTION).doc(dispatchId).create(doc);
    return { claimed: true, duplicate: false, dispatch_id: dispatchId };
  } catch (err) {
    if (isAlreadyExists(err)) return { claimed: false, duplicate: true, dispatch_id: dispatchId };
    throw err;
  }
}

// ── Send outcome ─────────────────────────────────────────────────────────────

/**
 * Records that the send succeeded and what Meta called the message.
 *
 * Kept separate from the claim because a claim and its outcome are different
 * facts: a row claimed but never marked is precisely the "we do not know what
 * happened" signal that H8-A exists to make visible.
 */
export async function recordProviderMessageIdFirestore(dispatchId, providerMessageId) {
  const id = assertUsableDispatchId(dispatchId);
  return await updateDoc(WHATSAPP_MESSAGES_COLLECTION, id, {
    provider_message_id: requiredString(providerMessageId, 'provider_message_id'),
    send_state: WHATSAPP_SEND_STATE.SENT
  });
}

/**
 * Records a send outcome that is not a success: FAILED when Meta refused, and
 * UNKNOWN when the call timed out and the message may or may not have been
 * accepted. UNKNOWN is never retried automatically — see the H8 specification.
 */
export async function markDispatchSendStateFirestore(dispatchId, sendState) {
  const id = assertUsableDispatchId(dispatchId);
  const state = assertMember(WHATSAPP_SEND_STATE, sendState, 'send state');
  return await updateDoc(WHATSAPP_MESSAGES_COLLECTION, id, { send_state: state });
}

// ── Delivery, as reported by Meta ────────────────────────────────────────────

/**
 * Meta reports delivery in lower case on the wire ('sent', 'delivered',
 * 'read', 'failed'); every enum in this project is upper case. Normalising
 * here, once, keeps the wire vocabulary out of the rest of the codebase.
 * Anything unrecognised is refused rather than stored.
 */
export function normalizeDeliveryStatus(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  return assertMember(WHATSAPP_DELIVERY_STATUS, raw, 'delivery status');
}

/**
 * Phase H8-E — delivery is a one-way lifecycle, so a receipt may only ever move
 * it FORWARD. Meta can redeliver a webhook and can deliver receipts out of
 * order, so a late 'sent' must never undo a 'read' that already arrived.
 *
 * FAILED ranks highest and is terminal: once a message is reported failed,
 * nothing reopens it.
 */
export const DELIVERY_STATUS_RANK = Object.freeze({
  SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4
});

/** The timestamp each state stamps, recorded once, on first arrival. */
const DELIVERY_TIMESTAMP_FIELD = Object.freeze({
  SENT: 'sent_at', DELIVERED: 'delivered_at', READ: 'read_at', FAILED: 'failed_at'
});

/** Outcomes of applying one receipt. None of them throws for an expected case. */
export const DELIVERY_APPLY = Object.freeze({
  APPLIED: 'APPLIED',
  NOT_FOUND: 'NOT_FOUND',
  IGNORED_STALE: 'IGNORED_STALE',
  INVALID: 'INVALID'
});

/** Provider error text is theirs, not ours: single-line, clamped, never trusted. */
export const PROVIDER_ERROR_MAX = 200;
export function sanitizeProviderError(value) {
  const s = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length <= PROVIDER_ERROR_MAX ? s : s.slice(0, PROVIDER_ERROR_MAX - 1) + '…';
}

/**
 * Applies one delivery receipt to the dispatch that produced the message.
 *
 * Correlation is by PROVIDER MESSAGE ID only. A receipt for an id we never
 * recorded touches nothing and creates nothing: there is no path here that
 * writes a document which did not already exist, so a forged or unknown id
 * cannot manufacture an outbound record.
 *
 * The read and the write share one transaction, so two receipts arriving at
 * once cannot both decide they are the newer one.
 *
 * Transport state ONLY. This never reads or writes a purchase request, a token,
 * an authority or a verification, and it cannot: none of them is reachable from
 * this file.
 *
 * @returns {{ outcome: string, dispatch_id: string|null, from: string|null, to: string|null }}
 */
export async function applyDeliveryStatusFirestore(providerMessageId, { status, error_code = null, error_message = null } = {}) {
  const wanted = String(providerMessageId ?? '').trim();
  if (!wanted) return { outcome: DELIVERY_APPLY.INVALID, dispatch_id: null, from: null, to: null };

  let normalized;
  try { normalized = normalizeDeliveryStatus(status); }
  catch { return { outcome: DELIVERY_APPLY.INVALID, dispatch_id: null, from: null, to: null }; }

  const snap = await db.collection(WHATSAPP_MESSAGES_COLLECTION)
    .where('provider_message_id', '==', wanted).limit(1).get();
  if (snap.empty) {
    // Deliberately nothing: no document is created for an id we never sent.
    return { outcome: DELIVERY_APPLY.NOT_FOUND, dispatch_id: null, from: null, to: null };
  }
  const ref = snap.docs[0].ref;

  return await db.runTransaction(async (txn) => {
    const fresh = await txn.get(ref);
    if (!fresh.exists) return { outcome: DELIVERY_APPLY.NOT_FOUND, dispatch_id: null, from: null, to: null };
    const current = formatDocSnapshot(fresh);
    const from = current.delivery_status || null;
    const currentRank = from ? (DELIVERY_STATUS_RANK[from] || 0) : 0;
    const nextRank = DELIVERY_STATUS_RANK[normalized];

    // Forward only. A duplicate or a late receipt is recorded as ignored, which
    // is what makes redelivery harmless rather than destructive.
    if (nextRank <= currentRank) {
      return { outcome: DELIVERY_APPLY.IGNORED_STALE, dispatch_id: current.dispatch_id, from, to: from };
    }

    const now = new Date().toISOString();
    const updates = {
      delivery_status: normalized,
      delivery_updated_at: now,
      updated_at: now,
      // Stamped once: an existing timestamp is the first time we heard it.
      [DELIVERY_TIMESTAMP_FIELD[normalized]]: current[DELIVERY_TIMESTAMP_FIELD[normalized]] || now
    };
    if (normalized === WHATSAPP_DELIVERY_STATUS.FAILED) {
      updates.provider_error_code = error_code === null || error_code === undefined ? null : String(error_code).slice(0, 64);
      updates.provider_error_message = sanitizeProviderError(error_message);
    }
    txn.update(ref, updates);
    return { outcome: DELIVERY_APPLY.APPLIED, dispatch_id: current.dispatch_id, from, to: normalized };
  });
}

/**
 * Updates transport state and NOTHING else. A delivery receipt never touches a
 * purchase request, a token or a decision: an undelivered notification means
 * the message did not arrive, not that the request was refused.
 */
export async function updateDeliveryStatusFirestore(dispatchId, status) {
  const id = assertUsableDispatchId(dispatchId);
  const normalized = normalizeDeliveryStatus(status);
  return await updateDoc(WHATSAPP_MESSAGES_COLLECTION, id, {
    delivery_status: normalized,
    delivery_updated_at: new Date().toISOString()
  });
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getDispatchFirestore(dispatchId, options = {}) {
  return await getDoc(WHATSAPP_MESSAGES_COLLECTION, assertUsableDispatchId(dispatchId), options);
}

/** Read half for a caller's transaction, matching the other repositories here. */
export async function readDispatchInTxn(txn, dispatchId) {
  const ref = dispatchRef(dispatchId);
  const snap = await txn.get(ref);
  return { ref, doc: snap.exists ? formatDocSnapshot(snap) : null };
}

/**
 * Resolves an inbound tap's `context.id` back to the dispatch that produced it.
 *
 * A single equality filter on one field. Firestore maintains single-field
 * indexes automatically, so this needs no entry in firestore.indexes.json —
 * which is the reason to resist adding any query here that combines fields.
 */
export async function findDispatchByProviderMessageIdFirestore(providerMessageId) {
  const wanted = requiredString(providerMessageId, 'provider_message_id');
  const snap = await db.collection(WHATSAPP_MESSAGES_COLLECTION)
    .where('provider_message_id', '==', wanted)
    .limit(1)
    .get();
  return snap.empty ? null : formatDocSnapshot(snap.docs[0]);
}

// ── The bridge counter ───────────────────────────────────────────────────────

/**
 * Compare-and-increment for the mint counter, in one transaction.
 *
 * This is a persistence primitive, not a policy: the CALLER supplies the
 * ceiling. The repository only guarantees that two concurrent taps cannot both
 * read the same count and both mint — which a bare increment could not.
 *
 * `bridge_consumed_at` records the FIRST honoured tap and is never overwritten,
 * so it stays a fact about when the authority first responded.
 *
 * @returns {{ granted: boolean, count: number, reason: string|null }}
 */
export async function claimBridgeMintFirestore(dispatchId, { maxMints } = {}) {
  const id = assertUsableDispatchId(dispatchId);
  const ceiling = Number.isInteger(maxMints) && maxMints > 0
    ? maxMints
    : (() => { throw new RepositoryError('maxMints must be a positive integer', 'VALIDATION_ERROR', 400); })();

  return await db.runTransaction(async (txn) => {
    const ref = db.collection(WHATSAPP_MESSAGES_COLLECTION).doc(id);
    const snap = await txn.get(ref);
    if (!snap.exists) return { granted: false, count: 0, reason: 'NOT_FOUND' };

    const current = formatDocSnapshot(snap);
    const count = Number.isInteger(current.bridge_mint_count) ? current.bridge_mint_count : 0;
    if (count >= ceiling) return { granted: false, count, reason: 'MINT_LIMIT_REACHED' };

    const now = new Date().toISOString();
    txn.update(ref, {
      bridge_mint_count: count + 1,
      bridge_consumed_at: current.bridge_consumed_at || now,
      updated_at: now
    });
    return { granted: true, count: count + 1, reason: null };
  });
}

/**
 * Every dispatch for one request, for reconciliation and for the read-only
 * status display. Filters on a single field and orders by document id, which
 * Firestore satisfies from its automatic indexes with no composite index.
 */
export async function listDispatchesForRequestFirestore(requestId, { limit = 50 } = {}) {
  const wanted = requiredString(requestId, 'request_id');
  const snap = await db.collection(WHATSAPP_MESSAGES_COLLECTION)
    .where('request_id', '==', wanted)
    .orderBy(FieldPath.documentId())
    .limit(limit)
    .get();
  return snap.docs.map(formatDocSnapshot);
}
