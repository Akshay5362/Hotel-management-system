import React, { createContext, useState } from 'react';

export const AdminAuthContext = createContext(null);

export function AdminAuthProvider({ children }) {
  const [adminUser, setAdminUser] = useState(() => {
    const saved = localStorage.getItem('adminUser');
    return saved ? JSON.parse(saved) : null;
  });
  
  const [adminToken, setAdminToken] = useState(() => {
    return localStorage.getItem('adminToken') || '';
  });

  const login = (userData, tokenData) => {
    localStorage.setItem('adminUser', JSON.stringify(userData));
    localStorage.setItem('adminToken', tokenData);
    setAdminUser(userData);
    setAdminToken(tokenData);
  };

  const logout = () => {
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
