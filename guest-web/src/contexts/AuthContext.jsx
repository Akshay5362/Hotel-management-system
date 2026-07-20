import React, { createContext, useState } from 'react';

export const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('guestUser');
    return saved ? JSON.parse(saved) : null;
  });
  
  const [token, setToken] = useState(() => {
    return localStorage.getItem('guestToken') || '';
  });

  const login = (userData, tokenData) => {
    localStorage.setItem('guestUser', JSON.stringify(userData));
    localStorage.setItem('guestToken', tokenData);
    setUser(userData);
    setToken(tokenData);
  };

  const logout = () => {
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
