const fs = require('fs');
let content = fs.readFileSync('src/App.jsx', 'utf8');

const importStr = "import AnalyticsModal from './components/AnalyticsModal';";
const newImportStr = importStr + "\nimport SettingsModal from './components/SettingsModal';";
content = content.replace(importStr, newImportStr);

const modalStr = "<AnalyticsModal\n            isOpen={activeModal === 'analytics'}\n            onClose={() => setActiveModal(null)}\n          />";
const newModalStr = modalStr + "\n          <SettingsModal\n            isOpen={activeModal === 'settings'}\n            onClose={() => setActiveModal(null)}\n          />";
content = content.replace(modalStr, newModalStr);

fs.writeFileSync('src/App.jsx', content);
console.log('App.jsx updated');
