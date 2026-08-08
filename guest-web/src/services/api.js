const rawBase = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000').replace(/\/+$/, '');
export const API_ORIGIN = rawBase.endsWith('/api') ? rawBase.replace(/\/api$/, '') : rawBase;
export const API_BASE_URL = `${API_ORIGIN}/api`;

export const apiFetch = async (path, options = {}) => {
  const token = localStorage.getItem('guestToken');
  
  const headers = {
    'Content-Type': 'application/json',
    'ngrok-skip-browser-warning': 'true',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || data.message || 'API Request failed');
  }
  return data;
};

