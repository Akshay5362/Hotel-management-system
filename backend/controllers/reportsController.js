import pool from '../db.js';
import { BusinessDateService } from '../services/businessDateService.js';
import { RoomStatusService } from '../services/roomStatusService.js';
import { ReportsCutoverService } from '../services/reportsCutoverService.js';
import {
  filterRecordsByDateRange,
  getEffectivePaymentAmount,
  computeDaysInRange,
  calculateStayOverlapNights,
  getBookingRoomTariff,
  getHistoricalRoomRevenueForBooking,
  calculateAvailableRoomNights,
  calculateAvailableRoomsForDate
} from '../services/firestoreReportsService.js';

// Helper to parse 'DD-MMM-YYYY' to a comparable Date object
const parseBusinessDate = (dateStr) => {
  if (!dateStr) return null;
  if (dateStr.includes('-') && dateStr.split('-')[0].length === 4) {
    return new Date(dateStr);
  }
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    const day = parseInt(parts[0], 10);
    const month = months[parts[1]];
    const year = parseInt(parts[2], 10);
    return new Date(year, month, day);
  }
  return new Date(dateStr);
};

export const getDashboardOverview = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const result = await ReportsCutoverService.getDashboardOverview(
      { startDate, endDate },
      async () => {
        const [payments] = await pool.query('SELECT * FROM payments');
        const [bookings] = await pool.query('SELECT * FROM bookings');
        const [ledgerItems] = await pool.query('SELECT * FROM ledger_items');
        const [statusHistory] = await pool.query('SELECT * FROM room_status_history');
        const businessDate = await BusinessDateService.getBusinessDate(pool);
        const rooms = await RoomStatusService.getRoomStatuses(pool, businessDate);

        // 1. Total revenue factoring in refunds
        const filteredPayments = filterRecordsByDateRange(payments, startDate, endDate, 'business_date');
        const totalRevenue = filteredPayments.reduce((sum, p) => sum + getEffectivePaymentAmount(p), 0);

        // 2. New bookings created in period
        const filteredBookings = filterRecordsByDateRange(bookings, startDate, endDate, 'created_at');
        const totalBookings = filteredBookings.length;

        // 3. Available room nights in date range deducting maintenance/OOO/blocked nights
        const totalAvailableRoomNights = calculateAvailableRoomNights(rooms, statusHistory, startDate, endDate);

        // 4. Calculate occupied room nights and room revenue for valid stays overlapping the period
        const validBookings = bookings.filter(b => ['Reserved', 'Checked In', 'Checked Out'].includes(b.booking_status));
        let totalOccupiedRoomNights = 0;
        let totalRoomRevenue = 0;

        validBookings.forEach(b => {
          const overlap = calculateStayOverlapNights(b, startDate, endDate);
          if (overlap > 0) {
            totalOccupiedRoomNights += overlap;
            const bookingRoomRev = getHistoricalRoomRevenueForBooking(b, ledgerItems, startDate, endDate);
            totalRoomRevenue += bookingRoomRev;
          }
        });

        const occupancyRate = totalAvailableRoomNights === 0 ? 0 : Math.min(100, Math.round((totalOccupiedRoomNights / totalAvailableRoomNights) * 100));
        const adr = totalOccupiedRoomNights === 0 ? 0 : Math.round(totalRoomRevenue / totalOccupiedRoomNights);
        const revPAR = totalAvailableRoomNights === 0 ? 0 : Math.round(totalRoomRevenue / totalAvailableRoomNights);

        return {
          totalRevenue,
          occupancyRate,
          totalBookings,
          adr,
          revPAR
        };
      }
    );

    res.json({
      totalRevenue: result.totalRevenue,
      occupancyRate: result.occupancyRate,
      totalBookings: result.totalBookings,
      adr: result.adr,
      revPAR: result.revPAR
    });
  } catch (error) {
    console.error('Error fetching dashboard overview:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getRevenueReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const result = await ReportsCutoverService.getRevenueReport(
      { startDate, endDate },
      async () => {
        const [payments] = await pool.query('SELECT * FROM payments');
        const filteredPayments = filterRecordsByDateRange(payments, startDate, endDate, 'business_date');

        const revenueByDate = {};
        const revenueByType = {};
        let totalNetRevenue = 0;

        filteredPayments.forEach(p => {
          const date = p.business_date;
          const amt = getEffectivePaymentAmount(p);
          totalNetRevenue += amt;

          if (!revenueByDate[date]) revenueByDate[date] = 0;
          revenueByDate[date] += amt;

          const type = p.payment_type || p.payment_method || 'Other';
          if (!revenueByType[type]) revenueByType[type] = 0;
          revenueByType[type] += amt;
        });

        const chartData = Object.keys(revenueByDate).map(date => ({
          date,
          revenue: revenueByDate[date]
        })).sort((a, b) => parseBusinessDate(a.date) - parseBusinessDate(b.date));

        return {
          total: totalNetRevenue,
          chartData,
          breakdown: revenueByType
        };
      }
    );

    res.json({
      total: result.total,
      chartData: result.chartData,
      breakdown: result.breakdown
    });
  } catch (error) {
    console.error('Error fetching revenue report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getOccupancyReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const result = await ReportsCutoverService.getOccupancyReport(
      { startDate, endDate },
      async () => {
        const businessDate = await BusinessDateService.getBusinessDate(pool);
        const rooms = await RoomStatusService.getRoomStatuses(pool, businessDate);
        const [roomTypes] = await pool.query('SELECT * FROM room_types');
        const [bookings] = await pool.query('SELECT * FROM bookings');
        const [statusHistory] = await pool.query('SELECT * FROM room_status_history');

        const roomTypeMap = new Map();
        roomTypes.forEach(rt => {
          const typeRooms = rooms.filter(r => r.room_type_id === rt.id && r.status !== 'inactive');
          roomTypeMap.set(rt.id, {
            id: rt.id,
            name: rt.title,
            totalRooms: typeRooms.length,
            typeRooms,
            occupiedNights: 0
          });
        });

        const validBookings = bookings.filter(b => ['Reserved', 'Checked In', 'Checked Out'].includes(b.booking_status));
        validBookings.forEach(b => {
          const overlap = calculateStayOverlapNights(b, startDate, endDate);
          if (overlap > 0) {
            const room = rooms.find(r => r.id === b.room_id || r.number === b.room_number);
            if (room && roomTypeMap.has(room.room_type_id)) {
              roomTypeMap.get(room.room_type_id).occupiedNights += overlap;
            }
          }
        });

        const roomTypeStats = Array.from(roomTypeMap.values()).map(stat => {
          const availableNights = calculateAvailableRoomNights(stat.typeRooms, statusHistory, startDate, endDate);
          return {
            name: stat.name,
            total: stat.totalRooms,
            occupied: stat.occupiedNights,
            occupancyRate: availableNights === 0 ? 0 : Math.min(100, Math.round((stat.occupiedNights / availableNights) * 100))
          };
        });

        const statusCounts = {
          'Reserved': 0,
          'Checked In': 0,
          'Checked Out': 0,
          'Cancelled': 0
        };

        const filteredBookings = filterRecordsByDateRange(bookings, startDate, endDate, 'created_at');
        filteredBookings.forEach(b => {
          if (statusCounts[b.booking_status] !== undefined) {
            statusCounts[b.booking_status]++;
          }
        });

        return {
          roomTypeStats,
          bookingStatus: statusCounts
        };
      }
    );

    res.json({
      roomTypeStats: result.roomTypeStats,
      bookingStatus: result.bookingStatus
    });
  } catch (error) {
    console.error('Error fetching occupancy report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getGuestAnalytics = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const result = await ReportsCutoverService.getGuestAnalytics(
      { startDate, endDate },
      async () => {
        const [guests] = await pool.query('SELECT * FROM guests');
        const filteredGuests = filterRecordsByDateRange(guests, startDate, endDate, 'created_at');

        const loyaltyStats = {};
        const genderStats = {};

        filteredGuests.forEach(g => {
          const tier = g.loyalty_tier || 'None';
          if (!loyaltyStats[tier]) loyaltyStats[tier] = 0;
          loyaltyStats[tier]++;

          const gender = g.gender || 'Unknown';
          if (!genderStats[gender]) genderStats[gender] = 0;
          genderStats[gender]++;
        });

        return {
          totalGuests: filteredGuests.length,
          loyaltyStats: Object.keys(loyaltyStats).map(name => ({ name, value: loyaltyStats[name] })),
          genderStats: Object.keys(genderStats).map(name => ({ name, value: genderStats[name] }))
        };
      }
    );

    res.json({
      totalGuests: result.totalGuests,
      loyaltyStats: result.loyaltyStats,
      genderStats: result.genderStats
    });
  } catch (error) {
    console.error('Error fetching guest analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getBookingAnalytics = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const result = await ReportsCutoverService.getBookingAnalytics(
      { startDate, endDate },
      async () => {
        const [bookings] = await pool.query('SELECT * FROM bookings');
        const filteredBookings = filterRecordsByDateRange(bookings, startDate, endDate, 'created_at');

        const bookingByDate = {};
        filteredBookings.forEach(b => {
          const d = b.created_at ? new Date(b.created_at).toISOString().split('T')[0] : '2026-08-19';
          if (!bookingByDate[d]) bookingByDate[d] = 0;
          bookingByDate[d]++;
        });

        const chartData = Object.keys(bookingByDate).map(date => ({
          date,
          bookings: bookingByDate[date]
        })).sort((a, b) => new Date(a.date) - new Date(b.date));

        return {
          totalBookings: filteredBookings.length,
          chartData
        };
      }
    );

    res.json({
      totalBookings: result.totalBookings,
      chartData: result.chartData
    });
  } catch (error) {
    console.error('Error fetching booking analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getCancellationReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const result = await ReportsCutoverService.getCancellationReport(
      { startDate, endDate },
      async () => {
        const [bookings] = await pool.query('SELECT * FROM bookings');
        const filteredBookings = filterRecordsByDateRange(bookings, startDate, endDate, 'created_at');

        const cancelled = filteredBookings.filter(b => b.booking_status === 'Cancelled');
        const totalCancelled = cancelled.length;
        const lostRevenue = cancelled.reduce((sum, b) => sum + Number(b.total_amount || 0), 0);

        return {
          totalCancelled,
          lostRevenue,
          cancellations: cancelled
        };
      }
    );

    res.json({
      totalCancelled: result.totalCancelled,
      lostRevenue: result.lostRevenue,
      cancellations: result.cancellations
    });
  } catch (error) {
    console.error('Error fetching cancellation report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getProfitReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const result = await ReportsCutoverService.getProfitReport(
      { startDate, endDate },
      async () => {
        const [payments] = await pool.query('SELECT * FROM payments');
        const filteredPayments = filterRecordsByDateRange(payments, startDate, endDate, 'business_date');

        const totalRevenue = filteredPayments.reduce((sum, p) => sum + getEffectivePaymentAmount(p), 0);
        const estimatedCosts = Math.round(totalRevenue * 0.3);
        const estimatedProfit = totalRevenue - estimatedCosts;

        return {
          totalRevenue,
          estimatedCosts,
          estimatedProfit
        };
      }
    );

    res.json({
      totalRevenue: result.totalRevenue,
      estimatedCosts: result.estimatedCosts,
      estimatedProfit: result.estimatedProfit
    });
  } catch (error) {
    console.error('Error fetching profit report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getADRReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const result = await ReportsCutoverService.getADRReport(
      { startDate, endDate },
      async () => {
        const [bookings] = await pool.query('SELECT * FROM bookings');
        const [ledgerItems] = await pool.query('SELECT * FROM ledger_items');
        const validBookings = bookings.filter(b => ['Reserved', 'Checked In', 'Checked Out'].includes(b.booking_status));

        const byDate = {};
        const startStr = startDate ? new Date(startDate).toISOString().split('T')[0] : null;
        const endStr = endDate ? new Date(endDate).toISOString().split('T')[0] : null;

        if (startStr && endStr) {
          const curr = new Date(startStr);
          const endObj = new Date(endStr);
          while (curr <= endObj) {
            const dKey = curr.toISOString().split('T')[0];
            byDate[dKey] = { revenue: 0, rooms: 0 };
            curr.setDate(curr.getDate() + 1);
          }
        }

        validBookings.forEach(b => {
          const checkIn = b.check_in_date ? new Date(b.check_in_date).toISOString().split('T')[0] : null;
          let checkOut = b.check_out_date ? new Date(b.check_out_date).toISOString().split('T')[0] : null;
          if (!checkIn) return;
          if (!checkOut || checkOut <= checkIn) {
            const d = new Date(checkIn);
            d.setDate(d.getDate() + 1);
            checkOut = d.toISOString().split('T')[0];
          }

          const stayDate = new Date(checkIn);
          const outDate = new Date(checkOut);
          while (stayDate < outDate) {
            const dKey = stayDate.toISOString().split('T')[0];
            if (!startStr || (dKey >= startStr && dKey <= endStr)) {
              if (!byDate[dKey]) byDate[dKey] = { revenue: 0, rooms: 0 };
              const dayRev = getHistoricalRoomRevenueForBooking(b, ledgerItems, dKey, dKey);
              byDate[dKey].revenue += dayRev;
              byDate[dKey].rooms += 1;
            }
            stayDate.setDate(stayDate.getDate() + 1);
          }
        });

        const chartData = Object.keys(byDate).map(date => ({
          date,
          adr: byDate[date].rooms === 0 ? 0 : Math.round(byDate[date].revenue / byDate[date].rooms)
        })).sort((a, b) => new Date(a.date) - new Date(b.date));

        return { chartData };
      }
    );

    res.json({ chartData: result.chartData });
  } catch (error) {
    console.error('Error fetching ADR report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getRevPARReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const result = await ReportsCutoverService.getRevPARReport(
      { startDate, endDate },
      async () => {
        const [bookings] = await pool.query('SELECT * FROM bookings');
        const [ledgerItems] = await pool.query('SELECT * FROM ledger_items');
        const [statusHistory] = await pool.query('SELECT * FROM room_status_history');
        const businessDate = await BusinessDateService.getBusinessDate(pool);
        const rooms = await RoomStatusService.getRoomStatuses(pool, businessDate);

        const validBookings = bookings.filter(b => ['Reserved', 'Checked In', 'Checked Out'].includes(b.booking_status));

        const byDate = {};
        const startStr = startDate ? new Date(startDate).toISOString().split('T')[0] : null;
        const endStr = endDate ? new Date(endDate).toISOString().split('T')[0] : null;

        if (startStr && endStr) {
          const curr = new Date(startStr);
          const endObj = new Date(endStr);
          while (curr <= endObj) {
            const dKey = curr.toISOString().split('T')[0];
            byDate[dKey] = { revenue: 0 };
            curr.setDate(curr.getDate() + 1);
          }
        }

        validBookings.forEach(b => {
          const checkIn = b.check_in_date ? new Date(b.check_in_date).toISOString().split('T')[0] : null;
          let checkOut = b.check_out_date ? new Date(b.check_out_date).toISOString().split('T')[0] : null;
          if (!checkIn) return;
          if (!checkOut || checkOut <= checkIn) {
            const d = new Date(checkIn);
            d.setDate(d.getDate() + 1);
            checkOut = d.toISOString().split('T')[0];
          }

          const stayDate = new Date(checkIn);
          const outDate = new Date(checkOut);
          while (stayDate < outDate) {
            const dKey = stayDate.toISOString().split('T')[0];
            if (!startStr || (dKey >= startStr && dKey <= endStr)) {
              if (!byDate[dKey]) byDate[dKey] = { revenue: 0 };
              const dayRev = getHistoricalRoomRevenueForBooking(b, ledgerItems, dKey, dKey);
              byDate[dKey].revenue += dayRev;
            }
            stayDate.setDate(stayDate.getDate() + 1);
          }
        });

        const chartData = Object.keys(byDate).map(date => {
          const dailyAvailable = calculateAvailableRoomsForDate(rooms, statusHistory, date);
          return {
            date,
            revPAR: dailyAvailable === 0 ? 0 : Math.round(byDate[date].revenue / dailyAvailable)
          };
        }).sort((a, b) => new Date(a.date) - new Date(b.date));

        return { chartData };
      }
    );

    res.json({ chartData: result.chartData });
  } catch (error) {
    console.error('Error fetching RevPAR report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getRoomTypePerformance = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const result = await ReportsCutoverService.getRoomTypePerformance(
      { startDate, endDate },
      async () => {
        const businessDate = await BusinessDateService.getBusinessDate(pool);
        const rooms = await RoomStatusService.getRoomStatuses(pool, businessDate);
        const [roomTypes] = await pool.query('SELECT * FROM room_types');
        const [bookings] = await pool.query('SELECT * FROM bookings');
        const [statusHistory] = await pool.query('SELECT * FROM room_status_history');

        const roomTypeMap = new Map();
        roomTypes.forEach(rt => {
          const typeRooms = rooms.filter(r => r.room_type_id === rt.id && r.status !== 'inactive');
          roomTypeMap.set(rt.id, {
            id: rt.id,
            name: rt.title,
            totalRooms: typeRooms.length,
            typeRooms,
            occupiedNights: 0
          });
        });

        const validBookings = bookings.filter(b => ['Reserved', 'Checked In', 'Checked Out'].includes(b.booking_status));
        validBookings.forEach(b => {
          const overlap = calculateStayOverlapNights(b, startDate, endDate);
          if (overlap > 0) {
            const room = rooms.find(r => r.id === b.room_id || r.number === b.room_number);
            if (room && roomTypeMap.has(room.room_type_id)) {
              roomTypeMap.get(room.room_type_id).occupiedNights += overlap;
            }
          }
        });

        const roomTypeStats = Array.from(roomTypeMap.values()).map(stat => {
          const availableNights = calculateAvailableRoomNights(stat.typeRooms, statusHistory, startDate, endDate);
          return {
            name: stat.name,
            total: stat.totalRooms,
            occupied: stat.occupiedNights,
            occupancyRate: availableNights === 0 ? 0 : Math.min(100, Math.round((stat.occupiedNights / availableNights) * 100))
          };
        });

        return { roomTypeStats };
      }
    );

    res.json({ roomTypeStats: result.roomTypeStats });
  } catch (error) {
    console.error('Error fetching Room Type Performance report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getPaymentsReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const result = await ReportsCutoverService.getPaymentsReport(
      { startDate, endDate },
      async () => {
        const [payments] = await pool.query('SELECT * FROM payments');
        const filteredPayments = filterRecordsByDateRange(payments, startDate, endDate, 'business_date');

        const paymentMethods = {};
        filteredPayments.forEach(p => {
          const method = p.payment_method || p.payment_type || 'Unknown';
          const amt = getEffectivePaymentAmount(p);
          if (!paymentMethods[method]) paymentMethods[method] = 0;
          paymentMethods[method] += amt;
        });

        const breakdown = Object.keys(paymentMethods).map(name => ({
          name,
          value: paymentMethods[name]
        }));

        return { breakdown, payments: filteredPayments };
      }
    );

    res.json({
      breakdown: result.breakdown,
      payments: result.payments
    });
  } catch (error) {
    console.error('Error fetching Payments report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
