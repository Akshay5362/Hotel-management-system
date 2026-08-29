/**
 * src/utils/dateFormatter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Safe, timezone-agnostic date and datetime formatters for HPMS UI.
 *
 * Rules:
 *  1. Date-only fields (e.g. DOB, check-in date) are parsed by date components
 *     (never via timezone-shifted JS Date constructors).
 *  2. Expected checkout displays as "DD-Mon-YYYY 11:00 AM".
 *  3. Never outputs "NaN-NaN-NaN" or "Invalid Date".
 */

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Formats any date input into date-only "DD-Mon-YYYY" (e.g. "02-Nov-2003").
 * Guarantees zero timezone shifting.
 */
export function formatDateOnly(dateVal) {
  if (!dateVal) return '—';
  const str = String(dateVal).trim();
  if (str === '' || str.toLowerCase() === 'null' || str.toLowerCase() === 'undefined' || str.includes('NaN')) {
    return '—';
  }

  // Already DD-Mon-YYYY (e.g. "02-Nov-2003" or "2-Nov-2003")
  const ddMonMatch = str.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (ddMonMatch) {
    const d = ddMonMatch[1].padStart(2, '0');
    const mon = ddMonMatch[2].charAt(0).toUpperCase() + ddMonMatch[2].slice(1).toLowerCase();
    const y = ddMonMatch[3];
    return `${d}-${mon}-${y}`;
  }

  // ISO / YYYY-MM-DD (e.g. "2003-11-02", "2003-11-02T00:00:00.000Z", "2003-11-02 00:00:00")
  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const y = isoMatch[1];
    const m = parseInt(isoMatch[2], 10);
    const d = isoMatch[3].padStart(2, '0');
    const mon = MONTH_SHORT[m - 1] || 'Jan';
    return `${d}-${mon}-${y}`;
  }

  // DD-MM-YYYY (e.g. "02-11-2003")
  const dmyMatch = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (dmyMatch) {
    const d = dmyMatch[1].padStart(2, '0');
    const m = parseInt(dmyMatch[2], 10);
    const y = dmyMatch[3];
    const mon = MONTH_SHORT[m - 1] || 'Jan';
    return `${d}-${mon}-${y}`;
  }

  // Fallback: strip any timestamp and return clean string
  return str.split('T')[0];
}

/**
 * Formats expected checkout string into "DD-Mon-YYYY 11:00 AM" (e.g. "20-Aug-2026 11:00 AM").
 * Handles inputs like:
 *  - "2026-08-20 11:00"
 *  - "2026-08-20T11:00"
 *  - "2026-08-20"
 *  - "20-Aug-2026 11:00 AM"
 *  - "2026-08-20 15:30"
 */
export function formatExpectedCheckout(dateVal) {
  if (!dateVal) return 'N/A';
  const str = String(dateVal).trim();
  if (str === '' || str.toLowerCase() === 'null' || str.toLowerCase() === 'undefined' || str.includes('NaN')) {
    return 'N/A';
  }

  // Check if time is already formatted with AM/PM e.g. "20-Aug-2026 11:00 AM"
  if (/^\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{1,2}:\d{2}\s+(AM|PM)$/i.test(str)) {
    return str;
  }

  let datePart = '';
  let timePart = '11:00 AM';

  // Extract time if present
  let rawTime = null;
  if (str.includes('T')) {
    const parts = str.split('T');
    datePart = parts[0];
    rawTime = parts[1]?.substring(0, 5);
  } else if (str.includes(' ')) {
    const parts = str.split(/\s+/);
    datePart = parts[0];
    rawTime = parts[1]?.substring(0, 5);
  } else {
    datePart = str;
  }

  if (rawTime && /^\d{1,2}:\d{2}/.test(rawTime)) {
    const [hStr, mStr] = rawTime.split(':');
    let h = parseInt(hStr, 10);
    const m = mStr.padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    timePart = `${String(h).padStart(2, '0')}:${m} ${ampm}`;
  }

  const formattedDate = formatDateOnly(datePart);
  if (formattedDate === '—') return 'N/A';

  return `${formattedDate} ${timePart}`;
}

/**
 * Computes default expected checkout datetime string for datetime-local inputs:
 * Check-in date + 1 calendar day at 11:00 ("YYYY-MM-DDTHH:mm").
 */
export function getDefaultExpectedCheckoutInput(checkInDateStr) {
  if (!checkInDateStr) return '';
  const str = String(checkInDateStr).trim();
  let yyyy = null, mm = null, dd = null;

  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    const clean = str.split(' ')[0].split('T')[0];
    const [y, m, d] = clean.split('-').map(Number);
    yyyy = y; mm = m; dd = d;
  } else if (/^\d{1,2}-[A-Za-z]{3}-\d{4}/.test(str)) {
    const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
    const parts = str.split(' ')[0].split('T')[0].split('-');
    dd = parseInt(parts[0], 10);
    mm = MONTHS[parts[1].toLowerCase()] || 1;
    yyyy = parseInt(parts[2], 10);
  }

  if (yyyy && mm && dd && !isNaN(yyyy) && !isNaN(mm) && !isNaN(dd)) {
    const dt = new Date(Date.UTC(yyyy, mm - 1, dd + 1));
    const nextY = dt.getUTCFullYear();
    const nextM = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const nextD = String(dt.getUTCDate()).padStart(2, '0');
    return `${nextY}-${nextM}-${nextD}T11:00`;
  }

  return '';
}
