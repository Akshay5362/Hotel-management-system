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
      SELECT r.id, r.number, r.status as db_status, r.is_active,
             r.housekeeping_status, r.housekeeping_priority, r.last_cleaned_at,
             rt.code as type, rt.title as type_title, rt.base_rate as rate
      FROM rooms r
      JOIN room_types rt ON r.room_type_id = rt.id
      ORDER BY CAST(r.number AS UNSIGNED) ASC, r.number ASC
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
        g.date_of_birth,
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
        res.date_of_birth,
        res.status
      FROM reservations res
      WHERE res.status IN ('Reserved', 'Confirmed')
    `);

    const sysComp = parseToComparableDate(businessDate);

    const processedRooms = rooms.map(r => {
      let computedStatus = r.db_status;
      let currentBooking = null;
      let currentReservation = null;

      const isActive = r.is_active !== 0 && r.is_active !== false && r.is_active !== '0';

      const roomBooking = activeBookings.find(b => b.room_id === r.id);
      if (roomBooking && roomBooking.booking_status === 'Checked In') {
        currentBooking = roomBooking;
        computedStatus = 'occupied';
      }

      // If the DB says 'occupied' but no currently-valid booking window matches,
      // override to 'vacant' so stale old bookings don't ghost the room.
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
      if (
        (computedStatus === 'vacant' || computedStatus === 'booked') &&
        !currentBooking &&
        (r.housekeeping_status === 'Dirty' || r.db_status === 'dirty')
      ) {
        computedStatus = 'dirty';
      }

      // ── Operational Inactive override ──────────────────────────────────────
      // Vacant rooms marked inactive surface as 'inactive' status in UI
      if (!isActive && computedStatus === 'vacant' && !currentBooking) {
        computedStatus = 'inactive';
      }

      return {
        id: r.id,
        number: r.number,
        type: r.type,
        status: computedStatus,
        is_active: isActive,
        housekeeping_status: r.housekeeping_status || (r.db_status === 'dirty' ? 'Dirty' : 'Clean'),
        rate: r.rate,
        guestName: currentBooking 
          ? currentBooking.guestName.toUpperCase() 
          : (currentReservation ? (currentReservation.guestName || currentReservation.guest_name || '').toUpperCase() : ''),
        phone: currentBooking 
          ? currentBooking.phone 
          : (currentReservation ? currentReservation.phone : ''),
        date_of_birth: currentBooking
          ? (currentBooking.date_of_birth || '')
          : (currentReservation ? (currentReservation.date_of_birth || '') : ''),
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

    // Ensure rooms are ALWAYS sorted by numerical room number ascending (1, 2, 3... 12, 14, 16, 17, 19, 20)
    return processedRooms.sort((a, b) => {
      const numA = parseInt(a.number, 10);
      const numB = parseInt(b.number, 10);
      if (!isNaN(numA) && !isNaN(numB) && numA !== numB) {
        return numA - numB;
      }
      return String(a.number || '').localeCompare(String(b.number || ''), undefined, { numeric: true, sensitivity: 'base' });
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

