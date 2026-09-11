import { HousekeepingCutoverService } from '../services/housekeepingCutoverService.js';
import { normalizeUserRole } from './authController.js';

export const getHousekeepingRooms = async (req, res) => {
  try {
    // L2: scope the result server-side for a housekeeper (cleaner) caller —
    // previously every role received the full hotel room list and the
    // frontend filtered to "my rooms" client-side only.
    const rows = await HousekeepingCutoverService.getHousekeepingRooms({
      role: normalizeUserRole(req.user),
      uid: req.user?.uid,
      id: req.user?.id
    });
    res.json(rows);
  } catch (error) {
    console.error('Error fetching housekeeping rooms:', error);
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
};

export const assignHousekeeper = async (req, res) => {
  const { roomId, userId, priority } = req.body;
  const performedBy = req.user?.id || null;

  if (!roomId) return res.status(400).json({ error: 'Room ID is required' });

  // Room/task assignment is an Admin/Reception management action — cleaners
  // operate their own assigned tasks via update-status only. Independent of
  // the route-level requireRole(...) list, mirroring the Food KDS pattern.
  if (normalizeUserRole(req.user) === 'housekeeper') {
    return res.status(403).json({
      error: 'Forbidden: Only Admin/Reception may assign or reassign housekeeping tasks.',
      code: 'HOUSEKEEPING_ASSIGN_FORBIDDEN'
    });
  }

  try {
    const result = await HousekeepingCutoverService.assignHousekeeper({
      roomId,
      userId,
      priority,
      performedBy,
      io: req.app.get('io')
    });
    res.json(result);
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ error: 'Room not found' });
    console.error('Error assigning housekeeper:', error);
    res.status(500).json({ error: 'Failed to assign housekeeper' });
  }
};

export const updateHousekeepingStatus = async (req, res) => {
  const { roomId, status, notes } = req.body;
  const performedBy = req.user?.id || null;

  if (!roomId || !status) return res.status(400).json({ error: 'Room ID and status are required' });

  try {
    const result = await HousekeepingCutoverService.updateHousekeepingStatus({
      roomId,
      status,
      notes,
      performedBy,
      io: req.app.get('io'),
      // L1: the service enforces that a 'housekeeper' caller may only
      // update a room currently assigned to them (403 otherwise).
      // Admin/receptionist are unrestricted.
      //
      // The role MUST be normalized here. The service tests
      // `caller?.role === 'housekeeper'`, but req.user.role carries the RAW
      // Firebase claim — 'CLEANER' — so passing req.user unchanged made that
      // comparison permanently false and the ownership guard never fired: a
      // cleaner could mark any room in the hotel clean, including one assigned
      // to someone else. Spreading req.user keeps uid / id / mysql_id, which
      // isRoomAssignedToUser needs to identify the assignee. This mirrors what
      // getHousekeepingRooms already does for the read path.
      caller: { ...req.user, role: normalizeUserRole(req.user) }
    });
    res.json(result);
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ error: 'Room not found' });
    if (error.status === 403) return res.status(403).json({ error: error.message, code: error.code });
    console.error('Error updating status:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
};

export const getHousekeepingLogs = async (req, res) => {
  const { roomId } = req.params;
  try {
    const rows = await HousekeepingCutoverService.getHousekeepingLogs(roomId);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching housekeeping logs:', error);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
};

