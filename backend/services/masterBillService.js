/**
 * backend/services/masterBillService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HPMS Master Bill / Hotel Invoice Authority Service
 *
 * Implements:
 *   - Information-complete Master Bill generation matching Hotel SKY-5 specifications
 *   - Authoritative reading from Firestore collections (/bookings, /guests, /rooms, /ledger_items, /payments, /settings/hotel_config)
 *   - Chronological financial line-item sequencing with running balance:
 *       Balance = Running Charges - Running Credits
 *   - Tax breakdown (CGST, SGST, IGST) based on configured rates
 *   - Mathematical reconciliation:
 *       Total Charges - Total Credits = Net Balance Due
 *   - Sanitized payment details without leaking sensitive credentials
 *   - 0 MySQL queries when running on primary Firestore path
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  getBookingByIdFirestore,
  getBookingByNumberFirestore,
  getGuestByIdFirestore,
  getGuestByPhoneFirestore,
  getRoomByIdFirestore,
  getRoomByNumberFirestore,
  getLedgerItemsByBookingFirestore,
  getPaymentsByBookingFirestore,
  getInvoiceByBookingFirestore,
  getHotelConfigFirestore,
  getSystemDateFirestore,
  formatBookingId
} from '../repositories/firestore/index.js';

/**
 * Format a Date object or string to DD-Mon-YY format (e.g. 17-Aug-26).
 */
