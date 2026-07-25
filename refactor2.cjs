const fs = require('fs');
let content = fs.readFileSync('backend/controllers/roomController.js', 'utf8');

const checkInStart = content.indexOf('export const guestRequestCheckIn = async (req, res) => {');
const checkOutStart = content.indexOf('export const guestAddService = async (req, res) => {');

const newCheckIn = 'export const guestRequestCheckIn = async (req, res) => {\n' +
'  const resolvedUserId = req.user?.id;\n' +
'  if (!resolvedUserId) return res.status(401).json({ error: "Unauthorized" });\n' +
'  let connection;\n' +
'  try {\n' +
'    connection = await pool.getConnection();\n' +
'    await connection.beginTransaction();\n' +
'    const [guestRows] = await connection.query("SELECT id FROM guests WHERE user_id = ?", [resolvedUserId]);\n' +
'    if (guestRows.length === 0) {\n' +
'      await connection.rollback();\n' +
'      return res.status(404).json({ error: "Guest profile not found" });\n' +
'    }\n' +
'    const guestId = guestRows[0].id;\n' +
'    const [bookingRows] = await connection.query(\n' +
'      SELECT b.*, r.number as room_number FROM bookings b\n' +
'       JOIN rooms r ON b.room_id = r.id\n' +
'       WHERE b.guest_id = ? AND b.booking_status = \\\'Reserved\\\'\n' +
'       ORDER BY b.id DESC LIMIT 1,\n' +
'      [guestId]\n' +
'    );\n' +
'    if (bookingRows.length === 0) {\n' +
'      await connection.rollback();\n' +
'      return res.status(404).json({ error: "No upcoming reservation found" });\n' +
'    }\n' +
'    const booking = bookingRows[0];\n' +
'    const [pendingPayment] = await connection.query(\n' +
'      SELECT id, amount FROM payments WHERE booking_id = ? AND payment_method = \\\'Cash\\\' AND payment_status = \\\'Pending\\\' LIMIT 1,\n' +
'      [booking.id]\n' +
'    );\n' +
'    if (pendingPayment.length > 0) {\n' +
'      await connection.rollback();\n' +
'      return res.status(403).json({\n' +
'        error: "Cash payment not yet confirmed.",\n' +
'        message: Your advance cash payment of ? has not been confirmed. Please visit the front desk.,\n' +
'        code: "CASH_PAYMENT_PENDING"\n' +
'      });\n' +
'    }\n' +
'    await processCheckIn(connection, {\n' +
'      roomNumber: booking.room_number,\n' +
'      guestId: guestId,\n' +
'      resolvedUserId,\n' +
'      isGuestSelfCheckIn: true\n' +
'    });\n' +
'    await connection.commit();\n' +
'    res.json({ message: Successfully checked in to Room , roomNumber: booking.room_number });\n' +
'  } catch (error) {\n' +
'    if (connection) { try { await connection.rollback(); } catch (e) {} }\n' +
'    console.error("guestRequestCheckIn error:", error);\n' +
'    res.status(error.status || 500).json({ error: error.message || "Internal Server Error" });\n' +
'  } finally {\n' +
'    if (connection) connection.release();\n' +
'  }\n' +
'};\n\n';

content = content.substring(0, checkInStart) + newCheckIn + content.substring(checkOutStart);

fs.writeFileSync('backend/controllers/roomController.js', content);
