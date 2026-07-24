const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');

// 1. Create apiConfig.js
const configDir = path.join(projectRoot, 'src', 'config');
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}
const configPath = path.join(configDir, 'apiConfig.js');
fs.writeFileSync(configPath, `export const API_BASE_URL = 'http://localhost:5000';\n`, 'utf8');
console.log('✓ Created src/config/apiConfig.js');

// 2. Files to process and their import paths
const targets = [
  { file: 'src/App.jsx', importPath: "import { API_BASE_URL } from './config/apiConfig';" },
  { file: 'src/utils/invoiceUtils.js', importPath: "import { API_BASE_URL } from '../config/apiConfig';" },
  { file: 'src/components/RefundCheckoutModal.jsx', importPath: "import { API_BASE_URL } from '../config/apiConfig';" },
  { file: 'src/components/ReceptionPortal.jsx', importPath: "import { API_BASE_URL } from '../config/apiConfig';" },
  { file: 'src/components/IdentityVerificationModal.jsx', importPath: "import { API_BASE_URL } from '../config/apiConfig';" },
  { file: 'src/components/GuestRequestsModal.jsx', importPath: "import { API_BASE_URL } from '../config/apiConfig';" },
  { file: 'src/components/GuestDashboard.jsx', importPath: "import { API_BASE_URL } from '../config/apiConfig';" },
  { file: 'src/components/GuestBookingWizard.jsx', importPath: "import { API_BASE_URL } from '../config/apiConfig';" },
  { file: 'src/components/CashStatusModal.jsx', importPath: "import { API_BASE_URL } from '../config/apiConfig';" },
  { file: 'src/components/AuthCard.jsx', importPath: "import { API_BASE_URL } from '../config/apiConfig';" },
  { file: 'src/components/AnalyticsModal.jsx', importPath: "import { API_BASE_URL } from '../config/apiConfig';" },
  { file: 'src/components/AdminHousekeeping.jsx', importPath: "import { API_BASE_URL } from '../config/apiConfig';" },
  { file: 'src/components/AdminGuests.jsx', importPath: "import { API_BASE_URL } from '../config/apiConfig';" }
];

targets.forEach(({ file, importPath }) => {
  const filePath = path.join(projectRoot, file);
  if (!fs.existsSync(filePath)) {
    console.log(`⚠ File not found, skipping: ${file}`);
    return;
  }

  let content = fs.readFileSync(filePath, 'utf8');

  // Replace http://localhost:5000 with API_BASE_URL
  // Handles template literal wrappers, strings, and quotes
  let modified = false;

  // Replace instances of `http://localhost:5000` with template literals or normal reference
  // Check if it's inside a template literal
  const regexLiteral = /`http:\/\/localhost:5000([^`]*)`/g;
  if (regexLiteral.test(content)) {
    content = content.replace(regexLiteral, '`${API_BASE_URL}$1`');
    modified = true;
  }

  const regexStringSingle = /'http:\/\/localhost:5000([^']*)'/g;
  if (regexStringSingle.test(content)) {
    content = content.replace(regexStringSingle, '`${API_BASE_URL}$1`');
    modified = true;
  }

  const regexStringDouble = /"http:\/\/localhost:5000([^"]*)"/g;
  if (regexStringDouble.test(content)) {
    content = content.replace(regexStringDouble, '`${API_BASE_URL}$1`');
    modified = true;
  }

  if (modified) {
    // Add import statement at the top (right after React or on the first line)
    if (!content.includes('API_BASE_URL')) {
      content = importPath + '\n' + content;
    } else if (!content.includes('import { API_BASE_URL }')) {
      content = importPath + '\n' + content;
    }
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✓ Centralized API URLs in: ${file}`);
  } else {
    console.log(`- No replacements needed in: ${file}`);
  }
});

console.log('Centralization script complete!');
