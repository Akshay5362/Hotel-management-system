import { auth, isFirebaseConfigured } from '../config/firebaseAdmin.js';

/**
 * Express middleware to verify Firebase ID Token from Authorization header:
 * Authorization: Bearer <Firebase ID token>
 *
 * Does NOT replace legacy JWT auth.
 * Fails gracefully if Firebase is not configured or token is missing/invalid.
 */
export const verifyFirebaseAuth = async (req, res, next) => {
  if (!isFirebaseConfigured || !auth) {
    return res.status(503).json({
      error: 'Firebase Authentication is not configured on this server.',
      code: 'FIREBASE_NOT_CONFIGURED'
    });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({
      error: 'Authorization header is missing',
      code: 'NO_AUTH_HEADER'
    });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({
      error: 'Invalid Authorization header format. Expected "Bearer <token>"',
      code: 'INVALID_HEADER_FORMAT'
    });
  }

  const token = parts[1];

  try {
    const decodedToken = await auth.verifyIdToken(token);
    req.firebaseUser = decodedToken;
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || null,
      role: decodedToken.role || 'guest',
      type: decodedToken.user_type || (decodedToken.role === 'guest' ? 'guest' : 'staff'),
      id: decodedToken.mysql_id || null,
      mysql_id: decodedToken.mysql_id || null,
      authProvider: 'firebase'
    };
    return next();
  } catch (error) {
    console.warn('[FirebaseAuthMiddleware] Token verification failed:', error.message);
    return res.status(401).json({
      error: 'Invalid or expired Firebase ID token',
      code: 'INVALID_FIREBASE_TOKEN'
    });
  }
};
