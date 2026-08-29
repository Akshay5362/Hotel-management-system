import express from 'express';
import { getRoomTypes, getRoomTypeById, createRoomType, updateRoomType, deleteRoomType } from '../controllers/roomTypeController.js';
import { authenticate, requireRole } from '../controllers/authController.js';

const router = express.Router();

router.get('/', authenticate, getRoomTypes);
router.get('/:id', authenticate, getRoomTypeById);
router.post('/', authenticate, requireRole('admin'), createRoomType);
router.put('/:id', authenticate, requireRole('admin'), updateRoomType);
router.delete('/:id', authenticate, requireRole('admin'), deleteRoomType);

export default router;
