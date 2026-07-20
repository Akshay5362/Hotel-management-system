/**
 * paymentRoutes.js
 * ---------------------------------------------------------------------------
 * Phase 2 Payment Module Routes
 *
 * POST /api/payments/finalize            → Finalise payment after bookRoom()
 * GET  /api/payments/booking/:bookingId  → All payments for a booking
 * GET  /api/payments/guest/my            → Current guest's payment history
 */

import express from 'express';
import { finalizePayment, getPaymentsByBooking, getMyPayments, confirmCashPayment, getGuestPaymentStatus } from '../controllers/paymentController.js';
import { createRazorpayOrder, verifyRazorpayPayment } from '../controllers/razorpayController.js';
import { authenticate, requireGuest, requireAdmin } from '../controllers/authController.js';

const router = express.Router();

// ── Razorpay Online Payments ───────────────────────────────────────────────
router.post('/razorpay/order', authenticate, requireGuest, createRazorpayOrder);
router.post('/razorpay/verify', authenticate, requireGuest, verifyRazorpayPayment);

// ── Guest-facing ───────────────────────────────────────────────────────────

// Finalise a booking's payment (called by guest portal after bookRoom succeeds)
router.post('/finalize', authenticate, requireGuest, finalizePayment);

// Guest's own complete payment history
router.get('/guest/my', authenticate, requireGuest, getMyPayments);

// Guest checks whether their active booking's payment is confirmed
router.get('/guest/payment-status', authenticate, requireGuest, getGuestPaymentStatus);

// ── Shared (admin + owning guest) ────────────────────────────────────

// All payments for a specific booking (guest sees only their own)
router.get('/booking/:bookingId', authenticate, getPaymentsByBooking);

// ── Admin only ────────────────────────────────────────────────────────

// Confirm that guest's cash advance was received at reception (unlocks Check In Now)
router.put('/booking/:bookingId/confirm-cash', authenticate, requireAdmin, confirmCashPayment);

export default router;
