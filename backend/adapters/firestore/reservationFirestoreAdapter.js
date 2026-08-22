import { db } from '../../config/firebaseAdmin.js';
import {
  parseToComparableDate,
  isDateOverlap,
  sortRoomsNumerically
} from '../../services/firestoreAvailabilityService.js';
import {
  formatReservationId,
  formatRoomId,
  formatBookingId
} from '../../repositories/firestore/firestoreUtils.js';

const BLOCKED_ROOM_STATUSES = Object.freeze(['occupied', 'dirty', 'out_of_order', 'maintenance', 'blocked']);
const ACTIVE_BOOKING_STATUSES = Object.freeze(['Checked In', 'Reserved']);
const ACTIVE_RESERVATION_STATUSES = Object.freeze(['Reserved', 'Confirmed', 'Pending']);

/**
 * Checks if an entity matches a room identifier.
 */
function matchesRoom(entity, targetDocId, targetNumber, targetMysqlId = null) {
  if (!entity) return false;
  const entityRoomId = entity.room_id ? String(entity.room_id) : null;
  const entityRoomNum = entity.room_number ? String(entity.room_number) : null;
  const entityMysqlId = entity.mysql_room_id !== undefined && entity.mysql_room_id !== null ? Number(entity.mysql_room_id) : null;

  const targetDocIdStr = targetDocId ? String(targetDocId) : null;
  const targetNumStr = targetNumber ? String(targetNumber) : null;

  if (targetDocIdStr && entityRoomId && (entityRoomId === targetDocIdStr || entityRoomId === targetDocIdStr.replace(/^room_/, ''))) {
    return true;
  }
  if (targetNumStr && (entityRoomNum === targetNumStr || entityRoomId === targetNumStr || entityRoomId === `room_${targetNumStr}`)) {
    return true;
  }
  if (targetMysqlId !== null && entityMysqlId !== null && entityMysqlId === Number(targetMysqlId)) {
    return true;
  }
  return false;
}

/**
 * Checks if an entity matches exclusion ID (for updates).
 */
function matchesExclusion(entity, excludeId) {
  if (!excludeId || !entity) return false;
  const exStr = String(excludeId).trim();
  const idStr = String(entity.id || entity.doc_id || '');
  const numStr = String(entity.reservation_number || entity.booking_number || '');
  const mysqlId = entity.mysql_reservation_id || entity.mysql_booking_id || entity.id;

  if (idStr === exStr || idStr === `res_${exStr}` || idStr === `reservation_${exStr}`) return true;
  if (numStr === exStr) return true;
  if (mysqlId && String(mysqlId) === exStr) return true;
  return false;
}

export class ReservationFirestoreAdapter {
  /**
   * Generates sequential Reservation Number: RES-YYYYMMDD-XXXX
   */
  static async generateReservationNumber(businessDate = null) {
    const compDate = parseToComparableDate(businessDate) || new Date().toISOString().split('T')[0];
    const dateStr = compDate.replace(/-/g, '');
    const prefix = `RES-${dateStr}-`;

    const snap = await db.collection('reservations')
      .where('reservation_number', '>=', prefix)
      .where('reservation_number', '<=', prefix + '\uf8ff')
      .get();

    let maxSeq = 1000;
    snap.forEach(doc => {
      const data = doc.data();
      const num = data?.reservation_number || '';
      const parts = num.split('-');
      if (parts.length === 3) {
        const seq = parseInt(parts[2], 10);
        if (!isNaN(seq) && seq > maxSeq) {
          maxSeq = seq;
        }
      }
    });

    return `${prefix}${maxSeq + 1}`;
  }

