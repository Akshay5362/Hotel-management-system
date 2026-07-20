const fs = require('fs');

const path = 'src/components/GuestDashboard.jsx';
let content = fs.readFileSync(path, 'utf-8');
const lines = content.split('\n');

// 1. Delete lines 476 to 655 (0-indexed: 475 to 654)
// Wait! Let's find exactly where they are to be safe
const startDel1 = lines.findIndex(l => l.includes("const vacantRooms = rooms.filter(r => {"));
const endDel1 = lines.findIndex(l => l.includes("const activeBalance = activeSubtotal - activeBookingDeposit;"));

if (startDel1 !== -1 && endDel1 !== -1 && endDel1 > startDel1) {
  lines.splice(startDel1, endDel1 - startDel1);
}

// 2. Find the start of the booking wizard block
const startIdx = lines.findIndex(l => l.includes('{!historyLoading && !activeReservation && !hasCheckedOut && ('));
let endIdx = -1;
for (let i = startIdx + 1; i < lines.length; i++) {
  if (lines[i].includes('ID RE-UPLOAD MODAL (for occupied guests with rejected documents)')) {
    endIdx = i - 3; // The )} should be right before this comment
    break;
  }
}

if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
  const replacement = `      {!historyLoading && !activeReservation && !hasCheckedOut && (
        <GuestBookingWizard
          user={user}
          token={token}
          rooms={rooms}
          activeBooking={activeBooking}
          activeReservation={activeReservation}
          hasCheckedOut={hasCheckedOut}
          historyLoading={historyLoading}
          wizardStep={wizardStep}
          setWizardStep={setWizardStep}
          confirmedBooking={confirmedBooking}
          setConfirmedBooking={setConfirmedBooking}
          fetchStatus={fetchStatus}
          loadGuestHistory={loadGuestHistory}
          onUserUpdate={onUserUpdate}
          showAlert={showAlert}
          apiFetch={apiFetch}
          liveBill={liveBill}
          activeSubtotal={activeSubtotal}
          activeBookingDeposit={activeBookingDeposit}
          activeBalance={activeBalance}
        />
      )}`;
  lines.splice(startIdx, endIdx - startIdx + 1, replacement);
}

fs.writeFileSync(path, lines.join('\n'));
console.log("Replaced wizard block!");
