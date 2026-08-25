import { processCheckIn } from '../services/checkInService.js';
import { CheckInCutoverService } from '../services/checkInCutoverService.js';
import { processCheckOut } from '../services/checkOutService.js';
import { CheckOutCutoverService } from '../services/checkOutCutoverService.js';
import { LedgerCutoverService } from '../services/ledgerCutoverService.js';
import { LedgerWriteCutoverService } from '../services/ledgerWriteCutoverService.js';
import { RefundCutoverService } from '../services/refundCutoverService.js';
import { processRoomShift } from '../services/roomShiftService.js';
import { RoomShiftCutoverService } from '../services/roomShiftCutoverService.js';
import { BusinessDateService } from '../services/businessDateService.js';
import { FirestoreAvailabilityService } from '../services/firestoreAvailabilityService.js';
import pool from '../db.js';
import { db } from '../config/firebaseAdmin.js';
import fs from 'fs';
import path from 'path';
import { isRoomsReadCanaryEnabled, isFirestoreLedgerShadowEnabled, isFirestoreCheckInServingEnabled, isFirestoreCheckOutServingEnabled, isFirestoreLedgerServingEnabled, isFirebaseOnlyGuestResolutionEnabled } from '../config/featureFlags.js';
import { extractOCRData, verifyDocumentData } from '../services/ocrService.js';
import { FirestoreShadowComparisonService } from '../services/firestoreShadowComparisonService.js';
import { FirestoreLedgerService } from '../services/firestoreLedgerService.js';
import { AuditHistoryCutoverService } from '../services/auditHistoryCutoverService.js';
import { validateCheckInPayload } from '../validators/checkInValidator.js';
import { invalidateGuestRequestsCache } from '../services/guestRequestsService.js';

// ── Phase 3 Step 3D-4: Guest Booking Ownership Helper ─────────────────────────
/**
 * Resolves the canonical guests.id (mysql_guest_id) for the authenticated guest.
 *
 * When ENABLE_FIREBASE_ONLY_GUEST_RESOLUTION=true:
 *   - Returns req.user.mysql_guest_id directly from verified Firebase Custom Claims.
 *   - ZERO MySQL queries for ownership resolution.
 *   - Throws 401 GUEST_OWNERSHIP_CLAIM_MISSING if claim absent/invalid.
 *   - Does NOT fall back to MySQL even if the claim is missing.
 *
 * When ENABLE_FIREBASE_ONLY_GUEST_RESOLUTION=false (default):
 *   - Returns null to signal the caller should use the legacy MySQL lookup.
 *
 * SECURITY: mysql_guest_id is taken ONLY from verified server-side claims.
 * Any guest_id/mysql_guest_id/user_id sent in the request body or query
 * parameters is NEVER used for authorization.
 *
 * @param {object} req  Express request with req.user from authenticate middleware
 * @returns {number|null}  guests.id if flag ON, null if flag OFF (use MySQL path)
 * @throws {Error}  code=GUEST_OWNERSHIP_CLAIM_MISSING if flag ON and claim absent
 */
function resolveGuestOwnershipId(req) {
  if (!isFirebaseOnlyGuestResolutionEnabled()) {
    return null; // Signal: use legacy MySQL path
  }

  const user = req.user;
  if (!user) {
    const err = new Error('Unauthenticated request.');
    err.status = 401; err.code = 'UNAUTHORIZED';
    throw err;
  }

  // Verify this is actually a guest token — reject staff/admin reaching this path
  const role     = String(user.role     || '').toLowerCase();
  const userType = String(user.user_type || user.type || '').toLowerCase();
  if (role !== 'guest' || userType !== 'guest') {
    const err = new Error('Guest ownership resolution attempted with non-guest token.');
    err.status = 403; err.code = 'FORBIDDEN';
    throw err;
  }

  const claimedId = user.mysql_guest_id ?? user.guest_id ?? null;
  if (claimedId == null) {
    const err = new Error(
      'Firebase guest token is missing mysql_guest_id claim. ' +
      'Re-provision this account via Step 3D-1 lazy migration.'
    );
    err.status = 401;
    err.code   = 'GUEST_OWNERSHIP_CLAIM_MISSING';
    throw err;
  }

  const parsed = Number(claimedId);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const err = new Error(`Invalid mysql_guest_id claim value: ${claimedId}`);
    err.status = 401;
    err.code   = 'GUEST_OWNERSHIP_CLAIM_MISSING';
    throw err;
  }

  return parsed;
}

// Helper to format time (e.g. 09:30 AM)
function formatTime(date) {
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; // 0 should be 12
  return `${String(hours).padStart(2, '0')}:${minutes} ${ampm}`;
}

export const checkIn = async (req, res) => {
  const { number } = req.params;

  if (!number || typeof number !== "string" || number.trim() === "") {
    return res.status(400).json({ error: "Room number is required" });
  }

  // ── Strict Pre-Transaction Validation of 14 Mandatory Fields ─────────────
  const validationResult = validateCheckInPayload({ ...req.body, roomNumber: number });
  if (!validationResult.isValid) {
    return res.status(400).json({
      error: "CHECKIN_VALIDATION_FAILED",
      message: "Required check-in information is missing or invalid.",
      fields: validationResult.errors
    });
  }

  const {
    guestName, phone, pax, deposit, checkInDate, manual_override, paymentMethod, transactionId,
    billing_instruction, billingInstruction, meal_plan, dateOfBirth, dob, age,
    expectedCheckoutDate, expectedCheckOutDate, departureDate,
    roomTariff, roomRent, paymentMode, purposeOfVisit, companyName, gstNo, city, state, country, address,
    idempotencyKey
  } = req.body;

  const parsedPax = validationResult.sanitized.pax;
  const parsedChildren = validationResult.sanitized.children;
  const parsedDeposit = parseInt(deposit, 10) || 0;
  const resolvedUserId = req.user?.type === "staff" ? null : (req.user?.id || null);

  try {
    const checkInParams = {
      roomNumber: number,
      guestName: validationResult.sanitized.guestName,
      phone: validationResult.sanitized.phone,
      age: validationResult.sanitized.age,
      email: validationResult.sanitized.email,
      country: validationResult.sanitized.country,
      state: validationResult.sanitized.state,
      address: validationResult.sanitized.address,
      pincode: validationResult.sanitized.pincode || req.body.pincode || '',
      gender: validationResult.sanitized.gender || req.body.gender || null,
      purposeOfVisit: validationResult.sanitized.purposeOfVisit,
      pax: parsedPax,
      children: parsedChildren,
      deposit: parsedDeposit,
      paymentMethod,
      transactionId,
      manualOverride: manual_override,
      checkInDate: validationResult.sanitized.checkInDate,
      expectedCheckoutDate: validationResult.sanitized.departureDate,
      departureDate: validationResult.sanitized.departureDate,
      resolvedUserId,
      isGuestSelfCheckIn: false,
      billingInstruction: validationResult.sanitized.billingInstruction,
      mealPlan: meal_plan || 'EP',
      dateOfBirth: validationResult.sanitized.dateOfBirth || dateOfBirth || dob || null,
      dob: validationResult.sanitized.dob || dob || dateOfBirth || null,
      roomTariff: validationResult.sanitized.roomTariff,
      paymentMode,
      companyName,
      gstNo: validationResult.sanitized.gstNo || gstNo || '',
      city,
      idempotencyKey: idempotencyKey || req.headers['idempotency-key'] || null
    };

    const result = await CheckInCutoverService.executeCheckIn({
      params: checkInParams
    });

    res.json({
      message: `Successfully checked in to Room ${number}`,
      bookingId: result.bookingId,
      bookingNumber: result.bookingNumber
    });
  } catch (error) {
    console.error("Error during checkin controller:", error);
    res.status(error.status || 500).json({ error: error.message || "Internal Server Error", code: error.code });
  }
};

export const checkOut = async (req, res) => {
  const { number } = req.params;
  const { balancePaid, paymentMethod, idempotencyKey } = req.body;

  if (!number || typeof number !== 'string' || number.trim() === '') {
    return res.status(400).json({ error: 'Room number is required' });
  }

  const parsedBalancePaid = parseInt(balancePaid, 10);
  if (isNaN(parsedBalancePaid)) {
    return res.status(400).json({ error: 'Balance paid must be a valid integer' });
  }

  // Obtain user ID from authenticated request context
  const resolvedUserId = req.user?.id || null;

  try {
    const result = await CheckOutCutoverService.executeCheckOut({
      params: {
        number,
        parsedBalancePaid,
        resolvedUserId,
        paymentMethod: paymentMethod || 'Cash',
        idempotencyKey: idempotencyKey || req.headers['idempotency-key'] || null
      }
    });

    res.json({ message: `Successfully checked out Room ${number}`, bookingId: result.bookingId });

  } catch (error) {
    console.error('Error during checkout controller:', error);
    res.status(error.status || 500).json({
      error: error.message || 'Internal Server Error',
      code: error.code,
      bookingId: error.bookingId,
      totalCharges: error.totalCharges,
      totalCredits: error.totalCredits,
      totalPayments: error.totalPayments,
      balanceDue: error.balanceDue
    });
  }
};

