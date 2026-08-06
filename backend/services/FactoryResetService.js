/**
 * FactoryResetService.js
 * ======================
 * Phase 2 — Complete Production Implementation
 *
 * WHAT THIS DOES:
 *   Deletes ALL transactional data in the correct FK child→parent order
 *   (no FOREIGN_KEY_CHECKS disabled — referential integrity always enforced).
 *   Deletes guest user accounts from the users table (role='guest').
 *   Deletes all uploaded guest identity documents from disk.
 *   Resets rooms to vacant, reseeds housekeeping, resets counters.
 *   Everything runs in a single MySQL transaction — one failure = full rollback.
 *
 * WHAT IS PRESERVED:
 *   - Admin and non-guest user accounts (users table)
 *   - staff table
 *   - roles, permissions, role_permissions
 *   - room_types (configuration)
 *   - rooms structure (only status column updated to 'vacant')
 *   - system_settings (only 4 counter keys updated; hotel config keys untouched)
 */

import pool from '../db.js';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename     = fileURLToPath(import.meta.url);
const __dirname      = path.dirname(__filename);
const GUEST_DOCS_DIR = path.join(__dirname, '..', 'guest-documents');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns today as "DD-Mon-YYYY" (PMS display format). */
function todayDisplay() {
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = new Date();
  const dd   = String(d.getDate()).padStart(2, '0');
  const mon  = MONTHS[d.getMonth()];
  const yyyy = d.getFullYear();
  return `${dd}-${mon}-${yyyy}`;
}

