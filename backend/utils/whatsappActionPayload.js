/**
 * backend/utils/whatsappActionPayload.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H7 — the identifier that rides on a WhatsApp interactive control.
 *
 * Deliberately pure: no Firebase, no Express, no I/O and NO LOGGING. Like the
 * signature and verification-code utilities, this file handles a secret (the
 * raw action token travels inside the payload), so it has no logging at all
 * rather than logging carefully.
 *
 * WHAT A PAYLOAD IS, AND IS NOT
 * It is an opaque identifier Meta stores against a button or list row and
 * echoes back verbatim when the authority taps it. It is NOT identity: the
 * deciding authority is always resolved from the Meta-attested sender, never
 * from anything in here. A payload therefore carries only "which action, on
 * which token" — never a uid, a phone number, a request id or a display name.
 *
 * WHY THE RAW TOKEN IS IN THE PAYLOAD, NOT A HANDLE
 * A 43-character token fits inside Meta's identifier limits with room to spare
 * (see MAX_ACTION_PAYLOAD_LENGTH), so a server-side handle would add a
 * Firestore collection and a lookup to solve a problem that does not exist.
 * The token alone is not a capability: H3 refuses it unless the sender resolves
 * to the authority it was minted for.
 *
 * WHY THE LABELS ARE SEPARATE
 * The payload is machine-only. Button and list TITLES are written by the
 * router and never contain a token, so nothing secret is displayed on screen
 * or quoted back into a chat transcript.
 *
 * FAIL CLOSED
 * Parsing returns a verdict object and never throws. Anything that is not
 * exactly a well-formed payload is `ok:false`, so a stray chat message can
 * never be mistaken for an action.
 */

import { TOKEN_PATTERN } from './approvalActionToken.js';

/** Namespace and version. A future shape change bumps this, never reuses it. */
export const ACTION_PAYLOAD_PREFIX = 'hpms.v1';

/**
 * Meta's documented limits differ by control: a reply-button identifier allows
 * more than a list-row identifier. This is the stricter of the two, so one
 * payload is valid in either place. Verify against current documentation when
 * the outbound templates are built in H8.
 */
export const MAX_ACTION_PAYLOAD_LENGTH = 200;

/** The three things an authority can tap. Short codes keep the payload small. */
export const WHATSAPP_ACTION = Object.freeze({
  APPROVE: 'ap',
  REJECT: 'rj',
  REASON: 'rr'
});

/** Why a payload could not be parsed. Never distinguishes more than it must. */
export const PAYLOAD_INVALID = Object.freeze({
  MALFORMED: 'MALFORMED',
  NOT_AN_ACTION: 'NOT_AN_ACTION',
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  TOO_LONG: 'TOO_LONG'
});

/** A reason code as the server defines them: upper snake case, bounded. */
const REASON_CODE_PATTERN = /^[A-Z][A-Z_]{2,39}$/;

/** The token alphabet excludes '.', so the separator can never appear inside a field. */
const SEPARATOR = '.';

function tokenOrNull(rawToken) {
  return typeof rawToken === 'string' && TOKEN_PATTERN.test(rawToken) ? rawToken : null;
}

function build(action, rawToken, suffix = null) {
  const token = tokenOrNull(rawToken);
  if (!token) return null;
  if (suffix !== null && !REASON_CODE_PATTERN.test(suffix)) return null;
  const payload = [ACTION_PAYLOAD_PREFIX, action, token, ...(suffix === null ? [] : [suffix])].join(SEPARATOR);
  return payload.length <= MAX_ACTION_PAYLOAD_LENGTH ? payload : null;
}

/** Approve this request, using this decision token. */
export function buildApprovePayload(rawToken) {
  return build(WHATSAPP_ACTION.APPROVE, rawToken);
}

/** Begin a rejection, using this decision token. Consumes nothing by itself. */
export function buildRejectPayload(rawToken) {
  return build(WHATSAPP_ACTION.REJECT, rawToken);
}

/** Complete a rejection: the reason-capture intent plus the chosen reason code. */
export function buildReasonPayload(intentToken, reasonCode) {
  return build(WHATSAPP_ACTION.REASON, intentToken, String(reasonCode || '').trim().toUpperCase());
}

/**
 * Parses an identifier Meta echoed back.
 *
 * @returns {{ ok: true, action: string, token: string, reason_code: string|null }}
 *        | {{ ok: false, reason: string }}
 */
export function parseActionPayload(payload) {
  if (typeof payload !== 'string' || payload.length === 0) {
    return { ok: false, reason: PAYLOAD_INVALID.MALFORMED };
  }
  if (payload.length > MAX_ACTION_PAYLOAD_LENGTH) {
    return { ok: false, reason: PAYLOAD_INVALID.TOO_LONG };
  }
  const parts = payload.split(SEPARATOR);
  // 'hpms' '.' 'v1' are two parts; the namespace check is exact, so anything
  // that merely looks similar is not an action rather than a bad action.
  if (parts.length < 4 || `${parts[0]}${SEPARATOR}${parts[1]}` !== ACTION_PAYLOAD_PREFIX) {
    return { ok: false, reason: PAYLOAD_INVALID.NOT_AN_ACTION };
  }

  const action = parts[2];
  const token = tokenOrNull(parts[3]);
  if (!token) return { ok: false, reason: PAYLOAD_INVALID.MALFORMED };

  if (action === WHATSAPP_ACTION.APPROVE || action === WHATSAPP_ACTION.REJECT) {
    if (parts.length !== 4) return { ok: false, reason: PAYLOAD_INVALID.MALFORMED };
    return { ok: true, action, token, reason_code: null };
  }

  if (action === WHATSAPP_ACTION.REASON) {
    if (parts.length !== 5) return { ok: false, reason: PAYLOAD_INVALID.MALFORMED };
    const reasonCode = parts[4];
    if (!REASON_CODE_PATTERN.test(reasonCode)) return { ok: false, reason: PAYLOAD_INVALID.MALFORMED };
    return { ok: true, action, token, reason_code: reasonCode };
  }

  return { ok: false, reason: PAYLOAD_INVALID.UNKNOWN_ACTION };
}

/** True when a string is shaped like one of our payloads, without parsing it fully. */
export function looksLikeActionPayload(payload) {
  return typeof payload === 'string'
    && payload.length <= MAX_ACTION_PAYLOAD_LENGTH
    && payload.startsWith(`${ACTION_PAYLOAD_PREFIX}${SEPARATOR}`);
}
