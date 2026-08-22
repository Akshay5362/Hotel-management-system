/**
 * roomTypeCutoverService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cutover Service for Room Types Master Data.
 * Routes operations to Firestore when USE_FIRESTORE_ROOM_TYPES=true.
 * Provides safe fail-closed error handling without silent MySQL fallback.
 */

import pool from '../db.js';
import { isFirestoreRoomTypesEnabled } from '../config/featureFlags.js';
import {
  getAllRoomTypesFirestore,
  getRoomTypeByIdFirestore,
  getRoomTypeByCodeFirestore,
  createRoomTypeFirestore,
  updateRoomTypeFirestore,
  deleteRoomTypeFirestore
} from '../repositories/firestore/roomTypesRepository.js';

export class RoomTypeCutoverService {

  static async getRoomTypes() {
    if (isFirestoreRoomTypesEnabled()) {
      try {
        const docs = await getAllRoomTypesFirestore();
        if (Array.isArray(docs)) {
          const formatted = docs.map(d => ({
            id: d.id || d.mysql_room_type_id || d.docId,
            code: d.code || 'DELUXE',
            title: d.title || d.name || 'Room Type',
            name: d.name || d.title || 'Room Type',
            description: d.description || '',
            base_rate: parseFloat(d.base_rate || 0),
            image: d.image || null,
            max_occupancy: Number(d.max_occupancy || 2)
          }));
          formatted.sort((a, b) => String(a.code).localeCompare(String(b.code)));
          return formatted;
        }
      } catch (err) {
        console.error('[FAIL_CLOSED:ROOM_TYPES] Firestore fetch failed:', err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    let connection;
    try {
      connection = await pool.getConnection();
      const [rows] = await connection.query(
        'SELECT * FROM room_types ORDER BY id ASC'
      );
      return (rows || []).map(r => ({
        id: r.id,
        code: r.code,
        title: r.title,
        name: r.title,
        description: r.description || '',
        base_rate: parseFloat(r.base_rate || 0),
        image: r.image || null,
        max_occupancy: 2
      }));
    } finally {
      if (connection) connection.release();
    }
  }

  static async getRoomTypeById(id) {
    if (isFirestoreRoomTypesEnabled()) {
      try {
        const doc = await getRoomTypeByIdFirestore(id);
        if (doc) {
          return {
            id: doc.id || doc.mysql_room_type_id || doc.docId,
            code: doc.code,
            title: doc.title || doc.name || 'Room Type',
            name: doc.name || doc.title || 'Room Type',
            description: doc.description || '',
            base_rate: parseFloat(doc.base_rate || 0),
            image: doc.image || null,
            max_occupancy: Number(doc.max_occupancy || 2)
          };
        }
        return null;
      } catch (err) {
        console.error(`[FAIL_CLOSED:ROOM_TYPES] Firestore getById failed for ${id}:`, err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    let connection;
    try {
      connection = await pool.getConnection();
      const [rows] = await connection.query(
        'SELECT * FROM room_types WHERE id = ? OR code = ? LIMIT 1',
        [id, id]
      );
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        id: r.id,
        code: r.code,
        title: r.title,
        name: r.title,
        description: r.description,
        base_rate: parseFloat(r.base_rate || 0)
      };
    } finally {
      if (connection) connection.release();
    }
  }

  static async createRoomType({ code, title, name, description, base_rate, image }) {
    const roomTypeName = name || title;
    const codeUpper = String(code).toUpperCase().trim();

    if (isFirestoreRoomTypesEnabled()) {
      try {
        const created = await createRoomTypeFirestore({
          code: codeUpper,
          name: roomTypeName,
          description: description || '',
          base_rate: Number(base_rate),
          image: image || ''
        });

        return {
          success: true,
          id: created.docId || `type_${codeUpper}`,
          code: codeUpper,
          name: roomTypeName,
          base_rate: Number(base_rate)
        };
      } catch (err) {
        if (err.code === 'DUPLICATE_KEY' || err.status === 409 || err.status === 400) {
          throw err;
        }
        console.error('[FAIL_CLOSED:ROOM_TYPES] Firestore create failed:', err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [result] = await connection.query(
        `INSERT INTO room_types (code, title, description, base_rate, image) VALUES (?, ?, ?, ?, ?)`,
        [codeUpper, roomTypeName, description || '', Number(base_rate), image || '']
      );

      const roomTypeId = result.insertId;

      if (isFirestoreDualWriteEnabled()) {
        await enqueue(connection, {
          event_type: 'ROOM_TYPE_CREATED',
          aggregate_type: 'ROOM_TYPE',
          aggregate_id: codeUpper,
          payload: {
            id: roomTypeId,
            name: roomTypeName,
            code: codeUpper,
            description: description || '',
            base_rate: Number(base_rate),
            image: image || '',
            mysql_room_type_id: roomTypeId
          }
        });
      }

      await connection.commit();
      return { success: true, id: roomTypeId, code: codeUpper, name: roomTypeName, base_rate: Number(base_rate) };
    } catch (err) {
      if (connection) await connection.rollback();
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  static async updateRoomType(id, { title, name, description, base_rate, image }) {
    if (isFirestoreRoomTypesEnabled()) {
      try {
        const existing = await getRoomTypeByIdFirestore(id);
        if (!existing) {
          const notFoundErr = new Error('Room type not found');
          notFoundErr.status = 404;
          throw notFoundErr;
        }

        const updatedName = name || title || existing.title || existing.name;
        const updatedDesc = description !== undefined ? description : (existing.description || '');
        const updatedRate = base_rate !== undefined ? Number(base_rate) : Number(existing.base_rate || 0);
        const updatedImg = image !== undefined ? image : (existing.image || null);

        const updatePayload = {
          name: updatedName,
          title: updatedName,
          description: updatedDesc,
          base_rate: updatedRate,
          image: updatedImg || null
        };

        await updateRoomTypeFirestore(existing.docId || existing.id || id, updatePayload);

        return {
          success: true,
          id: existing.mysql_room_type_id || existing.id || id,
          code: existing.code,
          name: updatedName,
          base_rate: updatedRate
        };
      } catch (err) {
        if (err.status === 404 || err.status === 400 || err.status === 409) throw err;
        console.error(`[FAIL_CLOSED:ROOM_TYPES] Firestore update failed for ${id}:`, err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [existing] = await connection.query('SELECT * FROM room_types WHERE id = ? OR code = ? FOR UPDATE', [id, id]);
      if (existing.length === 0) {
        await connection.rollback();
        const notFoundErr = new Error('Room type not found');
        notFoundErr.status = 404;
        throw notFoundErr;
      }

      const current = existing[0];
      const updatedName = name || title || current.title;
      const updatedDesc = description !== undefined ? description : current.description;
      const updatedRate = base_rate !== undefined ? Number(base_rate) : current.base_rate;
      const updatedImg = image !== undefined ? image : current.image;

      await connection.query(
        `UPDATE room_types SET title = ?, description = ?, base_rate = ?, image = ? WHERE id = ?`,
        [updatedName, updatedDesc, updatedRate, updatedImg, current.id]
      );

      if (isFirestoreDualWriteEnabled()) {
        await enqueue(connection, {
          event_type: 'ROOM_TYPE_UPDATED',
          aggregate_type: 'ROOM_TYPE',
          aggregate_id: current.code.toUpperCase(),
          payload: {
            id: current.id,
            name: updatedName,
            code: current.code.toUpperCase(),
            description: updatedDesc,
            base_rate: updatedRate,
            image: updatedImg,
            mysql_room_type_id: current.id
          }
        });
      }

      await connection.commit();
      return { success: true, id: current.id, code: current.code, name: updatedName, base_rate: updatedRate };
    } catch (err) {
      if (connection) await connection.rollback();
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  static async deleteRoomType(id) {
    if (isFirestoreRoomTypesEnabled()) {
      try {
        const existing = await getRoomTypeByIdFirestore(id);
        if (!existing) {
          const notFoundErr = new Error('Room type not found');
          notFoundErr.status = 404;
          throw notFoundErr;
        }

        await deleteRoomTypeFirestore(existing.docId || existing.id || id);
        return { success: true, message: `Room type ${existing.code} deleted successfully` };
      } catch (err) {
        if (err.status === 404 || err.status === 400 || err.status === 409) throw err;
        console.error(`[FAIL_CLOSED:ROOM_TYPES] Firestore delete failed for ${id}:`, err.message);
        throw err;
      }
    }

    // Authoritative MySQL Path (when flag disabled)
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [existing] = await connection.query('SELECT * FROM room_types WHERE id = ? OR code = ? FOR UPDATE', [id, id]);
      if (existing.length === 0) {
        await connection.rollback();
        const notFoundErr = new Error('Room type not found');
        notFoundErr.status = 404;
        throw notFoundErr;
      }

      const current = existing[0];
      await connection.query('DELETE FROM room_types WHERE id = ?', [current.id]);

      if (isFirestoreDualWriteEnabled()) {
        await enqueue(connection, {
          event_type: 'ROOM_TYPE_DELETED',
          aggregate_type: 'ROOM_TYPE',
          aggregate_id: current.code.toUpperCase(),
          payload: {
            id: current.id,
            code: current.code.toUpperCase(),
            docId: `type_${current.code.toUpperCase()}`
          }
        });
      }

      await connection.commit();
      return { success: true, message: `Room type ${current.code} deleted successfully` };
    } catch (err) {
      if (connection) await connection.rollback();
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }
}
