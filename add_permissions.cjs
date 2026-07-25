const pool = require('./backend/db.js').default;
async function run() {
  try {
    // 1. Insert permissions if they don't exist
    await pool.query('INSERT IGNORE INTO permissions (name, description) VALUES (?, ?)', ['modify_business_date', 'Grants permission to modify business date forward']);
    await pool.query('INSERT IGNORE INTO permissions (name, description) VALUES (?, ?)', ['override_business_date', 'Grants permission to override business date backward']);
    
    // 2. Get permission IDs
    const [p1] = await pool.query('SELECT id FROM permissions WHERE name = ?', ['modify_business_date']);
    const [p2] = await pool.query('SELECT id FROM permissions WHERE name = ?', ['override_business_date']);
    
    // 3. Get admin role ID
    const [roles] = await pool.query('SELECT id FROM roles WHERE name = ?', ['admin']);
    const adminId = roles[0].id;
    
    // 4. Assign permissions to admin
    await pool.query('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [adminId, p1[0].id]);
    await pool.query('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [adminId, p2[0].id]);
    
    console.log('Permissions migration successful');
  } catch (e) {
    console.error(e);
  }
  process.exit(0);
}
run();
