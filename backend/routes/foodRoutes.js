/**
 * foodRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Express API routes for the Food / Restaurant POS Module.
 *
 * Phase 1 — Menu Master (categories, items, tax config).
 * Phase 2A — Orders: context lookups + draft order creation.
 * Phase 2B — Order Lifecycle, Atomic Billing, Tables & Complimentary.
 * Phase 2C — Kitchen Display System.
 * Phase 2D-B — Order History back-office API.
 * Phase 2D-C — Reports summary API.
 *
 * Mounted at: /api/food
 * ─────────────────────────────────────────────────────────────────────────────
 */

import express from 'express';
import { authenticate, requireAdmin, requireRole } from '../controllers/authController.js';
import {
  getFoodCategories,
  getFoodCategoryById,
  createFoodCategory,
  updateFoodCategory,
  deleteFoodCategory,

  getFoodMenuItems,
  searchFoodMenuItems,
  getFoodMenuItemById,
  createFoodMenuItem,
  updateFoodMenuItem,
  deleteFoodMenuItem,

  getFoodTaxConfig,
  updateFoodTaxConfig,

  getFoodMeta
} from '../controllers/foodController.js';

import {
  getFoodOrderRoomContext,
  getFoodOrderStaffContext,
  createFoodOrder,
  getFoodOrderById
} from '../controllers/foodOrderController.js';

// ── Phase 2D-B: Order History / Phase 2D-C: Reports ───────────────────────────
import { getOrderHistory, getFoodReportsSummary } from '../controllers/foodReportsController.js';

import {
  placeFoodOrder,
  updateFoodOrderStatus,
  processPayNow,
  processRoomBill,
  cancelFoodOrder,
  listFoodOrders,
  getFoodKDSQueue
} from '../controllers/foodOrderLifecycleController.js';

import {
  requestComplimentary,
  approveComplimentary,
  rejectComplimentary,
  listPendingComplimentary
} from '../controllers/foodComplimentaryController.js';

import {
  getFoodTables,
  getFoodTableById,
  createFoodTable,
  updateFoodTable,
  deleteFoodTable
} from '../controllers/foodTableController.js';

const router = express.Router();

// All food routes require a valid authentication token
router.use(authenticate);

// ── Metadata ──────────────────────────────────────────────────────────────────
router.get('/meta', getFoodMeta);

// ── Food Categories (Phase 1) ─────────────────────────────────────────────────
router.get('/categories', getFoodCategories);
router.get('/categories/:id', getFoodCategoryById);
router.post('/categories', requireAdmin, createFoodCategory);
router.put('/categories/:id', requireAdmin, updateFoodCategory);
router.delete('/categories/:id', requireAdmin, deleteFoodCategory);

// ── Food Menu Items (Phase 1) ─────────────────────────────────────────────────
router.get('/menu-items/search', searchFoodMenuItems);
router.get('/menu-items', getFoodMenuItems);
router.get('/menu-items/:id', getFoodMenuItemById);
router.post('/menu-items', requireAdmin, createFoodMenuItem);
router.put('/menu-items/:id', requireAdmin, updateFoodMenuItem);
router.delete('/menu-items/:id', requireAdmin, deleteFoodMenuItem);

// ── Food Tax Configuration (Phase 1) ──────────────────────────────────────────
router.get('/tax-config', getFoodTaxConfig);
router.put('/tax-config', requireAdmin, updateFoodTaxConfig);

// ── Food Tables Master (Phase 2B) ─────────────────────────────────────────────
router.get('/tables', getFoodTables);
router.get('/tables/:id', getFoodTableById);
router.post('/tables', requireAdmin, createFoodTable);
router.put('/tables/:id', requireAdmin, updateFoodTable);
router.delete('/tables/:id', requireAdmin, deleteFoodTable);

// ── Food Context & Creation (Phase 2A & 2B) ───────────────────────────────────
router.get('/context/rooms', requireAdmin, getFoodOrderRoomContext);
router.get('/context/staff', requireAdmin, getFoodOrderStaffContext);
router.post('/orders', requireRole('admin', 'receptionist'), createFoodOrder);

// ── Food Order Lifecycle & Billing (Phase 2B & 2C) ────────────────────────────
router.get('/orders/kds',     requireRole('admin', 'receptionist', 'kitchen', 'chef'), getFoodKDSQueue);

// Phase 2D-B: must be registered BEFORE /orders/:id to prevent 'history' being
// matched as an order document ID by Express's wildcard route.
router.get('/orders/history', requireRole('admin', 'receptionist', 'manager'),         getOrderHistory);

// ── Phase 2D-C: Reports ────────────────────────────────────────────────────────
router.get('/reports/summary', requireRole('admin', 'receptionist', 'manager'),        getFoodReportsSummary);

router.get('/orders',         requireRole('admin', 'receptionist', 'kitchen', 'chef'), listFoodOrders);
router.get('/orders/:id',     requireRole('admin', 'receptionist', 'kitchen', 'chef'), getFoodOrderById);
router.put('/orders/:id/place', requireRole('admin', 'receptionist'), placeFoodOrder);
router.put('/orders/:id/status', requireRole('admin', 'receptionist', 'kitchen', 'chef'), updateFoodOrderStatus);
router.post('/orders/:id/pay-now', requireRole('admin', 'receptionist'), processPayNow);
router.post('/orders/:id/room-bill', requireRole('admin', 'receptionist'), processRoomBill);
router.post('/orders/:id/cancel', requireRole('admin', 'receptionist'), cancelFoodOrder);

// ── Complimentary Workflow (Phase 2B) ─────────────────────────────────────────
router.post('/orders/:id/complimentary/request', requireRole('admin', 'receptionist'), requestComplimentary);
router.get('/complimentary/pending', requireRole('admin', 'manager'), listPendingComplimentary);
router.post('/complimentary/:requestId/approve', requireRole('admin', 'manager'), approveComplimentary);
router.post('/complimentary/:requestId/reject', requireRole('admin', 'manager'), rejectComplimentary);

export default router;
