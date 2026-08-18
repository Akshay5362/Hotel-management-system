import React, { createContext, useState, useEffect } from 'react';
import { auth, signOut, onAuthStateChanged } from '../config/firebaseClient';

export const GuestAuthContext = createContext(null);

export function GuestAuthProvider({ children }) {
  const [guestUser, setGuestUser] = useState(() => {
    const saved = localStorage.getItem('guestUser');
    return saved ? JSON.parse(saved) : null;
  });
  
  const [guestToken, setGuestToken] = useState(() => {
    return localStorage.getItem('guestToken') || '';
  });

  useEffect(() => {
    if (!auth) return;
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        const storedToken = localStorage.getItem('guestToken');
        if (storedToken && !localStorage.getItem('adminToken')) {
          try {
            const freshToken = await firebaseUser.getIdToken(false);
            setGuestToken(freshToken);
            localStorage.setItem('guestToken', freshToken);
          } catch (e) {
            console.warn('[GuestAuthContext] Token refresh failed:', e.message);
          }
        }
      }
    });
    return () => unsubscribe();
  }, []);

  const login = (userData, tokenData) => {
    localStorage.setItem('guestUser', JSON.stringify(userData));
    localStorage.setItem('guestToken', tokenData);
    setGuestUser(userData);
    setGuestToken(tokenData);
  };

  const logout = async () => {
    if (auth && auth.currentUser && !localStorage.getItem('adminToken')) {
      try {
        await signOut(auth);
      } catch (e) {
        console.warn('[GuestAuthContext] Firebase signOut warning:', e.message);
      }
    }
    localStorage.removeItem('guestUser');
    localStorage.removeItem('guestToken');
    setGuestUser(null);
    setGuestToken('');
  };

  const updateUser = (updatedUserData) => {
    localStorage.setItem('guestUser', JSON.stringify(updatedUserData));
    setGuestUser(updatedUserData);
  };

  return (
    <GuestAuthContext.Provider value={{ guestUser, guestToken, login, logout, updateUser }}>
      {children}
    </GuestAuthContext.Provider>
  );
}
