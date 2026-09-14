/**
 * inventoryConstants.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Reusable constant definitions for the Inventory Management module.
 *
 * Phase A (foundation) additions: movement types, reference types, role
 * matrix and the stock-status vocabulary. Everything that existed before is
 * preserved so older readers keep working.
 */

/**
 * LEGACY unit vocabulary (pre Phase A). Kept only so legacy product documents
 * that still carry these values remain readable. New products must reference
 * an active document in the `inventory_units` collection (see
 * inventoryUnitsRepository.js); this list is NOT used for validation anymore.
 */
export const VALID_UNITS = [
  'Kg',
  'Gram',
  'Liter',
  'Ml',
  'Packet',
  'Piece',
  'Dozen',
  'Box',
  'Other'
];

export const VALID_STATUSES = ['Active', 'Inactive'];

export const VALID_DEPARTMENTS = [
  'Administration',
  'Front Office',
  'Kitchen',
  'Pantry',
  'Housekeeping',
  'Maintenance',
  'General'
];

// ── Stock movements ──────────────────────────────────────────────────────────

/** Every movement type the ledger engine understands (sign = effect on balance). */
export const MOVEMENT_TYPES = Object.freeze({
  OPENING:      { code: 'OPENING',      sign: +1, label: 'Opening stock' },
  RECEIPT:      { code: 'RECEIPT',      sign: +1, label: 'Goods receipt' },
  RETURN:       { code: 'RETURN',       sign: +1, label: 'Return to stock' },
  TRANSFER_IN:  { code: 'TRANSFER_IN',  sign: +1, label: 'Transfer in' },
  CONSUMPTION:  { code: 'CONSUMPTION',  sign: -1, label: 'Consumption' },
  WASTAGE:      { code: 'WASTAGE',      sign: -1, label: 'Wastage / damage' },
  TRANSFER_OUT: { code: 'TRANSFER_OUT', sign: -1, label: 'Transfer out' },
  /**
   * Phase G — compensates a goods receipt that was recorded in error. It never
   * edits or deletes the original RECEIPT movement: the ledger stays
   * append-only and the correction is a new, opposite entry that links back to
   * the receipt it cancels.
   */
  REVERSAL:     { code: 'REVERSAL',     sign: -1, label: 'Goods receipt reversal' },
  /** ADJUSTMENT carries its own sign in `quantity` (positive = add, negative = remove). */
  ADJUSTMENT:   { code: 'ADJUSTMENT',   sign: 0,  label: 'Manual adjustment' }
});

export const ALL_MOVEMENT_TYPES = Object.freeze(Object.keys(MOVEMENT_TYPES));

/**
 * Movement types that can be created through the public Phase A API.
 * RECEIPT / CONSUMPTION / WASTAGE / RETURN are reserved for later phases
 * (goods receipt, food/KDS deduction, wastage workflow) and are rejected by
 * the HTTP layer even though the ledger engine already understands them.
 */
export const PHASE_A_MOVEMENT_TYPES = Object.freeze(['OPENING', 'ADJUSTMENT', 'TRANSFER_IN', 'TRANSFER_OUT']);

/** Adjustment reasons offered by the UI (free text is still accepted). */
export const ADJUSTMENT_REASONS = Object.freeze([
  'Physical count correction',
  'Data entry correction',
  'Damaged / expired',
  'Sample / complimentary',
  'Other'
]);

/** Reference types a movement can point at (what caused it). */
export const REFERENCE_TYPES = Object.freeze([
  'MANUAL',          // ad-hoc adjustment / opening stock entered by a user
  'TRANSFER',        // paired TRANSFER_OUT / TRANSFER_IN
  'PURCHASE_ORDER',  // reserved — later phase
  'GOODS_RECEIPT',   // reserved — later phase
  'FOOD_ORDER',      // reserved — later phase
  'HOUSEKEEPING',    // reserved — later phase
  'MAINTENANCE'      // reserved — later phase
]);

/** Quantities are stored with at most this many decimals (0.25 KG, 1.3 KG …). */
export const QUANTITY_DECIMALS = 3;

