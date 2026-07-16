import pool from './db.js';

async function runMigration() {
  try {
    console.log('Running DB migration...');
    const conn = await pool.getConnection();
    
    // Check if columns exist to prevent errors on multiple runs
    try {
      await conn.query(`
        ALTER TABLE guests 
        ADD COLUMN id_document_path VARCHAR(255) DEFAULT NULL,
        ADD COLUMN id_upload_timestamp TIMESTAMP DEFAULT NULL,
        ADD COLUMN id_verification_status VARCHAR(50) DEFAULT 'Pending';
      `);
      console.log('Columns added successfully.');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log('Columns already exist, skipping.');
      } else {
        throw e;
      }
    }
    
    conn.release();
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

runMigration();
