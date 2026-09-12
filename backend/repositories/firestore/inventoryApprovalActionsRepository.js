/**
 * inventoryApprovalActionsRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H2 — one-time approval action tokens.
 *
 * Document id: SHA-256(raw token), hex.
 *
 *   inventory_approval_actions/{sha256}
 *     pr_id, pr_number, approver_uid, action,
 *     token_hash, expires_at, consumed_at, consumed_via,
 *     meta_message_id, created_at, created_by
 *
 * The raw token is returned to the caller once, at creation, and is never
 * stored. The hash IS the id, so presenting a token is a single getDoc rather
 * than a query, and a full read of this collection yields nothing presentable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A TOKEN IS NOT AUTHORIZATION.
 *
 * It proves only that the bearer received a specific message about a specific
 * request. Before any decision is recorded, H3 must additionally establish:
 *
 *   1. the staff record behind approver_uid still exists and is active
 *   2. that staff member's CURRENT role still passes roleCanApprove() against
 *      settings/inventory_pr_approval — never a copy taken at send time
 *   3. an active H1 authority record exists for them
 *   4. the verified identity matches approver_uid
 *   5. the purchase request is still PENDING_APPROVAL
 *   6. the requested action matches this token's action
 *
 * Nothing in this file performs any of those checks, and nothing here writes to
 * a purchase request. H3 must route the decision through the existing
 * PurchaseRequestApprovalService, which owns assertCanApprove(), the
 * self-approval block and first-valid-decision-wins. There is deliberately no
 * function here that approves anything.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Firestore rules deny clients both read and write; every access is Admin SDK.
 */

import { getDoc, listDocs, setDoc, updateDoc, RepositoryError } from './firestoreUtils.js';
import { db } from '../../config/firebaseAdmin.js';
import { PR_APPROVAL_ACTIONS, PR_TOKEN_PURPOSES } from '../../utils/inventoryConstants.js';
import { generateRawToken, hashToken, isWellFormedToken } from '../../utils/approvalActionToken.js';

export const APPROVAL_ACTIONS_COLLECTION = 'inventory_approval_actions';

/**
 * The action vocabulary is the EXISTING PR_APPROVAL_ACTIONS (APPROVED /
 * REJECTED), not a new APPROVE / REJECT pair. A token's action is handed
 * straight to PurchaseRequestApprovalService in H3, so a second spelling would
 * mean a translation step between two vocabularies for one concept — exactly
 * the kind of divergence H1 avoided for identity. The imperative forms are
 * accepted as INPUT aliases and normalised on the way in, so a caller may say
 * either, but only the canonical value is ever stored.
 */
const ACTION_ALIASES = Object.freeze({
  APPROVE: PR_APPROVAL_ACTIONS.APPROVED,
  APPROVED: PR_APPROVAL_ACTIONS.APPROVED,
  REJECT: PR_APPROVAL_ACTIONS.REJECTED,
  REJECTED: PR_APPROVAL_ACTIONS.REJECTED
});

export function normalizeAction(action) {
  const key = String(action || '').trim().toUpperCase();
  const resolved = ACTION_ALIASES[key];
  if (!resolved) {
    throw new RepositoryError(
      `Approval action must be APPROVED or REJECTED (got '${action}')`,
      'VALIDATION_ERROR',
      400
    );
  }
  return resolved;
}

/**
 * Phase H4 — a token's purpose. A document written before H4 has no purpose
 * field and IS a decision token, so the absent value reads as DECISION rather
 * than as invalid. That is what keeps every H2/H3 token working untouched.
 */
export function tokenPurpose(doc) {
  return (doc && doc.purpose) || PR_TOKEN_PURPOSES.DECISION;
}

function normalizePurpose(purpose) {
  if (purpose === undefined || purpose === null || purpose === '') return PR_TOKEN_PURPOSES.DECISION;
  const key = String(purpose).trim().toUpperCase();
  if (!PR_TOKEN_PURPOSES[key]) {
    throw new RepositoryError(
      `Approval action purpose must be DECISION or REASON_CAPTURE (got '${purpose}')`,
      'VALIDATION_ERROR',
      400
    );
  }
  return PR_TOKEN_PURPOSES[key];
}

function required(value, label) {
  const s = value === undefined || value === null ? '' : String(value).trim();
  if (!s) throw new RepositoryError(`${label} is required`, 'VALIDATION_ERROR', 400);
  return s;
}

function futureIso(value, label) {
  const s = required(value, label);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new RepositoryError(`${label} must be an ISO-8601 timestamp`, 'VALIDATION_ERROR', 400);
  if (t <= Date.now()) throw new RepositoryError(`${label} must be in the future`, 'VALIDATION_ERROR', 400);
  return new Date(t).toISOString();
}

