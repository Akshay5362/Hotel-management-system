/**
 * Isolated Firebase Web Client SDK Configuration (Guest Web App)
 * 
 * IMPORTANT SAFETY CONSTRAINTS:
 * - Uses ONLY public VITE_FIREBASE_* environment variables.
 * - NEVER imports or references Admin private keys or service account credentials.
 * - Not imported anywhere in the current Guest React application yet.
 * - Degrades gracefully if `firebase` npm package is not installed.
 */

const firebaseConfig = {
  apiKey: import.meta.env?.VITE_FIREBASE_API_KEY || '',
  authDomain: import.meta.env?.VITE_FIREBASE_AUTH_DOMAIN || '',
  projectId: import.meta.env?.VITE_FIREBASE_PROJECT_ID || 'hpms-sky5',
  storageBucket: import.meta.env?.VITE_FIREBASE_STORAGE_BUCKET || 'hpms-sky5.appspot.com',
  messagingSenderId: import.meta.env?.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: import.meta.env?.VITE_FIREBASE_APP_ID || '',
};

export const isClientConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId
);

export { firebaseConfig };
export default firebaseConfig;
