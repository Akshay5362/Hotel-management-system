import express from 'express';
import { checkIn, checkOut, clean, addLedgerItem, recordPayment, adjustRoomRent, shift, bookRoom, modifyCheckIn, guestRequestCheckIn, guestAddService, guestReportMaintenance, guestExtendStay, getGuestBill, getGuestNotifications, markNotificationRead, guestRequestCheckout, guestSubmitFeedback, getGuestHistory, getGuestHistoryAdmin, uploadIdentity, getRefundPolicy, updateRefundPolicy, processRefundCheckout, getPublicRooms, adminExtendStay, adminLateCheckout, adminNoShow, updateRoomStatus, getLedger } from '../controllers/roomController.js';
import { getStatus, runDayEnd, undoDayEnd, getGuestRequests, resolveGuestRequest, resolveExtensionRequest, getGuestDocuments, verifyGuestDocument, deleteGuestDocument, streamGuestDocument, searchGuests, listGuests, searchGuestsStaff } from '../controllers/auditController.js';
import { getBusinessDateInfo, updateBusinessDate, getHotelConfig, updateHotelConfig } from '../controllers/settingsController.js';
import { submitCash, getCashSubmissions } from '../controllers/cashController.js';
import { staffLogin, getAllStaff, getStaffById, createStaff, updateStaff, updateStaffStatus, deleteStaff } from '../controllers/staffController.js';
import { uploadIDDocument } from '../middleware/uploadMiddleware.js';
import { signUp, signIn, authenticate, requireAdmin, requireSuperAdmin, requireGuest, requireRole, getMe } from '../controllers/authController.js';
import paymentRoutes from './paymentRoutes.js';
import reportsRoutes from './reportsRoutes.js';
import invoiceRoutes from './invoiceRoutes.js';
import housekeepingRoutes from './housekeepingRoutes.js';
import staffRoutes from './staffRoutes.js';
import reservationRoutes from './reservationRoutes.js';

import factoryResetRoutes from './factoryResetRoutes.js';
import inventoryRoutes from './inventoryRoutes.js';
import roomTypeRoutes from './roomTypeRoutes.js';
import foodRoutes from './foodRoutes.js';          // ── Food / Restaurant POS (Phase 1)

const router = express.Router();


// Public routes
router.get('/public/rooms', getPublicRooms);

// Auth routes
router.post('/auth/signup', signUp);
router.post('/auth/signin', signIn);

// ── Identity Resolution — Secure role lookup for Firebase-authenticated staff ─
// Does NOT use `authenticate` middleware: getMe performs its own full verification
// so that the admin/staff role is sourced from the server-side Firebase token
// + MySQL record, never from client-supplied body data.
router.get('/auth/me', getMe);

// ── Staff Auth (public — no token required) ───────────────────────────────────────
router.post('/staff/auth/login', staffLogin);

// Audit & status routes
router.get('/status', authenticate, requireRole('admin', 'receptionist'), getStatus);
router.post('/dayend', authenticate, requireRole('admin'), runDayEnd);
router.post('/dayend/undo', authenticate, requireSuperAdmin, undoDayEnd);

// Settings routes
// NOTE: GET is open to all authenticated users (read-only).
// POST uses permission-based authorization inside the controller
// (hasPermission('override_business_date')) — not role-hardcoded middleware.
// This allows fine-grained control via the roles/permissions tables.
router.get('/settings/business-date', authenticate, getBusinessDateInfo);
router.post('/settings/business-date', authenticate, updateBusinessDate);
router.get('/settings/hotel-config', getHotelConfig);
router.post('/settings/hotel-config', authenticate, requireAdmin, updateHotelConfig);

