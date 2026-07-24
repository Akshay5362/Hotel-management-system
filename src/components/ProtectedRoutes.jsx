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

function hasPermission(userRole, allowedRoles) {
  if (userRole === "ADMIN" || userRole === "admin") return true;
  return allowedRoles.includes(userRole);
}

export function RoleProtectedRoute({ children, navigate, allowedRoles }) {
  const { adminUser } = useContext(AdminAuthContext);

  useEffect(() => {
    if (!adminUser) {
      navigate('/admin/login');
      return;
    }

    if (!hasPermission(adminUser.role, allowedRoles)) {
      alert("Access Denied: You don't have permission to view this dashboard.");
      
      // Auto-redirect to their correct dashboard
      switch (adminUser.role) {
        case 'ADMIN':
        case 'admin':
          navigate('/admin/dashboard');
          break;
        case 'RECEPTIONIST':
          navigate('/reception/dashboard');
          break;
        case 'CHEF':
          navigate('/kitchen/dashboard');
          break;
        case 'PANTRY_BOY':
          navigate('/pantry/dashboard');
          break;
        case 'CLEANER':
          navigate('/housekeeping/dashboard');
          break;
        default:
          navigate('/admin/login');
      }
    }
  }, [adminUser, navigate, allowedRoles]);

  if (!adminUser || !hasPermission(adminUser.role, allowedRoles)) return null;
  
  return <>{children}</>;
}
