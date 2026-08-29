import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure backend .env is loaded
dotenv.config({ path: path.join(__dirname, '..', '.env') });

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

const isFirebaseConfigured = Boolean(projectId && clientEmail && privateKey);

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
