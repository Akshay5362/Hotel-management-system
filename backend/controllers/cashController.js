import pool from '../db.js';

// ── Helper: format current time ─────────────────────────────────────────────
function formatTime(date) {
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

// ── Helper: generate receipt ID ─────────────────────────────────────────────
// Format: CS-YYYYMMDD-NNNN (e.g. CS-20260722-0001)
async function generateReceiptId(businessDate, connection) {
  // Derive YYYYMMDD from business date string (e.g. "22-Jul-2026" → "20260722")
  const parsed = new Date(businessDate);
  const datePart = isNaN(parsed.getTime())
    ? businessDate.replace(/-/g, '').replace(/[A-Za-z]/g, '').slice(0, 8)
    : parsed.toISOString().slice(0, 10).replace(/-/g, '');

  const [rows] = await connection.query(
    `SELECT COUNT(*) as cnt FROM cash_submissions WHERE business_date = ?`,
    [businessDate]
  );
  const seq = (rows[0].cnt + 1).toString().padStart(4, '0');
  return `CS-${datePart}-${seq}`;
}

// ── POST /api/cash/submit ────────────────────────────────────────────────────
export const submitCash = async (req, res) => {
  const { amount, receivedBy, shift, name, notes } = req.body;

  // Use the receptionist-entered name if provided; fall back to token name
  const receptionistName =
    (name || '').trim() ||
    req.user?.fullName ||
    req.user?.full_name ||
    req.user?.username ||
    'Receptionist';

  // Validation — only amount is required; receivedBy and shift are optional
  if (!amount || isNaN(amount) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Invalid amount. Must be a positive number.' });
  }

  const parsedAmount    = Math.round(Number(amount));
  const receiverName    = (receivedBy || '').trim() || 'N/A';
  const shiftLabel      = (shift || '').trim() || 'General';
  const combinedRemarks = [
    shiftLabel !== 'General' ? `Shift: ${shiftLabel}` : '',
    notes ? notes.trim() : ''
  ].filter(Boolean).join(' | ') || null;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Get current business date
    const [settingsRows] = await connection.query(
      `SELECT value_val FROM system_settings WHERE key_name = 'system_date'`
    );
    const businessDate = settingsRows[0]?.value_val ||
      new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');

    // Calculate cash in hand (advances + settlements - refunds - already submitted)
    const [cashLogRows] = await connection.query(
      `SELECT type, amount FROM cash_logs WHERE business_date = ?`, [businessDate]
    );
    const [submittedRows] = await connection.query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM cash_submissions WHERE business_date = ?`, [businessDate]
    );

    let advances = 0, settlements = 0, refunds = 0;
    for (const row of cashLogRows) {
      if (row.type === 'Advance Deposit') advances += Number(row.amount);
      else if (row.type === 'Checkout Settlement') settlements += Number(row.amount);
      else if (row.type.toLowerCase().includes('refund')) refunds += Number(row.amount);
    }
    const alreadySubmitted = Number(submittedRows[0].total);
    const cashInHand       = advances + settlements - refunds - alreadySubmitted;

    if (parsedAmount > cashInHand) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({
        error: `Cannot submit ₹${parsedAmount.toLocaleString('en-IN')}. Cash in hand is only ₹${cashInHand.toLocaleString('en-IN')}.`
      });
    }

    const remainingCash = cashInHand - parsedAmount;
    const receiptId     = await generateReceiptId(businessDate, connection);
    const submittedAt   = new Date();

    // Insert cash submission record
    const [insertResult] = await connection.query(
      `INSERT INTO cash_submissions
         (receipt_id, business_date, submitted_at, receptionist_name, receiver_name, amount, remaining_cash, remarks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [receiptId, businessDate, submittedAt, receptionistName, receiverName, parsedAmount, remainingCash, combinedRemarks]
    );

    // Structured audit log
    const structuredDetails = JSON.stringify({
      Receipt:      receiptId,
      Amount:       `₹${parsedAmount}`,
      Receptionist: receptionistName,
      Shift:        shiftLabel,
      Received_By:  receiverName,
      Business_Date: businessDate
    });
    await connection.query(
      `INSERT INTO audit_logs (user_id, action, details, business_date) VALUES (?, 'CASH_HANDOVER', ?, ?)`,
      [req.user?.type === 'staff' ? null : (req.user?.id || null), structuredDetails, businessDate]
    );

    await connection.commit();
    connection.release();

    return res.json({
      success: true,
      message: `₹${parsedAmount.toLocaleString('en-IN')} submitted successfully.`,
      submission: {
        id:               insertResult.insertId,
        receipt_id:       receiptId,
        business_date:    businessDate,
        submitted_at:     submittedAt.toISOString(),
        receptionist_name: receptionistName,
        receiver_name:    receiverName,
        shift:            shiftLabel,
        amount:           parsedAmount,
        remaining_cash:   remainingCash,
        remarks:          combinedRemarks,
        time:             formatTime(submittedAt),
      }
    });
  } catch (error) {
    try { await connection.rollback(); } catch (e) {}
    connection.release();
    console.error('submitCash error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ── GET /api/cash/submissions ────────────────────────────────────────────────
export const getCashSubmissions = async (req, res) => {
  try {
    const [settingsRows] = await pool.query(
      `SELECT value_val FROM system_settings WHERE key_name = 'system_date'`
    );
    const businessDate = settingsRows[0]?.value_val;

    const [rows] = await pool.query(
      `SELECT * FROM cash_submissions WHERE business_date = ? ORDER BY submitted_at ASC`,
      [businessDate]
    );

    return res.json({ submissions: rows });
  } catch (error) {
    console.error('getCashSubmissions error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};
