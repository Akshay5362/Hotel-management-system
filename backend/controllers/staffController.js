/**
 * staffController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Full CRUD for Hotel PMS Staff Management.
 *
 * ALL staff records use bcrypt password hashing.
 * Soft-delete only — no staff record is ever permanently deleted.
 * Completely isolated from existing users/guests/auth tables.
 */

import pool from '../db.js';
import { db, auth, isFirebaseConfigured } from '../config/firebaseAdmin.js';
import bcrypt from 'bcryptjs';
import { isStaffReadCanaryEnabled, isFirebaseOnlyStaffResolutionEnabled, isFirebaseStaffLoginEnabled, isMysqlCutoverFallbacksDisabled } from '../config/featureFlags.js';
import { StaffCutoverService } from '../services/staffCutoverService.js';

export async function syncStaffFirebaseClaims(staff) {
  if (!isFirebaseConfigured || !auth) return;
  const uid = `staff_${String(staff.username).toLowerCase().trim()}`;
  try {
    let existingUser;
    try {
      existingUser = await auth.getUser(uid);
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        console.warn(`[syncStaffFirebaseClaims] Firebase Auth user '${uid}' not found. Run Phase 3 Step 3A provisioning script.`);
        return;
      }
      throw e;
    }
    const existing = existingUser.customClaims || {};
    const required = {
      role: staff.role,
      user_type: 'staff',
      mysql_id: Number(staff.id),
      mysql_staff_id: Number(staff.id),
      staff_username: String(staff.username).toLowerCase().trim(),
      status: staff.status || 'Active',
      deleted: staff.deleted ? 1 : 0
    };
    // Check whether update is needed
    const needsUpdate = Object.entries(required).some(([k, v]) => existing[k] !== v);
    if (needsUpdate) {
      await auth.setCustomUserClaims(uid, { ...existing, ...required });
      console.log(`[syncStaffFirebaseClaims] Claims synced for '${uid}' (role=${staff.role}, status=${staff.status})`);
    }
  } catch (err) {
    console.warn(`[syncStaffFirebaseClaims] Non-fatal: Failed to sync Firebase claims for '${uid}':`, err.message);
  }
}

const BCRYPT_ROUNDS = 12;

const VALID_ROLES = ['ADMIN', 'RECEPTIONIST', 'CHEF', 'KITCHEN_HELPER', 'PANTRY_BOY', 'CLEANER'];
const VALID_DEPARTMENTS = ['Administration', 'Front Office', 'Kitchen', 'Pantry', 'Housekeeping'];
const VALID_SHIFTS = ['Morning', 'Night'];
const VALID_STATUSES = ['Active', 'Inactive'];

// ── Validation helpers ────────────────────────────────────────────────────────
function validateStaffPayload(body, requirePassword = true) {
  const errors = [];
  const { full_name, username, email, password, role, department, shift, phone, status } = body;

  if (!full_name || typeof full_name !== 'string' || full_name.trim().length < 2)
    errors.push('full_name is required (min 2 characters).');

  if (!username || typeof username !== 'string' || username.trim().length < 3)
    errors.push('username is required (min 3 characters).');
  else if (!/^[a-z0-9_.-]+$/i.test(username.trim()))
    errors.push('username may only contain letters, digits, underscores, hyphens, and dots.');

  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
    errors.push('A valid email address is required.');

  if (requirePassword) {
    if (!password || typeof password !== 'string' || password.length < 8)
      errors.push('password is required and must be at least 8 characters.');
    else if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password))
      errors.push('password must contain at least one uppercase letter, one lowercase letter, and one digit.');
  }

  if (!role || !VALID_ROLES.includes(role))
    errors.push(`role must be one of: ${VALID_ROLES.join(', ')}.`);

  if (!department || !VALID_DEPARTMENTS.includes(department))
    errors.push(`department must be one of: ${VALID_DEPARTMENTS.join(', ')}.`);

  if (!shift || !VALID_SHIFTS.includes(shift))
    errors.push(`shift must be one of: ${VALID_SHIFTS.join(', ')}.`);

  if (status && !VALID_STATUSES.includes(status))
    errors.push(`status must be one of: ${VALID_STATUSES.join(', ')}.`);

  if (phone && !/^\+?[\d\s\-().]{7,20}$/.test(phone.trim()))
    errors.push('phone number format is invalid.');

  return errors;
}

// Strip sensitive fields before returning or sending to outbox
function sanitize(staff) {
  if (!staff) return null;
  const { password_hash, password, deleted, ...safe } = staff;
  return safe;
}