export function roundQuantity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  const f = Math.pow(10, QUANTITY_DECIMALS);
  return Math.round(n * f) / f;
}

// ── Stock status ─────────────────────────────────────────────────────────────

export const STOCK_STATUS = Object.freeze({
  NORMAL: 'NORMAL',
  LOW:    'LOW_STOCK',
  OUT:    'OUT_OF_STOCK'
});

/** current_stock <= minimum_stock_level → LOW_STOCK; <= 0 → OUT_OF_STOCK. */
export function computeStockStatus(currentStock, minimumStockLevel) {
  const cur = Number(currentStock) || 0;
  const min = Number(minimumStockLevel) || 0;
  if (cur <= 0) return STOCK_STATUS.OUT;
  if (cur <= min) return STOCK_STATUS.LOW;
  return STOCK_STATUS.NORMAL;
}

// ── RBAC (normalized role names produced by authController.normalizeUserRole) ──
//
//  super_admin automatically inherits 'admin' inside requireRole, but it is
//  listed explicitly here so the matrix documents itself.

export const INVENTORY_ROLES = Object.freeze({
  /** Stock screen, movement history, category/unit/location lists. */
  VIEW:   Object.freeze(['admin', 'super_admin', 'receptionist', 'kitchen', 'housekeeper']),
  /** Categories, units, locations, products, suppliers, opening stock. */
  MANAGE: Object.freeze(['admin', 'super_admin']),
  /** Adjustments and transfers. */
  MOVE:   Object.freeze(['admin', 'super_admin', 'kitchen', 'housekeeper']),
  /**
   * Phase B — create and view purchase requests. Approval is NOT granted by
   * this role set; approving belongs to Phase C and has no endpoint yet.
   */
  REQUEST: Object.freeze(['admin', 'super_admin', 'receptionist', 'kitchen', 'housekeeper'])
});

// ── Purchase requests (Phase B) ──────────────────────────────────────────────
//
//  A PURCHASE REQUEST is a department asking for permission to buy. It is not
//  a purchase order, not a receipt, not a stock addition and not a payment —
//  nothing in this module may ever touch a stock balance or the ledger.

export const PR_STATUS = Object.freeze({
  DRAFT:            'DRAFT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  CANCELLED:        'CANCELLED',
  // Phase C — approval outcomes. Both are TERMINAL.
  APPROVED:         'APPROVED',
  REJECTED:         'REJECTED'
});

export const ALL_PR_STATUSES = Object.freeze(Object.values(PR_STATUS));

/**
 * Allowed state transitions.
 *
 * Phase B: DRAFT → PENDING_APPROVAL | CANCELLED.
 * Phase C: PENDING_APPROVAL → APPROVED | REJECTED, and nothing else.
 *
 * APPROVED and REJECTED are terminal: a rejected request is never returned to
 * DRAFT and is never edited — a replacement is raised as a NEW request (that
 * clone action is a later phase). PENDING_APPROVAL still cannot be edited or
 * cancelled, exactly as in Phase B. PURCHASE_ORDER_CREATED belongs to a later
 * phase and the server rejects any attempt to reach it.
 */
export const PR_TRANSITIONS = Object.freeze({
  DRAFT:            Object.freeze([PR_STATUS.PENDING_APPROVAL, PR_STATUS.CANCELLED]),
  PENDING_APPROVAL: Object.freeze([PR_STATUS.APPROVED, PR_STATUS.REJECTED]),
  CANCELLED:        Object.freeze([]),
  APPROVED:         Object.freeze([]),   // terminal
  REJECTED:         Object.freeze([])    // terminal
});

/** Statuses whose request document and line items are frozen. */
export const PR_IMMUTABLE_STATUSES = Object.freeze([
  PR_STATUS.PENDING_APPROVAL, PR_STATUS.APPROVED, PR_STATUS.REJECTED, PR_STATUS.CANCELLED
]);

/** The two decisions an approver can record. */
export const PR_APPROVAL_ACTIONS = Object.freeze({ APPROVED: 'APPROVED', REJECTED: 'REJECTED' });