export const clean = async (req, res) => {
  const { number } = req.params;

  if (!number || typeof number !== 'string' || number.trim() === '') {
    return res.status(400).json({ error: 'Room number is required' });
  }

  const operatorId = req.user?.id || null;

  try {
    const { getRoomByNumberFirestore, updateRoomFirestore } = await import('../repositories/firestore/roomsRepository.js');
    const room = await getRoomByNumberFirestore(number);
    if (!room) {
      return res.status(404).json({ error: `Room ${number} not found` });
    }

    const isDirtyByStatus = String(room.status || '').toLowerCase() === 'dirty';
    const isDirtyByHK     = String(room.housekeeping_status || '').toLowerCase() === 'dirty';

    if (!isDirtyByStatus && !isDirtyByHK) {
      return res.status(400).json({ error: `Room ${number} is not dirty` });
    }

    const businessDate = await BusinessDateService.getBusinessDate();

    const updatePayload = {
      housekeeping_status: 'Clean',
      housekeeping_priority: 'Normal',
      last_cleaned_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    if (isDirtyByStatus) {
      updatePayload.status = 'vacant';
    }

    await updateRoomFirestore(number, updatePayload);

    try {
      if (isDirtyByStatus) {
        const { createRoomStatusHistoryFirestore } = await import('../repositories/firestore/roomStatusHistoryRepository.js');
        await createRoomStatusHistoryFirestore({
          room_id: room.id || `room_${number}`,
          room_number: String(number),
          old_status: 'dirty',
          new_status: 'vacant',
          changed_by: operatorId,
          business_date: businessDate,
          created_at: new Date().toISOString()
        });
      }

      const { createAuditLogFirestore } = await import('../repositories/firestore/auditLogsRepository.js');
      await createAuditLogFirestore({
        user_id: operatorId,
        action: 'CLEAN_ROOM',
        details: `Marked Room ${number} as Clean and vacant. (status=${room.status}, hk=${room.housekeeping_status})`,
        business_date: businessDate
      });
    } catch (auditErr) {
      console.warn('[clean] Audit/history log non-fatal error:', auditErr.message);
    }

    res.json({ message: `Room ${number} marked as CLEAN and vacant` });
  } catch (error) {
    console.error('Error during cleaning controller (Firestore), attempting fallback:', error);
    try {
      const [roomRows] = await pool.query(`
        SELECT r.id, r.status, r.housekeeping_status
        FROM rooms r
        JOIN room_types rt ON r.room_type_id = rt.id
        WHERE r.number = ?
      `, [number]);
      if (roomRows.length === 0) {
        return res.status(404).json({ error: `Room ${number} not found` });
      }

      const room = roomRows[0];
      const isDirtyByStatus = room.status === 'dirty';
      const isDirtyByHK     = room.housekeeping_status === 'Dirty';

      if (!isDirtyByStatus && !isDirtyByHK) {
        return res.status(400).json({ error: `Room ${number} is not dirty` });
      }

      const businessDate = await BusinessDateService.getBusinessDate(pool);

      if (isDirtyByStatus) {
        await pool.query(
          `INSERT INTO room_status_history (room_id, old_status, new_status, changed_by, business_date)
           VALUES (?, 'dirty', 'vacant', ?, ?)`,
          [room.id, operatorId, businessDate]
        );
      }

      await pool.query(
        `INSERT INTO audit_logs (user_id, action, details, business_date)
         VALUES (?, 'CLEAN_ROOM', ?, ?)`,
        [operatorId, `Marked Room ${number} as Clean and vacant. (status=${room.status}, hk=${room.housekeeping_status})`, businessDate]
      );

      if (isDirtyByStatus) {
        await pool.query(
          `UPDATE rooms SET status = 'vacant', housekeeping_status = 'Clean', housekeeping_priority = 'Normal', last_cleaned_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [room.id]
        );
      } else {
        await pool.query(
          `UPDATE rooms SET housekeeping_status = 'Clean', housekeeping_priority = 'Normal', last_cleaned_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [room.id]
        );
      }

      return res.json({ message: `Room ${number} marked as CLEAN and vacant` });
    } catch (mysqlErr) {
      console.error('Error during cleaning controller (MySQL fallback):', mysqlErr);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
};

export const addLedgerItem = async (req, res) => {
  const { number } = req.params;
  const { desc, amount, category = 'General', transactionType = 'CHARGE' } = req.body;
  const idempotencyKey = req.body?.idempotencyKey || req.headers['idempotency-key'] || null;
  const resolvedUserId = req.user?.id || null;

  const parsedAmount = parseInt(amount, 10);
  if (!desc || typeof desc !== 'string' || desc.trim() === '' || isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Invalid charge description or amount', code: 'INVALID_CHARGE_PARAMS' });
  }

  const mysqlHandler = async () => {
    const [rooms] = await pool.query(`
      SELECT r.id, r.status
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE r.number = ?
    `, [number]);
    if (rooms.length === 0 || rooms[0].status !== 'occupied') {
      const err = new Error('Charges can only be posted to occupied rooms');
      err.status = 400;
      err.code = 'ROOM_NOT_OCCUPIED';
      throw err;
    }

    const room = rooms[0];

    // Find the active checkin booking ID
    const [bookings] = await pool.query(
      "SELECT id FROM bookings WHERE room_id = ? AND booking_status = 'Checked In'",
      [room.id]
    );
    const bookingId = bookings[0]?.id || null;

    // Get current business date
    const [settings] = await pool.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || '11-Jul-2026';

    // Idempotency check: prevent duplicate manual postings within a 5-second window
    const [recentDups] = await pool.query(
      `SELECT id FROM ledger_items 
       WHERE booking_id = ? 
         AND \`desc\` = ? 
         AND amount = ? 
         AND created_at >= NOW() - INTERVAL 5 SECOND`,
      [bookingId, desc.trim(), parsedAmount]
    );

    if (recentDups.length > 0) {
      console.log(`[Idempotency] Skipped duplicate manual charge for Room ${number}: ${desc.trim()}`);
      return { message: `Charge already posted (Idempotency skip).` };
    }

    await pool.query(
      'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
      [number, desc.trim(), parsedAmount, businessDate, bookingId]
    );

    return { message: `Posted ${desc} of ₹${parsedAmount} to Room ${number}` };
  };

  try {
    const businessDate = await BusinessDateService.getBusinessDate(pool);
    const result = await LedgerWriteCutoverService.addLedgerItem(
      {
        roomNumber: number,
        desc,
        amount: parsedAmount,
        category,
        transactionType,
        businessDate,
        idempotencyKey,
        resolvedUserId
      },
      mysqlHandler
    );

    res.json({ message: result.message || `Posted ${desc} of ₹${parsedAmount} to Room ${number}`, result });
  } catch (error) {
    console.error('Error posting ledger charge controller:', error);
    res.status(error.status || 500).json({ error: error.message || 'Internal Server Error', code: error.code });
  }
};

export const recordPayment = async (req, res) => {
  const { number } = req.params;
  const { amount, paymentMethod = 'Cash', reference = '', remarks = '', idempotencyKey = null } = req.body;
  const resolvedUserId = req.user?.id || req.user?.uid || 'admin';

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({
      error: 'Payment amount must be a positive number greater than 0.',
      code: 'INVALID_PAYMENT_AMOUNT'
    });
  }

  try {
    const businessDate = await BusinessDateService.getBusinessDate(pool);
    const result = await LedgerWriteCutoverService.recordPayment({
      roomNumber: number,
      amount: parsedAmount,
      paymentMethod,
      reference,
      remarks,
      businessDate,
      idempotencyKey: idempotencyKey || req.headers['idempotency-key'] || null,
      resolvedUserId
    });

    res.json({
      success: true,
      message: result.message || `Recorded payment of ₹${parsedAmount} for Room ${number}`,
      ...result
    });
  } catch (error) {
    console.error('Error in recordPayment controller:', error);
    res.status(error.status || 500).json({
      error: error.message || 'Internal Server Error',
      code: error.code,
      outstanding: error.outstanding
    });
  }
};

export const adjustRoomRent = async (req, res) => {
  const { number } = req.params;
  const { amount, adjustmentType = 'INCREASE', reason = '', idempotencyKey = null } = req.body;
  const resolvedUserId = req.user?.id || req.user?.uid || 'admin';

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({
      error: 'Adjustment amount must be a positive number greater than 0.',
      code: 'INVALID_ADJUSTMENT_AMOUNT'
    });
  }

  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    return res.status(400).json({
      error: 'A valid reason is required for manual room rent adjustment.',
      code: 'ADJUSTMENT_REASON_REQUIRED'
    });
  }

  const typeUpper = String(adjustmentType || 'INCREASE').trim().toUpperCase();
  if (typeUpper !== 'INCREASE' && typeUpper !== 'DECREASE') {
    return res.status(400).json({
      error: 'Adjustment type must be either INCREASE or DECREASE.',
      code: 'INVALID_ADJUSTMENT_TYPE'
    });
  }

  try {
    const businessDate = await BusinessDateService.getBusinessDate(pool);
    const result = await LedgerWriteCutoverService.adjustRoomRent({
      roomNumber: number,
      amount: parsedAmount,
      adjustmentType: typeUpper,
      reason: cleanReason,
      businessDate,
      idempotencyKey: idempotencyKey || req.headers['idempotency-key'] || null,
      resolvedUserId
    });

    res.json({
      success: true,
      message: result.message || `Successfully applied room rent adjustment for Room ${number}`,
      ...result
    });
  } catch (error) {
    console.error('Error in adjustRoomRent controller:', error);
    res.status(error.status || 500).json({
      error: error.message || 'Internal Server Error',
      code: error.code
    });
  }
};

export const shift = async (req, res) => {
  const {
    fromRoomNumber,
    toRoomNumber,
    adjustmentType = 'AUTOMATIC',
    manualAdjustmentAmount,
    manualAmount,
    manualAdjustmentReason,
    reason,
    idempotencyKey
  } = req.body;

  if (!fromRoomNumber || !toRoomNumber) {
    return res.status(400).json({ error: 'Source and target room numbers are required' });
  }

  // Obtain operator user id
  const resolvedUserId = req.user?.id || req.user?.uid || 'admin';

  try {
    const result = await RoomShiftCutoverService.executeRoomShift({
      params: {
        fromRoomNumber,
        toRoomNumber,
        adjustmentType,
        manualAdjustmentAmount,
        manualAmount,
        manualAdjustmentReason,
        reason,
        resolvedUserId,
        idempotencyKey: idempotencyKey || req.headers['idempotency-key'] || null
      }
    });

    res.json({
      success: true,
      message: result.message || `Successfully shifted guest from Room ${fromRoomNumber} to ${toRoomNumber}`,
      ...result
    });
  } catch (error) {
    console.error('Error during room shifting controller:', error);
    res.status(error.status || 500).json({
      error: error.message || 'Internal Server Error',
      code: error.code
    });
  }
};

