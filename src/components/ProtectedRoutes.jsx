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

/**
 * hasPermission — case-insensitive role check.
 * super_admin and admin always pass any protected route check.
 * All other roles must be explicitly listed in allowedRoles.
 */
function hasPermission(userRole, allowedRoles) {
  const roleUpper = (userRole || '').toUpperCase();
  if (roleUpper === 'ADMIN' || roleUpper === 'SUPER_ADMIN') return true;
  // Case-insensitive match against the allowed set
  return allowedRoles.some(r => r.toUpperCase() === roleUpper);
}

/**
 * Redirect a user to their correct dashboard based on role.
 */
function redirectToDashboard(role, navigate) {
  const roleUpper = (role || '').toUpperCase();
  switch (roleUpper) {
    case 'SUPER_ADMIN':
    case 'ADMIN':
      navigate('/admin/dashboard');
      break;
    case 'RECEPTIONIST':
      navigate('/reception/dashboard');
      break;
    case 'CHEF':
    case 'KITCHEN_HELPER':
    case 'PANTRY_BOY':
    case 'KITCHEN':
      navigate('/kitchen/dashboard');
      break;
    case 'CLEANER':
    case 'HOUSEKEEPING':
      navigate('/housekeeping/dashboard');
      break;
    default:
      navigate('/admin/login');
  }
}

export function RoleProtectedRoute({ children, navigate, allowedRoles }) {
  const { adminUser } = useContext(AdminAuthContext);

  useEffect(() => {
    if (!adminUser) {
      navigate('/admin/login');
      return;
    }

    if (!hasPermission(adminUser.role, allowedRoles)) {
      console.warn(`[RoleProtectedRoute] Access denied for role '${adminUser.role}'. Allowed: [${allowedRoles.join(', ')}]`);
      // Redirect to the dashboard the user is actually allowed to use
      redirectToDashboard(adminUser.role, navigate);
    }
  }, [adminUser, navigate, allowedRoles]);

  if (!adminUser || !hasPermission(adminUser.role, allowedRoles)) return null;
  
  return <>{children}</>;
}
