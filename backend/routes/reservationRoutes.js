import express from 'express';
import {
  createReservation,
  getReservations,
  getReservationById,
  updateReservation,
  cancelReservation,
  checkInReservation,
  getAvailableRoomsForReservation,
  getReservationReport
} from '../controllers/reservationController.js';
import { authenticate, requireRole } from '../controllers/authController.js';

const router = express.Router();

// Apply authentication middleware to all reservation routes
router.use(authenticate);

// Availability checking (shared for authenticated users)
router.get('/available-rooms', getAvailableRoomsForReservation);

// Reservation creation (shared creation path)
router.post('/', createReservation);

// Reservation management operations (Admin & Receptionist only)
router.get('/report', requireRole('admin', 'receptionist'), getReservationReport);
router.get('/', requireRole('admin', 'receptionist'), getReservations);
router.get('/:id', requireRole('admin', 'receptionist'), getReservationById);
router.put('/:id', requireRole('admin', 'receptionist'), updateReservation);
router.post('/:id/cancel', requireRole('admin', 'receptionist'), cancelReservation);
router.post('/:id/checkin', requireRole('admin', 'receptionist'), checkInReservation);

export default router;
