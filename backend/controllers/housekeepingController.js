import { HousekeepingCutoverService } from '../services/housekeepingCutoverService.js';

export const getHousekeepingRooms = async (req, res) => {
  try {
    const rows = await HousekeepingCutoverService.getHousekeepingRooms();
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

  try {
    const result = await HousekeepingCutoverService.assignHousekeeper({
      roomId,
      userId,
      priority,
      performedBy,
      io: req.io
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
      io: req.io
    });
    res.json(result);
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ error: 'Room not found' });
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

