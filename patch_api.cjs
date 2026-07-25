const fs = require('fs');
let content = fs.readFileSync('backend/routes/api.js', 'utf8');

const importStr = "import { getStatus, runDayEnd, getGuestRequests, resolveGuestRequest, resolveExtensionRequest, getGuestDocuments, verifyGuestDocument, deleteGuestDocument, searchGuests, listGuests, searchGuestsStaff } from '../controllers/auditController.js';";
const newImportStr = importStr + "\nimport { getBusinessDateInfo, updateBusinessDate } from '../controllers/settingsController.js';";
content = content.replace(importStr, newImportStr);

const routeStr = "// Audit & status routes\nrouter.get('/status', authenticate, getStatus);\nrouter.post('/dayend', authenticate, requireAdmin, runDayEnd);";
const newRouteStr = routeStr + "\n\n// Settings routes\nrouter.get('/settings/business-date', authenticate, getBusinessDateInfo);\nrouter.post('/settings/business-date', authenticate, requireAdmin, updateBusinessDate);";
content = content.replace(routeStr, newRouteStr);

fs.writeFileSync('backend/routes/api.js', content);
console.log('Routes added');
