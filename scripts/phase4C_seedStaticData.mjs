/**
 * scripts/phase4C_seedStaticData.mjs
 * ══════════════════════════════════════════════════════════════════════════════
 * HPMS-Sky5 — PHASE 4C: Static / Operational Master Data Seeding
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * SAFETY CONTRACT:
 *   ✅ Reads ONLY from MySQL (SELECT statements only)
 *   ✅ Writes ONLY to Firestore using batch.set(..., { merge: true })
 *   ✅ Never deletes any Firestore document (orphans are untouched)
 *   ✅ Never modifies MySQL data
 *   ✅ Validates Feature Flags are OFF
 *   ✅ Resolves Relationships (room_types, categories)
 *   ✅ Detects deterministic ID collisions before proceeding
 *   ✅ Dry-run by default — use --commit for actual write
 */

import pool from '../backend/db.js';
import { db } from '../backend/config/firebaseAdmin.js';
import {
  formatRoomId,
  formatCategoryDocId,
  formatProductDocId
} from '../backend/repositories/firestore/firestoreUtils.js';

// ── CLI flags ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--commit') || args.includes('--dry-run');
const MODE_LABEL = DRY_RUN ? 'DRY-RUN' : 'COMMIT';

// ════════════════════════════════════════════════════════════════════════════════
// SAFETY GUARDS
// ════════════════════════════════════════════════════════════════════════════════

function verifyFeatureFlags() {
  const MUST_BE_FALSE = [
    'ENABLE_FIRESTORE_READS',
    'ENABLE_FIRESTORE_DUAL_WRITE',
    'ENABLE_FIRESTORE_OUTBOX_WORKER',
    'ENABLE_FIRESTORE_RECONCILIATION',
  ];
  const violations = [];
  for (const flag of MUST_BE_FALSE) {
    if (process.env[flag] === 'true') {
      violations.push(`  ❌ ${flag} = true  (must be false for Phase 4C)`);
    }
  }
  if (violations.length > 0) {
    console.error('\n🚫 SAFETY ABORT: The following feature flags are unexpectedly enabled:');
    violations.forEach(v => console.error(v));
    console.error('\nSet all flags to false in backend/.env before running this script.\n');
    process.exit(1);
  }
  console.log('  ✅ Feature flags verified — FIRESTORE_READS=false, DUAL_WRITE=false');
}

async function safeQuery(sql, params = []) {
  const trimmed = sql.trim().toUpperCase();
  if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('SHOW')) {
    throw new Error(`SAFETY VIOLATION: Non-SELECT SQL attempted:\n"${sql}"`);
  }
  const [rows] = await pool.query(sql, params);
  return rows;
}

function toIsoString(dateVal) {
  if (!dateVal) return new Date().toISOString();
  return new Date(dateVal).toISOString();
}

// ════════════════════════════════════════════════════════════════════════════════
// ID GENERATORS & MAPPERS
// ════════════════════════════════════════════════════════════════════════════════

function buildRoomTypeDocId(code) {
  return `type_${String(code).toUpperCase().trim()}`;
}

