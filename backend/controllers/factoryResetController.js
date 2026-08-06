import { FactoryResetService } from '../services/FactoryResetService.js';

// ─── Canonical required confirmation phrase ────────────────────────────────────
const REQUIRED_PHRASE = 'RESET HOTEL DATA';

// ─── Logger ───────────────────────────────────────────────────────────────────
function logRequest(req, httpStatus, extra = {}) {
  const requestId = `req_fr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  console.log(
    `\n[FactoryReset]\n` +
    `  RequestID  : ${requestId}\n` +
    `  User       : ${req.user?.id ?? 'anonymous'} (${req.user?.role ?? 'none'})\n` +
    `  IP         : ${req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'}\n` +
    `  Route      : ${req.originalUrl || req.url}\n` +
    `  Timestamp  : ${new Date().toISOString()}\n` +
    `  HTTP       : ${httpStatus}\n` +
    `  ${Object.entries(extra).map(([k, v]) => `${k}: ${v}`).join('\n  ')}\n`
  );
  return requestId;
}

// ─── GET /api/system/factory-reset/status ─────────────────────────────────────
// Returns a preflight read-only check of current record counts.
export const getFactoryResetStatus = async (req, res) => {
  logRequest(req, 200, { action: 'STATUS' });
  try {
    const statusData = await FactoryResetService.verifyReset();
    return res.status(200).json({
      success:    true,
      status:     'Ready',
      message:    'Factory Reset service is operational. All systems ready.',
      validation: statusData,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// ─── POST /api/system/factory-reset ───────────────────────────────────────────
// Executes the full factory reset.
// Body: { confirmationPhrase: "RESET HOTEL DATA" }
export const factoryReset = async (req, res) => {
  const { confirmationPhrase } = req.body || {};

  // ── 1. Confirmation phrase validation ────────────────────────────────────────
  if (!confirmationPhrase || confirmationPhrase.trim() !== REQUIRED_PHRASE) {
    logRequest(req, 400, { action: 'REJECTED', reason: 'Wrong or missing confirmation phrase' });
    return res.status(400).json({
      success: false,
      error:   `Confirmation phrase incorrect. You must type exactly: ${REQUIRED_PHRASE}`,
    });
  }

  logRequest(req, 202, {
    action:   'EXECUTING',
    operator: req.user?.id,
    phrase:   confirmationPhrase,
  });

  try {
    const result = await FactoryResetService.factoryReset();

    logRequest(req, 200, {
      action:     'COMPLETED',
      executionMs: result.summary.executionMs,
      guests:     result.summary.guestsDeleted,
      bookings:   result.summary.bookingsDeleted,
    });

    return res.status(200).json(result);
  } catch (error) {
    logRequest(req, 500, { action: 'FAILED', error: error.message });
    return res.status(500).json({
      success: false,
      error:   error.message,
    });
  }
};