/** Why a token cannot be used. Never distinguishes "no such hash" to a caller. */
export const ACTION_INVALID = Object.freeze({
  MALFORMED: 'MALFORMED',
  NOT_FOUND: 'NOT_FOUND',
  EXPIRED: 'EXPIRED',
  CONSUMED: 'CONSUMED',
  INCOMPLETE: 'INCOMPLETE',
  PURPOSE_MISMATCH: 'PURPOSE_MISMATCH'
});

/**
 * Pure verdict over an already-fetched document. Shared by every read path.
 *
 * `expectedPurpose` is checked before the lifecycle so that presenting a
 * decision token where an intent is required is reported as the category error
 * it is, rather than leaking whether that unrelated token happens to be spent.
 * Passing null keeps the pre-H4 behaviour, which is what the standalone
 * consume primitive still wants.
 */
function evaluate(doc, nowMs = Date.now(), expectedPurpose = null) {
  if (!doc) return { valid: false, reason: ACTION_INVALID.NOT_FOUND };
  if (expectedPurpose && tokenPurpose(doc) !== expectedPurpose) {
    return { valid: false, reason: ACTION_INVALID.PURPOSE_MISMATCH };
  }
  if (doc.consumed_at) return { valid: false, reason: ACTION_INVALID.CONSUMED };
  if (!doc.expires_at || Date.parse(doc.expires_at) <= nowMs) {
    return { valid: false, reason: ACTION_INVALID.EXPIRED };
  }
  if (!doc.pr_id || !doc.approver_uid || !ACTION_ALIASES[doc.action]) {
    return { valid: false, reason: ACTION_INVALID.INCOMPLETE };
  }
  return { valid: true, action: doc };
}

// ── Creation ────────────────────────────────────────────────────────────────

/**
 * Mints one action and returns its raw token EXACTLY ONCE.
 *
 * The returned `raw_token` is the only copy that will ever exist. It is not
 * stored, not logged, and cannot be recovered — if the caller loses it, mint a
 * new action and invalidate this one.
 */
export async function createApprovalActionFirestore(data, options = {}) {
  const payload = {
    pr_id: required(data.pr_id, 'pr_id'),
    pr_number: required(data.pr_number, 'pr_number'),
    approver_uid: required(data.approver_uid, 'approver_uid'),
    action: normalizeAction(data.action),
    expires_at: futureIso(data.expires_at, 'expires_at'),
    created_by: required(data.created_by, 'created_by')
  };

  // Phase H4 — a reason-capture intent is structurally a token, so it lives in
  // this same collection rather than a parallel one. What makes it an intent
  // and not a decision is enforced here, once, at the only place either is
  // created: it must name the decision token it descends from, and it may only
  // ever carry REJECTED, because approval needs no second step.
  const purpose = normalizePurpose(data.purpose);
  const parentTokenHash = data.parent_token_hash === undefined || data.parent_token_hash === null
    ? null
    : required(data.parent_token_hash, 'parent_token_hash');

  if (purpose === PR_TOKEN_PURPOSES.REASON_CAPTURE) {
    if (!parentTokenHash) {
      throw new RepositoryError('A reason-capture intent requires parent_token_hash', 'VALIDATION_ERROR', 400);
    }
    if (payload.action !== PR_APPROVAL_ACTIONS.REJECTED) {
      throw new RepositoryError('A reason-capture intent may only carry REJECTED', 'VALIDATION_ERROR', 400);
    }
  } else if (parentTokenHash) {
    throw new RepositoryError('Only a reason-capture intent may carry parent_token_hash', 'VALIDATION_ERROR', 400);
  }

  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);

  const doc = {
    ...payload,
    purpose,
    parent_token_hash: parentTokenHash,
    token_hash: tokenHash,
    consumed_at: null,
    consumed_via: data.consumed_via ?? null,
    meta_message_id: data.meta_message_id ?? null,
    created_at: new Date().toISOString()
  };

  // merge:false — an action document is written once and only ever patched by
  // the consume primitive afterwards.
  await setDoc(APPROVAL_ACTIONS_COLLECTION, tokenHash, doc, { ...options, merge: false });

  // The raw token rides out on the return value and nowhere else.
  return { raw_token: rawToken, token_hash: tokenHash, action: doc };
}

// ── Lookup / validation ─────────────────────────────────────────────────────

/**
 * Resolves a presented token.
 *
 * Returns `{ valid:false, reason }` for every failure rather than throwing, and
 * a malformed token is rejected before any read so junk costs nothing. The
 * caller must not surface `reason` verbatim to an external party: NOT_FOUND and
 * EXPIRED are useful to an operator and an enumeration oracle to an attacker.
 */
export async function findApprovalActionByTokenFirestore(rawToken, options = {}) {
  const { expectedPurpose = null, ...readOptions } = options;
  if (!isWellFormedToken(rawToken)) return { valid: false, reason: ACTION_INVALID.MALFORMED };
  const tokenHash = hashToken(rawToken);
  const doc = await getDoc(APPROVAL_ACTIONS_COLLECTION, tokenHash, readOptions);
  return { ...evaluate(doc, Date.now(), expectedPurpose), token_hash: tokenHash };
}

