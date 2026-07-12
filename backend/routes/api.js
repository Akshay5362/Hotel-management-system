import express from 'express';
import { checkIn, checkOut, clean, addLedgerItem, shift } from '../controllers/roomController.js';
import { getStatus, runDayEnd } from '../controllers/auditController.js';

const router = express.Router();

// Audit & status routes
router.get('/status', getStatus);
router.post('/dayend', runDayEnd);

// Room routes
router.post('/rooms/:number/checkin', checkIn);
router.post('/rooms/:number/checkout', checkOut);
router.post('/rooms/:number/clean', clean);
router.post('/rooms/:number/ledger', addLedgerItem);
router.post('/rooms/shift', shift);

export default router;
