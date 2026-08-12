/**
 * getFirebaseWebConfig.js
 * Retrieves the Firebase Web App client config (apiKey, messagingSenderId, appId)
 * from the Firebase Management REST API using the Admin service account.
 *
 * The Firebase web apiKey is PUBLIC (not secret) — it restricts API quota, not access.
 * Safe to retrieve and store in .env.local.
 *
 * Run from backend/: node getFirebaseWebConfig.js
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const projectId   = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const rawKey      = process.env.FIREBASE_PRIVATE_KEY;
const privateKey  = rawKey ? rawKey.replace(/\\n/g, '\n') : undefined;

if (!projectId || !clientEmail || !privateKey) {
  console.error('[FATAL] Firebase Admin credentials missing');
  process.exit(1);
}

const app  = !getApps().length ? initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) }) : getApp();
const auth = getAuth(app);

// Get an access token to call the Firebase Management REST API
const { GoogleAuth } = await import('google-auth-library').catch(() => null) || {};

// Fallback: use the service account to get an access token via firebase-admin credential
const credential = app.options.credential;
const accessTokenResult = await credential.getAccessToken();
const accessToken = accessTokenResult.access_token;

// Call Firebase Management REST API to list Web Apps
const response = await fetch(
  `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps`,
  { headers: { Authorization: `Bearer ${accessToken}` } }
);

if (!response.ok) {
  console.error(`[ERROR] Management API returned ${response.status}: ${await response.text()}`);
  process.exit(1);
}

const data = await response.json();
const apps = data.apps || [];

if (apps.length === 0) {
  console.error('[ERROR] No Web Apps found in Firebase project. Create one in Firebase Console.');
  process.exit(1);
}

console.log(`\nFound ${apps.length} Web App(s) in project '${projectId}':\n`);

for (const webApp of apps) {
  console.log(`  App: ${webApp.displayName || '(unnamed)'} — AppId: ${webApp.appId}`);
  
  // Fetch the config for this specific app
  const configRes = await fetch(
    `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps/${webApp.appId}/config`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  
  if (!configRes.ok) {
    console.error(`  [ERROR] Config fetch failed: ${configRes.status}`);
    continue;
  }
  
  const config = await configRes.json();
  
  console.log('\n  ── Firebase Web App Config ──────────────────────────────────');
  console.log(`  VITE_FIREBASE_API_KEY=${config.apiKey}`);
  console.log(`  VITE_FIREBASE_AUTH_DOMAIN=${config.authDomain}`);
  console.log(`  VITE_FIREBASE_PROJECT_ID=${config.projectId}`);
  console.log(`  VITE_FIREBASE_STORAGE_BUCKET=${config.storageBucket}`);
  console.log(`  VITE_FIREBASE_MESSAGING_SENDER_ID=${config.messagingSenderId}`);
  console.log(`  VITE_FIREBASE_APP_ID=${config.appId}`);
  console.log('  ────────────────────────────────────────────────────────────\n');
}

console.log('[Done] Copy the values above into your .env.local file.');
process.exit(0);
