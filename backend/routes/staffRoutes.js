/**
 * staffRoutes.js
 * Staff Management API routes — admin-only access.
 * Mounted at /api/staff in server.js / api.js
 */
import express from 'express';
import {
  getAllStaff,
  getStaffById,
  createStaff,
  updateStaff,
  updateStaffStatus,
  deleteStaff,
} from '../controllers/staffController.js';

const router = express.Router();

// GET /api/staff           — list all staff (with optional filters)
router.get('/',     getAllStaff);

// GET /api/staff/:id       — get single staff member
router.get('/:id',  getStaffById);

// POST /api/staff          — create new staff member
router.post('/',    createStaff);

// PUT /api/staff/:id       — full update of a staff member
router.put('/:id',  updateStaff);

// PATCH /api/staff/status  — toggle Active/Inactive
// Note: must be registered BEFORE /:id to avoid route shadowing
router.patch('/status', updateStaffStatus);

// DELETE /api/staff/:id    — soft delete
router.delete('/:id', deleteStaff);

export default router;
