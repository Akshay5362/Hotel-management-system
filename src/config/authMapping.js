/**
 * src/config/authMapping.js
 * =========================================================================
 * Centralized Firebase Auth Email & User Identity Resolver for HPMS.
 * Maps usernames (e.g. 'reception_morning', 'admin') to provisioned Firebase Auth emails.
 */

export const USERNAME_EMAIL_MAP = {
  'admin': 'admin@hpms-sky5.internal',
  'superadmin': 'admin@hpms-sky5.internal',
  'keval': 'keval@hpms-sky5.internal',
  'reception_morning': 'reception.morning@hotelsky5.com',
  'reception_evening': 'reception.evening@hotelsky5.com',
  'reception_night': 'reception.night@hotelsky5.com',
  'chef': 'chef@hotelsky5.com',
  'helper': 'helper@hotelsky5.com',
  'pantry1': 'pantry1@hotelsky5.com',
  'pantry2': 'pantry2@hotelsky5.com',
  'cleaner1': 'cleaner1@hotelsky5.com',
  'cleaner2': 'cleaner2@hotelsky5.com',
  'reception2': 'reception2@hotelsky5.com',
  'akshay': 'akshay@hpms-sky5.internal'
};

/**
 * Resolves a username or email input string to a valid provisioned Firebase Auth email address.
 * @param {string} input Username or Email entered by user
 * @returns {string} Fully qualified Firebase Auth email address
 */
export function resolveFirebaseEmail(input) {
  if (!input || typeof input !== 'string') return '';
  const clean = input.trim().toLowerCase();
  if (clean.includes('@')) {
    return clean;
  }
  return USERNAME_EMAIL_MAP[clean] || `${clean}@hotelsky5.com`;
}

/**
 * Provides secondary fallback email for dual-account usernames (e.g., 'admin' system vs 'admin' staff).
 * @param {string} input Username
 * @returns {string|null} Alternate email or null
 */
export function resolveFallbackFirebaseEmail(input) {
  if (!input || typeof input !== 'string') return null;
  const clean = input.trim().toLowerCase();
  if (clean === 'admin') {
    return 'admin@hotelsky5.com'; // Staff Admin fallback
  }
  return null;
}
