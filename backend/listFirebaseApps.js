/**
 * listFirebaseApps.js  — lists ALL app types in the Firebase project
 * Run from backend/: node listFirebaseApps.js
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
const projectId   = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const rawKey      = process.env.FIREBASE_PRIVATE_KEY;
const privateKey  = rawKey ? rawKey.replace(/\\n/g, '\n') : undefined;

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
