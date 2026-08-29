/**
 * src/utils/reportDateUtils.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Deterministic date formatting and preset range calculator for HPMS Reports & Analytics.
 *
 * Guarantees:
 * 1. Zero timezone/UTC offset distortion (never shifts dates backward across UTC midnight).
 * 2. Uses hotel Business Date as the single source of truth for preset date calculations.
 * 3. Never falls back silently to browser clock if Business Date is unavailable.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Format a Date object or date string into strict 'YYYY-MM-DD' without UTC conversion.
 * @param {Date|string} date
 * @returns {string} 'YYYY-MM-DD' or ''
 */
export function formatDateOnly(date) {
  if (!date) return '';
  if (typeof date === 'string') {
    const trimmed = date.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    if (trimmed.includes('T')) return trimmed.split('T')[0];
  }
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Parse a 'YYYY-MM-DD' string into a local Date object.
 * @param {string} dateStr
 * @returns {Date|null}
 */
export function parseDateString(dateStr) {
  if (!dateStr) return null;
  const str = String(dateStr).trim();
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const y = parseInt(match[1], 10);
    const m = parseInt(match[2], 10) - 1;
    const d = parseInt(match[3], 10);
    return new Date(y, m, d);
  }
  return new Date(str);
}

/**
 * Calculate preset start and end dates relative to the authoritative hotel Business Date.
 * @param {string} preset 'Today' | 'Yesterday' | 'This Week' | 'This Month' | 'This Year' | 'Custom Date Range'
 * @param {string} businessDateStr 'YYYY-MM-DD'
 * @param {string} [customStart] 'YYYY-MM-DD'
 * @param {string} [customEnd] 'YYYY-MM-DD'
 * @returns {{ startStr: string, endStr: string } | null}
 */
export function calculatePresetDateRange(preset, businessDateStr, customStart = '', customEnd = '') {
  if (preset === 'Custom Date Range') {
    return {
      startStr: customStart ? formatDateOnly(customStart) : '',
      endStr: customEnd ? formatDateOnly(customEnd) : ''
    };
  }

  if (!businessDateStr) {
    return null;
  }

  const baseDate = parseDateString(businessDateStr);
  if (!baseDate || isNaN(baseDate.getTime())) {
    return null;
  }

  let startStr = '';
  let endStr = formatDateOnly(baseDate);

  switch (preset) {
    case 'Today': {
      startStr = formatDateOnly(baseDate);
      endStr = formatDateOnly(baseDate);
      break;
    }
    case 'Yesterday': {
      const yDate = new Date(baseDate);
      yDate.setDate(yDate.getDate() - 1);
      startStr = formatDateOnly(yDate);
      endStr = formatDateOnly(yDate);
      break;
    }
    case 'This Week': {
      const day = baseDate.getDay();
      const diff = baseDate.getDate() - day + (day === 0 ? -6 : 1);
      const startWeek = new Date(baseDate);
      startWeek.setDate(diff);
      startStr = formatDateOnly(startWeek);
      endStr = formatDateOnly(baseDate);
      break;
    }
    case 'This Month': {
      const startMonth = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1);
      startStr = formatDateOnly(startMonth);
      endStr = formatDateOnly(baseDate);
      break;
    }
    case 'This Year': {
      const startYear = new Date(baseDate.getFullYear(), 0, 1);
      startStr = formatDateOnly(startYear);
      endStr = formatDateOnly(baseDate);
      break;
    }
    default: {
      startStr = formatDateOnly(baseDate);
      endStr = formatDateOnly(baseDate);
      break;
    }
  }

  return { startStr, endStr };
}
