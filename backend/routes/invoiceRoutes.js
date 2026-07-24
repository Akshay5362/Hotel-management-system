import express from 'express';
import { getOrGenerateInvoiceNumber } from '../controllers/invoiceController.js';
import { authenticate, requireAdmin } from '../controllers/authController.js';

const router = express.Router();

router.post('/generate/:bookingId', authenticate, requireAdmin, getOrGenerateInvoiceNumber);

export default router;
