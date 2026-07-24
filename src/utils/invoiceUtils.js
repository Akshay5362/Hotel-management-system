import { API_BASE_URL } from '../config/apiConfig';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export const generateInvoicePDF = async (room, action = 'download') => {
  try {
    const token = localStorage.getItem('adminToken') || localStorage.getItem('token');
    // Fetch unique sequential invoice number
    const res = await fetch(`${API_BASE_URL}/api/invoices/generate/${room.booking_id}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      }
    });
    
    if (!res.ok) {
      console.error('Failed to generate invoice number from server');
    }
    const data = await res.json();
    const invoiceNumber = data.invoiceNumber || `INV-TEMP-${Math.floor(Math.random() * 10000)}`;

    const doc = new jsPDF();
    
    // Configuration & Branding
    const hotelName = 'HOTEL SKY-5'; // Could be dynamic from settings
    const address = '123 Sky Avenue, Cloud City, 456789';
    const email = 'contact@hotelsky5.com';
    const phone = '+91 9876543210';
    
    const primaryColor = [15, 23, 42]; // Slate 900
    const accentColor = [59, 130, 246]; // Blue 500

    // Header Background
    doc.setFillColor(...primaryColor);
    doc.rect(0, 0, 210, 40, 'F');

    // Header Text
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(24);
    doc.setFont('helvetica', 'bold');
    doc.text(hotelName, 15, 20);
    
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`${address} | ${phone} | ${email}`, 15, 30);

    // Invoice Label
    doc.setFontSize(28);
    doc.setFont('helvetica', 'bold');
    doc.text('INVOICE', 195, 25, { align: 'right' });
    
    doc.setFontSize(10);
    doc.text(`Date: ${new Date().toLocaleDateString()}`, 195, 33, { align: 'right' });

    // Reset Text Color
    doc.setTextColor(51, 65, 85);

    // Invoice Meta
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text(`Invoice No: ${invoiceNumber}`, 15, 55);
    doc.text(`Booking ID: ${room.booking_number || room.booking_id}`, 130, 55);

    // Separator line
    doc.setDrawColor(203, 213, 225);
    doc.line(15, 60, 195, 60);

    // Guest & Stay Details
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text('Bill To:', 15, 70);
    doc.setFont('helvetica', 'normal');
    doc.text(`Guest Name: ${room.guestName || 'N/A'}`, 15, 76);
    doc.text(`Contact: ${room.phone || 'N/A'}`, 15, 82);
    
    doc.setFont('helvetica', 'bold');
    doc.text('Stay Details:', 130, 70);
    doc.setFont('helvetica', 'normal');
    doc.text(`Room: ${room.number} (${room.type})`, 130, 76);
    doc.text(`Check-In: ${room.checkInDate || 'N/A'}`, 130, 82);
    // Assuming checkout is today/now if generating at checkout
    doc.text(`Check-Out: ${new Date().toLocaleDateString()}`, 130, 88);

    // Calculate nights
    let nights = 1;
    if (room.checkInDate) {
      try {
        const ci = new Date(room.checkInDate);
        const today = new Date();
        const diff = Math.ceil((today - ci) / (1000 * 60 * 60 * 24));
        if (diff > 0) nights = diff;
      } catch (e) {
        // ignore
      }
    }
    doc.text(`Nights: ${nights}`, 130, 94);

    // Billing Table
    const tableData = [];
    let subtotal = 0;
    
    // Add ledger items
    if (room.ledger && room.ledger.length > 0) {
      room.ledger.forEach((item, index) => {
        tableData.push([
          index + 1,
          item.desc || 'Service Charge',
          item.qty || 1,
          `Rs. ${(item.amount / (item.qty || 1)).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
          `Rs. ${item.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
        ]);
        subtotal += item.amount;
      });
    }

    autoTable(doc, {
      startY: 110,
      head: [['#', 'Description', 'Qty', 'Unit Price', 'Amount']],
      body: tableData,
      theme: 'grid',
      headStyles: { fillColor: accentColor, textColor: [255, 255, 255], fontStyle: 'bold' },
      styles: { fontSize: 10, cellPadding: 6 },
      columnStyles: {
        0: { cellWidth: 15, halign: 'center' },
        2: { cellWidth: 20, halign: 'center' },
        3: { cellWidth: 35, halign: 'right' },
        4: { cellWidth: 35, halign: 'right' }
      }
    });

    const finalY = doc.lastAutoTable.finalY || 110;
    const deposit = room.deposit || 0;
    const balance = subtotal - deposit;

    // Totals Section
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    
    const summaryX = 130;
    let currentY = finalY + 15;
    
    doc.text('Subtotal:', summaryX, currentY);
    doc.text(`Rs. ${subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, 195, currentY, { align: 'right' });
    currentY += 8;

    doc.text('Advance Paid:', summaryX, currentY);
    doc.setFont('helvetica', 'normal');
    doc.text(`- Rs. ${deposit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, 195, currentY, { align: 'right' });
    currentY += 8;

    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...primaryColor);
    
    doc.setDrawColor(203, 213, 225);
    doc.line(summaryX, currentY - 5, 195, currentY - 5);
    
    const balanceText = balance >= 0 ? 'Balance Due:' : 'Refund Amount:';
    doc.text(balanceText, summaryX, currentY + 2);
    doc.text(`Rs. ${Math.abs(balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, 195, currentY + 2, { align: 'right' });
    
    doc.line(summaryX, currentY + 6, 195, currentY + 6);

    // Footer
    const pageHeight = doc.internal.pageSize.height;
    
    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139);
    doc.setFont('helvetica', 'normal');
    doc.text('Thank you for your stay!', 105, pageHeight - 30, { align: 'center' });
    doc.setFontSize(8);
    doc.text('This is a computer generated invoice and does not require a signature.', 105, pageHeight - 20, { align: 'center' });

    // Action execution
    if (action === 'print') {
      doc.autoPrint();
      window.open(doc.output('bloburl'), '_blank');
    } else {
      doc.save(`Invoice_${invoiceNumber}.pdf`);
    }

    return true;
  } catch (error) {
    console.error('Error generating PDF:', error);
    alert('Failed to generate PDF Invoice');
    return false;
  }
};
