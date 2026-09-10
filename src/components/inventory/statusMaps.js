/**
 * statusMaps.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One place that says what every backend status means to a person and how it
 * should look. Every value here is a status the backend actually stores; the
 * labels are display text only. Nothing is invented — a request that has been
 * approved and later turned into an order is still APPROVED here, because
 * that is what the request document says.
 *
 * Tones map to .inv-badge modifiers: ok | warn | bad | info | neutral.
 * The label always carries the meaning, so a badge is readable without colour.
 */

export const STOCK_STATUS = {
  NORMAL:       { label: 'In stock',     tone: 'ok' },
  LOW_STOCK:    { label: 'Low',          tone: 'warn' },
  OUT_OF_STOCK: { label: 'Out of stock', tone: 'bad' }
};

export const PR_STATUS = {
  DRAFT:            { label: 'Draft',            tone: 'neutral' },
  PENDING_APPROVAL: { label: 'Pending approval', tone: 'warn' },
  APPROVED:         { label: 'Approved',         tone: 'ok' },
  REJECTED:         { label: 'Rejected',         tone: 'bad' },
  CANCELLED:        { label: 'Cancelled',        tone: 'neutral' }
};

export const PO_STATUS = {
  DRAFT:              { label: 'Draft',              tone: 'neutral' },
  ISSUED:             { label: 'Issued',             tone: 'info' },
  PARTIALLY_RECEIVED: { label: 'Partially received', tone: 'warn' },
  RECEIVED:           { label: 'Received',           tone: 'ok' },
  CLOSED_SHORT:       { label: 'Closed short',       tone: 'neutral' }
};

export const BILL_STATUS = {
  UPLOADED:          { label: 'Uploaded',        tone: 'neutral' },
  EXTRACTING:        { label: 'Reading',         tone: 'info' },
  EXTRACTED:         { label: 'Needs review',    tone: 'warn' },
  EXTRACTION_FAILED: { label: 'Enter manually',  tone: 'warn' },
  IN_REVIEW:         { label: 'In review',       tone: 'info' },
  CONFIRMED:         { label: 'Received',        tone: 'ok' },
  DISCARDED:         { label: 'Discarded',       tone: 'neutral' }
};

/** Bill states a person still has to do something about. */
export const BILL_OPEN_STATUSES = ['EXTRACTED', 'EXTRACTION_FAILED', 'IN_REVIEW'];

/** Purchase-order states a delivery can still be recorded against. */
export const PO_RECEIVABLE_STATUSES = ['ISSUED', 'PARTIALLY_RECEIVED'];

export const MOVEMENT_TYPE = {
  OPENING:      { label: 'Opening stock', tone: 'neutral' },
  ADJUSTMENT:   { label: 'Adjustment',    tone: 'info' },
  TRANSFER_IN:  { label: 'Transfer in',   tone: 'info' },
  TRANSFER_OUT: { label: 'Transfer out',  tone: 'info' },
  RECEIPT:      { label: 'Receipt',       tone: 'ok' },
  REVERSAL:     { label: 'Reversal',      tone: 'bad' },
  CONSUMPTION:  { label: 'Consumption',   tone: 'neutral' },
  WASTAGE:      { label: 'Wastage',       tone: 'warn' },
  RETURN:       { label: 'Return',        tone: 'neutral' }
};

/**
 * Match confidence from the bill matcher, expressed as what the operator has
 * to do rather than as a score. HIGH is the only band the server pre-selects.
 */
export const MATCH_CUE = {
  HIGH:      { label: 'Matched',         tone: 'ok',   glyph: '✓' },
  MEDIUM:    { label: 'Review',          tone: 'warn', glyph: '⚠' },
  LOW:       { label: 'Action required', tone: 'bad',  glyph: '✕' },
  UNMATCHED: { label: 'Action required', tone: 'bad',  glyph: '✕' }
};

export function statusOf(map, value, fallback = { label: String(value || '—'), tone: 'neutral' }) {
  return (value && map[value]) || fallback;
}
