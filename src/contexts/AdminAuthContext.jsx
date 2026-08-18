import React, { createContext, useState, useEffect } from 'react';
import { auth, signOut, onAuthStateChanged } from '../config/firebaseClient';

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
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        try {
          const freshToken = await firebaseUser.getIdToken(false);
          setAdminToken(freshToken);
          localStorage.setItem('adminToken', freshToken);
        } catch (e) {
          console.warn('[AdminAuthContext] Token refresh failed:', e.message);
        }
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
