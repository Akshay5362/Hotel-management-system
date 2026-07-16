import pool from './db.js';

async function runMigration() {
  try {
    console.log('Running DB migration for OCR and Verification...');
    const conn = await pool.getConnection();
    
    try {
      await conn.query(`
        ALTER TABLE guests 
        ADD COLUMN id_rejection_reason VARCHAR(255) DEFAULT NULL,
        ADD COLUMN id_verified_by INT DEFAULT NULL,
        ADD COLUMN id_verified_at TIMESTAMP DEFAULT NULL,
        ADD COLUMN id_ocr_text TEXT DEFAULT NULL;
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
