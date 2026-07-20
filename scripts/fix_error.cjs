const fs = require('fs');

const content = fs.readFileSync('backend/controllers/roomController.js', 'utf8');

const newContent = content.replace(
  "res.status(500).json({ error: 'Internal Server Error' });",
  "res.status(500).json({ error: error.message, stack: error.stack });"
);

fs.writeFileSync('backend/controllers/roomController.js', newContent);
console.log('Fixed error output');
