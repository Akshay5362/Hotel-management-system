const fs = require('fs');
const path = 'guest-web/src/components/GuestDashboard.jsx';
let content = fs.readFileSync(path, 'utf8');

// Add import
if (!content.includes('import { API_BASE_URL }')) {
  content = content.replace(
    "import React, { useState, useEffect, useCallback } from 'react';",
    "import React, { useState, useEffect, useCallback } from 'react';\nimport { API_BASE_URL } from '../services/api';"
  );
}

// Replace hardcoded URLs
content = content.replace(/http:\/\/localhost:5000\/api/g, '${API_BASE_URL}');
// Fix the fetch template string in apiFetch
content = content.replace("fetch(`\\${API_BASE_URL}${path}`", "fetch(`${API_BASE_URL}${path}`");

fs.writeFileSync(path, content);
console.log('API URLs updated successfully');
