/**
 * approvalActionToken.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H2 — the secret half of an approval action.
 *
 * Deliberately pure and dependency-free: no Firebase, no I/O, no logging. That
 * keeps it unit-testable without a project, and it keeps the one function that
 * handles a secret small enough to read in full.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * The raw token is returned to its creator exactly once and is never written
 * anywhere. Firestore stores only the SHA-256 hash, which is also the document
 * id — so a lookup is a single getDoc rather than a query, and an attacker with
 * full read access to the collection still holds nothing they can present.
 *
 * Nothing here logs. A `console.log` of a raw token would defeat the entire
 * design, so the file has no logging at all rather than logging carefully.
 */

import crypto from 'crypto';

/** 32 bytes. Below this the hash becomes worth attacking offline. */
export const TOKEN_BYTES = 32;

/** base64url of 32 bytes: 43 characters, no padding. */
export const TOKEN_LENGTH = 43;

/** What a well-formed token looks like coming back off the wire. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * A fresh secret. `randomBytes` is the CSPRNG; Math.random, timestamps, uuid v1
 * and the PR number are all predictable and must never be used here.
 *
 * base64url rather than hex: same entropy in 43 characters instead of 64, and
 * safe in a URL or a WhatsApp button payload without escaping.
 */
export function generateRawToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * The stored form. Deterministic, so a presented token resolves to exactly one
 * document id, and one-way, so the stored value is useless if the collection
 * leaks.
 *
 * Throws on anything that is not a well-formed token, so a malformed value
 * fails here rather than hashing to a plausible-looking id and costing a read.
 */
export function hashToken(rawToken) {
  if (typeof rawToken !== 'string' || !TOKEN_PATTERN.test(rawToken)) {
    const err = new Error('Malformed approval token.');
    err.code = 'MALFORMED_TOKEN';
    err.status = 400;
    throw err;
  }
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * True when the string is shaped like a token. Lets a caller reject junk before
 * spending a Firestore read, without revealing whether any given hash exists.
 */
export function isWellFormedToken(rawToken) {
  return typeof rawToken === 'string' && TOKEN_PATTERN.test(rawToken);
}
