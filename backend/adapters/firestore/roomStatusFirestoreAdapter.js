import { db } from '../../config/firebaseAdmin.js';

export class RoomStatusFirestoreAdapter {
  static async getRoomStatuses(businessDate = '2026-08-17') {
    if (!db) {
      throw new Error('Firebase Admin DB is not initialized.');
    }

    // 1. Fetch all Firestore /rooms
    const roomsSnap = await db.collection('rooms').get();
    const rooms = [];
    roomsSnap.forEach(doc => rooms.push({ docId: doc.id, ...doc.data() }));

    // 2. Fetch all active 'Checked In' bookings
    const bookingsSnap = await db.collection('bookings')
      .where('booking_status', '==', 'Checked In')
      .get();
    const activeBookings = [];
    bookingsSnap.forEach(doc => activeBookings.push({ docId: doc.id, ...doc.data() }));

    // 3. Fetch all active reservations
    const reservationsSnap = await db.collection('reservations')
      .where('status', 'in', ['Reserved', 'Confirmed'])
      .get();
    const activeReservations = [];
    reservationsSnap.forEach(doc => activeReservations.push({ docId: doc.id, ...doc.data() }));

    // Compute room status per room
    const processedRooms = rooms.map(r => {
      const roomNumStr = String(r.number);
      const isActive = r.is_active !== false && r.is_active !== 0 && r.is_active !== '0';

      // Find matching Checked In booking (MATCH BY room_id or room_number)
      const currentBooking = activeBookings.find(b => 
        b.room_id === r.docId || 
        b.room_id === `room_${r.number}` || 
        String(b.room_number) === roomNumStr
      );

      let computedStatus = r.status || 'vacant';

      // ── CRITICAL UTC DATE PRESERVATION RULE ──────────────────────────────────
      // Any booking with booking_status === 'Checked In' MUST cause room status = 'occupied'
      if (currentBooking) {
        computedStatus = 'occupied';
      } else if (r.status === 'occupied') {
        // Auto-heal ghost status if no active booking exists
        computedStatus = 'vacant';
      }

      // Check reservation for vacant rooms
      const currentReservation = activeReservations.find(res => 
        String(res.room_number) === roomNumStr || res.room_id === r.docId
      );

      if (computedStatus === 'vacant' && currentReservation) {
        computedStatus = 'booked';
      }

      // Housekeeping dirty override
      const isDirty = r.housekeeping_status === 'Dirty' || r.cleaning_status === 'Dirty' || r.status === 'dirty';
      if ((computedStatus === 'vacant' || computedStatus === 'booked') && !currentBooking && isDirty) {
        computedStatus = 'dirty';
      }

      // Operational Inactive override
      if (!isActive && computedStatus === 'vacant' && !currentBooking) {
        computedStatus = 'inactive';
      }

      return {
        id: r.docId,
        number: roomNumStr,
        type: r.type || 'SUITE',
        status: computedStatus,
        is_active: isActive,
        housekeeping_status: isDirty ? 'Dirty' : 'Clean',
        rate: Number(r.price || r.rate || 0),
        guestName: currentBooking 
          ? String(currentBooking.guest_name || '').toUpperCase() 
          : (currentReservation ? String(currentReservation.guest_name || '').toUpperCase() : ''),
        phone: currentBooking ? currentBooking.phone || '' : (currentReservation ? currentReservation.phone || '' : ''),
        date_of_birth: currentBooking ? currentBooking.date_of_birth || '' : (currentReservation ? currentReservation.date_of_birth || '' : ''),
        pax: currentBooking ? (Number(currentBooking.adults || 1) + Number(currentBooking.children || 0)) : 0,
        deposit: currentBooking ? Number(currentBooking.advance_amount || 0) : 0,
        checkInDate: currentBooking ? currentBooking.check_in_date || '' : '',
        expectedCheckOutDate: currentBooking ? currentBooking.expected_check_out_date || '' : '',
        booking_id: currentBooking ? currentBooking.docId : null,
        reservation_id: currentReservation ? currentReservation.docId : null,
        billing_instruction: currentBooking ? (currentBooking.billing_instruction || 'Direct to Guest') : 'Direct to Guest',
        meal_plan: currentBooking ? (currentBooking.meal_plan || 'EP') : 'EP',
        db_status: r.status,
        activeBooking: currentBooking || null,
        activeReservation: currentReservation || null
      };
    });

    // Numerical room ordering ascending: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10...
    return processedRooms.sort((a, b) => {
      const numA = parseInt(a.number, 10);
      const numB = parseInt(b.number, 10);
      if (!isNaN(numA) && !isNaN(numB) && numA !== numB) {
        return numA - numB;
      }
      return String(a.number || '').localeCompare(String(b.number || ''), undefined, { numeric: true, sensitivity: 'base' });
    });
  }
}
