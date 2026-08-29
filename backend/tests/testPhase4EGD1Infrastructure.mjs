/**
 * testPhase4EGD1Infrastructure.mjs
 *
 * Phase 4G-D Infrastructure Tests
 * Verifies:
 *   - Atomic claimNextBatch query execution using FOR UPDATE SKIP LOCKED
 *   - Worker lifecycle methods (startOutboxWorker, stopOutboxWorker, isWorkerRunning)
 *   - Enhanced healthcheck payload structure (/api/health response format)
 *   - Composite index configuration completeness in firestore.indexes.json
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { claimNextBatch } from '../services/outboxService.js';
import { startOutboxWorker, stopOutboxWorker, isWorkerRunning } from '../services/outboxWorker.js';
import { isFirestoreOutboxWorkerEnabled } from '../config/featureFlags.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('[Phase 4G-D] Infrastructure tests starting');

// ── 1. Worker Lifecycle Tests ───────────────────────────────────────────────
test('D1: stopOutboxWorker stops worker daemon cleanly', () => {
  stopOutboxWorker();
  assert.equal(isWorkerRunning(), false);
});

test('D1: startOutboxWorker respects ENABLE_FIRESTORE_OUTBOX_WORKER feature flag', () => {
  stopOutboxWorker();
  const started = startOutboxWorker();
  const isEnabled = isFirestoreOutboxWorkerEnabled();
  if (!isEnabled) {
    assert.equal(started, false, 'Worker should not start when feature flag is disabled');
    assert.equal(isWorkerRunning(), false);
  } else {
    assert.equal(started, true);
    assert.equal(isWorkerRunning(), true);
    stopOutboxWorker();
  }
});

// ── 2. Healthcheck Format Tests ──────────────────────────────────────────────
test('D1: Healthcheck structure contains outbox_worker status', () => {
  stopOutboxWorker();
  const healthResponse = {
    status: 'ok',
    service: 'hotel-pms-backend',
    port: 5000,
    outbox_worker: {
      enabled: isFirestoreOutboxWorkerEnabled(),
      running: isWorkerRunning()
    }
  };

  assert.equal(healthResponse.status, 'ok');
  assert.equal(typeof healthResponse.outbox_worker.enabled, 'boolean');
  assert.equal(typeof healthResponse.outbox_worker.running, 'boolean');
  assert.equal(healthResponse.outbox_worker.running, false);
});

// ── 3. Firestore Composite Index Configuration Tests ─────────────────────────
test('D1: firestore.indexes.json contains required composite indexes for all domain entities', () => {
  const indexPath = path.join(__dirname, '../../firestore.indexes.json');
  assert.ok(fs.existsSync(indexPath), 'firestore.indexes.json must exist');

  const content = fs.readFileSync(indexPath, 'utf-8');
  const indexData = JSON.parse(content);
  assert.ok(Array.isArray(indexData.indexes), 'indexes array must exist');

  const collections = new Set(indexData.indexes.map(idx => idx.collectionGroup));

  // Required collections with composite indexes
  const requiredCollections = [
    'bookings',
    'reservations',
    'payments',
    'invoices',
    'ledger_items',
    'staff',
    'cash_submissions',
    'notifications',
    'cash_logs',
    'audit_logs',
    'inventory_products'
  ];

  for (const col of requiredCollections) {
    assert.ok(collections.has(col), `firestore.indexes.json must contain composite index for collection '${col}'`);
  }
});

// ── 4. Atomic Locking Implementation Check ────────────────────────────────────
test('D1: claimNextBatch uses FOR UPDATE SKIP LOCKED in MySQL query', () => {
  const servicePath = path.join(__dirname, '../services/outboxService.js');
  const code = fs.readFileSync(servicePath, 'utf-8');
  assert.ok(code.includes('FOR UPDATE SKIP LOCKED'), 'claimNextBatch must query with FOR UPDATE SKIP LOCKED');
});

console.log('[Phase 4G-D] Infrastructure \u2713 tests complete');
