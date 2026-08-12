import express from '../backend/node_modules/express/index.js';
import crypto from 'crypto';
import http from 'http';

// Enable strict RBAC for this in-memory test execution
process.env.ENABLE_STRICT_RBAC = 'true';

// Dynamically import apiRouter after setting process.env.ENABLE_STRICT_RBAC
const { default: apiRouter } = await import('../backend/routes/api.js');

const app = express();
app.use(express.json());
app.use('/api', apiRouter);

const TEST_PORT = 5005;

const JWT_SECRET = process.env.JWT_SECRET || 'hotel-pms-super-secret-key-12345!';

function generateTestToken(payload) {
  const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(base64Payload).digest('base64url');
  return `${base64Payload}.${signature}`;
}

const TOKENS = {
  super_admin: generateTestToken({ id: 1, role: 'admin' }),
  admin: generateTestToken({ id: 10, role: 'ADMIN', type: 'staff' }),
  receptionist: generateTestToken({ id: 11, role: 'RECEPTIONIST', type: 'staff' }),
  housekeeper: generateTestToken({ id: 12, role: 'CLEANER', type: 'staff' }),
  kitchen: generateTestToken({ id: 13, role: 'CHEF', type: 'staff' }),
  guest: generateTestToken({ id: 20, role: 'guest' })
};

function makeRequest(method, path, token, body = null) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', (err) => resolve({ status: 500, error: err.message }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runRbacTests() {
  const server = app.listen(TEST_PORT, async () => {
    console.log('\n=================================================');
    console.log('  AUTOMATED STRICT RBAC AUTHORIZATION TEST SUITE');
    console.log('=================================================\n');

    const tests = [
      { name: 'POST /api/dayend', method: 'POST', path: '/api/dayend', expected: { super_admin: [200, 400], admin: [200, 400], receptionist: 403, housekeeper: 403, kitchen: 403, guest: 403 } },
      { name: 'POST /api/dayend/undo', method: 'POST', path: '/api/dayend/undo', expected: { super_admin: [200, 400, 409], admin: 403, receptionist: 403, housekeeper: 403, kitchen: 403, guest: 403 } },
      { name: 'POST /api/rooms/101/checkin', method: 'POST', path: '/api/rooms/101/checkin', expected: { super_admin: [200, 400, 404], admin: [200, 400, 404], receptionist: [200, 400, 404], housekeeper: 403, kitchen: 403, guest: 403 } },
      { name: 'POST /api/rooms/101/checkout', method: 'POST', path: '/api/rooms/101/checkout', expected: { super_admin: [200, 400, 404], admin: [200, 400, 404], receptionist: [200, 400, 404], housekeeper: 403, kitchen: 403, guest: 403 } },
      { name: 'POST /api/rooms/shift', method: 'POST', path: '/api/rooms/shift', expected: { super_admin: [200, 400], admin: [200, 400], receptionist: [200, 400], housekeeper: 403, kitchen: 403, guest: 403 } },
      { name: 'POST /api/rooms/101/refund-checkout', method: 'POST', path: '/api/rooms/101/refund-checkout', expected: { super_admin: [200, 400, 404], admin: [200, 400, 404], receptionist: 403, housekeeper: 403, kitchen: 403, guest: 403 } },
      { name: 'GET /api/staff', method: 'GET', path: '/api/staff', expected: { super_admin: [200, 304], admin: [200, 304], receptionist: 403, housekeeper: 403, kitchen: 403, guest: 403 } },
      { name: 'GET /api/admin/guest-documents', method: 'GET', path: '/api/admin/guest-documents', expected: { super_admin: [200, 304], admin: [200, 304], receptionist: [200, 304], housekeeper: 403, kitchen: 403, guest: 403 } },
      { name: 'PUT /api/rooms/101/status', method: 'PUT', path: '/api/rooms/101/status', expected: { super_admin: [200, 400, 404], admin: [200, 400, 404], receptionist: [200, 400, 404], housekeeper: [200, 400, 404], kitchen: 403, guest: 403 } }
    ];

    let totalFailures = 0;

    for (const t of tests) {
      console.log(`\n--- Testing ${t.name} ---`);
      for (const [role, token] of Object.entries(TOKENS)) {
        const res = await makeRequest(t.method, t.path, token);
        const expectedCodes = Array.isArray(t.expected[role]) ? t.expected[role] : [t.expected[role]];
        const isPassed = expectedCodes.includes(res.status);

        if (!isPassed) {
          totalFailures++;
          console.log(` ❌ ${role.toUpperCase()}: Received HTTP ${res.status} (Expected: ${expectedCodes.join('/')})`);
        } else {
          console.log(` ✔ ${role.toUpperCase()}: Received HTTP ${res.status} (Pass)`);
        }
      }
    }

    console.log('\n=================================================');
    console.log(`  TEST RESULTS: ${totalFailures === 0 ? 'ALL ROLE TESTS PASSED (0 Failures)' : `${totalFailures} Failures Detected`}`);
    console.log('=================================================\n');

    server.close();
    if (totalFailures > 0) process.exit(1);
    else process.exit(0);
  });
}

runRbacTests();
