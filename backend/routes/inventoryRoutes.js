/**
 * inventoryRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Express API routes for Inventory (Phase A: masters, stock, movements).
 * Mounted at /api/inventory behind `authenticate` (see routes/api.js).
 *
 * RBAC (strict, server-enforced via requireRole — normalized role names):
 *   VIEW   admin, super_admin, receptionist, kitchen, housekeeper
 *          → categories/units/locations lists, products (read), stock, movements
 *   MANAGE admin, super_admin
 *          → create/update/deactivate masters & products, suppliers, opening stock
 *   MOVE   admin, super_admin, kitchen, housekeeper
 *          → adjustments and transfers
 * `requireAdmin` is deliberately NOT used here (it admits every staff role).
 */

import express from 'express';
import { requireRole } from '../controllers/authController.js';
import { INVENTORY_ROLES, RECEIVING_ROLES, REVERSAL_ROLES, SHORT_CLOSE_ROLES } from '../utils/inventoryConstants.js';
import { uploadProductPhoto } from '../middleware/inventoryUploadMiddleware.js';
import {
  getApprovalAuthorities, getApprovalAuthorityByUid, upsertApprovalAuthority,
  activateApprovalAuthority, deactivateApprovalAuthority
} from '../controllers/inventoryApprovalAuthoritiesController.js';
import { billUpload, verifyUploadedBill } from '../middleware/billUploadMiddleware.js';
import { uploadBill, listBills, getBill, streamBillFile, discardBill, extractBill, interpretBill, getBillLines, confirmBillAgainstPO, confirmBillDirect, reverseDirectReceipt,
  getBillDuplicates
} from '../controllers/billController.js';
import {
  getCategories, createCategory, updateCategory, deleteCategory,
  getProducts, getProductById, createProduct, updateProduct, deleteProduct
} from '../controllers/inventoryController.js';
import {
  getUnits, createUnit, updateUnit, deleteUnit,
  getLocations, createLocation, updateLocation, deleteLocation,
  getSuppliers, getSupplierById, createSupplier, updateSupplier, deleteSupplier
} from '../controllers/inventoryMastersController.js';
import {
  getStock, getMovements, getProductMovements, postOpeningStock, postMovement
} from '../controllers/inventoryStockController.js';
import {
  getPurchaseOrders, getPurchaseOrderById, createPurchaseOrder, issuePurchaseOrder
} from '../controllers/purchaseOrderController.js';
import { createGoodsReceipt, getGoodsReceiptsForOrder } from '../controllers/goodsReceiptController.js';
import { reverseGoodsReceipt, closePurchaseOrderShort } from '../controllers/receiptCorrectionController.js';
import {
  createPurchaseRequest, getPurchaseRequests, getPurchaseRequestById,
  updatePurchaseRequest, submitPurchaseRequest, cancelPurchaseRequest,
  approvePurchaseRequest, rejectPurchaseRequest, getPurchaseRequestApprovalConfig,
  updatePurchaseRequestApprovalConfig
} from '../controllers/purchaseRequestController.js';

const router = express.Router();

const VIEW   = requireRole(...INVENTORY_ROLES.VIEW);
const MANAGE = requireRole(...INVENTORY_ROLES.MANAGE);
const MOVE   = requireRole(...INVENTORY_ROLES.MOVE);
const REQUEST = requireRole(...INVENTORY_ROLES.REQUEST);
// Phase F — receiving is the only purchasing action that changes stock.
// Deliberately NOT the MANAGE set: a receptionist signs for deliveries at the
// front desk, while kitchen/housekeeper roles do not.
const RECEIVE = requireRole(...RECEIVING_ROLES);
// Phase G — corrections are NARROWER than receiving. Undoing a delivery or
// writing off an outstanding balance changes stock and closes a purchasing
// commitment, so a receptionist who may sign for goods may not reverse them.
const REVERSE     = requireRole(...REVERSAL_ROLES);
const SHORT_CLOSE = requireRole(...SHORT_CLOSE_ROLES);