export const bookRoom = async (req, res) => {
  const { number } = req.params;
  const { 
    guestName, 
    phone, 
    email,
    gender,
    age,
    idType,
    governmentId,
    pax, 
    deposit, 
    checkInDate,
    checkOutDate,
    userId, 
    extraGuests, 
    extraServices,
    paymentMethod,
    transactionId
  } = req.body;

  // Input Validation
  if (!number || typeof number !== 'string' || number.trim() === '') {
    return res.status(400).json({ error: 'Room number is required' });
  }
  if (!guestName || typeof guestName !== 'string' || guestName.trim() === '') {
    return res.status(400).json({ error: 'Guest name is required' });
  }
  const parsedPax = parseInt(pax, 10);
  if (isNaN(parsedPax) || parsedPax <= 0) {
    return res.status(400).json({ error: 'Pax must be a positive integer' });
  }
  const parsedDeposit = parseInt(deposit, 10);
  if (isNaN(parsedDeposit) || parsedDeposit < 0) {
    return res.status(400).json({ success: false, message: 'Deposit must be a non-negative integer' });
  }

  // Strict Document Validation
  const val = (governmentId || '').trim();
  let docError = null;
  if (!idType || !val) {
    docError = 'ID Type and Document Number are required';
  } else if (idType === 'Aadhaar Card') {
    if (!/^\d{12}$/.test(val)) docError = 'Aadhaar must be exactly 12 numeric digits.';
  } else if (idType === 'Passport') {
    if (!/^[A-Z]\d{7}$/.test(val)) docError = 'Passport must be 1 uppercase letter followed by 7 digits.';
  } else if (idType === 'Voter ID') {
    if (!/^[A-Z]{3}\d{7}$/.test(val)) docError = 'Voter ID must be 3 uppercase letters followed by 7 digits.';
  } else if (idType === 'Driving Licence') {
    const cleanDL = val.replace(/[- ]/g, '');
    if (!/^[A-Z]{2}\d{2}(19|20)\d{2}\d{7}$/.test(cleanDL)) {
      docError = 'Driving Licence must match standard format (e.g. DL0420101234567).';
    }
  } else {
    docError = 'Invalid Document Type.';
  }

  if (docError) {
    return res.status(400).json({ success: false, message: 'Validation Failed', errors: { governmentId: docError } });
  }

  const { idDocumentPath, idOcrText } = req.body;
  // Document upload is optional — guest may show ID offline at reception.
  // If no document is uploaded, id_verification_status is set to 'Offline' below.


  // Obtain user ID from authenticated request context
  const resolvedUserId = req.user?.id || userId;
  const parsedUserId = parseInt(resolvedUserId, 10);
  if (isNaN(parsedUserId)) {
    return res.status(400).json({ error: 'User ID is required for guest booking' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Verify user exists first to prevent foreign key constraint violations
    const [userRows] = await connection.query('SELECT id FROM users WHERE id = ?', [parsedUserId]);
    if (userRows.length === 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'User session expired or user not found. Please log in again.' });
    }

    const [roomRows] = await connection.query(`
      SELECT r.*, rt.base_rate as rate, rt.code as type
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      WHERE r.number = ?
      FOR UPDATE
    `, [number]);
    if (roomRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: `Room ${number} not found` });
    }

    const room = roomRows[0];

    // Razorpay Online Payment Validation
    if (paymentMethod !== 'Cash') {
      if (!transactionId) {
        await connection.rollback();
        return res.status(400).json({ error: 'Transaction ID is required for online payments.' });
      }
      const [txnRows] = await connection.query(
        "SELECT id, amount, status, booking_id FROM razorpay_transactions WHERE id = ? FOR UPDATE",
        [transactionId]
      );
      if (txnRows.length === 0) {
        await connection.rollback();
        return res.status(400).json({ error: 'Invalid transaction ID.' });
      }
      const txn = txnRows[0];
      if (txn.status !== 'SUCCESS') {
        await connection.rollback();
        return res.status(400).json({ error: 'Payment was not successful.' });
      }
      if (txn.booking_id !== null) {
        await connection.rollback();
        return res.status(400).json({ error: 'Payment already consumed by another booking.' });
      }
      if (txn.amount < parsedDeposit) {
        await connection.rollback();
        return res.status(400).json({ error: 'Paid amount is less than the required deposit.' });
      }
    }

    // Determine effective check-in and check-out dates for overlap detection
    // Dates from client are ISO format (YYYY-MM-DD); convert for comparison
    const newCheckIn = checkInDate ? new Date(checkInDate) : new Date();
    const newCheckOut = checkOutDate ? new Date(checkOutDate) : null;

    // Unified availability validation via FirestoreAvailabilityService
    const checkInStr = checkInDate || (await BusinessDateService.getBusinessDate(connection));
    const checkOutStr = checkOutDate || checkInStr;
    const availResult = await FirestoreAvailabilityService.checkRoomAvailability(connection, {
      roomId: room.id,
      roomNumber: number,
      arrivalDate: checkInStr,
      departureDate: checkOutStr,
      forUpdate: true
    });

    if (!availResult.available) {
      await connection.rollback();
      return res.status(400).json({
        error: `Room ${number} cannot be booked: ${availResult.reason}`
      });
    }

    const guestNameUpper = guestName.trim().toUpperCase();

    // Get or create guest profile linked to user_id
    const [guestRows] = await connection.query('SELECT id, loyalty_tier, loyalty_points FROM guests WHERE user_id = ?', [parsedUserId]);
    let guestId;
    let loyaltyTier = 'Bronze';
    let loyaltyPoints = 0;

    if (guestRows.length > 0) {
      guestId = guestRows[0].id;
      loyaltyTier = guestRows[0].loyalty_tier || 'Bronze';
      loyaltyPoints = guestRows[0].loyalty_points || 0;
      // Update their profile details.
      // id_verification_status: 'Pending' if document uploaded for OCR, 'Offline' if guest will show ID in person.
      const verificationStatus = idDocumentPath ? 'Pending' : 'Offline';
      await connection.query(
        `UPDATE guests 
         SET full_name = ?, phone = ?, email = ?, gender = ?, age = ?, id_type = ?, government_id = ?,
             id_document_path = ?, id_upload_timestamp = CASE WHEN ? IS NOT NULL AND ? != '' THEN NOW() ELSE id_upload_timestamp END,
             id_verification_status = ?, id_ocr_text = ?
         WHERE id = ?`,
        [guestNameUpper, phone || '', email || '', gender || '', age ? parseInt(age, 10) : null, idType || '', governmentId || '',
         idDocumentPath || null, idDocumentPath || null, idDocumentPath || null,
         verificationStatus, idOcrText || '', guestId]
      );
    } else {
      const newVerificationStatus = idDocumentPath ? 'Pending' : 'Offline';
      const [newGuestRes] = await connection.query(
        `INSERT INTO guests (full_name, phone, email, gender, age, id_type, government_id, id_document_path, id_upload_timestamp, id_verification_status, id_ocr_text, user_id, loyalty_tier, loyalty_points) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NOT NULL THEN NOW() ELSE NULL END, ?, ?, ?, 'Bronze', 0)`,
        [guestNameUpper, phone || '', email || '', gender || '', age ? parseInt(age, 10) : null, idType || '', governmentId || '',
         idDocumentPath || null, idDocumentPath || null,
         newVerificationStatus, idOcrText || '', parsedUserId]
      );
      guestId = newGuestRes.insertId;
    }

    // Get current business date
    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || '11-Jul-2026';

    // Calculate loyalty discount on room base rate
    let discountPercent = 0;
    if (loyaltyTier === 'Silver') discountPercent = 0.05;
    else if (loyaltyTier === 'Gold') discountPercent = 0.10;
    else if (loyaltyTier === 'Platinum') discountPercent = 0.15;

    const tariffAmount = room.rate;
    const loyaltyDiscountAmount = Math.round(tariffAmount * discountPercent);

    // Calculate extra services totals with loyalty perks
    let servicesTotal = 0;
    const servicesList = [];
    if (extraServices && typeof extraServices === 'object') {
      if (extraServices.breakfast) {
        // Free breakfast for Gold and Platinum tiers
        const isFree = (loyaltyTier === 'Gold' || loyaltyTier === 'Platinum');
        const amt = isFree ? 0 : (250 * parsedPax);
        servicesTotal += amt;
        servicesList.push({ 
          desc: isFree ? 'Extra Service: Buffet Breakfast (Complimentary Loyalty Perk)' : 'Extra Service: Buffet Breakfast', 
          amount: amt 
        });
      }
      if (extraServices.lunch) {
        const amt = 400 * parsedPax;
        servicesTotal += amt;
        servicesList.push({ desc: 'Extra Service: Executive Lunch', amount: amt });
      }
      if (extraServices.dinner) {
        const amt = 500 * parsedPax;
        servicesTotal += amt;
        servicesList.push({ desc: 'Extra Service: Gourmet Dinner', amount: amt });
      }
      if (extraServices.parking) {
        // Free secure parking for Platinum tier
        const isFree = (loyaltyTier === 'Platinum');
        const amt = isFree ? 0 : 150;
        servicesTotal += amt;
        servicesList.push({ 
          desc: isFree ? 'Extra Service: Secure Parking (Complimentary Loyalty Perk)' : 'Extra Service: Secure Parking', 
          amount: amt 
        });
      }
    }

    const netTariffAmount = tariffAmount;
    // GST is included in the room rate — no separate tax line
    const bookingTotal = (netTariffAmount - loyaltyDiscountAmount) + servicesTotal;

    // Create Reserved Booking
    const bookingNumber = 'BKG-' + Math.floor(100000 + Math.random() * 900000);
    const expectedCheckOutStr = checkOutDate || '';
    const [bookingRes] = await connection.query(
      `INSERT INTO bookings (booking_number, guest_id, room_id, check_in_date, expected_check_out_date, adults, booking_status, payment_status, total_amount, advance_amount, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'Reserved', ?, ?, ?, ?)`,
      [bookingNumber, guestId, room.id, checkInDate || businessDate, expectedCheckOutStr, parsedPax, parsedDeposit >= bookingTotal ? 'Paid' : 'Partial', bookingTotal, parsedDeposit, parsedUserId]
    );
    const bookingId = bookingRes.insertId;

    // Add initial ledger entries (Room Tariff Charge, Services, and Taxes)
    await connection.query(
      'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
      [number, 'Room Tariff (Incl. GST)', tariffAmount, businessDate, bookingId]
    );

    // Add negative loyalty discount ledger item if any
    if (loyaltyDiscountAmount > 0) {
      await connection.query(
        'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
        [number, `Loyalty ${loyaltyTier} Discount (${discountPercent * 100}%)`, 1, -loyaltyDiscountAmount, businessDate, bookingId]
      );
    }

    // Add extra services to ledger
    for (const service of servicesList) {
      await connection.query(
        'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
        [number, service.desc, service.amount, businessDate, bookingId]
      );
    }

    // (GST included in rate — no separate tax line)

    // Add extra guests as zero-charge ledger items to folio
    if (extraGuests && Array.isArray(extraGuests)) {
      for (const extra of extraGuests) {
        if (extra.name && extra.age) {
          const descStr = `Extra Guest: ${extra.name.trim().toUpperCase()} (Age: ${extra.age})`;
          await connection.query(
            'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, 0, ?, ?)',
            [number, descStr, businessDate, bookingId]
          );
        }
      }
    }

    // Phase 4G-A: hoisted to outer scope so PAYMENT_CREATED enqueue can use it
    let advPaymentMysqlId = 0;

    // Insert cash log transaction if deposit paid
    if (parsedDeposit > 0) {
      const timeStr = formatTime(new Date());
      await connection.query(
        `INSERT INTO cash_logs (time, room, guest, type, amount, business_date, booking_id)
         VALUES (?, ?, ?, 'Advance Deposit', ?, ?, ?)`,
        [timeStr, number, guestNameUpper, parsedDeposit, businessDate, bookingId]
      );

      // Log Payment transaction
      // Phase 4G-A: capture insertId (previously discarded) for PAYMENT_CREATED outbox event
      const [advPaymentResult] = await connection.query(
        `INSERT INTO payments (booking_id, amount, payment_method, payment_type, business_date)
         VALUES (?, ?, 'Cash', 'Advance Deposit', ?)`,
        [bookingId, parsedDeposit, businessDate]
      );
      advPaymentMysqlId = advPaymentResult.insertId;
    }

    // Log Room Status History
    await connection.query(
      `INSERT INTO room_status_history (room_id, old_status, new_status, changed_by, business_date)
       VALUES (?, 'vacant', 'booked', ?, ?)`,
      [room.id, parsedUserId, businessDate]
    );

    // Calculate points earned: 1 point for every ₹10 spent
    const pointsEarned = Math.round(bookingTotal / 10);
    const updatedPoints = loyaltyPoints + pointsEarned;

    // Determine new tier based on total points
    let updatedTier = 'Bronze';
    if (updatedPoints >= 3000) updatedTier = 'Platinum';
    else if (updatedPoints >= 1500) updatedTier = 'Gold';
    else if (updatedPoints >= 500) updatedTier = 'Silver';

    await connection.query(
      'UPDATE guests SET loyalty_points = ?, loyalty_tier = ? WHERE id = ?',
      [updatedPoints, updatedTier, guestId]
    );

    // Insert Audit Log entry with updated loyalty points
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date)
       VALUES (?, 'BOOK_ROOM', ?, ?)`,
      [parsedUserId, `Online reservation booked for Room ${number}. Booking ID: ${bookingId}. Earned ${pointsEarned} loyalty points (Total: ${updatedPoints}, Tier: ${updatedTier})`, businessDate]
    );

    // Update room status to 'booked' only if it was previously 'vacant'
    // If room was already 'booked' (for a non-overlapping future date), leave it as 'booked' — the first guest's booking already set that
    if (room.status === 'vacant') {
      await connection.query(
        "UPDATE rooms SET status = 'booked' WHERE id = ?",
        [room.id]
      );
    }

    await connection.commit();
    res.json({ 
      message: `Successfully booked Room ${number}`,
      bookingNumber,
      bookingId,
      loyalty: {
        pointsEarned,
        totalPoints: updatedPoints,
        tier: updatedTier
      }
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError);
      }
    }
    console.error('Error during bookRoom controller:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

export const modifyCheckIn = async (req, res) => {
  const { number } = req.params;
  const { 
    guestName, 
    phone, 
    pax, 
    deposit, 
    checkInDate, 
    expectedCheckOutDate,
    address,
    state,
    gst_no,
    pincode,
    country,
    arrival_from,
    departure_to,
    billing_instruction,
    meal_plan,
    gender,
    dob,
    dateOfBirth
  } = req.body;

  if (!number) {
    return res.status(400).json({ error: 'Room number is required' });
  }

  const guestNameUpper = guestName ? guestName.trim().toUpperCase() : '';
  const ALLOWED_BILLING = ['Direct to Guest', 'Bill to Company', 'Room Tariff Only'];
  const ALLOWED_MEAL    = ['EP', 'CP', 'MAP', 'AP'];
  const resolvedBilling  = billing_instruction && ALLOWED_BILLING.includes(billing_instruction)
    ? billing_instruction
    : 'Direct to Guest';
  const resolvedMealPlan = meal_plan && ALLOWED_MEAL.includes(meal_plan)
    ? meal_plan
    : 'EP';

  // 1. Update Firestore
  if (db) {
    try {
      const roomDocSnap = await db.collection('rooms').doc(`room_${number}`).get();
      if (roomDocSnap.exists && roomDocSnap.data().current_booking_id) {
        const fsBkgRef = db.collection('bookings').doc(roomDocSnap.data().current_booking_id);
        const fsBkgSnap = await fsBkgRef.get();
        if (fsBkgSnap.exists) {
          const fsBkgData = fsBkgSnap.data();
          const updateBkg = {
            updated_at: new Date().toISOString()
          };
          if (guestNameUpper) updateBkg.guest_name = guestNameUpper;
          if (phone) updateBkg.phone = phone;
          if (address !== undefined) updateBkg.address = address;
          if (state !== undefined) updateBkg.state = state;
          if (pincode !== undefined) updateBkg.pincode = pincode;
          if (country !== undefined) updateBkg.country = country;
          if (gst_no !== undefined) updateBkg.gst_no = gst_no;
          if (checkInDate) updateBkg.check_in_date = checkInDate;
          if (expectedCheckOutDate) updateBkg.expected_check_out_date = expectedCheckOutDate;
          if (pax) { updateBkg.adults = Number(pax); updateBkg.pax = Number(pax); }
          if (deposit !== undefined) updateBkg.advance_amount = Number(deposit);
          if (billing_instruction) updateBkg.billing_instruction = resolvedBilling;
          if (meal_plan) updateBkg.meal_plan = resolvedMealPlan;
          if (gender !== undefined) updateBkg.gender = gender;
          if (dob || dateOfBirth) updateBkg.date_of_birth = dob || dateOfBirth;

          await fsBkgRef.update(updateBkg);

          if (fsBkgData.guest_id) {
            const fsGuestRef = db.collection('guests').doc(fsBkgData.guest_id);
            const updateGuest = { updated_at: new Date().toISOString() };
            if (guestNameUpper) updateGuest.full_name = guestNameUpper;
            if (phone) updateGuest.phone = phone;
            if (address !== undefined) updateGuest.address = address;
            if (state !== undefined) updateGuest.state = state;
            if (pincode !== undefined) updateGuest.pincode = pincode;
            if (country !== undefined) updateGuest.country = country;
            if (gst_no !== undefined) updateGuest.gst_no = gst_no;
            if (gender !== undefined) updateGuest.gender = gender;
            if (dob || dateOfBirth) updateGuest.date_of_birth = dob || dateOfBirth;
            await fsGuestRef.update(updateGuest).catch(() => {});
          }
        }
      }
    } catch (fsErr) {
      console.warn('[modifyCheckIn] Firestore update warning:', fsErr.message);
    }
  }

  // 2. MySQL dual-write
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [roomRows] = await connection.query(`
      SELECT id, status FROM rooms WHERE number = ? FOR UPDATE
    `, [number]);
    if (roomRows.length > 0) {
      const room = roomRows[0];
      const [bookingRows] = await connection.query(`
        SELECT * FROM bookings 
        WHERE room_id = ? AND booking_status IN ('Checked In', 'Reserved')
        ORDER BY id DESC LIMIT 1 FOR UPDATE
      `, [room.id]);

      if (bookingRows.length > 0) {
        const booking = bookingRows[0];
        if (guestNameUpper) {
          await connection.query(`
            UPDATE guests 
            SET full_name = ?, phone = ?, address = ?, gst_no = ?, pincode = ?, country = ?, arrival_from = ?, departure_to = ?
            WHERE id = ?
          `, [
            guestNameUpper, 
            phone || '', 
            address || '', 
            gst_no || '', 
            pincode || '', 
            country || '', 
            arrival_from || '', 
            departure_to || '', 
            booking.guest_id
          ]);
        }

        const parsedPax = pax ? parseInt(pax, 10) : booking.adults;
        const parsedDeposit = deposit !== undefined ? parseInt(deposit, 10) : booking.advance_amount;

        await connection.query(`
          UPDATE bookings 
          SET check_in_date = ?, expected_check_out_date = ?, adults = ?, advance_amount = ?,
              billing_instruction = ?, meal_plan = ?
          WHERE id = ?
        `, [
          checkInDate || booking.check_in_date, 
          expectedCheckOutDate || booking.expected_check_out_date || '',
          parsedPax, 
          parsedDeposit,
          resolvedBilling,
          resolvedMealPlan,
          booking.id
        ]);

        const resolvedUserId = req.user?.id || null;
        const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
        const systemDate = settings[0]?.value_val || '11-Jul-2026';

        await connection.query(
          `INSERT INTO audit_logs (user_id, action, details, business_date)
           VALUES (?, 'MODIFY_CHECKIN', ?, ?)`,
          [resolvedUserId, `Modified check-in details for Room ${number}. Booking ID: ${booking.id}`, systemDate]
        );
      }
    }
    await connection.commit();
  } catch (sqlErr) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }
    console.warn('[modifyCheckIn] MySQL update warning:', sqlErr.message);
  } finally {
    if (connection) {
      connection.release();
    }
  }

  return res.json({ message: `Successfully modified check-in details for Room ${number}` });
};

// ─────────────────────────────────────────────────────────────
// GUEST PORTAL PHASE 2 — Guest-Facing Controllers
export const guestRequestCheckIn = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: "Unauthorized" });
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // ── Step 3D-4: Guest ownership resolution ──────────────────────────────────
    let guestId;
    const claimedGuestId = resolveGuestOwnershipId(req);
    if (claimedGuestId !== null) {
      // Flag ON: use Firebase Custom Claim — zero MySQL guest lookup
      guestId = claimedGuestId;
    } else {
      // Flag OFF: legacy MySQL lookup
      const [guestRows] = await connection.query("SELECT id FROM guests WHERE user_id = ?", [resolvedUserId]);
      if (guestRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: "Guest profile not found" });
      }
      guestId = guestRows[0].id;
    }
    const [bookingRows] = await connection.query(
      `SELECT b.*, r.number as room_number FROM bookings b
       JOIN rooms r ON b.room_id = r.id
       WHERE b.guest_id = ? AND b.booking_status = 'Reserved'
       ORDER BY b.id DESC LIMIT 1`,
      [guestId]
    );
    if (bookingRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: "No upcoming reservation found" });
    }
    const booking = bookingRows[0];
    const [pendingPayment] = await connection.query(
      `SELECT id, amount FROM payments WHERE booking_id = ? AND payment_method = 'Cash' AND payment_status = 'Pending' LIMIT 1`,
      [booking.id]
    );
    if (pendingPayment.length > 0) {
      await connection.rollback();
      return res.status(403).json({
        error: "Cash payment not yet confirmed.",
        message: `Your advance cash payment of ₹${pendingPayment[0].amount} has not been confirmed. Please visit the front desk.`,
        code: "CASH_PAYMENT_PENDING"
      });
    }
    await processCheckIn(connection, {
      roomNumber: booking.room_number,
      guestId: guestId,
      resolvedUserId,
      isGuestSelfCheckIn: true
    });
    await connection.commit();
    res.json({ message: `Successfully checked in to Room ${booking.room_number}`, roomNumber: booking.room_number });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch (e) {} }
    console.error("guestRequestCheckIn error:", error);
    res.status(error.status || 500).json({ error: error.message || "Internal Server Error" });
  } finally {
    if (connection) connection.release();
  }
};

export const guestAddService = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: 'Unauthorized' });

  const { serviceDesc, amount, qty = 1 } = req.body;
  if (!serviceDesc || !amount) return res.status(400).json({ error: 'serviceDesc and amount are required' });

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // ── Step 3D-4: Guest ownership resolution ──────────────────────────────────
    let guestId;
    const claimedGuestId = resolveGuestOwnershipId(req);
    if (claimedGuestId !== null) {
      guestId = claimedGuestId;
    } else {
      const [guestRows] = await connection.query('SELECT id FROM guests WHERE user_id = ?', [resolvedUserId]);
      if (guestRows.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'Guest profile not found' }); }
      guestId = guestRows[0].id;
    }

    const [bookingRows] = await connection.query(
      `SELECT b.*, r.number as room_number FROM bookings b
       JOIN rooms r ON b.room_id = r.id
       WHERE b.guest_id = ? AND b.booking_status = 'Checked In'
       ORDER BY b.id DESC LIMIT 1`,
      [guestId]
    );
    if (bookingRows.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'No active stay found' }); }
    const booking = bookingRows[0];

    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');

    const parsedAmt = parseInt(amount, 10);
    const parsedQty = parseInt(qty, 10);

    // Insert ledger item
    await connection.query(
      'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, ?, ?, ?, ?)',
      [booking.room_number, serviceDesc, parsedQty, parsedAmt * parsedQty, businessDate, booking.id]
    );
    // Notify guest
    await connection.query(
      'INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
      [resolvedUserId, '✅ Service Requested', `Your request for "${serviceDesc}" has been received and will be delivered shortly.`]
    );

    await connection.commit();
    invalidateGuestRequestsCache();
    req.app.get('io')?.emit('new_guest_request', { type: 'service' });
    res.json({ message: 'Service request submitted successfully' });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch (e) {} }
    console.error('guestAddService error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

/** Guest reports a maintenance issue */
export const guestReportMaintenance = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: 'Unauthorized' });

  const { issue } = req.body;
  if (!issue || issue.trim() === '') return res.status(400).json({ error: 'Issue description is required' });

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // ── Step 3D-4: Guest ownership resolution ──────────────────────────────────
    let guestId;
    const claimedGuestId = resolveGuestOwnershipId(req);
    if (claimedGuestId !== null) {
      guestId = claimedGuestId;
    } else {
      const [guestRows] = await connection.query('SELECT id FROM guests WHERE user_id = ?', [resolvedUserId]);
      if (guestRows.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'Guest profile not found' }); }
      guestId = guestRows[0].id;
    }

    const [bookingRows] = await connection.query(
      `SELECT b.*, r.id as room_id_val, r.number as room_number FROM bookings b
       JOIN rooms r ON b.room_id = r.id
       WHERE b.guest_id = ? AND b.booking_status = 'Checked In'
       ORDER BY b.id DESC LIMIT 1`,
      [guestId]
    );
    if (bookingRows.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'No active stay found' }); }
    const booking = bookingRows[0];

    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');

    await connection.query(
      `INSERT INTO maintenance (room_id, reported_by, issue, status, business_date) VALUES (?, ?, ?, 'Pending', ?)`,
      [booking.room_id_val, resolvedUserId, issue.trim(), businessDate]
    );
    await connection.query(
      'INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
      [resolvedUserId, '🔧 Maintenance Report Received', `Your maintenance report for Room ${booking.room_number} has been logged. Our team will attend to it shortly.`]
    );

    await connection.commit();
    invalidateGuestRequestsCache();
    req.app.get('io')?.emit('new_guest_request', { type: 'maintenance' });
    res.json({ message: 'Maintenance request submitted successfully' });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch (e) {} }
    console.error('guestReportMaintenance error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

/** Guest extends their checkout date */
export const guestExtendStay = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: 'Unauthorized' });

  const { newCheckOutDate } = req.body;
  if (!newCheckOutDate) return res.status(400).json({ error: 'newCheckOutDate is required' });

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // ── Step 3D-4: Guest ownership resolution ──────────────────────────────────
    let guestId;
    const claimedGuestId = resolveGuestOwnershipId(req);
    if (claimedGuestId !== null) {
      guestId = claimedGuestId;
    } else {
      const [guestRows] = await connection.query('SELECT id FROM guests WHERE user_id = ?', [resolvedUserId]);
      if (guestRows.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'Guest profile not found' }); }
      guestId = guestRows[0].id;
    }

    const [bookingRows] = await connection.query(
      `SELECT b.*, r.number as room_number FROM bookings b
       JOIN rooms r ON b.room_id = r.id
       WHERE b.guest_id = ? AND b.booking_status = 'Checked In'
       ORDER BY b.id DESC LIMIT 1`,
      [guestId]
    );
    if (bookingRows.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'No active stay found' }); }
    const booking = bookingRows[0];

    // Validate new date is after existing check-out
    const existingOut = new Date(booking.expected_check_out_date);
    const newOut = new Date(newCheckOutDate);
    if (newOut <= existingOut) {
      await connection.rollback();
      return res.status(400).json({ error: 'New checkout date must be after the current checkout date' });
    }

    // Check if there is already a Pending request
    const [existingReqs] = await connection.query(
      "SELECT id FROM stay_extension_requests WHERE booking_id = ? AND status = 'Pending'",
      [booking.id]
    );
    if (existingReqs.length > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'You already have a pending extension request. Please wait for reception to approve it.' });
    }

    console.log(`[ExtendStay] Request received for Booking ${booking.id} to new checkout date ${newCheckOutDate}`);

    // Verify room availability for the extension period using FirestoreAvailabilityService
    const availResult = await FirestoreAvailabilityService.checkRoomAvailability(connection, {
      roomId: booking.room_id,
      roomNumber: booking.room_number,
      arrivalDate: booking.expected_check_out_date,
      departureDate: newCheckOutDate,
      forUpdate: true
    });

    if (!availResult.available) {
      console.log(`[ExtendStay] Conflict found for Room ${booking.room_id}. Request rejected: ${availResult.reason}`);
      await connection.rollback();
      return res.status(400).json({ error: 'Sorry, this room is already booked for the requested extension period.' });
    }

    // Create the extension request
    await connection.query(
      'INSERT INTO stay_extension_requests (booking_id, guest_id, room_id, current_checkout_date, requested_checkout_date) VALUES (?, ?, ?, ?, ?)',
      [booking.id, guestId, booking.room_id, booking.expected_check_out_date, newCheckOutDate]
    );
    console.log(`[ExtendStay] Pending request saved to stay_extension_requests for Booking ${booking.id}`);

    await connection.query(
      'INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
      [resolvedUserId, '⏳ Extension Requested', `Your request to extend stay until ${new Date(newCheckOutDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} has been submitted to reception for approval.`]
    );

    await connection.commit();
    invalidateGuestRequestsCache();
    console.log(`[ExtendStay] Transaction committed. Emitting socket notification...`);
    req.app.get('io')?.emit('new_guest_request', { type: 'extension' });
    res.json({ message: `Extension request to ${newCheckOutDate} submitted for approval.` });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch (e) {} }
    console.error('guestExtendStay error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

// ─── GET: Live bill/folio for the guest's active booking ──────────────────
export const getGuestBill = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // ── Step 3D-4: Guest ownership resolution ──────────────────────────────────
    let claimedGuestId = null;
    try {
      claimedGuestId = resolveGuestOwnershipId(req);
    } catch (_) {}

    const mysqlHandler = async () => {
      let guestId;
      if (claimedGuestId !== null) {
        guestId = claimedGuestId;
      } else {
        const [guestRows] = await pool.query('SELECT id FROM guests WHERE user_id = ?', [resolvedUserId]);
        if (guestRows.length === 0) {
          const err = new Error('Guest profile not found');
          err.status = 404;
          throw err;
        }
        guestId = guestRows[0].id;
      }

      const [bookingRows] = await pool.query(
        `SELECT b.*, r.number as room_number, rt.title as room_type_title, rt.base_rate
         FROM bookings b
         JOIN rooms r ON b.room_id = r.id
         JOIN room_types rt ON r.room_type_id = rt.id
         WHERE b.guest_id = ? AND b.booking_status IN ('Checked In', 'Reserved')
         ORDER BY b.id DESC LIMIT 1`,
        [guestId]
      );
      if (bookingRows.length === 0) return { booking: null, ledger: [] };
      const booking = bookingRows[0];

      const [ledger] = await pool.query(
        'SELECT * FROM ledger_items WHERE booking_id = ? ORDER BY id ASC',
        [booking.id]
      );

      return { booking, ledger };
    };

    const result = await AuditHistoryCutoverService.getGuestBill({ claimedGuestId, resolvedUserId }, mysqlHandler);
    const booking = result?.booking || null;
    const ledger = result?.ledger || [];
    return res.json({ booking, ledger });
  } catch (error) {
    console.error('getGuestBill error:', error);
    res.status(error.status || 500).json({ error: error.message || 'Internal Server Error' });
  }
};

/** Get notifications for the logged-in guest */
export const getGuestNotifications = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const [rows] = await pool.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [resolvedUserId]
    );
    res.json({ notifications: rows });
  } catch (error) {
    console.error('getGuestNotifications error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/** Mark a notification as read */
export const markNotificationRead = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.params;
  try {
    await pool.query('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [id, resolvedUserId]);
    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    console.error('markNotificationRead error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/** Guest requests checkout — sends admin notification */
export const guestRequestCheckout = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: 'Unauthorized' });

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // ── Step 3D-4: Guest ownership resolution ──────────────────────────────────
    let guest;
    const claimedGuestId = resolveGuestOwnershipId(req);
    if (claimedGuestId !== null) {
      // Flag ON: use claim. We still need full_name for audit log — fetch it.
      const [gRows] = await connection.query('SELECT id, full_name FROM guests WHERE id = ?', [claimedGuestId]);
      if (gRows.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'Guest profile not found' }); }
      guest = gRows[0];
    } else {
      const [guestRows] = await connection.query('SELECT id, full_name FROM guests WHERE user_id = ?', [resolvedUserId]);
      if (guestRows.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'Guest profile not found' }); }
      guest = guestRows[0];
    }

    const [bookingRows] = await connection.query(
      `SELECT b.*, r.number as room_number FROM bookings b
       JOIN rooms r ON b.room_id = r.id
       WHERE b.guest_id = ? AND b.booking_status = 'Checked In'
       ORDER BY b.id DESC LIMIT 1`,
      [guest.id]
    );
    if (bookingRows.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'No active stay found' }); }
    const booking = bookingRows[0];

    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');

    // Notify the guest
    await connection.query(
      'INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
      [resolvedUserId, '📋 Checkout Requested', `Your checkout request for Room ${booking.room_number} has been received. Please visit the reception desk to complete bill settlement.`]
    );
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'GUEST_CHECKOUT_REQUEST', ?, ?)`,
      [resolvedUserId, `Guest ${guest.full_name} requested checkout from Room ${booking.room_number}, Booking ID: ${booking.id}`, businessDate]
    );

    await connection.commit();
    invalidateGuestRequestsCache();
    req.app.get('io')?.emit('new_guest_request', { type: 'checkout' });
    res.json({ message: 'Checkout request submitted. Please proceed to the reception desk.', roomNumber: booking.room_number });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch (e) {} }
    console.error('guestRequestCheckout error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

// ─── POST-CHECKOUT: Submit Feedback & Rating ────────────────────────────────
/** Guest submits a post-stay review */
export const guestSubmitFeedback = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, overallRating, roomCleanliness, serviceQuality, valueForMoney, comments, wouldRecommend } = req.body;

  if (!bookingId || !overallRating) {
    return res.status(400).json({ error: 'bookingId and overallRating are required' });
  }
  const rating = parseInt(overallRating, 10);
  if (isNaN(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'overallRating must be between 1 and 5' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // ── Step 3D-4: Guest ownership resolution ──────────────────────────────────
    // Verify this booking belongs to this guest and is checked out
    let guestId;
    const claimedGuestId = resolveGuestOwnershipId(req);
    if (claimedGuestId !== null) {
      guestId = claimedGuestId;
    } else {
      const [guestRows] = await connection.query('SELECT id FROM guests WHERE user_id = ?', [resolvedUserId]);
      if (guestRows.length === 0) { await connection.rollback(); return res.status(404).json({ error: 'Guest profile not found' }); }
      guestId = guestRows[0].id;
    }

    const [bookingRows] = await connection.query(
      `SELECT b.id, b.booking_status, r.number as room_number 
       FROM bookings b JOIN rooms r ON b.room_id = r.id
       WHERE b.id = ? AND b.guest_id = ?`,
      [bookingId, guestId]
    );
    if (bookingRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Booking not found or does not belong to you' });
    }
    if (bookingRows[0].booking_status !== 'Checked Out') {
      await connection.rollback();
      return res.status(400).json({ error: 'Feedback can only be submitted after checkout' });
    }

    // Check for duplicate feedback
    const [existingFeedback] = await connection.query('SELECT id FROM feedback WHERE booking_id = ?', [bookingId]);
    if (existingFeedback.length > 0) {
      await connection.rollback();
      return res.status(409).json({ error: 'Feedback already submitted for this booking' });
    }

    // Insert feedback
    await connection.query(
      `INSERT INTO feedback (booking_id, guest_id, overall_rating, room_cleanliness, service_quality, value_for_money, comments, would_recommend)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [bookingId, guestId, rating,
       roomCleanliness ? parseInt(roomCleanliness, 10) : null,
       serviceQuality ? parseInt(serviceQuality, 10) : null,
       valueForMoney ? parseInt(valueForMoney, 10) : null,
       comments || null,
       wouldRecommend === false || wouldRecommend === 0 ? 0 : 1]
    );

    // Award 50 loyalty points for leaving a review
    await connection.query(
      `UPDATE guests SET loyalty_points = loyalty_points + 50 WHERE id = ?`,
      [guestId]
    );

    // Notify guest of points earned
    await connection.query(
      `INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)`,
      [resolvedUserId, '⭐ Thank You for Your Review!', 'You earned 50 loyalty points for sharing your feedback. We look forward to welcoming you again!']
    );

    // Audit log
    const [settings] = await connection.query("SELECT value_val FROM system_settings WHERE key_name = 'system_date'");
    const businessDate = settings[0]?.value_val || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'GUEST_FEEDBACK', ?, ?)`,
      [resolvedUserId, `Guest submitted ${rating}-star review for Booking ID: ${bookingId}`, businessDate]
    );

    await connection.commit();
    res.json({ message: 'Thank you for your feedback! You earned 50 loyalty points.', pointsEarned: 50 });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch (e) {} }
    console.error('guestSubmitFeedback error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

// ─── GET: Guest's own booking history ──────────────────────────────────────
/** Returns all bookings for the authenticated guest with payment and feedback status */
export const getGuestHistory = async (req, res) => {
  const resolvedUserId = req.user?.id;
  if (!resolvedUserId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // ── Step 3D-4: Guest ownership resolution ──────────────────────────────────
    let claimedGuestId = null;
    try {
      claimedGuestId = resolveGuestOwnershipId(req);
    } catch (_) {}

    const mysqlHandler = async () => {
      let guest;
      if (claimedGuestId !== null) {
        const [guestRows] = await pool.query('SELECT id, full_name, phone, email, loyalty_tier, loyalty_points FROM guests WHERE id = ?', [claimedGuestId]);
        if (guestRows.length === 0) {
          const err = new Error('Guest profile not found');
          err.status = 404;
          throw err;
        }
        guest = guestRows[0];
      } else {
        const [guestRows] = await pool.query('SELECT id, full_name, phone, email, loyalty_tier, loyalty_points FROM guests WHERE user_id = ?', [resolvedUserId]);
        if (guestRows.length === 0) {
          const err = new Error('Guest profile not found');
          err.status = 404;
          throw err;
        }
        guest = guestRows[0];
      }

      const [bookings] = await pool.query(`
        SELECT 
          b.id,
          b.booking_number,
          b.check_in_date,
          b.check_out_date,
          b.expected_check_out_date,
          b.adults,
          b.booking_status,
          b.payment_status,
          b.total_amount,
          b.advance_amount,
          b.created_at,
          r.number as room_number,
          rt.code as room_type,
          rt.title as room_title,
          f.id as feedback_id,
          f.overall_rating,
          f.comments as feedback_comments,
          f.created_at as feedback_date,
          COALESCE(
            (SELECT SUM(p.amount) FROM payments p WHERE p.booking_id = b.id), 0
          ) as total_paid
        FROM bookings b
        JOIN rooms r ON b.room_id = r.id
        JOIN room_types rt ON r.room_type_id = rt.id
        LEFT JOIN feedback f ON f.booking_id = b.id
        WHERE b.guest_id = ?
        ORDER BY b.created_at DESC
      `, [guest.id]);

      return { guest, bookings, totalStays: bookings.length };
    };

    const result = await AuditHistoryCutoverService.getGuestHistory({ claimedGuestId, resolvedUserId }, mysqlHandler);
    const guest = result?.guest;
    const bookings = result?.bookings || [];
    const totalStays = result?.totalStays || bookings.length;
    res.json({ guest, bookings, totalStays });
  } catch (error) {
    console.error('getGuestHistory error:', error);
    res.status(error.status || 500).json({ error: error.message || 'Internal Server Error' });
  }
};

// ─── GET (Admin): View a specific guest's full history ──────────────────────
export const getGuestHistoryAdmin = async (req, res) => {
  const { guestId } = req.params;
  try {
    // ── Step 3D-4: Guest ownership resolution ──────────────────────────────────
    const mysqlHandler = async () => {
      const [guestRows] = await pool.query(
        'SELECT id, full_name, phone, email, loyalty_tier, loyalty_points, created_at FROM guests WHERE id = ?',
        [guestId]
      );
      if (guestRows.length === 0) {
        const err = new Error('Guest not found');
        err.status = 404;
        throw err;
      }
      const guest = guestRows[0];

      const [bookings] = await pool.query(`
        SELECT 
          b.id, b.booking_number, b.check_in_date, b.check_out_date,
          b.booking_status, b.payment_status, b.total_amount, b.advance_amount,
          r.number as room_number, rt.code as room_type,
          f.overall_rating, f.comments as feedback_comments,
          COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.booking_id = b.id), 0) as total_paid
        FROM bookings b
        JOIN rooms r ON b.room_id = r.id
        JOIN room_types rt ON r.room_type_id = rt.id
        LEFT JOIN feedback f ON f.booking_id = b.id
        WHERE b.guest_id = ?
        ORDER BY b.created_at DESC
      `, [guest.id]);

      const [payments] = await pool.query(`
        SELECT p.*, b.booking_number
        FROM payments p
        JOIN bookings b ON p.booking_id = b.id
        WHERE b.guest_id = ?
        ORDER BY p.created_at DESC
      `, [guest.id]);

      return { guest, bookings, payments };
    };

    const result = await AuditHistoryCutoverService.getGuestHistoryAdmin(guestId, mysqlHandler);
    const guest = result?.guest;
    const bookings = result?.bookings || [];
    const payments = result?.payments || [];
    res.json({ guest, bookings, payments });
  } catch (error) {
    console.error('getGuestHistoryAdmin error:', error);
    res.status(error.status || 500).json({ error: error.message || 'Internal Server Error' });
  }
};

export const uploadIdentity = async (req, res) => {
  console.log('--- UPLOAD IDENTITY START ---');
  console.log('Request body:', req.body);
  console.log('Request file:', req.file);

  if (!req.file) {
    console.log('FAILED: No req.file');
    return res.status(400).json({ success: false, message: 'Upload Failed', errors: { document: 'No file uploaded or invalid file format.' } });
  }

  const { idType, documentNumber } = req.body;
  if (!idType) {
    console.log('FAILED: No idType provided');
    try { fs.unlinkSync(req.file.path); } catch(e) {}
    return res.status(400).json({ success: false, message: 'Upload Failed', errors: { document: 'ID Type is required for verification.' } });
  }

  try {
    // 1. Extract Text
    console.log('Starting OCR extraction for file:', req.file.path);
    const ocrData = await extractOCRData(req.file.path, req.file.mimetype);
    console.log('OCR Extraction Result (first 100 chars):', ocrData.preprocessedText ? ocrData.preprocessedText.substring(0, 100).replace(/\n/g, ' ') : 'NULL');

    // 2. Verify Document Type Match
    console.log(`Starting Document Verification. ID Type: ${idType}, Document Number: ${documentNumber}`);
    const verificationResult = verifyDocumentData(ocrData, idType, documentNumber);
    console.log('Document Match Result:', verificationResult);
    
    if (!verificationResult.success) {
      console.log('FAILED: Document verification failed. isMatch=false');
      try { fs.unlinkSync(req.file.path); } catch(e) {} // Clean up mismatched file
    } else {
      console.log('SUCCESS: Document verified successfully');
    }

    const report = {
      success: verificationResult.success,
      message: verificationResult.message,
      data: verificationResult.success ? {
        filePath: req.file.filename,
        ocrText: ocrData.preprocessedText.substring(0, 1000) // Keep reasonable length
      } : undefined,
      errors: !verificationResult.success ? { document: verificationResult.message } : undefined,
      verificationReport: {
        reasonFailed: verificationResult.success ? null : verificationResult.reason,
        ocrRawText: ocrData.rawText.substring(0, 500),
        ocrPreprocessedText: ocrData.preprocessedText.substring(0, 500),
        confidenceScore: ocrData.confidence,
        matchingScore: verificationResult.score,
        decision: verificationResult.success ? 'ACCEPTED' : 'REJECTED'
      }
    };

    if (verificationResult.success) {
      res.json(report);
    } else {
      res.status(400).json(report);
    }
  } catch (error) {
    console.error('OCR Process Error:', error);
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch(e) {}
    res.status(500).json({ success: false, message: 'Internal Server Error during document verification.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// REFUND POLICY — Admin-configurable cancellation refund settings
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/refund-policy  — return the 4 refund policy keys */
export const getRefundPolicy = async (req, res) => {
  try {
    const keys = ['refund_no_stay_pct', 'refund_partial_stay_pct', 'refund_full_stay_pct', 'refund_partial_hours'];
    const [rows] = await pool.query(
      'SELECT key_name, value_val FROM system_settings WHERE key_name IN (?)',
      [keys]
    );
    const policy = {};
    rows.forEach(r => { policy[r.key_name] = parseFloat(r.value_val); });
    // Provide safe defaults if keys are missing
    res.json({
      noStayPct:      policy['refund_no_stay_pct']      ?? 100,
      partialStayPct: policy['refund_partial_stay_pct'] ?? 50,
      fullStayPct:    policy['refund_full_stay_pct']    ?? 0,
      partialHours:   policy['refund_partial_hours']    ?? 12
    });
  } catch (error) {
    console.error('Error in getRefundPolicy:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/** PUT /api/refund-policy  — update the 4 refund policy keys (admin only) */
export const updateRefundPolicy = async (req, res) => {
  const { noStayPct, partialStayPct, fullStayPct, partialHours } = req.body;

  // Validation
  const vals = [noStayPct, partialStayPct, fullStayPct, partialHours];
  if (vals.some(v => v === undefined || v === null || isNaN(parseFloat(v)))) {
    return res.status(400).json({ error: 'All four refund policy values are required and must be numeric' });
  }
  if ([noStayPct, partialStayPct, fullStayPct].some(v => parseFloat(v) < 0 || parseFloat(v) > 100)) {
    return res.status(400).json({ error: 'Refund percentages must be between 0 and 100' });
  }

  try {
    const updates = [
      ['refund_no_stay_pct',      String(parseFloat(noStayPct))],
      ['refund_partial_stay_pct', String(parseFloat(partialStayPct))],
      ['refund_full_stay_pct',    String(parseFloat(fullStayPct))],
      ['refund_partial_hours',    String(parseFloat(partialHours))]
    ];
    for (const [key, val] of updates) {
      await pool.query(
        'INSERT INTO system_settings (key_name, value_val) VALUES (?, ?) ON DUPLICATE KEY UPDATE value_val = ?',
        [key, val, val]
      );
    }

    const resolvedUserId = req.user?.id || null;
    const [settings] = await pool.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
    const businessDate = settings[0]?.value_val || '18-Jul-2026';
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'UPDATE_REFUND_POLICY', ?, ?)`,
      [resolvedUserId, `Refund policy updated: NoStay=${noStayPct}%, Partial=${partialStayPct}%, Full=${fullStayPct}%, PartialHrs=${partialHours}`, businessDate]
    );

    res.json({ message: 'Refund policy updated successfully' });
  } catch (error) {
    console.error('Error in updateRefundPolicy:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * POST /api/rooms/:number/refund-checkout
 * Processes a cancellation refund checkout.
 * Body: { refundAmount, reason }
 * - Adds a "Cancellation Refund" negative ledger entry
 * - Logs refund in cash_logs (negative payout)
 * - Marks booking Checked Out with payment_status = 'Refunded'
 * - Sets room to dirty
 * - Audit log: REFUND_CHECKOUT
 */
export const processRefundCheckout = async (req, res) => {
  const { number } = req.params;
  const { refundAmount, reason } = req.body;
  const idempotencyKey = req.body?.idempotencyKey || req.headers['idempotency-key'] || null;

  if (!number) {
    return res.status(400).json({ error: 'Room number is required' });
  }
  const parsedRefund = parseFloat(refundAmount);
  if (isNaN(parsedRefund) || parsedRefund < 0) {
    return res.status(400).json({ error: 'Refund amount must be a non-negative number' });
  }

  const resolvedUserId = req.user?.id || null;

  const mysqlHandler = async () => {
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      // Fetch room
      const [roomRows] = await connection.query(`
        SELECT r.*, rt.base_rate as rate, rt.code as type
        FROM rooms r
        JOIN room_types rt ON r.room_type_id = rt.id
        WHERE r.number = ?
        FOR UPDATE
      `, [number]);
      if (roomRows.length === 0) {
        const err = new Error(`Room ${number} not found`);
        err.status = 404;
        err.code = 'ROOM_NOT_FOUND';
        throw err;
      }
      const room = roomRows[0];
      if (room.status !== 'occupied') {
        const err = new Error(`Room ${number} is not currently occupied`);
        err.status = 400;
        err.code = 'ROOM_NOT_OCCUPIED';
        throw err;
      }

      // Fetch active booking
      const [bookingRows] = await connection.query(
        `SELECT b.*, g.full_name as guestName, g.user_id as guestUserId
         FROM bookings b
         JOIN guests g ON b.guest_id = g.id
         WHERE b.room_id = ? AND b.booking_status = 'Checked In'`,
        [room.id]
      );
      if (bookingRows.length === 0) {
        const err = new Error(`No active booking found for Room ${number}`);
        err.status = 404;
        err.code = 'BOOKING_NOT_FOUND';
        throw err;
      }
      const booking = bookingRows[0];

      // Fetch system date
      const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);
      const businessDate = settings[0]?.value_val || '18-Jul-2026';

      const timeStr = formatTime(new Date());
      const refundReason = (reason || 'Guest Cancellation').trim();

      // Post Cancellation Refund ledger entry (negative amount = credit to guest)
      if (parsedRefund > 0) {
        await connection.query(
          'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
          [number, `Cancellation Refund (${refundReason})`, -parsedRefund, businessDate, booking.id]
        );

        // Log refund payout in cash_logs (amount stored as positive, type indicates direction)
        await connection.query(
          `INSERT INTO cash_logs (time, room, guest, type, amount, business_date, booking_id)
           VALUES (?, ?, ?, 'Cancellation Refund', ?, ?, ?)`,
          [timeStr, number, booking.guestName, parsedRefund, businessDate, booking.id]
        );

        // Log in payments table as refund
        await connection.query(
          `INSERT INTO payments (booking_id, amount, payment_method, payment_type, business_date)
           VALUES (?, ?, 'Cash', 'Cancellation Refund', ?)`,
          [booking.id, -parsedRefund, businessDate]
        );
      }

      // Mark booking as Checked Out with Refunded status
      await connection.query(
        `UPDATE bookings SET booking_status = 'Checked Out', payment_status = 'Refunded', check_out_date = ? WHERE id = ?`,
        [businessDate, booking.id]
      );

      // Room status → dirty
      await connection.query(`UPDATE rooms SET status = 'dirty' WHERE id = ?`, [room.id]);

      // Room status history
      await connection.query(
        `INSERT INTO room_status_history (room_id, old_status, new_status, changed_by, business_date)
         VALUES (?, 'occupied', 'dirty', ?, ?)`,
        [room.id, resolvedUserId, businessDate]
      );

      // Audit log
      await connection.query(
        `INSERT INTO audit_logs (user_id, action, details, business_date)
         VALUES (?, 'REFUND_CHECKOUT', ?, ?)`,
        [resolvedUserId,
         `Refund checkout for Room ${number}. Guest: ${booking.guestName}. Refund: ₹${parsedRefund}. Reason: ${refundReason}. Booking ID: ${booking.id}`,
         businessDate]
      );

      // Increment today_checkouts
      await connection.query(
        `UPDATE system_settings SET value_val = CAST(CAST(value_val AS UNSIGNED) + 1 AS CHAR) WHERE key_name = 'today_checkouts'`
      );

      // Notify guest if they have a portal account
      if (booking.guestUserId) {
        await connection.query(
          `INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)`,
          [booking.guestUserId,
           '💰 Cancellation Processed',
           `Your cancellation for Room ${number} has been processed. A refund of ₹${parsedRefund} will be returned to you. Reason: ${refundReason}.`]
        );
      }

      await connection.commit();
      return { message: `Refund checkout processed for Room ${number}. Refund: ₹${parsedRefund}` };

    } catch (error) {
      if (connection) {
        try { await connection.rollback(); } catch (e) { console.error('Rollback error:', e); }
      }
      throw error;
    } finally {
      if (connection) connection.release();
    }
  };

  try {
    const businessDate = await BusinessDateService.getBusinessDate(pool);
    const result = await RefundCutoverService.processRefundCheckout(
      {
        number,
        refundAmount: parsedRefund,
        reason,
        resolvedUserId,
        businessDate,
        idempotencyKey
      },
      mysqlHandler
    );

    res.json({ message: result.message || `Refund checkout processed for Room ${number}. Refund: ₹${parsedRefund}` });
  } catch (error) {
    console.error('Error in processRefundCheckout:', error);
    res.status(error.status || 500).json({ error: error.message || 'Internal Server Error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// FRONT OFFICE — Admin-only operations (no guest-facing equivalent)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/rooms/:number/extend-stay  (requireAdmin)
 * Admin directly extends a checked-in guest's checkout date.
 * Body: { newCheckOutDate }
 * - Updates expected_check_out_date on the active booking
 * - Posts additional night tariff + tax ledger entries
 * - Audit log: ADMIN_EXTEND_STAY
 */
export const adminExtendStay = async (req, res) => {
  const { number } = req.params;
  const { newCheckOutDate } = req.body;
  if (!number) return res.status(400).json({ error: 'Room number is required' });
  if (!newCheckOutDate) return res.status(400).json({ error: 'newCheckOutDate is required' });

  const resolvedUserId = req.user?.id || null;

  try {
    const { getRoomByNumberFirestore } = await import('../repositories/firestore/roomsRepository.js');
    const { listDocs } = await import('../repositories/firestore/firestoreUtils.js');
    const { updateBookingFirestore } = await import('../repositories/firestore/bookingsRepository.js');
    const { createLedgerItemFirestore } = await import('../repositories/firestore/ledgerRepository.js');
    const { createAuditLogFirestore } = await import('../repositories/firestore/auditLogsRepository.js');
    const { FirestoreAvailabilityService } = await import('../services/firestoreAvailabilityService.js');

    const room = await getRoomByNumberFirestore(number);
    if (!room) {
      return res.status(404).json({ error: `Room ${number} not found` });
    }
    if (String(room.status || '').toLowerCase() !== 'occupied') {
      return res.status(400).json({ error: `Room ${number} is not occupied` });
    }

    const bookings = await listDocs('bookings', {
      filters: [
        { field: 'room_number', op: '==', value: String(number) },
        { field: 'booking_status', op: '==', value: 'Checked In' }
      ],
      limit: 1
    });

    if (!bookings || bookings.length === 0) {
      return res.status(404).json({ error: `No active booking for Room ${number}` });
    }
    const booking = bookings[0];

    const availResult = await FirestoreAvailabilityService.checkRoomAvailability(null, {
      roomId: room.id,
      roomNumber: number,
      arrivalDate: booking.expected_check_out_date,
      departureDate: newCheckOutDate
    });

    if (!availResult.available) {
      return res.status(400).json({ error: `Cannot extend stay: ${availResult.reason}` });
    }

    const businessDate = await BusinessDateService.getBusinessDate();

    // Extend booking checkout date
    await updateBookingFirestore(booking.id, {
      expected_check_out_date: newCheckOutDate,
      updated_at: new Date().toISOString()
    });

    const tariff = Number(booking.room_tariff || room.rate || room.base_rate || 1500);
    const extTimeOfEntry = (() => {
      const n = new Date();
      const h = n.getHours(), mi = n.getMinutes();
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12 = h % 12 === 0 ? 12 : h % 12;
      return `${String(h12).padStart(2,'0')}:${String(mi).padStart(2,'0')} ${ampm}`;
    })();

    await createLedgerItemFirestore({
      room_number: String(number),
      desc: 'Stay Extension — Additional Night Tariff (Incl. GST)',
      qty: 1,
      amount: tariff,
      business_date: businessDate,
      booking_id: String(booking.id),
      transaction_type: 'ROLLOVER',
      credit_amount: 0,
      time_of_entry: extTimeOfEntry,
      created_by: resolvedUserId || null
    });

    await createAuditLogFirestore({
      user_id: resolvedUserId,
      action: 'ADMIN_EXTEND_STAY',
      details: `Extended stay for Room ${number} (Booking ${booking.id}). New checkout: ${newCheckOutDate}`,
      business_date: businessDate
    });

    return res.json({ message: `Stay extended to ${newCheckOutDate} for Room ${number}` });
  } catch (error) {
    if (error.status === 400 || error.status === 404) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('adminExtendStay Firestore error, attempting MySQL fallback:', error);
    
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [roomRows] = await connection.query(`
        SELECT r.*, rt.base_rate as rate, rt.code as type
        FROM rooms r
        JOIN room_types rt ON r.room_type_id = rt.id
        WHERE r.number = ? FOR UPDATE
      `, [number]);
      if (roomRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: `Room ${number} not found` });
      }
      const room = roomRows[0];
      if (room.status !== 'occupied') {
        await connection.rollback();
        return res.status(400).json({ error: `Room ${number} is not occupied` });
      }

      const [bookingRows] = await connection.query(
        `SELECT b.*, g.full_name as guestName FROM bookings b
         JOIN guests g ON b.guest_id = g.id
         WHERE b.room_id = ? AND b.booking_status = 'Checked In'`,
        [room.id]
      );
      if (bookingRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: `No active booking for Room ${number}` });
      }
      const booking = bookingRows[0];

      const availResult = await FirestoreAvailabilityService.checkRoomAvailability(connection, {
        roomId: room.id,
        roomNumber: number,
        arrivalDate: booking.expected_check_out_date,
        departureDate: newCheckOutDate,
        forUpdate: true
      });
      if (!availResult.available) {
        await connection.rollback();
        return res.status(400).json({ error: `Cannot extend stay: ${availResult.reason}` });
      }

      await connection.query(
        `UPDATE bookings SET expected_check_out_date = ? WHERE id = ?`,
        [newCheckOutDate, booking.id]
      );

      const tariff = booking.room_tariff || room.rate;
      const extTimeOfEntry = (() => {
        const n = new Date();
        const h = n.getHours(), mi = n.getMinutes();
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 === 0 ? 12 : h % 12;
        return `${String(h12).padStart(2,'0')}:${String(mi).padStart(2,'0')} ${ampm}`;
      })();
      const businessDate = await BusinessDateService.getBusinessDate(connection);
      await connection.query(
        `INSERT INTO ledger_items (room_number, \`desc\`, qty, amount, business_date, booking_id,
          transaction_type, credit_amount, time_of_entry, created_by)
         VALUES (?, ?, 1, ?, ?, ?, 'ROLLOVER', 0, ?, ?)`,
        [number, `Stay Extension — Additional Night Tariff (Incl. GST)`, tariff, businessDate, booking.id, extTimeOfEntry, resolvedUserId || null]
      );

      await connection.query(
        `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'ADMIN_EXTEND_STAY', ?, ?)`,
        [resolvedUserId, `Extended stay for Room ${number} (Booking ${booking.id}). New checkout: ${newCheckOutDate}`, businessDate]
      );

      await connection.commit();
      res.json({ message: `Stay extended to ${newCheckOutDate} for Room ${number}` });
    } catch (mysqlErr) {
      if (connection) { try { await connection.rollback(); } catch (e) {} }
      console.error('adminExtendStay fallback error:', mysqlErr);
      res.status(500).json({ error: 'Internal Server Error' });
    } finally {
      if (connection) connection.release();
    }
  }
};

/**
 * POST /api/rooms/:number/late-checkout  (requireAdmin)
 * Marks an occupied room for late checkout and optionally posts a fee.
 * Body: { lateCheckoutTime, fee }
 * - Posts Late Checkout Fee ledger item (default ₹500)
 * - Audit log: LATE_CHECKOUT
 */
export const adminLateCheckout = async (req, res) => {
  const { number } = req.params;
  const { lateCheckoutTime, fee = 500 } = req.body;
  if (!number) return res.status(400).json({ error: 'Room number is required' });

  const resolvedUserId = req.user?.id || null;
  const parsedFee = parseInt(fee, 10);

  try {
    const { getRoomByNumberFirestore } = await import('../repositories/firestore/roomsRepository.js');
    const { listDocs } = await import('../repositories/firestore/firestoreUtils.js');
    const { createLedgerItemFirestore } = await import('../repositories/firestore/ledgerRepository.js');
    const { createAuditLogFirestore } = await import('../repositories/firestore/auditLogsRepository.js');

    const room = await getRoomByNumberFirestore(number);
    if (!room) {
      return res.status(404).json({ error: `Room ${number} not found` });
    }
    if (String(room.status || '').toLowerCase() !== 'occupied') {
      return res.status(400).json({ error: `Room ${number} is not occupied` });
    }

    const bookings = await listDocs('bookings', {
      filters: [
        { field: 'room_number', op: '==', value: String(number) },
        { field: 'booking_status', op: '==', value: 'Checked In' }
      ],
      limit: 1
    });

    if (!bookings || bookings.length === 0) {
      return res.status(404).json({ error: `No active booking for Room ${number}` });
    }
    const booking = bookings[0];

    const businessDate = await BusinessDateService.getBusinessDate();

    if (parsedFee > 0) {
      await createLedgerItemFirestore({
        room_number: String(number),
        desc: `Late Checkout Fee${lateCheckoutTime ? ` (Until ${lateCheckoutTime})` : ''}`,
        qty: 1,
        amount: parsedFee,
        business_date: businessDate,
        booking_id: String(booking.id),
        transaction_type: 'POSTING',
        created_by: resolvedUserId || null
      });
    }

    await createAuditLogFirestore({
      user_id: resolvedUserId,
      action: 'LATE_CHECKOUT',
      details: `Late checkout approved for Room ${number}. Time: ${lateCheckoutTime || 'TBD'}. Fee: ₹${parsedFee}. Booking: ${booking.id}`,
      business_date: businessDate
    });

    return res.json({ message: `Late checkout recorded for Room ${number}. Fee ₹${parsedFee} posted.` });
  } catch (error) {
    if (error.status === 400 || error.status === 404) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('adminLateCheckout Firestore error, attempting fallback:', error);

    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [roomRows] = await connection.query(`
        SELECT r.id, r.status FROM rooms r WHERE r.number = ? FOR UPDATE
      `, [number]);
      if (roomRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: `Room ${number} not found` });
      }
      const room = roomRows[0];
      if (room.status !== 'occupied') {
        await connection.rollback();
        return res.status(400).json({ error: `Room ${number} is not occupied` });
      }

      const [bookingRows] = await connection.query(
        `SELECT id FROM bookings WHERE room_id = ? AND booking_status = 'Checked In'`,
        [room.id]
      );
      if (bookingRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: `No active booking for Room ${number}` });
      }
      const bookingId = bookingRows[0].id;

      const businessDate = await BusinessDateService.getBusinessDate(connection);

      if (parsedFee > 0) {
        await connection.query(
          'INSERT INTO ledger_items (room_number, `desc`, qty, amount, business_date, booking_id) VALUES (?, ?, 1, ?, ?, ?)',
          [number, `Late Checkout Fee${lateCheckoutTime ? ` (Until ${lateCheckoutTime})` : ''}`, parsedFee, businessDate, bookingId]
        );
      }

      await connection.query(
        `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'LATE_CHECKOUT', ?, ?)`,
        [resolvedUserId, `Late checkout approved for Room ${number}. Time: ${lateCheckoutTime || 'TBD'}. Fee: ₹${parsedFee}. Booking: ${bookingId}`, businessDate]
      );

      await connection.commit();
      res.json({ message: `Late checkout recorded for Room ${number}. Fee ₹${parsedFee} posted.` });
    } catch (mysqlErr) {
      if (connection) { try { await connection.rollback(); } catch (e) {} }
      console.error('adminLateCheckout fallback error:', mysqlErr);
      res.status(500).json({ error: 'Internal Server Error' });
    } finally {
      if (connection) connection.release();
    }
  }
};

