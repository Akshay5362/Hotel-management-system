import { FactoryResetService } from '../services/FactoryResetService.js';

// ─── Single canonical logger action ────────────────────────────────────────────
const ACTION = 'FACTORY_RESET_REQUEST';

/**
 * Emits a structured, multi-line log entry for every Factory Reset API call.
 * Records all Phase 1 invariants explicitly so terminal output is unambiguous.
 *
 * @param {import('express').Request} req
 * @param {number} httpStatus   - The HTTP status code being returned.
 * @returns {string}            - The unique requestId for correlation.
 */
function logFactoryResetRequest(req, httpStatus) {
  const requestId = `req_fr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const entry = {
    action     : ACTION,
    requestId,
    userId     : req.user?.id   || null,
    role       : req.user?.role || null,
    ip         : req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1',
    route      : req.originalUrl || req.url,
    timestamp  : new Date().toISOString(),
    // ── Phase 1 invariants (explicit) ──────────────────────────────────────
    phase      : 1,
    sqlExecuted: false,
    txStarted  : false,
    fsModified : false,
    httpStatus,
  };

  console.log(
    `\n[FactoryReset]\n` +
    `  Action     : ${entry.action}\n` +
    `  RequestID  : ${entry.requestId}\n` +
    `  User       : ${entry.userId ?? 'anonymous'} (${entry.role ?? 'none'})\n` +
    `  IP         : ${entry.ip}\n` +
    `  Route      : ${entry.route}\n` +
    `  Timestamp  : ${entry.timestamp}\n` +
    `  Phase      : ${entry.phase}\n` +
    `  Database   : untouched  (SQL executed: ${entry.sqlExecuted}, transaction: ${entry.txStarted})\n` +
    `  Filesystem : untouched  (modified: ${entry.fsModified})\n` +
    `  Response   : HTTP ${entry.httpStatus}\n`
  );

  return requestId;
}

// ─── Controllers ───────────────────────────────────────────────────────────────

/**
 * GET /api/system/factory-reset/status
 * Returns Phase 1 readiness status. No SQL or FS changes.
 */
export const getFactoryResetStatus = async (req, res) => {
  logFactoryResetRequest(req, 200);
  try {
    const statusData = await FactoryResetService.verifyReset();
    return res.status(200).json({
      success  : true,
      action   : ACTION,
      status   : 'Phase 1 - Architecture Ready',
      message  : 'Factory Reset service is initialized. Phase 2 implementation required for operational reset.',
      phase    : 1,
      database : 'untouched',
      filesystem: 'untouched',
      validation: statusData,
    });
  } catch (error) {
    return res.status(500).json({ success: false, action: ACTION, error: error.message });
  }
};

/**
 * POST /api/system/factory-reset
 * Phase 1 placeholder. Always returns HTTP 501 Not Implemented.
 * No SQL, no transaction, no filesystem modification occurs.
 */
export const factoryReset = async (req, res) => {
  logFactoryResetRequest(req, 501);

  // Phase 1: call verifyReset() (read-only validation only) then return 501.
  // Do NOT call factoryReset() or any destructive method.
  try {
    await FactoryResetService.verifyReset();
  } catch (_) {
    // verifyReset is read-only and should never throw in Phase 1,
    // but guard defensively so the 501 is still returned cleanly.
  }

  return res.status(501).json({
    success    : false,
    action     : ACTION,
    message    : 'Factory Reset is not implemented yet. Phase 2 required.',
    phase      : 1,
    sqlExecuted: false,
    txStarted  : false,
    fsModified : false,
  });
};
