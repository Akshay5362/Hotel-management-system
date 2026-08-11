import {
  createRoomFirestore, updateRoomFirestore, updateRoomStatusFirestore, deleteRoomFirestore, getRoomByIdFirestore, formatRoomId,
  createGuestFirestore, updateGuestFirestore, getGuestByIdFirestore, formatGuestId,
  createBookingFirestore, updateBookingFirestore, updateBookingStatusFirestore, deleteBookingFirestore, getBookingByIdFirestore, formatBookingId,
  createBookingHistoryFirestore,
  createRoomTypeFirestore, updateRoomTypeFirestore, deleteRoomTypeFirestore, getRoomTypeByIdFirestore,
  createStaffFirestore, updateStaffFirestore, deleteStaffFirestore, getStaffByIdFirestore, formatStaffId,
  createInventoryCategoryFirestore, updateInventoryCategoryFirestore, deleteInventoryCategoryFirestore, getInventoryCategoryByIdFirestore, formatCategoryDocId,
  updateSystemDateFirestore, updateSystemSettingFirestore,
  createInventoryProductFirestore, updateInventoryProductFirestore, deleteInventoryProductFirestore, updateProductStockFirestore, getInventoryProductByIdFirestore, formatProductDocId,
  createHousekeepingRecordFirestore, updateHousekeepingRecordFirestore, deleteHousekeepingRecordFirestore, getHousekeepingByIdFirestore,
  createAuditLogFirestore, deleteAuditLogFirestore
} from '../repositories/firestore/index.js';

export class DispatcherError extends Error {
  constructor(message, code = 'DISPATCH_ERROR') {
    super(message);
    this.name = 'DispatcherError';
    this.code = code;
  }
}

/**
 * Dispatches an outbox event to its corresponding Firestore Repository method.
 */
