/**
 * listFirebaseApps.js  — lists ALL app types in the Firebase project
 * Run from backend/: node listFirebaseApps.js
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

const app = !getApps().length ? initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) }) : getApp();
const credential = app.options.credential;
const { access_token: accessToken } = await credential.getAccessToken();

async function listApps(type) {
  const res = await fetch(
    `https://firebase.googleapis.com/v1beta1/projects/${projectId}/${type}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const d = await res.json();
  return d.apps || d[type.replace('Apps', 'apps')] || [];
}

const webApps     = await listApps('webApps');
const androidApps = await listApps('androidApps');
const iosApps     = await listApps('iosApps');

console.log(`\nProject: ${projectId}`);
console.log(`Web Apps:     ${webApps.length}`);
console.log(`Android Apps: ${androidApps.length}`);
console.log(`iOS Apps:     ${iosApps.length}`);

if (webApps.length > 0) {
  console.log('\nWeb Apps:', JSON.stringify(webApps.map(a => ({ appId: a.appId, name: a.displayName })), null, 2));
}

process.exit(0);