export async function getApprovalActionByHashFirestore(tokenHash, options = {}) {
  return await getDoc(APPROVAL_ACTIONS_COLLECTION, required(tokenHash, 'token_hash'), options);
}

// ── One-time consumption ────────────────────────────────────────────────────

/**
 * Standalone atomic consume. Two concurrent callers cannot both succeed: the
 * loser's transaction re-runs, sees `consumed_at` set, and returns CONSUMED.
 *
 * H3 should generally NOT use this. Consuming in its own transaction leaves a
 * window where the token is burnt but the decision then fails, stranding the
 * approver. Prefer the txn-scoped pair below so the token and the decision
 * commit together.
 */
export async function consumeApprovalActionFirestore(rawToken, { via = null, metaMessageId = null } = {}) {
  if (!isWellFormedToken(rawToken)) return { valid: false, reason: ACTION_INVALID.MALFORMED };
  const tokenHash = hashToken(rawToken);
  const ref = db.collection(APPROVAL_ACTIONS_COLLECTION).doc(tokenHash);

  return await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const doc = snap.exists ? { id: snap.id, ...snap.data() } : null;
    const verdict = evaluate(doc);
    if (!verdict.valid) return { ...verdict, token_hash: tokenHash };

    const consumedAt = new Date().toISOString();
    txn.update(ref, { consumed_at: consumedAt, consumed_via: via, meta_message_id: metaMessageId });
    return { valid: true, token_hash: tokenHash, action: { ...doc, consumed_at: consumedAt, consumed_via: via } };
  });
}

/**
 * Read half of the transaction-scoped pair. MUST be called during a
 * transaction's read phase — Firestore requires every read before any write, so
 * calling this after a txn.update in the same transaction will throw.
 *
 * Intended H3 shape, inside the EXISTING approval transaction:
 *
 *   const prSnap  = await txn.get(prRef);            // reads first
 *   const verdict = await readApprovalActionInTxn(txn, tokenHash);
 *   ... existing status / self-approval / already-acted checks ...
 *   txn.update(prRef, updates);                      // then writes
 *   markApprovalActionConsumedInTxn(txn, tokenHash, { via });
 */
export async function readApprovalActionInTxn(txn, tokenHash, options = {}) {
  const { nowMs = Date.now(), expectedPurpose = null } = options;
  const ref = db.collection(APPROVAL_ACTIONS_COLLECTION).doc(required(tokenHash, 'token_hash'));
  const snap = await txn.get(ref);
  const doc = snap.exists ? { id: snap.id, ...snap.data() } : null;
  return { ...evaluate(doc, nowMs, expectedPurpose), token_hash: tokenHash, ref };
}

/** Write half. Call during the transaction's write phase. Synchronous. */
export function markApprovalActionConsumedInTxn(txn, tokenHash, { via = null, metaMessageId = null } = {}) {
  const ref = db.collection(APPROVAL_ACTIONS_COLLECTION).doc(required(tokenHash, 'token_hash'));
  txn.update(ref, {
    consumed_at: new Date().toISOString(),
    consumed_via: via,
    meta_message_id: metaMessageId
  });
}

// ── Invalidation ────────────────────────────────────────────────────────────

/**
 * Retires every outstanding action for one request — what H3 calls once a
 * request reaches a terminal status, is cancelled, or an authority is revoked.
 *
 * Scoped by pr_id, which the automatic single-field index already serves, so no
 * composite index is needed and no collection is scanned. The handful of
 * already-consumed rows are filtered in memory rather than with a second
 * `where`, precisely to avoid requiring `pr_id + consumed_at`.
 *
 * Invalidation reuses `consumed_at` rather than adding a parallel flag: a
 * retired token and a spent one are both simply unusable, and `consumed_via`
 * records which it was.
 */
export async function invalidateApprovalActionsForRequestFirestore(prId, { reason = 'PR_TERMINAL', approverUid = null } = {}) {
  const id = required(prId, 'pr_id');
  const filters = [{ field: 'pr_id', op: '==', value: id }];
  if (approverUid) filters.push({ field: 'approver_uid', op: '==', value: String(approverUid) });

  const docs = await listDocs(APPROVAL_ACTIONS_COLLECTION, { filters, limit: 50 });
  const outstanding = docs.filter(d => d && !d.consumed_at);
  const now = new Date().toISOString();

  for (const d of outstanding) {
    await updateDoc(APPROVAL_ACTIONS_COLLECTION, d.token_hash || d.id, {
      consumed_at: now,
      consumed_via: `INVALIDATED:${reason}`
    });
  }
  return { examined: docs.length, invalidated: outstanding.length };
}