  /**
   * Atomically creates a reservation in Firestore with availability validation and idempotency.
   */
  static async createReservationFirestore(params) {
    const {
      guestName,
      phone,
      email = '',
      address = '',
      nationality = 'Indian',
      state = '',
      company = '',
      purpose = '',
      arrivalDate,
      arrivalTime = '12:00 PM',
      departureDate,
      adults = 1,
      children = 0,
      roomType = 'STANDARD',
      roomNumber,
      roomId = null,
      bookingSource = 'Direct',
      bookingMode = 'Offline',
      bookedBy = '',
      bookedByContact = '',
      advancePayment = 0,
      paymentMode = 'Cash',
      billingInstructions = '',
      transportMode = 'Self',
      remarks = '',
      dateOfBirth = null,
      dob = null,
      user = {},
      businessDate = null,
      idempotencyKey = null
    } = params;

    // Field Validations
    if (!guestName || typeof guestName !== 'string' || guestName.trim() === '') {
      const err = new Error('Guest name is required');
      err.status = 400;
      throw err;
    }
    if (!phone || typeof phone !== 'string' || phone.trim() === '') {
      const err = new Error('Contact phone number is required');
      err.status = 400;
      throw err;
    }
    if (!arrivalDate || !departureDate) {
      const err = new Error('Arrival and Departure dates are required');
      err.status = 400;
      throw err;
    }

    const sArr = parseToComparableDate(arrivalDate);
    const sDep = parseToComparableDate(departureDate);
    if (!sArr || !sDep || sArr >= sDep) {
      const err = new Error('Arrival date must be strictly before departure date');
      err.status = 400;
      throw err;
    }

    const parsedAdvance = parseInt(advancePayment, 10) || 0;
    if (parsedAdvance < 0) {
      const err = new Error('Advance payment must be a non-negative number');
      err.status = 400;
      throw err;
    }

    const selectedRoomNumber = roomNumber ? String(roomNumber).trim() : '';
    if (!selectedRoomNumber) {
      const err = new Error('Please select a room for reservation');
      err.status = 400;
      throw err;
    }

    const roomDocId = roomId ? (String(roomId).startsWith('room_') ? String(roomId) : formatRoomId(roomId)) : formatRoomId(selectedRoomNumber);
    const nowIso = new Date().toISOString();
    const resolvedDob = dateOfBirth || dob || null;
    const userId = user?.id || user?.uid || null;

    // Generate Reservation Number before transaction
    const reservationNumber = await this.generateReservationNumber(businessDate || sArr);
    const reservationDocId = formatReservationId(reservationNumber);

    return await db.runTransaction(async (transaction) => {
      // ════════════════════════════════════════════════════════════════════════
      // PHASE 1: ALL READS FIRST (Strict Firestore Invariant)
      // ════════════════════════════════════════════════════════════════════════

      // 1. Idempotency Check Read
      let cachedResult = null;
      let idemRef = null;
      if (idempotencyKey) {
        idemRef = db.collection('idempotency_keys').doc(String(idempotencyKey));
        const idemSnap = await transaction.get(idemRef);
        if (idemSnap.exists && idemSnap.data()?.status === 'COMPLETED' && idemSnap.data()?.result) {
          console.log(`[Idempotency] Returning cached createReservation result for key ${idempotencyKey}`);
          cachedResult = idemSnap.data().result;
        }
      }

      if (cachedResult) {
        return cachedResult;
      }

      // 2. Room Document Read
      const roomRef = db.collection('rooms').doc(roomDocId);
      const roomSnap = await transaction.get(roomRef);
      let roomData = null;

      if (roomSnap.exists) {
        roomData = roomSnap.data();
      } else {
        // Fallback: Query by number
        const byNumSnap = await transaction.get(
          db.collection('rooms').where('number', '==', selectedRoomNumber).limit(1)
        );
        if (!byNumSnap.empty) {
          roomData = byNumSnap.docs[0].data();
        }
      }

      if (!roomData) {
        const err = new Error(`Room ${selectedRoomNumber} not found`);
        err.status = 404;
        err.code = 'ROOM_NOT_FOUND';
        throw err;
      }

      // Check Active Status
      const isActive = roomData.is_active !== undefined ? Boolean(roomData.is_active) : true;
      if (!isActive) {
        const err = new Error(`Room ${selectedRoomNumber} is inactive and unavailable for reservation.`);
        err.status = 400;
        err.code = 'ROOM_INACTIVE';
        throw err;
      }

      // 3. Read All Active Bookings for Overlap Check
      const bookingsSnap = await transaction.get(
        db.collection('bookings')
          .where('room_number', '==', selectedRoomNumber)
          .limit(50)
      );

      for (const doc of bookingsSnap.docs) {
        const b = doc.data();
        const bStatus = b.booking_status || 'Checked In';
        if (ACTIVE_BOOKING_STATUSES.includes(bStatus)) {
          const bStart = b.check_in_date;
          const bEnd = b.expected_check_out_date || b.check_out_date || b.check_in_date;
          if (isDateOverlap(sArr, sDep, bStart, bEnd)) {
            const err = new Error(`Room ${selectedRoomNumber} is already booked from ${bStart} to ${bEnd}`);
            err.status = 409;
            err.code = 'ROOM_ALREADY_BOOKED';
            throw err;
          }
        }
      }

      // 4. Read All Active Reservations for Overlap Check
      const reservationsSnap = await transaction.get(
        db.collection('reservations')
          .where('room_number', '==', selectedRoomNumber)
          .limit(50)
      );

      for (const doc of reservationsSnap.docs) {
        const r = doc.data();
        const rStatus = r.status || 'Reserved';
        if (ACTIVE_RESERVATION_STATUSES.includes(rStatus)) {
          const rStart = r.arrival_date || r.check_in_date;
          const rEnd = r.departure_date || r.check_out_date;
          if (isDateOverlap(sArr, sDep, rStart, rEnd)) {
            const err = new Error(`Room ${selectedRoomNumber} already has an active reservation (#${r.reservation_number}) from ${rStart} to ${rEnd}`);
            err.status = 409;
            err.code = 'ROOM_ALREADY_BOOKED';
            throw err;
          }
        }
      }

      // ════════════════════════════════════════════════════════════════════════
      // PHASE 2: ALL WRITES AFTER READS
      // ════════════════════════════════════════════════════════════════════════

      const reservationPayload = {
        reservation_number: reservationNumber,
        guest_name: guestName.trim(),
        phone: phone.trim(),
        email: email || null,
        address: address || null,
        nationality: nationality || 'Indian',
        state: state || '',
        company: company || null,
        purpose: purpose || null,
        room_id: roomDocId,
        mysql_room_id: roomData.mysql_room_id || null,
        room_number: selectedRoomNumber,
        room_type: roomType || roomData.type || 'STANDARD',
        // Dual date field naming for 100% compatibility
        check_in_date: String(arrivalDate),
        check_out_date: String(departureDate),
        arrival_date: String(arrivalDate),
        departure_date: String(departureDate),
        arrival_time: arrivalTime || '12:00 PM',
        adults: parseInt(adults, 10) || 1,
        children: parseInt(children, 10) || 0,
        booking_source: bookingSource || 'Direct',
        booking_mode: bookingMode || 'Offline',
        booked_by: bookedBy || null,
        booked_by_contact: bookedByContact || null,
        advance_payment: parsedAdvance,
        payment_mode: paymentMode || 'Cash',
        transport_mode: transportMode || 'Self',
        billing_instructions: billingInstructions || null,
        remarks: remarks || null,
        date_of_birth: resolvedDob,
        status: 'Reserved',
        booking_id: null,
        mysql_booking_id: null,
        mysql_reservation_id: reservationNumber,
        created_by: userId ? String(userId) : null,
        created_at: nowIso,
        updated_at: nowIso
      };

      // Write 1: Reservation document
      const resRef = db.collection('reservations').doc(reservationDocId);
      transaction.set(resRef, reservationPayload, { merge: true });

      // Write 2: Guest document (upsert)
      const cleanPhone = phone.trim().replace(/\D/g, '');
      const guestDocId = `guest_${cleanPhone || Date.now()}`;
      const guestRef = db.collection('guests').doc(guestDocId);
      transaction.set(guestRef, {
        name: guestName.trim(),
        full_name: guestName.trim(),
        phone: phone.trim(),
        email: email || null,
        address: address || null,
        nationality: nationality || 'Indian',
        state: state || '',
        company: company || null,
        purpose: purpose || null,
        date_of_birth: resolvedDob,
        updated_at: nowIso
      }, { merge: true });

      // Write 3: Advance Cash Log if advancePayment > 0
      if (parsedAdvance > 0 && paymentMode === 'Cash') {
        const cashLogDocId = `cash_log_res_${reservationNumber}_advance`;
        const cashLogRef = db.collection('cash_logs').doc(cashLogDocId);
        transaction.set(cashLogRef, {
          log_id: cashLogDocId,
          time: arrivalTime || '12:00 PM',
          room: selectedRoomNumber,
          room_number: selectedRoomNumber,
          guest: guestName.trim(),
          type: `Reservation Advance (${reservationNumber})`,
          amount: parsedAdvance,
          payment_mode: 'Cash',
          business_date: businessDate || sArr,
          created_at: nowIso
        }, { merge: true });
      }

      const formattedResponse = {
        id: reservationDocId,
        mysql_reservation_id: reservationDocId,
        ...reservationPayload
      };

      const result = {
        success: true,
        message: 'Reservation created successfully',
        reservation: formattedResponse
      };

      // Write 4: Store Idempotency Record
      if (idemRef) {
        transaction.set(idemRef, {
          key: idempotencyKey,
          status: 'COMPLETED',
          domain: 'reservations_create',
          reservation_number: reservationNumber,
          result,
          created_at: nowIso
        });
      }

      return result;
    });
  }

