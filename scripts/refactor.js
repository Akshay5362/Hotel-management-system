const fs = require('fs');

const path = 'src/components/GuestDashboard.jsx';
let content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n');

// 1. Add imports
const imports = `import GuestBookingWizard from './GuestBookingWizard';
import GuestActiveReservation from './GuestActiveReservation';
import GuestActiveStayOverview from './GuestActiveStayOverview';`;
lines.splice(2, 0, imports);

// 2. Remove states from line 7 to 58 (Wait, lines might have shifted. Let's find them by string)
const step1Index = lines.findIndex(l => l.includes('// STEP 1: Room Selection Filters'));
const step6Index = lines.findIndex(l => l.includes('// STEP 6: Confirmation State'));

if (step1Index !== -1 && step6Index !== -1) {
  // We want to delete from step1Index to step6Index - 1
  lines.splice(step1Index, step6Index - step1Index);
}

// 3. Replace Phase 2 Guest Check-In Landing
const landingStart = lines.findIndex(l => l.includes('PHASE 2: GUEST CHECK-IN LANDING (status === \\\'booked\\\')'));
const landingEnd = lines.findIndex(l => l.includes('PHASE 2: GUEST STAY DASHBOARD (status === \\\'occupied\\\')'));
// Wait, there's a </main> before PHASE 2: GUEST STAY DASHBOARD
// Let's find the </main> before landingEnd
let landingEndActual = landingEnd - 1;
while(landingEndActual > landingStart && !lines[landingEndActual].includes('</main>')) {
  landingEndActual--;
}

if (landingStart !== -1 && landingEndActual !== -1) {
  const replacement = `      {/* ═══════════════════════════════════════════════════════════════════════
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
  lines.splice(landingStart, landingEndActual - landingStart + 1, replacement);
}

// 4. Replace Overview Tab
const overviewStart = lines.findIndex(l => l.includes('{/* ── OVERVIEW TAB ─────────────────────────────────────────────── */}'));
const serviceStart = lines.findIndex(l => l.includes('{/* ── ROOM SERVICE TAB ──────────────────────────────────────────── */}'));

if (overviewStart !== -1 && serviceStart !== -1) {
  const replacementOverview = `            {/* ── OVERVIEW TAB ─────────────────────────────────────────────── */}
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
  lines.splice(overviewStart, serviceStart - overviewStart, replacementOverview);
}

// 5. Replace GuestBookingWizard (Steps 1-5 + 6)
const phase1Start = lines.findIndex(l => l.includes('PHASE 1: PRE-CHECKIN / NEW BOOKING'));
// We want to delete everything from phase1Start to the end, except the last </div> and ); }
const replacementWizard = `      {/* ═══════════════════════════════════════════════════════════════════════
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

if (phase1Start !== -1) {
  lines.splice(phase1Start, lines.length - phase1Start, replacementWizard);
}

// 6. Delete unused functions that were moved to GuestBookingWizard
// - handleSelectRoom
// - handleExtraGuestChange
// - simulateFileUpload
// - handleRemoveFile
// - triggerUploadClick
// - toggleService
// - handleSelectCategoryCard
// - renderCategoryCard
// - selectMealPlan
// - handleTransitionToPayment
// - handleBookSubmit
// - handleFinishConfirmation
const funcsToRemove = [
  'const handleSelectRoom =',
  'const handleExtraGuestChange =',
  'const simulateFileUpload =',
  'const handleRemoveFile =',
  'const triggerUploadClick =',
  'const toggleService =',
  'const handleSelectCategoryCard =',
  'const renderCategoryCard =',
  'const selectMealPlan =',
  'const handleTransitionToPayment =',
  'const handleBookSubmit =',
  'const handleFinishConfirmation ='
];

let finalLines = [];
let skip = false;
let braceCount = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  
  if (!skip) {
    let funcMatch = funcsToRemove.find(f => line.includes(f));
    if (funcMatch) {
      skip = true;
      braceCount = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (braceCount === 0 && line.includes('}')) {
        skip = false;
      }
      continue;
    }
    
    // Derived pricing variables in GuestDashboard.jsx
    if (line.includes('const roomTypesInfo = {') || 
        line.includes('const vacantRooms =') ||
        line.includes('let filteredRooms =') ||
        line.includes('const cap = parseInt(') ||
        line.includes('const selectedRoom = vacantRooms') ||
        line.includes('const baseRate = selectedRoom') ||
        line.includes('const numGuests = parseInt(') ||
        line.includes('let discountPercent = 0;') ||
        line.includes('const loyaltyDiscount =') ||
        line.includes('let servicesTotal = 0;') ||
        line.includes('const servicesList = [];') ||
        line.includes('let activeMealPlan =') ||
        line.includes('const isBreakfastFree =') ||
        line.includes('const taxesAmount =') ||
        line.includes('const totalStayPrice =')) {
          
        // just a heuristic, we can also delete block by block
    }
  } else {
    braceCount += (line.match(/\{/g) || []).length;
    braceCount -= (line.match(/\}/g) || []).length;
    if (braceCount <= 0) {
      skip = false;
    }
    continue;
  }
  finalLines.push(line);
}

// Write back
fs.writeFileSync(path + '.temp', finalLines.join('\\n'));
console.log('Done!');
