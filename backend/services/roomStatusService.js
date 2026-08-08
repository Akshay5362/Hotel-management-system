import pool from '../db.js';

export function parseToComparableDate(dateStr) {
  if (!dateStr) return null;
  const str = String(dateStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }
  const months = { jan:'01', feb:'02', mar:'03', apr:"04", may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
  const parts = str.split('-');
  if (parts.length === 3) {
    const day = parts[0].padStart(2, '0');
    const mon = months[parts[1].toLowerCase()];
    const yr = parts[2];
    if (mon && yr) {
      return `${yr}-${mon}-${day}`;
    }
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }
  return str;
}

export function isDateOverlap(start1, end1, start2, end2) {
  const s1 = parseToComparableDate(start1);
  const e1 = parseToComparableDate(end1);
  const s2 = parseToComparableDate(start2);
  const e2 = parseToComparableDate(end2);
  if (!s1 || !e1 || !s2 || !e2) return false;
  return s1 < e2 && s2 < e1;
}

export class RoomStatusService {
  static async getRoomStatuses(connection, businessDate) {
    const [rooms] = await connection.query(`
      SELECT r.id, r.number, r.status as db_status,
             r.housekeeping_status, r.housekeeping_priority, r.last_cleaned_at,
             rt.code as type, rt.title as type_title, rt.base_rate as rate
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
    `);

    const [activeBookings] = await connection.query(`
      SELECT 
        b.id as booking_id,
        b.booking_number,
        b.room_id,
        b.check_in_date as checkInDate,
        b.expected_check_out_date as expectedCheckOutDate,
        b.adults,
        b.children,
        b.total_amount as totalAmount,
        b.advance_amount as deposit,
        b.booking_status,
        b.billing_instruction,
        b.meal_plan,
        g.full_name as guestName,
        g.phone,
        g.address,
        g.gst_no,
        g.pincode,
        g.country,
        g.arrival_from,
        g.departure_to,
        g.user_id
      FROM bookings b
      JOIN guests g ON b.guest_id = g.id
      WHERE b.booking_status IN ('Checked In', 'Reserved')
    `);

    const [activeReservations] = await connection.query(`
      SELECT 
        res.id as reservation_id,
        res.reservation_number as ref_code,
        res.reservation_number as booking_number,
        res.room_id,
        res.room_number,
        res.room_type as roomType,
        res.guest_name as guest_name,
        res.guest_name as guestName,
        res.phone,
        res.arrival_date as check_in_date,
        res.arrival_date as checkInDate,
        res.departure_date as check_out_date,
        res.departure_date as expectedCheckOutDate,
        res.adults as pax,
        res.adults,
        res.advance_payment as total_amount,
        res.advance_payment as deposit,
        res.status
      FROM reservations res
      WHERE res.status IN ('Reserved', 'Confirmed')
    `);

    const sysComp = parseToComparableDate(businessDate);

    return rooms.map(r => {
      let computedStatus = r.db_status;
      let currentBooking = null;
      let currentReservation = null;

      const roomBooking = activeBookings.find(b => b.room_id === r.id);
      if (roomBooking && roomBooking.booking_status === 'Checked In') {
        const checkInComp  = parseToComparableDate(roomBooking.checkInDate);
        const checkOutComp = parseToComparableDate(roomBooking.expectedCheckOutDate);

        // A booking is "currently occupied" when:
        //   1. booking_status = 'Checked In'   (guest is actively in the room)
        //   AND
        //   2. check_in_date <= businessDate    (they have arrived)
        //   AND
        //   3. businessDate <= expected_check_out_date  (inclusive — same-day checkout counts as occupied)
        //
        // Note: we use <= on checkout (not <) so that same-day bookings where
        // check_in == check_out still show the room as occupied.
        const isCurrentlyOccupied =
          checkInComp && sysComp && checkInComp <= sysComp &&
          (checkOutComp ? sysComp <= checkOutComp : true);

        if (isCurrentlyOccupied) {
          currentBooking = roomBooking;
          computedStatus = 'occupied';
        }
      }

      // If the DB says 'occupied' but no currently-valid booking window matches,
      // override to 'vacant' so stale old bookings don't ghost the room.
      // Exception: if the booking_status IS 'Checked In' we already handled it above.
      if (r.db_status === 'occupied' && !currentBooking) {
        computedStatus = 'vacant';
      }


      if (computedStatus === 'vacant' && !currentBooking) {
        const matchingRes = activeReservations.find(res => {
          if (res.room_number === r.number || res.room_id === r.id) {
            const arrComp = parseToComparableDate(res.check_in_date || res.arrival_date);
            const depComp = parseToComparableDate(res.check_out_date || res.departure_date);
            if (arrComp && depComp && sysComp) {
              return arrComp <= sysComp && sysComp < depComp;
            }
            return arrComp === sysComp;
          }
          return false;
        });

        if (matchingRes) {
          computedStatus = 'booked';
          currentReservation = matchingRes;
        }
      }

      // ── Housekeeping dirty override ────────────────────────────────────────
      // If the room is physically vacant (no active guest) but still flagged as
      // Dirty by housekeeping, surface 'dirty' so the dashboard and check-in
      // logic are in agreement — both block the room from new walk-in check-ins.
      if (
        (computedStatus === 'vacant' || computedStatus === 'booked') &&
        !currentBooking &&
        (r.housekeeping_status === 'Dirty' || r.db_status === 'dirty')
      ) {
        computedStatus = 'dirty';
      }

      return {
        id: r.id,
        number: r.number,
        type: r.type,
        status: computedStatus,
        housekeeping_status: r.housekeeping_status || (r.db_status === 'dirty' ? 'Dirty' : 'Clean'),
        rate: r.rate,
        guestName: currentBooking 
          ? currentBooking.guestName.toUpperCase() 
          : (currentReservation ? (currentReservation.guestName || currentReservation.guest_name || '').toUpperCase() : ''),
        phone: currentBooking 
          ? currentBooking.phone 
          : (currentReservation ? currentReservation.phone : ''),
        pax: currentBooking 
          ? (currentBooking.adults + currentBooking.children) 
          : (currentReservation ? (currentReservation.pax || currentReservation.adults || 1) : 0),
        deposit: currentBooking 
          ? currentBooking.deposit 
          : (currentReservation ? (currentReservation.deposit || currentReservation.advance_payment || 0) : 0),
        checkInDate: currentBooking 
          ? currentBooking.checkInDate 
          : (currentReservation ? (currentReservation.checkInDate || currentReservation.arrival_date) : ''),
        expectedCheckOutDate: currentBooking 
          ? (currentBooking.expectedCheckOutDate || '') 
          : (currentReservation ? (currentReservation.expectedCheckOutDate || currentReservation.departure_date) : ''),
        address: currentBooking ? (currentBooking.address || '') : '',
        gst_no: currentBooking ? (currentBooking.gst_no || '') : '',
        pincode: currentBooking ? (currentBooking.pincode || '') : '',
        country: currentBooking ? (currentBooking.country || '') : '',
        arrival_from: currentBooking ? (currentBooking.arrival_from || '') : '',
        departure_to: currentBooking ? (currentBooking.departure_to || '') : '',
        user_id: currentBooking ? currentBooking.user_id : null,
        booking_id: currentBooking ? currentBooking.booking_id : null,
        reservation_id: currentReservation ? currentReservation.reservation_id : null,
        booking_number: currentBooking ? currentBooking.booking_number : (currentReservation ? currentReservation.booking_number : null),
        billing_instruction: currentBooking ? (currentBooking.billing_instruction || 'Direct to Guest') : 'Direct to Guest',
        meal_plan: currentBooking ? (currentBooking.meal_plan || 'EP') : 'EP',
        db_status: r.db_status,
        activeBooking: currentBooking,
        activeReservation: currentReservation
      };
    });
  }

  static async getRoomStatus(connection, roomId, businessDate) {
    const statuses = await this.getRoomStatuses(connection, businessDate);
    return statuses.find(r => String(r.id) === String(roomId));
  }

  static async getAvailableRoomsForDateRange(connection, arrivalDate, departureDate, roomType = 'ALL') {
    const { AvailabilityService } = await import('./AvailabilityService.js');
    return AvailabilityService.getAvailableRooms(connection, arrivalDate, departureDate, roomType);
  }
}

