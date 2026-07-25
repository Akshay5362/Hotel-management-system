import express from 'express';
import { checkIn, checkOut, clean, addLedgerItem, shift, bookRoom, modifyCheckIn, guestRequestCheckIn, guestAddService, guestReportMaintenance, guestExtendStay, getGuestBill, getGuestNotifications, markNotificationRead, guestRequestCheckout, guestSubmitFeedback, getGuestHistory, getGuestHistoryAdmin, uploadIdentity, getRefundPolicy, updateRefundPolicy, processRefundCheckout, getPublicRooms, adminExtendStay, adminLateCheckout, adminNoShow, updateRoomStatus } from '../controllers/roomController.js';
import { getStatus, runDayEnd, getGuestRequests, resolveGuestRequest, resolveExtensionRequest, getGuestDocuments, verifyGuestDocument, deleteGuestDocument, searchGuests, listGuests, searchGuestsStaff } from '../controllers/auditController.js';
import { getBusinessDateInfo, updateBusinessDate } from '../controllers/settingsController.js';
import { submitCash, getCashSubmissions } from '../controllers/cashController.js';
import { staffLogin, getAllStaff, getStaffById, createStaff, updateStaff, updateStaffStatus, deleteStaff } from '../controllers/staffController.js';
import { uploadIDDocument } from '../middleware/uploadMiddleware.js';
import { signUp, signIn, authenticate, requireAdmin, requireGuest } from '../controllers/authController.js';
import paymentRoutes from './paymentRoutes.js';
import reportsRoutes from './reportsRoutes.js';
import invoiceRoutes from './invoiceRoutes.js';
import housekeepingRoutes from './housekeepingRoutes.js';
import staffRoutes from './staffRoutes.js';
import reservationRoutes from './reservationRoutes.js';

const router = express.Router();

// Public routes
router.get('/public/rooms', getPublicRooms);

// Auth routes
router.post('/auth/signup', signUp);
router.post('/auth/signin', signIn);

// ── Staff Auth (public — no token required) ───────────────────────────────────────
router.post('/staff/auth/login', staffLogin);

// Audit & status routes
router.get('/status', authenticate, getStatus);
router.post('/dayend', authenticate, requireAdmin, runDayEnd);

// Settings routes
router.get('/settings/business-date', authenticate, getBusinessDateInfo);
router.post('/settings/business-date', authenticate, requireAdmin, updateBusinessDate);

// Room routes (Admin)
router.post('/rooms/:number/checkin', authenticate, requireAdmin, checkIn);
router.put('/rooms/:number/checkin', authenticate, requireAdmin, modifyCheckIn);
router.post('/rooms/:number/checkout', authenticate, requireAdmin, checkOut);
router.post('/rooms/:number/clean', authenticate, requireAdmin, clean);
router.post('/rooms/:number/ledger', authenticate, requireAdmin, addLedgerItem);
router.post('/rooms/shift', authenticate, requireAdmin, shift);
router.post('/rooms/:number/book', authenticate, bookRoom);
router.post('/rooms/:number/refund-checkout', authenticate, requireAdmin, processRefundCheckout);
router.post('/rooms/:number/extend-stay', authenticate, requireAdmin, adminExtendStay);
router.post('/rooms/:number/late-checkout', authenticate, requireAdmin, adminLateCheckout);
router.post('/rooms/:number/no-show', authenticate, requireAdmin, adminNoShow);
router.put('/rooms/:number/status', authenticate, updateRoomStatus);

// Refund Policy routes (Admin only)
router.get('/refund-policy', authenticate, requireAdmin, getRefundPolicy);
router.put('/refund-policy', authenticate, requireAdmin, updateRefundPolicy);

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
router.post('/admin/guest-requests/extension/:id/resolve', authenticate, requireAdmin, resolveExtensionRequest);
router.get('/admin/guest-documents', authenticate, requireAdmin, getGuestDocuments);
router.post('/admin/guest-documents/:guestId/verify', authenticate, requireAdmin, verifyGuestDocument);
router.delete('/admin/guest-documents/:guestId', authenticate, requireAdmin, deleteGuestDocument);
router.get('/admin/guests', authenticate, requireAdmin, listGuests);
router.get('/admin/guests/search', authenticate, requireAdmin, searchGuests);

// Guest — History & Feedback (post-checkout)
router.get('/guest/history', authenticate, requireGuest, getGuestHistory);
router.post('/guest/feedback', authenticate, requireGuest, guestSubmitFeedback);

// ── Reception Staff — Guest Search (no requireAdmin) ──────────────────────
router.get('/reception/guests/search', authenticate, searchGuestsStaff);
router.get('/reception/guests/history/:guestId', authenticate, getGuestHistoryAdmin);

// ── Payment Module (Phase 2) ────────────────────────────────────────────────
router.use('/payments', paymentRoutes);

// ── Reports Module (Phase 2) ────────────────────────────────────────────────
router.use('/reports', reportsRoutes);

// ── Invoices Module (Phase 2) ───────────────────────────────────────────────
router.use('/invoices', invoiceRoutes);

// ── Housekeeping Module ─────────────────────────────────────────────────────
router.use('/housekeeping', authenticate, requireAdmin, housekeepingRoutes);

// ── Cash Handover Module ─────────────────────────────────────────────────────
router.post('/cash/submit', authenticate, submitCash);
router.get('/cash/submissions', authenticate, getCashSubmissions);

// ── Staff Management Module ──────────────────────────────────────────────────
router.use('/staff', authenticate, requireAdmin, staffRoutes);

// ── Reservation Module ───────────────────────────────────────────────────────
router.use('/reservations', reservationRoutes);

export default router;
