const fs = require('fs');

const content = fs.readFileSync('backend/controllers/roomController.js', 'utf8');

// Replace the buggy dynamic import with the existing 'pool'
const newContent = content.replace(
  "connection = await (await import('../db.js')).default.getConnection();",
  "connection = await pool.getConnection();"
);

fs.writeFileSync('backend/controllers/roomController.js', newContent);
console.log('Fixed getPublicRooms');
