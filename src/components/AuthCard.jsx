import React, { useState } from 'react';

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
    const endpoint = (!isAdmin && isSignUp) ? '/api/auth/signup' : '/api/auth/signin';
    
    // The frontend must not send the role for guest sign up
    const payload = (!isAdmin && isSignUp)
      ? { username, password, fullName, phone }
      : { username, password };

    try {
      const res = await fetch(`http://localhost:5000${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
