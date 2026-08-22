/**
 * staffCutoverService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cutover Service for Staff Management Master Data.
 * Routes operations to Firestore when USE_FIRESTORE_STAFF=true.
 * Provides safe fail-closed error handling without silent MySQL fallback.
 */

import pool from '../db.js';
import bcrypt from 'bcryptjs';
import { isFirestoreStaffEnabled, isFirebaseOnlyStaffResolutionEnabled } from '../config/featureFlags.js';
import {
  getAllStaffFirestore,
  getStaffByIdFirestore,
  getStaffByUsernameFirestore,
  createStaffFirestore,
  updateStaffFirestore,
  deleteStaffFirestore
} from '../repositories/firestore/staffRepository.js';
import { syncStaffFirebaseClaims } from '../controllers/staffController.js';

const BCRYPT_ROUNDS = 10;

function sanitize(record) {
  if (!record) return null;
  const { password_hash, password, ...safe } = record;
  return safe;
}

export class StaffCutoverService {

  static async getAllStaff(query = {}) {
    if (isFirestoreStaffEnabled()) {
      try {
        const { role, department, shift, status, search } = query;
        let docs = await getAllStaffFirestore({ includeInactive: true });

        // Filter deleted
        docs = docs.filter(s => !s.deleted && s.deleted !== 1 && !s.is_deleted);

        if (role) {
          docs = docs.filter(s => String(s.role).toLowerCase() === String(role).toLowerCase());
        }
        if (department) {
          docs = docs.filter(s => String(s.department).toLowerCase() === String(department).toLowerCase());
        }
        if (shift) {
          docs = docs.filter(s => String(s.shift).toLowerCase() === String(shift).toLowerCase());
        }
        if (status) {
          docs = docs.filter(s => String(s.status).toLowerCase() === String(status).toLowerCase());
        }
        if (search && search.trim()) {
          const q = search.trim().toLowerCase();
          docs = docs.filter(s =>
            (s.full_name && s.full_name.toLowerCase().includes(q)) ||
            (s.username && s.username.toLowerCase().includes(q)) ||
            (s.email && s.email.toLowerCase().includes(q))
          );
        }

        docs.sort((a, b) => String(a.full_name || '').localeCompare(String(b.full_name || '')));

        const safeStaff = docs.map(s => ({
          id: s.id || s.mysql_staff_id || s.docId,
          full_name: s.full_name,
          username: s.username,
          email: s.email,
          role: s.role,
          department: s.department,
          shift: s.shift,
          phone: s.phone || null,
          status: s.status || 'Active',
          last_login: s.last_login || null,
          created_at: s.created_at || null,
          updated_at: s.updated_at || null
        }));

        return { staff: safeStaff, total: safeStaff.length };
      } catch (err) {
        console.error('[FAIL_CLOSED:STAFF] Firestore getAllStaff failed:', err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    const { role, department, shift, status, search } = query;
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
    return { staff: rows.map(sanitize), total: rows.length };
  }

  static async getStaffById(id) {
    if (isFirestoreStaffEnabled()) {
      try {
        const doc = await getStaffByIdFirestore(id);
        if (doc && !doc.deleted && doc.deleted !== 1) {
          return sanitize({
            id: doc.id || doc.mysql_staff_id || id,
            full_name: doc.full_name,
            username: doc.username,
            email: doc.email,
            role: doc.role,
            department: doc.department,
            shift: doc.shift,
            phone: doc.phone || null,
            status: doc.status || 'Active',
            created_at: doc.created_at,
            updated_at: doc.updated_at
          });
        }
        return null;
      } catch (err) {
        console.error(`[FAIL_CLOSED:STAFF] Firestore getStaffById failed for ${id}:`, err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    const [rows] = await pool.query('SELECT * FROM staff WHERE (id = ? OR username = ?) AND deleted = 0', [id, id]);
    return rows[0] ? sanitize(rows[0]) : null;
  }

  static async createStaff(payload) {
    const { full_name, username, email, password, role, department, shift, phone, status } = payload;
    const cleanUsername = username.trim().toLowerCase();
    const cleanEmail = email.trim().toLowerCase();

    if (isFirestoreStaffEnabled()) {
      try {
        const existingUser = await getStaffByUsernameFirestore(cleanUsername);
        if (existingUser && !existingUser.deleted) {
          const dupErr = new Error('Username is already taken. Please choose a different username.');
          dupErr.code = 'DUPLICATE_KEY';
          dupErr.status = 409;
          throw dupErr;
        }

        const created = await createStaffFirestore({
          full_name: full_name.trim(),
          username: cleanUsername,
          email: cleanEmail,
          role,
          department,
          shift,
          phone: phone?.trim() || null,
          status: status || 'Active'
        });

        const safeStaff = sanitize({
          id: created.docId || `staff_${cleanUsername}`,
          full_name: full_name.trim(),
          username: cleanUsername,
          email: cleanEmail,
          role,
          department,
          shift,
          phone: phone?.trim() || null,
          status: status || 'Active'
        });

        if (isFirebaseOnlyStaffResolutionEnabled()) {
          syncStaffFirebaseClaims(safeStaff).catch(() => {});
        }

        return safeStaff;
      } catch (err) {
        if (err.status === 409 || err.code === 'DUPLICATE_KEY' || err.status === 400) throw err;
        console.error('[FAIL_CLOSED:STAFF] Firestore createStaff failed:', err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      const [result] = await connection.query(
        `INSERT INTO staff (full_name, username, email, password_hash, role, department, shift, phone, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          full_name.trim(),
          cleanUsername,
          cleanEmail,
          password_hash,
          role,
          department,
          shift,
          phone?.trim() || null,
          status || 'Active',
        ]
      );

      const [rows] = await connection.query('SELECT * FROM staff WHERE id = ?', [result.insertId]);
      const staffRecord = rows[0];
      const safeStaff = sanitize(staffRecord);

      if (isFirestoreDualWriteEnabled()) {
        await enqueue(connection, {
          event_type: 'STAFF_CREATED',
          aggregate_type: 'STAFF',
          aggregate_id: safeStaff.username,
          payload: {
            ...safeStaff,
            mysql_staff_id: safeStaff.id,
            updated_at: new Date().toISOString()
          }
        });
      }

      await connection.commit();

      if (isFirebaseOnlyStaffResolutionEnabled()) {
        syncStaffFirebaseClaims(safeStaff).catch(() => {});
      }

      return safeStaff;
    } catch (err) {
      if (connection) await connection.rollback();
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  static async updateStaff(id, payload) {
    if (isFirestoreStaffEnabled()) {
      try {
        const existing = await getStaffByIdFirestore(id);
        if (!existing || existing.deleted) {
          const notFoundErr = new Error('Staff member not found.');
          notFoundErr.status = 404;
          throw notFoundErr;
        }

        const updateData = { ...payload };
        delete updateData.password;

        await updateStaffFirestore(existing.docId || existing.username, updateData);

        const updated = { ...existing, ...updateData };
        const safeStaff = sanitize(updated);

        if (isFirebaseOnlyStaffResolutionEnabled()) {
          syncStaffFirebaseClaims(safeStaff).catch(() => {});
        }

        return safeStaff;
      } catch (err) {
        if (err.status === 404 || err.status === 409 || err.status === 400) throw err;
        console.error(`[FAIL_CLOSED:STAFF] Firestore updateStaff failed for ${id}:`, err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [existing] = await connection.query('SELECT * FROM staff WHERE (id = ? OR username = ?) AND deleted = 0 FOR UPDATE', [id, id]);
      if (existing.length === 0) {
        await connection.rollback();
        const notFoundErr = new Error('Staff member not found.');
        notFoundErr.status = 404;
        throw notFoundErr;
      }

      const currentStaff = existing[0];
      const updates = {};
      if (payload.full_name) updates.full_name = payload.full_name.trim();
      if (payload.email) updates.email = payload.email.trim().toLowerCase();
      if (payload.role) updates.role = payload.role;
      if (payload.department) updates.department = payload.department;
      if (payload.shift) updates.shift = payload.shift;
      if (payload.phone !== undefined) updates.phone = payload.phone?.trim() || null;
      if (payload.status) updates.status = payload.status;
      if (payload.password) updates.password_hash = await bcrypt.hash(payload.password, BCRYPT_ROUNDS);

      await connection.query('UPDATE staff SET ? WHERE id = ?', [updates, currentStaff.id]);
      const [rows] = await connection.query('SELECT * FROM staff WHERE id = ?', [currentStaff.id]);
      const safeStaff = sanitize(rows[0]);

      if (isFirestoreDualWriteEnabled()) {
        await enqueue(connection, {
          event_type: 'STAFF_UPDATED',
          aggregate_type: 'STAFF',
          aggregate_id: safeStaff.username,
          payload: {
            ...safeStaff,
            mysql_staff_id: safeStaff.id,
            updated_at: new Date().toISOString()
          }
        });
      }

      await connection.commit();

      if (isFirebaseOnlyStaffResolutionEnabled()) {
        syncStaffFirebaseClaims(safeStaff).catch(() => {});
      }

      return safeStaff;
    } catch (err) {
      if (connection) await connection.rollback();
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  static async updateStaffStatus(id, status) {
    if (isFirestoreStaffEnabled()) {
      try {
        const existing = await getStaffByIdFirestore(id);
        if (!existing || existing.deleted) {
          const notFoundErr = new Error('Staff member not found.');
          notFoundErr.status = 404;
          throw notFoundErr;
        }

        await updateStaffFirestore(existing.docId || existing.username, { status });
        const updated = { ...existing, status };
        const safeStaff = sanitize(updated);

        if (isFirebaseOnlyStaffResolutionEnabled()) {
          syncStaffFirebaseClaims(safeStaff).catch(() => {});
        }

        return safeStaff;
      } catch (err) {
        if (err.status === 404 || err.status === 400) throw err;
        console.error(`[FAIL_CLOSED:STAFF] Firestore updateStaffStatus failed for ${id}:`, err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [existing] = await connection.query('SELECT * FROM staff WHERE (id = ? OR username = ?) AND deleted = 0 FOR UPDATE', [id, id]);
      if (existing.length === 0) {
        await connection.rollback();
        const notFoundErr = new Error('Staff member not found.');
        notFoundErr.status = 404;
        throw notFoundErr;
      }

      const staffRecord = existing[0];
      await connection.query('UPDATE staff SET status = ? WHERE id = ?', [status, staffRecord.id]);
      const [rows] = await connection.query('SELECT * FROM staff WHERE id = ?', [staffRecord.id]);
      const safeStaff = sanitize(rows[0]);

      if (isFirestoreDualWriteEnabled()) {
        await enqueue(connection, {
          event_type: 'STAFF_STATUS_UPDATED',
          aggregate_type: 'STAFF',
          aggregate_id: safeStaff.username,
          payload: {
            username: safeStaff.username,
            status,
            mysql_staff_id: safeStaff.id,
            updated_at: new Date().toISOString()
          }
        });
      }

      await connection.commit();

      if (isFirebaseOnlyStaffResolutionEnabled()) {
        syncStaffFirebaseClaims(safeStaff).catch(() => {});
      }

      return safeStaff;
    } catch (err) {
      if (connection) await connection.rollback();
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  static async deleteStaff(id) {
    if (isFirestoreStaffEnabled()) {
      try {
        const existing = await getStaffByIdFirestore(id);
        if (!existing || existing.deleted) {
          const notFoundErr = new Error('Staff member not found.');
          notFoundErr.status = 404;
          throw notFoundErr;
        }

        await updateStaffFirestore(existing.docId || existing.username, {
          deleted: true,
          status: 'Inactive',
          deleted_at: new Date().toISOString()
        });

        return { success: true, message: 'Staff member deactivated successfully.' };
      } catch (err) {
        if (err.status === 404 || err.status === 400) throw err;
        console.error(`[FAIL_CLOSED:STAFF] Firestore deleteStaff failed for ${id}:`, err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [existing] = await connection.query('SELECT * FROM staff WHERE (id = ? OR username = ?) AND deleted = 0 FOR UPDATE', [id, id]);
      if (existing.length === 0) {
        await connection.rollback();
        const notFoundErr = new Error('Staff member not found.');
        notFoundErr.status = 404;
        throw notFoundErr;
      }

      const staff = existing[0];
      await connection.query(
        'UPDATE staff SET deleted = 1, status = "Inactive", updated_at = NOW() WHERE id = ?',
        [staff.id]
      );

      if (isFirestoreDualWriteEnabled()) {
        await enqueue(connection, {
          event_type: 'STAFF_DELETED',
          aggregate_type: 'STAFF',
          aggregate_id: staff.username,
          payload: {
            username: staff.username,
            deleted: true,
            status: 'Inactive',
            mysql_staff_id: staff.id,
            updated_at: new Date().toISOString()
          }
        });
      }

      await connection.commit();
      return { success: true, message: 'Staff member deactivated successfully.' };
    } catch (err) {
      if (connection) await connection.rollback();
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }
}
