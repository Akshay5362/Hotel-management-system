import React, { createContext, useState, useEffect } from 'react';
import { auth, signOut, onIdTokenChanged } from '../config/firebaseClient';
import { API_BASE_URL, getApiHeaders } from '../config/apiConfig';

export const AdminAuthContext = createContext(null);

export function AdminAuthProvider({ children }) {
  const [adminUser, setAdminUser] = useState(() => {
    const saved = localStorage.getItem('adminUser');
    return saved ? JSON.parse(saved) : null;
  });
  
  const [adminToken, setAdminToken] = useState(() => {
    return localStorage.getItem('adminToken') || '';
  });

  useEffect(() => {
    if (!auth) return;
    const unsubscribe = onIdTokenChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        try {
          const freshToken = await firebaseUser.getIdToken();
          setAdminToken(freshToken);
          localStorage.setItem('adminToken', freshToken);

          // Re-validate role from server on auth state change (e.g. initial load / role update).
          // This prevents a stale localStorage role from surviving a role change.
          try {
            const meRes = await fetch(`${API_BASE_URL}/api/auth/me`, {
              method: 'GET',
              headers: getApiHeaders(freshToken)
            });
            if (meRes.ok) {
              const meData = await meRes.json();
              if (meData.user && meData.user.role) {
                // Merge fresh server role into existing stored user (preserves extra fields)
                const existingUser = JSON.parse(localStorage.getItem('adminUser') || 'null');
                const refreshedUser = { ...(existingUser || {}), ...meData.user };
                localStorage.setItem('adminUser', JSON.stringify(refreshedUser));
                setAdminUser(refreshedUser);
              }
            }
          } catch (meErr) {
            // Non-fatal: keep existing stored user if /auth/me is unreachable
            console.warn('[AdminAuthContext] Role re-validation skipped (network):', meErr.message);
          }
        } catch (e) {
          console.warn('[AdminAuthContext] Token refresh failed:', e.message);
        }
      } else {
        // Firebase user signed out
        localStorage.removeItem('adminToken');
        setAdminToken('');
      }
    });
    return () => unsubscribe();
  }, []);

  const login = (userData, tokenData) => {
    localStorage.setItem('adminUser', JSON.stringify(userData));
    localStorage.setItem('adminToken', tokenData);
    setAdminUser(userData);
    setAdminToken(tokenData);
  };

  const logout = async () => {
    if (auth && auth.currentUser) {
      try {
        await signOut(auth);
      } catch (e) {
        console.warn('[AdminAuthContext] Firebase signOut warning:', e.message);
      }
    }
    localStorage.removeItem('adminUser');
    localStorage.removeItem('adminToken');
    setAdminUser(null);
    setAdminToken('');
  };

  const updateUser = (updatedUserData) => {
    localStorage.setItem('adminUser', JSON.stringify(updatedUserData));
    setAdminUser(updatedUserData);
  };

  return (
    <AdminAuthContext.Provider value={{ adminUser, adminToken, login, logout, updateUser }}>
      {children}
    </AdminAuthContext.Provider>
  );
}
