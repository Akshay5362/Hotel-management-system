import { FirestoreAvailabilityService } from '../services/firestoreAvailabilityService.js';
import { FirestoreRoomStatusService } from '../services/firestoreRoomStatusService.js';

async function smokeTest() {
  console.log('=== WORKFLOW SMOKE TEST ===');

  // 1. Availability check for new booking
  const availableRooms = await FirestoreAvailabilityService.getAvailableRooms({
    arrivalDate: '2026-08-21',
    departureDate: '2026-08-22'
  });

  console.log(`\n1. Available Rooms for 2026-08-21 to 2026-08-22: ${availableRooms.length}`);
  const availNums = availableRooms.map(r => r.number).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  console.log('Available Room Numbers:', availNums.join(', '));

  // Verify occupied rooms (1, 2, 3) are NOT in available rooms
  const hasOccupied = availNums.some(n => ['1', '2', '3'].includes(String(n)));
  console.log('Occupied Rooms (1, 2, 3) excluded from available rooms:', !hasOccupied);

  // 2. Room Status Service
  const statuses = await FirestoreRoomStatusService.getRoomStatuses('2026-08-21', { skipCache: true });
  console.log(`\n2. Status Service Total Rooms: ${statuses.length}`);
  const occupiedCount = statuses.filter(r => r.status === 'occupied').length;
  const vacantCount = statuses.filter(r => r.status === 'vacant').length;
  console.log(`Occupied: ${occupiedCount} | Vacant: ${vacantCount}`);

  // 3. Smoke assertions
  const passed = (
    availableRooms.length === 14 &&
    !hasOccupied &&
    statuses.length === 17 &&
    occupiedCount === 3 &&
    vacantCount === 14
  );

  if (passed) {
    console.log('\n✅ ALL WORKFLOW SMOKE TESTS PASSED.');
  } else {
    console.error('\n❌ WORKFLOW SMOKE TEST FAILED');
    process.exit(1);
  }
}

smokeTest();
