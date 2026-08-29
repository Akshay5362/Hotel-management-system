import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth';

const firebaseConfig = {
  apiKey:            import.meta.env?.VITE_FIREBASE_API_KEY            || 'AIzaSyBWVlM8MgdWogVnvse7zmCITnIsp7_KXBs',
  authDomain:        import.meta.env?.VITE_FIREBASE_AUTH_DOMAIN        || 'hpms-sky5.firebaseapp.com',
  projectId:         import.meta.env?.VITE_FIREBASE_PROJECT_ID         || 'hpms-sky5',
  storageBucket:     import.meta.env?.VITE_FIREBASE_STORAGE_BUCKET     || 'hpms-sky5.firebasestorage.app',
  messagingSenderId: import.meta.env?.VITE_FIREBASE_MESSAGING_SENDER_ID || '393759221953',
  appId:             import.meta.env?.VITE_FIREBASE_APP_ID              || '1:393759221953:web:429ac6601f778d970dcc40',
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
