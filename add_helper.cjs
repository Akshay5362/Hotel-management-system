const fs = require('fs');
let content = fs.readFileSync('backend/controllers/authController.js', 'utf8');

content += "\nexport const hasPermission = async (req, permissionName) => {\n  if (!req.user) return false;\n  \n  let roleName;\n  if (req.user.type === 'staff') {\n    roleName = req.user.role.toLowerCase();\n  } else {\n    roleName = req.user.role.toLowerCase();\n  }\n  \n  const pool = require('../db.js').default;\n  const [rows] = await pool.query(\\n    SELECT p.id \n    FROM permissions p\n    JOIN role_permissions rp ON p.id = rp.permission_id\n    JOIN roles r ON rp.role_id = r.id\n    WHERE LOWER(r.name) = ? AND p.name = ?\n  \, [roleName, permissionName]);\n  \n  return rows.length > 0;\n};\n";

fs.writeFileSync('backend/controllers/authController.js', content);
console.log('hasPermission added');
