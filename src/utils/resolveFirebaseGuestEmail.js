/**
 * src/utils/resolveFirebaseGuestEmail.js
 * ============================================================================
 * Firebase guest email resolution utility — Phase 3 Step 3D-3.
 *
 * Implements the EXACT same deterministic email mapping established in
 * Phase 3 Step 3D-1 (provisionGuestFirebaseAuth.mjs) and
 * Phase 3 Step 3D-2 (provisionGuestFirebaseAtSignup in authController.js).
 *
 * UID strategy:   guest_${users.id}
 * Email strategy:
 *   1. If username contains '@' → use username directly as email
 *   2. Else → username@hpms-sky5.internal
 *
 * IMPORTANT: This function does NOT perform MySQL lookups.
 * It maps only from the login username/email entered by the user.
 * It mirrors the provisioning-time logic exactly so the email matches
 * what was registered in Firebase Auth during Step 3D-1 or Step 3D-2.
 *
 * Domain notes:
 *   - Staff accounts use @hotelsky5.com or @hpms-sky5.internal
 *   - Guest accounts always use @hpms-sky5.internal (synthetic internal domain)
 *   - If the guest registered with an '@' username, that exact email is used
 *
 * @param {string} username  The login identifier entered by the guest
 *                           (username, email, phone, or any login handle)
 * @returns {string}         The Firebase Auth email address to sign in with
 */
export function resolveFirebaseGuestEmail(username) {
  if (!username || typeof username !== 'string') return '';
  const clean = username.trim().toLowerCase();
  if (!clean) return '';

  // Strategy 1: Username contains '@' → use directly as email
  if (clean.includes('@')) {
    return clean;
  }

  // Strategy 2: Synthetic internal email (matches Step 3D-1 provisioning)
  return `${clean}@hpms-sky5.internal`;
}

/**
 * Validates that a Firebase ID token's decoded claims identify a guest account.
 *
 * SECURITY CONTRACT:
 *   The guest login path must NOT authenticate staff or admin accounts.
 *   If the returned user object from /api/auth/me does not identify a guest,
 *   the login MUST be rejected to prevent privilege escalation.
 *
 * @param {object} user  The user object returned by /api/auth/me
 * @returns {{ valid: boolean, error: string|null }}
 */
export function validateGuestClaims(user) {
  if (!user) {
    return { valid: false, error: 'No user identity returned from server.' };
  }

  const role      = String(user.role      || '').toLowerCase();
  const userType  = String(user.user_type || user.type || '').toLowerCase();
  const loginType = String(user.loginType || '').toLowerCase();

  // Must be explicitly guest on all three axes
  if (role !== 'guest') {
    return { valid: false, error: 'This login portal is for guests only. Please use the Staff Portal.' };
  }
  if (userType !== 'guest') {
    return { valid: false, error: 'This login portal is for guests only. Please use the Staff Portal.' };
  }
  // loginType may be 'guest' or empty for legacy tokens — reject only known staff types
  if (loginType === 'staff' || loginType === 'admin') {
    return { valid: false, error: 'This login portal is for guests only. Please use the Staff Portal.' };
  }

  return { valid: true, error: null };
}

/**
 * Maps Firebase Auth error codes to user-friendly messages for the guest portal.
 * Mirrors the pattern already established for staff in AuthCard.jsx.
 *
 * @param {Error} err  Firebase Auth error
 * @returns {string}   User-friendly error message
 */
export function mapFirebaseGuestAuthError(err) {
  const code = err?.code || '';

  if (
    code === 'auth/invalid-credential' ||
    code === 'auth/wrong-password' ||
    code === 'auth/user-not-found' ||
    code === 'auth/invalid-email'
  ) {
    return 'Invalid username or password.';
  }
  if (code === 'auth/user-disabled') {
    return 'Your guest account has been disabled. Please contact the front desk.';
  }
  if (code === 'auth/too-many-requests') {
    return 'Too many failed login attempts. Please try again later.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Network error. Please check your connection and try again.';
  }
  if (code === 'auth/operation-not-allowed') {
    return 'Guest Firebase login is not configured. Please use username/password.';
  }
  if (code === 'FIREBASE_GUEST_ACCOUNT_NOT_FOUND') {
    return 'Your guest account has not been set up for online login yet. Please contact the front desk.';
  }
  // User-friendly backend messages pass through unchanged
  if (err?.message && !err.message.startsWith('Firebase:')) {
    return err.message;
  }
  return 'Authentication failed. Please try again.';
}
