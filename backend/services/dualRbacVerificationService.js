/**
 * dualRbacVerificationService.js — Read-Only Dual-RBAC Comparison Service
 * =======================================================================
 * Performs side-by-side comparison of permission evaluation results between
 * MySQL (ground truth) and Firestore RBAC repository.
 *
 * SAFETY RULES:
 *  - Verification ONLY: Does NOT modify live authorization decisions.
 *  - Read-Only: ZERO mutations on MySQL or Firestore.
 *  - Pure parity check: Returns match boolean and detailed breakdown.
 */

import pool from '../db.js';
import { hasFirestorePermission, getPermissionsForRoleFirestore } from '../repositories/firestore/rbacRepository.js';

/**
 * Check permission in MySQL (ground truth)
 * @param {number|string} roleId Or roleName
 * @param {string} permissionName
 */
export async function hasMysqlPermission(roleId, permissionName) {
  if (!roleId || !permissionName) return false;
  const cleanPerm = String(permissionName).trim().toLowerCase();

  let numRoleId = Number(roleId);
  let roleName = null;

  if (isNaN(numRoleId)) {
    roleName = String(roleId).trim().toLowerCase();
    const [rRows] = await pool.query('SELECT id FROM roles WHERE LOWER(name) = ? LIMIT 1', [roleName]);
    if (rRows.length > 0) {
      numRoleId = rRows[0].id;
    }
  }

  if (isNaN(numRoleId) || numRoleId <= 0) {
    return false;
  }

  const [rows] = await pool.query(`
    SELECT rp.role_id
    FROM role_permissions rp
    JOIN permissions p ON rp.permission_id = p.id
    WHERE rp.role_id = ? AND LOWER(p.name) = ?
    LIMIT 1
  `, [numRoleId, cleanPerm]);

  return rows.length > 0;
}

/**
 * Get all allowed permission names for a role in MySQL
 * @param {number|string} roleId
 */
export async function getMysqlPermissionsForRole(roleId) {
  if (!roleId) return [];
  let numRoleId = Number(roleId);

  if (isNaN(numRoleId)) {
    const roleName = String(roleId).trim().toLowerCase();
    const [rRows] = await pool.query('SELECT id FROM roles WHERE LOWER(name) = ? LIMIT 1', [roleName]);
    if (rRows.length > 0) numRoleId = rRows[0].id;
  }

  if (isNaN(numRoleId) || numRoleId <= 0) return [];

  const [rows] = await pool.query(`
    SELECT p.name
    FROM role_permissions rp
    JOIN permissions p ON rp.permission_id = p.id
    WHERE rp.role_id = ?
    ORDER BY p.id ASC
  `, [numRoleId]);

  return rows.map(r => r.name.toLowerCase().trim());
}

/**
 * Compare single permission evaluation between MySQL and Firestore
 * @param {number|string} roleId
 * @param {string} permissionName
 */
export async function comparePermissionResolution(roleId, permissionName) {
  const startMysql = Date.now();
  const mysqlAllowed = await hasMysqlPermission(roleId, permissionName);
  const mysqlTimeMs = Date.now() - startMysql;

  const startFs = Date.now();
  const firestoreAllowed = await hasFirestorePermission(roleId, permissionName);
  const firestoreTimeMs = Date.now() - startFs;

  const match = (mysqlAllowed === firestoreAllowed);

  return {
    roleId,
    permission: String(permissionName).trim().toLowerCase(),
    mysqlAllowed,
    firestoreAllowed,
    match,
    details: {
      mysqlTimeMs,
      firestoreTimeMs
    }
  };
}

/**
 * Compare all permission mappings for a given role between MySQL and Firestore
 * @param {number|string} roleId
 */
export async function compareRoleRbacParity(roleId) {
  const mysqlPerms = await getMysqlPermissionsForRole(roleId);
  const firestorePerms = await getPermissionsForRoleFirestore(roleId);

  const mysqlSet = new Set(mysqlPerms);
  const firestoreSet = new Set(firestorePerms);

  const allPerms = Array.from(new Set([...mysqlPerms, ...firestorePerms]));
  const comparisons = [];
  let allMatched = true;

  for (const perm of allPerms) {
    const inMysql = mysqlSet.has(perm);
    const inFs = firestoreSet.has(perm);
    const match = (inMysql === inFs);
    if (!match) allMatched = false;

    comparisons.push({
      permission: perm,
      mysqlAllowed: inMysql,
      firestoreAllowed: inFs,
      match
    });
  }

  return {
    roleId,
    mysqlPermissions: mysqlPerms,
    firestorePermissions: firestorePerms,
    allMatched,
    comparisons
  };
}
