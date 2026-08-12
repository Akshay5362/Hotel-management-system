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
  createAuditLogFirestore, deleteAuditLogFirestore,
  // Phase 2 additions
  createPaymentFirestore, updatePaymentFirestore,
  createLedgerItemFirestore,
  createInvoiceFirestore, updateInvoiceFirestore, getInvoiceByIdFirestore, formatInvoiceId,
  createReservationFirestore, updateReservationFirestore, getReservationByIdFirestore, formatReservationId,
  createCashLogFirestore,
  createCashSubmissionFirestore,
  createRazorpayTransactionFirestore, updateRazorpayTransactionFirestore, getRazorpayTransactionByOrderIdFirestore,
  createCheckoutSnapshotFirestore, getCheckoutSnapshotByBookingFirestore
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

    // ── Phase 2A Payment Events ──────────────────────────────────────────────
    case 'PAYMENT_CREATED': {
      // Resolve deterministic payment doc ID from payload
      const paymentId = payload.payment_id || payload.id
        ? `payment_${payload.payment_id || payload.id}`
        : null;
      return await createPaymentFirestore({
        ...payload,
        payment_id: paymentId
      });
    }

    // ── Phase 2B Ledger Item Events ──────────────────────────────────────────
    case 'LEDGER_ITEM_CREATED': {
      const itemId = payload.item_id || payload.id
        ? `ledger_${payload.item_id || payload.id}`
        : null;
      return await createLedgerItemFirestore({
        ...payload,
        item_id: itemId
      });
    }

    // ── Phase 2C Invoice Events ──────────────────────────────────────────────
    case 'INVOICE_CREATED': {
      if (!payload.invoice_number) {
        throw new DispatcherError('INVOICE_CREATED event missing required field: invoice_number', 'INVALID_PAYLOAD');
      }
      const invDocId = formatInvoiceId(payload.invoice_number);
      const existingInv = await getInvoiceByIdFirestore(invDocId);

      if (existingInv) {
        // Idempotent — invoice already exists; update instead of duplicating
        return await updateInvoiceFirestore(invDocId, {
          paid_amount: payload.paid_amount !== undefined ? Number(payload.paid_amount) : existingInv.paid_amount,
          outstanding_amount: payload.outstanding_amount !== undefined ? Number(payload.outstanding_amount) : existingInv.outstanding_amount,
          invoice_status: payload.invoice_status || payload.status || existingInv.invoice_status,
          updated_at: new Date().toISOString()
        });
      }

      return await createInvoiceFirestore({
        ...payload,
        mysql_invoice_id: payload.mysql_invoice_id || payload.id || null
      });
    }

    // ── Phase 2D Reservation Events ──────────────────────────────────────────
    case 'RESERVATION_CREATED': {
      if (!payload.reservation_number) {
        throw new DispatcherError('RESERVATION_CREATED event missing required field: reservation_number', 'INVALID_PAYLOAD');
      }
      const resDocId = formatReservationId(payload.reservation_number);
      const existingRes = await getReservationByIdFirestore(resDocId);

      if (existingRes) {
        // Idempotent upsert
        return await updateReservationFirestore(resDocId, {
          ...payload,
          updated_at: new Date().toISOString()
        });
      }

      return await createReservationFirestore({
        ...payload,
        mysql_reservation_id: payload.mysql_reservation_id || payload.id || null
      });
    }

    case 'RESERVATION_UPDATED': {
      const resKey = payload.reservation_number || payload.reservation_id || payload.id;
      if (!resKey) {
        throw new DispatcherError('RESERVATION_UPDATED event missing reservation_number or id', 'INVALID_PAYLOAD');
      }
      const resDocId = String(resKey).startsWith('res_') ? String(resKey) : formatReservationId(resKey);
      const existingRes = await getReservationByIdFirestore(resDocId);

      if (!existingRes) {
        // Upsert — create if not found
        return await createReservationFirestore({
          ...payload,
          reservation_number: String(resKey),
          mysql_reservation_id: payload.mysql_reservation_id || payload.id || null
        });
      }

      return await updateReservationFirestore(resDocId, {
        ...payload,
        updated_at: new Date().toISOString()
      });
    }

    // ── Phase 2E Cash Log Events ─────────────────────────────────────────────
    case 'CASH_LOG_CREATED': {
      const logId = payload.log_id || payload.id
        ? `cash_log_${payload.log_id || payload.id}`
        : null;
      return await createCashLogFirestore({
        ...payload,
        log_id: logId
      });
    }

    // ── Phase 2F Cash Submission Events ─────────────────────────────────────
    case 'CASH_SUBMISSION_CREATED': {
      const subId = payload.sub_id || payload.receipt_id || payload.id
        ? `cash_sub_${payload.sub_id || payload.receipt_id || payload.id}`
        : null;
      return await createCashSubmissionFirestore({
        ...payload,
        sub_id: subId,
        // Map MySQL field names to repository expectations
        user_id: payload.user_id || payload.receptionist_id || null,
        staff_name: payload.staff_name || payload.receptionist_name || '',
        notes: payload.notes || payload.remarks || ''
      });
    }

    // ── Phase 2G Razorpay Transaction Events ─────────────────────────────────
    case 'RAZORPAY_TRANSACTION_CREATED': {
      if (!payload.order_id) {
        throw new DispatcherError('RAZORPAY_TRANSACTION_CREATED event missing required field: order_id', 'INVALID_PAYLOAD');
      }
      const existingRzp = await getRazorpayTransactionByOrderIdFirestore(payload.order_id);

      if (existingRzp) {
        // Idempotent — gateway order already tracked; apply any updates
        return await updateRazorpayTransactionFirestore(payload.order_id, {
          status: payload.status || existingRzp.status,
          payment_id: payload.payment_id || existingRzp.payment_id,
          signature: payload.signature || existingRzp.signature,
          updated_at: new Date().toISOString()
        });
      }

      return await createRazorpayTransactionFirestore({
        ...payload,
        mysql_transaction_id: payload.mysql_transaction_id || payload.id || null
      });
    }

    // ── Phase 2H Checkout Snapshot Events ───────────────────────────────────
    case 'CHECKOUT_SNAPSHOT_CREATED': {
      if (!payload.booking_id) {
        throw new DispatcherError('CHECKOUT_SNAPSHOT_CREATED event missing required field: booking_id', 'INVALID_PAYLOAD');
      }
      const existingSnap = await getCheckoutSnapshotByBookingFirestore(payload.booking_id);

      if (existingSnap) {
        // Idempotent — snapshot already exists for this booking; skip re-creation
        console.log(`[Dispatcher] Checkout snapshot already exists for booking ${payload.booking_id}; skipping duplicate write.`);
        return existingSnap;
      }

      return await createCheckoutSnapshotFirestore({
        booking_id: payload.booking_id,
        snapshot_data: payload.snapshot_data || payload,
        mysql_booking_id: payload.mysql_booking_id || null
      });
    }

    // ── Phase 2I Stay Extension Events ──────────────────────────────────────
    //
    // NOTE: No dedicated stay_extensions Firestore repository exists yet.
    // Strategy: write a booking_history record (audit trail) AND update the
    // parent booking's expected_check_out_date so Firestore stays consistent.
    // A dedicated stay_extensions repository will be created in Phase 4.
    case 'STAY_EXTENSION_CREATED': {
      const bkgRef = payload.booking_number || payload.booking_id;
      if (!bkgRef) {
        throw new DispatcherError('STAY_EXTENSION_CREATED event missing booking_number or booking_id', 'INVALID_PAYLOAD');
      }

      const extDocId = payload.extension_id || payload.id
        ? `history_ext_${payload.extension_id || payload.id}`
        : `history_ext_${Date.now()}`;

      // 1. Record the extension as a booking history entry
      await createBookingHistoryFirestore({
        history_id: extDocId,
        booking_id: bkgRef,
        action: 'STAY_EXTENSION_REQUESTED',
        details: JSON.stringify({
          current_checkout: payload.current_checkout_date,
          requested_checkout: payload.requested_checkout_date,
          status: payload.status || 'Pending',
          extension_id: payload.extension_id || payload.id
        }),
        changed_by: payload.guest_id || null,
        business_date: payload.business_date || new Date().toISOString().split('T')[0],
        created_at: payload.created_at || new Date().toISOString()
      });

      return { action: 'STAY_EXTENSION_CREATED', booking_id: bkgRef, status: 'recorded' };
    }

    case 'STAY_EXTENSION_RESOLVED': {
      const bkgRef = payload.booking_number || payload.booking_id;
      if (!bkgRef) {
        throw new DispatcherError('STAY_EXTENSION_RESOLVED event missing booking_number or booking_id', 'INVALID_PAYLOAD');
      }

      const resolvedDocId = payload.extension_id || payload.id
        ? `history_ext_resolved_${payload.extension_id || payload.id}`
        : `history_ext_resolved_${Date.now()}`;

      // 1. Record resolution as a booking history entry
      await createBookingHistoryFirestore({
        history_id: resolvedDocId,
        booking_id: bkgRef,
        action: 'STAY_EXTENSION_RESOLVED',
        details: JSON.stringify({
          resolution: payload.resolution || payload.status || 'Approved',
          new_checkout: payload.new_checkout_date || payload.requested_checkout_date,
          extension_id: payload.extension_id || payload.id
        }),
        changed_by: payload.admin_id || payload.resolved_by || null,
        business_date: payload.business_date || new Date().toISOString().split('T')[0],
        created_at: payload.created_at || new Date().toISOString()
      });

      // 2. If approved, update the booking's expected_check_out_date in Firestore
      const approvedStatuses = ['approved', 'Approved', 'APPROVED'];
      const isApproved = approvedStatuses.includes(payload.resolution || payload.status || '');
      const newCheckout = payload.new_checkout_date || payload.requested_checkout_date;

      if (isApproved && newCheckout && bkgRef) {
        const bkgDocId = String(bkgRef).startsWith('bkg_') ? String(bkgRef) : formatBookingId(bkgRef);
        await updateBookingFirestore(bkgDocId, {
          expected_check_out_date: String(newCheckout),
          updated_at: new Date().toISOString()
        });
      }

      return { action: 'STAY_EXTENSION_RESOLVED', booking_id: bkgRef, status: 'recorded' };
    }

    default:
      throw new DispatcherError(`Unsupported event_type for dispatch: '${eventType}'`, 'UNSUPPORTED_EVENT_TYPE');
  }
}
