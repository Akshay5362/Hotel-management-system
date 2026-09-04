import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, onIdTokenChanged } from 'firebase/auth';

// ── Explicit environment configuration — no hardcoded project fallback ──────
// The frontend must NEVER silently default to the production Firebase project
// (hpms-sky5) when its environment variables are missing. Vite's own
// env-file loading is what selects sky5-development vs hpms-sky5 (.env.local
// for `npm run dev`, .env.production for `npm run build`) — this file's job
// is only to fail loudly and safely if that selection didn't produce real
// values, not to substitute a project of its own choosing.
const REQUIRED_FIREBASE_VARS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
];

const env = import.meta.env || {};
const missingVars = REQUIRED_FIREBASE_VARS.filter(key => !env[key]);
const placeholderVars = REQUIRED_FIREBASE_VARS.filter(key => String(env[key] || '').startsWith('REPLACE_WITH_'));

const firebaseConfig = {
  apiKey:            env.VITE_FIREBASE_API_KEY,
  authDomain:        env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             env.VITE_FIREBASE_APP_ID,
};

let app = null;
let auth = null;

if (missingVars.length > 0) {
  console.error(
    `[FirebaseClient] Missing required Firebase environment variables: ${missingVars.join(', ')}.\n` +
    'Refusing to initialize Firebase — the app will NOT silently connect to any project.\n' +
    'Copy the correct environment file (.env.local for sky5-development, ' +
    '.env.production for hpms-sky5) and restart the dev server / rebuild.'
  );
} else if (placeholderVars.length > 0) {
  console.error(
    `[FirebaseClient] Development configuration incomplete — placeholder value(s) still present for: ${placeholderVars.join(', ')}.\n` +
    'Replace .env.local with the real sky5-development Firebase Web config before use.\n' +
    'Firebase is disabled until this is fixed (no connection attempted).'
  );
} else {
  try {
    app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
    auth = getAuth(app);
  } catch (err) {
    console.warn('[FirebaseClient] SDK initialization warning:', err.message);
  }
}

export const isClientConfigured = Boolean(app && auth);

export { app, auth, signInWithEmailAndPassword, signOut, onAuthStateChanged, onIdTokenChanged, firebaseConfig };
export default firebaseConfig;
