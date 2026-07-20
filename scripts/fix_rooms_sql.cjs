const fs = require('fs');

const content = fs.readFileSync('backend/controllers/roomController.js', 'utf8');

const oldQuery = `SELECT 
        rt.id as category_id,
        rt.code as category,
        rt.base_rate as price,
        rt.image_url as image,
        rt.capacity,
        COUNT(r.id) as total_rooms,
        SUM(CASE WHEN r.status = 'VACANT' THEN 1 ELSE 0 END) as available_rooms
      FROM room_types rt
      JOIN rooms r ON r.room_type_id = rt.id
      GROUP BY rt.id`;

const newQuery = `SELECT 
        rt.id as category_id,
        rt.code as category,
        rt.title,
        rt.description,
        rt.base_rate as price,
        rt.image,
        COUNT(r.id) as total_rooms,
        SUM(CASE WHEN r.status = 'VACANT' THEN 1 ELSE 0 END) as available_rooms
      FROM room_types rt
      JOIN rooms r ON r.room_type_id = rt.id
      GROUP BY rt.id`;

const newContent = content.replace(oldQuery, newQuery);

fs.writeFileSync('backend/controllers/roomController.js', newContent);
console.log('Fixed getPublicRooms Query');
