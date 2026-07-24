import express from 'express';
import {
  getHousekeepingRooms,
  assignHousekeeper,
  updateHousekeepingStatus,
  getHousekeepingLogs
} from '../controllers/housekeepingController.js';

const router = express.Router();

// All routes are currently public or rely on higher-level middleware in this MVP
router.get('/rooms', getHousekeepingRooms);
router.post('/assign', assignHousekeeper);
router.post('/update-status', updateHousekeepingStatus);
router.get('/logs/:roomId', getHousekeepingLogs);

export default router;
