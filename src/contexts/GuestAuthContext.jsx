import React, { createContext, useState, useEffect } from 'react';

export const GuestAuthContext = createContext(null);

export function GuestAuthProvider({ children }) {
  const [guestUser, setGuestUser] = useState(() => {
    const saved = localStorage.getItem('guestUser');
    return saved ? JSON.parse(saved) : null;
  });
  
  const [guestToken, setGuestToken] = useState(() => {
    return localStorage.getItem('guestToken') || '';
  });

  const login = (userData, tokenData) => {
    localStorage.setItem('guestUser', JSON.stringify(userData));
    localStorage.setItem('guestToken', tokenData);
    setGuestUser(userData);
    setGuestToken(tokenData);
  };

  const logout = () => {
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