/**
 * POST /api/rooms/:number/no-show  (requireAdmin)
 * Marks a Reserved booking as No Show — frees the room back to vacant.
 * Body: { reason }
 * - booking_status → 'No Show'
 * - room.status → 'vacant'
 * - Deposit is forfeited (not refunded)
 * - Audit log: NO_SHOW
 */
export const adminNoShow = async (req, res) => {
  const { number } = req.params;
  const { reason } = req.body;

  if (!number) return res.status(400).json({ error: 'Room number is required' });

  const resolvedUserId = req.user?.id || null;

  try {
    const { getRoomByNumberFirestore, updateRoomFirestore } = await import('../repositories/firestore/roomsRepository.js');
    const { listDocs } = await import('../repositories/firestore/firestoreUtils.js');
    const { updateBookingFirestore } = await import('../repositories/firestore/bookingsRepository.js');
    const { createRoomStatusHistoryFirestore } = await import('../repositories/firestore/roomStatusHistoryRepository.js');
    const { createAuditLogFirestore } = await import('../repositories/firestore/auditLogsRepository.js');

    const room = await getRoomByNumberFirestore(number);
    if (!room) {
      return res.status(404).json({ error: `Room ${number} not found` });
    }
    if (String(room.status || '').toLowerCase() !== 'booked') {
      return res.status(400).json({ error: `Room ${number} does not have a Reserved booking` });
    }

    const bookings = await listDocs('bookings', {
      filters: [
        { field: 'room_number', op: '==', value: String(number) },
        { field: 'booking_status', op: '==', value: 'Reserved' }
      ],
      limit: 1
    });

    if (!bookings || bookings.length === 0) {
      return res.status(404).json({ error: `No Reserved booking found for Room ${number}` });
    }
    const booking = bookings[0];

    const businessDate = await BusinessDateService.getBusinessDate();

    // Mark booking as No Show
    await updateBookingFirestore(booking.id, {
      booking_status: 'No Show',
      check_out_date: businessDate,
      updated_at: new Date().toISOString()
    });

    // Free the room back to vacant
    await updateRoomFirestore(number, {
      status: 'vacant',
      current_booking_id: null,
      updated_at: new Date().toISOString()
    });

    try {
      await createRoomStatusHistoryFirestore({
        room_id: room.id || `room_${number}`,
        room_number: String(number),
        old_status: 'booked',
        new_status: 'vacant',
        changed_by: resolvedUserId,
        business_date: businessDate,
        created_at: new Date().toISOString()
      });

      await createAuditLogFirestore({
        user_id: resolvedUserId,
        action: 'NO_SHOW',
        details: `No Show marked for Room ${number}. Guest: ${booking.guest_name || booking.guestName || 'Guest'}. Reason: ${reason || 'Not provided'}. Booking ID: ${booking.id}. Deposit of ₹${booking.advance_amount || 0} forfeited.`,
        business_date: businessDate
      });
    } catch (_) {}

    return res.json({ message: `Room ${number} marked as No Show. Room is now vacant.` });
  } catch (error) {
    if (error.status === 400 || error.status === 404) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('adminNoShow Firestore error, attempting fallback:', error);

    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [roomRows] = await connection.query(`
        SELECT r.id, r.status FROM rooms r WHERE r.number = ? FOR UPDATE
      `, [number]);
      if (roomRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: `Room ${number} not found` });
      }
      const room = roomRows[0];
      if (room.status !== 'booked') {
        await connection.rollback();
        return res.status(400).json({ error: `Room ${number} does not have a Reserved booking` });
      }

      const [bookingRows] = await connection.query(
        `SELECT b.*, g.full_name as guestName FROM bookings b
         JOIN guests g ON b.guest_id = g.id
         WHERE b.room_id = ? AND b.booking_status = 'Reserved'`,
        [room.id]
      );
      if (bookingRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: `No Reserved booking found for Room ${number}` });
      }
      const booking = bookingRows[0];

      const businessDate = await BusinessDateService.getBusinessDate(connection);

      await connection.query(
        `UPDATE bookings SET booking_status = 'No Show', check_out_date = ? WHERE id = ?`,
        [businessDate, booking.id]
      );

      await connection.query(`UPDATE rooms SET status = 'vacant' WHERE id = ?`, [room.id]);

      await connection.query(
        `INSERT INTO room_status_history (room_id, old_status, new_status, changed_by, business_date)
         VALUES (?, 'booked', 'vacant', ?, ?)`,
        [room.id, resolvedUserId, businessDate]
      );

      await connection.query(
        `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'NO_SHOW', ?, ?)`,
        [resolvedUserId, `No Show marked for Room ${number}. Guest: ${booking.guestName}. Reason: ${reason || 'Not provided'}. Booking ID: ${booking.id}. Deposit of ₹${booking.advance_amount} forfeited.`, businessDate]
      );

      await connection.commit();
      res.json({ message: `Room ${number} marked as No Show. Room is now vacant.` });
    } catch (mysqlErr) {
      if (connection) { try { await connection.rollback(); } catch (e) {} }
      console.error('adminNoShow fallback error:', mysqlErr);
      res.status(500).json({ error: 'Internal Server Error' });
    } finally {
      if (connection) connection.release();
    }
  }
};

