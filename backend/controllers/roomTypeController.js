import pool from '../db.js';
import { db } from '../config/firebaseAdmin.js';
import { enqueue } from '../services/outboxService.js';
import { isFirestoreDualWriteEnabled, isRoomTypesReadCanaryEnabled } from '../config/featureFlags.js';
import { executeReadCanary } from '../services/dualReadVerificationService.js';

export const getRoomTypes = async (req, res) => {
  const canaryResult = await executeReadCanary({
    flagCheckFn: isRoomTypesReadCanaryEnabled,
    endpointName: '/api/room-types',
    fetchFirestoreFn: async () => {
      const snap = await db.collection('room_types').get();
      return snap.docs.map(doc => ({ ...doc.data(), firestore_id: doc.id }));
    },
    validateAndFormatFn: (docs) => {
      if (!Array.isArray(docs) || docs.length === 0) return null;
      const formatted = docs.map(d => ({
        id: d.id || d.mysql_room_type_id || d.firestore_id,
        code: d.code || 'DELUXE',
        title: d.title || d.name || 'Room Type',
        name: d.name || d.title || 'Room Type',
        description: d.description || '',
        base_rate: parseFloat(d.base_rate || d.price || 0),
        image: d.image || null
      }));
      formatted.sort((a, b) => Number(a.id) - Number(b.id));
      return formatted.length >= 1 ? formatted : null;
    }
  });

  if (canaryResult) {
    return res.json(canaryResult);
  }

  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM room_types ORDER BY id ASC');
    res.json(rows);
  } catch (error) {
    console.error('Error fetching room types:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

export const getRoomTypeById = async (req, res) => {
  const { id } = req.params;
  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM room_types WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Room type not found' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching room type:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

export const createRoomType = async (req, res) => {
  const { code, title, name, description, base_rate, image } = req.body;
  const roomTypeName = name || title;

  if (!code || !roomTypeName || base_rate === undefined) {
    return res.status(400).json({ error: 'Missing required fields: code, title/name, base_rate' });
  }

  const codeUpper = String(code).toUpperCase().trim();
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [result] = await connection.query(
      `INSERT INTO room_types (code, title, description, base_rate, image) VALUES (?, ?, ?, ?, ?)`,
      [codeUpper, roomTypeName, description || '', Number(base_rate), image || '']
    );

    const roomTypeId = result.insertId;

    // Enqueue Transactional Outbox Event if feature flag enabled
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
    res.status(201).json({ success: true, id: roomTypeId, code: codeUpper, name: roomTypeName, base_rate: Number(base_rate) });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Error creating room type:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

export const updateRoomType = async (req, res) => {
  const { id } = req.params;
  const { title, name, description, base_rate, image } = req.body;
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [existing] = await connection.query('SELECT * FROM room_types WHERE id = ? FOR UPDATE', [id]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Room type not found' });
    }

    const current = existing[0];
    const updatedName = name || title || current.title;
    const updatedDesc = description !== undefined ? description : current.description;
    const updatedRate = base_rate !== undefined ? Number(base_rate) : current.base_rate;
    const updatedImg = image !== undefined ? image : current.image;

    await connection.query(
      `UPDATE room_types SET title = ?, description = ?, base_rate = ?, image = ? WHERE id = ?`,
      [updatedName, updatedDesc, updatedRate, updatedImg, id]
    );

    // Enqueue Transactional Outbox Event if feature flag enabled
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
    res.json({ success: true, id: Number(id), code: current.code, name: updatedName, base_rate: updatedRate });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Error updating room type:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

export const deleteRoomType = async (req, res) => {
  const { id } = req.params;
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [existing] = await connection.query('SELECT * FROM room_types WHERE id = ? FOR UPDATE', [id]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Room type not found' });
    }

    const current = existing[0];
    await connection.query('DELETE FROM room_types WHERE id = ?', [id]);

    // Enqueue Transactional Outbox Event if feature flag enabled
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
    res.json({ success: true, message: `Room type ${current.code} deleted successfully` });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Error deleting room type:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};
