import { FirestoreAvailabilityService } from '../services/firestoreAvailabilityService.js';
import { FirestoreRoomStatusService } from '../services/firestoreRoomStatusService.js';
import { BusinessDateService } from '../services/businessDateService.js';

async function smokeTest() {
  console.log('=== WORKFLOW SMOKE TEST (DATA-INDEPENDENT INVARIANT) ===');

  // 1. Determine dynamic business date
  let testArrivalDate;
  try {
    testArrivalDate = await BusinessDateService.getBusinessDate();
  } catch (err) {
    testArrivalDate = new Date().toISOString().split('T')[0];
  }
  const testDepartureDate = BusinessDateService.addDays(testArrivalDate, 1);

  console.log(`\nTest Date Window: ${testArrivalDate} to ${testDepartureDate}`);

  // 2. Fetch live Room Statuses from FirestoreRoomStatusService
  const statuses = await FirestoreRoomStatusService.getRoomStatuses(testArrivalDate, { skipCache: true });
  const totalRoomsCount = statuses.length;

  const occupiedRooms = statuses
    .filter(r => r.status === 'occupied')
    .map(r => String(r.number));

  const vacantRooms = statuses
    .filter(r => r.status === 'vacant')
    .map(r => String(r.number));

  const dirtyRooms = statuses
    .filter(r => r.status === 'dirty' || r.housekeeping_status === 'Dirty' || r.cleaning_status === 'Dirty')
    .map(r => String(r.number));

  const blockedRooms = statuses
    .filter(r => ['out_of_order', 'maintenance', 'blocked'].includes(r.status))
    .map(r => String(r.number));

  console.log(`\n1. Room Status Breakdown (Total Rooms: ${totalRoomsCount}):`);
  console.log(` - Occupied (${occupiedRooms.length}):`, occupiedRooms.join(', ') || '(none)');
  console.log(` - Vacant   (${vacantRooms.length}):`, vacantRooms.join(', ') || '(none)');
  console.log(` - Dirty    (${dirtyRooms.length}):`, dirtyRooms.join(', ') || '(none)');
  console.log(` - Blocked  (${blockedRooms.length}):`, blockedRooms.join(', ') || '(none)');

  // 3. Fetch Available Rooms from FirestoreAvailabilityService
  const availableRooms = await FirestoreAvailabilityService.getAvailableRooms({
    arrivalDate: testArrivalDate,
    departureDate: testDepartureDate
  });

  const availNums = availableRooms
    .map(r => String(r.number))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  console.log(`\n2. Available Rooms for ${testArrivalDate} to ${testDepartureDate} (${availableRooms.length}):`);
  console.log('Available Room Numbers:', availNums.join(', ') || '(none)');

  // 4. Invariant Evaluations
  // Invariant A: Inventory is non-empty and consistent
  const invariantInventoryExists = totalRoomsCount > 0;

  // Invariant B: No currently occupied room is in the available rooms list
  const conflictingOccupiedRooms = availNums.filter(n => occupiedRooms.includes(n));
  const invariantNoOccupiedInAvailable = conflictingOccupiedRooms.length === 0;

  // Invariant C: No blocked/dirty room is in the available rooms list
  const conflictingBlockedRooms = availNums.filter(n => blockedRooms.includes(n) || dirtyRooms.includes(n));
  const invariantNoBlockedInAvailable = conflictingBlockedRooms.length === 0;

  // Invariant D: All available rooms belong to actual registered room inventory
  const allAvailableAreValidRooms = availNums.every(n => statuses.some(r => String(r.number) === n));

  // Invariant E: Available room count does not exceed total rooms minus occupied rooms
  const invariantCountBounded = availableRooms.length <= (totalRoomsCount - occupiedRooms.length);

  console.log('\n3. Invariant Evaluation:');
  console.log(` - Inventory Exists (${totalRoomsCount} rooms):`, invariantInventoryExists ? 'PASS' : 'FAIL');
  console.log(' - Occupied Rooms Excluded from Availability:', invariantNoOccupiedInAvailable ? 'PASS' : 'FAIL');
  if (conflictingOccupiedRooms.length > 0) {
    console.error('   ❌ Conflicting Occupied Rooms Found in Available List:', conflictingOccupiedRooms.join(', '));
  }
  console.log(' - Blocked/Dirty Rooms Excluded from Availability:', invariantNoBlockedInAvailable ? 'PASS' : 'FAIL');
  if (conflictingBlockedRooms.length > 0) {
    console.error('   ❌ Conflicting Blocked/Dirty Rooms Found in Available List:', conflictingBlockedRooms.join(', '));
  }
  console.log(' - Available Rooms are Valid Inventory:', allAvailableAreValidRooms ? 'PASS' : 'FAIL');
  console.log(' - Available Count Bounded by Non-Occupied Capacity:', invariantCountBounded ? 'PASS' : 'FAIL');

  const allPassed = (
    invariantInventoryExists &&
    invariantNoOccupiedInAvailable &&
    invariantNoBlockedInAvailable &&
    allAvailableAreValidRooms &&
    invariantCountBounded
  );

  if (allPassed) {
    console.log('\n✅ ALL WORKFLOW SMOKE INVARIANTS PASSED.');
    process.exit(0);
  } else {
    console.error('\n❌ WORKFLOW SMOKE INVARIANTS FAILED');
    process.exit(1);
  }
}

smokeTest();
