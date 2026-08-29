import { FactoryResetCutoverService } from '../services/factoryResetCutoverService.js';

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
    const statusData = await FactoryResetCutoverService.verifyReset();
    return res.status(200).json({
      success:    true,
      status:     'Ready',
      message:    'Firestore Factory Reset service is operational. All systems ready.',
      validation: statusData,
    });
  } catch (error) {
    const statusCode = error.status || 500;
    return res.status(statusCode).json({ success: false, error: error.message, code: error.code });
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
      code:    'INVALID_CONFIRMATION_PHRASE'
    });
  }

  logRequest(req, 202, {
    action:   'EXECUTING',
    operator: req.user?.id,
    phrase:   confirmationPhrase,
  });

  try {
    const operatorId = String(req.user?.id || req.user?.uid || 'system');
    const result = await FactoryResetCutoverService.factoryReset(operatorId);

    logRequest(req, 200, {
      action:     'COMPLETED',
      executionMs: result.summary?.executionMs,
      guests:     result.summary?.guestsDeleted,
      bookings:   result.summary?.bookingsDeleted,
    });

    return res.status(200).json(result);
  } catch (error) {
    const statusCode = error.status || 500;
    logRequest(req, statusCode, { action: 'FAILED', error: error.message });
    return res.status(statusCode).json({
      success: false,
      error:   error.message,
      code:    error.code
    });
  }
};
