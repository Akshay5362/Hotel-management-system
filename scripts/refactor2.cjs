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
const impLine = findLine("import PaymentPanel from './PaymentPanel';");
if (impLine !== -1) {
  lines[impLine] = "import PaymentPanel from './PaymentPanel';\nimport GuestBookingWizard from './GuestBookingWizard';\nimport GuestActiveReservation from './GuestActiveReservation';\nimport GuestActiveStayOverview from './GuestActiveStayOverview';";
}

// 2. Remove states
const s1 = findLine('// STEP 1: Room Selection Filters');
const s2 = findLine('// STEP 6: Confirmation State');
if (s1 !== -1 && s2 !== -1) {
  lines.splice(s1, s2 - s1);
}

// 3. Remove derived pricing variables
const dp = findLine('// Derived properties for Room Selection');
const ah = findLine('// Action Handlers');
if (dp !== -1 && ah !== -1) {
  lines.splice(dp, ah - dp);
}

// 4. Remove unused functions
const funcs = [
  'const handleSelectRoom',
  'const handleExtraGuestChange',
  'const simulateFileUpload',
  'const handleRemoveFile',
  'const triggerUploadClick',
  'const toggleService',
  'const handleSelectCategoryCard',
  'const renderCategoryCard',
  'const selectMealPlan',
  'const handleTransitionToPayment',
  'const handleBookSubmit',
  'const handleFinishConfirmation'
];

for (const fn of funcs) {
  let start = findLine(fn);
  if (start !== -1) {
    let braceCount = 0;
    let end = start;
    let foundOpen = false;
    for (let i = start; i < lines.length; i++) {
      braceCount += (lines[i].match(/\{/g) || []).length;
      braceCount -= (lines[i].match(/\}/g) || []).length;
      if (lines[i].includes('{')) foundOpen = true;
      if (foundOpen && braceCount === 0) {
        end = i;
        break;
      }
    }
    lines.splice(start, end - start + 1);
  }
}

// 5. Replace Guest Check-in Landing
const landStart = findLine('PHASE 2: GUEST CHECK-IN LANDING (status === \\\'booked\\\')');
let landEnd = findLine('PHASE 2: GUEST STAY DASHBOARD');
if (landStart !== -1 && landEnd !== -1) {
  // Find </main> above landEnd
  let actualEnd = landEnd - 1;
  while(actualEnd > landStart && !lines[actualEnd].includes('</main>')) {
    actualEnd--;
  }
  const rep = `      {/* ═══════════════════════════════════════════════════════════════════════
          PHASE 2: GUEST CHECK-IN LANDING (status === 'booked') 
      ═══════════════════════════════════════════════════════════════════════ */}
      <GuestActiveReservation
        activeBooking={activeBooking}
        activeReservation={activeReservation}
        wizardStep={wizardStep}
        guestHistory={guestHistory}
        user={user}
        liveBill={liveBill}
        paymentStatusInfo={paymentStatusInfo}
        isCheckingIn={isCheckingIn}
        handleSelfCheckIn={handleSelfCheckIn}
      />`;
  lines.splice(landStart - 1, actualEnd - landStart + 2, rep); // landStart is the comment, we want to replace the whole block
}

// 6. Replace Overview Tab
const overStart = findLine('{/* ── OVERVIEW TAB ─────────────────────────────────────────────── */}');
const servStart = findLine('{/* ── ROOM SERVICE TAB ──────────────────────────────────────────── */}');
if (overStart !== -1 && servStart !== -1) {
  const repOver = `            {/* ── OVERVIEW TAB ─────────────────────────────────────────────── */}
            {dashTab === 'overview' && (
              <GuestActiveStayOverview
                activeBooking={activeBooking}
                activeReservation={activeReservation}
                setDashTab={setDashTab}
                handleRequestCheckout={handleRequestCheckout}
                isRequestingCheckout={isRequestingCheckout}
                fetchStatus={fetchStatus}
              />
            )}`;
  lines.splice(overStart, servStart - overStart, repOver);
}

// 7. Replace GuestBookingWizard
const wizStart = findLine('PHASE 1: PRE-CHECKIN / NEW BOOKING WIZARD');
if (wizStart !== -1) {
  // Replace from wizStart-1 to end of file, then append `</div>);}`
  const repWiz = `      {/* ═══════════════════════════════════════════════════════════════════════
          PHASE 1: PRE-CHECKIN / NEW BOOKING WIZARD 
      ═══════════════════════════════════════════════════════════════════════ */}
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
    </div>
  );
}`;
  lines.splice(wizStart - 1, lines.length - wizStart + 1, repWiz);
}

fs.writeFileSync(path, lines.join('\n'));
console.log('Refactor completed successfully!');