// ── POST /api/staff/auth/login ─────────────────────────────────────────────────
/**
 * Phase 3 Step 3C:
 * When ENABLE_FIREBASE_STAFF_LOGIN=true, this MySQL-based endpoint is DISABLED.
 * Staff must authenticate through Firebase Authentication (signInWithEmailAndPassword)
 * to obtain a Firebase ID token, which is then verified by the backend via /api/auth/me.
 *
 * When ENABLE_FIREBASE_STAFF_LOGIN=false (default): behavior is unchanged.
 */
export const staffLogin = async (req, res) => {
  // ── Phase 3 Step 3C: Firebase-Only Staff Login Guard ────────────────────────
  if (isFirebaseStaffLoginEnabled() || isMysqlCutoverFallbacksDisabled()) {
    return res.status(401).json({
      error: 'Staff login via email/password is disabled. Please use Firebase Authentication to obtain an ID token.',
      code: 'FIREBASE_LOGIN_REQUIRED',
      hint: 'Use Firebase signInWithEmailAndPassword then call /api/auth/me with the Bearer ID token.'
    });
  }

  const { email, password } = req.body;

  if (!email || typeof email !== 'string' || !email.trim())
    return res.status(400).json({ error: 'Email is required.' });
  if (!password || typeof password !== 'string' || !password)
    return res.status(400).json({ error: 'Password is required.' });

  try {
    const [rows] = await pool.query(
      'SELECT * FROM staff WHERE email = ? AND deleted = 0 LIMIT 1',
      [email.trim().toLowerCase()]
    );

    if (rows.length === 0)
      return res.status(401).json({ error: 'Invalid email or password.' });

    const staff = rows[0];

    if (staff.status === 'Inactive')
      return res.status(403).json({ error: 'Your account is inactive. Please contact an administrator.' });

    const passwordMatch = await bcrypt.compare(password, staff.password_hash);
    if (!passwordMatch)
      return res.status(401).json({ error: 'Invalid email or password.' });

    return res.json({
      message: 'Logged in successfully.',
      token: null,
      idToken: null,
      staff: {
        id:         staff.id,
        name:       staff.full_name,
        username:   staff.username,
        email:      staff.email,
        role:       staff.role,
        department: staff.department,
        shift:      staff.shift,
        status:     staff.status,
      },
    });
  } catch (error) {
    console.error('staffLogin error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ── GET /api/staff ─────────────────────────────────────────────────────────────
export const getAllStaff = async (req, res) => {
  try {
    const result = await StaffCutoverService.getAllStaff(req.query);
    return res.json(result);
  } catch (error) {
    console.error('getAllStaff error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ── GET /api/staff/:id ─────────────────────────────────────────────────────────
export const getStaffById = async (req, res) => {
  try {
    const { id } = req.params;
    const staff = await StaffCutoverService.getStaffById(id);
    if (!staff) return res.status(404).json({ error: 'Staff member not found.' });
    return res.json({ staff });
  } catch (error) {
    console.error('getStaffById error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ── POST /api/staff ────────────────────────────────────────────────────────────
export const createStaff = async (req, res) => {
  const errors = validateStaffPayload(req.body, true);
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });

  try {
    const safeStaff = await StaffCutoverService.createStaff(req.body);
    return res.status(201).json({ message: 'Staff member created successfully.', staff: safeStaff });
  } catch (error) {
    if (error.status === 409 || error.code === 'ER_DUP_ENTRY' || error.code === 'DUPLICATE_KEY') {
      return res.status(409).json({ error: error.message || 'Username or email already exists.' });
    }
    console.error('createStaff error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ── PUT /api/staff/:id ─────────────────────────────────────────────────────────
export const updateStaff = async (req, res) => {
  const { id } = req.params;

  const errors = validateStaffPayload(req.body, !!req.body.password);
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });

  try {
    const safeStaff = await StaffCutoverService.updateStaff(id, req.body);
    return res.json({ message: 'Staff member updated successfully.', staff: safeStaff });
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ error: 'Staff member not found.' });
    if (error.status === 409 || error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: error.message || 'Username or email is already taken.' });
    }
    console.error('updateStaff error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ── PATCH /api/staff/status ────────────────────────────────────────────────────
export const updateStaffStatus = async (req, res) => {
  const { id, status } = req.body;

  if (!id) return res.status(400).json({ error: 'Staff id is required.' });
  if (!status || !VALID_STATUSES.includes(status))
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}.` });

  try {
    await StaffCutoverService.updateStaffStatus(id, status);
    return res.json({ message: `Staff status updated to ${status}.` });
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ error: 'Staff member not found.' });
    console.error('updateStaffStatus error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ── DELETE /api/staff/:id (soft delete only) ───────────────────────────────────
export const deleteStaff = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await StaffCutoverService.deleteStaff(id);
    return res.json(result);
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ error: 'Staff member not found.' });
    console.error('deleteStaff error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};
