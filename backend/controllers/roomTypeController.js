import { RoomTypeCutoverService } from '../services/roomTypeCutoverService.js';

export const getRoomTypes = async (req, res) => {
  try {
    const data = await RoomTypeCutoverService.getRoomTypes();
    res.json(data);
  } catch (error) {
    console.error('Error fetching room types:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export const getRoomTypeById = async (req, res) => {
  const { id } = req.params;
  try {
    const data = await RoomTypeCutoverService.getRoomTypeById(id);
    if (!data) {
      return res.status(404).json({ error: 'Room type not found' });
    }
    res.json(data);
  } catch (error) {
    console.error('Error fetching room type:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export const createRoomType = async (req, res) => {
  const { code, title, name, description, base_rate, image } = req.body;
  const roomTypeName = name || title;

  if (!code || !roomTypeName || base_rate === undefined) {
    return res.status(400).json({ error: 'Missing required fields: code, title/name, base_rate' });
  }

  try {
    const result = await RoomTypeCutoverService.createRoomType({ code, title, name, description, base_rate, image });
    res.status(201).json(result);
  } catch (error) {
    if (error.code === 'DUPLICATE_KEY') {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error creating room type:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
};

export const updateRoomType = async (req, res) => {
  const { id } = req.params;
  const { title, name, description, base_rate, image } = req.body;

  try {
    const result = await RoomTypeCutoverService.updateRoomType(id, { title, name, description, base_rate, image });
    res.json(result);
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ error: 'Room type not found' });
    }
    console.error('Error updating room type:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
};

export const deleteRoomType = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await RoomTypeCutoverService.deleteRoomType(id);
    res.json(result);
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ error: 'Room type not found' });
    }
    console.error('Error deleting room type:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
};