async function run() {
  console.log(`\n======================================================`);
  console.log(` PHASE 4C MIGRATION : ${MODE_LABEL} `);
  console.log(`======================================================\n`);

  verifyFeatureFlags();

  // 1. EXTRACT FROM MYSQL
  console.log('\n[1] Extracting data from MySQL...');
  const roomTypesSrc = await safeQuery('SELECT * FROM room_types');
  const roomsSrc = await safeQuery('SELECT * FROM rooms');
  const catSrc = await safeQuery('SELECT * FROM inventory_categories');
  const prodSrc = await safeQuery('SELECT * FROM inventory_products');

  // Lookup maps
  const roomTypeMap = new Map(); // id -> row
  roomTypesSrc.forEach(rt => roomTypeMap.set(rt.id, rt));
  const catMap = new Map(); // id -> row
  catSrc.forEach(c => catMap.set(c.id, c));

  // 2. VALIDATE RELATIONSHIPS & BUILD PAYLOADS
  console.log('\n[2] Validating relationships & mapping data...');
  const payloads = {
    room_types: [],
    rooms: [],
    inventory_categories: [],
    inventory_products: []
  };

  const collisionChecks = {
    room_types: new Map(),
    rooms: new Map(),
    inventory_categories: new Map(),
    inventory_products: new Map()
  };

  function checkCollision(collection, docId, sourceId) {
    if (collisionChecks[collection].has(docId)) {
      throw new Error(`COLLISION DETECTED in ${collection}: Doc ID '${docId}' maps to multiple source rows (e.g. MySQL ID ${sourceId} and ${collisionChecks[collection].get(docId)})`);
    }
    collisionChecks[collection].set(docId, sourceId);
  }

  // --- ROOM TYPES ---
  for (const rt of roomTypesSrc) {
    if (!rt.code) throw new Error(`RoomType ID ${rt.id} is missing a code`);
    const docId = buildRoomTypeDocId(rt.code);
    checkCollision('room_types', docId, rt.id);

    payloads.room_types.push({
      docId,
      ref: db.collection('room_types').doc(docId),
      data: {
        name: String(rt.title || rt.name || '').trim(),
        code: String(rt.code).toUpperCase().trim(),
        description: String(rt.description || '').trim(),
        base_rate: Number(rt.base_rate || 0),
        max_occupancy: 2,
        amenities: [],
        title: String(rt.title || '').trim(),
        image: String(rt.image || '').trim(),
        mysql_room_type_id: Number(rt.id),
        updated_at: new Date().toISOString(),
        migrated_at: new Date().toISOString(),
        migration_source: 'phase4C'
      }
    });
  }

  // --- ROOMS ---
  for (const r of roomsSrc) {
    const docId = formatRoomId(r.number);
    checkCollision('rooms', docId, r.id);

    const rt = roomTypeMap.get(r.room_type_id);
    if (!rt) throw new Error(`Room ID ${r.id} (number ${r.number}) references missing room_type_id: ${r.room_type_id}`);
    
    payloads.rooms.push({
      docId,
      ref: db.collection('rooms').doc(docId),
      data: {
        number: String(r.number).trim(),
        type: String(rt.code).toUpperCase().trim(),
        status: String(r.status || 'vacant'),
        housekeeping_status: String(r.housekeeping_status || 'Clean'),
        cleaning_status: String(r.housekeeping_status || 'Clean'),
        price: Number(rt.base_rate || 0),
        amenities: [],
        mysql_room_id: Number(r.id),
        mysql_room_type_id: Number(r.room_type_id),
        housekeeping_assigned_to: r.housekeeping_assigned_to || null,
        housekeeping_priority: r.housekeeping_priority || null,
        last_cleaned_at: r.last_cleaned_at ? toIsoString(r.last_cleaned_at) : null,
        current_booking_id: null,
        updated_at: new Date().toISOString(),
        migrated_at: new Date().toISOString(),
        migration_source: 'phase4C'
      }
    });
  }

  // --- INVENTORY CATEGORIES ---
  for (const c of catSrc) {
    if (!c.name) throw new Error(`Category ID ${c.id} missing name`);
    const docId = formatCategoryDocId(c.name);
    checkCollision('inventory_categories', docId, c.id);

    payloads.inventory_categories.push({
      docId,
      ref: db.collection('inventory_categories').doc(docId),
      data: {
        name: String(c.name).trim(),
        department: String(c.department || 'General').trim(),
        mysql_category_id: Number(c.id),
        created_at: toIsoString(c.created_at),
        updated_at: new Date().toISOString(),
        migrated_at: new Date().toISOString(),
        migration_source: 'phase4C'
      }
    });
  }

  // --- INVENTORY PRODUCTS ---
  for (const p of prodSrc) {
    if (!p.sku) throw new Error(`Product ID ${p.id} missing sku`);
    const docId = formatProductDocId(p.sku);
    checkCollision('inventory_products', docId, p.id);

    const c = catMap.get(p.category_id);
    if (!c) throw new Error(`Product ID ${p.id} (SKU ${p.sku}) references missing category_id: ${p.category_id}`);

    const catDocId = formatCategoryDocId(c.name);

    payloads.inventory_products.push({
      docId,
      ref: db.collection('inventory_products').doc(docId),
      data: {
        name: String(p.name).trim(),
        sku: String(p.sku).trim().toUpperCase(),
        category_id: catDocId,
        mysql_category_id: Number(p.category_id),
        mysql_product_id: Number(p.id),
        unit_of_measure: String(p.unit_of_measure || 'pcs'),
        unit: String(p.unit_of_measure || 'pcs'),
        minimum_stock_level: Number(p.minimum_stock_level || 5),
        reorder_level: Number(p.minimum_stock_level || 5),
        current_stock: Number(p.current_stock || 0),
        stock_quantity: Number(p.current_stock || 0),
        unit_price: Number(p.unit_price || 0),
        photo_url: p.photo_url ? String(p.photo_url) : null,
        status: String(p.status || 'Active'),
        created_at: toIsoString(p.created_at),
        updated_at: toIsoString(p.updated_at),
        migrated_at: new Date().toISOString(),
        migration_source: 'phase4C'
      }
    });
  }

  console.log('  ✅ Relationships validated');
  console.log('  ✅ No deterministic ID collisions detected');

  // 3. FETCH EXISTING FIRESTORE DOCS
  console.log('\n[3] Fetching existing canonical Firestore documents...');
  const collections = ['room_types', 'rooms', 'inventory_categories', 'inventory_products'];
  let totalExisting = 0;

  for (const coll of collections) {
    const list = payloads[coll];
    if (list.length === 0) continue;
    
    // Batch fetch in chunks of 10 to avoid query limits
    const chunks = [];
    for (let i = 0; i < list.length; i += 10) {
      chunks.push(list.slice(i, i + 10));
    }
    
    let existingCount = 0;
    for (const chunk of chunks) {
      const refs = chunk.map(i => i.ref);
      const snaps = await db.getAll(...refs);
      snaps.forEach(snap => {
        if (snap.exists) existingCount++;
      });
    }
    console.log(`  - ${coll}: ${existingCount} canonical documents already exist`);
    totalExisting += existingCount;
  }

  // 4. REPORT / SUMMARY
  console.log('\n[4] Migration Summary');
  collections.forEach(coll => {
    console.log(`\n  ${coll.toUpperCase()}:`);
    console.log(`    MySQL: ${payloads[coll].length}`);
    console.log(`    Planned Firestore writes: ${payloads[coll].length}`);
  });

  // 5. DRY RUN OR COMMIT
  if (DRY_RUN) {
    console.log('\n======================================================');
    console.log(' FINAL: DRY RUN — ZERO WRITES EXECUTED');
    console.log('======================================================\n');
  } else {
    console.log('\n[5] Committing to Firestore...');
    const batch = db.batch();
    
    for (const coll of collections) {
      for (const item of payloads[coll]) {
        batch.set(item.ref, item.data, { merge: true });
      }
    }
    
    await batch.commit();
    console.log('  ✅ Write successful');

    console.log('\n[6] Verification (Read-back)...');
    for (const coll of collections) {
      if (payloads[coll].length === 0) continue;
      const firstRef = payloads[coll][0].ref;
      const snap = await firstRef.get();
      if (snap.exists) {
        console.log(`  ✅ Verified ${coll} (sample ID: ${snap.id})`);
      } else {
        console.error(`  ❌ Failed to verify ${coll} (sample ID: ${snap.id} not found)`);
      }
    }

    console.log('\n======================================================');
    console.log(' FINAL: COMMIT SUCCESSFUL');
    console.log('======================================================\n');
  }

  await pool.end();
}

run().catch(err => {
  console.error('\n🚫 MIGRATION FAILED:', err);
  pool.end();
  process.exit(1);
});
