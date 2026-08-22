import pool from '../db.js';
import { BusinessDateService } from '../services/businessDateService.js';
import { RoomStatusService } from '../services/roomStatusService.js';
import { isFirestoreReportsShadowEnabled } from '../config/featureFlags.js';
import { FirestoreShadowComparisonService } from '../services/firestoreShadowComparisonService.js';
import { FirestoreReportsService } from '../services/firestoreReportsService.js';
import { ReportsCutoverService } from '../services/reportsCutoverService.js';

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

const filterByDateRange = (records, startDate, endDate, dateField = 'business_date') => {
  const start = startDate ? new Date(startDate) : new Date(0);
  const end = endDate ? new Date(endDate) : new Date();
  end.setHours(23, 59, 59, 999);

  return records.filter(record => {
    let recDate = record[dateField];
    if (recDate instanceof Date) {
      return recDate >= start && recDate <= end;
    }
    const parsed = parseBusinessDate(recDate);
    if (!parsed) return false;
    return parsed >= start && parsed <= end;
  });
};

export const getDashboardOverview = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const result = await ReportsCutoverService.getDashboardOverview(
      { startDate, endDate },
      async () => {
        const [payments] = await pool.query('SELECT * FROM payments');
        const [bookings] = await pool.query('SELECT * FROM bookings');
        const businessDate = await BusinessDateService.getBusinessDate(pool);
        const rooms = await RoomStatusService.getRoomStatuses(pool, businessDate);

        const filteredPayments = filterByDateRange(payments, startDate, endDate, 'business_date');
        const totalRevenue = filteredPayments.reduce((sum, p) => sum + p.amount, 0);

        const filteredBookings = filterByDateRange(bookings, startDate, endDate, 'created_at');
        const totalBookings = filteredBookings.length;

        const totalRooms = rooms.length;
        const occupiedRooms = rooms.filter(r => r.status === 'occupied').length;
        const occupancyRate = totalRooms === 0 ? 0 : Math.round((occupiedRooms / totalRooms) * 100);

        const roomRevenue = filteredBookings.reduce((sum, b) => sum + (b.total_amount || 0), 0);
        const validBookings = filteredBookings.filter(b => ['Reserved', 'Checked In', 'Checked Out'].includes(b.booking_status));
        const totalRoomsBooked = validBookings.length;
        const adr = totalRoomsBooked === 0 ? 0 : Math.round(roomRevenue / totalRoomsBooked);
        const revPAR = totalRooms === 0 ? 0 : Math.round(roomRevenue / totalRooms);

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
        const filteredPayments = filterByDateRange(payments, startDate, endDate, 'business_date');

        const revenueByDate = {};
        const revenueByType = {};

        filteredPayments.forEach(p => {
          const date = p.business_date;
          if (!revenueByDate[date]) revenueByDate[date] = 0;
          revenueByDate[date] += p.amount;

          const type = p.payment_type;
          if (!revenueByType[type]) revenueByType[type] = 0;
          revenueByType[type] += p.amount;
        });

        const chartData = Object.keys(revenueByDate).map(date => ({
          date,
          revenue: revenueByDate[date]
        })).sort((a, b) => parseBusinessDate(a.date) - parseBusinessDate(b.date));

        return {
          total: filteredPayments.reduce((sum, p) => sum + p.amount, 0),
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

        const roomTypeStats = roomTypes.map(rt => {
          const typeRooms = rooms.filter(r => r.room_type_id === rt.id);
          const occupied = typeRooms.filter(r => r.status === 'occupied').length;
          return {
            name: rt.title,
            total: typeRooms.length,
            occupied: occupied,
            occupancyRate: typeRooms.length === 0 ? 0 : Math.round((occupied / typeRooms.length) * 100)
          };
        });

        const statusCounts = {
          'Reserved': 0,
          'Checked In': 0,
          'Checked Out': 0,
          'Cancelled': 0
        };

        const filteredBookings = filterByDateRange(bookings, startDate, endDate, 'created_at');
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
        const filteredGuests = filterByDateRange(guests, startDate, endDate, 'created_at');

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
        const filteredBookings = filterByDateRange(bookings, startDate, endDate, 'created_at');

        const bookingByDate = {};
        filteredBookings.forEach(b => {
          const d = b.created_at.toISOString().split('T')[0];
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
        const filteredBookings = filterByDateRange(bookings, startDate, endDate, 'created_at');

        const cancelled = filteredBookings.filter(b => b.booking_status === 'Cancelled');
        const totalCancelled = cancelled.length;
        const lostRevenue = cancelled.reduce((sum, b) => sum + (b.total_amount || 0), 0);

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
        const filteredPayments = filterByDateRange(payments, startDate, endDate, 'business_date');

        const totalRevenue = filteredPayments.reduce((sum, p) => sum + p.amount, 0);
        const estimatedCosts = totalRevenue * 0.3;
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
        const filteredBookings = filterByDateRange(bookings, startDate, endDate, 'created_at');

        const byDate = {};
        filteredBookings.forEach(b => {
          if (!['Reserved', 'Checked In', 'Checked Out'].includes(b.booking_status)) return;
          const date = b.created_at.toISOString().split('T')[0];
          if (!byDate[date]) byDate[date] = { revenue: 0, rooms: 0 };
          byDate[date].revenue += (b.total_amount || 0);
          byDate[date].rooms += 1;
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
        const businessDate = await BusinessDateService.getBusinessDate(pool);
        const rooms = await RoomStatusService.getRoomStatuses(pool, businessDate);
        const totalRooms = rooms.length;

        const filteredBookings = filterByDateRange(bookings, startDate, endDate, 'created_at');

        const byDate = {};
        filteredBookings.forEach(b => {
          const date = b.created_at.toISOString().split('T')[0];
          if (!byDate[date]) byDate[date] = { revenue: 0 };
          byDate[date].revenue += (b.total_amount || 0);
        });

        const chartData = Object.keys(byDate).map(date => ({
          date,
          revPAR: totalRooms === 0 ? 0 : Math.round(byDate[date].revenue / totalRooms)
        })).sort((a, b) => new Date(a.date) - new Date(b.date));

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

        const roomTypeStats = roomTypes.map(rt => {
          const typeRooms = rooms.filter(r => r.room_type_id === rt.id);
          const occupied = typeRooms.filter(r => r.status === 'occupied').length;
          return {
            name: rt.title,
            total: typeRooms.length,
            occupied: occupied,
            occupancyRate: typeRooms.length === 0 ? 0 : Math.round((occupied / typeRooms.length) * 100)
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
        const filteredPayments = filterByDateRange(payments, startDate, endDate, 'business_date');

        const paymentMethods = {};
        filteredPayments.forEach(p => {
          const method = p.payment_type || 'Unknown';
          if (!paymentMethods[method]) paymentMethods[method] = 0;
          paymentMethods[method] += p.amount;
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
