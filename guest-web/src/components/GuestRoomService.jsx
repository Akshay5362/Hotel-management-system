import React from 'react';

export default function GuestRoomService({
  serviceCategory,
  setServiceCategory,
  handleServiceRequest,
  isSubmittingService
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div>
        <h2 style={{ fontFamily: 'var(--font-heading)', color: '#fff', fontWeight: '800', fontSize: '1.3rem', marginBottom: '4px' }}>🛎️ Room Service</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Select a service category and choose what you need. Requests are delivered directly to your room.</p>
      </div>

      {/* Category selector */}
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        {[
          { id: 'housekeeping', label: '🧹 Housekeeping' },
          { id: 'laundry', label: '👔 Laundry' },
          { id: 'extras', label: '🛏️ Bedroom Extras' },
          { id: 'toiletries', label: '🧴 Toiletries' },
        ].map(cat => (
          <button key={cat.id} onClick={() => setServiceCategory(cat.id)} style={{
            background: serviceCategory === cat.id ? 'rgba(129,140,248,0.2)' : 'rgba(255,255,255,0.04)',
            border: serviceCategory === cat.id ? '1px solid #818cf8' : '1px solid rgba(255,255,255,0.08)',
            borderRadius: '8px', padding: '10px 16px', color: serviceCategory === cat.id ? '#818cf8' : 'var(--text-secondary)', fontWeight: '600', fontSize: '0.85rem', cursor: 'pointer', transition: 'all 0.2s'
          }}>{cat.label}</button>
        ))}
      </div>

      {/* Service items grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '12px' }}>
        {({
          housekeeping: [
            { name: 'Room Cleaning', price: 0, desc: 'Full room cleaning service', icon: '🧹' },
            { name: 'Bed Turndown Service', price: 0, desc: 'Evening turndown with mints', icon: '🌙' },
            { name: 'Vacuum Cleaning', price: 0, desc: 'Deep carpet vacuuming', icon: '🌀' },
            { name: 'Fresh Towels', price: 50, desc: 'Set of fresh bath towels', icon: '🛁' },
          ],
          laundry: [
            { name: 'Shirt Laundry', price: 80, desc: 'Washed & pressed shirt', icon: '👕' },
            { name: 'Trouser Press', price: 100, desc: 'Steam pressed trousers', icon: '👖' },
            { name: 'Saree/Kurta', price: 150, desc: 'Ethnic wear dry clean', icon: '👗' },
            { name: 'Express Laundry', price: 250, desc: '3-hour express service', icon: '⚡' },
          ],
          extras: [
            { name: 'Extra Pillow', price: 0, desc: 'Soft memory foam pillow', icon: '😴' },
            { name: 'Extra Blanket', price: 150, desc: 'Warm fleece blanket', icon: '🛏️' },
            { name: 'Extra Bed', price: 500, desc: 'Rollaway bed with mattress', icon: '🛌' },
            { name: 'Baby Cot', price: 200, desc: 'Safe crib for infants', icon: '👶' },
            { name: 'Ironing Board', price: 0, desc: 'Portable ironing board', icon: '👔' },
          ],

          toiletries: [
            { name: 'Shampoo & Conditioner', price: 0, desc: 'Luxury hair care set', icon: '🧴' },
            { name: 'Dental Kit', price: 0, desc: 'Toothbrush & toothpaste', icon: '🦷' },
            { name: 'Razor & Shaving Kit', price: 0, desc: 'Complete shaving set', icon: '🪒' },
            { name: 'Sanitary Kit', price: 0, desc: 'Feminine hygiene items', icon: '🌸' },
          ],
        })[serviceCategory]?.map(item => (
          <div key={item.name} className="glass" style={{ borderRadius: '12px', padding: '18px', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ fontSize: '2rem' }}>{item.icon}</div>
            <p style={{ fontWeight: '700', color: '#fff', fontSize: '0.92rem', margin: 0 }}>{item.name}</p>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: 0, flex: 1 }}>{item.desc}</p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
              <span style={{ fontWeight: '700', color: item.price === 0 ? '#22c55e' : '#fbbf24', fontSize: '0.88rem' }}>{item.price === 0 ? 'Complimentary' : `₹ ${item.price}`}</span>
              <button
                onClick={() => handleServiceRequest(item.name, item.price || 1, 1)}
                disabled={isSubmittingService}
                style={{ background: 'rgba(56,189,248,0.15)', border: '1px solid rgba(56,189,248,0.4)', borderRadius: '6px', padding: '6px 14px', color: '#38bdf8', fontWeight: '700', fontSize: '0.8rem', cursor: 'pointer' }}
              >
                {isSubmittingService ? '...' : 'Request'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
