export const fmtVolume = (v) => Math.round(parseFloat(v) || 0);
export const fmtBatches = (n) => Math.round(parseFloat(n) || 0);
export const fmtBags = (n) => Math.round(parseFloat(n) || 0);
export const fmtBatchSize = (n) => Math.round(parseFloat(n) || 0);
export const fmtHours = (h) => h != null ? parseFloat(h).toFixed(2) : null;
export const fmtChangeover = (c) => parseFloat(c ?? 0.17).toFixed(2);
export const fmtRunRate = (r) => r != null ? parseFloat(r).toFixed(2) : null;

export function formatTime12(timeStr) {
  if (!timeStr) return '';
  const m = String(timeStr).match(/(\d+):(\d+)\s*(am|pm)?/i);
  if (!m) return timeStr;
  let h = parseInt(m[1]);
  const min = m[2];
  const ap = m[3] ? m[3].toUpperCase() : (h >= 12 ? 'PM' : 'AM');
  if (!m[3]) { if (h >= 12) { h = h === 12 ? 12 : h - 12; } else { h = h === 0 ? 12 : h; } }
  else if (m[3].toLowerCase() === 'pm' && h < 12) h += 12;
  else if (m[3].toLowerCase() === 'am' && h === 12) h = 0;
  const h12 = h % 12 || 12;
  return `${String(h12).padStart(2, '0')}:${min} ${ap}`;
}
