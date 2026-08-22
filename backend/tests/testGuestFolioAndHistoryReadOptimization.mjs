import assert from 'assert';
import { db } from '../config/firebaseAdmin.js';
import { AuditHistoryCutoverService } from '../services/auditHistoryCutoverService.js';
import { readBudgetMonitor } from '../utils/firestoreReadBudget.js';
import { listDocs } from '../repositories/firestore/firestoreUtils.js';

console.log('═════════════════════════════════════════════════════════════════════════════');
console.log('HPMS — PHASE 3B GUEST LIVE FOLIO & HISTORY READ OPTIMIZATION TEST SUITE');
console.log('═════════════════════════════════════════════════════════════════════════════\n');

async function runTests() {
  console.log('1. Resolving Active Guest in Firestore...');
  const allGuests = await listDocs('guests');
  assert(allGuests.length > 0, 'At least 1 guest must exist in Firestore');
  const activeGuest = allGuests[0];
  const guestId = activeGuest.id;
  const guestName = activeGuest.full_name;

  console.log(`✓ Testing with Guest: ${guestName} (${guestId})`);

  // Reset baseline reads
  const initialBudgetReads = readBudgetMonitor.estimatedReadsToday;

  const billResult = await AuditHistoryCutoverService.getGuestBill(
    { claimedGuestId: guestId },
    async () => { throw new Error('MySQL fallback should not execute'); }
  );

  const readsAfterBill = readBudgetMonitor.estimatedReadsToday;
  const billDocsRead = readsAfterBill - initialBudgetReads;

  console.log(`✓ getGuestBill executed successfully.`);
  console.log(`  - Active Booking: ${billResult.booking ? billResult.booking.booking_number : 'None'}`);
  console.log(`  - Room Number: ${billResult.booking ? billResult.booking.room_number : 'None'}`);
  console.log(`  - Ledger Items Count: ${billResult.ledger.length}`);
  console.log(`  - Total Document Reads: ${billDocsRead}`);

  assert(billResult && Array.isArray(billResult.ledger), 'getGuestBill must return ledger array');
  assert(billDocsRead < 10, `Targeted getGuestBill must consume < 10 reads (got ${billDocsRead}), avoiding previous 115+ full scans!`);

  console.log('\n2. Testing getGuestHistory with Targeted Guest Lookup...');
  const readsBeforeHistory = readBudgetMonitor.estimatedReadsToday;

  const historyResult = await AuditHistoryCutoverService.getGuestHistory(
    { claimedGuestId: guestId },
    async () => { throw new Error('MySQL fallback should not execute'); }
  );

  const readsAfterHistory = readBudgetMonitor.estimatedReadsToday;
  const historyDocsRead = readsAfterHistory - readsBeforeHistory;

  console.log(`✓ getGuestHistory executed successfully.`);
  console.log(`  - Guest Name: ${historyResult.guest.full_name}`);
  console.log(`  - Total Stays: ${historyResult.totalStays}`);
  console.log(`  - Bookings Returned: ${historyResult.bookings.length}`);
  console.log(`  - Total Document Reads: ${historyDocsRead}`);

  assert.strictEqual(historyResult.guest.full_name, guestName);
  assert(historyResult.totalStays >= 1, 'Total stays must be >= 1');
  assert(historyDocsRead < 15, `Targeted getGuestHistory must consume < 15 reads (got ${historyDocsRead}), avoiding previous 150+ full collection scans!`);

  console.log('\n3. Testing getGuestHistoryAdmin with Targeted Queries...');
  const readsBeforeAdmin = readBudgetMonitor.estimatedReadsToday;

  const adminHistory = await AuditHistoryCutoverService.getGuestHistoryAdmin(
    guestId,
    async () => { throw new Error('MySQL fallback should not execute'); }
  );

  const readsAfterAdmin = readBudgetMonitor.estimatedReadsToday;
  const adminDocsRead = readsAfterAdmin - readsBeforeAdmin;

  console.log(`✓ getGuestHistoryAdmin executed successfully.`);
  console.log(`  - Admin Bookings: ${adminHistory.bookings.length}`);
  console.log(`  - Admin Payments: ${adminHistory.payments.length}`);
  console.log(`  - Total Document Reads: ${adminDocsRead}`);

  assert.strictEqual(adminHistory.guest.full_name, guestName);
  assert(Array.isArray(adminHistory.payments), 'Payments must be array');
  assert(adminDocsRead < 15, `Targeted getGuestHistoryAdmin must consume < 15 reads (got ${adminDocsRead})`);

  console.log('\n4. Testing Edge Cases (Non-Existent Guest & Inactive Guest)...');
  try {
    await AuditHistoryCutoverService.getGuestBill(
      { claimedGuestId: 'guest_non_existent_999' },
      async () => { throw new Error('Fallback'); }
    );
    assert.fail('Should have thrown 404 for non-existent guest');
  } catch (err) {
    assert.strictEqual(err.status, 404, 'Must throw 404 for non-existent guest');
    console.log('✓ 404 error cleanly raised for non-existent guest.');
  }

  console.log('\n═════════════════════════════════════════════════════════════════════════════');
  console.log('ALL PHASE 3B GUEST LIVE FOLIO & HISTORY READ OPTIMIZATION TESTS PASSED!');
  console.log('═════════════════════════════════════════════════════════════════════════════\n');
}

runTests().catch(err => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
