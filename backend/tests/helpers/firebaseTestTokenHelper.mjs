/**
 * backend/tests/helpers/firebaseTestTokenHelper.mjs
 * ============================================================================
 * Centralized Firebase Test Token Generator for HPMS Integration & Unit Tests.
 *
 * Uses Firebase Admin SDK to mint custom tokens and exchanges them for authentic
 * Google RS256-signed Firebase ID tokens via Identity Toolkit REST API.
 *
 * Features:
 *  - 100% genuine Firebase ID tokens that pass auth.verifyIdToken()
 *  - In-memory caching for ultra-fast repeated test calls
 *  - Zero hardcoded passwords or mock tokens
 *  - Supports admin, super_admin, receptionist, housekeeping, kitchen, and guest roles
 */

import { auth, isFirebaseConfigured } from '../../config/firebaseAdmin.js';

const tokenCache = new Map();

const FIREBASE_WEB_API_KEY =
  process.env.FIREBASE_WEB_API_KEY ||
  process.env.VITE_FIREBASE_API_KEY ||
  'AIzaSyBWVlM8MgdWogVnvse7zmCITnIsp7_KXBs';

/**
 * Returns a valid Firebase ID token for the specified test identity/role.
 *
 * @param {object} options
 * @param {string} [options.role='admin']       - 'admin' | 'super_admin' | 'receptionist' | 'housekeeping' | 'cleaner' | 'kitchen' | 'staff' | 'guest'
 * @param {string} [options.uid]                - Custom Firebase UID (e.g. 'staff_1', 'user_1', 'guest_101')
 * @param {number} [options.id]                 - MySQL ID / numerical ID (default based on role)
 * @param {number} [options.mysql_id]           - MySQL user ID
 * @param {string} [options.type]               - 'staff' | 'guest' | 'admin'
 * @param {boolean} [options.isRootAdmin=false] - If true, maps to root super admin (UID 'user_1', mysql_id 1)
 * @param {object} [options.customClaims]       - Additional custom claims to attach
 * @returns {Promise<string>}                   - Authentic Firebase ID Token string
 */
export async function getTestFirebaseToken(options = {}) {
  if (!isFirebaseConfigured || !auth) {
    throw new Error('[firebaseTestTokenHelper] Firebase Admin SDK is not configured.');
  }

  let role = String(options.role || 'admin').toLowerCase();
  let isRootAdmin = Boolean(options.isRootAdmin || role === 'super_admin');
  let type = options.type || options.user_type || (role === 'guest' ? 'guest' : 'staff');
  
  if (role === 'super_admin') {
    role = 'admin';
    isRootAdmin = true;
    type = 'admin';
  } else if (role === 'cleaner') {
    role = 'housekeeping';
  } else if (['chef', 'kitchen_helper', 'pantry_boy'].includes(role)) {
    role = 'kitchen';
  }

  const id = options.id || options.mysql_id || (isRootAdmin ? 1 : (role === 'receptionist' ? 2 : (role === 'guest' ? (options.mysql_guest_id || 99) : 1)));
  const uid = options.uid || (isRootAdmin ? 'user_1' : (type === 'guest' ? `guest_${id}` : `staff_${id}`));

  const cacheKey = `${uid}:${role}:${type}:${isRootAdmin}:${id}`;
  const cached = tokenCache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now + 60000) {
    return cached.token;
  }

  // Construct standard claims matching HPMS Phase 3 specification
  const claims = {
    role: role,
    user_type: type,
    type: type,
    mysql_id: Number(id),
    ...(type === 'staff'
      ? {
          mysql_staff_id: Number(id),
          staff_id: uid.replace('staff_', '') || 'admin',
          staff_username: uid.replace('staff_', '') || 'admin',
          status: 'Active',
          deleted: 0
        }
      : {}),
    ...(type === 'guest'
      ? {
          mysql_guest_id: Number(id),
          guest_id: Number(id),
          loyalty_tier: 'Bronze',
          loyalty_points: 0
        }
      : {}),
    ...(options.customClaims || {})
  };

  // 1. Mint custom token with claims via Firebase Admin SDK
  const customToken = await auth.createCustomToken(uid, claims);

  // 2. Exchange custom token for real Firebase ID Token via Google Identity Toolkit REST API
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true })
    }
  );

  const data = await res.json();
  if (!res.ok || !data.idToken) {
    throw new Error(
      `[firebaseTestTokenHelper] Failed to exchange custom token (HTTP ${res.status}): ${JSON.stringify(data)}`
    );
  }

  const expiresInSec = Number(data.expiresIn) || 3600;
  tokenCache.set(cacheKey, {
    token: data.idToken,
    expiresAt: now + expiresInSec * 1000
  });

  return data.idToken;
}

export async function getAdminTestToken() {
  return getTestFirebaseToken({ role: 'admin', uid: 'staff_1', id: 1, type: 'staff' });
}

export async function getSuperAdminTestToken() {
  return getTestFirebaseToken({ role: 'super_admin', isRootAdmin: true, uid: 'user_1', id: 1, type: 'admin' });
}

export async function getReceptionistTestToken() {
  return getTestFirebaseToken({ role: 'receptionist', uid: 'staff_2', id: 2, type: 'staff' });
}

export async function getGuestTestToken(guestId = 99) {
  return getTestFirebaseToken({ role: 'guest', uid: `guest_${guestId}`, id: guestId, type: 'guest' });
}

export async function getHousekeeperTestToken() {
  return getTestFirebaseToken({ role: 'housekeeping', uid: 'staff_9', id: 9, type: 'staff' });
}

export default getTestFirebaseToken;
