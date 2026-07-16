import express from 'express';
import { checkIn, checkOut, clean, addLedgerItem, shift, bookRoom, modifyCheckIn, guestRequestCheckIn, guestAddService, guestReportMaintenance, guestExtendStay, getGuestBill, getGuestNotifications, markNotificationRead, guestRequestCheckout, guestSubmitFeedback, getGuestHistory, getGuestHistoryAdmin, uploadIdentity } from '../controllers/roomController.js';
import { getStatus, runDayEnd, getGuestRequests, resolveGuestRequest, getGuestDocuments, verifyGuestDocument } from '../controllers/auditController.js';
import { uploadIDDocument } from '../middleware/uploadMiddleware.js';
import { signUp, signIn, authenticate, requireAdmin, requireGuest } from '../controllers/authController.js';

const router = express.Router();

// Auth routes
router.post('/auth/signup', signUp);
router.post('/auth/signin', signIn);

// Audit & status routes
router.get('/status', authenticate, getStatus);
router.post('/dayend', authenticate, requireAdmin, runDayEnd);

// Room routes (Admin)
router.post('/rooms/:number/checkin', authenticate, requireAdmin, checkIn);
router.put('/rooms/:number/checkin', authenticate, requireAdmin, modifyCheckIn);
router.post('/rooms/:number/checkout', authenticate, requireAdmin, checkOut);
router.post('/rooms/:number/clean', authenticate, requireAdmin, clean);
router.post('/rooms/:number/ledger', authenticate, requireAdmin, addLedgerItem);
router.post('/rooms/shift', authenticate, requireAdmin, shift);
router.post('/rooms/:number/book', authenticate, bookRoom);

// Guest Portal Phase 2 routes (Guest-facing, no admin required)
router.post('/guest/upload-id', authenticate, requireGuest, uploadIDDocument.single('document'), uploadIdentity);
router.post('/guest/checkin-request', authenticate, requireGuest, guestRequestCheckIn);
router.post('/guest/service', authenticate, requireGuest, guestAddService);
router.post('/guest/maintenance', authenticate, requireGuest, guestReportMaintenance);
router.post('/guest/extend-stay', authenticate, requireGuest, guestExtendStay);
router.get('/guest/bill', authenticate, requireGuest, getGuestBill);
router.get('/guest/notifications', authenticate, requireGuest, getGuestNotifications);
router.put('/guest/notifications/:id/read', authenticate, requireGuest, markNotificationRead);
router.post('/guest/checkout-request', authenticate, requireGuest, guestRequestCheckout);

// Admin — Guest Requests panel
router.get('/admin/guest-requests', authenticate, requireAdmin, getGuestRequests);
router.get('/admin/guest-history/:guestId', authenticate, requireAdmin, getGuestHistoryAdmin);
router.post('/admin/guest-requests/:id/resolve', authenticate, requireAdmin, resolveGuestRequest);
router.get('/admin/guest-documents', authenticate, requireAdmin, getGuestDocuments);
router.post('/admin/guest-documents/:guestId/verify', authenticate, requireAdmin, verifyGuestDocument);

// Guest — History & Feedback (post-checkout)
router.get('/guest/history', authenticate, requireGuest, getGuestHistory);
router.post('/guest/feedback', authenticate, requireGuest, guestSubmitFeedback);

export default router;