/** multer error → 400 instead of a generic 500 */
function photoUpload(req, res, next) {
  uploadProductPhoto.single('photo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Photo upload failed.' });
    next();
  });
}

// Categories
router.get('/categories', VIEW, getCategories);
router.post('/categories', MANAGE, createCategory);
router.put('/categories/:id', MANAGE, updateCategory);
router.delete('/categories/:id', MANAGE, deleteCategory);

// Units
router.get('/units', VIEW, getUnits);
router.post('/units', MANAGE, createUnit);
router.put('/units/:id', MANAGE, updateUnit);
router.delete('/units/:id', MANAGE, deleteUnit);

// Locations
router.get('/locations', VIEW, getLocations);
router.post('/locations', MANAGE, createLocation);
router.put('/locations/:id', MANAGE, updateLocation);
router.delete('/locations/:id', MANAGE, deleteLocation);

// Suppliers (never exposed to VIEW-only roles)
router.get('/suppliers', MANAGE, getSuppliers);
router.get('/suppliers/:id', MANAGE, getSupplierById);
router.post('/suppliers', MANAGE, createSupplier);
router.put('/suppliers/:id', MANAGE, updateSupplier);
router.delete('/suppliers/:id', MANAGE, deleteSupplier);

// Stock & ledger (declared before /products/:id so the static path wins)
router.get('/stock', VIEW, getStock);
router.get('/movements', VIEW, getMovements);
router.post('/movements', MOVE, postMovement);

// Purchase requests (Phase B) — a REQUEST to buy: never an order, a receipt,
// a stock addition or a payment. None of these endpoints touch stock.
// Ownership (draft edit/cancel) is enforced again inside the service layer.
router.get('/purchase-requests', REQUEST, getPurchaseRequests);
router.post('/purchase-requests', REQUEST, createPurchaseRequest);
// Declared BEFORE '/purchase-requests/:id' so the static path is not matched
// as a request id.
router.get('/purchase-requests/approval-config', REQUEST, getPurchaseRequestApprovalConfig);
// Changing WHO may approve is an administrator action (MANAGE), and the
// controller re-checks the role because this configuration is itself an
// authorization boundary.
router.put('/purchase-requests/approval-config', MANAGE, updatePurchaseRequestApprovalConfig);
router.get('/purchase-requests/:id', REQUEST, getPurchaseRequestById);
router.put('/purchase-requests/:id', REQUEST, updatePurchaseRequest);
router.post('/purchase-requests/:id/submit', REQUEST, submitPurchaseRequest);
router.post('/purchase-requests/:id/cancel', REQUEST, cancelPurchaseRequest);

// Phase C — approval decisions. The route-level role set is intentionally the
// broad REQUEST set; the REAL approval authorization (settings-driven approver
// roles + the self-approval block) is enforced inside
// purchaseRequestApprovalService, which every decision must pass through.
router.post('/purchase-requests/:id/approve', REQUEST, approvePurchaseRequest);
router.post('/purchase-requests/:id/reject', REQUEST, rejectPurchaseRequest);

// Phase H1 — WhatsApp approval authorities: who may be NOTIFIED of a pending
// request, and on which number. MANAGE (admin, super_admin) throughout, so no
// staff member can register themselves. These records carry reachability only;
// the right to approve is still resolved from settings/inventory_pr_approval
// at decision time, inside purchaseRequestApprovalService. PUT keyed by uid
// rather than POST, because the uid IS the identity and a repeat must update
// the one record instead of creating a second.
router.get('/approval-authorities', MANAGE, getApprovalAuthorities);
router.get('/approval-authorities/:uid', MANAGE, getApprovalAuthorityByUid);
router.put('/approval-authorities/:uid', MANAGE, upsertApprovalAuthority);
router.post('/approval-authorities/:uid/activate', MANAGE, activateApprovalAuthority);
router.post('/approval-authorities/:uid/deactivate', MANAGE, deactivateApprovalAuthority);