  /**
   * Atomically updates a reservation in Firestore with self-excluding availability check.
   */
  static async updateReservationFirestore(resId, updateData, user = {}, idempotencyKey = null) {
    if (!resId) {
      const err = new Error('Reservation ID is required');
      err.status = 400;
      throw err;
    }

    const docId = String(resId).startsWith('res_') ? String(resId) : formatReservationId(resId);
    const nowIso = new Date().toISOString();

    return await db.runTransaction(async (transaction) => {
      // ════════════════════════════════════════════════════════════════════════
      // PHASE 1: ALL READS FIRST (Strict Firestore Invariant)
      // ════════════════════════════════════════════════════════════════════════

      // 1. Idempotency Check Read
      let cachedResult = null;
      let idemRef = null;
      if (idempotencyKey) {
        idemRef = db.collection('idempotency_keys').doc(String(idempotencyKey));
        const idemSnap = await transaction.get(idemRef);
        if (idemSnap.exists && idemSnap.data()?.status === 'COMPLETED' && idemSnap.data()?.result) {
          console.log(`[Idempotency] Returning cached updateReservation result for key ${idempotencyKey}`);
          cachedResult = idemSnap.data().result;
        }
      }

      if (cachedResult) {
        return cachedResult;
      }

      // 2. Read Existing Reservation
      let resRef = db.collection('reservations').doc(docId);
      let resSnap = await transaction.get(resRef);
      let currentRes = null;

      if (resSnap.exists) {
        currentRes = resSnap.data();
      } else {
        // Try searching by reservation_number
        const byNumSnap = await transaction.get(
          db.collection('reservations').where('reservation_number', '==', String(resId)).limit(1)
        );
        if (!byNumSnap.empty) {
          resRef = byNumSnap.docs[0].ref;
          currentRes = byNumSnap.docs[0].data();
        } else {
          // Try searching by mysql_reservation_id
          const byMysqlSnap = await transaction.get(
            db.collection('reservations').where('mysql_reservation_id', '==', Number(resId) || String(resId)).limit(1)
          );
          if (!byMysqlSnap.empty) {
            resRef = byMysqlSnap.docs[0].ref;
            currentRes = byMysqlSnap.docs[0].data();
          }
        }
      }

      if (!currentRes) {
        const err = new Error('Reservation not found');
        err.status = 404;
        err.code = 'RESERVATION_NOT_FOUND';
        throw err;
      }

      const guestName = updateData.guestName !== undefined ? updateData.guestName : currentRes.guest_name;
      const phone = updateData.phone !== undefined ? updateData.phone : currentRes.phone;
      const email = updateData.email !== undefined ? updateData.email : currentRes.email;
      const address = updateData.address !== undefined ? updateData.address : currentRes.address;
      const nationality = updateData.nationality !== undefined ? updateData.nationality : currentRes.nationality;
      const state = updateData.state !== undefined ? updateData.state : currentRes.state;
      const company = updateData.company !== undefined ? updateData.company : currentRes.company;
      const purpose = updateData.purpose !== undefined ? updateData.purpose : currentRes.purpose;
      const arrivalDate = updateData.arrivalDate !== undefined ? updateData.arrivalDate : (currentRes.arrival_date || currentRes.check_in_date);
      const arrivalTime = updateData.arrivalTime !== undefined ? updateData.arrivalTime : currentRes.arrival_time;
      const departureDate = updateData.departureDate !== undefined ? updateData.departureDate : (currentRes.departure_date || currentRes.check_out_date);
      const adults = updateData.adults !== undefined ? updateData.adults : currentRes.adults;
      const children = updateData.children !== undefined ? updateData.children : currentRes.children;
      const roomType = updateData.roomType !== undefined ? updateData.roomType : currentRes.room_type;
      const roomNumber = updateData.roomNumber !== undefined ? String(updateData.roomNumber) : currentRes.room_number;
      const bookingSource = updateData.bookingSource !== undefined ? updateData.bookingSource : currentRes.booking_source;
      const bookingMode = updateData.bookingMode !== undefined ? updateData.bookingMode : currentRes.booking_mode;
      const bookedBy = updateData.bookedBy !== undefined ? updateData.bookedBy : currentRes.booked_by;
      const bookedByContact = updateData.bookedByContact !== undefined ? updateData.bookedByContact : currentRes.booked_by_contact;
      const advancePayment = updateData.advancePayment !== undefined ? updateData.advancePayment : currentRes.advance_payment;
      const paymentMode = updateData.paymentMode !== undefined ? updateData.paymentMode : currentRes.payment_mode;
      const billingInstructions = updateData.billingInstructions !== undefined ? updateData.billingInstructions : currentRes.billing_instructions;
      const transportMode = updateData.transportMode !== undefined ? updateData.transportMode : currentRes.transport_mode;
      const remarks = updateData.remarks !== undefined ? updateData.remarks : currentRes.remarks;
      const status = updateData.status !== undefined ? updateData.status : currentRes.status;

      // Validate date logic
      const sArr = parseToComparableDate(arrivalDate);
      const sDep = parseToComparableDate(departureDate);
      if (!sArr || !sDep || sArr >= sDep) {
        const err = new Error('Arrival date must be strictly before departure date');
        err.status = 400;
        throw err;
      }

      // Check Availability (self-excluding) if room or dates changed
      const currArr = parseToComparableDate(currentRes.arrival_date || currentRes.check_in_date);
      const currDep = parseToComparableDate(currentRes.departure_date || currentRes.check_out_date);
      const roomChanged = roomNumber !== currentRes.room_number;
      const datesChanged = sArr !== currArr || sDep !== currDep;

      if (roomChanged || datesChanged) {
        // 3. Read Bookings for Conflict Check
        const bookingsSnap = await transaction.get(
          db.collection('bookings')
            .where('room_number', '==', roomNumber)
            .limit(50)
        );

        for (const doc of bookingsSnap.docs) {
          const b = doc.data();
          const bStatus = b.booking_status || 'Checked In';
          if (ACTIVE_BOOKING_STATUSES.includes(bStatus)) {
            const bStart = b.check_in_date;
            const bEnd = b.expected_check_out_date || b.check_out_date || b.check_in_date;
            if (isDateOverlap(sArr, sDep, bStart, bEnd)) {
              const err = new Error(`Room ${roomNumber} is already booked from ${bStart} to ${bEnd}`);
              err.status = 409;
              err.code = 'ROOM_ALREADY_BOOKED';
              throw err;
            }
          }
        }

        // 4. Read Reservations for Conflict Check (Excluding Self)
        const reservationsSnap = await transaction.get(
          db.collection('reservations')
            .where('room_number', '==', roomNumber)
            .limit(50)
        );

        for (const doc of reservationsSnap.docs) {
          const r = doc.data();
          // Self-exclusion check
          if (matchesExclusion(r, currentRes.reservation_number) || matchesExclusion(r, resId)) {
            continue;
          }
          const rStatus = r.status || 'Reserved';
          if (ACTIVE_RESERVATION_STATUSES.includes(rStatus)) {
            const rStart = r.arrival_date || r.check_in_date;
            const rEnd = r.departure_date || r.check_out_date;
            if (isDateOverlap(sArr, sDep, rStart, rEnd)) {
              const err = new Error(`Room ${roomNumber} already has an active reservation (#${r.reservation_number}) from ${rStart} to ${rEnd}`);
              err.status = 409;
              err.code = 'ROOM_ALREADY_BOOKED';
              throw err;
            }
          }
        }
      }

      // ════════════════════════════════════════════════════════════════════════
      // PHASE 2: ALL WRITES AFTER READS
      // ════════════════════════════════════════════════════════════════════════

      const updatedFields = {
        guest_name: typeof guestName === 'string' ? guestName.trim() : guestName,
        phone: typeof phone === 'string' ? phone.trim() : phone,
        email: email || null,
        address: address || null,
        nationality: nationality || 'Indian',
        state: state || '',
        company: company || null,
        purpose: purpose || null,
        room_id: formatRoomId(roomNumber),
        room_number: roomNumber,
        room_type: roomType || null,
        check_in_date: String(arrivalDate),
        check_out_date: String(departureDate),
        arrival_date: String(arrivalDate),
        departure_date: String(departureDate),
        arrival_time: arrivalTime || '12:00 PM',
        adults: parseInt(adults, 10) || 1,
        children: parseInt(children, 10) || 0,
        booking_source: bookingSource || 'Direct',
        booking_mode: bookingMode || 'Offline',
        booked_by: bookedBy || null,
        booked_by_contact: bookedByContact || null,
        advance_payment: parseInt(advancePayment, 10) || 0,
        payment_mode: paymentMode || 'Cash',
        billing_instructions: billingInstructions || null,
        transport_mode: transportMode || 'Self',
        remarks: remarks || null,
        status: status || currentRes.status || 'Reserved',
        updated_at: nowIso
      };

      transaction.set(resRef, updatedFields, { merge: true });

      const updatedReservation = {
        ...currentRes,
        ...updatedFields,
        id: currentRes.mysql_reservation_id || currentRes.reservation_number || docId
      };

      const result = {
        success: true,
        message: 'Reservation updated successfully',
        reservation: updatedReservation
      };

      // Store Idempotency
      if (idemRef) {
        transaction.set(idemRef, {
          key: idempotencyKey,
          status: 'COMPLETED',
          domain: 'reservations_update',
          reservation_id: docId,
          result,
          created_at: nowIso
        });
      }

      return result;
    });
  }

