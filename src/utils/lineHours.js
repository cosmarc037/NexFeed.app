/*
 * lineHours.js — single source of truth for per-line LOAD hours.
 *
 * The Plant Auto-Sequence "Per-Line Summary → Total Hrs" column and the Stage 5.5
 * AI rebalance load metric MUST agree with the per-order detail rows. The detail
 * rows recompute each order's production time live (effective batch-ceiling volume
 * ÷ the order's own run rate); they do NOT trust the stored production_hours, which
 * goes stale on combined orders (set from the pre-combine pieces / a generic line
 * rate, not the combined effVol ÷ the combined order's own — often slower — rate).
 *
 * So this module recomputes production hours the same way the detail rows do, and
 * is used by BOTH:
 *   - calculateLineHoursBreakdown (Dashboard.jsx → plantCombinePlace perLineSummary)
 *   - computeLineQueueHours (plantRebalanceAI.js, Stage 5.5)
 * Keeping them on one helper is what keeps the summary column == the visible rows,
 * and the AI load view byte-identical to the table (see
 * .agents/memory/production-time-display-parity.md and stage55-load-basis.md).
 */

// Effective (batch-ceiling) volume — mirrors getEffVolume in Dashboard.jsx exactly.
export function orderEffVolume(order) {
  if (!order) return 0;
  if (order.volume_override != null && order.volume_override !== "") {
    return parseFloat(order.volume_override);
  }
  const orig = parseFloat(order.total_volume_mt) || 0;
  const bs = parseFloat(order.batch_size) || 4;
  if (bs <= 0) return orig;
  return Math.ceil(orig / bs) * bs;
}

// Per-order production hours for LOAD totals. Mirrors the detail-row formula
// (calcOrderEnd in PlantAutoSequenceModal.jsx):
//   - manually-entered hours (production_hours_manual && > 0) → use stored value
//   - Mash (form 'M') → 0 (no line run rate; shown as "—" in the detail rows)
//   - otherwise → effVol ÷ own run rate (0 when there is no valid run rate)
export function orderProductionHours(order) {
  if (!order) return 0;
  if (order.production_hours_manual === true && parseFloat(order.production_hours) > 0) {
    return parseFloat(order.production_hours);
  }
  const form = String(order.form || "").trim().toUpperCase();
  if (form === "M") return 0;
  const rr = parseFloat(order.run_rate);
  const vol = orderEffVolume(order);
  if (!rr || rr <= 0 || !vol || vol <= 0) return 0;
  return parseFloat((vol / rr).toFixed(2));
}

// Sequence-aware changeover already attached to the order (set by
// applyPreviewChangeovers); never re-derived here.
export function orderChangeoverHours(order) {
  return parseFloat(order?._changeoverTotal ?? order?.changeover_time ?? 0) || 0;
}

// { productionHours, changeoverHours, totalHours } for a line's order list.
export function lineHoursBreakdown(orders) {
  const list = orders || [];
  const prod = Number(list.reduce((s, o) => s + orderProductionHours(o), 0).toFixed(2));
  const co = Number(list.reduce((s, o) => s + orderChangeoverHours(o), 0).toFixed(2));
  return { productionHours: prod, changeoverHours: co, totalHours: Number((prod + co).toFixed(2)) };
}

// Rebuild the post-placement ("after") fields of a perLineSummary against a NEW
// sequencedByLine. plantCombinePlace snapshots perLineSummary BEFORE Stage 5.5
// diverts orders across lines, so the summary's afterHours/afterMT/afterCount would
// otherwise lag the post-diversion per-order rows and the "Total Hrs" column would no
// longer equal the visible rows. Reuses lineHoursBreakdown so the recomputed column
// stays byte-identical to the detail rows. before* fields and the New/Left badges
// (combine + line-balance semantics) are preserved as-is; Stage 5.5 moves surface in
// the separate rebalance section. `effectiveLineTotalMT(orders)` is injected because
// the MT basis (getEffectiveDisplayVolumeMT) lives in the caller, not here.
export function rebuildSummaryAfterFields(perLineSummary, sequencedByLine, effectiveLineTotalMT) {
  return (perLineSummary || []).map((ls) => {
    const after = (sequencedByLine && sequencedByLine[ls.line]) || [];
    const afterHours = lineHoursBreakdown(after);
    const beforeTotal = ls.beforeHours?.totalHours || 0;
    return {
      ...ls,
      afterCount: after.length,
      afterMT: Number(effectiveLineTotalMT(after) || 0).toFixed(1),
      afterHours,
      hoursDiff: Number((afterHours.totalHours - beforeTotal).toFixed(2)),
    };
  });
}
