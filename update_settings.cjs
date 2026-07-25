const fs = require('fs');
let content = fs.readFileSync('backend/controllers/settingsController.js', 'utf8');

const importAuth = "import { hasPermission } from './authController.js';\n";
content = importAuth + content;

const targetStr = "const isSuperAdmin = username === 'admin' || role === 'SUPER_ADMIN';";

const newStr = const canModify = await hasPermission(req, 'modify_business_date');
    if (!canModify) {
      await connection.rollback();
      return res.status(403).json({ error: 'You do not have permission to modify the business date.' });
    }

    const canOverride = await hasPermission(req, 'override_business_date');;

content = content.replace(targetStr, newStr);

const targetStr2 = "if (dNew < dOld && !isSuperAdmin) {";
const newStr2 = "if (dNew < dOld && !canOverride) {";
content = content.replace(targetStr2, newStr2);

fs.writeFileSync('backend/controllers/settingsController.js', content);
console.log('settingsController updated');
