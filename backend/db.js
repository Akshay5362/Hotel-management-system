import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load dotenv from current backend directory
dotenv.config({ path: path.join(__dirname, '.env') });

const isMysqlDisabled = process.env.DISABLE_MYSQL_CUTOVER_FALLBACKS === 'true';

let rawPool = null;

if (!isMysqlDisabled) {
  rawPool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'hotel_pms',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });
}

// Hard production safety proxy
const pool = {
  query: async (...args) => {
    if (process.env.DISABLE_MYSQL_CUTOVER_FALLBACKS === 'true') {
      const err = new Error('[MYSQL_DECOMMISSIONED_GUARD] Attempted MySQL query while DISABLE_MYSQL_CUTOVER_FALLBACKS=true. Production runtime is strictly Firestore-only.');
      err.code = 'ER_MYSQL_DECOMMISSIONED';
      throw err;
    }
    if (!rawPool) {
      rawPool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'hotel_pms',
        port: parseInt(process.env.DB_PORT || '3306', 10),
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
      });
    }
    return rawPool.query(...args);
  },
  execute: async (...args) => {
    if (process.env.DISABLE_MYSQL_CUTOVER_FALLBACKS === 'true') {
      const err = new Error('[MYSQL_DECOMMISSIONED_GUARD] Attempted MySQL execute while DISABLE_MYSQL_CUTOVER_FALLBACKS=true. Production runtime is strictly Firestore-only.');
      err.code = 'ER_MYSQL_DECOMMISSIONED';
      throw err;
    }
    if (!rawPool) {
      rawPool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'hotel_pms',
        port: parseInt(process.env.DB_PORT || '3306', 10),
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
      });
    }
    return rawPool.execute(...args);
  },
  getConnection: async () => {
    if (process.env.DISABLE_MYSQL_CUTOVER_FALLBACKS === 'true') {
      const err = new Error('[MYSQL_DECOMMISSIONED_GUARD] Attempted MySQL getConnection while DISABLE_MYSQL_CUTOVER_FALLBACKS=true. Production runtime is strictly Firestore-only.');
      err.code = 'ER_MYSQL_DECOMMISSIONED';
      throw err;
    }
    if (!rawPool) {
      rawPool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'hotel_pms',
        port: parseInt(process.env.DB_PORT || '3306', 10),
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
      });
    }
    return rawPool.getConnection();
  },
  end: async () => {
    if (rawPool) return rawPool.end();
  }
};

export default pool;
