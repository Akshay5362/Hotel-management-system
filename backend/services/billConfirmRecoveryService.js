/**
 * billConfirmRecoveryService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H5 — crash recovery for PO-assisted bill confirmation.
 *
 * THE PROBLEM THIS EXISTS TO SOLVE
 * The PO path cannot write the bill and the goods receipt in one transaction:
 * the Phase F engine owns its own transaction and is deliberately untouched.
 * So there are two commits, and a process that dies between them used to leave
 * the bill marked CONFIRMED with no receipt — permanently, and invisibly.
 *
 * THE FIX
 * The bill is claimed as CONFIRMING rather than CONFIRMED, and the claim records
 * the exact receipt id the engine is about to produce. That id is deterministic:
 * `receiptIdForKey(idempotency_key)`. Recovery is therefore a single
 * document-reference read, never a scan and never a new index.
 *
 *     receipt exists  →  finish the job: CONFIRMED, linked to that receipt
 *     receipt absent  →  release the claim back to the status it had before
 *
 * Neither branch invents anything. A released claim is remembered by receipt
 * id, so if a straggler engine call commits after the release, the next
 * confirmation finds that receipt and finalises it instead of creating a
 * second one. That is what stops the opposite failure — a live receipt beside
 * a bill that looks ready to confirm again.
 *
 * THIS SERVICE POSTS NO STOCK. It reads one receipt and writes one bill.
 */

import { db } from '../config/firebaseAdmin.js';
import {
  billRef, getInventoryBillByIdFirestore
} from '../repositories/firestore/inventoryBillsRepository.js';
import { getGoodsReceiptByIdFirestore } from '../repositories/firestore/goodsReceiptsRepository.js';
import { createAuditLogFirestore } from '../repositories/firestore/auditLogsRepository.js';
import { BILL_STATUS, BILL_CONFIRMATION_STALE_MS } from '../utils/inventoryConstants.js';

/** How many released claims to remember. More than this and something is wrong. */
const MAX_RELEASED_CLAIMS = 10;