/** Maps an approval action to the status the request lands in. */
export const PR_ACTION_TO_STATUS = Object.freeze({
  [PR_APPROVAL_ACTIONS.APPROVED]: PR_STATUS.APPROVED,
  [PR_APPROVAL_ACTIONS.REJECTED]: PR_STATUS.REJECTED
});

/**
 * Phase H4 — what an approval action token is FOR.
 *
 *   DECISION        the token a notified approver presents to record a
 *                   decision. This is every token H2 and H3 deal with.
 *   REASON_CAPTURE  a short-lived intent minted once an approver has chosen to
 *                   reject, which carries the mandatory reason back into the
 *                   same decision engine. It is never a decision on its own,
 *                   and it is useless without the rest of the checks.
 *
 * Tokens written before H4 carry no purpose field and are read as DECISION, so
 * existing behaviour is unchanged.
 */
export const PR_TOKEN_PURPOSES = Object.freeze({
  DECISION: 'DECISION',
  REASON_CAPTURE: 'REASON_CAPTURE'
});

/**
 * A reason-capture intent covers the few minutes between choosing to reject
 * and picking a reason. It is not a standing credential, so it expires far
 * sooner than the decision token that spawned it.
 */
export const PR_REASON_CAPTURE_TTL_MS = 10 * 60 * 1000;

/**
 * The ONLY rejection reasons a token-driven rejection may record.
 *
 * The approver chooses a CODE; the SERVER owns the words. Free text is
 * deliberately not accepted on this path, so a caller that holds nothing but a
 * token cannot write arbitrary words onto a purchase request it does not
 * otherwise control. Every string here clears MIN_REJECTION_REASON_LENGTH, so
 * the existing rejection rule is satisfied by construction rather than by
 * hoping the caller typed enough characters.
 *
 * Free-text rejection is a later phase, and it will need its own answer to
 * "who is allowed to put these words on the record".
 */
export const PR_REJECTION_REASON_CODES = Object.freeze({
  BUDGET_UNAVAILABLE:      'Budget is not available for this request.',
  ALREADY_IN_STOCK:        'These items are already in stock.',
  QUANTITY_TOO_HIGH:       'The quantity requested is higher than required.',
  SUPPLIER_OR_PRICE_WRONG: 'The supplier or price on this request is not acceptable.',
  NOT_REQUIRED_NOW:        'These items are not required at this time.',
  DUPLICATE_REQUEST:       'This duplicates another purchase request.'
});

/**
 * Phase H6 — approval authorities as EXTERNAL identities.
 *
 *   EXTERNAL  a person who approves over WhatsApp and never logs into HPMS.
 *             No Firebase account, no staff document, no role. Identity is a
 *             server-issued authority_id; the credential is a verified WhatsApp
 *             number. This is the only type the H6 registration path creates.
 *   INTERNAL  the pre-H6 shape, keyed by a staff uid and authorised by the
 *             staff role. Retained so the staff-based principal path stays
 *             explicit and selectable by STORED type — never by whether a
 *             staff lookup happens to succeed. Nothing in H6 creates one.
 *
 * External authority is never expressed as a staff role. A stored type is
 * immutable after creation.
 */
export const APPROVAL_AUTHORITY_TYPES = Object.freeze({
  EXTERNAL: 'EXTERNAL',
  INTERNAL: 'INTERNAL'
});

/** REGISTERED IS NOT VERIFIED: a new authority starts PENDING_VERIFICATION. */
export const APPROVAL_AUTHORITY_VERIFICATION = Object.freeze({
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  VERIFIED: 'VERIFIED',
  REVOKED: 'REVOKED'
});

/** How the number was proven: a one-time code that arrived FROM the number. */
export const WHATSAPP_VERIFICATION_METHOD = 'WHATSAPP_INBOUND_CODE';

/** A proven number stays proven for 180 days, then must be proven again. */
export const WHATSAPP_VERIFICATION_VALIDITY_MS = 180 * 24 * 60 * 60 * 1000;

