const fs = require('fs');
let content = fs.readFileSync('backend/controllers/roomController.js', 'utf8');

if (!content.includes('processCheckIn')) {
  content = "import { processCheckIn } from '../services/checkInService.js';\n" + content;
}

const checkInStart = content.indexOf('export const checkIn = async (req, res) => {');
const checkOutStart = content.indexOf('export const checkOut = async (req, res) => {');

const newCheckIn = 'export const checkIn = async (req, res) => {\n' +
'  const { number } = req.params;\n' +
'  const { guestName, phone, pax, deposit, checkInDate, manual_override, paymentMethod, transactionId } = req.body;\n' +
'  // Input Validation\n' +
'  if (!number || typeof number !== "string" || number.trim() === "") return res.status(400).json({ error: "Room number is required" });\n' +
'  if (!guestName || typeof guestName !== "string" || guestName.trim() === "") return res.status(400).json({ error: "Guest name is required" });\n' +
'  const parsedPax = parseInt(pax, 10);\n' +
'  if (isNaN(parsedPax) || parsedPax <= 0) return res.status(400).json({ error: "Pax must be a positive integer" });\n' +
'  const parsedDeposit = parseInt(deposit, 10);\n' +
'  if (isNaN(parsedDeposit) || parsedDeposit < 0) return res.status(400).json({ error: "Deposit must be a non-negative integer" });\n' +
'  const resolvedUserId = req.user?.type === "staff" ? null : (req.user?.id || null);\n' +
'  let connection;\n' +
'  try {\n' +
'    connection = await pool.getConnection();\n' +
'    await connection.beginTransaction();\n' +
'    const { bookingId } = await processCheckIn(connection, {\n' +
'      roomNumber: number,\n' +
'      guestName,\n' +
'      phone,\n' +
'      pax: parsedPax,\n' +
'      deposit: parsedDeposit,\n' +
'      paymentMethod,\n' +
'      transactionId,\n' +
'      manualOverride: manual_override,\n' +
'      checkInDate,\n' +
'      resolvedUserId,\n' +
'      isGuestSelfCheckIn: false\n' +
'    });\n' +
'    await connection.commit();\n' +
'    res.json({ message: Successfully checked in to Room , bookingId });\n' +
'  } catch (error) {\n' +
'    if (connection) { try { await connection.rollback(); } catch (e) {} }\n' +
'    console.error("Error during checkin controller:", error);\n' +
'    res.status(error.status || 500).json({ error: error.message || "Internal Server Error", code: error.code });\n' +
'  } finally {\n' +
'    if (connection) connection.release();\n' +
'  }\n' +
'};\n\n';

content = content.substring(0, checkInStart) + newCheckIn + content.substring(checkOutStart);

fs.writeFileSync('backend/controllers/roomController.js', content);
