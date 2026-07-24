import pool from '../db.js';

// Helper to parse 'DD-MMM-YYYY' to a comparable Date object
const parseBusinessDate = (dateStr) => {
  if (!dateStr) return null;
  // If it's already a standard format like YYYY-MM-DD
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
    // if it's created_at (timestamp)
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
    
    // Fetch relevant data
    const [payments] = await pool.query('SELECT * FROM payments');
    const [bookings] = await pool.query('SELECT * FROM bookings');
    const [rooms] = await pool.query('SELECT * FROM rooms');
    const [roomTypes] = await pool.query('SELECT * FROM room_types');

    const filteredPayments = filterByDateRange(payments, startDate, endDate, 'business_date');
    
    // Total Revenue from payments
    const totalRevenue = filteredPayments.reduce((sum, p) => sum + p.amount, 0);

    // Bookings created in this period
    const filteredBookings = filterByDateRange(bookings, startDate, endDate, 'created_at');
    const totalBookings = filteredBookings.length;

    // Occupancy logic
    const totalRooms = rooms.length;
    const occupiedRooms = rooms.filter(r => r.status === 'occupied').length;
    const occupancyRate = totalRooms === 0 ? 0 : Math.round((occupiedRooms / totalRooms) * 100);

    // ADR = Total Room Revenue / Total Rooms Booked (Confirmed + Checked Out bookings only)
    const roomRevenue = filteredBookings.reduce((sum, b) => sum + (b.total_amount || 0), 0);
    const validBookings = filteredBookings.filter(b => ['Reserved', 'Checked In', 'Checked Out'].includes(b.booking_status));
    const totalRoomsBooked = validBookings.length;
    const adr = totalRoomsBooked === 0 ? 0 : Math.round(roomRevenue / totalRoomsBooked);

    // RevPAR = Total Room Revenue / Total Available Rooms
    const revPAR = totalRooms === 0 ? 0 : Math.round(roomRevenue / totalRooms);

    res.json({
      totalRevenue,
      occupancyRate,
      totalBookings,
      adr,
      revPAR
    });

  } catch (error) {
    console.error('Error fetching dashboard overview:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getRevenueReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const [payments] = await pool.query('SELECT * FROM payments');
    const filteredPayments = filterByDateRange(payments, startDate, endDate, 'business_date');

    // Group by business_date
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

    res.json({
      total: filteredPayments.reduce((sum, p) => sum + p.amount, 0),
      chartData,
      breakdown: revenueByType
    });
  } catch (error) {
    console.error('Error fetching revenue report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getOccupancyReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const [rooms] = await pool.query('SELECT * FROM rooms');
    const [roomTypes] = await pool.query('SELECT * FROM room_types');
    const [bookings] = await pool.query('SELECT * FROM bookings');

    // Room Type Performance
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

    // We can also analyze booking status
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

    res.json({
      roomTypeStats,
      bookingStatus: statusCounts
    });
  } catch (error) {
    console.error('Error fetching occupancy report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getGuestAnalytics = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
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

    res.json({
      totalGuests: filteredGuests.length,
      loyaltyStats: Object.keys(loyaltyStats).map(name => ({ name, value: loyaltyStats[name] })),
      genderStats: Object.keys(genderStats).map(name => ({ name, value: genderStats[name] }))
    });
  } catch (error) {
    console.error('Error fetching guest analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getBookingAnalytics = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
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

    res.json({
      totalBookings: filteredBookings.length,
      chartData
    });
  } catch (error) {
    console.error('Error fetching booking analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getCancellationReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const [bookings] = await pool.query('SELECT * FROM bookings');
    const filteredBookings = filterByDateRange(bookings, startDate, endDate, 'created_at');
    
    const cancelled = filteredBookings.filter(b => b.booking_status === 'Cancelled');
    const totalCancelled = cancelled.length;
    const lostRevenue = cancelled.reduce((sum, b) => sum + (b.total_amount || 0), 0);
    
    res.json({
      totalCancelled,
      lostRevenue,
      cancellations: cancelled
    });
  } catch (error) {
    console.error('Error fetching cancellation report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getProfitReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const [payments] = await pool.query('SELECT * FROM payments');
    const filteredPayments = filterByDateRange(payments, startDate, endDate, 'business_date');
    
    const totalRevenue = filteredPayments.reduce((sum, p) => sum + p.amount, 0);
    // Assuming 30% operating costs for a simplified profit report
    const estimatedCosts = totalRevenue * 0.3;
    const estimatedProfit = totalRevenue - estimatedCosts;
    
    res.json({
      totalRevenue,
      estimatedCosts,
      estimatedProfit
    });
  } catch (error) {
    console.error('Error fetching profit report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};


export const getADRReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
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

    res.json({ chartData });
  } catch (error) {
    console.error('Error fetching ADR report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getRevPARReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const [bookings] = await pool.query('SELECT * FROM bookings');
    const [rooms] = await pool.query('SELECT * FROM rooms');
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

    res.json({ chartData });
  } catch (error) {
    console.error('Error fetching RevPAR report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getRoomTypePerformance = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const [rooms] = await pool.query('SELECT * FROM rooms');
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

    res.json({ roomTypeStats });
  } catch (error) {
    console.error('Error fetching Room Type Performance report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getPaymentsReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
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

    res.json({ breakdown, payments: filteredPayments });
  } catch (error) {
    console.error('Error fetching Payments report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

