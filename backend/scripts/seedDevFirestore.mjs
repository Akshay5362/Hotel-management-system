/**
 * backend/scripts/seedDevFirestore.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Seeds the MINIMUM synthetic Firestore dataset needed to functionally test
 * Chef KDS, Cleaner/Housekeeping, and the Admin Housekeeping module against
 * the ISOLATED DEV Firebase project (sky5-development) ONLY.
 *
 * SAFETY — quadruple guard, checked in this order, before any write:
 *   1. HPMS_ENV must literally be "development" (else: throw, exit 1).
 *   2. Firebase Admin is initialized from backend/.env.development only.
 *   3. The resolved Firestore project id must be exactly "sky5-development".
 *   4. Any resolved project id containing "hpms" (case-insensitive) is
 *      rejected outright, regardless of #3, as defense in depth.
 * The resolved project id is printed before any write is attempted.
 *
 * Dry-run by default. Pass --execute to actually write. Every write is an
 * idempotent `set(doc, payload, { merge: true })` on a fixed, deterministic
 * document ID — running this script any number of times converges on the
 * same state, it never creates duplicates.
 *
 * Data is 100% synthetic. Nothing here is read from or copied out of any
 * production system. Real hotel identity fields (GSTIN, address, phone)
 * are intentionally replaced with obvious dev placeholders.
 *
 * Run:
 *   npm run dev:seed -- --dry-run    (default; identical to no flag)
 *   npm run dev:seed -- --execute    (writes)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.join(__dirname, '..');

// ── Guard 1: HPMS_ENV must be explicitly "development" ──────────────────────
const HPMS_ENV = process.env.HPMS_ENV;
if (HPMS_ENV !== 'development') {
  console.error(
    `[SAFETY_ABORT] HPMS_ENV must be exactly "development" (got: ${JSON.stringify(HPMS_ENV)}). ` +
    `This script only ever seeds sky5-development. Refusing to proceed. ` +
    `Run via: npm run dev:seed -- --dry-run`
  );
  process.exit(1);
}

// Load ONLY backend/.env.development — never backend/.env (production).
dotenv.config({ path: path.join(BACKEND_ROOT, '.env.development') });

const { initializeApp, cert, getApps, getApp } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
const { isProductionProject } = await import('../config/productionSafetyGuard.js');

const EXECUTE = process.argv.includes('--execute');
const DRY_RUN = !EXECUTE;

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;
const privateKey = rawPrivateKey ? rawPrivateKey.replace(/\\n/g, '\n') : undefined;

// ── Guard 2 (fail-closed, mirrors firebaseAdmin.js): refuse if the resolved
// project is production, before any credential is used. ────────────────────
if (isProductionProject()) {
  console.error(
    `[SAFETY_ABORT] FIREBASE_PROJECT_ID resolved to the PRODUCTION project ("${projectId}"). ` +
    `Refusing to initialize. Fix backend/.env.development and retry.`
  );
  process.exit(1);
}

if (!projectId || !clientEmail || !privateKey ||
    String(clientEmail).startsWith('REPLACE_WITH_') || String(rawPrivateKey).startsWith('REPLACE_WITH_')) {
  console.error('[FATAL] Missing or placeholder Firebase Admin credentials in backend/.env.development — nothing was contacted, nothing was written.');
  process.exit(1);
}

const firebaseApp = !getApps().length
  ? initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) })
  : getApp();

const resolvedProjectId = firebaseApp?.options?.projectId || firebaseApp?.options?.credential?.projectId || projectId;

// ── Guard 3 + 4 ───────────────────────────────────────────────────────────
if (resolvedProjectId !== 'sky5-development') {
  console.error(`[SAFETY_ABORT] Resolved Firebase project is "${resolvedProjectId}", expected exactly "sky5-development". Refusing to write.`);
  process.exit(1);
}
if (/hpms/i.test(resolvedProjectId)) {
  console.error(`[SAFETY_ABORT] Resolved Firebase project id "${resolvedProjectId}" contains "hpms" — refusing unconditionally, regardless of the exact-match check above.`);
  process.exit(1);
}

console.log('═'.repeat(78));
console.log('  DEV FIRESTORE SEEDER — backend/scripts/seedDevFirestore.mjs');
console.log('═'.repeat(78));
console.log(`  Resolved Firebase project : ${resolvedProjectId}`);
console.log(`  HPMS_ENV                  : ${HPMS_ENV}`);
console.log(`  Mode                      : ${DRY_RUN ? 'DRY-RUN (no writes)' : 'EXECUTE (writing)'}`);
console.log('═'.repeat(78) + '\n');

const db = getFirestore(firebaseApp);
const NOW = new Date().toISOString();

// ── Upsert helper — logs and, only in --execute mode, writes ────────────────
const summary = { collections: 0, docs: 0 };
async function upsert(collection, docId, payload) {
  summary.docs++;
  if (DRY_RUN) {
    console.log(`  [DRY-RUN] would upsert ${collection}/${docId}`);
    return;
  }
  await db.collection(collection).doc(docId).set(payload, { merge: true });
  console.log(`  [WRITE]   upserted ${collection}/${docId}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// ROOM TYPES
// ═══════════════════════════════════════════════════════════════════════════
async function seedRoomTypes() {
  console.log('\n── room_types ──────────────────────────────────────────────');
  summary.collections++;
  const types = [
    { code: 'DELUXE', name: 'Deluxe Room (DEV)', base_rate: 3200, description: 'Synthetic DEV room type — not real inventory.', max_occupancy: 2, amenities: ['AC', 'TV', 'WiFi'] },
    { code: 'SUITE', name: 'Suite (DEV)', base_rate: 5400, description: 'Synthetic DEV room type — not real inventory.', max_occupancy: 3, amenities: ['AC', 'TV', 'WiFi', 'Mini Bar'] }
  ];
  for (const t of types) {
    const docId = `type_${t.code}`;
    await upsert('room_types', docId, {
      name: t.name,
      code: t.code,
      base_rate: t.base_rate,
      description: t.description,
      max_occupancy: t.max_occupancy,
      amenities: t.amenities,
      mysql_room_type_id: null,
      created_at: NOW,
      updated_at: NOW
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ROOMS
// ═══════════════════════════════════════════════════════════════════════════
async function seedRooms() {
  console.log('\n── rooms ───────────────────────────────────────────────────');
  summary.collections++;
  // Mix of Dirty/Clean so both KDS-adjacent flows and the cleaner queue have
  // something to act on. All vacant (no bookings exist in DEV — an occupied
  // room with no matching Checked-In booking is auto-healed back to vacant).
  const rooms = [
    { number: '101', type: 'DELUXE', typeCode: 'DELUXE', floor: 1, price: 3200, hk: 'Dirty' },
    { number: '102', type: 'DELUXE', typeCode: 'DELUXE', floor: 1, price: 3200, hk: 'Clean' },
    { number: '103', type: 'DELUXE', typeCode: 'DELUXE', floor: 1, price: 3200, hk: 'Dirty' },
    { number: '104', type: 'SUITE', typeCode: 'SUITE', floor: 2, price: 5400, hk: 'Clean' },
    { number: '105', type: 'SUITE', typeCode: 'SUITE', floor: 2, price: 5400, hk: 'Dirty' },
    { number: '106', type: 'SUITE', typeCode: 'SUITE', floor: 2, price: 5400, hk: 'Clean' }
  ];
  for (const r of rooms) {
    const docId = `room_${r.number}`;
    await upsert('rooms', docId, {
      number: r.number,
      type: r.type,
      status: 'vacant',
      is_active: true,
      cleaning_status: r.hk,
      housekeeping_status: r.hk,
      housekeeping_priority: 'Normal',
      price: r.price,
      room_type_id: `type_${r.typeCode}`,
      mysql_room_id: null,
      amenities: [],
      housekeeping_assigned_to: null,
      assigned_to_name: null,
      last_cleaned_at: null,
      current_booking_id: null,
      current_guest_name: null,
      guest_id: null,
      floor: r.floor,
      created_at: NOW,
      updated_at: NOW
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FOOD MENU — CATEGORIES + ITEMS
// ═══════════════════════════════════════════════════════════════════════════
async function seedFoodMenu() {
  console.log('\n── food_menu_categories ────────────────────────────────────');
  summary.collections++;
  const categories = [
    { slug: 'starters', name: 'Starters (DEV)', order: 0, emoji: '🥗' },
    { slug: 'main_course', name: 'Main Course (DEV)', order: 1, emoji: '🍛' },
    { slug: 'beverages', name: 'Beverages (DEV)', order: 2, emoji: '☕' }
  ];
  for (const c of categories) {
    const docId = `fcat_${c.slug}`;
    await upsert('food_menu_categories', docId, {
      category_id: docId,
      name: c.name,
      description: 'Synthetic DEV category — not real menu content.',
      display_order: c.order,
      is_active: true,
      icon_emoji: c.emoji,
      created_at: NOW,
      updated_at: NOW
    });
  }

  console.log('\n── food_menu_items ─────────────────────────────────────────');
  summary.collections++;
  const items = [
    { slug: 'veg_spring_rolls', name: 'Veg Spring Rolls (DEV)', category: 'starters', price: 180, veg: true, kot: 'KITCHEN' },
    { slug: 'paneer_tikka', name: 'Paneer Tikka (DEV)', category: 'starters', price: 240, veg: true, kot: 'KITCHEN' },
    { slug: 'veg_biryani', name: 'Veg Biryani (DEV)', category: 'main_course', price: 260, veg: true, kot: 'KITCHEN' },
    { slug: 'dal_makhani', name: 'Dal Makhani (DEV)', category: 'main_course', price: 220, veg: true, kot: 'KITCHEN' },
    { slug: 'masala_chai', name: 'Masala Chai (DEV)', category: 'beverages', price: 50, veg: true, kot: 'PANTRY' },
    { slug: 'cold_coffee', name: 'Cold Coffee (DEV)', category: 'beverages', price: 90, veg: true, kot: 'PANTRY' }
  ];
  for (const it of items) {
    const docId = `fitem_${it.slug}`;
    await upsert('food_menu_items', docId, {
      item_id: docId,
      category_id: `fcat_${it.category}`,
      name: it.name,
      search_name: it.name.toLowerCase(),
      description: 'Synthetic DEV menu item — not real menu content.',
      base_price: it.price,
      tax_rate: 5,
      tax_type: 'GST_5',
      is_veg: it.veg,
      is_active: true,
      kot_type: it.kot,
      preparation_time_mins: 10,
      image_url: null,
      tags: [],
      created_at: NOW,
      updated_at: NOW
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FOOD TABLES + WAITER
// ═══════════════════════════════════════════════════════════════════════════
async function seedFoodTablesAndWaiter() {
  console.log('\n── food_tables ─────────────────────────────────────────────');
  summary.collections++;
  const tables = [
    { id: 'ftbl_table_1', name: 'Table 1 (DEV)', order: 0 },
    { id: 'ftbl_table_2', name: 'Table 2 (DEV)', order: 1 }
  ];
  for (const t of tables) {
    await upsert('food_tables', t.id, {
      table_id: t.id,
      table_name: t.name,
      capacity: 4,
      location: 'Main Dining',
      is_active: true,
      display_order: t.order,
      created_at: NOW,
      updated_at: NOW
    });
  }

  console.log('\n── food_waiters ────────────────────────────────────────────');
  summary.collections++;
  await upsert('food_waiters', 'fwtr_dev_waiter', {
    waiter_id: 'fwtr_dev_waiter',
    waiter_name: 'DEV Waiter',
    is_active: true,
    display_order: 0,
    created_at: NOW,
    updated_at: NOW
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS (system_date, hotel_config — synthetic only) + food_tax_config
// ═══════════════════════════════════════════════════════════════════════════
async function seedSettings() {
  console.log('\n── settings/system_date ────────────────────────────────────');
  summary.collections++;
  const today = new Date().toISOString().split('T')[0];
  await upsert('settings', 'system_date', {
    current_date: today,
    system_date: today,
    value_val: today,
    today_checkins: 0,
    today_checkouts: 0,
    continued_rooms: 0,
    day_end_status: 'IDLE',
    created_at: NOW,
    updated_at: NOW
  });

  console.log('\n── settings/hotel_config (synthetic — no real hotel identity) ─');
  await upsert('settings', 'hotel_config', {
    name: 'HPMS DEV TEST HOTEL',
    hotel_name: 'HPMS DEV TEST HOTEL',
    address: '123 Synthetic Street, DEV Environment',
    phone: '+91 0000000000',
    mobile: '+91 0000000000',
    email: 'dev-test@example.invalid',
    gstin: 'DEVTESTGSTIN000',
    state: 'DEV State',
    state_code: '00',
    hotel_reg_no: 'DEV-0000',
    tax_rate: 0.05,
    terms_and_conditions: 'Synthetic DEV terms — not the real hotel policy.',
    cancellation_policy: 'Synthetic DEV policy — not the real hotel policy.',
    created_at: NOW,
    updated_at: NOW
  });

  console.log('\n── food_tax_config/ftax_default ────────────────────────────');
  summary.collections++;
  await upsert('food_tax_config', 'ftax_default', {
    config_id: 'ftax_default',
    gst_5: { cgst: 2.5, sgst: 2.5 },
    gst_12: { cgst: 6.0, sgst: 6.0 },
    gst_18: { cgst: 9.0, sgst: 9.0 },
    notes: 'Synthetic DEV tax config.',
    created_at: NOW,
    updated_at: NOW
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// STAFF FIRESTORE DOCS (cosmetic profile data only — no credentials here;
// see seedDevAuthUsers.mjs for the actual login accounts)
// ═══════════════════════════════════════════════════════════════════════════
async function seedStaffDocs() {
  console.log('\n── staff (profile docs only — no passwords) ────────────────');
  summary.collections++;
  const staff = [
    { docId: 'staff_2', username: 'reception_morning', full_name: 'DEV Reception Morning', email: 'reception.morning@hotelsky5.com', role: 'receptionist', department: 'Front Office', shift: 'Morning', mysql_staff_id: 2, user_uid: 'staff_2' },
    { docId: 'staff_5', username: 'chef', full_name: 'DEV Chef', email: 'chef@hotelsky5.com', role: 'chef', department: 'Kitchen', shift: 'Morning', mysql_staff_id: 5, user_uid: 'staff_5' },
    { docId: 'staff_6', username: 'helper', full_name: 'DEV Kitchen Helper', email: 'helper@hotelsky5.com', role: 'kitchen_helper', department: 'Kitchen', shift: 'Morning', mysql_staff_id: 6, user_uid: 'staff_6' },
    { docId: 'staff_9', username: 'cleaner1', full_name: 'DEV Cleaner 1', email: 'cleaner1@hotelsky5.com', role: 'cleaner', department: 'Housekeeping', shift: 'Morning', mysql_staff_id: 9, user_uid: 'staff_9' },
    { docId: 'staff_10', username: 'cleaner2', full_name: 'DEV Cleaner 2', email: 'cleaner2@hotelsky5.com', role: 'cleaner', department: 'Housekeeping', shift: 'Night', mysql_staff_id: 10, user_uid: 'staff_10' }
  ];
  for (const s of staff) {
    await upsert('staff', s.docId, {
      username: s.username,
      full_name: s.full_name,
      email: s.email,
      role: s.role,
      department: s.department,
      shift: s.shift,
      status: 'Active',
      user_uid: s.user_uid,
      mysql_staff_id: s.mysql_staff_id,
      phone: null,
      mysql_user_id: null,
      created_at: NOW,
      updated_at: NOW
    });
  }
}

async function main() {
  await seedRoomTypes();
  await seedRooms();
  await seedFoodMenu();
  await seedFoodTablesAndWaiter();
  await seedSettings();
  await seedStaffDocs();

  console.log('\n' + '═'.repeat(78));
  console.log(`  ${DRY_RUN ? 'DRY-RUN COMPLETE — zero writes performed' : 'SEED COMPLETE'}`);
  console.log(`  Collections touched : ${summary.collections}`);
  console.log(`  Documents ${DRY_RUN ? 'that would be written' : 'written'} : ${summary.docs}`);
  console.log('═'.repeat(78));
  if (DRY_RUN) {
    console.log('\n  Re-run with --execute to actually write this data.');
  }
}

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
