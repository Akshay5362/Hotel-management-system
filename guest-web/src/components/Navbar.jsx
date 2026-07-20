import React, { useContext } from 'react';
import { Link } from 'react-router-dom';
import { AuthContext } from '../contexts/AuthContext';

export default function Navbar() {
  const { user } = useContext(AuthContext);

  const navStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '1.5rem 2rem',
    background: 'rgba(15, 15, 15, 0.8)',
    backdropFilter: 'blur(10px)',
    borderBottom: '1px solid var(--border-color)',
    position: 'sticky',
    top: 0,
    zIndex: 1000
  };

  const linkStyle = {
    color: '#fff',
    textDecoration: 'none',
    fontWeight: '500',
    fontSize: '0.95rem',
    transition: 'color 0.2s',
  };

  const ctaStyle = {
    ...linkStyle,
    background: 'var(--color-vacant)',
    color: '#000',
    padding: '8px 16px',
    borderRadius: '8px',
    fontWeight: '700'
  };

  return (
    <nav style={navStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem', fontFamily: 'var(--font-heading)', color: '#fff', letterSpacing: '1px' }}>
          HOTEL SKY-5
        </h1>
      </div>
      
      <div style={{ display: 'flex', gap: '2rem', alignItems: 'center' }}>
        <Link to="/" style={linkStyle}>Home</Link>
        <Link to="/rooms" style={linkStyle}>Rooms & Suites</Link>
        <Link to="/amenities" style={linkStyle}>Amenities</Link>
        <Link to="/gallery" style={linkStyle}>Gallery</Link>
        <Link to="/about" style={linkStyle}>About Us</Link>
        <Link to="/contact" style={linkStyle}>Contact</Link>
        
        {user ? (
          <Link to="/dashboard" style={ctaStyle}>Guest Dashboard</Link>
        ) : (
          <Link to="/login" style={ctaStyle}>Sign In</Link>
        )}
      </div>
    </nav>
  );
}
