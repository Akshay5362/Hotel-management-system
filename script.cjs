const fs = require('fs');
let content = fs.readFileSync('backend/controllers/roomController.js', 'utf8');

const t1 = "    const room = roomRows[0];\n    if (room.status !== 'vacant' && room.status !== 'booked') {\n      await connection.rollback();\n      return res.status(400).json({ error: \\Room \ is not vacant or booked\\ });\n    }";

const r1 = "    const room = roomRows[0];\n\n    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);\n    const businessDate = settings[0]?.value_val || new Date().toISOString().split('T')[0];\n\n    const computedRoomStatus = await RoomStatusService.getRoomStatus(connection, room.id, businessDate);\n    const { manual_override } = req.body;\n\n    if (!computedRoomStatus) {\n      await connection.rollback();\n      return res.status(404).json({ error: \\Room \ status could not be computed\\ });\n    }\n\n    if (computedRoomStatus.status === 'occupied') {\n      await connection.rollback();\n      return res.status(400).json({ error: \\Room \ is already occupied.\\ });\n    }\n\n    if (computedRoomStatus.status === 'booked' && !manual_override) {\n      await connection.rollback();\n      return res.status(400).json({\n        error: \\Room \ is reserved for today. Please confirm you want to check-in over this reservation.\\,\n        code: 'ROOM_BOOKED'\n      });\n    }";

content = content.replace(t1, r1);

const t2 = "    const guestNameUpper = guestName.trim().toUpperCase();\n    const [settings] = await connection.query('SELECT value_val FROM system_settings WHERE key_name = ?', ['system_date']);\n    const businessDate = settings[0]?.value_val || '11-Jul-2026';";

const r2 = "    const guestNameUpper = guestName.trim().toUpperCase();";

content = content.replace(t2, r2);

const importSearch = "import pool from '../db.js';";
const importReplace = "import pool from '../db.js';\nimport { RoomStatusService } from '../services/roomStatusService.js';";
content = content.replace(importSearch, importReplace);

fs.writeFileSync('backend/controllers/roomController.js', content);
console.log('Success');
