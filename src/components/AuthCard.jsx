import React, { useState } from 'react';
import { API_BASE_URL, getApiHeaders } from '../config/apiConfig';
import { auth, signInWithEmailAndPassword, isClientConfigured } from '../config/firebaseClient';
import { resolveFirebaseEmail, resolveFallbackFirebaseEmail } from '../config/authMapping';
import {
  resolveFirebaseGuestEmail,
  validateGuestClaims,
  mapFirebaseGuestAuthError
} from '../utils/resolveFirebaseGuestEmail';


/**
 * Phase 3 Step 3C: Maps Firebase Auth error codes to user-friendly messages.
 * Prevents raw Firebase error codes from being shown to staff users.
 * Matches the existing backend error contract where possible.
 */
function mapFirebaseAuthError(err) {
  const code = err?.code || '';
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found' || code === 'auth/invalid-email') {
    return 'Invalid username or password.';
  }
  if (code === 'auth/user-disabled') {
    return 'Your account has been disabled. Please contact an administrator.';
  }
  if (code === 'auth/too-many-requests') {
    return 'Too many failed login attempts. Please try again later.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Network error. Please check your connection and try again.';
  }
  // Return the message if it's already user-friendly (from our backend /api/auth/me)
  if (err?.message && !err.message.startsWith('Firebase:')) {
    return err.message;
  }
  return 'Authentication failed. Please try again.';
}