/** A one-time code lives 15 minutes and survives at most 5 wrong guesses. */
export const WHATSAPP_VERIFICATION_CHALLENGE_TTL_MS = 15 * 60 * 1000;
export const WHATSAPP_VERIFICATION_MAX_ATTEMPTS = 5;
export const WHATSAPP_VERIFICATION_CODE_LENGTH = 8;

// ── Outbound WhatsApp correlation (Phase H8-A) ───────────────────────────────
//
//  One row per OUTBOUND dispatch, so that an inbound tap — which carries only
//  the id of the message its button belonged to — can be resolved back to a
//  request and an authority. Meta's template quick-reply buttons carry no
//  developer payload, so this correlation is the only way a tap is attributable.

/** Only outbound dispatches are recorded; inbound lives in whatsapp_webhook_events. */
export const WHATSAPP_DISPATCH_DIRECTION = Object.freeze({ OUTBOUND: 'OUTBOUND' });

/**
 * What a dispatch was for. Two purposes for the same request and authority are
 * two different dispatches, and therefore two different deterministic ids.
 */
export const WHATSAPP_DISPATCH_PURPOSE = Object.freeze({
  PR_REVIEW_NOTIFICATION: 'PR_REVIEW_NOTIFICATION',
  PR_DECISION_PROMPT: 'PR_DECISION_PROMPT'
});

/**
 * OUR side of the send. UNKNOWN is the honest answer when a call timed out and
 * Meta may or may not have accepted the message; it is reported, never retried
 * automatically, because retrying a billable message to a real person on a
 * guess is worse than surfacing it.
 */
export const WHATSAPP_SEND_STATE = Object.freeze({
  CLAIMED: 'CLAIMED',
  SENT: 'SENT',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN'
});

/**
 * META'S side, normalized to this project's upper-case convention on the way in.
 * Deliberately separate from send_state: transport state must never be mistaken
 * for, or promoted into, purchase-request business state.
 */
export const WHATSAPP_DELIVERY_STATUS = Object.freeze({
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  FAILED: 'FAILED'
});

/**
 * Fail-safe default when settings/inventory_pr_approval is missing or invalid:
 * only administrators may approve. This is deliberately NOT the Phase B
 * REQUEST role set — being able to raise a request must never imply being able
 * to approve one.
 */
export const DEFAULT_PR_APPROVER_ROLES = Object.freeze(['admin', 'super_admin']);

/**
 * The ONLY role names that may appear in settings/inventory_pr_approval
 * .allowed_roles. These are the normalized names produced by
 * authController.normalizeUserRole — a client cannot invent a privileged role
 * by writing an arbitrary string into the configuration.
 */
export const VALID_APPROVER_ROLES = Object.freeze(['admin', 'super_admin', 'receptionist', 'kitchen', 'housekeeper']);

/** Socket.IO events emitted by the purchase-request workflow (Phase D). */
export const PR_EVENTS = Object.freeze({
  SUBMITTED: 'inventory:purchase_request_submitted',
  DECIDED:   'inventory:purchase_request_decided'
});

/**
 * Phase H8-C — transport-only events for the WhatsApp notification fan-out.
 *
 * Deliberately separate from PR_EVENTS: these say something about a MESSAGE,
 * never about a purchase request. A failed notification means the message did
 * not arrive, not that the request was refused, and nothing here ever stands in
 * for DECIDED. They are display hints carrying no phone number and no secret,
 * and they grant nothing — the Staff Portal still authorises every call
 * server-side.
 */
export const PR_WHATSAPP_EVENTS = Object.freeze({
  QUEUED: 'inventory:purchase_request_whatsapp_queued',
  STATUS: 'inventory:purchase_request_whatsapp_status',
  FAILED: 'inventory:purchase_request_whatsapp_failed'
});

// ── Purchase orders (Phase E) ────────────────────────────────────────────────
//
//  A PURCHASE ORDER is the formal document sent to ONE supplier, created from
//  exactly ONE approved purchase request. It is still not a receipt and not a
//  payment: creating or issuing a PO never changes stock. Goods receiving —
//  the only step that may touch a balance — is Phase F.

