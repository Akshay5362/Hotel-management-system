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
const impLine = findLine("import GuestActiveStayOverview from './GuestActiveStayOverview';");
if (impLine !== -1) {
  lines[impLine] = "import GuestActiveStayOverview from './GuestActiveStayOverview';\nimport GuestBilling from './GuestBilling';\nimport GuestNotifications from './GuestNotifications';";
}

// 2. Replace Bill Tab
const billStart = findLine("{/* ── MY BILL TAB ───────────────────────────────────────────────── */}");
const notifStart = findLine("{/* ── NOTIFICATIONS TAB ─────────────────────────────────────────── */}");

if (billStart !== -1 && notifStart !== -1) {
  const repBill = `            {/* ── MY BILL TAB ───────────────────────────────────────────────── */}
            {dashTab === 'bill' && (
              <GuestBilling 
                liveBill={liveBill}
                billLoading={billLoading}
                loadBill={loadBill}
              />
            )}`;
  lines.splice(billStart, notifStart - billStart, repBill);
}

// Re-read lines to get new indices after splicing
const notifStart2 = findLine("{/* ── NOTIFICATIONS TAB ─────────────────────────────────────────── */}");
const extendStart = findLine("{/* ── EXTEND STAY TAB ───────────────────────────────────────────── */}");

if (notifStart2 !== -1 && extendStart !== -1) {
  const repNotif = `            {/* ── NOTIFICATIONS TAB ─────────────────────────────────────────── */}
            {dashTab === 'notifications' && (
              <GuestNotifications 
                notifications={notifications}
                notifLoading={notifLoading}
                loadNotifications={loadNotifications}
                handleMarkRead={handleMarkRead}
                activeBooking={activeBooking}
                setWizardStep={setWizardStep}
                setDashTab={setDashTab}
                setReuploadFile={setReuploadFile}
                setReuploadError={setReuploadError}
                setReuploadSuccess={setReuploadSuccess}
                setShowIdReupload={setShowIdReupload}
              />
            )}`;
  lines.splice(notifStart2, extendStart - notifStart2, repNotif);
}

fs.writeFileSync(path, lines.join('\n'));
console.log('Phase 2B Refactor completed successfully!');
