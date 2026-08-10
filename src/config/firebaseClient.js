import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env?.VITE_FIREBASE_API_KEY || 'AIzaSyDemoDummyApiKeyForHpmsSky5',
  authDomain: import.meta.env?.VITE_FIREBASE_AUTH_DOMAIN || 'hpms-sky5.firebaseapp.com',
  projectId: import.meta.env?.VITE_FIREBASE_PROJECT_ID || 'hpms-sky5',
  storageBucket: import.meta.env?.VITE_FIREBASE_STORAGE_BUCKET || 'hpms-sky5.appspot.com',
  messagingSenderId: import.meta.env?.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: import.meta.env?.VITE_FIREBASE_APP_ID || '',
};

let app = null;
let auth = null;

try {
  app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
  auth = getAuth(app);
} catch (err) {
  console.warn('[FirebaseClient] SDK initialization warning:', err.message);
}

export const isClientConfigured = Boolean(app && auth);

export { app, auth, signInWithEmailAndPassword, signOut, onAuthStateChanged, firebaseConfig };
export default firebaseConfig;
