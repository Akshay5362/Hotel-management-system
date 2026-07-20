const fs = require('fs');
const path = require('path');

const pages = [
  { name: 'Home', title: 'Welcome to Hotel Sky-5', content: 'Experience luxury like never before. Start your journey with us today.' },
  { name: 'About', title: 'About Us', content: 'Discover the rich history and mission of Hotel Sky-5.' },
  { name: 'Rooms', title: 'Our Rooms & Suites', content: 'Explore our luxurious accommodations.' },
  { name: 'RoomDetails', title: 'Room Details', content: 'Detailed information about the selected room category.' },
  { name: 'Gallery', title: 'Photo Gallery', content: 'Take a visual tour of our hotel and amenities.' },
  { name: 'Amenities', title: 'Hotel Amenities', content: 'World-class facilities designed for your ultimate comfort.' },
  { name: 'Contact', title: 'Contact Us', content: 'Get in touch with our team for reservations and inquiries.' },
  { name: 'FAQ', title: 'Frequently Asked Questions', content: 'Find answers to common questions about your stay.' },
  { name: 'PrivacyPolicy', title: 'Privacy Policy', content: 'How we protect and handle your personal data.' },
  { name: 'Terms', title: 'Terms & Conditions', content: 'The terms governing your stay at Hotel Sky-5.' }
];

const dir = 'guest-web/src/pages';

pages.forEach(p => {
  const content = `import React from 'react';

export default function ${p.name}() {
  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '4rem 2rem' }}>
      <h1 style={{ fontFamily: 'var(--font-heading)', color: '#fff', fontSize: '2.5rem', marginBottom: '1.5rem' }}>
        ${p.title}
      </h1>
      <div className="glass" style={{ padding: '2rem', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: '1.1rem', lineHeight: '1.6' }}>
          ${p.content}
        </p>
        <p style={{ marginTop: '2rem', fontSize: '0.9rem', color: '#666' }}>
          [ This is a Phase 6 placeholder page component. ]
        </p>
      </div>
    </div>
  );
}
`;
  // Don't overwrite Login or Dashboard
  if(p.name !== 'Login' && p.name !== 'Dashboard') {
      fs.writeFileSync(path.join(dir, `${p.name}.jsx`), content);
  }
});

console.log('Pages scaffolded successfully.');