function fail(message, code, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

/** Milliseconds since the claim was taken, or Infinity when it cannot be read. */
export function claimAgeMs(claim, now = Date.now()) {
  const t = Date.parse(claim?.claimed_at || '');
  return Number.isFinite(t) ? now - t : Infinity;
}

export function isClaimStale(claim, now = Date.now()) {
  return claimAgeMs(claim, now) >= BILL_CONFIRMATION_STALE_MS;
}

async function audit(action, details, actor, businessDate, logId) {
  try {
    await createAuditLogFirestore({
      log_id: logId,
      action,
      details: { ...details, actor_role: actor?.role || null },
      user_id: actor?.uid || 'system_recovery',
      business_date: businessDate || undefined
    });
  } catch (err) {
    // Recovery has already corrected the bill; a failed audit write must not
    // undo that, and must not make the caller think recovery failed.
    console.warn(`[BillConfirmRecovery] audit log failed (${action}): ${err.message}`);
  }
}

/**
 * Finalises a bill whose receipt is known to exist.
 *
 * Transactional and re-checked: the bill must still be CONFIRMING under the
 * same claim, so two recoveries racing cannot both write.
 */
async function finalise(billDocRef, claim, receipt, actor, reason) {
  const receiptId = receipt.receipt_id || receipt.id;
  const now = new Date().toISOString();
  const applied = await db.runTransaction(async (txn) => {
    const snap = await txn.get(billDocRef);
    if (!snap.exists) return false;
    const live = snap.data();
    if (live.status === BILL_STATUS.CONFIRMED && live.receipt_id) return false;   // already done
    if (live.status !== BILL_STATUS.CONFIRMING) return false;                     // someone else settled it
    if (live.confirmation_claim?.claim_id && claim?.claim_id &&
        live.confirmation_claim.claim_id !== claim.claim_id) return false;        // a newer claim owns it
    txn.update(billDocRef, {
      status: BILL_STATUS.CONFIRMED,
      receipt_id: receiptId,
      po_id: claim?.po_id ?? live.po_id ?? null,
      mode: claim?.mode || live.mode || 'PO',
      location_id: claim?.location_id ?? live.location_id ?? null,
      supplier_id: claim?.supplier_id ?? live.supplier_id ?? null,
      confirmed_by_uid: claim?.claimed_by_uid ?? live.confirmed_by_uid ?? null,
      confirmed_by_name: claim?.claimed_by_name ?? live.confirmed_by_name ?? null,
      confirmed_at: live.confirmed_at || claim?.claimed_at || now,
      confirmation_claim: null,
      updated_at: now
    });
    return true;
  });
  return { applied, receiptId, reason };
}

/**
 * Releases a claim whose receipt does not exist, back to the status the bill
 * held before the claim.
 *
 * The receipt is re-read INSIDE the transaction, so a receipt that appeared
 * between the outer check and here is not overwritten with a release. The
 * released receipt id is remembered either way.
 */
async function release(billDocRef, claim, actor, reason) {
  const now = new Date().toISOString();
  const outcome = await db.runTransaction(async (txn) => {
    const snap = await txn.get(billDocRef);
    if (!snap.exists) return { applied: false, why: 'bill missing' };
    const live = snap.data();
    if (live.status !== BILL_STATUS.CONFIRMING) return { applied: false, why: `status is ${live.status}` };
    if (live.confirmation_claim?.claim_id && claim?.claim_id &&
        live.confirmation_claim.claim_id !== claim.claim_id) {
      return { applied: false, why: 'a newer claim owns this bill' };
    }
    const prior = claim?.prior_status && claim.prior_status !== BILL_STATUS.CONFIRMING
      ? claim.prior_status
      : BILL_STATUS.IN_REVIEW;
    const released = Array.isArray(live.released_claims) ? [...live.released_claims] : [];
    if (claim?.receipt_id) {
      released.push({ receipt_id: claim.receipt_id, released_at: now, reason });
    }
    txn.update(billDocRef, {
      status: prior,
      receipt_id: null,
      confirmed_by_uid: null,
      confirmed_by_name: null,
      confirmed_at: null,
      confirmation_claim: null,
      released_claims: released.slice(-MAX_RELEASED_CLAIMS),
      updated_at: now
    });
    return { applied: true, prior };
  });
  return outcome;
}

export const BillConfirmRecoveryService = {
  /**
   * Settles an outstanding confirmation claim on one bill.
   *
   * Called before every confirmation attempt, and callable on its own. Safe to
   * run repeatedly: a bill that is not CONFIRMING is left alone.
   *
   * @param {string} billId
   * @param {object} [opts]
   * @param {boolean} [opts.force] settle even a claim that is not yet stale.
   *   Used by the confirmation path only when it owns the claim itself.
   * @returns {{ settled: boolean, outcome: string, receipt_id?: string, status?: string }}
   */
  async settle(billId, { force = false, actor = null } = {}) {
    const bill = await getInventoryBillByIdFirestore(billId);
    if (!bill) throw fail('Bill not found.', 'BILL_NOT_FOUND', 404);

    // ── A receipt from a previously RELEASED claim that committed late ───────
    // The dangerous case: the bill reads as receivable while a real receipt
    // exists. Checked first, and by document reference only.
    for (const rc of (bill.released_claims || [])) {
      if (!rc?.receipt_id) continue;
      const late = await getGoodsReceiptByIdFirestore(rc.receipt_id);
      if (!late) continue;
      const res = await finalise(
        billRef(bill.id),
        { claim_id: bill.confirmation_claim?.claim_id, po_id: late.po_id, mode: 'PO', receipt_id: rc.receipt_id },
        late, actor, 'LATE_RECEIPT_AFTER_RELEASE'
      );
      // finalise() only writes a CONFIRMING bill. A released bill is not
      // CONFIRMING, so re-claim it as CONFIRMING first and then finalise.
      if (!res.applied) {
        await db.runTransaction(async (txn) => {
          const snap = await txn.get(billRef(bill.id));
          if (!snap.exists) return;
          const live = snap.data();
          if (live.status === BILL_STATUS.CONFIRMED && live.receipt_id) return;
          txn.update(billRef(bill.id), {
            status: BILL_STATUS.CONFIRMED,
            receipt_id: rc.receipt_id,
            mode: live.mode || 'PO',
            po_id: live.po_id ?? late.po_id ?? null,
            confirmed_at: live.confirmed_at || new Date().toISOString(),
            confirmation_claim: null,
            updated_at: new Date().toISOString()
          });
        });
      }
      await audit('INVENTORY_BILL_CONFIRMATION_RECOVERED', {
        bill_id: bill.id, receipt_id: rc.receipt_id, mode: 'PO',
        recovery: 'LATE_RECEIPT_AFTER_RELEASE',
        detail: 'A released claim\'s receipt was found to exist; the bill was finalised rather than confirmed a second time.'
      }, actor, late.business_date, `inv_billrec_${rc.receipt_id}`);
      return { settled: true, outcome: 'FINALISED_LATE_RECEIPT', receipt_id: rc.receipt_id, status: BILL_STATUS.CONFIRMED };
    }

    if (bill.status !== BILL_STATUS.CONFIRMING) {
      return { settled: false, outcome: 'NOT_CONFIRMING', status: bill.status };
    }

    const claim = bill.confirmation_claim || null;

    // A CONFIRMING bill with no claim record cannot be reasoned about from the
    // bill alone. Treated as stale so it can never strand, but never finalised
    // on a guess — without a receipt id there is nothing to check.
    if (!claim || !claim.receipt_id) {
      if (!force && !isClaimStale(claim)) {
        return { settled: false, outcome: 'CLAIM_FRESH', status: bill.status };
      }
      const out = await release(billRef(bill.id), claim, actor, 'CLAIM_WITHOUT_RECEIPT_REFERENCE');
      if (out.applied) {
        await audit('INVENTORY_BILL_CONFIRMATION_RELEASED', {
          bill_id: bill.id, mode: 'PO', recovery: 'CLAIM_WITHOUT_RECEIPT_REFERENCE',
          released_to: out.prior,
          detail: 'A CONFIRMING bill carried no claim reference, so no receipt could be identified. Released without creating anything.'
        }, actor, bill.business_date, `inv_billrel_${bill.id}_${Date.now()}`);
      }
      return { settled: out.applied, outcome: out.applied ? 'RELEASED' : 'NO_CHANGE', status: out.prior };
    }

    if (!force && !isClaimStale(claim)) {
      return { settled: false, outcome: 'CLAIM_FRESH', status: bill.status, receipt_id: claim.receipt_id };
    }

    // The whole recovery decision: one document-reference read.
    const receipt = await getGoodsReceiptByIdFirestore(claim.receipt_id);

    if (receipt) {
      const res = await finalise(billRef(bill.id), claim, receipt, actor, 'RECEIPT_FOUND');
      if (res.applied) {
        await audit('INVENTORY_BILL_CONFIRMATION_RECOVERED', {
          bill_id: bill.id, receipt_id: res.receiptId, receipt_number: receipt.receipt_number,
          po_id: claim.po_id || null, mode: claim.mode || 'PO',
          recovery: 'RECEIPT_FOUND', claim_id: claim.claim_id || null, claimed_at: claim.claimed_at || null,
          detail: 'The goods receipt for this claim exists, so the bill was finalised against it. No stock was posted by this recovery.'
        }, actor, receipt.business_date, `inv_billrec_${res.receiptId}`);
      }
      return { settled: res.applied, outcome: 'FINALISED', receipt_id: res.receiptId, status: BILL_STATUS.CONFIRMED };
    }

    const out = await release(billRef(bill.id), claim, actor, 'NO_RECEIPT');
    if (out.applied) {
      await audit('INVENTORY_BILL_CONFIRMATION_RELEASED', {
        bill_id: bill.id, po_id: claim.po_id || null, mode: claim.mode || 'PO',
        expected_receipt_id: claim.receipt_id, recovery: 'NO_RECEIPT',
        claim_id: claim.claim_id || null, claimed_at: claim.claimed_at || null,
        released_to: out.prior,
        detail: 'No goods receipt was ever created for this claim, so the bill was released for another attempt. No stock was posted or removed.'
      }, actor, bill.business_date, `inv_billrel_${bill.id}_${Date.now()}`);
    }
    return { settled: out.applied, outcome: out.applied ? 'RELEASED' : 'NO_CHANGE', status: out.prior };
  },

  /**
   * Settles every bill currently left in CONFIRMING. Intended for a startup or
   * maintenance sweep rather than the request path.
   *
   * Uses the automatic single-field index on `status`; no composite index and
   * no full-collection scan.
   */
  async settleAllStalled({ actor = null, limit = 50 } = {}) {
    const snap = await db.collection('inventory_bills')
      .where('status', '==', BILL_STATUS.CONFIRMING)
      .limit(limit)
      .get();
    const results = [];
    for (const d of snap.docs) {
      try {
        results.push({ bill_id: d.id, ...(await BillConfirmRecoveryService.settle(d.id, { actor })) });
      } catch (err) {
        results.push({ bill_id: d.id, settled: false, outcome: 'ERROR', error: err.message });
      }
    }
    return { checked: snap.size, results };
  }
};

export default BillConfirmRecoveryService;
