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
import bcrypt from 'bcryptjs';
import { generateToken } from './authController.js';

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

// Strip sensitive fields before returning
function sanitize(staff) {
  const { password_hash, deleted, ...safe } = staff;
  return safe;
}

// ── POST /api/staff/auth/login ─────────────────────────────────────────────────
// Email + bcrypt password only. Username is a display name, NOT a login key.
export const staffLogin = async (req, res) => {
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

    // Block inactive accounts before doing bcrypt (saves CPU on disabled accounts)
    if (staff.status === 'Inactive')
      return res.status(403).json({ error: 'Your account is inactive. Please contact an administrator.' });

    const passwordMatch = await bcrypt.compare(password, staff.password_hash);
    if (!passwordMatch)
      return res.status(401).json({ error: 'Invalid email or password.' });

    // Update last_login timestamp (fire-and-forget — never block the login response)
    pool.query('UPDATE staff SET last_login = NOW() WHERE id = ?', [staff.id]).catch(() => {});

    // Build a signed token. type:'staff' distinguishes it from admin/guest tokens.
    const tokenPayload = {
      id:   staff.id,
      role: staff.role,       // e.g. 'RECEPTIONIST'
      type: 'staff',          // sentinel — allows middleware to identify staff tokens
    };
    const token = generateToken(tokenPayload);

    return res.json({
      message: 'Logged in successfully.',
      token,
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
    const { role, department, shift, status, search } = req.query;
    let where = ['deleted = 0'];
    const params = [];

    if (role)       { where.push('role = ?');       params.push(role); }
    if (department) { where.push('department = ?'); params.push(department); }
    if (shift)      { where.push('shift = ?');      params.push(shift); }
    if (status)     { where.push('status = ?');     params.push(status); }
    if (search) {
      where.push('(full_name LIKE ? OR username LIKE ? OR email LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const [rows] = await pool.query(
      `SELECT * FROM staff WHERE ${where.join(' AND ')} ORDER BY full_name ASC`,
      params
    );
    return res.json({ staff: rows.map(sanitize), total: rows.length });
  } catch (error) {
    console.error('getAllStaff error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ── GET /api/staff/:id ─────────────────────────────────────────────────────────
export const getStaffById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(
      'SELECT * FROM staff WHERE id = ? AND deleted = 0',
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Staff member not found.' });
    return res.json({ staff: sanitize(rows[0]) });
  } catch (error) {
    console.error('getStaffById error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ── POST /api/staff ────────────────────────────────────────────────────────────
export const createStaff = async (req, res) => {
  const errors = validateStaffPayload(req.body, true);
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });

  const { full_name, username, email, password, role, department, shift, phone, status } = req.body;

  try {
    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const [result] = await pool.query(
      `INSERT INTO staff (full_name, username, email, password_hash, role, department, shift, phone, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        full_name.trim(),
        username.trim().toLowerCase(),
        email.trim().toLowerCase(),
        password_hash,
        role,
        department,
        shift,
        phone?.trim() || null,
        status || 'Active',
      ]
    );

    const [rows] = await pool.query('SELECT * FROM staff WHERE id = ?', [result.insertId]);
    return res.status(201).json({ message: 'Staff member created successfully.', staff: sanitize(rows[0]) });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      if (error.message.includes('username'))
        return res.status(409).json({ error: 'Username is already taken. Please choose a different username.' });
      if (error.message.includes('email'))
        return res.status(409).json({ error: 'Email address is already registered to another staff member.' });
    }
    console.error('createStaff error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ── PUT /api/staff/:id ─────────────────────────────────────────────────────────
export const updateStaff = async (req, res) => {
  const { id } = req.params;

  // For updates, password is optional
  const errors = validateStaffPayload(req.body, !!req.body.password);
  if (errors.length) return res.status(400).json({ error: 'Validation failed.', details: errors });

  try {
    const [existing] = await pool.query('SELECT id FROM staff WHERE id = ? AND deleted = 0', [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Staff member not found.' });

    const { full_name, username, email, password, role, department, shift, phone, status } = req.body;

    const updates = {
      full_name: full_name.trim(),
      username: username.trim().toLowerCase(),
      email: email.trim().toLowerCase(),
      role,
      department,
      shift,
      phone: phone?.trim() || null,
      status: status || 'Active',
    };

    if (password) {
      updates.password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    }

    await pool.query('UPDATE staff SET ? WHERE id = ?', [updates, id]);

    const [rows] = await pool.query('SELECT * FROM staff WHERE id = ?', [id]);
    return res.json({ message: 'Staff member updated successfully.', staff: sanitize(rows[0]) });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      if (error.message.includes('username'))
        return res.status(409).json({ error: 'Username is already taken.' });
      if (error.message.includes('email'))
        return res.status(409).json({ error: 'Email address is already registered to another staff member.' });
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
    const [existing] = await pool.query('SELECT id FROM staff WHERE id = ? AND deleted = 0', [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Staff member not found.' });

    await pool.query('UPDATE staff SET status = ? WHERE id = ?', [status, id]);
    return res.json({ message: `Staff status updated to ${status}.` });
  } catch (error) {
    console.error('updateStaffStatus error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ── DELETE /api/staff/:id (soft delete only) ───────────────────────────────────
export const deleteStaff = async (req, res) => {
  const { id } = req.params;

  try {
    const [existing] = await pool.query('SELECT id FROM staff WHERE id = ? AND deleted = 0', [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Staff member not found.' });

    // Soft delete: mark deleted=1 and set status=Inactive. Record is preserved for audit.
    await pool.query(
      "UPDATE staff SET deleted = 1, status = 'Inactive' WHERE id = ?",
      [id]
    );
    return res.json({ message: 'Staff member removed. Record retained for audit trail.' });
  } catch (error) {
    console.error('deleteStaff error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};
