/**
 * Universal date parsing and formatting utilities.
 * Handles all month formats for all locales consistently.
 */

export const MONTH_MAP = {
  january: 0, february: 1, march: 2, april: 3,
  may: 4, june: 5, july: 6, august: 7,
  september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3,
  jun: 5, jul: 6, aug: 7,
  sep: 8, oct: 9, nov: 10, dec: 11,
};

const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const NON_DATE_STRINGS = new Set([
  'prio replenish','safety stocks','safety stock','safety_stock',
  'n/a','na','tbd','tba','none','null','undefined','-','—','',
  'stock_sufficient','auto_sequence',
]);

/**
 * Parse any date string into a JS Date.
 * Returns null for non-date strings (e.g. "prio replenish").
 */
export function parseDate(dateStr) {
  if (!dateStr) return null;
  if (dateStr instanceof Date) return isNaN(dateStr.getTime()) ? null : dateStr;

  const str = String(dateStr).trim();
  if (!str) return null;
  if (NON_DATE_STRINGS.has(str.toLowerCase())) return null;

  let d;

  // ISO: "2026-03-28" or "2026-04-15"
  d = _tryISO(str);          if (d) return d;

  // Month-name-first: "Mar 28", "April 15", "Apr 15, 2026", "March 28, 2026"
  d = _tryMonthFirst(str);   if (d) return d;

  // Day-month-name: "28-Mar-26", "15-Apr-2026", "28 Mar 2026", "15 April 26"
  d = _tryDayMonthName(str); if (d) return d;

  // Slash: "3/28/2026", "03/28/2026", "4/15/2026"
  d = _trySlash(str);        if (d) return d;

  // Dash numeric: "03-28-2026", "04-15-2026"
  d = _tryDashNumeric(str);  if (d) return d;

  // Native fallback (only sensible years)
  const native = new Date(str);
  if (!isNaN(native.getTime()) && native.getFullYear() >= 2020 && native.getFullYear() <= 2035) {
    return native;
  }

  return null;
}

function _tryISO(str) {
  const m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

function _tryMonthFirst(str) {
  // "Apr 15" / "April 15" / "Apr 15, 2026" / "April 15, 2026" / "Apr-15"
  const m = str.match(/^([A-Za-z]+)[\s\-]+(\d{1,2})(?:[\s,]+(\d{4}))?/);
  if (!m) return null;
  const mo = MONTH_MAP[m[1].toLowerCase()];
  if (mo === undefined) return null;
  const day = parseInt(m[2]);
  const year = m[3] ? parseInt(m[3]) : _inferYear(mo, day);
  const d = new Date(year, mo, day);
  return isNaN(d.getTime()) ? null : d;
}

function _tryDayMonthName(str) {
  // "28-Mar-26", "15-Apr-2026", "28 Mar 2026", "15 April 2026"
  const m = str.match(/^(\d{1,2})[\s\-\/]([A-Za-z]+)(?:[\s\-\/](\d{2,4}))?/);
  if (!m) return null;
  const day = parseInt(m[1]);
  const mo = MONTH_MAP[m[2].toLowerCase()];
  if (mo === undefined) return null;
  let year = m[3] ? parseInt(m[3]) : _inferYear(mo, day);
  if (year < 100) year += 2000;
  const d = new Date(year, mo, day);
  return isNaN(d.getTime()) ? null : d;
}

function _trySlash(str) {
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  let year = parseInt(m[3]);
  if (year < 100) year += 2000;
  const mo = parseInt(m[1]) - 1;
  const day = parseInt(m[2]);
  if (mo < 0 || mo > 11 || day < 1 || day > 31) return null;
  const d = new Date(year, mo, day);
  return isNaN(d.getTime()) ? null : d;
}

function _tryDashNumeric(str) {
  const m = str.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})/);
  if (!m) return null;
  let year = parseInt(m[3]);
  if (year < 100) year += 2000;
  const mo = parseInt(m[1]) - 1;
  const day = parseInt(m[2]);
  if (mo < 0 || mo > 11 || day < 1 || day > 31) return null;
  const d = new Date(year, mo, day);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Infer year for a month/day: use current year unless the date is in the past,
 * in which case roll forward to next year.
 */
function _inferYear(month, day) {
  const now = new Date();
  const thisYear = now.getFullYear();
  const candidate = new Date(thisYear, month, day);
  return candidate < now ? thisYear + 1 : thisYear;
}

/**
 * Convert a date string / Date to ISO "YYYY-MM-DD".
 * Returns null for non-dates.
 */
export function toISODate(dateStr) {
  const d = dateStr instanceof Date ? dateStr : parseDate(dateStr);
  if (!d) return null;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Format a Date object (or parseable string) for display: "Mar 28, 2026".
 * Returns "—" for invalid/null inputs.
 */
export function formatDate(date) {
  const d = date instanceof Date ? date : parseDate(date);
  if (!d || isNaN(d.getTime())) return '—';
  return `${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/**
 * Format a date string for compact display: "Mar 28".
 * Returns "—" for invalid/null inputs.
 */
export function formatShortDate(dateStr) {
  const d = parseDate(dateStr);
  if (!d || isNaN(d.getTime())) return '—';
  return `${SHORT_MONTHS[d.getMonth()]}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Returns true if the string is a valid ISO date (YYYY-MM-DD).
 * Used to distinguish "real" dates from strings like "prio replenish".
 */
export function isValidISODate(str) {
  return !!(str && !isNaN(Date.parse(str)) && /^\d{4}-\d{2}-\d{2}/.test(str));
}
