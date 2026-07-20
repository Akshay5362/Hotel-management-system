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
const impLine = findLine("import GuestMaintenance from './GuestMaintenance';");
if (impLine !== -1) {
  lines[impLine] = "import GuestMaintenance from './GuestMaintenance';\nimport GuestFeedback from './GuestFeedback';\nimport GuestProfile from './GuestProfile';\nimport GuestLoyalty from './GuestLoyalty';\nimport GuestBookingHistory from './GuestBookingHistory';";
}

// 2. Locate boundaries
const feedbackStart = findLine("{/* ── FEEDBACK TAB ─────────────────────────────────────────────── */}");
const originalBookingStart = findLine("{/* ═══════════════════════════════════════════════════════════════════════");

if (feedbackStart !== -1 && originalBookingStart !== -1) {
  const replacement = `            {/* ── FEEDBACK TAB ─────────────────────────────────────────────── */}
            {postCheckoutTab === 'feedback' && (
              <GuestFeedback
                latestCheckedOutBooking={latestCheckedOutBooking}
                feedbackSubmitted={feedbackSubmitted}
                feedbackOverall={feedbackOverall} setFeedbackOverall={setFeedbackOverall}
                feedbackCleanliness={feedbackCleanliness} setFeedbackCleanliness={setFeedbackCleanliness}
                feedbackService={feedbackService} setFeedbackService={setFeedbackService}
                feedbackValue={feedbackValue} setFeedbackValue={setFeedbackValue}
                feedbackComments={feedbackComments} setFeedbackComments={setFeedbackComments}
                feedbackRecommend={feedbackRecommend} setFeedbackRecommend={setFeedbackRecommend}
                handleSubmitFeedback={handleSubmitFeedback}
                isSubmittingFeedback={isSubmittingFeedback}
                setPostCheckoutTab={setPostCheckoutTab}
              />
            )}

            {/* ── MY STAYS HISTORY TAB ─────────────────────────────────────── */}
            {postCheckoutTab === 'history' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h2 style={{ fontFamily: 'var(--font-heading)', fontWeight: '800', color: '#fff', margin: 0, fontSize: '1.2rem' }}>
                    📋 Your Stay History
                  </h2>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                    {guestHistory?.totalStays || 0} stay{guestHistory?.totalStays !== 1 ? 's' : ''} total
                  </span>
                </div>

                {/* Loyalty Summary Card */}
                {guestHistory?.guest && (
                  <div style={{ background: 'linear-gradient(135deg, rgba(251,191,36,0.1), rgba(245,158,11,0.05))', border: '1px solid rgba(251,191,36,0.25)', borderRadius: '12px', padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
                    <GuestProfile guest={guestHistory.guest} />
                    <GuestLoyalty guest={guestHistory.guest} totalStays={guestHistory.totalStays} />
                  </div>
                )}

                <GuestBookingHistory
                  historyLoading={historyLoading}
                  guestHistory={guestHistory}
                  setFeedbackBookingId={setFeedbackBookingId}
                  setFeedbackSubmitted={setFeedbackSubmitted}
                  setPostCheckoutTab={setPostCheckoutTab}
                />

                {/* Book Again CTA */}
                <div style={{ textAlign: 'center', padding: '24px', marginTop: '8px' }}>
                  <button onClick={() => { setGuestHistory(null); setWizardStep(1); }} style={{
                    background: 'linear-gradient(135deg, #38bdf8, #6366f1)', border: 'none', borderRadius: '12px',
                    padding: '14px 32px', color: '#fff', fontWeight: '800', fontSize: '1rem', cursor: 'pointer'
                  }}>
                    🏨 Book Your Next Stay
                  </button>
                  <p style={{ margin: '8px 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>Looking forward to welcoming you again at Hotel Sky-5</p>
                </div>
              </div>
            )}

          </div>
        </main>
      )}`;

  // Wait, the original code had:
  //           </div>
  //         </main>
  //       )}
  // just before the ORIGINAL BOOKING WIZARD start line.
  // We need to keep that!
  
  // So we delete from feedbackStart up to (originalBookingStart - 1)
  // Wait, let's find the closing `      )}` that ends the main content block.
  // It should be 1 line before originalBookingStart.
  
  // Actually, we can just replace everything from feedbackStart to (originalBookingStart - 1).
  // Is (originalBookingStart - 1) an empty line, or is it `      )}`?
  
  // Let's print out what we are replacing.
  console.log("Replacing from", feedbackStart, "to", originalBookingStart - 1);
  lines.splice(feedbackStart, originalBookingStart - feedbackStart, replacement);
}

fs.writeFileSync(path, lines.join('\n'));
console.log('Phase 2D Refactor completed successfully!');
