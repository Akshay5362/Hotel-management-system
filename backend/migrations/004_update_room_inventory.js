/**
 * Migration 004 - Update Room Inventory
 * ---------------------------------------------------------------------------
 * PURPOSE:
 *   Renames all existing room numbers from old 3-digit format (101-120)
 *   to new single/double-digit format (1-20 subset) per hotel specification.
 *   Also inserts Room 12 which is a new addition.
 *   Rooms 13, 15, 18 are NEVER created.
 *
 * MAPPING (old -> new):
 *   101->1  102->2  103->3  104->4  105->5  106->6
 *   107->7  108->8  110->9  111->10 112->11 [NEW]->12
 *   114->14 116->16 117->17 119->19 120->20
 *
 * SAFETY:
 *   - Uses UPDATE (not DELETE+INSERT) so all FK-linked records are preserved
 *   - Updates ledger_items.room_number (string FK) separately
 *   - All other tables link via rooms.id (integer FK) — no changes needed
 *   - Full transaction with rollback on error
 *   - Idempotent: safe to run multiple times
 *
 * DOWN:
 *   Reverses all renames. Cannot recover room 12 data if it was new.
 */

import pool from '../db.js';

// Old number -> New number mapping
const ROOM_RENAME_MAP = [
  ['101', '1'],
  ['102', '2'],
  ['103', '3'],
  ['104', '4'],
  ['105', '5'],
  ['106', '6'],
  ['107', '7'],
  ['108', '8'],
  ['110', '9'],
  ['111', '10'],
  ['112', '11'],
  ['114', '14'],
  ['116', '16'],
  ['117', '17'],
  ['119', '19'],
  ['120', '20'],
];

// Room 12 is new - doesn't exist in old inventory, must be inserted
const NEW_ROOMS = [
  { number: '12', type_code: 'EXECUTIVE', status: 'vacant' },
];

export async function up(connection) {
  console.log('[Migration 004] Starting room inventory update...');

  // ── Step 1: Verify we are working with old numbers (idempotency check) ──
  const [existingCheck] = await connection.query(
    "SELECT COUNT(*) as cnt FROM rooms WHERE number = '1'"
  );
  if (existingCheck[0].cnt > 0) {
    console.log('[Migration 004] Already migrated (room "1" exists). Skipping.');
    return;
  }

  // ── Step 2: Disable FK checks so we can rename rooms without cascade issues
  await connection.query('SET FOREIGN_KEY_CHECKS = 0');

  try {
    // ── Phase A: Rename rooms to temporary placeholder values ──────────────
    console.log('[Migration 004] Phase A: Renaming rooms to temporary values...');
    for (const [oldNum, newNum] of ROOM_RENAME_MAP) {
      await connection.query(
        "UPDATE rooms SET number = ? WHERE number = ?",
        [`TMP_${newNum}`, oldNum]
      );
    }

    // ── Phase A: Update ledger_items.room_number to temp values ───────────
    console.log('[Migration 004] Updating ledger_items to temporary values...');
    for (const [oldNum, newNum] of ROOM_RENAME_MAP) {
      await connection.query(
        "UPDATE ledger_items SET room_number = ? WHERE room_number = ?",
        [`TMP_${newNum}`, oldNum]
      );
    }

    // ── Phase B: Rename rooms from TMP_ to final numbers ──────────────────
    console.log('[Migration 004] Phase B: Renaming rooms to final values...');
    for (const [, newNum] of ROOM_RENAME_MAP) {
      await connection.query(
        "UPDATE rooms SET number = ? WHERE number = ?",
        [newNum, `TMP_${newNum}`]
      );
    }

    // ── Phase B: Update ledger_items.room_number to final values ──────────
    console.log('[Migration 004] Updating ledger_items to final values...');
    for (const [, newNum] of ROOM_RENAME_MAP) {
      await connection.query(
        "UPDATE ledger_items SET room_number = ? WHERE room_number = ?",
        [newNum, `TMP_${newNum}`]
      );
    }

    // ── Step 5: Insert new rooms (room 12) ────────────────────────────────
    console.log('[Migration 004] Inserting new rooms...');
    for (const room of NEW_ROOMS) {
      const [existing] = await connection.query(
        "SELECT id FROM rooms WHERE number = ?",
        [room.number]
      );
      if (existing.length > 0) {
        console.log(`[Migration 004] Room ${room.number} already exists, skipping insert.`);
        continue;
      }

      const [typeRows] = await connection.query(
        "SELECT id FROM room_types WHERE code = ?",
        [room.type_code]
      );
      if (typeRows.length === 0) {
        throw new Error(`Room type ${room.type_code} not found in room_types table.`);
      }
      const typeId = typeRows[0].id;

      await connection.query(
        "INSERT INTO rooms (number, room_type_id, status) VALUES (?, ?, ?)",
        [room.number, typeId, room.status]
      );
      console.log(`[Migration 004] Inserted new room ${room.number} (${room.type_code})`);
    }

  } finally {
    // Always re-enable FK checks
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  // ── Step 6: Verification ─────────────────────────────────────────────────
  const [finalRooms] = await connection.query(
    "SELECT number, (SELECT code FROM room_types WHERE id=room_type_id) as type FROM rooms ORDER BY CAST(number AS UNSIGNED)"
  );
  console.log('[Migration 004] Final room inventory:');
  finalRooms.forEach(r => console.log(`  Room ${r.number} -> ${r.type}`));

  const [orphanCheck] = await connection.query(`
    SELECT COUNT(*) as cnt
    FROM ledger_items li
    LEFT JOIN rooms r ON li.room_number = r.number
    WHERE r.id IS NULL
  `);
  if (orphanCheck[0].cnt > 0) {
    throw new Error(`Migration 004: ${orphanCheck[0].cnt} orphaned ledger_items found! Rolling back.`);
  }

  console.log(`[Migration 004] Success! ${finalRooms.length} rooms in inventory. 0 orphaned ledger references.`);
}

export async function down(connection) {
  console.log('[Migration 004] Rolling back room inventory update...');

  // Reverse: new -> old
  const reverseMap = ROOM_RENAME_MAP.map(([oldNum, newNum]) => [newNum, oldNum]);

  // Phase A: temp rename
  for (const [newNum, oldNum] of reverseMap) {
    await connection.query(
      "UPDATE rooms SET number = ? WHERE number = ?",
      [`TMP_${oldNum}`, newNum]
    );
  }
  for (const [newNum, oldNum] of reverseMap) {
    await connection.query(
      "UPDATE ledger_items SET room_number = ? WHERE room_number = ?",
      [`TMP_${oldNum}`, newNum]
    );
  }

  // Phase B: final rename
  for (const [, oldNum] of reverseMap) {
    await connection.query(
      "UPDATE rooms SET number = ? WHERE number = ?",
      [oldNum, `TMP_${oldNum}`]
    );
  }
  for (const [, oldNum] of reverseMap) {
    await connection.query(
      "UPDATE ledger_items SET room_number = ? WHERE room_number = ?",
      [oldNum, `TMP_${oldNum}`]
    );
  }

  // Remove the newly added room 12 (was not in original inventory)
  for (const room of NEW_ROOMS) {
    await connection.query("DELETE FROM rooms WHERE number = ?", [room.number]);
  }

  console.log('[Migration 004] Rollback complete.');
}
