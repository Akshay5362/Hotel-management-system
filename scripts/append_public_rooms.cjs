const fs = require('fs');

const contentToAppend = `
export const getPublicRooms = async (req, res) => {
  let connection;
  try {
    connection = await (await import('../db.js')).default.getConnection();
    const [rooms] = await connection.query(\`
      SELECT 
        rt.id as category_id,
        rt.code as category,
        rt.base_rate as price,
        rt.image_url as image,
        rt.capacity,
        COUNT(r.id) as total_rooms,
        SUM(CASE WHEN r.status = 'VACANT' THEN 1 ELSE 0 END) as available_rooms
      FROM room_types rt
      JOIN rooms r ON r.room_type_id = rt.id
      GROUP BY rt.id
    \`);
    
    // Map data to match what the frontend expects
    const formattedRooms = rooms.map(r => ({
      id: r.category_id,
      type: r.category,
      price: parseFloat(r.price),
      capacity: r.capacity || 2,
      image: r.image || 'https://images.unsplash.com/photo-1611892440504-42a792e24d32?auto=format&fit=crop&q=80&w=800',
      available: r.available_rooms > 0
    }));

    res.json(formattedRooms);
  } catch (error) {
    console.error('Error fetching public rooms:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    if (connection) connection.release();
  }
};
`;

fs.appendFileSync('backend/controllers/roomController.js', contentToAppend);
console.log('Appended getPublicRooms');
