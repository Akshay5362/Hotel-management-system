const fs = require('fs');

const path = 'src/components/GuestDashboard.jsx';
let content = fs.readFileSync(path, 'utf8');

// 1. Add imports
content = content.replace(
  "import PaymentPanel from './PaymentPanel';",
  "import PaymentPanel from './PaymentPanel';\nimport GuestBookingWizard from './GuestBookingWizard';\nimport GuestActiveReservation from './GuestActiveReservation';\nimport GuestActiveStayOverview from './GuestActiveStayOverview';"
);

// 2. Remove states from line 7 to 58 (approximately)
content = content.replace(/\/\/ STEP 1: Room Selection Filters[\s\S]*?\/\/ STEP 6: Confirmation State/, '// STEP 6: Confirmation State');

// 3. Remove unused functions
const functionsToRemove = [
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

let lines = content.split('\n');
let finalLines = [];
let skip = false;
let braceCount = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  
  if (!skip) {
    let funcMatch = functionsToRemove.find(f => line.includes(f));
    if (funcMatch && line.includes('=>')) {
      skip = true;
      braceCount = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (braceCount === 0 && line.includes('}')) {
        skip = false;
      }
      continue;
    }
    
    // Check for derived block removal
    if (line.includes('const roomTypesInfo = {')) {
      skip = true;
      braceCount = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      continue;
    }
    
    // Single line variables we can just ignore for now or delete.
    if (line.trim().startsWith('const vacantRooms =') ||
        line.trim().startsWith('let filteredRooms =') ||
        line.trim().startsWith('const cap =') ||
        line.trim().startsWith('const selectedRoom =') ||
        line.trim().startsWith('const baseRate =') ||
        line.trim().startsWith('const numGuests =') ||
        line.trim().startsWith('let discountPercent =') ||
        line.trim().startsWith('const loyaltyDiscount =') ||
        line.trim().startsWith('let servicesTotal =') ||
        line.trim().startsWith('const servicesList =') ||
        line.trim().startsWith('let activeMealPlan =') ||
        line.trim().startsWith('const isBreakfastFree =') ||
        line.trim().startsWith('const taxesAmount =') ||
        line.trim().startsWith('const totalStayPrice =')) {
        // Just skip these lines
        continue;
    }
    // Also skip block of if (activeMealPlan === 'CP') etc.
    if (line.trim().startsWith('if (activeMealPlan ===') || line.trim().startsWith('if (selectedCategory !==') || line.trim().startsWith('filteredRooms =') || line.trim().startsWith('if (user.loyalty_tier ===') || line.trim().startsWith('else if (user.loyalty_tier ===')) {
       // It's getting too complicated to parse manually by line.
       // It's better to just use regex to replace the known blocks in string format.
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

let newContent = finalLines.join('\n');

// Replace the derived block with a regex since line by line is hard
newContent = newContent.replace(/\/\/ Derived properties for Room Selection[\s\S]*?\/\/ Action Handlers/g, '// Action Handlers');
newContent = newContent.replace(/\/\/ Calculate pricing breakdown[\s\S]*?\/\/ Phase 3: Submit feedback/g, '// Phase 3: Submit feedback');
// Wait, the above will delete EVERYTHING from 'Calculate pricing breakdown' to 'Submit feedback'! Including `apiFetch`, `loadBill`, `loadNotifications`, `loadGuestHistory`!
// That is dangerous.

// I'll rewrite this script.
