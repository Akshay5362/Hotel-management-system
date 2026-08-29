/**
 * createFirebaseWebApp.js
 * ========================
 * Creates a Web App registration in Firebase project hpms-sky5
 * and retrieves its client config (apiKey, messagingSenderId, appId).
 *
 * The Firebase web SDK apiKey is a PUBLIC quota key — NOT a secret.
 * It is safe to retrieve and store in .env.local (which is .gitignored).
 *
 * Run from backend/: node createFirebaseWebApp.js
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

if (!projectId || !clientEmail || !privateKey) {
  console.error('[FATAL] Missing Firebase Admin credentials in .env');
  process.exit(1);
}

const adminApp = !getApps().length ? initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) }) : getApp();
const { access_token: accessToken } = await adminApp.options.credential.getAccessToken();

const BASE = 'https://firebase.googleapis.com/v1beta1';
const headers = {
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json'
};

// ── Step 1: Check if a Web App already exists ─────────────────────────────────
console.log(`\n[Step 1] Checking existing Web Apps in project '${projectId}'...`);
const listRes = await fetch(`${BASE}/projects/${projectId}/webApps`, { headers });
const listData = await listRes.json();
let existingApps = listData.apps || [];

let webApp = existingApps[0] || null;

if (webApp) {
  console.log(`  Found existing Web App: ${webApp.displayName || '(unnamed)'} — appId: ${webApp.appId}`);
} else {
  // ── Step 2: Create a new Web App ───────────────────────────────────────────
  console.log('  No Web App found. Creating one...');
  const createRes = await fetch(`${BASE}/projects/${projectId}/webApps`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ displayName: 'HPMS-Sky5 PMS' })
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    console.error(`[ERROR] Web App creation failed (${createRes.status}): ${err}`);
    process.exit(1);
  }

  // Creation returns a long-running operation — poll for completion
  const operation = await createRes.json();
  console.log(`  Operation started: ${operation.name}`);

  // Poll the operation until done (max 30s)
  let opResult = operation;
  let attempts = 0;
  while (!opResult.done && attempts < 15) {
    await new Promise(r => setTimeout(r, 2000));
    attempts++;
    const pollRes = await fetch(`https://firebase.googleapis.com/v1beta1/${opResult.name}`, { headers });
    opResult = await pollRes.json();
    process.stdout.write('.');
  }
  console.log('');

  if (!opResult.done || opResult.error) {
    console.error('[ERROR] Operation did not complete successfully:', JSON.stringify(opResult.error || opResult));
    process.exit(1);
  }

  webApp = opResult.response;
  console.log(`  ✅ Web App created: ${webApp.displayName} — appId: ${webApp.appId}`);
}

// ── Step 3: Retrieve the Web App config ──────────────────────────────────────
console.log('\n[Step 2] Retrieving Web App config...');
const configRes = await fetch(`${BASE}/projects/${projectId}/webApps/${webApp.appId}/config`, { headers });

if (!configRes.ok) {
  const err = await configRes.text();
  console.error(`[ERROR] Config fetch failed (${configRes.status}): ${err}`);
  process.exit(1);
}

const config = await configRes.json();

// ── Step 4: Print config for .env.local ──────────────────────────────────────
console.log('\n' + '═'.repeat(70));
console.log('  FIREBASE WEB APP CONFIG — Add these to .env.local');
console.log('═'.repeat(70));
console.log(`VITE_FIREBASE_API_KEY=${config.apiKey}`);
console.log(`VITE_FIREBASE_AUTH_DOMAIN=${config.authDomain}`);
console.log(`VITE_FIREBASE_PROJECT_ID=${config.projectId}`);
console.log(`VITE_FIREBASE_STORAGE_BUCKET=${config.storageBucket}`);
console.log(`VITE_FIREBASE_MESSAGING_SENDER_ID=${config.messagingSenderId}`);
console.log(`VITE_FIREBASE_APP_ID=${config.appId}`);
console.log('═'.repeat(70));
console.log('\n[NOTE] apiKey is a PUBLIC quota key — safe for .env.local (not committed)');
console.log('[NOTE] NEVER put FIREBASE_PRIVATE_KEY in frontend config.\n');

// ── Step 5: Auto-write to .env.local (root-level) ────────────────────────────
import { readFileSync, writeFileSync } from 'fs';

const envLocalPath = path.join(__dirname, '..', '.env.local');
let envLocal = '';
try {
  envLocal = readFileSync(envLocalPath, 'utf8');
} catch { envLocal = ''; }

const keysToSet = {
  VITE_FIREBASE_API_KEY: config.apiKey,
  VITE_FIREBASE_AUTH_DOMAIN: config.authDomain,
  VITE_FIREBASE_PROJECT_ID: config.projectId,
  VITE_FIREBASE_STORAGE_BUCKET: config.storageBucket,
  VITE_FIREBASE_MESSAGING_SENDER_ID: config.messagingSenderId,
  VITE_FIREBASE_APP_ID: config.appId
};

let updated = envLocal;
for (const [key, value] of Object.entries(keysToSet)) {
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(updated)) {
    updated = updated.replace(regex, `${key}=${value}`);
  } else {
    updated = updated.trimEnd() + `\n${key}=${value}\n`;
  }
}

writeFileSync(envLocalPath, updated, 'utf8');
console.log(`[Done] .env.local updated at: ${envLocalPath}`);
console.log('[Done] Run "npm run dev" to start the frontend with Firebase client auth.\n');

process.exit(0);