/** Deletes one file — swallows ENOENT (already gone). */
function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[FactoryReset] Failed to delete ${filePath}: ${err.message}`);
    }
  }
}

/**
 * Deletes every uploaded guest document from backend/guest-documents/.
 * Only removes files whose names start with "id_doc_" (the upload naming pattern).
 * Hotel assets (logos, room images) are in different directories and untouched.
 *
 * @returns {{ filesDeleted: number, errors: string[] }}
 */
function deleteAllGuestDocumentFiles() {
  let filesDeleted = 0;
  const errors = [];

  if (!fs.existsSync(GUEST_DOCS_DIR)) {
    return { filesDeleted: 0, errors: [] };
  }

  let entries;
  try {
    entries = fs.readdirSync(GUEST_DOCS_DIR);
  } catch (err) {
    return { filesDeleted: 0, errors: [`Cannot read guest-documents dir: ${err.message}`] };
  }

  for (const name of entries) {
    if (!name.startsWith('id_doc_')) continue;          // skip README, .gitkeep, etc.

    const fullPath = path.join(GUEST_DOCS_DIR, name);
    try {
      if (fs.statSync(fullPath).isFile()) {
        safeUnlink(fullPath);
        filesDeleted++;
      }
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }

  return { filesDeleted, errors };
}

// ─── DELETE ORDER (child → parent — NO FK checks disabled) ───────────────────
//
//  Every table is deleted in FK dependency order: child tables first.
//
//  room_status_history  → rooms, users
//  booking_history      → bookings, rooms, users
//  stay_extension_requests → bookings, guests, rooms
//  feedback             → bookings, guests
//  maintenance          → rooms, users
//  housekeeping         → rooms, users
//  ledger_items         → rooms.number, bookings
//  payments             → bookings
//  invoices             → bookings
//  cash_logs            → bookings
//  audit_logs           → users
//  notifications        → users
//  reservations         → rooms, bookings, users
//  bookings             → guests, rooms, users
//  guests               → users
//  (then) DELETE FROM users WHERE role='guest'
//
const DELETE_SEQUENCE = [
  { table: 'room_status_history',     label: 'roomStatusHistory' },
  { table: 'booking_history',         label: 'bookingHistory'    },
  { table: 'stay_extension_requests', label: 'stayExtensions'    },
  { table: 'feedback',                label: 'feedback'          },
  { table: 'maintenance',             label: 'maintenance'       },
  { table: 'housekeeping',            label: 'housekeeping'      },
  { table: 'ledger_items',            label: 'ledgerItems'       },
  { table: 'payments',                label: 'payments'          },
  { table: 'invoices',                label: 'invoices'          },
  { table: 'cash_logs',               label: 'cashLogs'          },
  { table: 'audit_logs',              label: 'auditLogs'         },
  { table: 'notifications',           label: 'notifications'     },
  { table: 'reservations',            label: 'reservations'      },
  { table: 'bookings',                label: 'bookings'          },
  { table: 'guests',                  label: 'guests'            },
];

// Tables on which AUTO_INCREMENT is reset after the committed transaction
const AI_RESET_TABLES = [
  'room_status_history', 'booking_history', 'stay_extension_requests',
  'feedback', 'maintenance', 'housekeeping', 'ledger_items',
  'payments', 'invoices', 'cash_logs', 'audit_logs', 'notifications',
  'reservations', 'bookings', 'guests',
];

// ─── Service ──────────────────────────────────────────────────────────────────

export class FactoryResetService {

  /**
   * Executes the complete factory reset.
   *
   * @returns {Promise<{ success: boolean, summary: object }>}
   * @throws {Error} On transaction failure — DB left completely unchanged.
   */
  static async factoryReset() {
    const startMs  = Date.now();
    const todayStr = todayDisplay();
    const counts   = {};

    // ── Step 1: Run all deletes inside a single transaction ───────────────────
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Delete transactional tables in FK-safe order
      for (const { table, label } of DELETE_SEQUENCE) {
        const [result] = await conn.query(`DELETE FROM \`${table}\``);
        counts[label]  = result.affectedRows;
      }

      // Delete guest-role user accounts (role_name = 'guest')
      const [roleRows] = await conn.query(
        "SELECT id FROM roles WHERE name = 'guest' LIMIT 1"
      );
      counts.guestUsersDeleted = 0;
      if (roleRows.length > 0) {
        const [r] = await conn.query(
          'DELETE FROM users WHERE role_id = ?',
          [roleRows[0].id]
        );
        counts.guestUsersDeleted = r.affectedRows;
      }

      // Reset all rooms to 'vacant'
      const [roomsResult] = await conn.query("UPDATE rooms SET status = 'vacant'");
      counts.roomsReset = roomsResult.affectedRows;

      // Re-seed one 'Clean' housekeeping row per room
      const [roomRows] = await conn.query('SELECT id FROM rooms');
      for (const { id } of roomRows) {
        await conn.query(
          "INSERT INTO housekeeping (room_id, status, notes, business_date) VALUES (?, 'Clean', 'Post factory reset — room ready for check-in.', ?)",
          [id, todayStr]
        );
      }
      counts.housekeepingReseeded = roomRows.length;

      // Reset operational counters in system_settings
      const settingsToReset = [
        { key: 'system_date',    value: todayStr },
        { key: 'today_checkins', value: '0'      },
        { key: 'today_checkouts',value: '0'      },
        { key: 'continued_rooms',value: '0'      },
      ];
      for (const { key, value } of settingsToReset) {
        await conn.query(
          'UPDATE system_settings SET value_val = ? WHERE key_name = ?',
          [value, key]
        );
      }
      counts.businessDateReset = todayStr;

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      conn.release();
      console.error('[FactoryReset] TRANSACTION FAILED — rolled back completely:', err.message);
      throw new Error(`Factory Reset failed and was rolled back: ${err.message}`);
    }
    conn.release();

    // ── Step 2: Reset AUTO_INCREMENT (post-commit — DDL cannot be in a TX) ────
    try {
      const aiConn = await pool.getConnection();
      for (const table of AI_RESET_TABLES) {
        try {
          await aiConn.query(`ALTER TABLE \`${table}\` AUTO_INCREMENT = 1`);
        } catch (e) {
          console.warn(`[FactoryReset] AUTO_INCREMENT reset skipped for ${table}: ${e.message}`);
        }
      }
      aiConn.release();
    } catch (e) {
      console.warn('[FactoryReset] AUTO_INCREMENT reset connection failed:', e.message);
    }

    // ── Step 3: Delete uploaded guest document files from disk ────────────────
    const fileResult = deleteAllGuestDocumentFiles();
    counts.filesDeleted = fileResult.filesDeleted;
    if (fileResult.errors.length > 0) {
      console.warn('[FactoryReset] File deletion warnings:', fileResult.errors);
    }

    const executionMs = Date.now() - startMs;

    console.log(
      `\n[FactoryReset] ✓ Complete in ${executionMs}ms\n` +
      `  Guests              : ${counts.guests} deleted\n` +
      `  Guest users         : ${counts.guestUsersDeleted} deleted\n` +
      `  Bookings            : ${counts.bookings} deleted\n` +
      `  Reservations        : ${counts.reservations} deleted\n` +
      `  Payments            : ${counts.payments} deleted\n` +
      `  Invoices            : ${counts.invoices} deleted\n` +
      `  Cash logs           : ${counts.cashLogs} deleted\n` +
      `  Notifications       : ${counts.notifications} deleted\n` +
      `  Audit logs          : ${counts.auditLogs} deleted\n` +
      `  Maintenance         : ${counts.maintenance} deleted\n` +
      `  Housekeeping        : ${counts.housekeeping} deleted\n` +
      `  Stay extensions     : ${counts.stayExtensions} deleted\n` +
      `  Feedback            : ${counts.feedback} deleted\n` +
      `  Rooms reset         : ${counts.roomsReset} → vacant\n` +
      `  HK re-seeded        : ${counts.housekeepingReseeded} Clean rows\n` +
      `  Business date reset : ${counts.businessDateReset}\n` +
      `  Files deleted       : ${counts.filesDeleted} from disk\n`
    );

    return {
      success: true,
      summary: {
        guestsDeleted:         counts.guests,
        guestUsersDeleted:     counts.guestUsersDeleted,
        reservationsDeleted:   counts.reservations,
        bookingsDeleted:       counts.bookings,
        paymentsDeleted:       counts.payments,
        invoicesDeleted:       counts.invoices,
        ledgerItemsDeleted:    counts.ledgerItems,
        cashLogsDeleted:       counts.cashLogs,
        notificationsDeleted:  counts.notifications,
        maintenanceDeleted:    counts.maintenance,
        auditLogsDeleted:      counts.auditLogs,
        housekeepingDeleted:   counts.housekeeping,
        roomServiceDeleted:    (counts.stayExtensions || 0) + (counts.feedback || 0),
        roomsReset:            counts.roomsReset,
        businessDateReset:     counts.businessDateReset,
        filesDeletedFromDisk:  counts.filesDeleted,
        executionMs,
      },
    };
  }

  /** Read-only preflight — returns current record counts without modifying anything. */
  static async verifyReset() {
    const conn = await pool.getConnection();
    try {
      const [[{ guests }]]       = await conn.query('SELECT COUNT(*) AS guests FROM guests');
      const [[{ bookings }]]     = await conn.query('SELECT COUNT(*) AS bookings FROM bookings');
      const [[{ reservations }]] = await conn.query('SELECT COUNT(*) AS reservations FROM reservations');
      const [[{ payments }]]     = await conn.query('SELECT COUNT(*) AS payments FROM payments');
      return { valid: true, status: 'Ready', counts: { guests, bookings, reservations, payments } };
    } finally {
      conn.release();
    }
  }
}
