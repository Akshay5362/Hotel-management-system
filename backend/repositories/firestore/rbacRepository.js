/**
 * rbacRepository.js — Firestore Read-Only RBAC Repository
 * =======================================================
 * Provides safe, read-only helper functions for querying RBAC master data
 * (/roles, /permissions, /role_permissions) from Firestore.
 *
 * Safety Constraints:
 *  - READ-ONLY: Performs zero mutations on Firestore or MySQL.
 *  - Uses existing Firebase Admin SDK via firestoreUtils.js.
 */

import { getDoc, listDocs } from './firestoreUtils.js';

const ROLES_COLLECTION = 'roles';
const PERMISSIONS_COLLECTION = 'permissions';
const ROLE_PERMISSIONS_COLLECTION = 'role_permissions';

function formatRoleId(roleId) {
  if (roleId === undefined || roleId === null) return null;
  const str = String(roleId).trim().toLowerCase();
  if (str.startsWith('role_')) return str;
  if (str === '1') return 'role_admin';
  if (str === '2') return 'role_guest';
  return `role_${str}`;
}

function formatPermissionId(permissionId) {
  if (permissionId === undefined || permissionId === null) return null;
  const str = String(permissionId).trim().toLowerCase();
  if (str.startsWith('perm_')) return str;
  return `perm_${str}`;
}

// ── ROLES HELPERS ────────────────────────────────────────────────────────────

export async function getRoleByIdFirestore(roleId, options = {}) {
  if (roleId === undefined || roleId === null) return null;
  
  // Try by deterministic doc ID first (e.g. role_admin or role_1)
  const docId = formatRoleId(roleId);
  const doc = await getDoc(ROLES_COLLECTION, docId, options);
  if (doc) return doc;

  // Fallback query by numeric role_id or mysql_role_id
  const numId = Number(roleId);
  if (!isNaN(numId)) {
    const results = await listDocs(ROLES_COLLECTION, {
      filters: [{ field: 'role_id', op: '==', value: numId }],
      limit: 1,
      transaction: options.transaction
    });
    if (results[0]) return results[0];
  }

  return null;
}

export async function getRoleByNameFirestore(roleName, options = {}) {
  if (!roleName) return null;
  const cleanName = String(roleName).trim().toLowerCase();
  
  // Try deterministic ID role_<name>
  const docId = `role_${cleanName}`;
  const doc = await getDoc(ROLES_COLLECTION, docId, options);
  if (doc) return doc;

  const results = await listDocs(ROLES_COLLECTION, {
    filters: [{ field: 'name', op: '==', value: cleanName }],
    limit: 1,
    transaction: options.transaction
  });
  return results[0] || null;
}

export async function getAllRolesFirestore(options = {}) {
  return await listDocs(ROLES_COLLECTION, {
    limit: 100,
    transaction: options.transaction
  });
}

// ── PERMISSIONS HELPERS ──────────────────────────────────────────────────────

export async function getPermissionByIdFirestore(permissionId, options = {}) {
  if (permissionId === undefined || permissionId === null) return null;
  const docId = formatPermissionId(permissionId);
  const doc = await getDoc(PERMISSIONS_COLLECTION, docId, options);
  if (doc) return doc;

  const numId = Number(permissionId);
  if (!isNaN(numId)) {
    const results = await listDocs(PERMISSIONS_COLLECTION, {
      filters: [{ field: 'permission_id', op: '==', value: numId }],
      limit: 1,
      transaction: options.transaction
    });
    if (results[0]) return results[0];
  }

  return null;
}

export async function getPermissionByNameFirestore(permissionName, options = {}) {
  if (!permissionName) return null;
  const cleanName = String(permissionName).trim().toLowerCase();

  const docId = `perm_${cleanName}`;
  const doc = await getDoc(PERMISSIONS_COLLECTION, docId, options);
  if (doc) return doc;

  const results = await listDocs(PERMISSIONS_COLLECTION, {
    filters: [{ field: 'name', op: '==', value: cleanName }],
    limit: 1,
    transaction: options.transaction
  });
  return results[0] || null;
}

export async function getAllPermissionsFirestore(options = {}) {
  return await listDocs(PERMISSIONS_COLLECTION, {
    limit: 100,
    transaction: options.transaction
  });
}

// ── ROLE-PERMISSIONS HELPERS ────────────────────────────────────────────────

export async function getRolePermissionsFirestore(roleId, options = {}) {
  if (roleId === undefined || roleId === null) return [];

  // Determine role_id integer or string role_name
  let numRoleId = Number(roleId);
  let roleName = null;

  if (isNaN(numRoleId)) {
    roleName = String(roleId).trim().toLowerCase();
    const roleDoc = await getRoleByNameFirestore(roleName, options);
    if (roleDoc) {
      numRoleId = roleDoc.role_id || roleDoc.mysql_role_id;
    }
  } else if (!roleName) {
    const roleDoc = await getRoleByIdFirestore(numRoleId, options);
    if (roleDoc) {
      roleName = roleDoc.name;
    }
  }

  // Query /role_permissions by role_id or role_name
  const filters = [];
  if (!isNaN(numRoleId) && numRoleId > 0) {
    filters.push({ field: 'role_id', op: '==', value: numRoleId });
  } else if (roleName) {
    filters.push({ field: 'role_name', op: '==', value: roleName });
  } else {
    return [];
  }

  return await listDocs(ROLE_PERMISSIONS_COLLECTION, {
    filters,
    limit: 100,
    transaction: options.transaction
  });
}

export async function getPermissionsForRoleFirestore(roleId, options = {}) {
  const rpList = await getRolePermissionsFirestore(roleId, options);
  const permissionNames = rpList.map(rp => rp.permission_name).filter(Boolean);
  return permissionNames;
}

export async function hasFirestorePermission(roleId, permissionName, options = {}) {
  if (!roleId || !permissionName) return false;
  const cleanPerm = String(permissionName).trim().toLowerCase();
  const allowedPermissions = await getPermissionsForRoleFirestore(roleId, options);
  return allowedPermissions.includes(cleanPerm);
}
