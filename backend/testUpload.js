import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runTest() {
  const dummyImgPath = path.join(__dirname, 'dummy.jpg');
  fs.writeFileSync(dummyImgPath, 'dummy image content');

  // Login as guest to get token
  let token = '';
  try {
    const loginRes = await fetch('http://localhost:5000/api/guest/login', { // wait, what is the guest login route?
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'harsh', password: 'password' })
    });
    // Wait, let's just get the login route right. Or just bypass auth in authController temporarily.
  } catch (e) {}

  const formData = new FormData();
  const fileBlob = new Blob([fs.readFileSync(dummyImgPath)], { type: 'image/jpeg' });
  formData.append('document', fileBlob, 'dummy.jpg');
  formData.append('idType', 'Aadhaar Card');
  formData.append('documentNumber', '692568428167');

  try {
    const response = await fetch('http://localhost:5000/api/guest/upload-id', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: formData
    });
    console.log('Status:', response.status);
    console.log('Body:', await response.text());
  } catch (e) {
    console.error(e);
  }
}
runTest();
