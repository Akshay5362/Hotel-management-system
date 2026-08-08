/**
 * inventoryRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Express API routes for Inventory Management (Categories & Product Master).
 */

import express from 'express';
import {
  getCategories,
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct
} from '../controllers/inventoryController.js';
import { uploadProductPhoto } from '../middleware/inventoryUploadMiddleware.js';
import { requireAdmin } from '../controllers/authController.js';

const router = express.Router();

// Categories route
router.get('/categories', getCategories);

// Products routes
router.get('/products', getProducts);
router.get('/products/:id', getProductById);
router.post('/products', requireAdmin, uploadProductPhoto.single('photo'), createProduct);
router.put('/products/:id', requireAdmin, uploadProductPhoto.single('photo'), updateProduct);
router.delete('/products/:id', requireAdmin, deleteProduct);

export default router;