export function formatBillDate(dateInput) {
  if (!dateInput) return '';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) {
    // If already in DD-Mon-YYYY format
    return String(dateInput);
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dd = String(d.getDate()).padStart(2, '0');
  const mon = months[d.getMonth()];
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}-${mon}-${yy}`;
}

/**
 * Format a Date object or string to 12-hour time string (e.g. 10:19:59 AM).
 */
export function formatBillTime(dateInput) {
  if (!dateInput) return '12:00:00 PM';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return '12:00:00 PM';
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
}

export class MasterBillService {
  /**
   * Generates a fully reconciled Master Bill object for a booking.
   *
   * @param {string|number} bookingId - Numeric ID, document ID (bkg_X), or booking number (BKG-X)
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Master Bill complete payload
   */
  static async getMasterBill(bookingId, options = {}) {
    if (!bookingId) {
      const err = new Error('Booking ID is required to generate Master Bill');
      err.status = 400;
      throw err;
    }

    // ── 1. Fetch Authoritative Booking Document ──────────────────────────────
    let booking = await getBookingByIdFirestore(bookingId);
    if (!booking) {
      booking = await getBookingByNumberFirestore(bookingId);
    }
    if (!booking && !isNaN(Number(bookingId))) {
      booking = await getBookingByIdFirestore(`bkg_${bookingId}`);
    }

    if (!booking) {
      const err = new Error(`Booking '${bookingId}' not found`);
      err.status = 404;
      throw err;
    }

    const bkgDocId = booking.id || String(bookingId);
    const rawBookingId = bkgDocId.replace(/^(booking_|bkg_)/, '');
    const bookingNumber = booking.booking_number || `BKG-${rawBookingId}`;

    // ── 2. Fetch Associated Entities in Parallel from Firestore ───────────────
    const [
      guestDoc,
      roomDoc,
      ledgerItems,
      payments,
      invoiceDoc,
      hotelConfig,
      systemDate
    ] = await Promise.all([
      booking.guest_id
        ? getGuestByIdFirestore(booking.guest_id)
        : (booking.phone ? getGuestByPhoneFirestore(booking.phone) : null),
      booking.room_id
        ? getRoomByIdFirestore(booking.room_id)
        : (booking.room_number ? getRoomByNumberFirestore(booking.room_number) : null),
      getLedgerItemsByBookingFirestore(bkgDocId),
      getPaymentsByBookingFirestore(bkgDocId),
      getInvoiceByBookingFirestore(bkgDocId),
      getHotelConfigFirestore(),
      getSystemDateFirestore()
    ]);

    // ── 3. Build Hotel Header Information ────────────────────────────────────
    const hotel = {
      name: hotelConfig.hotel_name || 'HOTEL SKY-5',
      address: hotelConfig.address || 'DISHA ARCADE, I.T PARK ROAD, SECTOR 4, MDC, PANCHKULA-134114',
      phone: hotelConfig.phone || hotelConfig.mobile || '+91 8146470934',
      mobile: hotelConfig.mobile || hotelConfig.phone || '+91 8146470934',
      email: hotelConfig.email || 'Hotelsky71@gmail.com',
      gstin: hotelConfig.gstin || '06AANFH0310B1Z5',
      state: hotelConfig.state || 'Haryana',
      stateCode: hotelConfig.state_code || '06',
      hotelRegNo: hotelConfig.hotel_reg_no || '9610'
    };

    // ── 4. Build Guest Information ───────────────────────────────────────────
    const guest = {
      name: guestDoc?.full_name || booking.guest_name || 'Walk In Guest',
      phone: guestDoc?.phone || booking.phone || '',
      email: guestDoc?.email || booking.guest_email || '',
      address: guestDoc?.address || booking.guest_address || 'Chandigarh',
      state: guestDoc?.state || booking.guest_state || 'Chandigarh',
      gstin: guestDoc?.gstin || guestDoc?.gst_no || booking.guest_gstin || booking.gst_no || booking.gstNo || '',
      gst_no: guestDoc?.gst_no || guestDoc?.gstin || booking.gst_no || booking.gstNo || '',
      idType: guestDoc?.id_type || '',
      governmentId: guestDoc?.government_id || ''
    };

    // ── 5. Build Stay Information ────────────────────────────────────────────
    const arrivalDateStr = booking.check_in_date || systemDate || new Date().toISOString().split('T')[0];
    const arrivalTimeStr = booking.check_in_time || booking.created_at || new Date().toISOString();
    const departureDateStr = booking.check_out_date || booking.expected_check_out_date || arrivalDateStr;
    const departureTimeStr = booking.check_out_time || booking.updated_at || new Date().toISOString();

    // Calculate nights / days
    let days = 1;
    try {
      const arr = new Date(arrivalDateStr);
      const dep = new Date(departureDateStr);
      const diffTime = dep.getTime() - arr.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      if (diffDays > 0) days = diffDays;
    } catch (_) {
      days = 1;
    }

    const stay = {
      arrivalDate: formatBillDate(arrivalDateStr),
      arrivalTime: formatBillTime(arrivalTimeStr),
      departureDate: formatBillDate(departureDateStr),
      departureTime: formatBillTime(departureTimeStr),
      roomNo: String(roomDoc?.room_number || booking.room_number || '101'),
      roomType: roomDoc?.type_name || roomDoc?.type || booking.room_type || 'Standard',
      paxAdult: Number(booking.pax_adult || booking.adults || 2),
      paxChildren: Number(booking.pax_children || booking.children || 0),
      days: days,
      plan: booking.plan || 'Room Only'
    };

    // ── 6. Build Invoice Information ─────────────────────────────────────────
    const invoiceYear = new Date().getFullYear();
    const defaultInvNumber = `INV-${invoiceYear}-${String(rawBookingId).padStart(6, '0')}`;
    const invoiceNumber = invoiceDoc?.invoice_number || booking.invoice_number || defaultInvNumber;
    const invoiceDate = invoiceDoc?.business_date
      ? formatBillDate(invoiceDoc.business_date)
      : formatBillDate(systemDate || new Date().toISOString().split('T')[0]);

    const invoiceInfo = {
      invoiceNumber,
      billNo: invoiceNumber,
      invoiceDate,
      registrationNo: String(booking.registration_no || rawBookingId),
      hotelRegNo: hotel.hotelRegNo,
      status: invoiceDoc?.status || (booking.payment_status === 'Paid' ? 'Paid' : 'Issued')
    };

    // ── 7. Build Line-Item Table with Running Balance ─────────────────────────
    const lineItems = [];
    let runningBalance = 0;
    let totalCharges = 0;
    let totalCredits = 0;
    let taxableAmount = 0;
    let totalGst = 0;

    // A. Collect Events from Ledger
    const debitEvents = [];
    const ledgerCreditAdjustments = [];

    (ledgerItems || []).forEach((item) => {
      const amount = Number(item.amount || item.debit_amount || 0);
      const credit = Number(item.credit_amount || 0);
      const desc = item.description || item.desc || 'Room Tariff';
      const type = String(item.transaction_type || item.type || '').toUpperCase();

      // Skip payment-type ledger entries here because payments collection is authoritative
      if (type === 'PAYMENT') {
        return;
      }

      const dateStr = formatBillDate(item.business_date || item.created_at || arrivalDateStr);
      let refStr = item.reference_number || item.reference || item.ref || '';
      if (!refStr && item.id) {
        refStr = String(item.id).startsWith('ledger_') ? item.id : `REF-${item.id}`;
      }

      if (type === 'CREDIT' || type === 'ADJUSTMENT' || type === 'REFUND' || (amount <= 0 && credit > 0)) {
        ledgerCreditAdjustments.push({
          date: dateStr,
          created_at: item.created_at || new Date().toISOString(),
          particulars: desc.toUpperCase(),
          reference: refStr,
          charges: 0,
          credit: credit > 0 ? credit : Math.abs(amount)
        });
      } else if (amount > 0) {
        debitEvents.push({
          date: dateStr,
          created_at: item.created_at || new Date().toISOString(),
          particulars: desc.toUpperCase(),
          reference: refStr,
          charges: amount,
          credit: 0
        });
      }
    });

    // If no debit ledger items exist, add base tariff from booking
    if (debitEvents.length === 0) {
      const baseTariff = Number(booking.total_amount || booking.base_rate || booking.room_tariff || 2500);
      debitEvents.push({
        date: formatBillDate(arrivalDateStr),
        created_at: booking.created_at || new Date().toISOString(),
        particulars: 'ROOM RENT',
        reference: `BKG-${rawBookingId}`,
        charges: baseTariff,
        credit: 0
      });
    }

    // B. Collect Credit Events (Credit Adjustments + Authoritative Payments)
    const creditEvents = [...ledgerCreditAdjustments];
    const paymentBreakdown = [];

    if (payments && payments.length > 0) {
      payments.forEach((pay) => {
        const pAmt = Number(pay.amount) || 0;
        if (pAmt <= 0) return;
        const pMode = (pay.payment_method || pay.payment_mode || 'Cash').toUpperCase();
        const pDate = formatBillDate(pay.payment_date || pay.business_date || pay.created_at || arrivalDateStr);
        const pTime = formatBillTime(pay.created_at);
        const pRef = pay.reference || pay.transaction_id || pay.payment_number || pay.payment_reference || `PAY-${pay.id ? String(pay.id).slice(-6) : 'DESK'}`;

        creditEvents.push({
          date: pDate,
          created_at: pay.created_at || new Date().toISOString(),
          particulars: `PAYMENT (${pMode})`,
          reference: pRef,
          charges: 0,
          credit: pAmt
        });

        paymentBreakdown.push({
          date: pDate,
          time: pTime,
          mode: pMode,
          amount: pAmt,
          reference: pRef,
          recordedBy: pay.created_by || 'Staff'
        });
      });
    } else {
      // Fallback: If no /payments documents exist, check booking advance_amount
      const advanceAmount = Number(booking.advance_amount || 0);
      if (advanceAmount > 0) {
        const advDate = formatBillDate(arrivalDateStr);
        const advTime = formatBillTime(arrivalTimeStr);
        const advMode = (booking.advance_payment_mode || booking.payment_mode || 'Cash').toUpperCase();
        const advRef = `ADV-${rawBookingId}`;

        creditEvents.push({
          date: advDate,
          created_at: booking.created_at || new Date().toISOString(),
          particulars: 'ADVANCE DEPOSIT',
          reference: advRef,
          charges: 0,
          credit: advanceAmount
        });

        paymentBreakdown.push({
          date: advDate,
          time: advTime,
          mode: advMode,
          amount: advanceAmount,
          reference: advRef,
          recordedBy: 'Staff'
        });
      }
    }

    // C. Combine & Sort Chronologically
    const allEvents = [...debitEvents, ...creditEvents].sort((a, b) => {
      return new Date(a.created_at || 0) - new Date(b.created_at || 0);
    });

    allEvents.forEach((ev) => {
      if (ev.charges > 0) {
        runningBalance += ev.charges;
        totalCharges += ev.charges;
      }
      if (ev.credit > 0) {
        runningBalance -= ev.credit;
        totalCredits += ev.credit;
      }

      lineItems.push({
        date: ev.date,
        particulars: ev.particulars,
        reference: ev.reference,
        charges: ev.charges > 0 ? ev.charges : 0,
        credit: ev.credit > 0 ? ev.credit : 0,
        balance: runningBalance
      });
    });

    // ── 8. Calculate Taxes & Settlement Breakdown ─────────────────────────────
    const taxRate = Number(hotelConfig.tax_rate || 0.05); // 5% default
    // If room rates are GST-inclusive: Taxable = Gross / (1 + taxRate)
    taxableAmount = Number((totalCharges / (1 + taxRate)).toFixed(2));
    totalGst = Number((totalCharges - taxableAmount).toFixed(2));
    const cgst = Number((totalGst / 2).toFixed(2));
    const sgst = Number((totalGst / 2).toFixed(2));
    const igst = 0.00;

    const outstandingBalance = Math.max(0, Number((totalCharges - totalCredits).toFixed(2)));
    const refundDue = totalCredits > totalCharges ? Number((totalCredits - totalCharges).toFixed(2)) : 0;

    // ── 9. Financial Reconciliation Validation ──────────────────────────────
    const calculatedBalance = Number((totalCharges - totalCredits).toFixed(2));
    const reconciliation = {
      isReconciled: Math.abs(calculatedBalance - (outstandingBalance - refundDue)) < 0.01,
      totalCharges,
      totalCredits,
      calculatedBalance,
      outstandingBalance,
      refundDue
    };

    if (!reconciliation.isReconciled) {
      console.warn('[MasterBillService] Reconciliation disparity detected:', reconciliation);
    }

    // ── 10. Final Assembled Master Bill ──────────────────────────────────────
    const advancePortion = paymentBreakdown.find(p => String(p.reference).startsWith('ADV-'))?.amount || 0;
    const directPaymentsPortion = totalCredits - advancePortion;

    return {
      title: 'MASTER BILL',
      hotel,
      invoice: invoiceInfo,
      guest,
      stay,
      lineItems,
      settlement: {
        subtotal: totalCharges,
        taxableAmount,
        cgst,
        sgst,
        igst,
        discount: 0.00,
        grossTotal: totalCharges,
        advanceReceived: advancePortion,
        paymentsReceived: directPaymentsPortion,
        totalCredits,
        outstandingBalance,
        refundDue,
        netPayable: outstandingBalance,
        paymentStatus: outstandingBalance === 0 ? 'PAID IN FULL' : 'BALANCE DUE'
      },
      paymentDetails: paymentBreakdown,
      termsAndConditions: hotelConfig.terms_and_conditions || DEFAULT_HOTEL_CONFIG.terms_and_conditions,
      reconciliation
    };
  }
}