export const getPublicRooms = async (req, res) => {
  // Primary Firestore read path
  try {
    const { getAllRoomsFirestore } = await import('../repositories/firestore/roomsRepository.js');
    const { getAllRoomTypesFirestore } = await import('../repositories/firestore/roomTypesRepository.js');

    const [rooms, roomTypes] = await Promise.all([
      getAllRoomsFirestore(),
      getAllRoomTypesFirestore()
    ]);

    if (Array.isArray(roomTypes) && roomTypes.length > 0) {
      const formattedRooms = roomTypes.map(rt => {
        const typeCode = String(rt.code || rt.id || '').toUpperCase();
        const typeRooms = (rooms || []).filter(r => 
          String(r.type || r.room_type || '').toUpperCase() === typeCode ||
          String(r.room_type_id || '') === String(rt.id)
        );
        const availableCount = typeRooms.filter(r => String(r.status || '').toLowerCase() === 'vacant').length;

        return {
          id: rt.id,
          type: rt.code || rt.title || 'Standard',
          price: parseFloat(rt.base_rate || rt.price || 0),
          capacity: rt.capacity || 2,
          image: rt.image || 'https://images.unsplash.com/photo-1611892440504-42a792e24d32?auto=format&fit=crop&q=80&w=800',
          available: availableCount > 0
        };
      });

      return res.json(formattedRooms);
    }
  } catch (fsErr) {
    console.warn('[getPublicRooms] Firestore error, attempting fallback:', fsErr.message);
  }

  if (process.env.DISABLE_MYSQL_CUTOVER_FALLBACKS === 'true') {
    return res.status(500).json({ error: 'Failed to load public rooms from database.' });
  }

  // Fallback MySQL read path
  let connection;
  try {
    connection = await pool.getConnection();
    const [rooms] = await connection.query(`
      SELECT 
        rt.id as category_id,
        rt.code as category,
        rt.title,
        rt.description,
        rt.base_rate as price,
        rt.image,
        COUNT(r.id) as total_rooms,
        SUM(CASE WHEN r.status = 'VACANT' THEN 1 ELSE 0 END) as available_rooms
      FROM room_types rt
      JOIN rooms r ON r.room_type_id = rt.id
      GROUP BY rt.id
    `);

    const formattedRooms = rooms.map(r => ({
      id: r.category_id,
      type: r.category,
      price: parseFloat(r.price),
      capacity: r.capacity || 2,
      image: r.image || 'https://images.unsplash.com/photo-1611892440504-42a792e24d32?auto=format&fit=crop&q=80&w=800',
      available: r.available_rooms > 0
    }));

    res.json(formattedRooms);
  } catch (error) {
    console.error('Error fetching public rooms:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};

export const updateRoomStatus = async (req, res) => {
  const { number } = req.params;
  const { action } = req.body;

  const isStaff       = req.user?.type === 'staff';
  const resolvedUserId = isStaff ? null : (req.user?.id || null);

  if (!number || !action) return res.status(400).json({ error: 'Room number and action required' });

  try {
    const { getRoomByNumberFirestore, updateRoomFirestore } = await import('../repositories/firestore/roomsRepository.js');
    const room = await getRoomByNumberFirestore(number);
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const businessDate = await BusinessDateService.getBusinessDate();
    let performerName = req.user?.username || req.user?.fullName || 'System';

    let oldStatus   = room.status;
    let newStatus   = room.status;
    let oldHkStatus = room.housekeeping_status;
    let newHkStatus = room.housekeeping_status;
    let newIsActive = room.is_active !== undefined ? room.is_active : 1;
    let logDetail   = '';

    if (action === 'mark_dirty') {
      newHkStatus = 'Dirty';
      if (room.status === 'vacant') {
        newStatus = 'dirty';
      }
      logDetail = `Room ${number}: Housekeeping marked Dirty (occupancy: ${oldStatus} → ${newStatus}).`;
    } else if (action === 'mark_clean') {
      newHkStatus = 'Clean';
      if (room.status === 'dirty') {
        newStatus = 'vacant';
      }
      logDetail = `Room ${number}: Housekeeping marked Clean (occupancy: ${oldStatus} → ${newStatus}).`;
    } else if (action === 'mark_inactive') {
      if (room.status === 'occupied') {
        return res.status(400).json({ error: 'Occupied rooms cannot be marked inactive' });
      }
      newIsActive = 0;
      if (room.status === 'vacant' || room.status === 'dirty') {
        newStatus = 'inactive';
      }
      logDetail = `Room ${number}: Marked Inactive.`;
    } else if (action === 'mark_active') {
      newIsActive = 1;
      if (room.status === 'inactive') {
        newStatus = room.housekeeping_status === 'Dirty' ? 'dirty' : 'vacant';
      }
      logDetail = `Room ${number}: Marked Active.`;
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }

    await updateRoomFirestore(number, {
      is_active: newIsActive,
      status: newStatus,
      housekeeping_status: newHkStatus,
      cleaning_status: newHkStatus,
      updated_at: new Date().toISOString()
    });

    if (newStatus !== oldStatus || newHkStatus !== oldHkStatus) {
      try {
        if (newStatus !== oldStatus) {
          const { createRoomStatusHistoryFirestore } = await import('../repositories/firestore/roomStatusHistoryRepository.js');
          await createRoomStatusHistoryFirestore({
            room_id: room.id || `room_${number}`,
            room_number: String(number),
            old_status: oldStatus,
            new_status: newStatus,
            changed_by: resolvedUserId,
            business_date: businessDate,
            created_at: new Date().toISOString()
          });
        }

        const structuredDetails = JSON.stringify({
          Room:             number,
          Occupancy_Before: oldStatus,
          Occupancy_After:  newStatus,
          HK_Before:        oldHkStatus,
          HK_After:         newHkStatus,
          User:             performerName,
          Business_Date:    businessDate
        });
        const { createAuditLogFirestore } = await import('../repositories/firestore/auditLogsRepository.js');
        await createAuditLogFirestore({
          user_id: resolvedUserId,
          action: 'UPDATE_ROOM_STATUS',
          details: structuredDetails,
          business_date: businessDate
        });
      } catch (auditErr) {
        console.warn('[updateRoomStatus] Audit/history log non-fatal error:', auditErr.message);
      }
    }

    const { invalidateRoomStatusCache } = await import('../services/firestoreRoomStatusService.js');
    invalidateRoomStatusCache();

    const updatedRoomData = await getRoomByNumberFirestore(number);
    return res.json({
      success: true,
      message: logDetail,
      room: updatedRoomData
    });
  } catch (err) {
    if (err.status === 400 || err.status === 404) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('updateRoomStatus Firestore error, attempting MySQL fallback:', err);

    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      const [roomRows] = await connection.query('SELECT * FROM rooms WHERE number = ? FOR UPDATE', [number]);
      if (roomRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: 'Room not found' });
      }
      const room = roomRows[0];

      const businessDate = await BusinessDateService.getBusinessDate(connection);

      let performerName = 'System';
      if (resolvedUserId) {
        const [userRows] = await connection.query('SELECT fullName FROM users WHERE id = ?', [resolvedUserId]);
        if (userRows.length > 0) performerName = userRows[0].fullName;
      }

      let oldStatus   = room.status;
      let newStatus   = room.status;
      let oldHkStatus = room.housekeeping_status;
      let newHkStatus = room.housekeeping_status;
      let newIsActive = room.is_active !== undefined ? room.is_active : 1;
      let logDetail   = '';

      if (action === 'mark_dirty') {
        newHkStatus = 'Dirty';
        if (room.status === 'vacant') {
          newStatus = 'dirty';
        }
        logDetail = `Room ${number}: Housekeeping marked Dirty (occupancy: ${oldStatus} → ${newStatus}).`;
      } else if (action === 'mark_clean') {
        newHkStatus = 'Clean';
        if (room.status === 'dirty') {
          newStatus = 'vacant';
        }
        logDetail = `Room ${number}: Housekeeping marked Clean (occupancy: ${oldStatus} → ${newStatus}).`;
      } else if (action === 'mark_inactive') {
        if (room.status === 'occupied') {
          await connection.rollback();
          return res.status(400).json({ error: 'Occupied rooms cannot be marked inactive' });
        }
        newIsActive = 0;
        if (room.status === 'vacant' || room.status === 'dirty') {
          newStatus = 'inactive';
        }
        logDetail = `Room ${number}: Marked Inactive.`;
      } else if (action === 'mark_active') {
        newIsActive = 1;
        if (room.status === 'inactive') {
          newStatus = room.housekeeping_status === 'Dirty' ? 'dirty' : 'vacant';
        }
        logDetail = `Room ${number}: Marked Active.`;
      } else {
        await connection.rollback();
        return res.status(400).json({ error: 'Invalid action' });
      }

      await connection.query(
        'UPDATE rooms SET is_active = ?, status = ?, housekeeping_status = ? WHERE id = ?',
        [newIsActive, newStatus, newHkStatus, room.id]
      );

      if (newStatus !== oldStatus || newHkStatus !== oldHkStatus) {
        if (newStatus !== oldStatus) {
          await connection.query(
            'INSERT INTO room_status_history (room_id, old_status, new_status, changed_by, business_date) VALUES (?, ?, ?, ?, ?)',
            [room.id, oldStatus, newStatus, resolvedUserId, businessDate]
          );
        }

        const structuredDetails = JSON.stringify({
          Room:             number,
          Occupancy_Before: oldStatus,
          Occupancy_After:  newStatus,
          HK_Before:        oldHkStatus,
          HK_After:         newHkStatus,
          User:             performerName,
          Business_Date:    businessDate
        });
        await connection.query(
          'INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, ?, ?, ?)',
          [resolvedUserId, 'UPDATE_ROOM_STATUS', structuredDetails, businessDate]
        );
      }

      await connection.commit();
      res.json({ message: logDetail });
    } catch (mysqlErr) {
      if (connection) await connection.rollback();
      console.error('updateRoomStatus fallback error:', mysqlErr);
      res.status(500).json({ error: 'Internal Server Error' });
    } finally {
      if (connection) connection.release();
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
/**
 * GET /api/rooms/:number/ledger
 * Returns all ledger items for the active booking of an occupied room.
 * Computes running balance per row.
 * Controlled Cutover: Serves primary from Firestore when USE_FIRESTORE_LEDGER=true,
 * with automatic fallback to MySQL.
 * Accessible by Admin and Receptionist roles.
 */
export const getLedger = async (req, res) => {
  const { number } = req.params;
  if (!number) return res.status(400).json({ error: 'Room number is required' });

  try {
    const result = await LedgerCutoverService.getLedgerWithFallback(number);

    res.json({
      booking: result.booking,
      ledger: result.ledger,
      summary: result.summary
    });
  } catch (err) {
    console.error('getLedger error:', err);
    res.status(err.status || 500).json({
      error: err.message || 'Internal Server Error',
      code: err.code || undefined
    });
  }
};
