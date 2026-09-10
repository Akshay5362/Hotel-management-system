/**
 * billMatchingService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H3 — deterministic interpretation of the flat OCR text produced by H2.
 *
 * EVERY EXPORT HERE IS A PURE FUNCTION. No Firestore, no network, no file I/O,
 * no clock. That is deliberate: parsing and matching are the parts most likely
 * to be wrong, so they must be testable offline against a fixture corpus.
 *
 * WHAT THIS IS NOT
 *   Tesseract returns a flat stream of words with no table structure — column
 *   relationships are destroyed before this code ever runs. Line parsing is
 *   therefore a HEURISTIC that produces SUGGESTIONS, never confirmed values.
 *   Nothing here decides anything; it proposes, and a human disposes in H4.
 *
 * HARD RULES
 *   • Only HIGH confidence may be pre-selected by the UI.
 *   • Quantities are never treated as human-confirmed, at any confidence.
 *   • No unit is ever converted. BOX is not PCS. A mismatch is an exception.
 *   • Nothing creates a product or a supplier.
 */

import { MATCH_CONFIDENCE } from '../utils/inventoryConstants.js';

// ── Text normalisation ───────────────────────────────────────────────────────

/** Upper-case, strip punctuation, collapse whitespace. The comparison basis. */
export function normalizeText(value) {
  return String(value == null ? '' : value)
    .toUpperCase()
    .replace(/[^A-Z0-9\s.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokens of 2+ characters, used for overlap scoring. */
export function tokenize(value) {
  return normalizeText(value).split(' ').filter(t => t.length >= 2);
}

/**
 * All non-alphanumerics removed. SKUs are written inconsistently on bills —
 * VEG-001, VEG 001, VEG001 — so they are compared in this compacted form.
 */
export function compact(value) {
  return String(value == null ? '' : value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Levenshtein distance, iterative and allocation-light. */
export function editDistance(a, b) {
  const s = String(a), t = String(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[t.length];
}

/**
 * Two tokens count as the same word if they are equal, or within a small edit
 * distance. OCR routinely drops or doubles a character — TOMATOE for TOMATOES —
 * and an exact-only comparison would score that pair at zero.
 */
function tokensMatch(a, b) {
  if (a === b) return true;
  const longer = Math.max(a.length, b.length);
  if (longer < 4) return false;                 // too short to fuzz safely
  const budget = longer >= 8 ? 2 : 1;
  return editDistance(a, b) <= budget;
}

/**
 * Similarity in [0,1] combining fuzzy token overlap with normalised edit
 * distance. Token overlap carries most of the weight because supplier wording
 * reorders and pads words far more often than it misspells them.
 *
 * Overlap blends containment with Jaccard. Containment matters because a bill
 * line is usually the product name PLUS extra descriptors ("Sunflower Oil
 * Refined"), and a pure Jaccard score punishes that padding unfairly.
 */
export function similarity(a, b) {
  const na = normalizeText(a), nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ta = tokenize(na), tb = tokenize(nb);
  let shared = 0;
  const used = new Set();
  for (const x of ta) {
    for (let i = 0; i < tb.length; i++) {
      if (used.has(i)) continue;
      if (tokensMatch(x, tb[i])) { shared++; used.add(i); break; }
    }
  }
  const minSize = Math.min(ta.length, tb.length);
  const maxSize = Math.max(ta.length, tb.length);
  const containment = minSize ? shared / minSize : 0;
  const jaccard = maxSize ? shared / maxSize : 0;
  const overlap = containment * 0.6 + jaccard * 0.4;

  const dist = editDistance(na, nb);
  const edit = 1 - dist / Math.max(na.length, nb.length);

  return Math.max(0, Math.min(1, overlap * 0.65 + edit * 0.35));
}

// ── Units ────────────────────────────────────────────────────────────────────

/**
 * Normalises a unit token to compare against inventory_units codes, which the
 * masters repository already stores upper-cased.
 *
 * This ONLY strips a trailing plural "S" and surrounding punctuation — KGS and
 * KG are the same token typed differently. It performs NO conversion of any
 * kind: BOX stays BOX, DOZEN stays DOZEN. There is no conversion table in the
 * schema, so inventing one here would silently corrupt stock.
 */
export function normalizeUnitToken(value) {
  const raw = String(value == null ? '' : value).trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (!raw) return null;
  if (raw.length > 2 && raw.endsWith('S')) {
    const singular = raw.slice(0, -1);
    if (singular.length >= 2) return singular;
  }
  return raw;
}

/** Unit tokens a bill line might carry. Recognition only — never conversion. */
export const RECOGNISED_UNIT_TOKENS = Object.freeze([
  'KG', 'GRAM', 'GM', 'G', 'LTR', 'L', 'ML', 'PC', 'PCS', 'PIECE', 'NOS', 'NO',
  'BOX', 'PKT', 'PACKET', 'BTL', 'BOTTLE', 'DOZEN', 'DOZ', 'REAM', 'BAG', 'TIN', 'CAN'
]);

/**
 * Decides whether a bill's unit agrees with the matched product's unit.
 * Returns { agrees, exception, reason }. Anything other than an exact match
 * after normalisation is an EXCEPTION for a human to resolve.
 */
export function compareUnits(billUnit, productUnit) {
  const b = normalizeUnitToken(billUnit);
  const p = normalizeUnitToken(productUnit);
  if (!p) return { agrees: false, exception: true, reason: 'The product has no unit of measure.' };
  if (!b) return { agrees: false, exception: true, reason: 'No unit could be read from the bill line.' };
  if (b === p) return { agrees: true, exception: false, reason: null };
  return {
    agrees: false,
    exception: true,
    reason: `Bill says '${billUnit}' but the product is held in '${productUnit}'. No conversion exists; resolve manually.`
  };
}

// ── Quantities ───────────────────────────────────────────────────────────────

/**
 * Parses a quantity token. Decimals must survive: 0.25, 1.3 and 2.5 are all
 * legitimate. Returns null rather than guessing when the token is not a clean
 * number, because a wrong quantity becomes wrong stock.
 */
export function parseQuantity(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Money token → number, or null. Accepts thousands separators. */
export function parseMoney(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().replace(/[^0-9.]/g, '');
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ── Header field extraction ──────────────────────────────────────────────────

/** Invoice number, or null. Never invented. */
export function extractInvoiceNumber(text) {
  const t = String(text || '');
  const patterns = [
    /(?:invoice|bill|inv)\s*(?:no|number|#)\s*[:.\-]?\s*([A-Z0-9][A-Z0-9\/\-]{2,24})/i,
    /(?:invoice|bill)\s*[:.\-]\s*([A-Z0-9][A-Z0-9\/\-]{2,24})/i
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m && m[1]) {
      const v = m[1].trim().replace(/[.\-]+$/, '');
      if (v && !/^(NO|NUMBER|DATE)$/i.test(v)) return v.toUpperCase();
    }
  }
  return null;
}

/**
 * Invoice date. Returns { date, ambiguous }.
 *
 * `date` is ISO or null. `ambiguous` is true when a numeric day/month pair
 * could legitimately be read either way (both parts ≤ 12), because guessing
 * between 08/09 and 09/08 is exactly the kind of silent error this phase must
 * not make. The value is still offered, flagged, for a human to confirm.
 */
export function extractInvoiceDate(text) {
  const t = String(text || '');
  const iso = t.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const [, y, m, d] = iso;
    const r = buildDate(y, m, d);
    if (r) return { date: r, ambiguous: false };
  }
  const numeric = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2}|\d{2})\b/);
  if (numeric) {
    let [, a, b, y] = numeric;
    if (y.length === 2) y = `20${y}`;
    const A = Number(a), B = Number(b);
    // Day-first is the Indian convention and the hotel's locale.
    const r = buildDate(y, B, A) || buildDate(y, A, B);
    if (r) return { date: r, ambiguous: A <= 12 && B <= 12 && A !== B };
  }
  return { date: null, ambiguous: false };
}

function buildDate(y, m, d) {
  const Y = Number(y), M = Number(m), D = Number(d);
  if (!Y || M < 1 || M > 12 || D < 1 || D > 31) return null;
  const iso = `${Y}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getUTCMonth() + 1 !== M || parsed.getUTCDate() !== D) return null;
  return iso;
}

/** GSTIN, the single strongest supplier signal on an Indian tax invoice. */
export function extractGstin(text) {
  const m = String(text || '').toUpperCase().match(/\b(\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z]\d)\b/);
  return m ? m[1] : null;
}

/**
 * Supplier name guess: the first substantial line before any labelled field.
 * A guess only — matching decides whether it is usable.
 */
export function extractSupplierName(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 6)) {
    if (/invoice|bill|date|gstin|tax|no[:.]/i.test(line)) continue;
    const letters = line.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 4) return line.slice(0, 120);
  }
  return null;
}

// ── Line extraction ──────────────────────────────────────────────────────────

const UNIT_ALTERNATION = RECOGNISED_UNIT_TOKENS.slice().sort((a, b) => b.length - a.length).join('|');

/**
 * Heuristic line extraction from flat text.
 *
 * A candidate line is one containing a number followed by a recognised unit
 * token. The text before that pair is the description; trailing numbers are
 * offered as rate and amount. Lines that do not fit are simply not returned —
 * the operator adds them by hand in H4, which is the honest outcome given that
 * Tesseract destroyed the column structure.
 */
export function extractLines(text) {
  const out = [];
  const rows = String(text || '').split(/\r?\n/);
  const re = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_ALTERNATION})\\b`, 'i');

  for (const row of rows) {
    const line = row.trim();
    if (!line || line.length < 3) continue;
    if (/^(total|subtotal|grand total|gstin|invoice|date|tax)\b/i.test(line)) continue;

    const m = line.match(re);
    if (!m) continue;

    const qty = parseQuantity(m[1]);
    if (qty === null) continue;

    const description = line.slice(0, m.index).trim().replace(/[.\-–|:]+$/, '').trim();
    if (!description || description.replace(/[^A-Za-z]/g, '').length < 2) continue;

    // Numbers appearing AFTER the quantity/unit pair are candidate rate/amount.
    const tail = line.slice(m.index + m[0].length);
    const nums = (tail.match(/\d+(?:\.\d+)?/g) || []).map(parseMoney).filter(n => n !== null);

    out.push({
      raw_text: line.slice(0, 500),
      // The description alone, with the quantity, unit, rate and amount
      // stripped off. Matching MUST use this rather than raw_text: leaving the
      // numbers in prevents an exact product-name match from ever scoring HIGH.
      description: description.slice(0, 300),
      raw_quantity: qty,
      raw_unit: normalizeUnitToken(m[2]),
      raw_rate: nums.length >= 1 ? nums[0] : null,
      raw_amount: nums.length >= 2 ? nums[1] : null
    });
  }
  return out;
}

// ── Matching ─────────────────────────────────────────────────────────────────

export const SIMILARITY_THRESHOLDS = Object.freeze({
  STRONG: 0.75,   // MEDIUM floor
  WEAK: 0.12      // LOW floor; below this is UNMATCHED
});

/**
 * Matches one bill description against the product master.
 *
 * @param {string} description   text read from the bill
 * @param {string|null} billUnit unit read from the bill
 * @param {Array} products       [{ id, name, sku, unit_of_measure, is_active }]
 * @returns {{ product_id, confidence, score, candidates, unit_exception, unit_reason }}
 *
 * HIGH requires either an exact SKU, or an exact normalised name whose unit
 * also agrees. A unit disagreement can never produce HIGH, because HIGH is the
 * only band the UI may pre-select and a wrong unit is a wrong stock posting.
 */
export function matchProduct(description, billUnit, products = []) {
  const none = {
    product_id: null, confidence: MATCH_CONFIDENCE.UNMATCHED, score: 0,
    candidates: [], unit_exception: false, unit_reason: null
  };
  const desc = normalizeText(description);
  if (!desc) return none;

  const active = (products || []).filter(p => p && p.is_active !== false);
  if (!active.length) return none;

  // 1. Exact SKU appearing anywhere in the description → HIGH.
  //    Compared in compacted form so VEG-001, VEG 001 and VEG001 all match, with
  //    a boundary check so a short SKU cannot match inside a longer code.
  const descCompact = compact(description);
  for (const p of active) {
    const sku = compact(p.sku);
    const skuHit = sku.length >= 3 && (
      descCompact === sku ||
      new RegExp(`(^|[^A-Z0-9])${sku}([^A-Z0-9]|$)`).test(normalizeText(description).replace(/\s/g, ' ')) ||
      tokenize(description).some(t => compact(t) === sku) ||
      // VEG-001 tokenises to VEG + 001; rejoin adjacent tokens before comparing.
      tokenize(description).some((t, i, arr) => i + 1 < arr.length && compact(t + arr[i + 1]) === sku)
    );
    if (skuHit) {
      const u = compareUnits(billUnit, p.unit_of_measure);
      return {
        product_id: p.id, confidence: MATCH_CONFIDENCE.HIGH, score: 1,
        candidates: [{ product_id: p.id, score: 1 }],
        unit_exception: u.exception, unit_reason: u.reason
      };
    }
  }

  // 2. Score every product by name similarity.
  const scored = active
    .map(p => ({ product_id: p.id, product: p, score: similarity(desc, p.name) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return none;

  const best = scored[0];
  const runnerUp = scored[1] || null;
  const u = compareUnits(billUnit, best.product.unit_of_measure);
  const candidates = scored.slice(0, 5).map(s => ({ product_id: s.product_id, score: Number(s.score.toFixed(4)) }));

  // Several candidates scoring within 5% of each other is genuine ambiguity,
  // so it is capped at LOW no matter how high the top score is.
  const ambiguous = !!runnerUp && (best.score - runnerUp.score) < 0.05;

  let confidence;
  if (normalizeText(best.product.name) === desc && u.agrees && !ambiguous) {
    confidence = MATCH_CONFIDENCE.HIGH;
  } else if (ambiguous) {
    confidence = best.score >= SIMILARITY_THRESHOLDS.WEAK ? MATCH_CONFIDENCE.LOW : MATCH_CONFIDENCE.UNMATCHED;
  } else if (best.score >= SIMILARITY_THRESHOLDS.STRONG && u.agrees) {
    confidence = MATCH_CONFIDENCE.MEDIUM;
  } else if (best.score >= SIMILARITY_THRESHOLDS.WEAK) {
    confidence = MATCH_CONFIDENCE.LOW;
  } else {
    return { ...none, candidates };
  }

  // UNMATCHED must never carry a product id. The ambiguous branch above can
  // reach UNMATCHED with a `best` in hand, and returning it would let the UI
  // present a proposal the matcher explicitly rejected.
  if (confidence === MATCH_CONFIDENCE.UNMATCHED) return { ...none, candidates };

  return {
    product_id: best.product_id,
    confidence,
    score: Number(best.score.toFixed(4)),
    candidates,
    unit_exception: u.exception,
    unit_reason: u.reason
  };
}

/**
 * Matches the supplier. GSTIN is decisive; otherwise the already-normalised
 * `search_name` field is compared. Never creates a supplier.
 */
export function matchSupplier(rawName, gstin, suppliers = []) {
  const none = { supplier_id: null, confidence: MATCH_CONFIDENCE.UNMATCHED, score: 0, candidates: [] };
  const active = (suppliers || []).filter(s => s && s.is_active !== false);
  if (!active.length) return none;

  if (gstin) {
    const hit = active.find(s => String(s.gstin || '').toUpperCase() === String(gstin).toUpperCase());
    if (hit) {
      return { supplier_id: hit.id, confidence: MATCH_CONFIDENCE.HIGH, score: 1, candidates: [{ supplier_id: hit.id, score: 1 }] };
    }
  }

  const name = normalizeText(rawName);
  if (!name) return none;

  const exact = active.find(s => normalizeText(s.search_name || s.name) === name);
  if (exact) {
    return { supplier_id: exact.id, confidence: MATCH_CONFIDENCE.HIGH, score: 1, candidates: [{ supplier_id: exact.id, score: 1 }] };
  }

  const scored = active
    .map(s => ({ supplier_id: s.id, score: similarity(name, s.search_name || s.name) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return none;

  const best = scored[0];
  const runnerUp = scored[1] || null;
  const ambiguous = !!runnerUp && (best.score - runnerUp.score) < 0.05;
  const candidates = scored.slice(0, 5).map(s => ({ supplier_id: s.supplier_id, score: Number(s.score.toFixed(4)) }));

  let confidence;
  if (ambiguous) confidence = best.score >= SIMILARITY_THRESHOLDS.WEAK ? MATCH_CONFIDENCE.LOW : MATCH_CONFIDENCE.UNMATCHED;
  else if (best.score >= SIMILARITY_THRESHOLDS.STRONG) confidence = MATCH_CONFIDENCE.MEDIUM;
  else if (best.score >= SIMILARITY_THRESHOLDS.WEAK) confidence = MATCH_CONFIDENCE.LOW;
  else return { ...none, candidates };

  // Same rule as products: UNMATCHED never carries an id.
  if (confidence === MATCH_CONFIDENCE.UNMATCHED) return { ...none, candidates };

  return { supplier_id: best.supplier_id, confidence, score: Number(best.score.toFixed(4)), candidates };
}

/** Only HIGH may be pre-selected. The single place this policy is expressed. */
export function mayAutoSelect(confidence) {
  return confidence === MATCH_CONFIDENCE.HIGH;
}

/**
 * Full interpretation of one bill's OCR text. Pure: masters are passed in.
 * Produces a proposal only — `resolved_quantity` and `resolved_unit` are
 * deliberately left null, because nothing here is human-confirmed.
 */
export function interpretBill(ocrText, { products = [], suppliers = [] } = {}) {
  const gstin = extractGstin(ocrText);
  const supplierNameRaw = extractSupplierName(ocrText);
  const supplier = matchSupplier(supplierNameRaw, gstin, suppliers);
  const { date, ambiguous } = extractInvoiceDate(ocrText);

  const lines = extractLines(ocrText).map((l, i) => {
    // Match on the description, never the whole raw line.
    const m = matchProduct(l.description || l.raw_text, l.raw_unit, products);
    return {
      line_no: i + 1,
      ...l,
      matched_product_id: mayAutoSelect(m.confidence) ? m.product_id : null,
      suggested_product_id: m.product_id,
      match_confidence: m.confidence,
      match_score: m.score,
      candidates: m.candidates,
      unit_exception: m.unit_exception,
      unit_reason: m.unit_reason,
      // Never pre-confirmed. H4 fills these in from operator input.
      resolved_quantity: null,
      resolved_unit: null,
      po_item_id: null,
      ordered_quantity: null,
      excluded: false
    };
  });

  return {
    supplier_name_raw: supplierNameRaw,
    supplier_id: mayAutoSelect(supplier.confidence) ? supplier.supplier_id : null,
    suggested_supplier_id: supplier.supplier_id,
    supplier_confidence: supplier.confidence,
    supplier_candidates: supplier.candidates,
    gstin,
    invoice_number: extractInvoiceNumber(ocrText),
    invoice_date: date,
    invoice_date_ambiguous: ambiguous,
    lines
  };
}
