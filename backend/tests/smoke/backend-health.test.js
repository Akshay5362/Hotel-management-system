import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env configuration from backend/.env
dotenv.config({ path: path.join(__dirname, '../../.env') });

describe('Smoke Test - Backend Infrastructure', () => {
  let dbConnection;

  // Establish a connection using credentials loaded from backend/.env
  beforeAll(async () => {
    const host = process.env.DB_HOST || '127.0.0.1';
    const user = process.env.DB_USER || 'root';
    const password = process.env.DB_PASSWORD || 'Akshu@5362';
    const database = process.env.DB_NAME || 'hotel_pms';
    const port = parseInt(process.env.DB_PORT || '3306');

    dbConnection = await mysql.createConnection({ host, user, password, database, port });
  });

  // Clean up database connection
  afterAll(async () => {
    if (dbConnection) {
      await dbConnection.end();
    }
  });

  // Test 1: Check Database connectivity
  it('should connect to MySQL and return database version', async () => {
    const [rows] = await dbConnection.query('SELECT VERSION() as version');
    expect(rows[0].version).toBeDefined();
    console.log(`[Smoke Test] Database version resolved: ${rows[0].version}`);
  });

  // Test 2: Check System Settings table accessibility
  it('should successfully read the system_date configuration setting', async () => {
    const [rows] = await dbConnection.query(
      "SELECT value_val FROM system_settings WHERE key_name = 'system_date'"
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].value_val).toBeDefined();
    console.log(`[Smoke Test] System business date: ${rows[0].value_val}`);
  });
});
