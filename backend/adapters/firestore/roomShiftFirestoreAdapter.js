/**
 * roomShiftFirestoreAdapter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Atomic Firestore Transaction Adapter for Room Shift.
 */
import { db } from '../../config/firebaseAdmin.js';
import { LedgerFirestoreAdapter } from './ledgerFirestoreAdapter.js';

export const processRoomShiftFirestoreTransaction = async ({
  fromRoomNumber,
  toRoomNumber,
  adjustmentType = 'AUTOMATIC',
  manualAdjustmentAmount = 0,
  manualAmount = 0,
  manualAdjustmentReason = '',
  reason = '',
  resolvedUserId = 'admin',
  businessDate = null,
  idempotencyKey = null
}) => {
  if (!db) {
    throw new Error('Firebase Admin DB is not initialized.');
  }

  const fromStr = String(fromRoomNumber).trim();
  const toStr = String(toRoomNumber).trim();

  if (fromStr === toStr) {
    const err = new Error('Source and target room cannot be the same');
    err.status = 400;
    err.code = 'SAME_ROOM_SHIFT';
    throw err;
  }

  const nowIso = new Date().toISOString();
  let actualBusinessDate = businessDate;
  if (!actualBusinessDate) {
    const today = new Date();
    actualBusinessDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  }

  // Parse adjustment inputs
  const adjType = String(adjustmentType || 'AUTOMATIC').trim().toUpperCase();
  const parsedManualAmt = parseFloat(manualAdjustmentAmount || manualAmount || 0);
  const cleanReason = String(manualAdjustmentReason || reason || '').trim();

  if (adjType === 'INCREASE' || adjType === 'DECREASE') {
    if (isNaN(parsedManualAmt) || parsedManualAmt <= 0) {
      const err = new Error('Manual adjustment amount must be a positive number greater than 0.');
      err.status = 400;
      err.code = 'INVALID_MANUAL_AMOUNT';
      throw err;
    }
    if (!cleanReason) {
      const err = new Error('A valid reason is mandatory for manual room shift adjustments.');
      err.status = 400;
      err.code = 'MANUAL_REASON_REQUIRED';
      throw err;
    }
  }

  return await db.runTransaction(async (transaction) => {
    // 0. IDEMPOTENCY CHECK
    if (idempotencyKey) {
      const idemRef = db.collection('idempotency_keys').doc(String(idempotencyKey));
      const idemSnap = await transaction.get(idemRef);
      if (idemSnap.exists && idemSnap.data().status === 'COMPLETED') {
        return { ...idemSnap.data().result, replayed: true };
      }
    }

    // 1. READ ROOM DOCUMENTS (Source and Target)
    const sourceRoomRef = db.collection('rooms').doc(`room_${fromStr}`);
    const targetRoomRef = db.collection('rooms').doc(`room_${toStr}`);

    const [sourceSnap, targetSnap] = await Promise.all([
      transaction.get(sourceRoomRef),
      transaction.get(targetRoomRef)
    ]);

    if (!sourceSnap.exists) {
      const err = new Error(`Source Room ${fromStr} not found`);
      err.status = 404;
      err.code = 'SOURCE_ROOM_NOT_FOUND';
      throw err;
    }

    if (!targetSnap.exists) {
      const err = new Error(`Target Room ${toStr} not found`);
      err.status = 404;
      err.code = 'TARGET_ROOM_NOT_FOUND';
      throw err;
    }

    const sourceData = sourceSnap.data();
    const targetData = targetSnap.data();

    // Validate Source Room
    if (sourceData.status !== 'occupied') {
      const err = new Error(`Source Room ${fromStr} is not occupied`);
      err.status = 400;
      err.code = 'SOURCE_ROOM_NOT_OCCUPIED';
      throw err;
    }

    // Validate Target Room
    if (targetData.is_active === false || targetData.is_active === 0 || targetData.is_active === '0') {
      const err = new Error(`Target Room ${toStr} is inactive and unavailable`);
      err.status = 400;
      err.code = 'TARGET_ROOM_INACTIVE';
      throw err;
    }

    if (targetData.status !== 'vacant') {
      const err = new Error(`Target Room ${toStr} is not vacant (Current status: ${targetData.status})`);
      err.status = 400;
      err.code = 'TARGET_ROOM_NOT_VACANT';
      throw err;
    }

    if (targetData.housekeeping_status === 'Dirty' || targetData.status === 'dirty') {
      const err = new Error(`Target Room ${toStr} has pending housekeeping (Dirty)`);
      err.status = 400;
      err.code = 'TARGET_ROOM_DIRTY';
      throw err;
    }

    // 2. READ ACTIVE BOOKING ON SOURCE ROOM
    let activeBookingDocId = sourceData.current_booking_id;
    let activeBookingData = null;

    if (activeBookingDocId) {
      const bSnap = await transaction.get(db.collection('bookings').doc(activeBookingDocId));
      if (bSnap.exists) {
        activeBookingData = bSnap.data();
      }
    }

    if (!activeBookingData) {
      const err = new Error(`No active checkin found for Room ${fromStr}`);
      err.status = 400;
      err.code = 'BOOKING_NOT_FOUND';
      throw err;
    }

    const bookingRef = db.collection('bookings').doc(activeBookingDocId);

    // 3. READ EXISTING LEDGER ITEMS AND PAYMENTS FOR THIS BOOKING
    const existingLedgers = [];
    // Existing ledger items still tagged with the room being vacated -- these
    // need their room_number field synced to the destination room (Write 4b
    // below). Only the room_number field is touched; amount/type/description
    // are never modified here.
    const staleRoomLedgerRefs = [];
    const ledgerSnap = await transaction.get(
      db.collection('ledger_items').where('booking_id', '==', activeBookingDocId)
    );
    ledgerSnap.forEach(d => {
      const data = d.data();
      existingLedgers.push({ id: d.id, ...data });
      if (data.room_number === fromStr) {
        staleRoomLedgerRefs.push(d.ref);
      }
    });

    const existingPayments = [];
    const paymentSnap = await transaction.get(
      db.collection('payments').where('booking_id', '==', activeBookingDocId)
    );
    paymentSnap.forEach(d => existingPayments.push({ id: d.id, ...d.data() }));

    // 3b. FIND THE RESERVATION LINKED TO THIS BOOKING (if any).
    // Room Shift is booking-centric and has no reservationId input; a booking
    // created via Check-In from a reservation is the only way to find it, via
    // the same booking_id equality query pattern already used above for
    // ledger_items/payments. Walk-in bookings (no originating reservation)
    // simply produce zero results here, which is expected and not an error.
    const reservationSnap = await transaction.get(
      db.collection('reservations').where('booking_id', '==', activeBookingDocId)
    );
    const linkedReservationRefs = reservationSnap.docs.map(d => d.ref);

    // 4. CALCULATE SOURCE TARIFF, DESTINATION TARIFF, AND DIFFERENTIALS
    const sourceTariff = Number(sourceData.price || sourceData.rate || sourceData.base_rate || activeBookingData.room_tariff || 0);
    const targetTariff = Number(targetData.price || targetData.rate || targetData.base_rate || 0);
    const targetType = targetData.type || targetData.room_type || 'Standard';

    const automaticDifference = targetTariff - sourceTariff;

    let finalAdditionalCharge = 0;
    if (adjType === 'NO_ADJUSTMENT') {
      finalAdditionalCharge = 0;
    } else if (adjType === 'INCREASE') {
      finalAdditionalCharge = automaticDifference + parsedManualAmt;
    } else if (adjType === 'DECREASE') {
      finalAdditionalCharge = automaticDifference - parsedManualAmt;
    } else {
      // Default: AUTOMATIC
      finalAdditionalCharge = automaticDifference;
    }

    // 5. PREPARE IMMUTABLE ADJUSTMENT LEDGER ENTRY (IF ANY)
    let shiftLedgerRef = null;
    let shiftLedgerData = null;

    if (finalAdditionalCharge > 0) {
      // Upgrade charge / increase adjustment
      shiftLedgerRef = db.collection('ledger_items').doc(`ledger_${activeBookingDocId}_shift_${Date.now()}`);
      const desc = cleanReason
        ? `Room Shift Adjustment (${fromStr} → ${toStr}) - ${cleanReason}`
        : `Room Shift Upgrade (${fromStr} → ${toStr})`;

      shiftLedgerData = {
        item_id: shiftLedgerRef.id,
        booking_id: bookingRef.id,
        booking_number: activeBookingData.booking_number || bookingRef.id,
        room_number: toStr,
        desc,
        description: desc,
        qty: 1,
        amount: finalAdditionalCharge,
        debit_amount: finalAdditionalCharge,
        credit_amount: 0,
        transaction_type: 'CHARGE',
        category: 'Room Shift Adjustment',
        business_date: actualBusinessDate,
        created_at: nowIso
      };
      existingLedgers.push(shiftLedgerData);
    } else if (finalAdditionalCharge < 0) {
      // Downgrade credit / decrease adjustment
      const creditVal = Math.abs(finalAdditionalCharge);
      shiftLedgerRef = db.collection('ledger_items').doc(`ledger_${activeBookingDocId}_shift_${Date.now()}`);
      const desc = cleanReason
        ? `Room Shift Adjustment (${fromStr} → ${toStr}) - ${cleanReason}`
        : `Room Shift Downgrade Credit (${fromStr} → ${toStr})`;

      shiftLedgerData = {
        item_id: shiftLedgerRef.id,
        booking_id: bookingRef.id,
        booking_number: activeBookingData.booking_number || bookingRef.id,
        room_number: toStr,
        desc,
        description: desc,
        qty: 1,
        amount: 0,
        debit_amount: 0,
        credit_amount: creditVal,
        transaction_type: 'CREDIT',
        category: 'Room Shift Adjustment',
        business_date: actualBusinessDate,
        created_at: nowIso
      };
      existingLedgers.push(shiftLedgerData);
    }

    // Authoritative balance recalculation
    const financials = LedgerFirestoreAdapter.calculateAuthoritativeBalance(existingLedgers, existingPayments);
    const netTotalCharges = financials.netCharges;
    const outstandingBalance = financials.outstandingBalance;

    // 6. MUTATIONS

    // Write 1: Update Booking with new Room, new canonical tariff, and updated total_amount
    transaction.set(bookingRef, {
      room_id: targetRoomRef.id,
      room_number: toStr,
      room_tariff: targetTariff > 0 ? targetTariff : (activeBookingData.room_tariff || 0),
      total_amount: netTotalCharges,
      updated_at: nowIso
    }, { merge: true });

    // Write 1b: Sync room_number/room_id on the reservation that originated
    // this booking (if any). Only these two cross-reference fields are
    // touched -- status, dates, and guest fields are never modified here.
    linkedReservationRefs.forEach(reservationRef => {
      transaction.set(reservationRef, {
        room_number: toStr,
        room_id: targetRoomRef.id,
        updated_at: nowIso
      }, { merge: true });
    });

    // Write 2: Release Source Room (Vacant)
    transaction.set(sourceRoomRef, {
      status: 'vacant',
      current_booking_id: null,
      updated_at: nowIso
    }, { merge: true });

    // Write 3: Occupy Target Room
    transaction.set(targetRoomRef, {
      status: 'occupied',
      current_booking_id: bookingRef.id,
      updated_at: nowIso
    }, { merge: true });

    // Write 4: Shift Ledger Item (if any)
    if (shiftLedgerRef && shiftLedgerData) {
      transaction.set(shiftLedgerRef, shiftLedgerData);
    }

    // Write 4b: Sync room_number on existing ledger items still pointing at
    // the vacated room (e.g. the original room-tariff charge from Check-In).
    // Amount, transaction_type, description, and totals are never touched --
    // only the room_number cross-reference field.
    staleRoomLedgerRefs.forEach(ledgerItemRef => {
      transaction.set(ledgerItemRef, {
        room_number: toStr,
        updated_at: nowIso
      }, { merge: true });
    });

    // Write 5: Room Status History for Source Room
    const rshSourceRef = db.collection('room_status_history').doc(`rsh_${fromStr}_shift_${Date.now()}`);
    transaction.set(rshSourceRef, {
      room_id: sourceRoomRef.id,
      room_number: fromStr,
      old_status: 'occupied',
      new_status: 'vacant',
      changed_by: String(resolvedUserId),
      business_date: actualBusinessDate,
      created_at: nowIso
    });

    // Write 6: Room Status History for Target Room
    const rshTargetRef = db.collection('room_status_history').doc(`rsh_${toStr}_shift_${Date.now()}`);
    transaction.set(rshTargetRef, {
      room_id: targetRoomRef.id,
      room_number: toStr,
      old_status: 'vacant',
      new_status: 'occupied',
      changed_by: String(resolvedUserId),
      business_date: actualBusinessDate,
      created_at: nowIso
    });

    // Write 7: Booking History Record
    const histRef = db.collection('booking_history').doc(`bh_${bookingRef.id}_shift_${Date.now()}`);
    transaction.set(histRef, {
      booking_id: bookingRef.id,
      action: 'SHIFT_ROOM',
      old_room_id: sourceRoomRef.id,
      new_room_id: targetRoomRef.id,
      old_room_number: fromStr,
      new_room_number: toStr,
      source_tariff: sourceTariff,
      destination_tariff: targetTariff,
      automatic_difference: automaticDifference,
      adjustment_type: adjType,
      manual_amount: parsedManualAmt,
      final_additional_charge: finalAdditionalCharge,
      changed_by: String(resolvedUserId),
      business_date: actualBusinessDate,
      notes: `Shifted from Room ${fromStr} (₹${sourceTariff}) to Room ${toStr} (₹${targetTariff}). Diff: ₹${finalAdditionalCharge}`,
      created_at: nowIso
    });

    // Write 8: Room Shift Adjustment Audit Record
    const rsaRef = db.collection('room_shift_adjustments').doc(`rsa_${bookingRef.id}_${Date.now()}`);
    transaction.set(rsaRef, {
      id: rsaRef.id,
      booking_id: bookingRef.id,
      booking_number: activeBookingData.booking_number || bookingRef.id,
      guest_id: activeBookingData.guest_id || null,
      guest_name: activeBookingData.guest_name || 'GUEST',
      source_room: fromStr,
      destination_room: toStr,
      source_tariff: sourceTariff,
      destination_tariff: targetTariff,
      automatic_difference: automaticDifference,
      adjustment_type: adjType,
      manual_amount: parsedManualAmt,
      final_additional_amount: finalAdditionalCharge,
      reason: cleanReason || 'Automatic room shift tariff adjustment',
      created_by: String(resolvedUserId),
      business_date: actualBusinessDate,
      created_at: nowIso,
      shift_id: histRef.id
    });

    // Write 9: Audit Log
    const auditRef = db.collection('audit_logs').doc(`audit_shift_${bookingRef.id}_${Date.now()}`);
    transaction.set(auditRef, {
      user_id: String(resolvedUserId),
      action: 'SHIFT_ROOM',
      details: `Shifted guest reservation (Booking: ${activeBookingData.booking_number || bookingRef.id}) from Room ${fromStr} (₹${sourceTariff}) to ${toStr} (₹${targetTariff}). Additional charge: ₹${finalAdditionalCharge}`,
      business_date: actualBusinessDate,
      created_at: nowIso
    });

    const resultPayload = {
      success: true,
      message: `Successfully shifted guest from Room ${fromStr} to ${toStr}`,
      bookingId: bookingRef.id,
      fromRoomNumber: fromStr,
      toRoomNumber: toStr,
      sourceTariff,
      destinationTariff: targetTariff,
      automaticDifference,
      adjustmentType: adjType,
      manualAmount: parsedManualAmt,
      finalAdditionalCharge,
      netTotalCharges,
      totalPayments: financials.totalPayments,
      outstandingBalance
    };

    // Write 10: Idempotency Record
    if (idempotencyKey) {
      const idemRef = db.collection('idempotency_keys').doc(String(idempotencyKey));
      transaction.set(idemRef, {
        idempotency_key: String(idempotencyKey),
        status: 'COMPLETED',
        result: resultPayload,
        created_at: nowIso
      });
    }

    return resultPayload;
  }, { maxAttempts: 1 });
};

export default {
  processRoomShiftFirestoreTransaction
};
