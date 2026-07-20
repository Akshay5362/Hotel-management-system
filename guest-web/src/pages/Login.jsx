import React, { useState, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthContext } from '../contexts/AuthContext';
import { API_BASE_URL } from '../services/api';

export default function Login() {
  const [isSignUp, setIsSignUp] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const { login } = useContext(AuthContext);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrorMsg('');

    if (!username.trim() || !password.trim()) {
      setErrorMsg('Username and password are required.');
      return;
    }

    if (isSignUp) {
      if (password.length < 8) {
        setErrorMsg('Password must be at least 8 characters long.');
        return;
      }
      if (!/[A-Z]/.test(password)) {
        setErrorMsg('Password must contain at least one uppercase letter.');
        return;
      }
      if (!/[a-z]/.test(password)) {
        setErrorMsg('Password must contain at least one lowercase letter.');
        return;
      }
      if (!fullName.trim()) {
        setErrorMsg('Full name is required to register.');
        return;
      }
    }

    setIsLoading(true);
    const endpoint = isSignUp ? '/auth/signup' : '/auth/signin';
    const payload = isSignUp ? { username, password, fullName, phone } : { username, password };

    try {
      const res = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || data.message || 'Authentication failed');
      }

      login(data.user, data.token);
      navigate('/dashboard');

    } catch (err) {
      setErrorMsg(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
      <div className="glass" style={{
        maxWidth: '400px', width: '100%', padding: '2rem', borderRadius: '12px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        border: '1px solid var(--border-color)',
        backdropFilter: 'blur(10px)',
        background: 'rgba(20,20,20,0.6)'
      }}>
        <h2 style={{ fontFamily: 'var(--font-heading)', color: '#fff', marginBottom: '1.5rem', textAlign: 'center' }}>
          {isSignUp ? 'Create Guest Account' : 'Guest Login'}
        </h2>

        {errorMsg && (
          <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.4)', color: '#f87171', padding: '10px', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.9rem' }}>
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {isSignUp && (
            <>
              <div className="form-group" style={{ margin: 0 }}>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Full Name</label>
                <input
                  type="text"
                  value={fullName}
                  onChange={e => setFullName(e.target.value)}
                  placeholder="John Doe"
                  style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.05)', color: '#fff' }}
                />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Phone (Optional)</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  placeholder="+1 234 567 8900"
                  style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.05)', color: '#fff' }}
                />
              </div>
            </>
          )}

          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Username (Email)</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="guest@example.com"
              style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.05)', color: '#fff' }}
            />
          </div>
          
          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.05)', color: '#fff' }}
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            style={{
              padding: '12px', background: 'var(--color-occupied)', color: '#fff',
              border: 'none', borderRadius: '8px', fontWeight: 'bold',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              opacity: isLoading ? 0.7 : 1, marginTop: '0.5rem'
            }}
          >
            {isLoading ? 'Processing...' : (isSignUp ? 'Sign Up' : 'Sign In')}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: '1.5rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          {isSignUp ? 'Already have an account?' : 'New to Hotel Sky-5?'}
          <button
            type="button"
            onClick={() => setIsSignUp(!isSignUp)}
            style={{
              background: 'none', border: 'none', color: 'var(--color-vacant)',
              fontWeight: 'bold', cursor: 'pointer', marginLeft: '5px'
            }}
          >
            {isSignUp ? 'Log in' : 'Register here'}
          </button>
        </p>
      </div>
    </div>
  );
}