export async function dispatchEvent(event) {
  if (!event || !event.event_type) {
    throw new DispatcherError('Invalid event object for dispatch', 'INVALID_DISPATCH_EVENT');
  }

  let payload = event.payload;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (e) {
      throw new DispatcherError(`Failed to parse event JSON payload: ${e.message}`, 'INVALID_JSON_PAYLOAD');
    }
  }

  const eventType = String(event.event_type).toUpperCase();

  switch (eventType) {
    case 'TEST_ROOM_UPSERT':
      return await createRoomFirestore(payload);

    case 'TEST_GUEST_UPSERT':
      return await createGuestFirestore(payload);

    case 'TEST_BOOKING_UPSERT':
      return await createBookingFirestore(payload);

    // ── Phase 3B Room Type Events ──────────────────────────────────────────────
    case 'ROOM_TYPE_CREATED': {
      const codeStr = String(payload.code).toUpperCase().trim();
      const docId = `type_${codeStr}`;
      const existing = await getRoomTypeByIdFirestore(docId);

      if (existing) {
        return await updateRoomTypeFirestore(docId, {
          name: payload.name || payload.title || existing.name,
          description: payload.description !== undefined ? payload.description : existing.description,
          base_rate: payload.base_rate !== undefined ? Number(payload.base_rate) : existing.base_rate,
          updated_at: new Date().toISOString()
        });
      }

      return await createRoomTypeFirestore({
        name: payload.name || payload.title,
        code: payload.code,
        description: payload.description || '',
        base_rate: payload.base_rate,
        mysql_room_type_id: payload.mysql_room_type_id || payload.id
      });
    }

    case 'ROOM_TYPE_UPDATED': {
      const codeStr = String(payload.code).toUpperCase().trim();
      const docId = `type_${codeStr}`;
      const existing = await getRoomTypeByIdFirestore(docId);

      if (!existing) {
        return await createRoomTypeFirestore({
          name: payload.name || payload.title,
          code: payload.code,
          description: payload.description || '',
          base_rate: payload.base_rate,
          mysql_room_type_id: payload.mysql_room_type_id || payload.id
        });
      }

      return await updateRoomTypeFirestore(docId, {
        name: payload.name || payload.title || existing.name,
        description: payload.description !== undefined ? payload.description : existing.description,
        base_rate: payload.base_rate !== undefined ? Number(payload.base_rate) : existing.base_rate,
        updated_at: new Date().toISOString()
      });
    }

    case 'ROOM_TYPE_DELETED': {
      const codeStr = String(payload.code).toUpperCase().trim();
      const docId = payload.docId || `type_${codeStr}`;
      return await deleteRoomTypeFirestore(docId).catch(err => {
        if (err.code === 'NOT_FOUND') return null;
        throw err;
      });
    }

    // ── Phase 3C Room Events ──────────────────────────────────────────────────
    case 'ROOM_CREATED': {
      const roomNum = payload.number || payload.room_number;
      const docId = formatRoomId(roomNum);
      const existing = await getRoomByIdFirestore(docId);

      if (existing) {
        return await updateRoomFirestore(docId, payload);
      }
      return await createRoomFirestore(payload);
    }

    case 'ROOM_UPDATED':
      return await updateRoomFirestore(`room_${payload.number || payload.room_number}`, payload);

    case 'ROOM_STATUS_CHANGED':
      return await updateRoomStatusFirestore(`room_${payload.number || payload.room_number}`, payload);

    case 'ROOM_DELETED':
      return await deleteRoomFirestore(payload.docId || `room_${payload.number || payload.room_number}`);

    // ── Phase 3D Staff Events ──────────────────────────────────────────────────
    case 'STAFF_CREATED': {
      const staffKey = payload.user_uid || payload.username;
      const docId = formatStaffId(staffKey);
      const existing = await getStaffByIdFirestore(docId);

      if (existing) {
        return await updateStaffFirestore(docId, payload);
      }
      return await createStaffFirestore(payload);
    }

    case 'STAFF_UPDATED':
    case 'STAFF_STATUS_CHANGED': {
      const staffKey = payload.user_uid || payload.username || payload.staff_id || payload.id;
      return await updateStaffFirestore(String(staffKey), payload);
    }

    case 'STAFF_DELETED': {
      const staffKey = payload.docId || payload.user_uid || payload.username || payload.id;
      return await deleteStaffFirestore(String(staffKey)).catch(err => {
        if (err.code === 'NOT_FOUND') return null;
        throw err;
      });
    }

    // ── Phase 3E Inventory Category Events ─────────────────────────────────────
    case 'INVENTORY_CATEGORY_CREATED': {
      const catName = payload.name || payload.category_name;
      const docId = formatCategoryDocId(catName);
      const existing = await getInventoryCategoryByIdFirestore(docId);

      if (existing) {
        return await updateInventoryCategoryFirestore(docId, payload);
      }
      return await createInventoryCategoryFirestore(payload);
    }

    case 'INVENTORY_CATEGORY_UPDATED': {
      const catKey = payload.docId || payload.name || payload.id;
      return await updateInventoryCategoryFirestore(String(catKey), payload);
    }

    case 'INVENTORY_CATEGORY_DELETED': {
      const catKey = payload.docId || payload.name || payload.id;
      return await deleteInventoryCategoryFirestore(String(catKey)).catch(err => {
        if (err.code === 'NOT_FOUND') return null; // Idempotent deletion
        throw err;
      });
    }

    // ── Phase 3F System Settings Events ─────────────────────────────────────────
    case 'SYSTEM_DATE_UPDATED': {
      const dateVal = payload.current_date || payload.system_date || payload.date;
      return await updateSystemDateFirestore(dateVal, { updated_at: payload.updated_at });
    }

    case 'SYSTEM_SETTING_UPDATED': {
      const settingId = payload.key_name || payload.settingId || payload.id || 'system_date';
      return await updateSystemSettingFirestore(String(settingId), payload);
    }

    // ── Phase 3G Inventory Product Events ──────────────────────────────────────
    case 'INVENTORY_PRODUCT_CREATED': {
      const skuStr = payload.sku;
      const docId = formatProductDocId(skuStr);
      const existing = await getInventoryProductByIdFirestore(docId);

      if (existing) {
        return await updateInventoryProductFirestore(docId, payload);
      }
      return await createInventoryProductFirestore(payload);
    }

    case 'INVENTORY_PRODUCT_UPDATED':
    case 'INVENTORY_PRODUCT_DEACTIVATED': {
      const prodKey = payload.docId || payload.sku || payload.id;
      return await updateInventoryProductFirestore(String(prodKey), payload);
    }

    case 'INVENTORY_PRODUCT_STOCK_UPDATED': {
      const prodKey = payload.docId || payload.sku || payload.id;
      return await updateInventoryProductFirestore(String(prodKey), payload);
    }

    case 'INVENTORY_PRODUCT_DELETED': {
      const prodKey = payload.docId || payload.sku || payload.id;
      return await deleteInventoryProductFirestore(String(prodKey)).catch(err => {
        if (err.code === 'NOT_FOUND') return null; // Idempotent deletion
        throw err;
      });
    }

    // ── Phase 3H Guest Profile Events ──────────────────────────────────────────
    case 'GUEST_CREATED': {
      const guestKey = payload.phone || payload.user_uid || payload.guest_id || payload.id;
      const docId = formatGuestId(guestKey);
      const existing = await getGuestByIdFirestore(docId);

      if (existing) {
        return await updateGuestFirestore(docId, payload);
      }
      return await createGuestFirestore(payload);
    }

    case 'GUEST_UPDATED': {
      const guestKey = payload.docId || payload.phone || payload.user_uid || payload.guest_id || payload.id;
      return await updateGuestFirestore(String(guestKey), payload);
    }

    // ── Phase 3I Housekeeping Events ───────────────────────────────────────────
    case 'HOUSEKEEPING_STATUS_UPDATED': {
      const hkKey = payload.docId || payload.room_number || payload.room_id || payload.id;
      const docId = String(hkKey).startsWith('hk_') ? String(hkKey) : `hk_room_${hkKey}`;
      const existing = await getHousekeepingByIdFirestore(docId);

      if (existing) {
        return await updateHousekeepingRecordFirestore(docId, payload);
      }
      return await createHousekeepingRecordFirestore({ ...payload, docId });
    }

    case 'HOUSEKEEPING_LOG_CREATED': {
      const hkKey = payload.docId || payload.room_number || payload.room_id || payload.id;
      const docId = String(hkKey).startsWith('hk_') ? String(hkKey) : `hk_room_${hkKey}`;
      return await updateHousekeepingRecordFirestore(docId, payload);
    }

    // ── Phase 3J Audit Log Events ──────────────────────────────────────────────
    case 'AUDIT_LOG_CREATED': {
      return await createAuditLogFirestore(payload);
    }

    // ── Phase 3K Booking Events ──────────────────────────────────────────────────
    case 'BOOKING_CREATED': {
      const bkgNum = payload.booking_number || payload.number;
      const docId = formatBookingId(bkgNum);
      const existing = await getBookingByIdFirestore(docId);

      if (existing) {
        return await updateBookingFirestore(docId, payload);
      }
      return await createBookingFirestore(payload);
    }

    case 'BOOKING_UPDATED': {
      const bkgNum = payload.booking_number || payload.number || payload.booking_id;
      const docId = String(bkgNum).startsWith('bkg_') ? String(bkgNum) : formatBookingId(bkgNum);
      return await updateBookingFirestore(docId, payload);
    }

    case 'BOOKING_STATUS_CHANGED': {
      const bkgNum = payload.booking_number || payload.number || payload.booking_id;
      const docId = String(bkgNum).startsWith('bkg_') ? String(bkgNum) : formatBookingId(bkgNum);
      return await updateBookingStatusFirestore(docId, payload.booking_status, payload.payment_status, { updated_at: payload.updated_at });
    }

    case 'BOOKING_HISTORY_CREATED': {
      return await createBookingHistoryFirestore(payload);
    }

    case 'BOOKING_DELETED': {
      const bkgNum = payload.docId || payload.booking_number || payload.number || payload.booking_id;
      const docId = String(bkgNum).startsWith('bkg_') ? String(bkgNum) : formatBookingId(bkgNum);
      return await deleteBookingFirestore(docId).catch(err => {
        if (err.code === 'NOT_FOUND') return null; // Idempotent deletion
        throw err;
      });
    }

    default:
      throw new DispatcherError(`Unsupported event_type for dispatch: '${eventType}'`, 'UNSUPPORTED_EVENT_TYPE');
  }
}