export const PO_STATUS = Object.freeze({
  DRAFT:  'DRAFT',
  ISSUED: 'ISSUED',
  // Phase F — receiving outcomes.
  PARTIALLY_RECEIVED: 'PARTIALLY_RECEIVED',
  RECEIVED:           'RECEIVED',
  // Phase G — the buyer accepts that the outstanding balance will never
  // arrive. A purchasing decision, NOT a stock movement.
  CLOSED_SHORT:       'CLOSED_SHORT'
});

export const ALL_PO_STATUSES = Object.freeze(Object.values(PO_STATUS));

/**
 * Purchase order transitions.
 *
 * Phase E: DRAFT → ISSUED.
 * Phase F: receiving moves ISSUED → PARTIALLY_RECEIVED → RECEIVED.
 * Phase G: a receipt reversal recomputes the receiving position, so RECEIVED
 *   and PARTIALLY_RECEIVED can move BACK toward ISSUED — the status always
 *   describes what is actually received. A short close ends the order.
 *
 * ── WHAT THIS TABLE IS, AND IS NOT ─────────────────────────────────────────
 * Only DRAFT → ISSUED is GATED by this table (purchaseOrderService.issue).
 * Every receiving and correction outcome is DERIVED from the surviving
 * receipts, not chosen from a list: the status is whatever the effective
 * quantities imply. This table therefore documents the reachable set; it is
 * not the mechanism that produces it, and it must not be read as a whitelist
 * the correction paths consult.
 *
 * RECEIVED → RECEIVED is listed because it is genuinely reachable, not as a
 * formality: if one receipt over-delivered, reversing a DIFFERENT receipt can
 * leave every line still satisfied (ordered 10, A = 5, B = 12 → reverse A →
 * 12 remains → still RECEIVED). PARTIALLY_RECEIVED already self-transitions
 * for the analogous receiving case.
 *
 * Invariants that hold from every state: an order never returns to DRAFT, and
 * CLOSED_SHORT is terminal (reopening it is deliberately not implemented).
 */
export const PO_TRANSITIONS = Object.freeze({
  DRAFT:              Object.freeze([PO_STATUS.ISSUED]),
  ISSUED:             Object.freeze([PO_STATUS.PARTIALLY_RECEIVED, PO_STATUS.RECEIVED]),
  PARTIALLY_RECEIVED: Object.freeze([PO_STATUS.PARTIALLY_RECEIVED, PO_STATUS.RECEIVED, PO_STATUS.ISSUED, PO_STATUS.CLOSED_SHORT]),
  RECEIVED:           Object.freeze([PO_STATUS.RECEIVED, PO_STATUS.PARTIALLY_RECEIVED, PO_STATUS.ISSUED]),
  CLOSED_SHORT:       Object.freeze([])   // terminal
});

/** A purchase order may only be received against in these states. */
export const PO_RECEIVABLE_STATUSES = Object.freeze([PO_STATUS.ISSUED, PO_STATUS.PARTIALLY_RECEIVED]);

/** Counter prefix — kept separate from PR so the two sequences never collide. */
export const PO_NUMBER_PREFIX = 'PO';

// ── Goods receiving (Phase F) ────────────────────────────────────────────────
//
//  Receiving is the FIRST step in the purchasing chain that may change stock,
//  and it increases it by the quantity actually ACCEPTED — never by the
//  quantity ordered.

/** Counter prefix for goods receipts. */
export const GR_NUMBER_PREFIX = 'GR';

export const VARIANCE_TYPE = Object.freeze({
  /** Cumulative received still below the ordered quantity — the PO stays open. */
  SHORT: 'SHORT',
  /** Cumulative received exactly matches the ordered quantity. */
  EXACT: 'EXACT',
  /** Cumulative received exceeds the ordered quantity — a reason is mandatory. */
  OVER:  'OVER'
});

