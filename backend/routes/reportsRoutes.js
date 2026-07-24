import express from 'express';
import {
  getDashboardOverview,
  getRevenueReport,
  getOccupancyReport,
  getGuestAnalytics,
  getBookingAnalytics,
  getCancellationReport,
  getProfitReport,
  getADRReport,
  getRevPARReport,
  getRoomTypePerformance,
  getPaymentsReport
} from '../controllers/reportsController.js';
import { authenticate, requireAdmin } from '../controllers/authController.js';

const router = express.Router();

// Apply auth middleware to all report routes
router.use(authenticate, requireAdmin);

router.get('/dashboard', getDashboardOverview);
router.get('/revenue', getRevenueReport);
router.get('/occupancy', getOccupancyReport);
router.get('/guests', getGuestAnalytics);
router.get('/bookings', getBookingAnalytics);
router.get('/cancellations', getCancellationReport);
router.get('/profit', getProfitReport);
router.get('/adr', getADRReport);
router.get('/revpar', getRevPARReport);
router.get('/room-types', getRoomTypePerformance);
router.get('/payments', getPaymentsReport);

export default router;
