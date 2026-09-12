/**
 * backend/repositories/firestore/whatsappWebhookEventsRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H5 — exactly-once claiming of an inbound webhook event.
 *
 *   whatsapp_webhook_events/{event_id}
 *     event_id, event_type, meta_message_id, delivery_digest,
 *     status, claimed_at, processed_at, error_code, created_at
 *
 * WHY THIS EXISTS
 * Meta re-delivers a webhook it did not get a 2xx for, and can deliver the same
 * event more than once regardless. Without a claim, a retry would run the
 * downstream work twice. Since the downstream work in H7 is "record an approval
 * decision", twice is not acceptable.
 *
 * THE CLAIM IS THE FIRST THING THAT HAPPENS
 * `create()` fails if the document already exists, so the claim is atomic in
 * one write with no read and no transaction. Claiming BEFORE processing is the
 * deliberate choice:
 *
 *   crash AFTER claim, BEFORE processing  → the event is never processed
 *   claim AFTER processing instead        → a retry could process twice
 *
 * The first failure mode is recoverable and harmless: the approval token the
 * event refers to is still unconsumed, so the approver simply taps again and a
 * new event id arrives. The second is a duplicate decision. H5 therefore claims
 * first, and a stuck CLAIMED row is a visible operational signal rather than a
 * silent double-decision.
 *
 * WHAT IS NOT STORED
 * Not the payload. An inbound WhatsApp payload carries phone numbers and
 * message text, none of which this phase needs, so only a digest of the
 * delivery is kept — enough to correlate a duplicate, useless to a reader.
 *
 * Firestore rules deny clients both read and write; every access is Admin SDK.
 */

import crypto from 'crypto';
import { db } from '../../config/firebaseAdmin.js';
import { getDoc, updateDoc, RepositoryError } from './firestoreUtils.js';

export const WHATSAPP_WEBHOOK_EVENTS_COLLECTION = 'whatsapp_webhook_events';

/** Lifecycle of one claimed event. H5 only ever writes CLAIMED. */
export const WEBHOOK_EVENT_STATUS = Object.freeze({
  CLAIMED: 'CLAIMED',
  PROCESSED: 'PROCESSED',
  FAILED: 'FAILED'
});

/** Firestore/gRPC signals an existing document on create() as ALREADY_EXISTS (6). */
function isAlreadyExists(err) {
  return err && (err.code === 6 || err.code === 'already-exists' || /ALREADY_EXISTS/i.test(String(err.message || '')));
}

function requiredId(value, label) {
  const s = String(value ?? '').trim();
  if (!s) throw new RepositoryError(`${label} is required`, 'VALIDATION_ERROR', 400);
  // Firestore document ids may not contain '/', and '.'/'..' are reserved.
  if (s.includes('/') || s === '.' || s === '..') {
    throw new RepositoryError(`${label} '${s}' is not a usable document id`, 'VALIDATION_ERROR', 400);
  }
  if (s.length > 400) throw new RepositoryError(`${label} is too long`, 'VALIDATION_ERROR', 400);
  return s;
}

/** A non-reversible fingerprint of one delivery, safe to store and to compare. */
export function digestDelivery(rawBody) {
  if (!Buffer.isBuffer(rawBody)) return null;
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

/**
 * Claims one inbound event, exactly once.
 *
 * @returns {{ claimed: boolean, duplicate: boolean, event_id: string }}
 *   `claimed:true` means THIS call won the claim and owns the downstream work.
 *   `duplicate:true` means the event was already claimed and must be ignored.
 *   Neither throws, because a duplicate is a normal, expected outcome.
 */
export async function claimWebhookEventFirestore(eventId, data = {}) {
  const id = requiredId(eventId, 'event_id');
  const now = new Date().toISOString();
  const doc = {
    event_id: id,
    event_type: data.event_type ? String(data.event_type) : null,
    meta_message_id: data.meta_message_id ? String(data.meta_message_id) : null,
    delivery_digest: data.delivery_digest ? String(data.delivery_digest) : null,
    status: WEBHOOK_EVENT_STATUS.CLAIMED,
    claimed_at: now,
    processed_at: null,
    error_code: null,
    created_at: now
  };

  try {
    // create() — NOT set() — because set() would silently overwrite an existing
    // claim and hand the same event to a second processor.
    await db.collection(WHATSAPP_WEBHOOK_EVENTS_COLLECTION).doc(id).create(doc);
    return { claimed: true, duplicate: false, event_id: id };
  } catch (err) {
    if (isAlreadyExists(err)) return { claimed: false, duplicate: true, event_id: id };
    throw err;
  }
}

/**
 * Records the outcome of the downstream work. H7 calls this; H5 does not, and
 * the separation is intentional — a claim and its outcome are different facts.
 */
export async function markWebhookEventFirestore(eventId, { status, errorCode = null } = {}) {
  const id = requiredId(eventId, 'event_id');
  // hasOwnProperty, not a bare lookup: a bare lookup resolves through the
  // prototype chain, so 'constructor', 'toString' and friends would pass and be
  // written as a status no operator query for CLAIMED/PROCESSED/FAILED matches.
  if (!Object.prototype.hasOwnProperty.call(WEBHOOK_EVENT_STATUS, status)) {
    throw new RepositoryError(`Unknown webhook event status '${status}'`, 'VALIDATION_ERROR', 400);
  }
  return await updateDoc(WHATSAPP_WEBHOOK_EVENTS_COLLECTION, id, {
    status,
    error_code: errorCode ? String(errorCode) : null,
    processed_at: new Date().toISOString()
  });
}

export async function getWebhookEventFirestore(eventId, options = {}) {
  return await getDoc(WHATSAPP_WEBHOOK_EVENTS_COLLECTION, requiredId(eventId, 'event_id'), options);
}