  /**
   * Atomically cancels a reservation in Firestore and immediately releases inventory.
   */
  static async cancelReservationFirestore(resId, params = {}, user = {}, idempotencyKey = null) {
    if (!resId) {
      const err = new Error('Reservation ID is required');
      err.status = 400;
      throw err;
    }

    const { cancellationReason = 'Guest Cancellation', refundAmount } = params;
    const docId = String(resId).startsWith('res_') ? String(resId) : formatReservationId(resId);
    const nowIso = new Date().toISOString();

    return await db.runTransaction(async (transaction) => {
      // ════════════════════════════════════════════════════════════════════════
      // PHASE 1: ALL READS FIRST (Strict Firestore Invariant)
      // ════════════════════════════════════════════════════════════════════════

      // 1. Idempotency Check Read
      let cachedResult = null;
      let idemRef = null;
      if (idempotencyKey) {
        idemRef = db.collection('idempotency_keys').doc(String(idempotencyKey));
        const idemSnap = await transaction.get(idemRef);
        if (idemSnap.exists && idemSnap.data()?.status === 'COMPLETED' && idemSnap.data()?.result) {
          console.log(`[Idempotency] Returning cached cancelReservation result for key ${idempotencyKey}`);
          cachedResult = idemSnap.data().result;
        }
      }

      if (cachedResult) {
        return cachedResult;
      }

      // 2. Read Existing Reservation
      let resRef = db.collection('reservations').doc(docId);
      let resSnap = await transaction.get(resRef);
      let currentRes = null;

      if (resSnap.exists) {
        currentRes = resSnap.data();
      } else {
        const byNumSnap = await transaction.get(
          db.collection('reservations').where('reservation_number', '==', String(resId)).limit(1)
        );
        if (!byNumSnap.empty) {
          resRef = byNumSnap.docs[0].ref;
          currentRes = byNumSnap.docs[0].data();
        } else {
          const byMysqlSnap = await transaction.get(
            db.collection('reservations').where('mysql_reservation_id', '==', Number(resId) || String(resId)).limit(1)
          );
          if (!byMysqlSnap.empty) {
            resRef = byMysqlSnap.docs[0].ref;
            currentRes = byMysqlSnap.docs[0].data();
          }
        }
      }

      if (!currentRes) {
        const err = new Error('Reservation not found');
        err.status = 404;
        err.code = 'RESERVATION_NOT_FOUND';
        throw err;
      }

      // 3. Read Associated Booking if any
      let associatedBookingSnap = null;
      let associatedBookingRef = null;
      const bkgId = currentRes.booking_id || currentRes.mysql_booking_id;
      if (bkgId) {
        const bkgDocId = String(bkgId).startsWith('booking_') || String(bkgId).startsWith('bkg_') ? String(bkgId) : formatBookingId(bkgId);
        associatedBookingRef = db.collection('bookings').doc(bkgDocId);
        associatedBookingSnap = await transaction.get(associatedBookingRef);
      }

      // ════════════════════════════════════════════════════════════════════════
      // PHASE 2: ALL WRITES AFTER READS
      // ════════════════════════════════════════════════════════════════════════

      const updatedRemarks = currentRes.remarks
        ? `${currentRes.remarks} | Cancelled: ${cancellationReason}`
        : `Cancelled: ${cancellationReason}`;

      // Write 1: Update Reservation status
      transaction.set(resRef, {
        status: 'Cancelled',
        remarks: updatedRemarks,
        updated_at: nowIso
      }, { merge: true });

      // Write 2: If associated with booking
      if (associatedBookingSnap && associatedBookingSnap.exists) {
        const bookingData = associatedBookingSnap.data();
        if (bookingData.booking_status === 'Checked In') {
          // Booking -> Checked Out / Refunded
          transaction.set(associatedBookingRef, {
            booking_status: 'Checked Out',
            payment_status: 'Refunded',
            updated_at: nowIso
          }, { merge: true });

          // Room -> Dirty
          if (currentRes.room_number) {
            const roomRef = db.collection('rooms').doc(formatRoomId(currentRes.room_number));
            transaction.set(roomRef, {
              status: 'dirty',
              housekeeping_status: 'Dirty',
              updated_at: nowIso
            }, { merge: true });
          }
        } else {
          transaction.set(associatedBookingRef, {
            payment_status: 'Refunded',
            updated_at: nowIso
          }, { merge: true });
        }
      }

      const resNumber = currentRes.reservation_number || resId;
      const result = {
        success: true,
        message: `Reservation #${resNumber} cancelled successfully`
      };

      // Store Idempotency
      if (idemRef) {
        transaction.set(idemRef, {
          key: idempotencyKey,
          status: 'COMPLETED',
          domain: 'reservations_cancel',
          reservation_id: docId,
          result,
          created_at: nowIso
        });
      }

      return result;
    });
  }

