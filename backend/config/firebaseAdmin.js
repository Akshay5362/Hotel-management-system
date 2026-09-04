import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { isProductionProject } from './productionSafetyGuard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Explicit environment selection ───────────────────────────────────────────
// HPMS_ENV is a dedicated, purpose-built selector for which Firebase project
// this process talks to — deliberately NOT NODE_ENV, which already carries
// unrelated meaning elsewhere (Express behavior, build tooling, etc.) and
// must not be overloaded to also gate which live data store gets used.
//
// Unset HPMS_ENV defaults to 'production' — this preserves the exact existing
// behavior for any pathway that doesn't yet know about HPMS_ENV (the packaged
// Electron production build, a bare `node server.js`, etc.), which already
// only ever had backend/.env (production) to load. Every script that is
// actually meant for local development now sets HPMS_ENV=development
// explicitly (see package.json) so none of them silently fall through to
// this default.
const HPMS_ENV = process.env.HPMS_ENV || 'production';
const envFileName = HPMS_ENV === 'development' ? '.env.development' : '.env';
dotenv.config({ path: path.join(__dirname, '..', envFileName) });

let firebaseApp = null;
let db = null;
let auth = null;
let storage = null;

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;
const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;

// Handle escaped newline characters in the private key
const privateKey = rawPrivateKey ? rawPrivateKey.replace(/\\n/g, '\n') : undefined;

// ── Production Safety Guard ──────────────────────────────────────────────────
// If this process explicitly identifies itself as development (HPMS_ENV=development)
// but the resolved Firebase project is still the production project, fail
// closed immediately — before any credential is ever used to connect — rather
// than letting development/test work silently touch live production data.
// Reuses isProductionProject() from ./productionSafetyGuard.js.
if (HPMS_ENV === 'development' && isProductionProject()) {
  const message =
    'DEVELOPMENT SAFETY ERROR:\n' +
    'Development/test environment cannot connect to production Firebase project "hpms-sky5".\n' +
    `Resolved FIREBASE_PROJECT_ID from ${envFileName} was "${projectId}".\n` +
    'Expected FIREBASE_PROJECT_ID=sky5-development from backend/.env.development.\n' +
    'Refusing to start. Fix backend/.env.development and restart.';
  console.error(message);
  throw new Error('DEVELOPMENT SAFETY ERROR: refusing to connect a development/test process to production Firebase project hpms-sky5.');
}

// ── Placeholder credential guard (development only) ─────────────────────────
// backend/.env.development ships with clearly-named REPLACE_WITH_* placeholder
// values until real sky5-development service-account credentials are added.
// Refuse to attempt a connection with those placeholders rather than letting
// the Admin SDK fail confusingly deep inside a cert()/initializeApp() call.
const hasPlaceholderCredential = HPMS_ENV === 'development' &&
  (String(clientEmail || '').startsWith('REPLACE_WITH_') || String(rawPrivateKey || '').startsWith('REPLACE_WITH_'));

if (hasPlaceholderCredential) {
  console.error(
    'DEVELOPMENT CONFIGURATION INCOMPLETE:\n' +
    'backend/.env.development still has placeholder Firebase Admin credentials.\n' +
    'Replace FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY with the real ' +
    'sky5-development service-account values before starting in development mode.\n' +
    'Firebase Admin features are disabled until this is fixed (no connection attempted).'
  );
}

const isFirebaseConfigured = Boolean(projectId && clientEmail && privateKey) && !hasPlaceholderCredential;

if (isFirebaseConfigured) {
  try {
    const existingApps = getApps();
    if (!existingApps.length) {
      firebaseApp = initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey,
        }),
        storageBucket: storageBucket || undefined,
      });
      console.log(`[FirebaseAdmin] Initialized successfully for project: ${projectId}`);
    } else {
      firebaseApp = getApp();
    }

    db = getFirestore(firebaseApp);
    auth = getAuth(firebaseApp);
    storage = getStorage(firebaseApp);
  } catch (error) {
    console.warn('[FirebaseAdmin] Initialization warning:', error.message);
  }
} else {
  console.log('[FirebaseAdmin] Firebase environment variables not fully configured. Firebase Admin features are disabled (optional state).');
}

export {
  firebaseApp,
  db,
  auth,
  storage,
  isFirebaseConfigured
};

export default firebaseApp;
