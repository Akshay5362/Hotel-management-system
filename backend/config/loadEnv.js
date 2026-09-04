/**
 * backend/config/loadEnv.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for HPMS_ENV-based environment file selection.
 *
 * MUST be the very first import in backend/server.js — ahead of every other
 * import, including route/controller modules — because ES modules fully
 * evaluate every import in a file (in the order written, regardless of that
 * import's line position relative to the file's own top-level code) before
 * the importing file's own code runs. A dotenv.config() call written early in
 * server.js's source is NOT guaranteed to run before a transitively-imported
 * module (e.g. db.js, firebaseAdmin.js) further down the import list — only
 * being the first import declaration guarantees this module's side effect
 * (loading the correct .env file) completes before anything else in the
 * dependency graph gets a chance to run.
 *
 * dotenv.config() never overrides a variable already present in process.env,
 * so this being first is what makes it authoritative: every other module's
 * own dotenv.config call for the same keys becomes a harmless no-op once this
 * has already run.
 *
 * HPMS_ENV=development → backend/.env.development
 * HPMS_ENV=production, or unset (existing production pathways) → backend/.env
 * ─────────────────────────────────────────────────────────────────────────────
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HPMS_ENV = process.env.HPMS_ENV || 'production';
const envFileName = HPMS_ENV === 'development' ? '.env.development' : '.env';

dotenv.config({ path: path.join(__dirname, '..', envFileName) });