// Purchase orders (Phase E) — the formal document issued to ONE supplier,
// created from exactly ONE approved request. MANAGE-only: a PO carries
// supplier identity and pricing, which Phase A already restricted to MANAGE.
// Creating or issuing a PO never touches stock (receiving is Phase F).
router.get('/purchase-orders', MANAGE, getPurchaseOrders);
router.post('/purchase-orders', MANAGE, createPurchaseOrder);
router.get('/purchase-orders/:id', MANAGE, getPurchaseOrderById);
router.post('/purchase-orders/:id/issue', MANAGE, issuePurchaseOrder);

// Goods receiving (Phase F). Posting a receipt increases stock by the quantity
// ACCEPTED — receipt, PO state and stock ledger commit in one transaction.
router.get('/purchase-orders/:id/receipts', RECEIVE, getGoodsReceiptsForOrder);
router.post('/purchase-orders/:id/receipts', RECEIVE, createGoodsReceipt);

// Receipt correction & short close (Phase G). A reversal posts a compensating
// REVERSAL movement and recomputes the order's receiving position from the
// surviving receipts; a short close writes off the outstanding balance and
// moves NO stock at all. Both require admin/super_admin.
router.post('/purchase-orders/:id/receipts/:receiptId/reverse', REVERSE, reverseGoodsReceipt);
router.post('/purchase-orders/:id/close-short', SHORT_CLOSE, closePurchaseOrderShort);

// Products
router.get('/products', VIEW, getProducts);
router.get('/products/:id/movements', VIEW, getProductMovements);
router.post('/products/:id/opening-stock', MANAGE, postOpeningStock);
router.get('/products/:id', VIEW, getProductById);
router.post('/products', MANAGE, photoUpload, createProduct);
router.put('/products/:id', MANAGE, photoUpload, updateProduct);
router.delete('/products/:id', MANAGE, deleteProduct);

// ── Supplier bills — Phase H1 ────────────────────────────────────────────────
// Upload, retrieval and discard only. NOTHING here moves stock: extraction,
// matching, review and both confirmation paths arrive in H2–H6.
//
// RECEIVE (RECEIVING_ROLES) is the correct gate: a bill is the paperwork for a
// delivery, so whoever may sign for goods may capture the bill. It is
// deliberately NOT the broader VIEW set — a bill exposes purchase pricing.
router.get('/bills', RECEIVE, listBills);
router.post('/bills', RECEIVE, billUpload, verifyUploadedBill, uploadBill);
router.get('/bills/:id', RECEIVE, getBill);
router.get('/bills/:id/file', RECEIVE, streamBillFile);
// H2 — re-run OCR. Manual reaper for a bill stranded in EXTRACTING by a restart,
// and the retry path for a poor extraction. Synchronous by design.
router.post('/bills/:id/extract', RECEIVE, extractBill);
// H3 — parse the OCR text into reviewable lines and propose matches. Writes only
// bill + bill-line documents; moves no stock and creates no receipt.
router.post('/bills/:id/interpret', RECEIVE, interpretBill);
router.get('/bills/:id/lines', RECEIVE, getBillLines);
// H7 — read-only duplicate signals for the review screen. RECEIVE-guarded like
// the rest of the bill surface: the response names other bills and their
// invoice references, which is purchasing information.
router.get('/bills/:id/duplicates', RECEIVE, getBillDuplicates);
// H5 / H6 — the ONLY stock-affecting bill endpoints. RECEIVE matches the Phase F
// receiving gate; the direct reversal uses the narrower Phase G gate because
// undoing a delivery is a stronger action than signing for one.
router.post('/bills/:id/confirm-po', RECEIVE, confirmBillAgainstPO);
router.post('/bills/:id/confirm-direct', RECEIVE, confirmBillDirect);
router.post('/receipts/:id/reverse-direct', REVERSE, reverseDirectReceipt);
router.delete('/bills/:id', RECEIVE, discardBill);

export default router;