export default function AuthCard({ isAdmin = false, initialIsSignUp = false, onAuthSuccess, showAlert, onNavigate }) {
  const [isSignUp, setIsSignUp] = useState(initialIsSignUp);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      showAlert('Username and password are required', 'Form Validation');
      return;
    }
    if (!isAdmin && isSignUp) {
      if (password.length < 8) {
        showAlert('Password must be at least 8 characters long.', 'Form Validation');
        return;
      }
      if (!/[A-Z]/.test(password)) {
        showAlert('Password must contain at least one uppercase letter.', 'Form Validation');
        return;
      }
      if (!/[a-z]/.test(password)) {
        showAlert('Password must contain at least one lowercase letter.', 'Form Validation');
        return;
      }
      if (!fullName.trim()) {
        showAlert('Full name is required to register', 'Form Validation');
        return;
      }
    }

    setIsLoading(true);

    // ── Phase 3 Step 3C: Staff/Admin Firebase Login ──────────────────────────────────────
    if (isAdmin && isClientConfigured && auth) {
      const emailToUse = resolveFirebaseEmail(username);

      try {
        let userCredential;
        try {
          userCredential = await signInWithEmailAndPassword(auth, emailToUse, password);
        } catch (primaryErr) {
          const fallbackEmail = resolveFallbackFirebaseEmail(username);
          if (fallbackEmail) {
            userCredential = await signInWithEmailAndPassword(auth, fallbackEmail, password);
          } else {
            throw primaryErr;
          }
        }

        const idToken = await userCredential.user.getIdToken(true);

        // ── Call /api/auth/me — server verifies token + resolves real role ──
        // Never use /api/status for identity: it returns no user object.
        // Never default unknown staff to 'admin'.
        const meRes = await fetch(`${API_BASE_URL}/api/auth/me`, {
          method: 'GET',
          headers: getApiHeaders(idToken)
        });

        if (!meRes.ok) {
          const meData = await meRes.json().catch(() => ({}));
          const errMsg = meData.error || `Identity verification failed (HTTP ${meRes.status})`;
          // 422 = role indeterminate — do NOT assign admin silently
          throw new Error(errMsg);
        }

        const meData = await meRes.json();
        if (!meData.user || !meData.user.role) {
          throw new Error('Server returned identity response with no role. Contact administrator.');
        }

        showAlert('Logged in successfully!', 'Authentication Success');
        onAuthSuccess(meData.user, idToken);
        setIsLoading(false);
        return;
      } catch (fbErr) {
        console.warn('[AuthCard] Firebase Client Auth login attempt failed/fallback:', fbErr.message);
        if (fbErr.message && (fbErr.message.includes('inactive') || fbErr.message.includes('Forbidden') || fbErr.message.includes('disabled') || fbErr.message.includes('Identity verification') || fbErr.message.includes('Role could not') || fbErr.message.includes('no role'))) {
          showAlert(fbErr.message, 'Authentication Error');
          setIsLoading(false);
          return;
        }
        // Phase 3 Step 3C: When Firebase-only staff login is enabled, do NOT fall through
        // to the legacy MySQL /api/auth/signin endpoint for staff. Show the Firebase error directly.
        const isFirebaseStaffLoginEnabled = import.meta.env?.VITE_ENABLE_FIREBASE_STAFF_LOGIN === 'true';
        if (isFirebaseStaffLoginEnabled) {
          const friendlyError = mapFirebaseAuthError(fbErr);
          showAlert(friendlyError, 'Authentication Error');
          setIsLoading(false);
          return;
        }
      }
    }

    // ── Phase 3 Step 3D-3: Guest Firebase Login ──────────────────────────────────────────
    // Activated only when VITE_ENABLE_FIREBASE_GUEST_LOGIN=true AND guest portal sign-in.
    // NEVER runs for staff/admin (isAdmin=true) — that path is above.
    // NEVER runs during guest signup (isSignUp=true) — signup goes directly to legacy path.
    //
    // SECURITY: After obtaining the ID token, we call /api/auth/me and validate
    // that the returned user has role='guest' and user_type='guest'.
    // Staff/admin tokens are REJECTED here even if they somehow reach this path.
    const isFirebaseGuestLoginEnabled = import.meta.env?.VITE_ENABLE_FIREBASE_GUEST_LOGIN === 'true';
    if (!isAdmin && !isSignUp && isFirebaseGuestLoginEnabled && isClientConfigured && auth) {
      const guestEmail = resolveFirebaseGuestEmail(username);
      if (!guestEmail) {
        showAlert('Could not resolve your guest account email. Please contact the front desk.', 'Authentication Error');
        setIsLoading(false);
        return;
      }

      try {
        // 1. Authenticate with Firebase using resolved guest email
        let userCredential;
        try {
          userCredential = await signInWithEmailAndPassword(auth, guestEmail, password);
        } catch (primaryErr) {
          if (
            primaryErr.code === 'auth/user-not-found' ||
            primaryErr.code === 'auth/invalid-credential' ||
            primaryErr.code === 'auth/wrong-password'
          ) {
            // Guest account may not have been provisioned yet — show a clean message
            // DO NOT fall through to legacy MySQL path when flag is ON
            const friendlyErr = mapFirebaseGuestAuthError(primaryErr);
            showAlert(friendlyErr, 'Authentication Error');
            setIsLoading(false);
            return;
          }
          throw primaryErr; // Re-throw unexpected errors (network, disabled, etc.)
        }

        // 2. Obtain a fresh ID token
        const idToken = await userCredential.user.getIdToken(true);

        // 3. Verify identity server-side and resolve canonical guest object
        const meRes = await fetch(`${API_BASE_URL}/api/auth/me`, {
          method: 'GET',
          headers: getApiHeaders(idToken)
        });

        if (!meRes.ok) {
          const meData = await meRes.json().catch(() => ({}));
          const errMsg = meData.error || `Identity verification failed (HTTP ${meRes.status})`;
          throw new Error(errMsg);
        }

        const meData = await meRes.json();
        if (!meData.user) {
          throw new Error('Server returned no user identity. Please try again.');
        }

        // 4. SECURITY: Validate returned claims are guest-only
        //    Reject staff/admin tokens that may have reached this path
        const claimsCheck = validateGuestClaims(meData.user);
        if (!claimsCheck.valid) {
          // Sign out the non-guest Firebase session immediately
          try { await auth.signOut?.() || await import('../config/firebaseClient').then(m => m.signOut(m.auth)); } catch (_) {}
          throw new Error(claimsCheck.error);
        }

        // 5. Success — deliver canonical guest user object + Firebase ID token to app
        showAlert('Logged in successfully!', 'Authentication Success');
        onAuthSuccess(meData.user, idToken);
        setIsLoading(false);
        return;

      } catch (fbErr) {
        console.warn('[AuthCard] Guest Firebase login error:', fbErr.message);
        const friendlyError = mapFirebaseGuestAuthError(fbErr);
        showAlert(friendlyError, 'Authentication Error');
        setIsLoading(false);
        return;
        // DO NOT fall through to legacy MySQL path when VITE_ENABLE_FIREBASE_GUEST_LOGIN=true
      }
    }

    // ── Legacy MySQL path (flag OFF, or signup, or Firebase unavailable) ─────────────────
    const endpoint = (!isAdmin && isSignUp) ? '/api/auth/signup' : '/api/auth/signin';
    
    // The frontend must not send the role for guest sign up
    const payload = (!isAdmin && isSignUp)
      ? { username, password, fullName, phone }
      : { username, password };

    try {
      const res = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: getApiHeaders(null, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Authentication failed');
      }

      showAlert(
        (!isAdmin && isSignUp) ? 'Registration successful! Logging you in...' : 'Logged in successfully!',
        'Authentication Success'
      );
      
      onAuthSuccess(data.user, data.token);
    } catch (err) {
      console.error(err);
      showAlert(err.message || 'Something went wrong', 'Authentication Error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      width: '100vw',
      background: 'radial-gradient(circle at center, #111827 0%, #030712 100%)',
      padding: '20px'
    }}>
      <div className="glass" style={{
        width: '100%',
        maxWidth: '420px',
        borderRadius: '16px',
        padding: '30px 25px',
        boxShadow: '0 20px 40px rgba(0, 0, 0, 0.5), 0 0 20px rgba(56, 189, 248, 0.1)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        backdropFilter: 'blur(20px)'
      }}>
        {/* Title */}
        <div style={{ textAlign: 'center', marginBottom: '25px' }}>
          <div style={{ fontSize: '3rem', marginBottom: '10px' }}>{isAdmin ? '🛡️' : '🏢'}</div>
          <h2 style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: '1.6rem', color: '#fff', letterSpacing: '0.5px' }}>
            {isAdmin ? 'Staff Portal' : 'Guest Portal'}
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '4px' }}>
            {isAdmin ? 'Webline PMS Plus Administration' : 'Luxury Room Booking & Reservations'}
          </p>
        </div>

        {/* Tab Switcher - only show for Guest Portal (not Admin Portal) */}
        {!isAdmin && (
          <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', padding: '4px', borderRadius: '8px', marginBottom: '20px', border: '1px solid var(--border-color)' }}>
            <button 
              onClick={() => { setIsSignUp(false); setUsername(''); setPassword(''); }}
              style={{
                flex: 1,
                padding: '8px 0',
                border: 'none',
                background: !isSignUp ? 'var(--accent-grad)' : 'transparent',
                color: !isSignUp ? '#fff' : 'var(--text-secondary)',
                borderRadius: '6px',
                fontWeight: '600',
                fontSize: '0.85rem',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
            >
              Sign In
            </button>
            <button 
              onClick={() => { setIsSignUp(true); setUsername(''); setPassword(''); }}
              style={{
                flex: 1,
                padding: '8px 0',
                border: 'none',
                background: isSignUp ? 'var(--accent-grad)' : 'transparent',
                color: isSignUp ? '#fff' : 'var(--text-secondary)',
                borderRadius: '6px',
                fontWeight: '600',
                fontSize: '0.85rem',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
            >
              Sign Up
            </button>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} autoComplete="off" style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
          
          <div className="form-group">
            <label style={{ fontSize: '0.75rem', marginBottom: '4px' }}>
              {(!isAdmin && isSignUp) ? 'Choose a Login ID (email, phone, or any handle)' : 'Username, Email, or Phone'}
            </label>
            <input 
              type="text" 
              placeholder={(!isAdmin && isSignUp) ? 'e.g. amit@gmail.com or 9876543210' : 'Enter username, email, or phone'}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="off"
              style={{ padding: '10px 14px', background: 'rgba(0,0,0,0.4)', borderColor: 'var(--border-color)' }}
            />
            {(!isAdmin && isSignUp) && (
              <p style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '4px', lineHeight: '1.4' }}>
                🔑 This is what you’ll use to sign in. Must be unique — use your email or phone for best results.
              </p>
            )}
          </div>

          <div className="form-group">
            <label style={{ fontSize: '0.75rem', marginBottom: '4px' }}>Password</label>
            <input 
              type="password" 
              placeholder="Enter password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              style={{ padding: '10px 14px', background: 'rgba(0,0,0,0.4)', borderColor: 'var(--border-color)' }}
            />
          </div>

          {!isAdmin && isSignUp && (
            <>
              <div className="form-group">
                <label style={{ fontSize: '0.75rem', marginBottom: '4px' }}>Full Name</label>
                <input 
                  type="text" 
                  placeholder="e.g. Jane Doe"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                  autoComplete="off"
                  style={{ padding: '10px 14px', background: 'rgba(0,0,0,0.4)', borderColor: 'var(--border-color)' }}
                />
              </div>

              <div className="form-group">
                <label style={{ fontSize: '0.75rem', marginBottom: '4px' }}>Mobile Number</label>
                <input 
                  type="tel" 
                  placeholder="e.g. +91 9999999999"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  autoComplete="off"
                  style={{ padding: '10px 14px', background: 'rgba(0,0,0,0.4)', borderColor: 'var(--border-color)' }}
                />
              </div>
            </>
          )}

          <button 
            type="submit" 
            className="btn-primary" 
            disabled={isLoading}
            style={{ 
              marginTop: '10px', 
              padding: '12px', 
              fontSize: '0.95rem',
              background: 'var(--accent-grad)',
              borderColor: 'var(--accent-color)',
              opacity: isLoading ? 0.7 : 1,
              cursor: isLoading ? 'not-allowed' : 'pointer'
            }}
          >
            {isLoading ? (
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                <span className="spinner" style={{
                  width: '16px',
                  height: '16px',
                  border: '2px solid rgba(255,255,255,0.2)',
                  borderTopColor: '#fff',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite'
                }} />
                Processing...
              </span>
            ) : (!isAdmin && isSignUp) ? 'Create Guest Account' : 'Sign In'}
          </button>
        </form>

        {/* Back Link */}
        <div style={{ textAlign: 'center', marginTop: '20px' }}>
          <button
            onClick={() => onNavigate('/')}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              fontSize: '0.8rem',
              cursor: 'pointer',
              textDecoration: 'underline',
              transition: 'color 0.2s'
            }}
            onMouseEnter={(e) => e.target.style.color = '#fff'}
            onMouseLeave={(e) => e.target.style.color = 'var(--text-muted)'}
          >
            ← Back to Portal Selection
          </button>
        </div>

        {/* Demo Accounts Tip */}
        <div style={{
          marginTop: '20px',
          padding: '10px 12px',
          background: 'rgba(56, 189, 248, 0.05)',
          border: '1px solid rgba(56, 189, 248, 0.12)',
          borderRadius: '8px',
          fontSize: '0.72rem',
          color: 'var(--text-muted)',
          lineHeight: '1.4'
        }}>
          💡 <strong>Demo Accounts Seeding:</strong><br />
          • Admin: <code>admin</code> / Password: <code>admin123</code><br />
          • Guest: <code>guest</code> / Password: <code>guest123</code>
        </div>
      </div>
    </div>
  );
}