  /**
   * Retrieves list of reservations from Firestore with optional filtering.
   */
  static async getReservationsFirestore(query = {}) {
    const { status, search, fromDate, toDate } = query;

    const snap = await db.collection('reservations').get();
    let reservations = [];

    snap.forEach(doc => {
      const r = doc.data();
      if (!r) return;

      const resNumber = r.reservation_number || '';
      const gName = r.guest_name || '';
      const rPhone = r.phone || '';
      const rRoomNum = r.room_number || '';
      const rStatus = r.status || 'Reserved';
      const arrDate = parseToComparableDate(r.arrival_date || r.check_in_date);
      const depDate = parseToComparableDate(r.departure_date || r.check_out_date);

      // Status filter
      if (status && status !== 'ALL' && rStatus !== status) {
        return;
      }

      // Date range filters
      if (fromDate) {
        const fComp = parseToComparableDate(fromDate);
        if (arrDate && arrDate < fComp) return;
      }

      if (toDate) {
        const tComp = parseToComparableDate(toDate);
        if (depDate && depDate > tComp) return;
      }

      // Search filter
      if (search && search.trim() !== '') {
        const s = search.trim().toLowerCase();
        const matchesSearch = gName.toLowerCase().includes(s) ||
                              rPhone.toLowerCase().includes(s) ||
                              resNumber.toLowerCase().includes(s) ||
                              rRoomNum.toLowerCase().includes(s);
        if (!matchesSearch) return;
      }

      reservations.push({
        id: r.mysql_reservation_id || doc.id,
        reservation_number: resNumber,
        guest_name: gName,
        phone: rPhone,
        email: r.email || null,
        address: r.address || null,
        nationality: r.nationality || 'Indian',
        state: r.state || '',
        company: r.company || null,
        purpose: r.purpose || null,
        room_id: r.mysql_room_id || r.room_id || null,
        room_number: rRoomNum,
        room_type: r.room_type || 'STANDARD',
        arrival_date: r.arrival_date || r.check_in_date || null,
        departure_date: r.departure_date || r.check_out_date || null,
        check_in_date: r.check_in_date || r.arrival_date || null,
        check_out_date: r.check_out_date || r.departure_date || null,
        arrival_time: r.arrival_time || '12:00 PM',
        adults: Number(r.adults || 1),
        children: Number(r.children || 0),
        booking_source: r.booking_source || 'Direct',
        booking_mode: r.booking_mode || 'Offline',
        booked_by: r.booked_by || null,
        booked_by_contact: r.booked_by_contact || null,
        advance_payment: parseFloat(r.advance_payment || 0),
        payment_mode: r.payment_mode || 'Cash',
        billing_instructions: r.billing_instructions || null,
        transport_mode: r.transport_mode || 'Self',
        remarks: r.remarks || null,
        status: rStatus,
        date_of_birth: r.date_of_birth || r.dob || null,
        created_at: r.created_at || null,
        updated_at: r.updated_at || null
      });
    });

    reservations.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    return {
      success: true,
      count: reservations.length,
      reservations
    };
  }

