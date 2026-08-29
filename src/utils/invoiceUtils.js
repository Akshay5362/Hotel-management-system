import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { API_URL, getApiHeaders } from '../config/apiConfig';

/**
 * Formats a currency number with Indian number formatting and 2 decimal places.
 */
function formatCurrency(val) {
  const num = Number(val) || 0;
  return num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Format a Date object or string to DD-Mon-YY format (e.g. 17-Aug-26).
 */
function formatBillDate(dateInput) {
  if (!dateInput) return '';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return String(dateInput);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dd = String(d.getDate()).padStart(2, '0');
  const mon = months[d.getMonth()];
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}-${mon}-${yy}`;
}

/**
 * Format a Date object or string to 12-hour time string (e.g. 10:19:59 AM).
 */
function formatBillTime(dateInput) {
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

/**
 * generateInvoicePDF / generateMasterBillPDF
 * -------------------------------------------
 * Generates an information-complete, pixel-perfect Master Bill PDF matching
 * the Hotel SKY-5 Master Bill specification.
 *
 * @param {Object} roomOrBill - Room object or full Master Bill payload
 * @param {string} action - 'download' | 'print' | 'blob'
 * @returns {Promise<boolean>} Success status
 */
export const generateInvoicePDF = async (roomOrBill, action = 'download') => {
  try {
    const token = localStorage.getItem('adminToken') || localStorage.getItem('token');
    const bookingId = roomOrBill.current_booking_id || roomOrBill.booking_id || roomOrBill.bookingId || roomOrBill.booking?.id || roomOrBill.booking_number || roomOrBill.number || roomOrBill.id;

    let billData = roomOrBill.settlement ? roomOrBill : null;

    // ── 1. Fetch Authoritative Master Bill Data from Server ────────────────────
    if (bookingId) {
      try {
        const res = await fetch(`${API_URL}/invoices/master-bill/${bookingId}`, {
          headers: getApiHeaders(token, { 'Content-Type': 'application/json' })
        });
        if (res.ok) {
          billData = await res.json();
        }
      } catch (err) {
        console.warn('[generateInvoicePDF] Server fetch failed, using local room data:', err.message);
      }
    }

    // ── 2. Fallback Construction from Local Room Object ───────────────────────
    if (!billData) {
      const hotel = {
        name: 'HOTEL SKY-5',
        address: 'DISHA ARCADE, I.T PARK ROAD, SECTOR 4, MDC, PANCHKULA-134114',
        phone: '+91 8146470934',
        mobile: '+91 8146470934',
        email: 'Hotelsky71@gmail.com',
        gstin: '06AANFH0310B1Z5',
        state: 'Haryana',
        stateCode: '06',
        hotelRegNo: '9610'
      };

      const invoiceNum = roomOrBill.invoice_number || `INV-${new Date().getFullYear()}-${String(bookingId || 101).padStart(6, '0')}`;
      const invDate = formatBillDate(new Date());

      const guest = {
        name: roomOrBill.guestName || roomOrBill.guest_name || 'Walk In Guest',
        phone: roomOrBill.phone || roomOrBill.mobile || '',
        email: roomOrBill.email || '',
        address: roomOrBill.address || 'Chandigarh',
        state: roomOrBill.state || 'Chandigarh',
        gstin: roomOrBill.guest_gstin || ''
      };

      const stay = {
        arrivalDate: formatBillDate(roomOrBill.checkInDate || roomOrBill.check_in_date || new Date()),
        arrivalTime: formatBillTime(roomOrBill.checkInTime || new Date()),
        departureDate: formatBillDate(roomOrBill.checkOutDate || roomOrBill.check_out_date || new Date()),
        departureTime: formatBillTime(new Date()),
        roomNo: String(roomOrBill.number || roomOrBill.room_number || '108'),
        roomType: roomOrBill.type || roomOrBill.room_type || 'Deluxe Double',
        paxAdult: 2,
        paxChildren: 0,
        days: 1,
        plan: 'Room Only'
      };

      const rawLedger = roomOrBill.ledger || [];
      const lineItems = [];
      let runningBalance = 0;
      let totalCharges = 0;
      let totalCredits = 0;

      rawLedger.forEach((item) => {
        const amt = Number(item.amount) || 0;
        runningBalance += amt;
        totalCharges += amt;
        lineItems.push({
          date: formatBillDate(item.business_date || stay.arrivalDate),
          particulars: (item.desc || item.description || 'ROOM CHARGE').toUpperCase(),
          reference: item.ref || (item.id ? `REF-${item.id}` : ''),
          charges: amt,
          credit: 0,
          balance: runningBalance
        });
      });

      const deposit = Number(roomOrBill.deposit || roomOrBill.advance_amount || 0);
      if (deposit > 0) {
        runningBalance -= deposit;
        totalCredits += deposit;
        lineItems.push({
          date: stay.arrivalDate,
          particulars: 'ADVANCE DEPOSIT',
          reference: `ADV-${bookingId || '101'}`,
          charges: 0,
          credit: deposit,
          balance: runningBalance
        });
      }

      const balancePaid = Number(roomOrBill.balancePaid || 0);
      if (balancePaid > 0) {
        runningBalance -= balancePaid;
        totalCredits += balancePaid;
        lineItems.push({
          date: stay.departureDate,
          particulars: 'PAYMENT AT CHECKOUT (CASH/CARD)',
          reference: `PAY-${Date.now().toString().slice(-6)}`,
          charges: 0,
          credit: balancePaid,
          balance: runningBalance
        });
      }

      const outstandingBalance = Math.max(0, totalCharges - totalCredits);

      billData = {
        title: 'MASTER BILL',
        hotel,
        invoice: {
          invoiceNumber: invoiceNum,
          billNo: invoiceNum,
          invoiceDate: invDate,
          registrationNo: String(bookingId || '9615'),
          hotelRegNo: '9610',
          status: outstandingBalance === 0 ? 'Paid' : 'Issued'
        },
        guest,
        stay,
        lineItems,
        settlement: {
          subtotal: totalCharges,
          taxableAmount: Number((totalCharges / 1.05).toFixed(2)),
          cgst: Number(((totalCharges - totalCharges / 1.05) / 2).toFixed(2)),
          sgst: Number(((totalCharges - totalCharges / 1.05) / 2).toFixed(2)),
          igst: 0.00,
          discount: 0.00,
          grossTotal: totalCharges,
          advanceReceived: deposit,
          paymentsReceived: balancePaid,
          totalCredits,
          outstandingBalance,
          refundDue: totalCredits > totalCharges ? totalCredits - totalCharges : 0,
          netPayable: outstandingBalance,
          paymentStatus: outstandingBalance === 0 ? 'PAID IN FULL' : 'BALANCE DUE'
        },
        paymentDetails: [
          ...(deposit > 0 ? [{ date: stay.arrivalDate, mode: 'CASH / ONLINE', amount: deposit, reference: `ADV-${bookingId || '101'}` }] : []),
          ...(balancePaid > 0 ? [{ date: stay.departureDate, mode: 'DESK SETTLEMENT', amount: balancePaid, reference: `PAY-CHECKOUT` }] : [])
        ],
        termsAndConditions: '1. Standard check-in time is 12:00 PM and check-out time is 11:00 AM.\n2. Valid government photo ID is mandatory at the time of check-in.\n3. Outside food and beverages are not allowed inside hotel premises.'
      };
    }

    const { hotel, invoice, guest, stay, lineItems, settlement, paymentDetails, termsAndConditions } = billData;

    // ── 3. Initialize jsPDF Document (A4 Portrait) ───────────────────────────
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4'
    });

    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 14;
    const contentWidth = pageWidth - margin * 2; // 182mm

    // Color Palette
    const slateDark = [15, 23, 42];
    const slateText = [51, 65, 85];
    const slateMuted = [100, 116, 139];
    const borderGray = [203, 213, 225];
    const greenAccent = [22, 163, 74];
    const redAccent = [220, 38, 38];

    // ── 4. HOTEL IDENTITY HEADER ─────────────────────────────────────────────
    let y = 14;

    // Top Hotel Name (Centered & Bold)
    doc.setTextColor(...slateDark);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text(hotel.name, pageWidth / 2, y, { align: 'center' });

    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...slateText);
    doc.text(hotel.address, pageWidth / 2, y, { align: 'center' });

    y += 4.5;
    const contactLine = `Mobile: ${hotel.mobile || hotel.phone}  |  Email: ${hotel.email}  |  GSTIN: ${hotel.gstin}`;
    doc.text(contactLine, pageWidth / 2, y, { align: 'center' });

    y += 3.5;
    doc.setDrawColor(...borderGray);
    doc.setLineWidth(0.3);
    doc.line(margin, y, pageWidth - margin, y);

    // ── 5. BILL TITLE & STATUS BADGE ─────────────────────────────────────────
    y += 6;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...slateDark);
    doc.text('MASTER BILL', pageWidth / 2, y, { align: 'center' });

    // Status Badge on Right
    const isPaid = settlement?.paymentStatus === 'PAID IN FULL' || invoice?.status === 'Paid';
    const badgeText = isPaid ? '✔  PAID IN FULL' : '⚠  BALANCE DUE';
    const badgeColor = isPaid ? greenAccent : redAccent;

    doc.setFillColor(...badgeColor);
    doc.roundedRect(pageWidth - margin - 38, y - 4.5, 38, 6.5, 1, 1, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text(badgeText, pageWidth - margin - 19, y - 0.3, { align: 'center' });

    // ── 6. GUEST & INVOICE / STAY INFORMATION BOX ────────────────────────────
    y += 4;
    const boxStartY = y;
    const boxHeight = 44;
    const colWidth = (contentWidth - 4) / 2; // ~89mm each
    const rightColX = margin + colWidth + 4;

    // Draw background and borders for info boxes
    doc.setFillColor(248, 250, 252); // Slate 50
    doc.roundedRect(margin, boxStartY, colWidth, boxHeight, 1.5, 1.5, 'FD');
    doc.roundedRect(rightColX, boxStartY, colWidth, boxHeight, 1.5, 1.5, 'FD');

    // --- Left Column: Guest Information ---
    let ly = boxStartY + 5;
    const labelX = margin + 3;
    const valX = margin + 28;

    const printInfoRow = (lbl, val, curY, targetValX = valX) => {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.8);
      doc.setTextColor(...slateMuted);
      doc.text(lbl, labelX, curY);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...slateDark);
      doc.text(`:  ${val || '—'}`, targetValX, curY);
    };

    printInfoRow('Booking ID', invoice.registrationNo ? `Walk In (${invoice.registrationNo})` : 'Walk In Guest', ly);
    ly += 5;
    printInfoRow('Guest Name', guest.name.toUpperCase(), ly);
    ly += 5;
    printInfoRow('Address', (guest.address || 'Chandigarh').slice(0, 32), ly);
    ly += 5;
    printInfoRow('State', guest.state || 'Chandigarh', ly);
    ly += 5;
    printInfoRow('Contact No.', guest.phone || '—', ly);
    ly += 5;
    printInfoRow('GSTIN', guest.gstin || '—', ly);
    ly += 5;
    printInfoRow('ID / Reg No', guest.governmentId || invoice.registrationNo || '—', ly);

    // --- Right Column: Invoice & Stay Information ---
    let ry = boxStartY + 5;
    const rLabelX = rightColX + 3;
    const rValX = rightColX + 26;

    const printRightRow = (lbl, val, curY, targetValX = rValX) => {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.8);
      doc.setTextColor(...slateMuted);
      doc.text(lbl, rLabelX, curY);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...slateDark);
      doc.text(`:  ${val || '—'}`, targetValX, curY);
    };

    printRightRow('Invoice Date', invoice.invoiceDate || formatBillDate(new Date()), ry);
    ry += 5;
    printRightRow('Bill No', invoice.billNo || invoice.invoiceNumber || '—', ry);
    ry += 5;
    printRightRow('Reg / Hotel No', `${invoice.registrationNo || '9615'} / ${hotel.hotelRegNo || '9610'}`, ry);
    ry += 5;
    printRightRow('Room / Type', `Room ${stay.roomNo} (${stay.roomType})`, ry);
    ry += 5;
    printRightRow('Pax (Ad / Ch)', `${stay.paxAdult} Adult(s) / ${stay.paxChildren} Child`, ry);
    ry += 5;
    printRightRow('Arrival', `${stay.arrivalDate} ${stay.arrivalTime}`, ry);
    ry += 5;
    printRightRow('Departure', `${stay.departureDate} ${stay.departureTime}`, ry);

    y = boxStartY + boxHeight + 4;

    // ── 7. MASTER BILL LINE-ITEM TABLE (AutoTable) ───────────────────────────
    const tableColumns = [
      { header: 'Date', dataKey: 'date' },
      { header: 'Particulars', dataKey: 'particulars' },
      { header: 'Reference', dataKey: 'reference' },
      { header: 'Charges (₹)', dataKey: 'charges' },
      { header: 'Credit (₹)', dataKey: 'credit' },
      { header: 'Balance (₹)', dataKey: 'balance' }
    ];

    const tableRows = (lineItems || []).map(item => ({
      date: item.date || '—',
      particulars: item.particulars || 'SERVICE CHARGE',
      reference: item.reference || '—',
      charges: item.charges > 0 ? formatCurrency(item.charges) : '—',
      credit: item.credit > 0 ? formatCurrency(item.credit) : '—',
      balance: formatCurrency(item.balance)
    }));

    autoTable(doc, {
      startY: y,
      head: [tableColumns.map(c => c.header)],
      body: tableRows.map(r => [r.date, r.particulars, r.reference, r.charges, r.credit, r.balance]),
      theme: 'grid',
      margin: { left: margin, right: margin, bottom: 28 },
      headStyles: {
        fillColor: slateDark,
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 8,
        halign: 'center'
      },
      bodyStyles: {
        fontSize: 7.8,
        textColor: slateDark,
        cellPadding: 2.5
      },
      columnStyles: {
        0: { cellWidth: 22, halign: 'center' },
        1: { cellWidth: 56, halign: 'left' },
        2: { cellWidth: 36, halign: 'left' },
        3: { cellWidth: 22, halign: 'right' },
        4: { cellWidth: 22, halign: 'right' },
        5: { cellWidth: 24, halign: 'right', fontStyle: 'bold' }
      },
      didDrawPage: (data) => {
        // Repeat Header Note on subsequent pages
        const pageNumber = doc.internal.getCurrentPageInfo().pageNumber;
        if (pageNumber > 1) {
          doc.setFontSize(7.5);
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(...slateMuted);
          doc.text(`${hotel.name} — MASTER BILL (${invoice.billNo})`, margin, 10);
        }
      }
    });

    let currentY = doc.lastAutoTable.finalY + 5;

    // Check if we have enough room for Settlement Box & Footer (need ~55mm)
    if (currentY > pageHeight - 65) {
      doc.addPage();
      currentY = 18;
    }

    // ── 8. SETTLEMENT & TAX SUMMARY BOX ──────────────────────────────────────
    const summaryBoxWidth = 86;
    const summaryBoxX = pageWidth - margin - summaryBoxWidth;
    const summaryStartY = currentY;

    // Draw Totals Box
    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(...borderGray);
    doc.roundedRect(summaryBoxX, summaryStartY, summaryBoxWidth, 42, 1.5, 1.5, 'FD');

    let sy = summaryStartY + 4.5;
    const sLabelX = summaryBoxX + 4;
    const sValX = summaryBoxX + summaryBoxWidth - 4;

    const printSummaryRow = (lbl, val, isBold = false, isHighlight = false, color = slateDark) => {
      doc.setFont('helvetica', isBold ? 'bold' : 'normal');
      doc.setFontSize(isHighlight ? 9.5 : 7.8);
      doc.setTextColor(...(isHighlight ? slateDark : slateMuted));
      doc.text(lbl, sLabelX, sy);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...color);
      doc.text(val, sValX, sy, { align: 'right' });
      sy += isHighlight ? 6 : 4.5;
    };

    printSummaryRow('Sub Total (Gross Charges)', `Rs. ${formatCurrency(settlement.subtotal)}`);
    printSummaryRow('Taxable Amount', `Rs. ${formatCurrency(settlement.taxableAmount)}`);
    printSummaryRow('CGST (2.5%)', `Rs. ${formatCurrency(settlement.cgst)}`);
    printSummaryRow('SGST (2.5%)', `Rs. ${formatCurrency(settlement.sgst)}`);
    printSummaryRow('Total Credits / Advance', `- Rs. ${formatCurrency(settlement.totalCredits)}`, false, false, greenAccent);

    doc.setDrawColor(...borderGray);
    doc.line(sLabelX, sy - 2, sValX, sy - 2);

    const netAmountStr = `Rs. ${formatCurrency(settlement.outstandingBalance)}`;
    printSummaryRow('BALANCE DUE / NET PAYABLE', netAmountStr, true, true, isPaid ? greenAccent : redAccent);

    // --- Left Box: Payment Details Breakdown ---
    const payBoxWidth = contentWidth - summaryBoxWidth - 4;
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(margin, summaryStartY, payBoxWidth, 42, 1.5, 1.5, 'D');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...slateDark);
    doc.text('PAYMENT DETAILS', margin + 3, summaryStartY + 4.5);

    let py = summaryStartY + 9;
    if (paymentDetails && paymentDetails.length > 0) {
      paymentDetails.slice(0, 3).forEach((p) => {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(...slateText);
        doc.text(`• ${p.date} - ${p.mode}: Rs. ${formatCurrency(p.amount)} (${p.reference || 'REF'})`, margin + 3, py);
        py += 4.5;
      });
    } else {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(7.5);
      doc.setTextColor(...slateMuted);
      doc.text('No payment records logged.', margin + 3, py);
      py += 4.5;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...slateMuted);
    doc.text('TERMS & CONDITIONS:', margin + 3, py + 2);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.text('1. Check-in 12:00 PM / Check-out 11:00 AM. 2. Disputes subject to local jurisdiction.', margin + 3, py + 6);

    // ── 9. FOOTER & AUTHORIZED SIGNATORY ──────────────────────────────────────
    const totalPages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);
      const footerY = pageHeight - 12;

      doc.setDrawColor(...borderGray);
      doc.line(margin, footerY - 4, pageWidth - margin, footerY - 4);

      // Thank you message
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(...slateDark);
      doc.text('Thank you for staying with us at HOTEL SKY-5!', margin, footerY);

      // Computer generated notice
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(...slateMuted);
      doc.text('This is a computer-generated invoice and requires no physical signature.', margin, footerY + 3.5);

      // Authorized Signatory
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(...slateDark);
      doc.text('Authorized Signatory', pageWidth - margin - 35, footerY);

      // Page numbering
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(...slateMuted);
      doc.text(`Page ${i} of ${totalPages}`, pageWidth / 2, footerY + 3.5, { align: 'center' });
    }

    // ── 10. Output Execution ──────────────────────────────────────────────────
    if (action === 'print') {
      doc.autoPrint();
      window.open(doc.output('bloburl'), '_blank');
    } else if (action === 'blob') {
      return doc.output('blob');
    } else {
      doc.save(`Master_Bill_${invoice.billNo || '12531'}.pdf`);
    }

    return true;
  } catch (error) {
    console.error('Error generating Master Bill PDF:', error);
    alert('Failed to generate Master Bill PDF: ' + error.message);
    return false;
  }
};
