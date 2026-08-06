import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

/**
 * generateInvoicePDF
 * ------------------
 * Generates a hotel invoice PDF.
 *
 * The `room` object must contain:
 *   room.ledger        — array of ledger items {desc, qty, amount}
 *   room.deposit       — advance_amount paid at check-in
 *   room.balancePaid   — balance collected at desk during checkout (optional)
 *   room.booking_id    — DB booking ID
 *   room.booking_number — booking reference
 *   room.guestName, room.phone, room.number, room.type, room.rate
 *   room.checkInDate
 *
 * After Settle & Check Out:
 *   Balance Due = 0
 *   Status = PAID
 */
export const generateInvoicePDF = async (room, action = 'download') => {
  try {
    const token = localStorage.getItem('adminToken') || localStorage.getItem('token');
    
    // Fetch or reserve a sequential invoice number from the server
    const res = await fetch(`http://localhost:5000/api/invoices/generate/${room.booking_id}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      }
    });
    const data = await res.json();
    const invoiceNumber = data.invoiceNumber || `INV-TEMP-${Math.floor(Math.random() * 10000)}`;

    const doc = new jsPDF();

    // ── Branding ──────────────────────────────────────────────────────────────
    const hotelName = 'HOTEL SKY-5';
    const address   = '123 Sky Avenue, Cloud City, 456789';
    const email     = 'contact@hotelsky5.com';
    const phone     = '+91 9876543210';

    const primaryColor = [15, 23, 42];   // Slate 900
    const accentColor  = [59, 130, 246]; // Blue 500
    const greenColor   = [22, 163, 74];  // Green 600

    // ── Header ────────────────────────────────────────────────────────────────
    doc.setFillColor(...primaryColor);
    doc.rect(0, 0, 210, 42, 'F');

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(22);
    doc.setFont('helvetica', 'bold');
    doc.text(hotelName, 15, 20);

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(`${address}  |  ${phone}  |  ${email}`, 15, 29);

    // INVOICE title (right)
    doc.setFontSize(26);
    doc.setFont('helvetica', 'bold');
    doc.text('INVOICE', 195, 22, { align: 'right' });

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(`Date: ${new Date().toLocaleDateString('en-IN')}`, 195, 32, { align: 'right' });

    // ── PAID badge (top-right corner) ─────────────────────────────────────────
    doc.setFillColor(...greenColor);
    doc.roundedRect(148, 36, 47, 11, 2, 2, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('✔  PAID IN FULL', 171.5, 43.5, { align: 'center' });

    // ── Invoice Meta ──────────────────────────────────────────────────────────
    doc.setTextColor(51, 65, 85);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text(`Invoice No: ${invoiceNumber}`, 15, 57);
    doc.text(`Booking Ref: ${room.booking_number || room.booking_id || 'N/A'}`, 130, 57);

    doc.setDrawColor(203, 213, 225);
    doc.line(15, 62, 195, 62);

    // ── Guest & Stay Details ──────────────────────────────────────────────────
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text('Bill To:', 15, 72);
    doc.setFont('helvetica', 'normal');
    doc.text(`Guest Name : ${room.guestName || 'N/A'}`, 15, 79);
    doc.text(`Contact    : ${room.phone || 'N/A'}`, 15, 86);

    doc.setFont('helvetica', 'bold');
    doc.text('Stay Details:', 130, 72);
    doc.setFont('helvetica', 'normal');
    doc.text(`Room     : ${room.number} (${room.type || 'Standard'})`, 130, 79);
    doc.text(`Check-In : ${room.checkInDate || 'N/A'}`, 130, 86);
    doc.text(`Check-Out: ${new Date().toLocaleDateString('en-IN')}`, 130, 93);

    // Calculate nights stayed
    let nights = 1;
    if (room.checkInDate) {
      try {
        // Parse PMS date format dd-Mon-yyyy
        const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
        const parts = room.checkInDate.split('-');
        const ci = (parts.length === 3 && months[parts[1]] !== undefined)
          ? new Date(Date.UTC(+parts[2], months[parts[1]], +parts[0]))
          : new Date(room.checkInDate);
        const diff = Math.ceil((new Date() - ci) / (1000 * 60 * 60 * 24));
        if (diff > 0) nights = diff;
      } catch (e) { /* ignore */ }
    }
    doc.text(`Nights   : ${nights}`, 130, 100);

    // ── Billing Table ─────────────────────────────────────────────────────────
    // Filter out any legacy "Taxes & GST" rows — GST is included in tariff
    const visibleLedger = (room.ledger || []).filter(item => {
      const d = (item.desc || '').toLowerCase();
      return !d.includes('taxes & gst') && !d.includes('tax & gst') && !d.includes('gst (5%)');
    });

    const tableData = [];
    let grandTotal = 0;

    visibleLedger.forEach((item, index) => {
      const qty    = item.qty || 1;
      const amount = Number(item.amount) || 0;
      const unit   = amount / qty;
      tableData.push([
        index + 1,
        item.desc || 'Service Charge',
        qty,
        `Rs. ${unit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
        `Rs. ${amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
      ]);
      grandTotal += amount;
    });

    autoTable(doc, {
      startY: 110,
      head: [['#', 'Description', 'Qty', 'Unit Price', 'Amount']],
      body: tableData,
      theme: 'grid',
      headStyles: { fillColor: accentColor, textColor: [255, 255, 255], fontStyle: 'bold' },
      styles: { fontSize: 9, cellPadding: 5 },
      columnStyles: {
        0: { cellWidth: 13, halign: 'center' },
        2: { cellWidth: 18, halign: 'center' },
        3: { cellWidth: 38, halign: 'right' },
        4: { cellWidth: 38, halign: 'right' }
      }
    });

    const finalY = doc.lastAutoTable.finalY || 110;

    // ── Totals Summary ────────────────────────────────────────────────────────
    const advancePaid  = Number(room.deposit) || 0;
    // balancePaidAtDesk = grandTotal − advancePaid (what was collected at checkout desk)
    const balanceAtDesk = Math.max(0, grandTotal - advancePaid);
    const totalAmountPaid = advancePaid + balanceAtDesk; // == grandTotal

    const summaryX = 120;
    let sy = finalY + 14;

    const summaryRow = (label, value, bold = false, color = null) => {
      if (color) doc.setTextColor(...color);
      else doc.setTextColor(51, 65, 85);
      doc.setFont('helvetica', bold ? 'bold' : 'normal');
      doc.setFontSize(bold ? 11 : 9.5);
      doc.text(label, summaryX, sy);
      doc.text(`Rs. ${value.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, 195, sy, { align: 'right' });
      sy += 8;
    };

    // Grand Total header
    doc.setDrawColor(203, 213, 225);
    doc.line(summaryX, sy - 4, 195, sy - 4);
    summaryRow('Grand Total (GST Inclusive):', grandTotal, true);

    doc.line(summaryX, sy - 4, 195, sy - 4);

    // Advance Paid at Check-In
    doc.setTextColor(51, 65, 85);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.text('Advance Paid at Check-In:', summaryX, sy);
    doc.setTextColor(...greenColor);
    doc.text(`- Rs. ${advancePaid.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, 195, sy, { align: 'right' });
    doc.setTextColor(51, 65, 85);
    sy += 8;

    // Balance Paid at Checkout Desk
    doc.setFont('helvetica', 'normal');
    doc.text('Balance Paid at Desk:', summaryX, sy);
    doc.setTextColor(...greenColor);
    doc.text(`- Rs. ${balanceAtDesk.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, 195, sy, { align: 'right' });
    doc.setTextColor(51, 65, 85);
    sy += 8;

    // Total Amount Paid
    doc.setFont('helvetica', 'bold');
    doc.text('Total Amount Paid:', summaryX, sy);
    doc.setTextColor(...greenColor);
    doc.text(`Rs. ${totalAmountPaid.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, 195, sy, { align: 'right' });
    sy += 10;

    // BALANCE DUE = 0 (always after successful checkout)
    doc.setDrawColor(...greenColor);
    doc.line(summaryX, sy - 4, 195, sy - 4);
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...primaryColor);
    doc.text('Balance Due:', summaryX, sy + 2);
    doc.setTextColor(...greenColor);
    doc.text('Rs. 0.00', 195, sy + 2, { align: 'right' });
    doc.line(summaryX, sy + 6, 195, sy + 6);

    // ── Payment Note ──────────────────────────────────────────────────────────
    sy += 16;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(100, 116, 139);
    doc.text('* All room tariffs are GST inclusive. No additional taxes apply.', 15, sy);

    // ── Footer ────────────────────────────────────────────────────────────────
    const pageH = doc.internal.pageSize.height;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text('Thank you for your stay at Hotel Sky-5!', 105, pageH - 28, { align: 'center' });
    doc.setFontSize(7.5);
    doc.text('This is a computer-generated invoice and does not require a signature.', 105, pageH - 20, { align: 'center' });

    // ── Output ────────────────────────────────────────────────────────────────
    if (action === 'print') {
      doc.autoPrint();
      window.open(doc.output('bloburl'), '_blank');
    } else {
      doc.save(`Invoice_${invoiceNumber}.pdf`);
    }

    return true;
  } catch (error) {
    console.error('Error generating PDF:', error);
    alert('Failed to generate PDF Invoice: ' + error.message);
    return false;
  }
};
