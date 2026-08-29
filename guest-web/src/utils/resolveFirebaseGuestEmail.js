/**
 * guest-web/src/utils/resolveFirebaseGuestEmail.js
 * ============================================================================
 * Firebase guest email resolution & error mapping utility for standalone Guest Web.
 * Mirrors the proven implementation in the main application.
 */

export function resolveFirebaseGuestEmail(username) {
  if (!username || typeof username !== 'string') return '';
  const clean = username.trim().toLowerCase();
  if (!clean) return '';

  if (clean.includes('@')) {
    return clean;
  }

  return `${clean}@hpms-sky5.internal`;
}

export function validateGuestClaims(user) {
  if (!user) {
    return { valid: false, error: 'No user identity returned from server.' };
  }

  const role      = String(user.role      || '').toLowerCase();
  const userType  = String(user.user_type || user.type || '').toLowerCase();
  const loginType = String(user.loginType || '').toLowerCase();

  if (role !== 'guest') {
    return { valid: false, error: 'This login portal is for guests only.' };
  }
  if (userType !== 'guest') {
    return { valid: false, error: 'This login portal is for guests only.' };
  }
  if (loginType === 'staff' || loginType === 'admin') {
    return { valid: false, error: 'This login portal is for guests only.' };
  }

  return { valid: true, error: null };
}

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
    return 'Guest Firebase login is not configured. Please contact the front desk.';
  }
  if (code === 'FIREBASE_GUEST_ACCOUNT_NOT_FOUND') {
    return 'Your guest account has not been set up for online login yet. Please contact the front desk.';
  }
  if (err?.message && !err.message.startsWith('Firebase:')) {
    return err.message;
  }
  return 'Authentication failed. Please try again.';
}
