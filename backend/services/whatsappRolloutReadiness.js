/**
 * backend/services/whatsappRolloutReadiness.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H8-G — the final code-level readiness gate before a controlled rollout.
 *
 * It answers one question honestly: what, exactly, is still standing between
 * this deployment and sending a real WhatsApp message. It changes nothing,
 * enables nothing, and performs no rollout of its own.
 *
 * WHAT IT IS NOT
 * It is not a health check against Meta. It opens no socket, authenticates
 * nothing, and imports neither a database nor a transport. Everything here is
 * read from configuration and from the existing flag helpers, so it can run in
 * any process without side effects of any kind.
 *
 * THE HONEST PART
 * Three prerequisites cannot be verified from inside this codebase: whether
 * Meta has approved the template, whether the webhook is actually reachable
 * from the internet, and whether the credentials in the environment are real
 * rather than merely well-formed. No code path sets any of them satisfied,
 * which is why `production_ready` is false even when every local check passes.
 * Reporting otherwise would be reporting a guess as a fact.
 *
 * SAFE OUTPUT ONLY
 * Everything returned is a boolean, a small integer, a reason CODE or the NAME
 * of an absent configuration key. No value read from configuration is ever
 * returned or logged: not a token, not a secret, not a verify token, not a
 * phone number. Presence is tested; contents never leave.
 */

import {
  isWhatsAppWebhookEnabled,
  isWhatsAppVerificationEnabled,
  isWhatsAppDecisionsEnabled,
  isWhatsAppOutboundEnabled
} from '../config/featureFlags.js';
import { getWhatsAppOutboundStatus } from './whatsappOutboundClient.js';

/** The staged progression this integration is designed to roll out through. */
export const ROLLOUT_STAGE = Object.freeze({
  INERT: 0,
  WEBHOOK_ONLY: 1,
  VERIFICATION: 2,
  OUTBOUND: 3,
  FULL: 4
});

export const ROLLOUT_STAGE_NAME = Object.freeze({
  0: 'INERT',
  1: 'WEBHOOK_ONLY',
  2: 'VERIFICATION',
  3: 'OUTBOUND',
  4: 'FULL'
});

/** Reason codes. Codes, never messages containing values. */
export const BLOCKED_REASON = Object.freeze({
  FLAG_DISABLED: 'FLAG_DISABLED',
  CONFIG_MISSING: 'CONFIG_MISSING',
  CONFIG_INVALID: 'CONFIG_INVALID',
  PREREQUISITE_NOT_READY: 'PREREQUISITE_NOT_READY',
  EXTERNAL_PREREQUISITE_PENDING: 'EXTERNAL_PREREQUISITE_PENDING'
});

/**
 * The three things no amount of local configuration can establish. Each stays
 * pending until a human confirms it outside this system; there is deliberately
 * no environment variable, database field or code path that marks one done,
 * because any such switch would just be a way to lie to ourselves.
 */
export const EXTERNAL_PREREQUISITES = Object.freeze([
  Object.freeze({
    key: 'META_TEMPLATE_APPROVAL',
    description: 'Meta must approve the utility template before any business-initiated message can be delivered.'
  }),
  Object.freeze({
    key: 'PUBLIC_WEBHOOK_INGRESS',
    description: 'Meta must be able to reach the webhook from the internet. No ingress is configured by this codebase.'
  }),
  Object.freeze({
    key: 'META_CREDENTIAL_PROVISIONING',
    description: 'The configured credentials must be real and authorised. Structural validity is all that is checked here.'
  })
]);

function present(name) {
  return Boolean(String(process.env[name] ?? '').trim());
}

/** One capability's verdict. Keys and codes only; never a configured value. */
function capability({ enabled, requiredKeys = [], invalidKeys = [], prerequisitesReady = true }) {
  const missing = requiredKeys.filter(k => !present(k));
  const blocked_reasons = [];
  if (!enabled) blocked_reasons.push(BLOCKED_REASON.FLAG_DISABLED);
  if (missing.length) blocked_reasons.push(BLOCKED_REASON.CONFIG_MISSING);
  if (invalidKeys.length) blocked_reasons.push(BLOCKED_REASON.CONFIG_INVALID);
  if (!prerequisitesReady) blocked_reasons.push(BLOCKED_REASON.PREREQUISITE_NOT_READY);

  const configured = missing.length === 0 && invalidKeys.length === 0;
  return Object.freeze({
    enabled,
    configured,
    ready: enabled && configured && prerequisitesReady,
    missing: Object.freeze([...missing, ...invalidKeys]),
    blocked_reasons: Object.freeze(blocked_reasons)
  });
}

/**
 * Which stage the CURRENT flag combination corresponds to.
 *
 * The progression is cumulative, so a combination that skips a step — decisions
 * on while the webhook is off, say — does not earn the higher stage. It is
 * reported at the highest stage it genuinely satisfies, which for an incomplete
 * combination is a lower one, never a flattering one.
 */
