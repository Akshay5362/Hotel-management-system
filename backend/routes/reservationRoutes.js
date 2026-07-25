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
import { authenticate } from '../controllers/authController.js';

const router = express.Router();

// Apply authentication middleware to all reservation routes
router.use(authenticate);

// Reservation routes
router.get('/available-rooms', getAvailableRoomsForReservation);
router.get('/report', getReservationReport);
router.get('/', getReservations);
router.post('/', createReservation);
router.get('/:id', getReservationById);
router.put('/:id', updateReservation);
router.post('/:id/cancel', cancelReservation);
router.post('/:id/checkin', checkInReservation);

export default router;
