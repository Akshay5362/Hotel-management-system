import React from 'react';
import { Link } from 'react-router-dom';

export default function Footer() {
  const footerStyle = {
    background: '#0a0a0a',
    padding: '3rem 2rem 1.5rem',
    borderTop: '1px solid var(--border-color)',
    marginTop: 'auto'
  };

  const gridStyle = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: '2rem',
    maxWidth: '1200px',
    margin: '0 auto',
    marginBottom: '2rem'
  };

  const titleStyle = {
    color: '#fff',
    fontFamily: 'var(--font-heading)',
    fontSize: '1.1rem',
    marginBottom: '1rem'
  };

  const linkStyle = {
    color: 'var(--text-muted)',
    textDecoration: 'none',
    fontSize: '0.85rem',
    display: 'block',
    marginBottom: '0.5rem',
    transition: 'color 0.2s'
  };

  return (
    <footer style={footerStyle}>
      <div style={gridStyle}>
        <div>
          <h3 style={{ ...titleStyle, color: 'var(--color-vacant)' }}>HOTEL SKY-5</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: '1.6' }}>
            Experience luxury and comfort in the heart of the city. 
            Where every stay is a memorable journey.
          </p>
        </div>
        
        <div>
          <h4 style={titleStyle}>Quick Links</h4>
          <Link to="/rooms" style={linkStyle}>Rooms & Suites</Link>
          <Link to="/amenities" style={linkStyle}>Amenities</Link>
          <Link to="/gallery" style={linkStyle}>Gallery</Link>
          <Link to="/about" style={linkStyle}>About Us</Link>
        </div>

        <div>
          <h4 style={titleStyle}>Support</h4>
          <Link to="/faq" style={linkStyle}>FAQ</Link>
          <Link to="/contact" style={linkStyle}>Contact Us</Link>
          <Link to="/privacy-policy" style={linkStyle}>Privacy Policy</Link>
          <Link to="/terms" style={linkStyle}>Terms & Conditions</Link>
        </div>

        <div>
          <h4 style={titleStyle}>Contact</h4>
          <p style={linkStyle}>📍 123 Luxury Avenue, Sky City</p>
          <p style={linkStyle}>📞 +1 (555) 123-4567</p>
          <p style={linkStyle}>✉️ reservations@hotelsky5.com</p>
        </div>
      </div>
      
      <div style={{ textAlign: 'center', paddingTop: '1.5rem', borderTop: '1px solid rgba(255,255,255,0.05)', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
        &copy; {new Date().getFullYear()} Hotel Sky-5. All rights reserved.
      </div>
    </footer>
  );
}