  /**
   * Retrieves single reservation by ID or reservation_number from Firestore.
   */
  static async getReservationByIdFirestore(id) {
    if (!id) return { success: false, message: 'Reservation ID is required' };

    const docId = String(id).startsWith('res_') ? String(id) : formatReservationId(id);
    let snap = await db.collection('reservations').doc(docId).get();

    if (!snap.exists) {
      const byNumSnap = await db.collection('reservations')
        .where('reservation_number', '==', String(id))
        .limit(1)
        .get();
      if (!byNumSnap.empty) {
        snap = byNumSnap.docs[0];
      } else {
        const byMysqlSnap = await db.collection('reservations')
          .where('mysql_reservation_id', '==', Number(id) || String(id))
          .limit(1)
          .get();
        if (!byMysqlSnap.empty) {
          snap = byMysqlSnap.docs[0];
        }
      }
    }

    if (!snap.exists) {
      const err = new Error('Reservation not found');
      err.status = 404;
      throw err;
    }

    const r = snap.data();
    return {
      success: true,
      reservation: {
        id: r.mysql_reservation_id || snap.id,
        ...r
      }
    };
  }

  /**
   * Generates reservation summary report metrics from Firestore.
   */
  static async getReservationReportFirestore(query = {}) {
    const listRes = await this.getReservationsFirestore(query);
    const rows = listRes.reservations || [];

    const totalReservations = rows.length;
    const reservedCount = rows.filter(r => r.status === 'Reserved').length;
    const confirmedCount = rows.filter(r => r.status === 'Confirmed').length;
    const checkedInCount = rows.filter(r => r.status === 'Checked-In' || r.status === 'Checked In').length;
    const cancelledCount = rows.filter(r => r.status === 'Cancelled').length;
    const totalAdvance = rows.reduce((sum, r) => sum + (r.advance_payment || 0), 0);

    return {
      success: true,
      summary: {
        totalReservations,
        reservedCount,
        confirmedCount,
        checkedInCount,
        cancelledCount,
        totalAdvance
      },
      reservations: rows
    };
  }
}

export default ReservationFirestoreAdapter;
