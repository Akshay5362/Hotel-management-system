import React, { createContext, useState, useEffect } from 'react';
import { auth, signOut, onAuthStateChanged } from '../config/firebaseClient';
import { API_BASE_URL } from '../services/api';

export const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('guestUser');
    return saved ? JSON.parse(saved) : null;
  });
  
  const [token, setToken] = useState(() => {
    return localStorage.getItem('guestToken') || '';
  });

  useEffect(() => {
    if (!auth) return;
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        const storedToken = localStorage.getItem('guestToken');
        if (storedToken) {
          try {
            const freshToken = await firebaseUser.getIdToken(false);
            setToken(freshToken);
            localStorage.setItem('guestToken', freshToken);

            // Re-validate role and user identity from server
            try {
              const meRes = await fetch(`${API_BASE_URL}/auth/me`, {
                method: 'GET',
                headers: {
                  'Authorization': `Bearer ${freshToken}`,
                  'ngrok-skip-browser-warning': 'true'
                }
              });
              if (meRes.ok) {
                const meData = await meRes.json();
                if (meData.user) {
                  const existingUser = JSON.parse(localStorage.getItem('guestUser') || 'null');
                  const refreshedUser = { ...(existingUser || {}), ...meData.user };
                  localStorage.setItem('guestUser', JSON.stringify(refreshedUser));
                  setUser(refreshedUser);
                }
              }
            } catch (meErr) {
              console.warn('[AuthContext] Role re-validation skipped (network):', meErr.message);
            }
          } catch (e) {
            console.warn('[AuthContext] Token refresh failed:', e.message);
          }
        }
      }
    });
    return () => unsubscribe();
  }, []);

  const login = (userData, tokenData) => {
    localStorage.setItem('guestUser', JSON.stringify(userData));
    localStorage.setItem('guestToken', tokenData);
    setUser(userData);
    setToken(tokenData);
  };

  const logout = async () => {
    if (auth && auth.currentUser) {
      try {
        await signOut(auth);
      } catch (e) {
        console.warn('[AuthContext] Firebase signOut warning:', e.message);
      }
    }
    localStorage.removeItem('guestUser');
    localStorage.removeItem('guestToken');
    setUser(null);
    setToken('');
  };

  const updateUser = (updatedUserData) => {
    localStorage.setItem('guestUser', JSON.stringify(updatedUserData));
    setUser(updatedUserData);
  };

  return (
    <AuthContext.Provider value={{ user, token, login, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
}
