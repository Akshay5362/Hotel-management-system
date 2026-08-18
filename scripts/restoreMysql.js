/**
 * restoreMysql.js
 * ==============================================================================
 * HPMS Pure Node.js Isolated Restore Tool.
 *
 * Restores a timestamped SQL backup file into a SAFE ISOLATED DATABASE (e.g. hpms_restore_test).
 * STRICT HARD SAFETY RULE:
 * Refuses execution if target database matches production DB_NAME or contains 'production'.
 */

import fs from 'fs';
import path from 'path';
import mysql from '../backend/node_modules/mysql2/promise.js';
import dotenv from '../backend/node_modules/dotenv/lib/main.js';
import { fileURLToPath } from 'url';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load backend/.env credentials
dotenv.config({ path: path.join(__dirname, '..', 'backend', '.env') });

const CRITICAL_TABLES = [
  'rooms', 'room_types', 'bookings', 'guests', 'staff',
  'payments', 'invoices', 'ledger_items', 'cash_logs',
  'inventory_categories', 'inventory_products', 'reservations'
];


export async function restoreMysqlBackup(backupPath, options = {}) {
  const targetDb = options.targetDatabase || 'hpms_restore_test';
  const prodDb = process.env.DB_NAME || 'hotel_pms';

  // HARD SAFETY RULE: REJECT PRODUCTION RESTORE TARGET
  if (targetDb.toLowerCase() === prodDb.toLowerCase() || targetDb.toLowerCase().includes('production')) {
    throw new Error(`CRITICAL_RESTORE_SAFETY_VIOLATION: Refusing restore into production database '${targetDb}'. Target MUST be an isolated test database.`);
  }

  if (!fs.existsSync(backupPath)) {
    throw new Error(`RESTORE_FILE_NOT_FOUND: Backup file does not exist at '${backupPath}'`);
  }

  const dbHost = options.host || process.env.DB_HOST || 'localhost';
  const dbUser = options.user || process.env.DB_USER || 'root';
  const dbPassword = options.password !== undefined ? options.password : (process.env.DB_PASSWORD || '');
  const dbPort = options.port || parseInt(process.env.DB_PORT || '3306', 10);

  // Connect to MySQL server (root connection)
  const conn = await mysql.createConnection({
    host: dbHost,
    user: dbUser,
    password: dbPassword,
    port: dbPort,
    multipleStatements: true
  });

  try {
    // Create isolated target database
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${targetDb}\``);
    await conn.query(`USE \`${targetDb}\``);
    await conn.query(`SET FOREIGN_KEY_CHECKS=0`);

    const sqlContent = fs.readFileSync(backupPath, 'utf8');
    const sqlStatements = sqlContent
      .split(/;\s*$/m)
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));

    for (const stmt of sqlStatements) {
      if (stmt) {
        await conn.query(stmt);
      }
    }

    await conn.query(`SET FOREIGN_KEY_CHECKS=1`);


    // Verify restored table counts
    const [tables] = await conn.query('SHOW TABLES');
    const tableKey = `Tables_in_${targetDb}`;
    const restoredTableNames = tables.map(r => r[tableKey] || Object.values(r)[0]);

    const tableCounts = {};
    for (const tableName of restoredTableNames) {
      const [cntRows] = await conn.query(`SELECT COUNT(*) as count FROM \`${tableName}\``);
      tableCounts[tableName] = cntRows[0].count;
    }

    const missingCriticalTables = CRITICAL_TABLES.filter(t => !restoredTableNames.includes(t));
    if (missingCriticalTables.length > 0) {
      throw new Error(`RESTORE_INTEGRITY_FAILURE: Missing critical tables in restored database: ${missingCriticalTables.join(', ')}`);
    }

    return {
      success: true,
      targetDatabase: targetDb,
      restoredTableCount: restoredTableNames.length,
      restoredTables: restoredTableNames,
      tableCounts,
      timestamp: new Date().toISOString()
    };
  } finally {
    await conn.end();
  }
}

// Command-line entrypoint
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error('Usage: node restoreMysql.js <path-to-sql-backup> [target-db-name]');
    process.exit(1);
  }
  const targetArg = process.argv[3] || 'hpms_restore_test';
  restoreMysqlBackup(fileArg, { targetDatabase: targetArg }).then(res => {
    console.log('Isolated Restore Successful:', res);
  }).catch(err => {
    console.error('Isolated Restore Failed:', err.message);
    process.exit(1);
  });
}
