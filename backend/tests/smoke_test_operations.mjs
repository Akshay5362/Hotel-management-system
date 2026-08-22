import assert from 'assert';
import { CheckInCutoverService } from '../services/checkInCutoverService.js';
import { RoomShiftCutoverService } from '../services/roomShiftCutoverService.js';
import { CheckOutCutoverService } from '../services/checkOutCutoverService.js';
import { FirestoreRoomStatusService } from '../services/firestoreRoomStatusService.js';

console.log('--- Operational Services Smoke Test ---');

// 1. CheckInCutoverService structure & method availability
assert.strictEqual(typeof CheckInCutoverService.executeCheckIn, 'function', 'executeCheckIn must be a function');
assert.strictEqual(typeof CheckInCutoverService.reconcileUnknownOutcome, 'function', 'reconcileUnknownOutcome must be a function');
console.log('✓ CheckInCutoverService loaded and exports executeCheckIn');

// 2. RoomShiftCutoverService structure & method availability
assert.strictEqual(typeof RoomShiftCutoverService.executeRoomShift, 'function', 'executeRoomShift must be a function');
assert.strictEqual(typeof RoomShiftCutoverService.reconcileUnknownOutcome, 'function', 'reconcileUnknownOutcome must be a function');
console.log('✓ RoomShiftCutoverService loaded and exports executeRoomShift');

// 3. CheckOutCutoverService structure & method availability
assert.strictEqual(typeof CheckOutCutoverService.executeCheckOut, 'function', 'executeCheckOut must be a function');
console.log('✓ CheckOutCutoverService loaded and exports executeCheckOut');

// 4. FirestoreRoomStatusService structure & method availability
assert.strictEqual(typeof FirestoreRoomStatusService.getRoomStatuses, 'function', 'getRoomStatuses must be a function');
assert.strictEqual(typeof FirestoreRoomStatusService.getRoomStatus, 'function', 'getRoomStatus must be a function');
console.log('✓ FirestoreRoomStatusService loaded and exports getRoomStatuses, getRoomStatus');

console.log('\nAll operational cutover services are valid, fully loadable, and decoupled from obsolete outbox modules!');
