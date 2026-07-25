const fs = require('fs');

const targetStr = "const systemDate = settingsMap['system_date'];";
const replaceStr = "const systemDate = settingsMap['system_date'];\n    if (!systemDate) {\n      console.error('[CRITICAL] system_settings.system_date is missing from database.');\n      return res.status(500).json({ error: 'System configuration error: Business Date is missing. Please contact administrator.' });\n    }";

let content = fs.readFileSync('backend/controllers/auditController.js', 'utf8');
content = content.replace(targetStr, replaceStr);
fs.writeFileSync('backend/controllers/auditController.js', content);

const targetStr2 = "const businessDate = settings[0]?.value_val;";
const replaceStr2 = "const businessDate = settings[0]?.value_val;\n    if (!businessDate) {\n      console.error('[CRITICAL] system_settings.system_date is missing from database.');\n      return res.status(500).json({ error: 'System configuration error: Business Date is missing. Please contact administrator.' });\n    }";

const filesToUpdate = [
  'backend/controllers/roomController.js',
  'backend/controllers/reportsController.js',
  'backend/controllers/reservationController.js'
];

for (const file of filesToUpdate) {
  let c = fs.readFileSync(file, 'utf8');
  c = c.replaceAll(targetStr2, replaceStr2);
  fs.writeFileSync(file, c);
}
console.log('Success');
