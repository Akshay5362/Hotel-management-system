import express from 'express';
import { checkIn, checkOut, clean, addLedgerItem, shift, bookRoom, modifyCheckIn } from '../controllers/roomController.js';
import { getStatus, runDayEnd } from '../controllers/auditController.js';
import { signUp, signIn, authenticate, requireAdmin } from '../controllers/authController.js';

const router = express.Router();

// Auth routes
router.post('/auth/signup', signUp);
router.post('/auth/signin', signIn);

// Audit & status routes
router.get('/status', authenticate, getStatus);
router.post('/dayend', authenticate, requireAdmin, runDayEnd);

// Room routes
router.post('/rooms/:number/checkin', authenticate, requireAdmin, checkIn);
router.put('/rooms/:number/checkin', authenticate, requireAdmin, modifyCheckIn);
router.post('/rooms/:number/checkout', authenticate, requireAdmin, checkOut);
router.post('/rooms/:number/clean', authenticate, requireAdmin, clean);
router.post('/rooms/:number/ledger', authenticate, requireAdmin, addLedgerItem);
router.post('/rooms/shift', authenticate, requireAdmin, shift);
router.post('/rooms/:number/book', authenticate, bookRoom);

export default router;
