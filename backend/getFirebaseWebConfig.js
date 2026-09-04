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

// Same explicit HPMS_ENV selection as backend/config/firebaseAdmin.js — run
// with HPMS_ENV=development to target sky5-development instead of hpms-sky5.
// Unset defaults to production, matching this script's prior behavior.
const HPMS_ENV = process.env.HPMS_ENV || 'production';
const envFileName = HPMS_ENV === 'development' ? '.env.development' : '.env';
dotenv.config({ path: path.join(__dirname, envFileName) });

import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { isProductionProject } from './config/productionSafetyGuard.js';

const projectId   = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const rawKey      = process.env.FIREBASE_PRIVATE_KEY;
const privateKey  = rawKey ? rawKey.replace(/\\n/g, '\n') : undefined;

if (HPMS_ENV === 'development' && isProductionProject()) {
  console.error(
    `[DEVELOPMENT SAFETY ERROR] This script was run with HPMS_ENV=development but resolved FIREBASE_PROJECT_ID="${projectId}" (production). ` +
    `Refusing to run. Fix ${envFileName} and retry.`
  );
  process.exit(1);
}

if (!projectId || !clientEmail || !privateKey || String(clientEmail).startsWith('REPLACE_WITH_') || String(rawKey).startsWith('REPLACE_WITH_')) {
  console.error('[FATAL] Firebase Admin credentials missing or still placeholders — nothing was contacted.');
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
