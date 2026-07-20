import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_BASE_URL } from '../services/api';

export default function Rooms() {
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetch(`${API_BASE_URL}/public/rooms`)
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) {
          setRooms(data);
        }
      })
      .catch(err => console.error("Error fetching rooms:", err))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '4rem 2rem' }}>
      <h1 style={{ fontFamily: 'var(--font-heading)', color: '#fff', fontSize: '2.5rem', marginBottom: '1rem', textAlign: 'center' }}>
        Our Rooms & Suites
      </h1>
      <p style={{ textAlign: 'center', color: 'var(--text-muted)', marginBottom: '3rem' }}>
        Experience the pinnacle of luxury and comfort in our meticulously designed accommodations.
      </p>
      
      {loading ? (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>Loading accommodations...</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '2rem' }}>
          {rooms.map(room => (
            <div key={room.id} className="glass" style={{ borderRadius: '12px', overflow: 'hidden', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ height: '200px', width: '100%', overflow: 'hidden' }}>
                <img src={room.image} alt={room.type} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </div>
              <div style={{ padding: '1.5rem', flex: 1, display: 'flex', flexDirection: 'column' }}>
                <h3 style={{ margin: '0 0 10px 0', color: '#fff', fontSize: '1.25rem' }}>{room.type}</h3>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                  <span style={{ color: 'var(--color-vacant)', fontWeight: 'bold', fontSize: '1.2rem' }}>₹{room.price} <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>/ night</span></span>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', background: 'rgba(255,255,255,0.05)', padding: '4px 8px', borderRadius: '4px' }}>Up to {room.capacity} Guests</span>
                </div>
                <button 
                  onClick={() => navigate(room.available ? '/login' : '#')}
                  disabled={!room.available}
                  style={{ 
                    marginTop: 'auto', 
                    padding: '10px', 
                    width: '100%', 
                    background: room.available ? 'var(--color-vacant)' : 'rgba(255,255,255,0.1)', 
                    color: room.available ? '#000' : '#888', 
                    border: 'none', 
                    borderRadius: '8px', 
                    cursor: room.available ? 'pointer' : 'not-allowed', 
                    transition: 'all 0.2s',
                    fontWeight: 'bold'
                  }}
                >
                  {room.available ? 'Book Now' : 'Currently Unavailable'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