// Room routes (Admin & Receptionist)
router.post('/rooms/:number/checkin', authenticate, requireRole('admin', 'receptionist'), checkIn);
router.put('/rooms/:number/checkin', authenticate, requireRole('admin', 'receptionist'), modifyCheckIn);
router.post('/rooms/:number/checkout', authenticate, requireRole('admin', 'receptionist'), checkOut);
router.post('/rooms/:number/clean', authenticate, requireRole('admin', 'receptionist', 'housekeeper'), clean);
router.post('/rooms/:number/ledger', authenticate, requireRole('admin', 'receptionist'), addLedgerItem);
router.post('/rooms/:number/adjust-rent', authenticate, requireRole('admin', 'receptionist'), adjustRoomRent);
router.post('/rooms/:number/payments', authenticate, requireRole('admin', 'receptionist'), recordPayment);
router.get('/rooms/:number/ledger', authenticate, requireRole('admin', 'receptionist'), getLedger);
router.post('/rooms/shift', authenticate, requireRole('admin', 'receptionist'), shift);
router.post('/rooms/:number/book', authenticate, bookRoom);
router.post('/rooms/:number/refund-checkout', authenticate, requireRole('admin'), processRefundCheckout);
router.post('/rooms/:number/extend-stay', authenticate, requireRole('admin', 'receptionist'), adminExtendStay);
router.post('/rooms/:number/late-checkout', authenticate, requireRole('admin', 'receptionist'), adminLateCheckout);
router.post('/rooms/:number/no-show', authenticate, requireRole('admin', 'receptionist'), adminNoShow);
router.put('/rooms/:number/status', authenticate, requireRole('admin', 'receptionist', 'housekeeper'), updateRoomStatus);

// Refund Policy routes (Admin only)
router.get('/refund-policy', authenticate, requireRole('admin'), getRefundPolicy);
router.put('/refund-policy', authenticate, requireRole('admin'), updateRefundPolicy);

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
router.get('/admin/guest-requests', authenticate, requireRole('admin', 'receptionist'), getGuestRequests);
router.get('/admin/guest-history/:guestId', authenticate, requireRole('admin', 'receptionist'), getGuestHistoryAdmin);
router.post('/admin/guest-requests/:id/resolve', authenticate, requireRole('admin', 'receptionist'), resolveGuestRequest);
router.post('/admin/guest-requests/extension/:id/resolve', authenticate, requireRole('admin', 'receptionist'), resolveExtensionRequest);
router.get('/admin/guest-documents', authenticate, requireRole('admin', 'receptionist'), getGuestDocuments);
router.get('/admin/guest-documents/file/:filename', authenticate, requireRole('admin', 'receptionist'), streamGuestDocument);
router.post('/admin/guest-documents/:guestId/verify', authenticate, requireRole('admin', 'receptionist'), verifyGuestDocument);
router.delete('/admin/guest-documents/:guestId', authenticate, requireRole('admin'), deleteGuestDocument);
router.get('/admin/guests', authenticate, requireRole('admin', 'receptionist'), listGuests);
router.get('/admin/guests/search', authenticate, requireRole('admin', 'receptionist'), searchGuests);

// Guest — History & Feedback (post-checkout)
router.get('/guest/history', authenticate, requireGuest, getGuestHistory);
router.post('/guest/feedback', authenticate, requireGuest, guestSubmitFeedback);

// ── Reception Staff — Guest Search ──────────────────────────────────────────
router.get('/reception/guests/search', authenticate, requireRole('admin', 'receptionist'), searchGuestsStaff);
router.get('/reception/guests/history/:guestId', authenticate, requireRole('admin', 'receptionist'), getGuestHistoryAdmin);

// ── Payment Module (Phase 2) ────────────────────────────────────────────────
router.use('/payments', paymentRoutes);

// ── Reports Module (Phase 2) ────────────────────────────────────────────────
router.use('/reports', reportsRoutes);

// ── Invoices Module (Phase 2) ───────────────────────────────────────────────
router.use('/invoices', invoiceRoutes);

// ── Housekeeping Module ─────────────────────────────────────────────────────
router.use('/housekeeping', authenticate, requireRole('admin', 'receptionist', 'housekeeper'), housekeepingRoutes);

// ── Cash Handover Module ─────────────────────────────────────────────────────
router.post('/cash/submit', authenticate, requireRole('admin', 'receptionist'), submitCash);
router.get('/cash/submissions', authenticate, requireRole('admin', 'receptionist'), getCashSubmissions);

// ── Staff Management Module ──────────────────────────────────────────────────
router.use('/staff', authenticate, requireRole('admin'), staffRoutes);

// ── Reservation Module ───────────────────────────────────────────────────────
router.use('/reservations', reservationRoutes);

// ── Inventory Module ────────────────────────────────────────────────────────
router.use('/inventory', authenticate, inventoryRoutes);

// ── Room Types Module (Phase 3B Pilot) ─────────────────────────────────────
router.use('/room-types', roomTypeRoutes);

// ── Factory Reset Module (Phase 1 Architecture) ─────────────────────────────
router.use('/system/factory-reset', factoryResetRoutes);

// ── Food / Restaurant POS Module (Phase 1 — Menu Master) ────────────────────
// auth is applied per-route inside foodRoutes.js
router.use('/food', foodRoutes);

export default router;