/** Roles permitted to receive goods against a purchase order. */
export const RECEIVING_ROLES = Object.freeze(['admin', 'super_admin', 'receptionist']);

// ── Receipt correction & short close (Phase G) ───────────────────────────────
//
//  Reversing a receipt un-does a stock increase, and closing an order short
//  writes off an outstanding balance. Both are corrective decisions with
//  lasting inventory/purchasing consequences, so they are deliberately
//  NARROWER than RECEIVING_ROLES: a receptionist may sign for a delivery but
//  may not undo one or abandon the remainder of an order.
export const REVERSAL_ROLES = Object.freeze(['admin', 'super_admin']);
export const SHORT_CLOSE_ROLES = Object.freeze(['admin', 'super_admin']);

/** A reversal or short-close reason must be real text, not blank padding. */
export const MIN_CORRECTION_REASON_LENGTH = 3;

/** A rejection must carry a real reason (auditable), not an empty string. */
export const MIN_REJECTION_REASON_LENGTH = 3;

export const PR_PRIORITIES = Object.freeze(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
export const DEFAULT_PR_PRIORITY = 'NORMAL';

/** Sanity cap on a single request line, so a typo cannot create an absurd request. */
export const MAX_REQUEST_QUANTITY = 1000000;
/** Cap on how many distinct product lines one request may carry. */
export const MAX_REQUEST_LINES = 200;

/** Money is stored to 2 decimals; quantities to QUANTITY_DECIMALS (3). */
export function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100) / 100;
}

/** Bounded fetch size for in-memory filtering of master lists (products, suppliers). */
export const MASTER_LIST_FETCH_CAP = 1000;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * Firestore evaluates an `in` filter against at most 30 values. Ten is well
 * under that and still covers every status enum in this module, so a caller
 * cannot construct a filter the database will reject.
 */
export const MAX_STATUS_FILTER_VALUES = 10;

/**
 * Parses a `?status=` query value into a validated list.
 *
 * Accepts what the API has always accepted — a single status string — and
 * additionally a comma-separated list or an array, so one request can ask for
 * several statuses at once. Values are upper-cased, trimmed and de-duplicated,
 * and order is preserved.
 *
 * Returns `{ statuses, invalid }`. `invalid` is non-empty when the caller named
 * something outside `allowed`; callers reject the request rather than silently
 * dropping the unknown value, which would answer a different question than the
 * one that was asked.
 */
export function parseStatusFilter(raw, allowed = []) {
  const parts = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const statuses = [];
  const invalid = [];
  for (const part of parts) {
    const value = String(part ?? '').trim().toUpperCase();
    if (!value) continue;
    if (!allowed.includes(value)) { if (!invalid.includes(value)) invalid.push(value); continue; }
    if (!statuses.includes(value)) statuses.push(value);
  }
  return { statuses, invalid };
}

// ── Phase H1 — supplier bill capture ─────────────────────────────────────────
// Additive only. Nothing above this line changes, and no A–G behaviour reads
// any of these constants.

/**
 * Lifecycle of an uploaded supplier bill. H1 only ever produces UPLOADED and
 * DISCARDED; the extraction and review states are declared here so the schema
 * is stable before H2–H6 fill them in.
 */
export const BILL_STATUS = Object.freeze({
  UPLOADED:          'UPLOADED',           // stored and hashed, nothing read yet
  EXTRACTING:        'EXTRACTING',         // H2 — OCR in flight
  EXTRACTED:         'EXTRACTED',          // H2 — raw text available
  EXTRACTION_FAILED: 'EXTRACTION_FAILED',  // H2 — usable as a manual entry form
  IN_REVIEW:         'IN_REVIEW',          // H4 — operator editing a draft
  // H5 — a confirmation is in flight. The PO path cannot write the bill and the
  // receipt in one transaction, because the Phase F engine owns its own; this
  // state is what makes the gap between them recoverable instead of permanent.
  // A bill is only ever CONFIRMING while a claim is outstanding, and the claim
  // records the exact receipt id the engine will produce.
  CONFIRMING:        'CONFIRMING',         // H5 — claimed, receipt not yet confirmed
  CONFIRMED:         'CONFIRMED',          // H5/H6 — a receipt exists, file immutable
  DISCARDED:         'DISCARDED'           // abandoned before confirmation
});

