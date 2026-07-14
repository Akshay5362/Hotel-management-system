import React from 'react';
import RoomCard from './RoomCard';

export default function RoomGrid({ rooms, activeFilter, searchQuery, onRoomClick }) {
  return (
    <div className="room-grid">
      {rooms.map((room) => {
        // Check if it fits the active status filter
        const matchesFilter = activeFilter === 'all' || room.status === activeFilter;
        
        // Check if it fits the search query (room number or guest name)
        const matchesSearch = 
          room.number.includes(searchQuery) || 
          (room.guestName && room.guestName.toLowerCase().includes(searchQuery.toLowerCase())) ||
          room.type.toLowerCase().includes(searchQuery.toLowerCase());
        
        const isDimmed = !matchesFilter || !matchesSearch;

        return (
          <RoomCard 
            key={room.number} 
            room={room} 
            onClick={onRoomClick}
            isDimmed={isDimmed}
          />
        );
      })}
    </div>
  );
}
