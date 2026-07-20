const fs = require('fs');

const path = 'src/components/GuestDashboard.jsx';
let content = fs.readFileSync(path, 'utf8');
let lines = content.split('\n');

function findLine(str, start = 0) {
  for (let i = start; i < lines.length; i++) {
    if (lines[i].includes(str)) return i;
  }
  return -1;
}

// 1. Add imports
const impLine = findLine("import GuestNotifications from './GuestNotifications';");
if (impLine !== -1) {
  lines[impLine] = "import GuestNotifications from './GuestNotifications';\nimport GuestRoomService from './GuestRoomService';\nimport GuestMaintenance from './GuestMaintenance';";
}

// 2. Replace Room Service Tab
const serviceStart = findLine("{/* ── ROOM SERVICE TAB ──────────────────────────────────────────── */}");
const foodStart = findLine("{/* ── FOOD ORDER TAB ────────────────────────────────────────────── */}");

if (serviceStart !== -1 && foodStart !== -1) {
  const repService = `            {/* ── ROOM SERVICE TAB ──────────────────────────────────────────── */}
            {dashTab === 'service' && (
              <GuestRoomService
                serviceCategory={serviceCategory}
                setServiceCategory={setServiceCategory}
                handleServiceRequest={handleServiceRequest}
                isSubmittingService={isSubmittingService}
              />
            )}`;
  lines.splice(serviceStart, foodStart - serviceStart, repService);
}

// Re-read lines to get new indices after splicing
const maintenanceStart = findLine("{/* ── MAINTENANCE TAB ───────────────────────────────────────────── */}");
const billStart = findLine("{/* ── MY BILL TAB ───────────────────────────────────────────────── */}");

if (maintenanceStart !== -1 && billStart !== -1) {
  const repMaintenance = `            {/* ── MAINTENANCE TAB ───────────────────────────────────────────── */}
            {dashTab === 'maintenance' && (
              <GuestMaintenance
                maintenanceIssue={maintenanceIssue}
                setMaintenanceIssue={setMaintenanceIssue}
                handleMaintenanceSubmit={handleMaintenanceSubmit}
                isSubmittingMaintenance={isSubmittingMaintenance}
              />
            )}`;
  lines.splice(maintenanceStart, billStart - maintenanceStart, repMaintenance);
} else {
    console.log("Could not find maintenanceStart or billStart. Check exact string matches.");
    console.log("maintenanceStart:", maintenanceStart);
    console.log("billStart:", billStart);
}

fs.writeFileSync(path, lines.join('\n'));
console.log('Phase 2C Refactor completed successfully!');