export function getRolloutStage() {
  const webhook = isWhatsAppWebhookEnabled();
  const verification = isWhatsAppVerificationEnabled();
  const decisions = isWhatsAppDecisionsEnabled();
  const outbound = isWhatsAppOutboundEnabled();

  if (webhook && verification && outbound && decisions) return ROLLOUT_STAGE.FULL;
  if (webhook && verification && outbound) return ROLLOUT_STAGE.OUTBOUND;
  if (webhook && verification) return ROLLOUT_STAGE.VERIFICATION;
  if (webhook) return ROLLOUT_STAGE.WEBHOOK_ONLY;
  return ROLLOUT_STAGE.INERT;
}

/**
 * True only when a flag combination is one of the designed stages.
 *
 * Enabling decisions before the webhook, or outbound before verification, is
 * not a stage: it is a configuration that would half-work, and it is reported
 * as unsafe rather than quietly accepted.
 */
export function isSafeFlagCombination() {
  const webhook = isWhatsAppWebhookEnabled();
  const verification = isWhatsAppVerificationEnabled();
  const decisions = isWhatsAppDecisionsEnabled();
  const outbound = isWhatsAppOutboundEnabled();

  if (!webhook) return !verification && !decisions && !outbound;   // Stage 0
  if (!verification) return !decisions && !outbound;               // Stage 1
  if (!outbound) return !decisions;                                // Stage 2
  return true;                                                     // Stage 3 or 4
}

/**
 * The whole picture, safe to log, safe to return from an authenticated
 * diagnostic endpoint, and safe to paste into a ticket.
 */
export function getWhatsAppRolloutReadiness() {
  const outboundStatus = getWhatsAppOutboundStatus();

  const webhook = capability({
    enabled: isWhatsAppWebhookEnabled(),
    requiredKeys: ['WHATSAPP_APP_SECRET', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN']
  });

  const verification = capability({
    enabled: isWhatsAppVerificationEnabled(),
    requiredKeys: ['WHATSAPP_VERIFICATION_SECRET'],
    // An inbound code can only arrive through a working webhook.
    prerequisitesReady: webhook.ready
  });

  // Outbound reuses the H8-F status rather than restating which keys matter.
  const outbound = Object.freeze({
    enabled: outboundStatus.outbound_enabled,
    configured: outboundStatus.graph_configured && outboundStatus.credentials_configured && outboundStatus.template_configured,
    ready: outboundStatus.ready,
    missing: outboundStatus.missing,
    blocked_reasons: Object.freeze([
      ...(outboundStatus.outbound_enabled ? [] : [BLOCKED_REASON.FLAG_DISABLED]),
      ...(outboundStatus.missing.length ? [BLOCKED_REASON.CONFIG_MISSING] : [])
    ])
  });

  const decisions = capability({
    enabled: isWhatsAppDecisionsEnabled(),
    // A decision arrives inbound and is answered outbound, so both must work.
    prerequisitesReady: webhook.ready && outbound.ready
  });

  const stage = getRolloutStage();
  const safeCombination = isSafeFlagCombination();

  // `outbound.ready` is currently implied by `decisions.ready`, because decisions
  // take outbound readiness as a prerequisite above. It is listed anyway rather
  // than relying on that implication: if the decisions prerequisite is ever
  // relaxed, this conjunct becomes load-bearing again and readiness stays
  // correct without anyone having to notice. Mutation testing cannot distinguish
  // its removal today, and that is expected — it is deliberate redundancy, not
  // an untested protection.
  const code_ready = webhook.ready && verification.ready && outbound.ready && decisions.ready && safeCombination;

  // Nothing here can satisfy an external prerequisite, so this is always false.
  // That is the point: local configuration is not evidence about Meta.
  const externalsSatisfied = false;

  const blocked_reasons = [];
  if (!safeCombination) blocked_reasons.push(BLOCKED_REASON.PREREQUISITE_NOT_READY);
  if (!code_ready) blocked_reasons.push(BLOCKED_REASON.CONFIG_MISSING);
  blocked_reasons.push(BLOCKED_REASON.EXTERNAL_PREREQUISITE_PENDING);

  return Object.freeze({
    stage,
    stage_name: ROLLOUT_STAGE_NAME[stage],
    safe_flag_combination: safeCombination,
    capabilities: Object.freeze({ webhook, verification, outbound, decisions }),
    // Everything this codebase can check for itself.
    code_ready,
    // Never true from code. See EXTERNAL_PREREQUISITES.
    production_ready: code_ready && externalsSatisfied,
    external_prerequisites: Object.freeze(EXTERNAL_PREREQUISITES.map(p =>
      Object.freeze({ key: p.key, status: 'PENDING', description: p.description }))),
    blocked_reasons: Object.freeze([...new Set(blocked_reasons)])
  });
}

export default { getWhatsAppRolloutReadiness, getRolloutStage, isSafeFlagCombination };
