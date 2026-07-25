const pool = require('./backend/db.js').default;
async function run() {
  try {
    await pool.query('ALTER TABLE audit_logs ADD COLUMN previous_business_date VARCHAR(20) DEFAULT NULL');
    await pool.query('ALTER TABLE audit_logs ADD COLUMN new_business_date VARCHAR(20) DEFAULT NULL');
    await pool.query('ALTER TABLE audit_logs ADD COLUMN reason TEXT DEFAULT NULL');
    await pool.query('ALTER TABLE audit_logs ADD COLUMN username VARCHAR(50) DEFAULT NULL');
    await pool.query('ALTER TABLE audit_logs ADD COLUMN role VARCHAR(50) DEFAULT NULL');
    await pool.query('ALTER TABLE audit_logs ADD COLUMN client_ip VARCHAR(50) DEFAULT NULL');
    await pool.query('ALTER TABLE audit_logs ADD COLUMN application_version VARCHAR(50) DEFAULT "1.0.0"');
    console.log('Migration successful');
  } catch (e) {
    if (e.code === 'ER_DUP_FIELDNAME') console.log('Already migrated');
    else console.error(e);
  }
  process.exit(0);
}
run();
