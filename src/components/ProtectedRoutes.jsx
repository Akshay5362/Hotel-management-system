import React, { useContext, useEffect } from 'react';
import { GuestAuthContext } from '../contexts/GuestAuthContext';
import { AdminAuthContext } from '../contexts/AdminAuthContext';

export function GuestProtectedRoute({ children, navigate }) {
  const { guestUser } = useContext(GuestAuthContext);

  useEffect(() => {
    if (!guestUser) {
      navigate('/login');
    }
  }, [guestUser, navigate]);

  if (!guestUser) return null;
  return <>{children}</>;
}

export function AdminProtectedRoute({ children, navigate }) {
  const { adminUser } = useContext(AdminAuthContext);

  useEffect(() => {
    if (!adminUser) {
      navigate('/admin/login');
    }
  }, [adminUser, navigate]);

  if (!adminUser) return null;
  return <>{children}</>;
}
