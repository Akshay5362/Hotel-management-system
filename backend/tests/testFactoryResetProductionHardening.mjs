import assert from 'assert';
import crypto from 'crypto';
import { FactoryResetCutoverService } from '../services/factoryResetCutoverService.js';

const JWT_SECRET = 'hotel-pms-super-secret-key-12345!';
function generateLegacyToken(user) {
  const payload = JSON.stringify({ id: user.id, role: user.role, type: user.type || 'staff' });
  const base64Payload = Buffer.from(payload).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(base64Payload).digest('base64url');
  return base64Payload + '.' + signature;
}

async function runHardeningTests() {
  console.log('============================================================');
  console.log('HPMS FACTORY RESET PRODUCTION HARDENING TESTS (READ-ONLY)');
  console.log('============================================================');

  const superAdminToken = generateLegacyToken({ id: 1, role: 'admin', type: 'admin', isRootAdmin: true });
  const receptionistToken = generateLegacyToken({ id: 2, role: 'receptionist', type: 'staff' });

  // 1. Status Preflight Check (Read-Only)
  console.log('\n--- 1. GET /api/system/factory-reset/status (Super Admin) ---');
  const statusRes = await fetch('http://127.0.0.1:5000/api/system/factory-reset/status', {
    headers: { Authorization: 'Bearer ' + superAdminToken }
  });

  console.log(` Status HTTP Code: ${statusRes.status}`);
  assert.strictEqual(statusRes.status, 200, 'Status preflight must return 200');
  const statusData = await statusRes.json();
  console.log(' Preflight validation data:', JSON.stringify(statusData.validation, null, 2));

  assert.strictEqual(statusData.success, true, 'Status check must be successful');
  assert.strictEqual(statusData.validation.valid, true, 'Preflight validation must be valid');
  assert(statusData.validation.counts !== undefined, 'Counts object must exist');
  console.log(' ✅ Preflight status reflects live Firestore collections.');

  // 2. Authorization Protection (Receptionist blocked)
  console.log('\n--- 2. AUTHORIZATION TEST: Receptionist Access Blocked ---');
  const nonAdminRes = await fetch('http://127.0.0.1:5000/api/system/factory-reset/status', {
    headers: { Authorization: 'Bearer ' + receptionistToken }
  });
  console.log(` Receptionist Status HTTP Code: ${nonAdminRes.status}`);
  assert.strictEqual(nonAdminRes.status, 403, 'Non-super-admin must receive 403 Forbidden');
  console.log(' ✅ Non-super-admin access rejected with 403 Forbidden.');

  // 3. Confirmation Protection (Wrong / Missing phrase)
  console.log('\n--- 3. CONFIRMATION PROTECTION: Wrong Confirmation Phrase ---');
  const wrongPhraseRes = await fetch('http://127.0.0.1:5000/api/system/factory-reset', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + superAdminToken
    },
    body: JSON.stringify({ confirmationPhrase: 'WRONG PHRASE' })
  });
  console.log(` Wrong Phrase HTTP Code: ${wrongPhraseRes.status}`);
  const wrongPhraseData = await wrongPhraseRes.json();
  assert.strictEqual(wrongPhraseRes.status, 400, 'Wrong phrase must return 400');
  assert.strictEqual(wrongPhraseData.code, 'INVALID_CONFIRMATION_PHRASE', 'Code must be INVALID_CONFIRMATION_PHRASE');
  console.log(' ✅ Invalid confirmation phrase correctly rejected with 400.');

  // 4. Fail-Closed on Disabled Flag Test
  console.log('\n--- 4. FAIL-CLOSED TEST: When Flag Disabled, Fails Closed Without MySQL Fallback ---');
  const origFlag = process.env.USE_FIRESTORE_FACTORY_RESET;
  try {
    process.env.USE_FIRESTORE_FACTORY_RESET = 'false';
    let threw = false;
    try {
      await FactoryResetCutoverService.verifyReset();
    } catch (err) {
      threw = true;
      console.log(` Caught expected error: ${err.message}`);
      assert.strictEqual(err.code, 'FIRESTORE_FACTORY_RESET_DISABLED');
      assert.strictEqual(err.status, 503);
    }
    assert.strictEqual(threw, true, 'Must fail closed when flag is false');
    console.log(' ✅ Fail-closed behavior verified when feature flag is false.');
  } finally {
    process.env.USE_FIRESTORE_FACTORY_RESET = origFlag;
  }

  // 5. Existing PMS Workflow & Live Healthcheck
  console.log('\n--- 5. LIVE HEALTH & STATUS INTEGRITY ---');
  const healthRes = await fetch('http://127.0.0.1:5000/api/health');
  assert.strictEqual(healthRes.status, 200, 'Health check must return 200');

  const pmsStatusRes = await fetch('http://127.0.0.1:5000/api/status', {
    headers: { Authorization: 'Bearer ' + superAdminToken }
  });
  assert.strictEqual(pmsStatusRes.status, 200, 'Status check must return 200');
  const pmsStatus = await pmsStatusRes.json();

  console.log(` Total Rooms in PMS: ${pmsStatus.rooms?.length}`);
  console.log(` Occupied Rooms: ${pmsStatus.rooms?.filter(r => r.status === 'occupied').length}`);
  assert.strictEqual(pmsStatus.rooms?.length, 17, 'Canonical 17 rooms intact');

  console.log('\n============================================================');
  console.log('✅ ALL FACTORY RESET PRODUCTION HARDENING TESTS PASSED (100%)');
  console.log('============================================================');
}

runHardeningTests();
