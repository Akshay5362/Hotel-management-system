import express from 'express';
import { getOrGenerateInvoiceNumber, getMasterBill } from '../controllers/invoiceController.js';
import { authenticate, requireAdmin } from '../controllers/authController.js';

const router = express.Router();

router.post('/generate/:bookingId', authenticate, requireAdmin, getOrGenerateInvoiceNumber);
router.get('/master-bill/:bookingId', authenticate, getMasterBill);
router.get('/:bookingId/master-bill', authenticate, getMasterBill);

export default router;
