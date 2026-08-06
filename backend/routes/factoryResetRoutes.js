import express from 'express';
import { factoryReset, getFactoryResetStatus } from '../controllers/factoryResetController.js';
import { authenticate, requireSuperAdmin } from '../controllers/authController.js';

const router = express.Router();

// GET /api/system/factory-reset/status — Super Admin only
router.get('/status', authenticate, requireSuperAdmin, getFactoryResetStatus);

// POST /api/system/factory-reset — Super Admin only (Returns HTTP 501 in Phase 1)
router.post('/', authenticate, requireSuperAdmin, factoryReset);

export default router;