export const ALL_BILL_STATUSES = Object.freeze(Object.values(BILL_STATUS));

/**
 * A bill in one of these states has never moved stock, so its stored file may
 * still be removed. CONFIRMED is deliberately absent: once a receipt exists the
 * bill is evidence and the file becomes immutable, mirroring receipt
 * immutability in Phase G.
 */
export const BILL_DISCARDABLE_STATUSES = Object.freeze([
  BILL_STATUS.UPLOADED,
  BILL_STATUS.EXTRACTING,
  BILL_STATUS.EXTRACTED,
  BILL_STATUS.EXTRACTION_FAILED,
  BILL_STATUS.IN_REVIEW
]);
// CONFIRMING is deliberately absent above: a claimed bill may already have a
// receipt that this process has not yet observed, so discarding it could
// orphan real stock.

/**
 * How long a confirmation claim may stand before it is treated as abandoned.
 *
 * A Firestore transaction cannot outlive about a minute, and the Phase F engine
 * runs one transaction, so a claim older than this cannot still have work in
 * flight — the process that made it is gone. Generous on purpose: releasing a
 * claim that is merely slow is the one mistake that could let a second receipt
 * be created, so the recovery waits far longer than any real call can take.
 */
export const BILL_CONFIRMATION_STALE_MS = 15 * 60 * 1000;

/** Which receiving workflow the operator chose for a bill. Null until chosen (H4). */
export const BILL_MODE = Object.freeze({
  PO:     'PO',      // received against an existing purchase order (Option 1)
  DIRECT: 'DIRECT'   // PO-less direct receipt (Option 3)
});

/** Confidence bands for supplier and product matching. Declared for H3. */
export const MATCH_CONFIDENCE = Object.freeze({
  HIGH:      'HIGH',       // only this band may be pre-selected for the operator
  MEDIUM:    'MEDIUM',
  LOW:       'LOW',
  UNMATCHED: 'UNMATCHED'
});

/**
 * H7 — duplicate signals raised on a bill.
 *
 * Every one of these is a WARNING, never an automatic rejection. A hotel
 * legitimately receives a corrected reprint of an invoice, and a supplier
 * legitimately reuses an invoice number by mistake; silently refusing either
 * would push the operator into working around the system. What the signals do
 * instead is withhold confirmation until the operator names the signal they are
 * overriding and says why, which is then auditable.
 */
export const BILL_DUPLICATE_CODE = Object.freeze({
  // The stored file hashes to a value another bill already has. Two identical
  // photographs are a near-certain re-upload rather than two deliveries.
  FILE_DUPLICATE: 'FILE_DUPLICATE',
  // supplier + invoice number + invoice date all match an existing bill.
  INVOICE_DUPLICATE: 'INVOICE_DUPLICATE',
  // Same supplier and invoice number, different date. Usually a correction.
  INVOICE_NUMBER_REUSED: 'INVOICE_NUMBER_REUSED',
  // No invoice number at all. Never fabricated from a timestamp or file name;
  // the operator must acknowledge receiving against an unnumbered document.
  MISSING_INVOICE_NUMBER: 'MISSING_INVOICE_NUMBER'
});

export const ALL_BILL_DUPLICATE_CODES = Object.freeze(Object.values(BILL_DUPLICATE_CODE));

/**
 * A duplicate override must carry a real explanation. Short enough that a
 * genuine reason fits, long enough that "ok" does not.
 */
export const MIN_DUPLICATE_OVERRIDE_REASON = 10;

/** Bills in these states are ignored when looking for duplicates. */
export const BILL_DUPLICATE_IGNORED_STATUSES = Object.freeze([
  BILL_STATUS.DISCARDED
]);

/** Raw OCR text is capped before storage so a bill document stays small. */
export const BILL_OCR_TEXT_MAX = 20000;
