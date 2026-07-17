/**
 * Hotel PMS - Migration Runner
 * ---------------------------------------------------------------------------
 * Usage:
 *   node migrations/runner.js up        -> Apply all pending migrations
 *   node migrations/runner.js down      -> Roll back the last applied migration
 *   node migrations/runner.js status    -> Show applied vs pending migrations
 *   node migrations/runner.js fresh     -> Roll back ALL applied migrations (DEV only)
 *
 * Rules:
 *   - NEVER drops or recreates tables.
 *   - NEVER touches init_db.js.
 *   - Every migration must export up() and down().
 *   - Migrations are applied in filename order (001_, 002_, ...).
 *   - Applied migrations are tracked in the schema_migrations table.
 *   - Each migration runs in a DB transaction (fully succeeds or rolls back).
 */

import pool from '../db.js';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Terminal colours
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};

function log(symbol, color, msg) {
  console.log(`  ${color}${symbol}${c.reset} ${msg}`);
}

// Bootstrap: ensure schema_migrations table exists
async function ensureMigrationsTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS \`schema_migrations\` (
      \`id\`         INT AUTO_INCREMENT PRIMARY KEY,
      \`migration\`  VARCHAR(255) NOT NULL UNIQUE,
      \`applied_at\` TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

// Read all migration files from this directory
async function getMigrationFiles() {
  const files = fs.readdirSync(__dirname)
    .filter(f => /^\d{3}_.*\.js$/.test(f))
    .sort();
  return files;
}

// Fetch list of already-applied migrations from the DB
async function getAppliedMigrations(connection) {
  const [rows] = await connection.query(
    'SELECT migration FROM schema_migrations ORDER BY id ASC'
  );
  return rows.map(r => r.migration);
}

// Apply a single migration file (up)
async function applyMigration(filename) {
  const filePath = path.join(__dirname, filename);
  const fileUrl  = 'file:///' + filePath.replace(/\\/g, '/');
  const mod      = await import(fileUrl);
  const up       = mod.up;

  if (typeof up !== 'function') {
    throw new Error(`${filename} does not export an up() function.`);
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await ensureMigrationsTable(connection);
    await up(connection);
    await connection.query(
      'INSERT INTO schema_migrations (migration) VALUES (?)',
      [filename]
    );
    await connection.commit();
    log('OK', c.green, `Applied:      ${filename}`);
  } catch (err) {
    await connection.rollback();
    log('!!', c.red,  `FAILED:       ${filename}`);
    log('  ', c.red,  err.message);
    throw err;
  } finally {
    connection.release();
  }
}

// Roll back a single migration file (down)
async function rollbackMigration(filename) {
  const filePath = path.join(__dirname, filename);
  const fileUrl  = 'file:///' + filePath.replace(/\\/g, '/');
  const mod      = await import(fileUrl);
  const down     = mod.down;

  if (typeof down !== 'function') {
    throw new Error(`${filename} does not export a down() function.`);
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await down(connection);
    await connection.query(
      'DELETE FROM schema_migrations WHERE migration = ?',
      [filename]
    );
    await connection.commit();
    log('<<', c.yellow, `Rolled back:  ${filename}`);
  } catch (err) {
    await connection.rollback();
    log('!!', c.red,   `Rollback FAILED: ${filename}`);
    log('  ', c.red,   err.message);
    throw err;
  } finally {
    connection.release();
  }
}

// -- Commands ------------------------------------------------------------------

async function runUp() {
  const connection = await pool.getConnection();
  await ensureMigrationsTable(connection);
  const applied = await getAppliedMigrations(connection);
  connection.release();

  const files   = await getMigrationFiles();
  const pending = files.filter(f => !applied.includes(f));

  if (pending.length === 0) {
    log('--', c.cyan, 'Nothing to migrate. All migrations are up to date.');
    return;
  }

  console.log(`\nApplying ${pending.length} pending migration(s)...\n`);
  for (const file of pending) {
    await applyMigration(file);
  }
  console.log(`\n${c.green}Migration complete.${c.reset}\n`);
}

async function runDown() {
  const connection = await pool.getConnection();
  await ensureMigrationsTable(connection);
  const applied = await getAppliedMigrations(connection);
  connection.release();

  if (applied.length === 0) {
    log('--', c.cyan, 'Nothing to roll back. No migrations have been applied.');
    return;
  }

  const last = applied[applied.length - 1];
  console.log(`\nRolling back: ${last}...\n`);
  await rollbackMigration(last);
  console.log(`\n${c.yellow}Rollback complete.${c.reset}\n`);
}

async function runStatus() {
  const connection = await pool.getConnection();
  await ensureMigrationsTable(connection);
  const applied = await getAppliedMigrations(connection);
  connection.release();

  const files = await getMigrationFiles();

  console.log('\nMigration Status');
  console.log('-'.repeat(55));

  if (files.length === 0) {
    log('--', c.gray, 'No migration files found in migrations/');
  }

  for (const file of files) {
    const isApplied = applied.includes(file);
    if (isApplied) {
      log('OK', c.green,  `${file}  [applied]`);
    } else {
      log('??', c.yellow, `${file}  [pending]`);
    }
  }

  const pendingCount = files.filter(f => !applied.includes(f)).length;
  console.log('-'.repeat(55));
  console.log(`  Applied: ${applied.length}   Pending: ${pendingCount}\n`);
}

async function runFresh() {
  const connection = await pool.getConnection();
  await ensureMigrationsTable(connection);
  const applied = await getAppliedMigrations(connection);
  connection.release();

  if (applied.length === 0) {
    log('--', c.cyan, 'Nothing to roll back.');
    return;
  }

  console.log(`\n${c.red}Rolling back ALL ${applied.length} migration(s)...${c.reset}\n`);
  const reversed = [...applied].reverse();
  for (const file of reversed) {
    await rollbackMigration(file);
  }
  console.log(`\n${c.yellow}All migrations rolled back.${c.reset}\n`);
}

// -- Entry point --------------------------------------------------------------
const command = process.argv[2];

async function main() {
  console.log(`\n${c.bold}${c.cyan}Hotel PMS - Migration Runner${c.reset}`);
  console.log(`${c.gray}DB: ${process.env.DB_NAME || 'hotel_pms'} @ ${process.env.DB_HOST || 'localhost'}${c.reset}\n`);

  switch (command) {
    case 'up':     await runUp();     break;
    case 'down':   await runDown();   break;
    case 'status': await runStatus(); break;
    case 'fresh':  await runFresh();  break;
    default:
      console.error(`Unknown command: "${command || ''}"`);
      console.log('Usage: node migrations/runner.js [up | down | status | fresh]\n');
      process.exit(1);
  }
}

main()
  .then(()  => process.exit(0))
  .catch(err => {
    console.error(`\nFatal: ${err.message}`);
    process.exit(1);
  });
