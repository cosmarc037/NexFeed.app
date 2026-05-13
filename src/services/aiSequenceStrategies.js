// AI Sequencing Strategies — generates 3 sequencing options PER PRODUCTION LINE
// for the plant-level auto-sequence preview. Operates on the OUTPUT of the
// local combine/line-balance algorithm (sequencedResults), only re-ordering
// orders within each line and optionally suggesting MTS date adjustments
// within each order's safe window.
//
//   For EACH active line independently:
//     1. rule_based    — current local algorithm output, no AI; never recommended
//     2. ai_option_1   — first line-specific AI-generated strategy (name/theme/
//                        reasoning + ordering all from one AI call scoped to
//                        that line's lineup)
//     3. ai_option_2   — second line-specific AI-generated strategy (must be
//                        meaningfully distinct from ai_option_1)
//
// Recommendation badge applies per-line and only among the two AI strategies on
// that line, via determineLineRecommendation (slack/risk/optimisation/
// profitability weighted score). Standard Sequence is never marked recommended.
// Different lines may end up with different AI-generated strategy names.
//
// The exported orchestrator generateSequenceStrategies returns a map of
// `{ byLine: { [lineKey]: { rule_based, ai_option_1, ai_option_2, recommended } } }`.
// Plant-wide variants of the prompt/parser/applier remain in the file below as
// legacy helpers but are no longer called from the orchestrator.

import { callSequenceStrategyAI } from "./azureAI";
import {
  calculateChangeoverBetween,
  calculateAdditionalChangeover,
  buildDynamicChangeoverPromptSection,
  getFallbackChangeoverRules,
} from "@/utils/changeoverCalc";

// Return the LOCAL calendar date as an ISO string (YYYY-MM-DD).
// IMPORTANT: never use new Date().toISOString() for "today" because
// .toISOString() converts to UTC — a user in UTC+8 at 5 AM on May 13
// would get "2026-05-12" instead of "2026-05-13". All scheduling rules
// ("Critical → today", "earliest = today+2", etc.) must use local date.
// PHT = UTC+8. Adding 8 h to UTC then reading as UTC date gives the PHT date.
const _PHT_MS = 8 * 3600_000;
function _toLocalISO(d) {
  return new Date(d.getTime() + _PHT_MS).toISOString().substring(0, 10);
}

const LINE_RUN_RATES = {
  "Line 1": 20, "Line 2": 20,
  "Line 3": 10, "Line 4": 10,
  "Line 5": 10, "Line 6": 10, "Line 7": 10,
};

const MTO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

// True MTO orders carry a contractual avail_date that the AI must NOT change.
// N10D-enriched MTS orders ALSO have an ISO target_avail_date written into them by the
// dashboard pipeline, but those came from N10D inference (date_source === 'n10d' or
// avail_date_source === 'auto_sequence') — not a customer contract — so the AI is
// allowed to suggest a different production date for them within the safe window.
function isMTO(o) {
  if (!o.target_avail_date || !MTO_DATE_RE.test(String(o.target_avail_date))) return false;
  const isN10DSourced = o.avail_date_source === 'auto_sequence' || o.date_source === 'n10d';
  return !isN10DSourced;
}

function isCritical(o) {
  return o._n10dStatus === "Critical" || o._dateCategory === "critical";
}

function getLineRunRate(line) {
  return LINE_RUN_RATES[line] || 10;
}

// ─── Changeover time helpers ───────────────────────────────────────────────
// Sum the per-order outgoing changeover hours for a flat array of orders by
// REPLICATING applyPreviewChangeovers (in PlantAutoSequenceModal.jsx) exactly.
//
// Why we don't trust stored fields here:
//   The order objects often carry a stale `_changeoverTotal` /
//   `_effectiveChangeover` / `changeover` / `_changeoverHrs` from the prior
//   render of the BEFORE table. After the AI strategy reorders them, those
//   stored values still reflect the OLD neighbor — so summing them gives the
//   same number for every strategy. The only way to match what the After
//   table will actually display for THIS strategy is to recompute from
//   scratch using each order's true next-order in the strategy's final
//   sequence, plus the live changeoverRules.
function calculateTotalChangeoverTime(orders, changeoverRules) {
  if (!orders || !orders.length) return 0;
  const isDone = (o) => {
    const s = (o?.status || '').toLowerCase();
    return s === 'done' || s === 'completed' || s === 'cancel_po';
  };
  let sum = 0;
  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    if (isDone(order)) {
      // Done/Cancel: use frozen_changeover if saved, else changeover_time
      // (matches applyPreviewChangeovers branches 360-369).
      const isFrozen = order.frozen_changeover != null;
      const retained = isFrozen
        ? (parseFloat(order.frozen_changeover) || 0)
        : (parseFloat(order.changeover_time ?? 0) || 0);
      sum += retained;
      continue;
    }
    // Find the next NON-done order (matches the j-loop at line 372-376).
    let following = null;
    for (let j = i + 1; j < orders.length; j++) {
      if (!isDone(orders[j])) { following = orders[j]; break; }
    }
    if (!following) continue; // Last active order: no outgoing changeover.
    // base = changeover_time, with the same form-based fallback as
    // previewGetBaseChangeover (C → 0.33, else 0.17).
    const baseRaw = parseFloat(order.changeover_time);
    const base = Number.isFinite(baseRaw)
      ? baseRaw
      : (((order.form || '').trim().toUpperCase() === 'C') ? 0.33 : 0.17);
    const { total: additional } = calculateAdditionalChangeover(
      order, following, changeoverRules || []
    );
    sum += parseFloat((base + additional).toFixed(3));
  }
  return Number(sum.toFixed(2));
}

// Returns standardCO, strategyCO, and the signed deltaHours
// (strategyCO − standardCO). Negative = strategy saved time; positive = worse.
function calculateTimeSavedVsStandard(standardOrders, strategyOrders, changeoverRules) {
  const standardCO = calculateTotalChangeoverTime(standardOrders, changeoverRules);
  const strategyCO = calculateTotalChangeoverTime(strategyOrders, changeoverRules);
  const deltaHours = Number((strategyCO - standardCO).toFixed(2));
  return {
    standardCO:  Number(standardCO.toFixed(2)),
    strategyCO:  Number(strategyCO.toFixed(2)),
    deltaHours,
  };
}

// ─── Metrics calculation ───────────────────────────────────────────────────
export function calculateStrategyMetrics(ordersByLine) {
  const allOrders = Object.values(ordersByLine).flat();
  const totalOrders = allOrders.length;

  const mtoOrders = allOrders.filter(isMTO);
  const mtsCount = totalOrders - mtoOrders.length;

  // Simulate completion times for slack/violation detection
  let minSlack = Infinity;
  let minSlackOrder = null;
  let violations = 0;

  for (const [line, orders] of Object.entries(ordersByLine)) {
    const runRate = getLineRunRate(line);
    let cursor = new Date();
    cursor.setHours(8, 0, 0, 0);

    for (const o of orders) {
      const volume = parseFloat(o.volume || o.total_volume_mt || 0) || 0;
      const prodHours = parseFloat(o.production_hours) || (runRate > 0 ? volume / runRate : 0);
      // _changeoverTotal is populated by applyChangeoverEnrichment using LIVE rules.
      // No hardcoded fallback — if enrichment didn't run, treat as 0 (honest signal).
      const changeover = parseFloat(o._changeoverTotal ?? o.changeover_time ?? 0) || 0;
      const totalHours = prodHours + changeover;
      const orderEnd = new Date(cursor.getTime() + totalHours * 60 * 60 * 1000);

      o._strategyEstimatedCompletion = orderEnd.toISOString();

      if (o.target_avail_date && MTO_DATE_RE.test(String(o.target_avail_date))) {
        const availDate = new Date(o.target_avail_date);
        availDate.setHours(23, 59, 59, 999);
        const slackHours = (availDate.getTime() - orderEnd.getTime()) / (1000 * 60 * 60);
        if (slackHours < minSlack) {
          minSlack = slackHours;
          minSlackOrder = o;
        }
        if (orderEnd > availDate) violations += 1;
      }

      cursor = orderEnd;
    }
  }

  let riskLevel = "Low";
  if (violations > 0 || (minSlack !== Infinity && minSlack < 0)) riskLevel = "Violated";
  else if (minSlack !== Infinity && minSlack < 12) riskLevel = "High";
  else if (minSlack !== Infinity && minSlack < 48) riskLevel = "Medium";

  // Only count Flexible-MTS date adjustments here so the "MTS adjusted" KPI keeps
  // its original meaning. MTO/Critical/Urgent/Monitor orders may also carry an
  // _aiSuggestedDate (informational), but they are not "flexibility moves".
  const mtsAdjusted = allOrders.filter(o => o._aiSuggestedDate && o._aiSuggestedDateIsFlexible).length;
  const totalMargin = allOrders.reduce(
    (sum, o) => sum + (parseFloat(o._margin) || 0) * (parseFloat(o.volume || o.total_volume_mt) || 0),
    0
  );

  // N10D baseline risk counts — only Critical (overdue) and Urgent (delayed) drive
  // the visible Orders at risk count. Monitor orders are tracked internally but do
  // not appear in the risk count (they are not actually late yet).
  const _overdueN10d     = allOrders.filter(o => o._n10dStatus === 'Critical').length;
  const _delayedN10d     = allOrders.filter(o => o._n10dStatus === 'Urgent').length;
  const _compromisedN10d = allOrders.filter(o => o._n10dStatus === 'Monitor').length;
  const _ordersAtRiskBaseline = _overdueN10d + _delayedN10d; // Monitor excluded

  return {
    totalOrders,
    mtoCount: mtoOrders.length,
    mtsCount,
    mtsAdjusted,
    minSlackHours: minSlack === Infinity ? null : minSlack.toFixed(1),
    minSlackOrder: minSlackOrder?.item_description || null,
    riskLevel,
    totalMargin: totalMargin.toFixed(0),
    violations,
    totalChangeoverHours: calculateTotalChangeoverTime(allOrders),
    // timeSavedHours / rawTimeSavedHours are stamped later by
    // generateLineStrategies once Standard is available as a baseline.
    // ordersAtRisk / overdueCount / delayedCount / compromisedCount are
    // refined by _stampRisk in generateLineStrategies once changeovers are stamped.
    ordersAtRisk: _ordersAtRiskBaseline,
    overdueCount: _overdueN10d,
    delayedCount: _delayedN10d,
    compromisedCount: _compromisedN10d, // tracked internally, not in visible count
  };
}

// ─── Accurate at-risk order count (post-changeover-stamp) ─────────────────
// Runs a fresh timing simulation using correctly-computed changeovers to
// identify which orders in a proposed sequence will miss their deadline
// (completion > target_avail_date). Combines these violations with the N10D
// status-based risk categories (Critical/Urgent/Monitor) that match the
// preview table's row highlight colours.
//
// Called by _stampRisk in generateLineStrategies AFTER _stampChangeover so
// the changeover values reflect the strategy's actual sequence.
function computeAtRiskOrders(orders, line, inferredTargetMap, changeoverRules) {
  const isDone = (o) => {
    const s = (o?.status || '').toLowerCase();
    return s === 'done' || s === 'completed' || s === 'cancel_po';
  };

  const runRate = getLineRunRate(line);
  let cursor = new Date();
  cursor.setHours(8, 0, 0, 0);
  const violationIds = new Set();

  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    const volume = parseFloat(o.volume || o.total_volume_mt || 0) || 0;
    const prodHours = parseFloat(o.production_hours) || (runRate > 0 ? volume / runRate : 0);

    // Replicate calculateTotalChangeoverTime's per-order logic exactly
    let changeover = 0;
    if (isDone(o)) {
      const isFrozen = o.frozen_changeover != null;
      changeover = isFrozen
        ? (parseFloat(o.frozen_changeover) || 0)
        : (parseFloat(o.changeover_time ?? 0) || 0);
    } else {
      let following = null;
      for (let j = i + 1; j < orders.length; j++) {
        if (!isDone(orders[j])) { following = orders[j]; break; }
      }
      if (following) {
        const baseRaw = parseFloat(o.changeover_time);
        const base = Number.isFinite(baseRaw)
          ? baseRaw
          : (((o.form || '').trim().toUpperCase() === 'C') ? 0.33 : 0.17);
        const { total: additional } = calculateAdditionalChangeover(o, following, changeoverRules || []);
        changeover = parseFloat((base + additional).toFixed(3));
      }
    }

    const totalHours = prodHours + changeover;
    const orderEnd = new Date(cursor.getTime() + totalHours * 60 * 60 * 1000);
    cursor = orderEnd;

    // Deadline check: effective avail date (ISO target or N10D inferred)
    const effectiveAvail = getEffectiveAvailISO(o, inferredTargetMap);
    if (effectiveAvail) {
      const deadline = new Date(effectiveAvail);
      deadline.setHours(23, 59, 59, 999);
      if (orderEnd > deadline) violationIds.add(o.id);
    }
  }

  // N10D status categories — only overdue (Critical) and delayed (Urgent) orders
  // count toward the visible risk figure. Monitor orders are tracked for the debug
  // log but are NOT added to atRiskIds because they have not actually missed their
  // deadline yet.
  const atRiskIds = new Set(violationIds);
  let overdueCount = violationIds.size; // deadline violations = overdue
  let delayedCount = 0;
  let compromisedCount = 0; // internal / debug only — not shown in card count

  for (const o of orders) {
    const n10d = o._n10dStatus || '';
    if (n10d === 'Critical') {
      // Critical = stock already exhausted by DFL — overdue by definition
      if (!violationIds.has(o.id)) {
        atRiskIds.add(o.id);
        overdueCount++;
      }
    } else if (n10d === 'Urgent') {
      // Urgent = dispatch due soon. Only flag as delayed when the sequential
      // timeline simulation confirms the order will ACTUALLY miss its deadline.
      // An Urgent order whose production completes before its avail date is NOT
      // at risk — counting it would inflate the metric and mislead the user.
      if (violationIds.has(o.id)) {
        delayedCount++;
        // atRiskIds already seeded from violationIds; no additional add needed.
      }
    } else if (n10d === 'Monitor') {
      // Monitor = approaching threshold but not yet late — excluded from risk count
      compromisedCount++;
    }
  }

  // Two-tier severity: High = any truly overdue/delayed order, Low = none.
  // "Moderate" has been removed — same-day / near-threshold orders that have
  // not yet missed their deadline should not inflate the risk count.
  const resolvedSeverity = atRiskIds.size > 0 ? 'High' : 'Low';

  // ── Spec §9 debug log ─────────────────────────────────────────────────────
  const _overdueOrders    = orders.filter(o => o._n10dStatus === 'Critical' || violationIds.has(o.id));
  // Delayed = Urgent orders that the simulation confirms will miss their deadline.
  // Urgent orders that complete before their avail date are NOT delayed.
  const _delayedOrders    = orders.filter(o => o._n10dStatus === 'Urgent' && violationIds.has(o.id));
  const _urgentSafe       = orders.filter(o => o._n10dStatus === 'Urgent' && !violationIds.has(o.id));
  const _nonLateCompromised = orders.filter(o => o._n10dStatus === 'Monitor');
  console.debug('[Orders At Risk Logic]', {
    line,
    overdueOrders: _overdueOrders.map(o => ({
      orderId: o.id,
      availDate: getEffectiveAvailISO(o, inferredTargetMap),
      status: o._n10dStatus,
    })),
    delayedOrders: _delayedOrders.map(o => ({
      orderId: o.id,
      availDate: getEffectiveAvailISO(o, inferredTargetMap),
      status: o._n10dStatus,
    })),
    urgentSafeOrders: _urgentSafe.map(o => ({
      orderId: o.id,
      availDate: getEffectiveAvailISO(o, inferredTargetMap),
      status: o._n10dStatus,
      note: 'Urgent but completes before deadline — not counted as at risk',
    })),
    nonLateCompromisedOrders: _nonLateCompromised.map(o => ({
      orderId: o.id,
      availDate: getEffectiveAvailISO(o, inferredTargetMap),
      status: o._n10dStatus,
    })),
    visibleRiskCount: atRiskIds.size,
    visibleRiskSeverity: resolvedSeverity,
  });

  return {
    ordersAtRisk: atRiskIds.size,
    overdueCount,
    delayedCount,
    compromisedCount,
    violationCount: violationIds.size,
    resolvedSeverity, // 'High' or 'Low' only — Moderate removed
  };
}

// ─── Daily utilization (grouped by Avail Date) ────────────────────────────
// Buckets each order in the strategy's sequence by its effective Avail Date.
// Priority: _aiSuggestedDate → getEffectiveAvailISO (target_avail_date +
// inferredTargetMap). The inferredTargetMap parameter is essential for the
// Standard Sequence card where MTS orders typically carry no raw ISO
// target_avail_date — without it those orders silently fall into "(no date)".
//
// Returns:
//   perDay: [{ date: 'YYYY-MM-DD'|'(no date)', orderCount, usedHours, utilizationPercent }]
//   averageUtilization: mean of perDay[].utilizationPercent  (excludes "No date")
function computeDailyUtilization(orders, line, changeoverRules, inferredTargetMap) {
  const isDone = (o) => {
    const s = (o?.status || '').toLowerCase();
    return s === 'done' || s === 'completed' || s === 'cancel_po';
  };
  const runRate = getLineRunRate(line);

  const perAvail = new Map(); // YYYY-MM-DD | '(no date)' -> { date, orderCount, usedHours }
  const ensureBucket = (key) => {
    if (!perAvail.has(key)) perAvail.set(key, { date: key, orderCount: 0, usedHours: 0 });
    return perAvail.get(key);
  };

  // Effective avail date resolution — mirrors the dashboard's own lookup order:
  //   1. _aiSuggestedDate  (set by AI strategy application — AI cards only)
  //   2. getEffectiveAvailISO — checks target_avail_date first, then
  //      inferredTargetMap (MTS inferred threshold). This covers Standard
  //      orders whose avail date lives in the inferred map rather than on
  //      the order's own target_avail_date field.
  const getAvailKey = (o) => {
    const ai = o._aiSuggestedDate;
    if (ai && /^\d{4}-\d{2}-\d{2}/.test(String(ai))) return String(ai).substring(0, 10);
    const eff = getEffectiveAvailISO(o, inferredTargetMap || {});
    if (eff) return eff;
    return '(no date)';
  };

  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    const volume = parseFloat(o.volume || o.total_volume_mt || 0) || 0;
    const prodHours = parseFloat(o.production_hours) || (runRate > 0 ? volume / runRate : 0);

    // Per-order changeover — same logic as computeAtRiskOrders to keep numbers consistent.
    let changeover = 0;
    if (isDone(o)) {
      changeover = o.frozen_changeover != null
        ? (parseFloat(o.frozen_changeover) || 0)
        : (parseFloat(o.changeover_time ?? 0) || 0);
    } else {
      let following = null;
      for (let j = i + 1; j < orders.length; j++) {
        if (!isDone(orders[j])) { following = orders[j]; break; }
      }
      if (following) {
        const baseRaw = parseFloat(o.changeover_time);
        const base = Number.isFinite(baseRaw)
          ? baseRaw
          : (((o.form || '').trim().toUpperCase() === 'C') ? 0.33 : 0.17);
        const { total: additional } = calculateAdditionalChangeover(o, following, changeoverRules || []);
        changeover = parseFloat((base + additional).toFixed(3));
      }
    }

    const totalHours = prodHours + changeover;
    const bucket = ensureBucket(getAvailKey(o));
    bucket.orderCount += 1;
    bucket.usedHours  += totalHours;
  }

  // Sort dated buckets chronologically; push "(no date)" to the end.
  const days = Array.from(perAvail.values())
    .sort((a, b) => {
      if (a.date === '(no date)') return 1;
      if (b.date === '(no date)') return -1;
      return a.date.localeCompare(b.date);
    })
    .map(d => ({
      date: d.date,
      orderCount: d.orderCount,
      usedHours: parseFloat(d.usedHours.toFixed(2)),
      utilizationPercent: d.date === '(no date)'
        ? null  // no meaningful % for undated orders
        : parseFloat(((d.usedHours / 24) * 100).toFixed(1)),
    }));

  // Average excludes the "(no date)" bucket.
  const dated = days.filter(d => d.date !== '(no date)' && d.utilizationPercent != null);
  const avg = dated.length > 0
    ? dated.reduce((s, d) => s + d.utilizationPercent, 0) / dated.length
    : 0;

  return {
    perDay: days,
    averageUtilization: parseFloat(avg.toFixed(1)),
  };
}

// ─── Master-data enrichment (margin + profit rate) ─────────────────────────
// Normalize a material code so we can match across data sources that store
// the same code in different formats (numeric vs string, with/without
// padding, leading zeros, whitespace, etc.).
function normalizeMaterialCode(value) {
  if (value == null) return '';
  return String(value).trim();
}

// Look up an order's margin from master data, trying every known code-field
// alias on both the order and the master-data record. Returns marginFound
// flag so downstream callers can distinguish "true zero" from "not found".
function getMarginFromMasterData(order, masterData) {
  if (!order || !masterData || !masterData.length) {
    return { margin: 0, marginFound: false, matchedField: null };
  }
  const orderCode = normalizeMaterialCode(
    order.material_code_fg ||
    order.fg_material_code ||
    order.material_code
  );
  if (!orderCode) {
    return { margin: 0, marginFound: false, matchedField: null };
  }
  const match = masterData.find(md => {
    const codes = [
      md.fg_material_code,
      md.material_code_fg,
      md.material_code,
      md.MaterialCode,
      md['FG Material Code'],
      md['Material Code (FG)'],
      md['Material Code'],
    ].map(normalizeMaterialCode);
    return codes.includes(orderCode);
  });
  if (!match) {
    return { margin: 0, marginFound: false, matchedField: null };
  }
  const rawMargin = match.margin ?? match.Margin ?? match['Margin'] ?? match['Margin (%)'] ?? null;
  const parsed = parseFloat(rawMargin);
  if (Number.isNaN(parsed)) {
    return { margin: 0, marginFound: false, matchedField: 'margin-unparseable' };
  }
  return { margin: parsed, marginFound: true, matchedField: 'margin' };
}

function enrichWithMargin(ordersByLine, masterData) {
  const enriched = {};
  for (const [line, orders] of Object.entries(ordersByLine)) {
    enriched[line] = orders.map(o => {
      const { margin, marginFound, matchedField } = getMarginFromMasterData(o, masterData);
      const volume = parseFloat(o.volume_override || o.volume || o.total_volume_mt || 0) || 0;
      const prodHours = parseFloat(o.production_hours) || 0;
      const changeover = parseFloat(o._changeoverTotal ?? o.changeover_time ?? 0) || 0;
      const runtimeTotal = prodHours + changeover;
      return {
        ...o,
        _margin: margin,
        _marginFound: marginFound,
        _marginMatchedField: matchedField,
        _marginTotal: margin * volume,                                   // total margin contribution
        _profitRate: runtimeTotal > 0 ? margin / runtimeTotal : 0,      // margin per runtime-hour
        _runtimeTotal: runtimeTotal,
      };
    });
  }
  return enriched;
}

// ─── Rule-based strategy (no AI) ───────────────────────────────────────────
export function buildRuleBasedStrategy(sequencedResults, masterData) {
  const enriched = enrichWithMargin(sequencedResults, masterData);
  // Re-stamp prio cleanly
  for (const orders of Object.values(enriched)) {
    orders.forEach((o, i) => { o.prio = i + 1; });
  }
  return {
    id: "rule_based",
    name: "Standard Sequence",
    theme: "Rule-Based",
    description: "Sequenced strictly by availability dates and future dispatch thresholds.",
    icon: "",
    color: "blue",
    orders: enriched,
    metrics: calculateStrategyMetrics(enriched),
    aiReasoning: "",
    dateAdjustments: [],
    isAIRecommended: false,
    isAIGenerated: false,
    aiFailed: false,
  };
}

// ─── Effective avail-date helper ───────────────────────────────────────────
// Returns the ISO date that should be treated as the order's deadline ceiling.
// Mirrors the UI's getEffectiveAvailDate logic so the AI's safe window matches what users see.
//   1. order.target_avail_date if it's already an ISO date.
//   2. inferredTargetMap[material_code]?.targetDate if it's an ISO date.
//   3. null (caller falls back to a default ceiling).
function getEffectiveAvailISO(order, inferredTargetMap) {
  if (order.target_avail_date && MTO_DATE_RE.test(String(order.target_avail_date))) {
    return String(order.target_avail_date).substring(0, 10);
  }
  const inf = (inferredTargetMap || {})[order.material_code]
           || (inferredTargetMap || {})[order.material_code_fg];
  if (inf?.targetDate && MTO_DATE_RE.test(String(inf.targetDate))) {
    return String(inf.targetDate).substring(0, 10);
  }
  return null;
}

// ─── Overdue date rollforward for AI scheduling context ───────────────────
// When an order's effective avail date has already passed, the AI model
// should NOT anchor on that stale past date when generating suggested_dates.
// This helper returns a rolled-forward anchor (today) for use inside prompt
// builders so the AI sees a realistic current scheduling starting point.
//
// Important: this ONLY affects what the AI model receives in the prompt.
// The original order.target_avail_date / inferredTargetMap value is never
// mutated, and the visible UI fields remain unchanged.
//
// Returns: todayISO when effectiveAvail is overdue, otherwise effectiveAvail.
function resolveAISchedulingAnchor(effectiveAvail, todayISO) {
  if (effectiveAvail && effectiveAvail < todayISO) return todayISO;
  return effectiveAvail;
}

// ─── AI prompt builder ─────────────────────────────────────────────────────
function buildAIPrompt(ordersByLine, withProfitability, inferredTargetMap = {}, changeoverRules = null) {
  const allOrders = Object.values(ordersByLine).flat();

  const N10D_URGENCY = { Critical: 1, Urgent: 2, Monitor: 3, Flexible: 4 };

  const orderDetails = allOrders.map(o => {
    const effectiveAvail = getEffectiveAvailISO(o, inferredTargetMap) || null;
    const _today0 = new Date(); _today0.setHours(0, 0, 0, 0);
    const _todayISO = _toLocalISO(_today0);
    // n10d_days_remaining: calendar days from today to the effective ceiling (0 = at threshold, 999 = unknown)
    let n10d_days_remaining = 999;
    if (effectiveAvail) {
      const deadline = new Date(effectiveAvail);
      n10d_days_remaining = Math.max(0, Math.ceil((deadline - _today0) / (1000 * 60 * 60 * 24)));
    }
    const mto = isMTO(o);
    const critical = isCritical(o);
    const urgent = o._n10dStatus === "Urgent";
    const monitor = o._n10dStatus === "Monitor";
    const flexible = !mto && !critical && !urgent && !monitor;

    // Overdue rollforward: if the order's effective avail date is already in the
    // past, the AI model should not anchor on that stale date. Roll it forward
    // to today so the AI uses a current scheduling anchor. The original
    // target_avail_date and inferredTargetMap data are NEVER mutated here.
    const isOriginalDateOverdue = !!(effectiveAvail && effectiveAvail < _todayISO);
    const aiAnchorDate = resolveAISchedulingAnchor(effectiveAvail, _todayISO);
    if (isOriginalDateOverdue) {
      console.debug('[AI Overdue Date Rollforward]', {
        orderId: o.id,
        originalAvailDate: effectiveAvail,
        currentSchedulingDate: _todayISO,
        isOriginalDateOverdue: true,
        effectiveAiSchedulingDate: aiAnchorDate,
        strategyTitle: 'buildAIPrompt (plant-wide legacy)',
      });
    }

    // safe_window_end = the LATEST date AI may suggest for this order.
    //   • MTO/Critical/Urgent/Monitor → aiAnchorDate (HARD ceiling — cannot delay)
    //     If overdue, aiAnchorDate = today so the ceiling is also updated to today.
    //   • Flexible (Sufficient)        → effectiveAvail + 14 days (SOFT — stock-sufficient,
    //                                     may defer for changeover/profit optimisation)
    //   • Flexible with no avail date  → today + 24 days (10d default + 14d buffer)
    let safe_window_end = isOriginalDateOverdue && !flexible ? aiAnchorDate : effectiveAvail;
    if (flexible) {
      if (effectiveAvail) {
        const d = new Date(effectiveAvail);
        d.setDate(d.getDate() + 14);
        safe_window_end = d.toISOString().substring(0, 10);
      } else {
        const d = new Date();
        d.setDate(d.getDate() + 24);
        safe_window_end = d.toISOString().substring(0, 10);
      }
    }

    return {
      id: o.id,
      line: o.feedmill_line,
      description: (o.item_description || "").substring(0, 60),
      volume: parseFloat(o.volume || o.total_volume_mt || 0) || 0,
      // current_avail_date: rolled forward to today when the original date is
      // overdue so the AI model uses a current scheduling anchor. The raw UI
      // field and underlying order data remain unchanged.
      current_avail_date: aiAnchorDate || o.target_avail_date || null,
      // safe_window_end = HARD upper bound the AI must not exceed (= aiAnchorDate
      // for firm statuses; = effectiveAvail + 14d for flexible orders).
      safe_window_end,
      n10d_days_remaining,
      future_dispatch_status: o._n10dStatus || "Flexible",
      urgency_rank: mto ? 1 : (N10D_URGENCY[o._n10dStatus] ?? 4),
      is_mto: mto,
      is_critical: critical,
      is_urgent: urgent,
      is_monitor: monitor,
      is_flexible: flexible,
      margin: parseFloat(o._margin) || 0,
      profit_rate: o._profitRate != null ? parseFloat(o._profitRate.toFixed(3)) : 0,
      production_hours: parseFloat(o.production_hours) || 0,
      changeover_hours: parseFloat(o._changeoverTotal ?? o.changeover_time ?? 0) || 0,
      color: o.color || null,
      diameter: o.diameter || null,
      category: o.category || null,
      form: o.form || null,
    };
  });

  const lineSummary = Object.entries(ordersByLine)
    .map(([line, orders]) => `${line}: ${orders.length} orders`)
    .join(", ");

  // Category counts for prompt header
  const countCritical  = allOrders.filter(o => isCritical(o)).length;
  const countUrgent    = allOrders.filter(o => o._n10dStatus === "Urgent").length;
  const countMonitor   = allOrders.filter(o => o._n10dStatus === "Monitor").length;
  const countSufficient = allOrders.filter(o => !isMTO(o) && !isCritical(o) && o._n10dStatus !== "Urgent" && o._n10dStatus !== "Monitor").length;
  const countMTO       = allOrders.filter(isMTO).length;

  const systemPrompt = `You are an AI production scheduler for a feed manufacturing plant. Your PRIMARY responsibility is to protect order deadlines. Only optimise flow WITHIN the constraints set by deadlines. Respond ONLY with valid JSON.`;

  // Live cost matrix sourced from the user-configured Changeover Rules tab
  // (per-feedmill values for FM1/FM2/FM3). Falls back to defaults if missing.
  const dynamicChangeoverSection = buildDynamicChangeoverPromptSection(
    changeoverRules || getFallbackChangeoverRules()
  );

  const userPrompt = `Re-sequence the following orders within their assigned lines.

CURRENT ORDERS (${allOrders.length} total — Critical: ${countCritical} | Urgent: ${countUrgent} | Monitor: ${countMonitor} | Sufficient: ${countSufficient} | MTO: ${countMTO}):
Lines: ${lineSummary}

⚠ IMPORTANT: Use the EXACT line key names shown above (e.g. "Line 1") as keys in your strategy response.
Every order_id below must appear exactly once in the output with a suggested_date.

${JSON.stringify(orderDetails, null, 2)}

${dynamicChangeoverSection}

GOAL: minimise TOTAL changeover hours across the entire production run.

════════════════════════════════════════════
STRICT DEADLINE RULES — these override every other consideration including changeover savings.
════════════════════════════════════════════

RULE 1 — SEQUENCE FIRM-DEADLINE ORDERS BY THEIR DEADLINE (EARLIEST FIRST):
  • MTO orders (is_mto: true)             → HARD deadline = current_avail_date. Never miss. Never move past it.
  • MTS future_dispatch_status "Critical" → produce TODAY. Pin to position 1 in line.
  • MTS future_dispatch_status "Urgent"   → HARD ceiling = current_avail_date. Cannot delay.
  • MTS future_dispatch_status "Monitor"  → HARD ceiling = current_avail_date. Cannot delay.
  • MTS is_flexible: true (Sufficient)   → NO hard deadline. FREE to reposition anywhere within safe_window_end.

RULE 2 — FLEXIBLE ORDERS MAY MOVE FREELY:
  is_flexible: true orders have no firm deadline. You MAY:
  • Move them earlier (to cluster with compatible materials)
  • Move them later (up to safe_window_end, which is current_avail_date + 14 days)
  • Place them adjacent to matching MTO orders for zero-changeover transitions

RULE 3 — MTO DATES ARE IMMUTABLE:
  suggested_date for any MTO order = current_avail_date exactly (copy it verbatim).

RULE 4 — NO CROSS-LINE MOVES. RULE 5 — EVERY ORDER_ID APPEARS EXACTLY ONCE.

════════════════════════════════════════════
STRATEGY: ${withProfitability ? "PROFIT-OPTIMIZED" : "BALANCED"}
════════════════════════════════════════════
${withProfitability
  ? `Goal: maximise PROFIT SCORE across the production run while respecting all deadlines.

PROFIT SCORE definition:
  Profit Score = Margin ÷ (Production Hours + Changeover Hours)
  — Margin is stored as a percentage, so Profit Score is a profitability ranking score, not a currency rate.
  — A high-margin order followed by a compatible material has a better profit score than the same order
    followed by an incompatible material (changeover hours inflate the denominator).
  — Use the changeover matrix above to estimate changeover cost for each transition.

STEP 1 — SORT FLEXIBLE ORDERS BY PROFIT SCORE (highest first).
  • Calculate each flexible order's profit_score = margin ÷ (production_hours + expected_changeover_hours).
  • Higher profit-score flexible orders MUST appear EARLIER in the line.
  • Only exception: a firm-deadline order (MTO/Critical/Urgent/Monitor) blocks the position — never push it back.
  • Tie-break: prefer grouping compatible materials to reduce the changeover denominator.

STEP 2 — CLUSTER COMPATIBLE MATERIALS WITHIN THE PROFIT-SCORE ORDER.
  • If two adjacent profit-score orders share category+color+diameter → place them BACK-TO-BACK.
  • This reduces changeover hours, improving profit score for the follower.
  • Max 1 position swap to achieve a cluster (never skip past a deadline order).

STEP 3 — ASSIGN DATES THAT ENFORCE YOUR INTENDED SEQUENCE.
  • Highest profit-score order gets the EARLIEST date in its safe window (today + 2 at minimum).
  • Each subsequent order gets a date ≥ its predecessor. Space by 1-3 days.
  • Compatible consecutive orders may share the same date.
  • MTO orders: copy current_avail_date exactly.

PROFIT-SCORE EXAMPLE (use the matrix above to verify costs for the actual feedmill):
  Order P (margin 50, prod_hours 4h, Gamefowl-Yellow-3mm, no prev → profit_score ≈ 12.50) → suggested: 29-Apr (FIRST)
  Order R (margin 48, prod_hours 4h, Gamefowl-Yellow-3mm, after P base only 0.17h → profit_score ≈ 11.49) → suggested: 30-Apr (SECOND)
  Order Q (margin 12, prod_hours 4h, Swine-Brown-3mm, after R +color+category → profit_score ≈ 2.70) → suggested: 04-May (LAST — lowest profit score)
  Result: P→R→Q prioritises higher profitability opportunities first.`
  : `Goal: minimise TOTAL changeover hours by clustering compatible materials, without missing any firm deadline.
Margin is NOT considered — only material compatibility matters.

STEP 1 — MAP EACH FLEXIBLE ORDER TO ITS BEST MATERIAL CLUSTER.
  • A material cluster = all orders sharing the same category + color (diameter secondary).
  • For each MTO order on the line, check if any flexible order shares its category+color+diameter.
    → If yes: that flexible order's cluster should be placed IMMEDIATELY BEFORE the MTO.
    → This produces zero extra changeover at the MTO transition.

STEP 2 — ORDER THE CLUSTERS FROM LEFT TO RIGHT.
  • Clusters with a matching MTO anchor → place cluster just before the MTO (dates = MTO_date - 2×n, ..., MTO_date - 2).
  • Remaining clusters without an anchor → place at the start of the line using early safe-window dates.
  • Within each cluster, order by diameter (same diameter first, then diameter changes within cluster).

STEP 3 — ASSIGN suggested_date TO ENFORCE THE CLUSTER ORDER.
  • Each cluster's orders get consecutive dates spaced 2-3 days apart.
  • The cluster adjacent to an MTO gets dates ending 1-2 days before the MTO's current_avail_date.
  • Early clusters start at today+2 and count forward.
  • MTO orders: suggested_date = current_avail_date (copy exactly).
  • IMPORTANT: Do NOT keep a flexible order at its original current_avail_date — the whole point is to
    move it so the chronological sort produces the optimal material-clustered sequence.

REAL-WORLD EXAMPLE 1 — No critical order (MTO anchor):
  Standard (before):
    Pos 1 — Order A  Gamefowl·Yellow·3mm  14-May (Sufficient, flexible)
    Pos 2 — Order B  Swine·Brown·3mm      14-May (Sufficient, flexible)
    Pos 3 — Order C  Swine·Brown·4mm      14-May (Sufficient, flexible)
    Pos 4 — Order D  Gamefowl·Yellow·3mm  22-May (MTO, HARD deadline)
    Changeovers: A→B = base+color+category, B→C = base+diameter, C→D = base+color+category

  AI Balanced (after — correct output):
    Pos 1 — Order B  Swine·Brown·3mm      04-May  (Sufficient — starts Swine/Brown cluster early)
    Pos 2 — Order C  Swine·Brown·4mm      07-May  (Sufficient — same cluster as B)
    Pos 3 — Order A  Gamefowl·Yellow·3mm  21-May  (Sufficient — placed ADJACENT to MTO D, same material)
    Pos 4 — Order D  Gamefowl·Yellow·3mm  22-May  (MTO — date unchanged, copy current_avail_date)
    Changeovers: B→C = base+diameter, C→A = base+color+category, A→D = base only ✓ (one base+color+category eliminated)

REAL-WORLD EXAMPLE 2 — Critical order present, no MTO:
  Standard (before):
    Pos 1 — Order A  Gamefowl·Yellow·3mm  27-Apr (Critical — produce TODAY)
    Pos 2 — Order B  Swine·Brown·3mm      14-May (Sufficient, flexible)
    Pos 3 — Order C  Swine·Brown·4mm      14-May (Sufficient, flexible)
    Pos 4 — Order D  Gamefowl·Yellow·3mm  22-May (Sufficient, flexible)
    Changeovers: A→B = base+color+category, B→C = base+diameter, C→D = base+color+category

  AI Balanced (after — correct output):
    Pos 1 — Order A  Gamefowl·Yellow·3mm  27-Apr  (Critical — suggested_date = TODAY, position 1 always)
    Pos 2 — Order B  Swine·Brown·3mm      07-May  (Sufficient — starts Swine/Brown cluster)
    Pos 3 — Order C  Swine·Brown·4mm      10-May  (Sufficient — same cluster as B)
    Pos 4 — Order D  Gamefowl·Yellow·3mm  28-May  (Sufficient — DEFERRED within safe window to group with A's Gamefowl material)
    Changeovers: same number of transitions, but D now follows the Gamefowl cluster end-to-end ✓

  Key: D was DEFERRED (14-May → 28-May, still within safe_window_end = 14-May+14 = 28-May) so it
  clusters with the Gamefowl material at the end. B+C Swine/Brown cluster is grouped together in the middle.

YOU MUST produce output like these examples:
  • Every flexible order must have a DIFFERENT suggested_date from its current_avail_date
  • Dates must CREATE the desired cluster sequence (dates = position in line)
  • MTO: copy current_avail_date exactly
  • Critical: suggested_date = TODAY`}

════════════════════════════════════════════
PRODUCTION-DATE SUGGESTION (suggested_date) — REQUIRED for every order:
════════════════════════════════════════════
TODAY is ${_toLocalISO(new Date())}.
Earliest allowed suggestion = today + 2 days = ${(() => { const d = new Date(); d.setDate(d.getDate() + 2); return _toLocalISO(d); })()}.

SAFE WINDOW PER STATUS — EVERY order must have a suggested_date:

  • is_mto: true
        → suggested_date = current_avail_date verbatim. Do NOT change.

  • future_dispatch_status "Critical"
        → suggested_date = TODAY (${_toLocalISO(new Date())}). Always position 1.

  • is_urgent or is_monitor
        → WINDOW = [today+2, safe_window_end] where safe_window_end = current_avail_date.
        → You MAY suggest an EARLIER date to advance production and reduce changeover.
        → NEVER exceed safe_window_end (cannot delay Urgent/Monitor past their deadline).

  • is_flexible (Sufficient)
        → WINDOW = [today+2, safe_window_end] where safe_window_end = current_avail_date + 14 days.
        → You MAY move the date EARLIER or LATER anywhere within this window.
        → ⚠ NEVER return the order's original current_avail_date unchanged — the date MUST move.
        → Deferring (later than current_avail_date) is allowed and encouraged when it clusters materials.

MANDATORY: Every single order_id in the input must have a suggested_date in your output.
  • Do NOT skip any order
  • Do NOT suggest the same date as current_avail_date for Sufficient orders (except MTO)
  • Do NOT leave Sufficient orders at their current dates — always move them to create the cluster

HOW THE SORT WORKS: The system re-sorts each line by suggested_date (earliest first) after receiving your JSON.
Your dates ARE the sequence. If you want order B before order C, give B an earlier date than C.
Use "position" as a tiebreak label when two orders share the same date.

RESPONSE FORMAT (JSON only — no markdown, no text outside the JSON):
{
  "strategy": {
    "Line 1": [
      { "order_id": "xxx", "position": 1, "suggested_date": "2026-04-29", "reasoning": "Highest margin in line (₱50,000) — placed first" },
      { "order_id": "zzz", "position": 2, "suggested_date": "2026-04-30", "reasoning": "Same material as order xxx — zero extra changeover" },
      { "order_id": "yyy", "position": 3, "suggested_date": "2026-05-04", "reasoning": "Different material cluster — placed last, lowest margin" }
    ],
    "Line 2": [...]
  },
  "reasoning": "1-2 sentence summary of the strategy applied and total changeover saved",
  "dateAdjustments": [
    { "order_id": "yyy", "original": "2026-05-14", "new": "2026-05-04", "reason": "Sufficient order moved earlier — low margin, fills back-end slot" }
  ]
}`;

  return { systemPrompt, userPrompt };
}

// ─── AI response parser ────────────────────────────────────────────────────
function parseAIResponse(content) {
  if (!content) return { strategy: {}, reasoning: "", dateAdjustments: [] };
  try {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in AI response");
    return JSON.parse(match[0]);
  } catch (err) {
    console.error("[aiSequenceStrategies] Failed to parse AI response:", err);
    return { strategy: {}, reasoning: "", dateAdjustments: [] };
  }
}

// ─── Urgency helpers ────────────────────────────────────────────────────────
const FIRM_STATUSES = new Set(["Critical", "Urgent", "Monitor"]);

// ─── Validate AI output and apply to original orders ──────────────────────
function applyAISequenceToOrders(aiResult, originalOrdersByLine, inferredTargetMap = {}, options = {}) {
  const result = {};
  const todayISO = _toLocalISO(new Date());
  const earliestDate = new Date();
  earliestDate.setDate(earliestDate.getDate() + 2);
  const earliestAllowed = _toLocalISO(earliestDate);
  // Hard ceiling for orders with NO avail_date and NO N10D inference — prevents drift.
  const ceilingDate = new Date();
  ceilingDate.setDate(ceilingDate.getDate() + 10);
  const defaultLatestAllowed = _toLocalISO(ceilingDate);

  // Resolve the AI's suggested production date for an order, applying the per-status rules:
  //   • MTO       → keep avail_date (no suggestion)
  //   • Critical  → today (produce NOW)
  //   • Urgent / Monitor → AI's date, HARD clamp to [today+2, effective_avail_date]
  //   • Sufficient / Flexible → AI's date, SOFT clamp to [today+2, effective_avail_date + 14d]
  //                              (no hard deadline — stock-sufficient, safe to defer for optimisation)
  function resolveSuggestedDate(order, aiSuggested) {
    if (isMTO(order)) {
      // MTO contracts are immutable — keep the existing avail_date.
      return null;
    }
    if (order._n10dStatus === "Critical") {
      // Critical = produce TODAY regardless of what the AI returned.
      // todayISO is always evaluated dynamically (new Date() inside the
      // enclosing applyAISequenceToOrders call), so this can never be stale
      // relative to the run that invoked it.
      console.debug('[AI Avail Date Derivation]', {
        orderId:                    order.id,
        urgencyBucket:              'critical',
        futureDispatchTargetDate:   getEffectiveAvailISO(order, inferredTargetMap) || null,
        todayDateUsed:              todayISO,
        computedAvailDate:          todayISO,
        previousAvailDate:          order._aiSuggestedDate || order.target_avail_date || null,
        sourceRuleApplied:          'critical_today',
        wasRecomputedAfterSequencing: true,
      });
      const previousAvailDate = order._aiSuggestedDate || order.target_avail_date || null;
      if (previousAvailDate && previousAvailDate !== todayISO) {
        console.debug('[AI Avail Date Stale Check]', {
          orderId:             order.id,
          oldAvailDate:        previousAvailDate,
          recomputedAvailDate: todayISO,
          usingStaleValue:     false,
        });
      }
      return { date: todayISO, isFlexible: false };
    }
    if (!aiSuggested || !/^\d{4}-\d{2}-\d{2}/.test(aiSuggested)) {
      return null;
    }
    const minDate = earliestAllowed;
    const isFlexible = !FIRM_STATUSES.has(order._n10dStatus);

    // Effective avail = target_avail_date if ISO, else N10D inferred date.
    const effectiveAvail = getEffectiveAvailISO(order, inferredTargetMap);
    let maxDate;
    if (isFlexible) {
      // Sufficient/Flexible orders have NO hard deadline (stock is sufficient).
      // Allow AI to defer up to 14 days beyond the inferred N10D date for changeover/profit
      // optimisation. If no inferred date at all, allow today+24 (10 default + 14 buffer).
      if (effectiveAvail) {
        const d = new Date(effectiveAvail);
        d.setDate(d.getDate() + 14);
        maxDate = d.toISOString().substring(0, 10);
      } else {
        const d = new Date();
        d.setDate(d.getDate() + 24);
        maxDate = d.toISOString().substring(0, 10);
      }
    } else {
      // Urgent / Monitor — HARD ceiling at the effective avail date. Cannot delay these.
      maxDate = effectiveAvail || defaultLatestAllowed;
    }

    let finalDate = aiSuggested;
    let sourceRule = 'ai_suggested';
    let tight = false;
    if (maxDate < minDate) {
      // Window inverted: the order's deadline has already passed (overdue).
      // Pinning to the past maxDate would set _aiSuggestedDate to a date in the
      // past. Instead, recover ASAP by using today so the order is scheduled
      // at the earliest feasible current date rather than a stale past date.
      finalDate = todayISO;
      sourceRule = 'overdue_recovery_today';
      tight = true;
    } else {
      if (finalDate < minDate) { finalDate = minDate; sourceRule = 'min_clamp_today_plus2'; }
      if (finalDate > maxDate) { finalDate = maxDate; sourceRule = isFlexible ? 'flexible_stock_window' : 'future_dispatch_target'; }
    }

    const urgencyBucket = isFlexible ? 'stock_sufficient' : (order._n10dStatus || 'monitor').toLowerCase();
    console.debug('[AI Avail Date Derivation]', {
      orderId:                    order.id,
      urgencyBucket,
      futureDispatchTargetDate:   effectiveAvail || null,
      todayDateUsed:              todayISO,
      computedAvailDate:          finalDate,
      previousAvailDate:          order._aiSuggestedDate || order.target_avail_date || null,
      sourceRuleApplied:          sourceRule,
      wasRecomputedAfterSequencing: true,
    });
    const prevDate = order._aiSuggestedDate || null;
    if (prevDate && prevDate !== finalDate) {
      console.debug('[AI Avail Date Stale Check]', {
        orderId:             order.id,
        oldAvailDate:        prevDate,
        recomputedAvailDate: finalDate,
        usingStaleValue:     false,
      });
    }

    return { date: finalDate, isFlexible, tight };
  }

  for (const [line, orders] of Object.entries(originalOrdersByLine)) {
    const aiLine = aiResult.strategy?.[line] || [];
    const orderMap = new Map(orders.map(o => [String(o.id), { ...o }]));
    const ordered = [];

    for (const aiOrder of aiLine) {
      const order = orderMap.get(String(aiOrder.order_id));
      if (!order) continue;

      // Accept any of the three field names the model might use.
      const aiSuggested = aiOrder.suggested_date || aiOrder.suggested_start_date || aiOrder.suggested_avail_date;
      const resolved = resolveSuggestedDate(order, aiSuggested);
      if (resolved) {
        order._aiSuggestedDate = resolved.date;
        order._aiSuggestedDateIsFlexible = resolved.isFlexible;
        if (resolved.tight) order._aiSuggestedDateTight = true;
        order._aiReasoning = aiOrder.reasoning || "";
      }
      // Store the AI's explicit position so we can use it as a tiebreak when dates are equal.
      order._aiPosition = typeof aiOrder.position === "number" ? aiOrder.position : null;
      ordered.push(order);
      orderMap.delete(String(aiOrder.order_id));
    }

    // Append any orders the AI missed (safety net) in their original order.
    const missedMTO = [...orderMap.values()].filter(isMTO);
    if (missedMTO.length > 0) {
      console.warn(
        `[aiSequenceStrategies] AI omitted ${missedMTO.length} MTO order(s) on ${line}; ` +
        `appending to end may risk deadline:`,
        missedMTO.map(o => o.id)
      );
    }
    // Critical orders missed by the AI need a TODAY suggestion injected so they sort to the top.
    orderMap.forEach(o => {
      if (!isMTO(o) && o._n10dStatus === "Critical") {
        o._aiSuggestedDate = todayISO;
        o._aiSuggestedDateIsFlexible = false;
      }
      ordered.push(o);
    });

    // ── Sort the line CHRONOLOGICALLY by effective production date ──
    // Effective date = AI suggested date when present, else the order's current avail_date.
    // This is the single source of truth for sequence — earliest first. Critical orders end
    // up at the top because they all carry today's date; Urgent/Monitor/Sufficient slot in
    // by their AI-suggested or original avail_date; orders with no date sort last.
    // Tiebreak: AI's explicit `position` field when dates are equal (preserves cluster grouping).
    const chronological = [...ordered]
      .map((o, i) => ({ o, i, key: effectiveProductionDateKey(o) }))
      .sort((a, b) => {
        if (a.key < b.key) return -1;
        if (a.key > b.key) return 1;
        // Same date — use AI's explicit position if provided
        const posA = a.o._aiPosition ?? Infinity;
        const posB = b.o._aiPosition ?? Infinity;
        if (posA !== posB) return posA - posB;
        return a.i - b.i; // final stable tiebreak: original array order
      })
      .map(({ o }) => o);

    // ── Post-process: cluster flexible orders by material compatibility ──
    // The AI occasionally fails to pull a late Sufficient order into an earlier
    // cluster of the same (category, color). This deterministic pass fixes that
    // by re-anchoring each material cluster to its earliest assigned date.
    //
    // Skipped for the balanced strategy — applyBalancedDateHeuristic does its
    // own re-pricing of flexible dates (and a final chronological sort with a
    // material-compatibility tiebreaker) further downstream.
    const clustered = options.skipClustering
      ? chronological
      : postProcessCluster(chronological, inferredTargetMap);

    // Re-stamp prio
    clustered.forEach((o, i) => { o.prio = i + 1; });
    result[line] = clustered;
  }
  return result;
}

// Return the date this order will ACTUALLY be produced for, used for chronological sorting.
// Prefers the AI-suggested date, then the order's avail_date, then a sentinel.
function effectiveProductionDateKey(o) {
  if (o._aiSuggestedDate && /^\d{4}-\d{2}-\d{2}/.test(o._aiSuggestedDate)) {
    return String(o._aiSuggestedDate).substring(0, 10);
  }
  if (o.target_avail_date && /^\d{4}-\d{2}-\d{2}/.test(String(o.target_avail_date))) {
    return String(o.target_avail_date).substring(0, 10);
  }
  return "9999-99-99";
}

// Pairwise changeover cost between two orders (uses LIVE configured rules
// from the Changeover Rules tab). Imported from @/utils/changeoverCalc as
// `calculateChangeoverBetween(a, b, rules)`.

// ─── Post-processing: cluster flexible orders by material compatibility ────
// The AI is instructed to cluster via date assignment but doesn't always follow
// through (e.g. a Sufficient order with a late avail_date gets left behind even
// though it shares category+color with earlier orders on the same line).
//
// This pass groups flexible (Sufficient) orders by (category, color), anchors
// each cluster to the EARLIEST date already assigned in that group, and assigns
// consecutive dates (2-day steps) to all cluster members — so the chronological
// re-sort that follows will naturally place them adjacent.
//
// Rules:
//   • Only FLEXIBLE orders are re-clustered (FIRM orders keep their AI dates).
//   • A cluster is only compressed if 2+ orders share (category, color).
//   • The target date must be within [today+2, effectiveAvail + 14d] — the same
//     safe window used throughout the rest of the pipeline.
//   • Orders are already sorted within the cluster by diameter then original date.
function postProcessCluster(orders, inferredTargetMap = {}) {
  const isFirmOrder = o => FIRM_STATUSES.has(o._n10dStatus) || isMTO(o);
  const dateOf     = o => effectiveProductionDateKey(o);
  const clusterKey = o =>
    `${(o.category || '_').toLowerCase()}|${(o.color || '_').toLowerCase()}`;

  const today = new Date();
  const earliestDate = new Date(today);
  earliestDate.setDate(earliestDate.getDate() + 2);
  const earliestISO = earliestDate.toISOString().substring(0, 10);

  // Group only FLEXIBLE orders by cluster key
  const clusters = new Map();
  for (const o of orders) {
    if (isFirmOrder(o)) continue;
    const k = clusterKey(o);
    if (!clusters.has(k)) clusters.set(k, []);
    clusters.get(k).push(o);
  }

  clusters.forEach((clOrders) => {
    if (clOrders.length < 2) return; // no clustering needed for singletons

    // Cluster anchor = earliest effective date in the group (floored at today+2)
    const dates = clOrders
      .map(dateOf)
      .filter(d => d !== '9999-99-99')
      .sort();
    if (dates.length === 0) return;
    const anchorISO = dates[0] < earliestISO ? earliestISO : dates[0];

    // Sort cluster: diameter asc, then original date asc as secondary
    clOrders.sort((a, b) => {
      const dA = parseFloat(a.diameter || 0);
      const dB = parseFloat(b.diameter || 0);
      if (dA !== dB) return dA - dB;
      return dateOf(a).localeCompare(dateOf(b));
    });

    clOrders.forEach((o, i) => {
      const existingDate = dateOf(o);
      const anchor = new Date(anchorISO);
      anchor.setDate(anchor.getDate() + i * 2); // 2-day spacing within cluster
      const targetISO = anchor.toISOString().substring(0, 10);

      // Only pull forward — never push later than current effective date
      if (targetISO >= existingDate) return;

      // Verify target is within this order's safe window (avail + 14d for Sufficient)
      const effectiveAvail = getEffectiveAvailISO(o, inferredTargetMap);
      let safeEnd = '9999-99-99';
      if (effectiveAvail) {
        const se = new Date(effectiveAvail);
        se.setDate(se.getDate() + 14);
        safeEnd = se.toISOString().substring(0, 10);
      }
      if (targetISO > safeEnd) return; // would breach safe window — skip

      // Move the order into the cluster slot
      o._aiSuggestedDate = targetISO;
      o._aiSuggestedDateIsFlexible = true;
      if (!o._aiReasoning) {
        o._aiReasoning = `Clustered with ${(o.category || '')}·${(o.color || '')} orders to reduce changeover`;
      }
    });
  });

  // Re-sort by updated effective dates (same logic as chronological sort above)
  // Stable tiebreak: AI position when present, then original input index.
  const indexed = orders.map((o, i) => ({ o, i }));
  indexed.sort((a, b) => {
    const dA = dateOf(a.o);
    const dB = dateOf(b.o);
    if (dA < dB) return -1;
    if (dA > dB) return 1;
    const posA = a.o._aiPosition ?? Infinity;
    const posB = b.o._aiPosition ?? Infinity;
    if (posA !== posB) return posA - posB;
    return a.i - b.i; // stable: preserves original order on full ties
  });
  return indexed.map(({ o }) => o);
}

// ─── AI Balanced: heuristic dates + chronological-with-tiebreak sort ──────
// Approach (chronology-first, compatibility-second):
//   1. Protected orders (MTO/Critical/Urgent/Monitor) keep their AI-clamped
//      date — the heuristic never moves them.
//   2. Flexible orders (Sufficient) get a heuristic-chosen date inside their
//      safe window, scored by daily line load + material compatibility +
//      mild earliness preference + heavy overload penalty.
//   3. After dates settle, the line is re-sorted CHRONOLOGICALLY. When
//      effective dates are equal, the tiebreak is:
//          (a) protected rank (MTO < Critical < Urgent < Monitor < flexible)
//          (b) material compatibility (category, color, diameter, form)
//      so visually-identical materials cluster on the same date without
//      letting grouping override timeline logic.

function isProtectedOrder(o) {
  return isMTO(o) || FIRM_STATUSES.has(o._n10dStatus);
}

function getProtectedRank(o) {
  if (isMTO(o)) return 0;
  if (o._n10dStatus === "Critical") return 1;
  if (o._n10dStatus === "Urgent")   return 2;
  if (o._n10dStatus === "Monitor")  return 3;
  return 4;
}

function getMaterialSignature(o) {
  const cat  = String(o.category || "").trim().toLowerCase();
  const col  = String(o.color    || "").trim().toLowerCase();
  const dia  = String(o.diameter || "").trim().toLowerCase();
  const form = String(o.form     || "").trim().toLowerCase();
  return `${cat}|${col}|${dia}|${form}`;
}

// Compatibility tiebreaker: only used when chronology is effectively equal.
// Returns a deterministic ordering by (category, color, diameter, form) so
// orders sharing material attributes end up adjacent on the same date.
function compareMaterialCompatibility(a, b) {
  const sigA = getMaterialSignature(a);
  const sigB = getMaterialSignature(b);
  if (sigA === sigB) return 0;

  const ca = String(a.category || "").toLowerCase();
  const cb = String(b.category || "").toLowerCase();
  if (ca !== cb) return ca.localeCompare(cb);

  const coA = String(a.color || "").toLowerCase();
  const coB = String(b.color || "").toLowerCase();
  if (coA !== coB) return coA.localeCompare(coB);

  const dA = String(a.diameter || "").toLowerCase();
  const dB = String(b.diameter || "").toLowerCase();
  if (dA !== dB) return dA.localeCompare(dB);

  const fA = String(a.form || "").toLowerCase();
  const fB = String(b.form || "").toLowerCase();
  return fA.localeCompare(fB);
}

function getBalancedSafeWindow(order, inferredTargetMap) {
  const today = new Date();
  const earliest = new Date(today);
  earliest.setDate(earliest.getDate() + 2);
  const earliestISO = earliest.toISOString().substring(0, 10);

  if (isProtectedOrder(order)) {
    // Protected orders keep their AI-clamped date — return a single-date
    // "window" so the heuristic never re-picks them.
    const fixed = (order._aiSuggestedDate && /^\d{4}-\d{2}-\d{2}/.test(order._aiSuggestedDate))
      ? String(order._aiSuggestedDate).substring(0, 10)
      : (order.target_avail_date && MTO_DATE_RE.test(String(order.target_avail_date))
          ? String(order.target_avail_date).substring(0, 10)
          : earliestISO);
    return { start: fixed, end: fixed };
  }

  const effectiveAvail = getEffectiveAvailISO(order, inferredTargetMap);
  if (!effectiveAvail) {
    const e = new Date(today);
    e.setDate(e.getDate() + 24); // 10 default + 14 buffer (mirrors resolveSuggestedDate)
    return { start: earliestISO, end: e.toISOString().substring(0, 10) };
  }
  const latest = new Date(effectiveAvail);
  latest.setDate(latest.getDate() + 14);
  const endISO = latest.toISOString().substring(0, 10);
  // Inverted window — pin to the deadline (matches resolveSuggestedDate's
  // `if (maxDate < minDate) finalDate = maxDate` behavior).
  if (endISO < earliestISO) return { start: endISO, end: endISO };
  return { start: earliestISO, end: endISO };
}

function orderProductionHours(o, line) {
  const runRate = getLineRunRate(line);
  const volume = parseFloat(o.volume_override || o.volume || o.total_volume_mt || 0) || 0;
  const prodHours = runRate > 0 ? volume / runRate : 0;
  const co = parseFloat(o._changeoverTotal ?? o.changeover_time ?? 0) || 0;
  return prodHours + co;
}

// ─── Heuristic date scoring ────────────────────────────────────────────────

function enumerateDates(startISO, endISO) {
  const dates = [];
  const start = new Date(startISO);
  const end = new Date(endISO);
  if (end < start) return [startISO];
  const cur = new Date(start);
  let safetyCap = 90; // cap window enumeration to 90 days
  while (cur <= end && safetyCap-- > 0) {
    dates.push(cur.toISOString().substring(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function buildDailyLoadMap(orders, line) {
  const map = new Map();
  orders.forEach(o => {
    const dt = effectiveProductionDateKey(o);
    if (dt === '9999-99-99') return;
    if (!map.has(dt)) map.set(dt, { orderCount: 0, totalHours: 0 });
    const bucket = map.get(dt);
    bucket.orderCount += 1;
    bucket.totalHours += orderProductionHours(o, line);
  });
  return map;
}

// Rate how compatible an order is with other orders already on the same date.
// We score by the SHAPE of the material difference rather than raw hours, so
// the bands stay correct regardless of how the user has configured per-FM
// values in the Changeover Rules tab. The live rule cost (via
// `calculateChangeoverBetween`) is still consulted as a tiebreak/sanity check
// so that an FM-specific zero-cost rule can lift a band one notch.
function estimateCompatibilityGain(order, candidateDate, orders, changeoverRules) {
  const sameDate = orders.filter(o => {
    if (String(o.id) === String(order.id)) return false;
    return effectiveProductionDateKey(o) === candidateDate;
  });
  if (sameDate.length === 0) return 1; // neutral-positive — fills empty/light day

  const norm = (v) => String(v ?? "").trim().toLowerCase();
  const sameColor    = (a, b) => norm(a.color)    === norm(b.color);
  const sameCategory = (a, b) => norm(a.category) === norm(b.category);
  const sameDiameter = (a, b) => {
    const da = parseFloat(a.diameter) || 0;
    const db = parseFloat(b.diameter) || 0;
    return da === db;
  };

  let bestGain = 0;
  for (const other of sameDate) {
    let attrDiffs = 0;
    if (!sameColor(order, other))    attrDiffs += 1;
    if (!sameCategory(order, other)) attrDiffs += 1;
    const diameterChanged = !sameDiameter(order, other);

    // Diameter change dominates (it's the costliest physical step in every
    // feedmill configuration we've ever shipped) — collapse to the lowest band.
    let band;
    if (diameterChanged)        band = 1;
    else if (attrDiffs === 0)   band = 4; // identical material — base changeover only
    else if (attrDiffs === 1)   band = 3; // one attribute differs
    else                        band = 2; // both color + category differ

    // Sanity check: if the LIVE rule cost for this transition is essentially
    // zero (e.g. user disabled a rule for this FM), promote one band.
    const co = calculateChangeoverBetween(order, other, changeoverRules);
    if (band < 4 && co <= 0.20) band = Math.min(4, band + 1);

    if (band > bestGain) bestGain = band;
  }
  return bestGain;
}

function scoreBalancedCandidateDate(order, candidateDate, line, orders, dailyLoadMap, changeoverRules) {
  let score = 0;
  const load = dailyLoadMap.get(candidateDate) || { orderCount: 0, totalHours: 0 };

  // 1. Prefer lighter days (12hr healthy daily target, 4 orders comfortable)
  score += Math.max(0, 12 - load.totalHours) * 4;
  score += Math.max(0, 4 - load.orderCount) * 2;

  // 2. Reward grouping with compatible materials already on that day
  score += estimateCompatibilityGain(order, candidateDate, orders, changeoverRules) * 10;

  // 3. Mild preference for earlier dates within next 20 days
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const candidate = new Date(candidateDate);
  candidate.setHours(0, 0, 0, 0);
  const daysFromToday = Math.round((candidate - today) / (1000 * 60 * 60 * 24));
  score += Math.max(0, 20 - daysFromToday) * 0.75;

  // 4. Penalize overloaded days (heavy past a full shift)
  if (load.totalHours > 16) score -= 20;
  if (load.totalHours > 20) score -= 30;

  return score;
}

function chooseBestBalancedDate(order, line, orders, safeWindow, dailyLoadMap, changeoverRules) {
  const candidates = enumerateDates(safeWindow.start, safeWindow.end);
  let bestDate = safeWindow.start;
  let bestScore = -Infinity;
  for (const d of candidates) {
    const s = scoreBalancedCandidateDate(order, d, line, orders, dailyLoadMap, changeoverRules);
    if (s > bestScore) {
      bestScore = s;
      bestDate = d;
    }
  }
  return bestDate;
}

// ─── Final sort: chronological first, compatibility as tiebreak ────────────
//
// CONTRACT: chronology is the PRIMARY sort key and can NEVER be overridden by
// any tiebreaker. Material compatibility is only consulted when two orders
// share the SAME effective production date (and the same protected rank).
// This guarantees the rendered table is always "earliest avail-date on top,
// latest at the bottom" — a 22-May order can never appear above a 05-May one.

// Returns true iff `s` looks like a real ISO date (YYYY-MM-DD prefix).
// String labels like "stock_sufficient" / "safety_stocks" / null fail this.
function isISODateValue(s) {
  if (s == null) return false;
  if (s instanceof Date) return !isNaN(s.getTime());
  return /^\d{4}-\d{2}-\d{2}/.test(String(s));
}

// Normalize anything date-ish to a YYYY-MM-DD string for comparison.
// Returns null when the input isn't a real date — caller treats null as
// "no date" and sorts those AFTER all real dates.
function normalizeDateForSort(s) {
  if (!isISODateValue(s)) return null;
  if (s instanceof Date) return s.toISOString().substring(0, 10);
  return String(s).substring(0, 10);
}

function sortOrdersChronologicallyWithBalancedTieBreak(orders) {
  const indexed = orders.map((o, i) => ({ o, i }));
  indexed.sort((a, b) => {
    // Effective date = AI-suggested date if present, else target_avail_date.
    const rawA = a.o._aiSuggestedDate || a.o.target_avail_date;
    const rawB = b.o._aiSuggestedDate || b.o.target_avail_date;
    const dA = normalizeDateForSort(rawA);
    const dB = normalizeDateForSort(rawB);

    const isAReal = dA !== null;
    const isBReal = dB !== null;

    // 1. Real dated values come BEFORE non-date labels (stock_sufficient etc.)
    if (isAReal && !isBReal) return -1;
    if (!isAReal && isBReal) return 1;

    // 2. Both real dates → strict chronological order ALWAYS wins.
    //    Nothing below this point can flip the order across different dates.
    if (isAReal && isBReal && dA !== dB) {
      return dA < dB ? -1 : 1;
    }

    // 3. Same effective date (or both non-date) → protected rank decides
    //    (MTO < Critical < Urgent < Monitor < flexible).
    const rA = getProtectedRank(a.o);
    const rB = getProtectedRank(b.o);
    if (rA !== rB) return rA - rB;

    // 4. Same date + same protected rank → material compatibility tiebreak
    //    so adjacent orders share material attributes when possible.
    const cmp = compareMaterialCompatibility(a.o, b.o);
    if (cmp !== 0) return cmp;

    // 5. Final stable tiebreak: original input order.
    return a.i - b.i;
  });
  return indexed.map(({ o }) => o);
}

// ─── Top-level: re-pick flexible dates, then chronological+tiebreak sort ──

function applyBalancedDateHeuristic(ordersByLine, inferredTargetMap = {}, changeoverRules = null) {
  const result = {};
  for (const [line, orders] of Object.entries(ordersByLine)) {
    if (!orders || orders.length === 0) {
      result[line] = [];
      continue;
    }

    const dailyLoadMap = buildDailyLoadMap(orders, line);

    orders.forEach(o => {
      if (isProtectedOrder(o)) return; // keep AI-clamped date

      const safeWindow = getBalancedSafeWindow(o, inferredTargetMap);
      const oldDate = effectiveProductionDateKey(o);
      const newDate = chooseBestBalancedDate(o, line, orders, safeWindow, dailyLoadMap, changeoverRules);
      if (!/^\d{4}-\d{2}-\d{2}/.test(newDate) || newDate === oldDate) return;

      // Update load map incrementally so subsequent orders see this placement
      const hours = orderProductionHours(o, line);
      if (oldDate !== '9999-99-99' && dailyLoadMap.has(oldDate)) {
        const b = dailyLoadMap.get(oldDate);
        b.orderCount = Math.max(0, b.orderCount - 1);
        b.totalHours = Math.max(0, b.totalHours - hours);
      }
      if (!dailyLoadMap.has(newDate)) dailyLoadMap.set(newDate, { orderCount: 0, totalHours: 0 });
      const nb = dailyLoadMap.get(newDate);
      nb.orderCount += 1;
      nb.totalHours += hours;

      o._aiSuggestedDate = newDate;
      o._aiSuggestedDateIsFlexible = true;
      o._balancedHeuristicApplied = true;
      if (!o._aiReasoning) {
        o._aiReasoning = `Balanced heuristic chose ${newDate} based on line load and material compatibility`;
      }
    });

    // Final sort: chronological-first, compatibility-second
    const sorted = sortOrdersChronologicallyWithBalancedTieBreak(orders);
    sorted.forEach((o, i) => { o.prio = i + 1; });
    result[line] = sorted;
  }
  return result;
}



// ─── Profit-rate helpers ───────────────────────────────────────────────────
//
// Profit Rate = Margin ÷ (Production Hours + Changeover Hours)
//
// Changeover hours depend on which order PRECEDES this one in the sequence
// (positional), so we compute them per-candidate using the actual preceding
// order found by findNearestPreviousOrderOnOrBeforeDate.
//
// This is distinct from _profitRate stamped by enrichWithMargin (which uses
// the static pre-computed changeover on the order object). The dynamic
// calculation here accounts for how changeover varies with ordering.

// Production hours only (no changeover) — so we can separately add the
// positional changeover for each candidate pairing.
function calcProductionHoursOnly(o, line) {
  const runRate = getLineRunRate(line);
  const volume = parseFloat(o.volume_override || o.volume || o.total_volume_mt || 0) || 0;
  return runRate > 0 ? volume / runRate : 0;
}

// Find the order scheduled most recently on or before candidateDate
// (excluding the current order itself). This is the order this order would
// follow if placed on candidateDate, so we can compute the changeover cost.
function findNearestPreviousOrderOnOrBeforeDate(order, candidateDate, orders) {
  const pool = orders.filter(o => {
    if (String(o.id) === String(order.id)) return false;
    const d = effectiveProductionDateKey(o);
    return d !== '9999-99-99' && d <= candidateDate;
  });
  if (pool.length === 0) return null;
  // Sort DESC by date, then DESC by prio number (higher number = runs later on same day)
  pool.sort((a, b) => {
    const dA = effectiveProductionDateKey(a);
    const dB = effectiveProductionDateKey(b);
    if (dA !== dB) return dB.localeCompare(dA);
    return (b.prio || 0) - (a.prio || 0);
  });
  return pool[0];
}

// Dynamic profit rate using positional changeover cost.
function calculateProfitRate(order, prevOrder, changeoverRules, line) {
  const margin = parseFloat(order._margin) || 0;
  const prodHours = calcProductionHoursOnly(order, line);
  const coHours = prevOrder
    ? (parseFloat(calculateChangeoverBetween(prevOrder, order, changeoverRules)) || 0)
    : 0;
  const totalHours = prodHours + coHours;
  if (totalHours <= 0) return 0;
  return margin / totalHours;
}

// ─── Profit candidate-date scorer ─────────────────────────────────────────
//
// Signals (in descending importance):
//   1. Profit rate × 20  — primary objective
//   2. Light day load    — secondary (avoids overloading a single day)
//   3. Compatibility     — tertiary (fewer changeovers when grouped)
//   4. Mild earliness    — quaternary (prefer sooner within safe window)
//   5. Overload penalty  — negative guard
function scoreProfitCandidateDate(order, candidateDate, line, orders, dailyLoadMap, changeoverRules) {
  let score = 0;
  const load = dailyLoadMap.get(candidateDate) || { orderCount: 0, totalHours: 0 };

  // 1. Profit rate — main signal
  const prevOrder = findNearestPreviousOrderOnOrBeforeDate(order, candidateDate, orders);
  const profitRate = calculateProfitRate(order, prevOrder, changeoverRules, line);
  score += profitRate * 20;

  // 2. Prefer lighter-loaded days
  score += Math.max(0, 12 - load.totalHours) * 3;
  score += Math.max(0, 4 - load.orderCount) * 1.5;

  // 3. Reward material compatibility / lower changeover cost
  score += estimateCompatibilityGain(order, candidateDate, orders, changeoverRules) * 8;

  // 4. Mild preference for earlier dates within the next 20 days
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const candidate = new Date(candidateDate);
  candidate.setHours(0, 0, 0, 0);
  const daysFromToday = Math.round((candidate - today) / (1000 * 60 * 60 * 24));
  score += Math.max(0, 20 - daysFromToday) * 0.75;

  // 5. Penalize overloaded days
  if (load.totalHours > 16) score -= 20;
  if (load.totalHours > 20) score -= 30;

  return score;
}

function chooseBestProfitDate(order, line, orders, safeWindow, dailyLoadMap, changeoverRules) {
  const candidates = enumerateDates(safeWindow.start, safeWindow.end);
  let bestDate = safeWindow.start;
  let bestScore = -Infinity;
  for (const d of candidates) {
    const s = scoreProfitCandidateDate(order, d, line, orders, dailyLoadMap, changeoverRules);
    if (s > bestScore) {
      bestScore = s;
      bestDate = d;
    }
  }
  return bestDate;
}

// ─── Profit date heuristic ─────────────────────────────────────────────────
//
// Same structure as applyBalancedDateHeuristic, but:
//   • Flexible orders are processed in descending _profitRate order (Margin ÷
//     Runtime-Hours pre-calculated by enrichWithMargin) so high-value orders
//     claim the best early slots before lower-value ones compete.
//   • Date scoring uses scoreProfitCandidateDate which factors in dynamic
//     changeover costs via the actual preceding order.
//   • Ends with the same chronological sort as Balanced.
function applyProfitDateHeuristic(ordersByLine, inferredTargetMap = {}, changeoverRules = null) {
  const result = {};
  for (const [line, orders] of Object.entries(ordersByLine)) {
    if (!orders || orders.length === 0) {
      result[line] = [];
      continue;
    }

    const dailyLoadMap = buildDailyLoadMap(orders, line);

    // Protected orders (MTO, Critical, Urgent, Monitor) keep their AI-clamped dates.
    // Flexible orders are sorted by _profitRate DESC so the highest-value orders
    // pick their preferred dates first.
    const protectedOrders = orders.filter(o => isProtectedOrder(o));
    const flexibleOrders  = orders
      .filter(o => !isProtectedOrder(o))
      .sort((a, b) => (parseFloat(b._profitRate) || 0) - (parseFloat(a._profitRate) || 0));

    for (const o of flexibleOrders) {
      const safeWindow = getBalancedSafeWindow(o, inferredTargetMap);
      const oldDate = effectiveProductionDateKey(o);
      const newDate = chooseBestProfitDate(o, line, orders, safeWindow, dailyLoadMap, changeoverRules);
      if (!/^\d{4}-\d{2}-\d{2}/.test(newDate) || newDate === oldDate) continue;

      // Update load map incrementally so subsequent lower-value orders see the
      // actual remaining capacity after this order's placement.
      const hours = orderProductionHours(o, line);
      if (oldDate !== '9999-99-99' && dailyLoadMap.has(oldDate)) {
        const b = dailyLoadMap.get(oldDate);
        b.orderCount = Math.max(0, b.orderCount - 1);
        b.totalHours = Math.max(0, b.totalHours - hours);
      }
      if (!dailyLoadMap.has(newDate)) dailyLoadMap.set(newDate, { orderCount: 0, totalHours: 0 });
      const nb = dailyLoadMap.get(newDate);
      nb.orderCount += 1;
      nb.totalHours += hours;

      o._aiSuggestedDate = newDate;
      o._aiSuggestedDateIsFlexible = true;
      o._profitHeuristicApplied = true;
      if (!o._aiReasoning) {
        const rate    = ((parseFloat(o._profitRate) || 0)).toFixed(1);
        const margin  = ((parseFloat(o._margin)     || 0)).toFixed(1);
        const sigText = AI_PROFITABILITY_BASIS === 'margin' ? `margin ${margin}%` : `profit score ${rate}`;
        o._aiReasoning = `Profit heuristic chose ${newDate} (${sigText}) — higher ${AI_PROFITABILITY_LABEL_LOWER} orders placed first`;
      }
    }

    // Final sort: chronological-first, same tiebreakers as Balanced
    const allOrders = [...protectedOrders, ...flexibleOrders];
    const sorted = sortOrdersChronologicallyWithBalancedTieBreak(allOrders);
    sorted.forEach((o, i) => { o.prio = i + 1; });
    result[line] = sorted;
  }
  return result;
}

// ─── Capacity-aware best-fit daily packing for flexible MTS orders ─────────
//
// Enhancement layer applied AFTER applyAISequenceToOrders resolves
// _aiSuggestedDate. Upgrades the previous greedy earliest-fit approach to
// a scored best-fit: for each flexible order, ALL candidate days in its safe
// window are scored and the highest-scoring day is chosen.
//
// Day score = fillWeight × fillScore + compatWeight × compatScore
//   • fillScore  = (usedHours + orderHours) / 24  — prefers days that get
//                  close to full (denser packing, fewer lightly-used days)
//   • compatScore = normalised estimateCompatibilityGain / 4 — rewards
//                  placing orders alongside compatible materials to reduce CO
//   • fillWeight / compatWeight come from 3-D priority:
//       MTS primary                    → 0.75 / 0.25  (fill dominates)
//       Changeover primary             → 0.35 / 0.65  (compat dominates)
//       Both secondary or unspecified  → 0.55 / 0.45  (balanced)
//
// Processing order: narrowest safe window first (most constrained), then
// largest order first (fills anchor-days before smaller orders pile up).
//
// Protected orders (MTO / Critical / Urgent / Monitor) are seeded as anchors
// and never moved. +14-day later-than-target window applies to MTS Sufficient
// only (already enforced by getBalancedSafeWindow).
//
// Only fires when 3-D analysis indicates MTS flexibility is justified.
//
// Emits: [AI Best-Fit Day Packing] per order (day evaluation) and
//        [AI Date Suggestion Enhancement] per final assignment.
//
// Returns the same array with _aiSuggestedDate potentially updated.
function applyCapacityAwarePacking(
  orders,
  line,
  inferredTargetMap,
  mtsConsideration,
  emphasis,
  strategyTitle,
  changeoverRules,
) {
  if (!orders || orders.length === 0) return orders;

  // ── Guard: only run when 3-D analysis justifies MTS flexibility ───────────
  const mtsDeprioritized = Array.isArray(emphasis?.deprioritized)
    ? emphasis.deprioritized.some(d => /^mts/i.test(String(d)))
    : /^mts/i.test(String(emphasis?.deprioritized || ''));
  const mtsPrimary   = emphasis?.primary   === 'mts';
  const mtsSecondary = emphasis?.secondary === 'mts';
  const coPrimary    = emphasis?.primary   === 'changeover';
  const coSecondary  = emphasis?.secondary === 'changeover';
  const mtsRelevance = parseFloat(mtsConsideration?.relevance) || 0;
  const mtsFlexJustified = !mtsDeprioritized && (mtsPrimary || mtsSecondary || mtsRelevance >= 0.4);
  if (!mtsFlexJustified) {
    console.debug('[AI Date Suggestion Enhancement] Skipping capacity packing — MTS not justified by 3-D analysis', {
      strategyTitle,
      primary:       emphasis?.primary || null,
      secondary:     emphasis?.secondary || null,
      deprioritized: emphasis?.deprioritized,
      mtsRelevance,
    });
    return orders;
  }

  // ── 3-D priority weights ──────────────────────────────────────────────────
  // fillWeight   → importance of utilization density per day
  // compatWeight → importance of changeover compatibility within a day
  let fillWeight, compatWeight;
  if (mtsPrimary) {
    fillWeight = 0.75; compatWeight = 0.25;
  } else if (coPrimary) {
    fillWeight = 0.35; compatWeight = 0.65;
  } else if (mtsSecondary && coSecondary) {
    fillWeight = 0.50; compatWeight = 0.50;
  } else {
    fillWeight = 0.55; compatWeight = 0.45;
  }

  const runRate   = getLineRunRate(line);
  const DAILY_CAP = 24;

  // ── Daily bucket: { usedHours, orders[] } — tracks both load and residents ─
  const dailyBucket = new Map();
  const ensureDay = (d) => {
    if (!dailyBucket.has(d)) dailyBucket.set(d, { usedHours: 0, orders: [] });
  };

  // Seed from protected anchors (immovable)
  for (const o of orders) {
    if (!isProtectedOrder(o)) continue;
    const d = effectiveProductionDateKey(o);
    if (d === '9999-99-99') continue;
    ensureDay(d);
    const vol     = parseFloat(o.volume_override || o.volume || o.total_volume_mt || 0) || 0;
    const prodHrs = runRate > 0 ? vol / runRate : 0;
    const coHrs   = parseFloat(o._changeoverTotal ?? o.changeover_time ?? 0) || 0;
    const bkt = dailyBucket.get(d);
    bkt.usedHours += prodHrs + coHrs;
    bkt.orders.push(o);
  }

  // ── Normalised compat score (0–1) ─────────────────────────────────────────
  // estimateCompatibilityGain returns [0,4] (4 = identical material). Divide by 4.
  const getCompatScore = (order, candidateDate) => {
    const gain = estimateCompatibilityGain(order, candidateDate, orders, changeoverRules || null);
    return Math.max(0, Math.min(4, gain)) / 4;
  };

  // ── Scored day evaluator ──────────────────────────────────────────────────
  // Returns -Infinity if the order doesn't fit; otherwise a weighted score.
  const scoreDayForOrder = (order, candidateDate, orderHours) => {
    const bkt  = dailyBucket.get(candidateDate) || { usedHours: 0 };
    const used = bkt.usedHours;
    if (used + orderHours > DAILY_CAP) return -Infinity;
    const fillAfter = (used + orderHours) / DAILY_CAP; // 0–1
    const compat    = getCompatScore(order, candidateDate);   // 0–1
    return fillAfter * fillWeight + compat * compatWeight;
  };

  // ── Sort: narrowest safe window first, then largest order ─────────────────
  // Most-constrained first ensures they claim their preferred days before
  // orders with wider windows fill them up.
  const flexOrders = orders
    .filter(o => !isProtectedOrder(o))
    .sort((a, b) => {
      const swA  = getBalancedSafeWindow(a, inferredTargetMap);
      const swB  = getBalancedSafeWindow(b, inferredTargetMap);
      const daysA = enumerateDates(swA.start, swA.end).length;
      const daysB = enumerateDates(swB.start, swB.end).length;
      if (daysA !== daysB) return daysA - daysB;
      return orderProductionHours(b, line) - orderProductionHours(a, line); // larger first
    });

  for (const o of flexOrders) {
    const vol           = parseFloat(o.volume_override || o.volume || o.total_volume_mt || 0) || 0;
    const prodHrs       = runRate > 0 ? vol / runRate : 0;
    const coHrs         = parseFloat(o._changeoverTotal ?? o.changeover_time ?? 0) || 0;
    const orderHours    = prodHrs + coHrs;

    const urgencyClass           = o._n10dStatus || 'Sufficient';
    const canMoveLaterUpTo14Days = !FIRM_STATUSES.has(o._n10dStatus);
    const originalTargetDate     = getEffectiveAvailISO(o, inferredTargetMap || {}) || null;
    const safeWindow             = getBalancedSafeWindow(o, inferredTargetMap);
    const oldDate                = effectiveProductionDateKey(o);

    // ── Best-fit: score every candidate day, pick the highest ────────────────
    const candidates = enumerateDates(safeWindow.start, safeWindow.end);
    let bestDate  = null;
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      ensureDay(candidate);
      const s = scoreDayForOrder(o, candidate, orderHours);
      if (s > bestScore) { bestScore = s; bestDate = candidate; }
    }
    // Fallback: safe window end (every day overflows — order larger than 24h).
    if (!bestDate || bestScore === -Infinity) bestDate = safeWindow.end;

    const bktBefore = dailyBucket.get(bestDate) || { usedHours: 0, orders: [] };
    const assignedDayUsedHours = bktBefore.usedHours;

    // ── Debug: best-fit day evaluation ────────────────────────────────────────
    console.debug('[AI Best-Fit Day Packing]', {
      strategyId:          o._aiStrategyId || null,
      title:               strategyTitle,
      mtsPriority:         mtsPrimary ? 'primary' : mtsSecondary ? 'secondary' : 'not_active',
      changeoverPriority:  coPrimary  ? 'primary' : coSecondary  ? 'secondary' : 'not_active',
      candidateDay:        bestDate,
      candidateOrders:     bktBefore.orders.map(co => ({
        orderId:            co.id,
        item:               (co.item_description || '').substring(0, 40),
        productionHours:    parseFloat(co.production_hours) || 0,
        estimatedChangeover: parseFloat(co._changeoverTotal ?? co.changeover_time ?? 0) || 0,
        targetDate:         getEffectiveAvailISO(co, inferredTargetMap) || null,
        suggestedDate:      co._aiSuggestedDate || null,
        orderType:          isMTO(co) ? 'MTO' : 'MTS',
        urgencyClass:       co._n10dStatus || 'Sufficient',
        stockStatus:        co._n10dStatus || 'Sufficient',
      })),
      chosenCombination:   [o.id],
      usedHoursAfterPacking: assignedDayUsedHours + orderHours,
      capacityLimit:       DAILY_CAP,
      selectionReason:     'best_fit_with_3d_priority_tiebreak',
    });

    // ── Update bucket (remove old slot, add to new) ───────────────────────────
    if (oldDate !== '9999-99-99' && dailyBucket.has(oldDate)) {
      const old = dailyBucket.get(oldDate);
      old.usedHours = Math.max(0, old.usedHours - orderHours);
      old.orders    = old.orders.filter(x => String(x.id) !== String(o.id));
    }
    ensureDay(bestDate);
    const nb = dailyBucket.get(bestDate);
    nb.usedHours += orderHours;
    nb.orders.push(o);

    // ── Apply date ────────────────────────────────────────────────────────────
    const fitStatus = bestDate === oldDate ? 'fit_current_day' : 'moved_to_next_day';
    if (bestDate !== oldDate) {
      o._aiSuggestedDate           = bestDate;
      o._aiSuggestedDateIsFlexible = true;
      o._capacityPackingApplied    = true;
      if (!o._aiReasoning) {
        const fillPct = ((assignedDayUsedHours + orderHours) / DAILY_CAP * 100).toFixed(0);
        o._aiReasoning = `Best-fit packing: placed on ${bestDate} — ${fillPct}% of 24 h cap used`;
      }
    }

    console.debug('[AI Date Suggestion Enhancement]', {
      orderId:                 o.id,
      item:                    (o.item_description || '').substring(0, 50),
      originalTargetDate,
      suggestedDate:           bestDate,
      orderType:               isMTO(o) ? 'MTO' : 'MTS',
      urgencyClass,
      stockStatus:             urgencyClass,
      mtsEligibleForFlex:      true,
      canMoveLaterUpTo14Days,
      assignedDayUsedHours,
      assignedDayCapacity:     DAILY_CAP,
      productionHours:         prodHrs,
      changeoverHoursAssigned: coHrs,
      fitStatus,
      strategyTitle,
    });
  }

  return orders;
}

// ─── Plant-wide AI strategy generator ──────────────────────────────────────
//
// One AI call generates BOTH alternative strategies (names, themes,
// descriptions, reasoning, and per-line orderings). Hard constraints are
// enforced afterwards via applyAISequenceToOrders (safe-window clamp), so
// any unsafe AI suggestion is repaired before being shown to the user.

const STRATEGY_VISUALS = [
  { icon: '', color: 'purple' },
  { icon: '', color: 'green' },
];

function buildPlantwideStrategyPrompt({ ordersByLine, changeoverRules, inferredTargetMap }) {
  const allOrders = Object.values(ordersByLine).flat();
  const N10D_URGENCY = { Critical: 1, Urgent: 2, Monitor: 3, Flexible: 4 };

  const orderDetails = allOrders.map(o => {
    const effectiveAvail = getEffectiveAvailISO(o, inferredTargetMap) || null;
    const _today0 = new Date(); _today0.setHours(0, 0, 0, 0);
    const _todayISO = _toLocalISO(_today0);
    let n10d_days_remaining = 999;
    if (effectiveAvail) {
      const deadline = new Date(effectiveAvail);
      n10d_days_remaining = Math.max(0, Math.ceil((deadline - _today0) / 86400000));
    }
    const mto = isMTO(o);
    const critical = isCritical(o);
    const urgent = o._n10dStatus === 'Urgent';
    const monitor = o._n10dStatus === 'Monitor';
    const flexible = !mto && !critical && !urgent && !monitor;

    const isOriginalDateOverdue = !!(effectiveAvail && effectiveAvail < _todayISO);
    const aiAnchorDate = resolveAISchedulingAnchor(effectiveAvail, _todayISO);
    if (isOriginalDateOverdue) {
      console.debug('[AI Overdue Date Rollforward]', {
        orderId: o.id,
        originalAvailDate: effectiveAvail,
        currentSchedulingDate: _todayISO,
        isOriginalDateOverdue: true,
        effectiveAiSchedulingDate: aiAnchorDate,
        strategyTitle: 'buildPlantwideStrategyPrompt',
      });
    }

    let safe_window_end = isOriginalDateOverdue && !flexible ? aiAnchorDate : effectiveAvail;
    if (flexible) {
      if (effectiveAvail) {
        const d = new Date(effectiveAvail); d.setDate(d.getDate() + 14);
        safe_window_end = d.toISOString().substring(0, 10);
      } else {
        const d = new Date(); d.setDate(d.getDate() + 24);
        safe_window_end = d.toISOString().substring(0, 10);
      }
    }
    return {
      id: o.id,
      line: o.feedmill_line,
      description: (o.item_description || '').substring(0, 60),
      volume: parseFloat(o.volume || o.total_volume_mt || 0) || 0,
      current_avail_date: aiAnchorDate || o.target_avail_date || null,
      safe_window_end,
      n10d_days_remaining,
      future_dispatch_status: o._n10dStatus || 'Flexible',
      urgency_rank: mto ? 1 : (N10D_URGENCY[o._n10dStatus] ?? 4),
      is_mto: mto,
      is_critical: critical,
      is_urgent: urgent,
      is_monitor: monitor,
      is_flexible: flexible,
      margin: parseFloat(o._margin) || 0,
      profit_score: o._profitRate != null ? parseFloat(o._profitRate.toFixed(3)) : 0,
      production_hours: parseFloat(o.production_hours) || 0,
      changeover_hours: parseFloat(o._changeoverTotal ?? o.changeover_time ?? 0) || 0,
      color: o.color || null,
      diameter: o.diameter || null,
      category: o.category || null,
      form: o.form || null,
    };
  });

  const lineSummary = Object.entries(ordersByLine)
    .map(([l, os]) => `${l}: ${os.length}`).join(', ');
  const countCritical = allOrders.filter(o => isCritical(o)).length;
  const countUrgent = allOrders.filter(o => o._n10dStatus === 'Urgent').length;
  const countMonitor = allOrders.filter(o => o._n10dStatus === 'Monitor').length;
  const countSufficient = allOrders.filter(o => !isMTO(o) && !isCritical(o) && o._n10dStatus !== 'Urgent' && o._n10dStatus !== 'Monitor').length;
  const countMTO = allOrders.filter(isMTO).length;

  const dynamicChangeoverSection = buildDynamicChangeoverPromptSection(
    changeoverRules || getFallbackChangeoverRules()
  );

  const todayISO = _toLocalISO(new Date());
  const earliest = (() => { const d = new Date(); d.setDate(d.getDate() + 2); return _toLocalISO(d); })();

  const systemPrompt = `You are an AI production scheduler for a feed manufacturing plant. Your role is to analyse the current plant-wide lineup and propose TWO distinct, plant-wide sequencing strategies. Every strategy must respect hard deadline rules — schedule safety always overrides optimisation. Respond ONLY with valid JSON.`;

  const userPrompt = `The current plant-wide lineup has already gone through (1) cross-line combination, (2) line assignment by queue time, and (3) future dispatch date enrichment. Your job is to propose exactly TWO alternative plant-wide sequencing strategies for this lineup.

CURRENT ORDERS (${allOrders.length} total — Critical: ${countCritical} | Urgent: ${countUrgent} | Monitor: ${countMonitor} | Sufficient: ${countSufficient} | MTO: ${countMTO}):
Lines: ${lineSummary}

⚠ Use the EXACT line key names shown above (e.g. "Line 1") as keys in each strategy's "orders" map.
Every order_id below must appear exactly once per strategy with a suggested_date.

${JSON.stringify(orderDetails, null, 2)}

${dynamicChangeoverSection}

════════════════════════════════════════════
HARD RULES — apply to BOTH strategies; non-negotiable.
════════════════════════════════════════════
RULE 1 — DEADLINE PROTECTION
  • is_mto: true               → suggested_date = current_avail_date verbatim (immutable contract). Position by date.
  • future_dispatch_status "Critical"     → suggested_date = TODAY (${todayISO}). Pin to position 1 in line.
  • is_urgent or is_monitor    → may move EARLIER but NEVER later than current_avail_date (HARD ceiling).
  • is_flexible (Sufficient)   → free to move within [today+2 = ${earliest}, safe_window_end].
RULE 2 — NO CROSS-LINE MOVES.
RULE 3 — EVERY order_id appears exactly once per strategy, on its assigned line.

════════════════════════════════════════════
STRATEGY DESIGN
════════════════════════════════════════════
Invent TWO truly distinct strategies based on what THIS lineup actually needs. Do NOT use generic names like "Balanced" or "Profit-Optimized" unless the lineup truly justifies them — invent specific names that describe the actual sequencing idea you are applying.

Examples of valid distinct focuses (you may pick different ones):
  • Cluster compatible materials to reduce total changeover hours
  • Advance higher profit-score flexible orders into earlier safe slots
  • Spread load more evenly across days to reduce overload risk
  • Front-load risky/older orders to maximise schedule slack
  • Improve continuity across lines while preserving protected deadlines

The two strategies MUST be meaningfully different in their sequencing focus. They must not be near-duplicates of each other.

For EACH strategy, return:
  • strategy_name              — your invented name (3-5 words)
  • subtitle                   — short tag like "AI-generated strategy"
  • short_description          — one sentence (≤ 140 chars) describing what the strategy does
  • reasoning_summary          — 2-3 sentences explaining why this approach helps THIS lineup
  • orders                     — { "Line 1": [{ order_id, position, suggested_date }], "Line 2": [...] }
  • optional dateAdjustments   — array of notable date moves with order_id + original + new + reason

PROFIT SCORE (use only when your strategy emphasises profitability):
  Profit Score = Margin ÷ (Production Hours + Changeover Hours).
  Higher = more margin per total machine-hour consumed.

RESPONSE FORMAT — JSON only, no markdown, no commentary:
{
  "strategies": [
    {
      "strategy_id": "ai_option_1",
      "strategy_name": "...",
      "subtitle": "AI-generated strategy",
      "short_description": "...",
      "reasoning_summary": "...",
      "orders": {
        "Line 1": [
          { "order_id": "xxx", "position": 1, "suggested_date": "${earliest}" }
        ]
      },
      "dateAdjustments": []
    },
    {
      "strategy_id": "ai_option_2",
      "strategy_name": "...",
      "subtitle": "AI-generated strategy",
      "short_description": "...",
      "reasoning_summary": "...",
      "orders": { "Line 1": [ ... ] },
      "dateAdjustments": []
    }
  ]
}`;

  return { systemPrompt, userPrompt };
}

// Tolerant parser — handles direct JSON, fenced blocks, and greedy {...}
// extraction. Always returns { strategies: [...] } (possibly empty).
function parsePlantwideStrategyResponse(content) {
  if (!content || typeof content !== 'string') return { strategies: [] };
  const tryParseStrategies = (txt) => {
    try {
      const obj = JSON.parse(txt);
      if (obj && Array.isArray(obj.strategies)) return obj.strategies;
    } catch (_) { /* fall through */ }
    return null;
  };
  let arr = tryParseStrategies(content);
  if (arr) return { strategies: arr };
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    arr = tryParseStrategies(fence[1]);
    if (arr) return { strategies: arr };
  }
  const greedy = content.match(/\{[\s\S]*\}/);
  if (greedy) {
    arr = tryParseStrategies(greedy[0]);
    if (arr) return { strategies: arr };
  }
  console.error('[aiSequenceStrategies] plantwide parse failed (length=', content.length, ', preview=', content.slice(0, 200), ')');
  return { strategies: [] };
}

// Detects whether a strategy's reasoning emphasises profit/margin so
// downstream insight generation can apply the strict profit-score formula
// rules only when the strategy actually claims to optimise for profit.
function _strategyEmphasizesProfit(meta) {
  // Per-line AI strategies now carry an explicit `distinctFocus` tag (e.g.
  // "Profit advancement", "Changeover reduction"). When present, prefer it
  // — it's a much cleaner signal than regex-matching the long-form name +
  // description + reasoning. Fall back to the original name/description/
  // reasoning regex only when distinctFocus is missing (legacy / plant-wide
  // strategies). This keeps the service-side insight generation aligned
  // with the modal-side dispatcher (`_aiStrategyEmphasizesProfit`).
  const focus = String(meta?.distinctFocus || '').toLowerCase();
  if (focus) return /profit|margin|profitabil/.test(focus);
  const text = `${meta?.name || ''} ${meta?.description || ''} ${meta?.reasoningSummary || ''}`.toLowerCase();
  return /\bprofit\b|\bmargin\b|profitabil/.test(text);
}

function buildFailedAIStrategyShell(slotIndex, reason = 'AI strategy generation failed') {
  const slot = slotIndex === 0 ? 'ai_option_1' : 'ai_option_2';
  const visuals = STRATEGY_VISUALS[slotIndex] || STRATEGY_VISUALS[0];
  return {
    id: slot,
    name: 'AI Strategy Unavailable',
    theme: 'AI-generated strategy',
    description: 'AI could not generate this strategy for the current lineup.',
    icon: visuals.icon,
    color: visuals.color,
    reasoningSummary: reason,
    aiReasoning: reason,
    orders: {},
    metrics: calculateStrategyMetrics({}),
    dateAdjustments: [],
    isAIRecommended: false,
    isAI: true,
    isAIGenerated: true,
    aiFailed: true,
    sourceType: 'ai_generated',
  };
}

function applyPlantwideAIStrategy(aiStrategy, enrichedOrdersByLine, inferredTargetMap, changeoverRules, slotIndex) {
  const slot = slotIndex === 0 ? 'ai_option_1' : 'ai_option_2';
  const visuals = STRATEGY_VISUALS[slotIndex] || STRATEGY_VISUALS[0];

  // Required AI-generated metadata: strategy_name, reasoning_summary, and a
  // non-empty per-line orders map. Silently substituting fallbacks for these
  // would mask malformed AI output — the spec is clear that names/themes/
  // reasoning must come from the AI itself, so a missing field fails the slot.
  const name = String(aiStrategy?.strategy_name || '').trim();
  const reasoningSummary = String(aiStrategy?.reasoning_summary || '').trim();
  const ordersMap = aiStrategy?.orders;
  if (!name) {
    return buildFailedAIStrategyShell(slotIndex, 'AI strategy missing required strategy_name');
  }
  if (!reasoningSummary) {
    return buildFailedAIStrategyShell(slotIndex, 'AI strategy missing required reasoning_summary');
  }
  if (!ordersMap || typeof ordersMap !== 'object' || Object.keys(ordersMap).length === 0) {
    return buildFailedAIStrategyShell(slotIndex, 'AI strategy returned no per-line orders');
  }
  // Sanity-check structural alignment with the source plant lineup: at least
  // one line key from the AI response must match a line in the enriched
  // orders, otherwise the safe-window clamp has nothing to apply.
  const enrichedLines = new Set(Object.keys(enrichedOrdersByLine));
  const aiLines = Object.keys(ordersMap).filter(k => enrichedLines.has(k));
  if (aiLines.length === 0) {
    return buildFailedAIStrategyShell(slotIndex, 'AI strategy line keys do not match plant lines');
  }

  // Reuse the existing safe-window clamp + date validation pipeline by
  // adapting the AI's response into the legacy { strategy: {...} } shape.
  const aiResult = {
    strategy: ordersMap,
    reasoning: reasoningSummary,
    dateAdjustments: aiStrategy.dateAdjustments || [],
  };

  let ordersAfter;
  try {
    ordersAfter = applyAISequenceToOrders(
      aiResult,
      enrichedOrdersByLine,
      inferredTargetMap,
      { skipClustering: true },
    );
  } catch (err) {
    console.error(`[aiSequenceStrategies] applying ${slot} failed:`, err);
    return buildFailedAIStrategyShell(slotIndex, `Could not apply AI strategy: ${err.message || err}`);
  }

  // After the safe-window clamp, every order must still be present on its
  // assigned line. If the resulting orders map is empty (no lines with any
  // orders), the AI's response was unusable and we surface that as a failure
  // instead of presenting an empty card as if it were a valid strategy.
  const totalAfter = Object.values(ordersAfter || {}).reduce((n, arr) => n + (arr ? arr.length : 0), 0);
  if (totalAfter === 0) {
    return buildFailedAIStrategyShell(slotIndex, 'AI strategy produced no schedulable orders after safe-window clamp');
  }

  const subtitle = String(aiStrategy.subtitle || 'AI-generated strategy').trim();
  const description = String(aiStrategy.short_description || '').trim()
    || 'AI-generated plant-wide sequencing strategy.';

  // Stamp strategy meta on each order so downstream consumers (insight
  // generator, modal-side fallback, render) can show the AI-generated
  // name/reasoning instead of a generic placeholder.
  for (const orders of Object.values(ordersAfter)) {
    for (const o of orders) {
      o._aiStrategyId = slot;
      o._aiStrategyName = name;
      o._aiStrategyReasoning = reasoningSummary;
    }
  }

  return {
    id: slot,
    name,
    theme: subtitle,
    description,
    icon: visuals.icon,
    color: visuals.color,
    reasoningSummary,
    aiReasoning: reasoningSummary,
    orders: ordersAfter,
    metrics: calculateStrategyMetrics(ordersAfter),
    dateAdjustments: aiResult.dateAdjustments,
    isAIRecommended: false,
    isAI: true,
    isAIGenerated: true,
    aiFailed: false,
    sourceType: 'ai_generated',
  };
}

// ─── Recommendation logic — AI strategies only ────────────────────────────
// Standard Sequence is NEVER recommended (per spec §12). Among the two AI
// strategies, weighted score (per Prompt_1777523216167 §14): 30% slack,
// 20% risk, 15% optimisation, 10% profitability, 25% faithfulness.
// Eligibility: not failed, zero violations, ≥1.5h slack, AND
// faithfulnessScore >= 60 when scored.
function determineAIRecommendation(strategies) {
  if (strategies.rule_based) strategies.rule_based.isAIRecommended = false;

  const candidates = ['ai_option_1', 'ai_option_2']
    .map(id => strategies[id])
    .filter(s => s && !s.aiFailed && s.metrics);
  // Per spec §12 + §15: eligibility requires violations==0 AND finite slack
  // >= 1.5h AND (when scored) faithfulnessScore >= 60. A strategy whose
  // After table does not visibly act on its declared goal must not be
  // recommended even if its other metrics look strong.
  const eligible = candidates.filter(s => {
    if ((s.metrics.violations || 0) > 0) return false;
    const slack = parseFloat(s.metrics.minSlackHours);
    if (!Number.isFinite(slack) || slack < 1.5) return false;
    const faith = s.metrics.faithfulnessScore;
    if (faith != null && Number.isFinite(faith) && faith < 60) return false;
    return true;
  });
  if (eligible.length === 0) return null;

  const slacks = eligible.map(s => parseFloat(s.metrics.minSlackHours));
  const maxSlack = Math.max(...slacks, 0.0001);
  const riskRank = { Low: 1.0, Medium: 0.66, High: 0.33, Violated: 0 };
  const optMoves = eligible.map(s => s.metrics.mtsAdjusted || 0);
  const maxMoves = Math.max(...optMoves, 1);
  const margins = eligible.map(s => parseFloat(s.metrics.totalMargin) || 0);
  const maxMargin = Math.max(...margins, 0.0001);

  let best = eligible[0];
  let bestScore = -Infinity;
  eligible.forEach((s, i) => {
    const slackScore = slacks[i] / maxSlack;
    const riskScore = riskRank[s.metrics.riskLevel || 'Low'] ?? 0.5;
    const optScore = optMoves[i] / maxMoves;
    const profitScore = margins[i] / maxMargin;
    // Faithfulness contributes its 0..100 score scaled to 0..1. Strategies
    // that pre-date the scorer (or fall back to "faithful by default") get
    // a neutral 0.75 so they don't lose ground to scored-but-mediocre peers.
    const faithRaw = s.metrics.faithfulnessScore;
    const faithScore = (faithRaw != null && Number.isFinite(faithRaw)) ? (faithRaw / 100) : 0.75;
    const score = 0.30 * slackScore + 0.20 * riskScore + 0.15 * optScore
      + 0.10 * profitScore + 0.25 * faithScore;
    if (score > bestScore) { bestScore = score; best = s; }
  });
  best.isAIRecommended = true;
  return best.id;
}

// ─── Strategy-specific AI Insight Generation ──────────────────────────────

function _siGetProtectedReason(order) {
  if (isMTO(order)) return 'MTO';
  // Status may live in any of several fields depending on which pipeline
  // produced the order. Normalise (trim + lowercase) so we never miss a
  // protected order due to a casing or whitespace variant.
  const raw = order._n10dStatus
    || order.n10dStatus
    || order._dateCategory
    || order.dateCategory
    || order.inferred_target_label
    || '';
  const st = String(raw).trim().toLowerCase();
  if (st === 'critical') return 'Critical';
  if (st === 'urgent') return 'Urgent';
  if (st === 'monitor') return 'Monitor';
  if (st.includes('prio replenish')) return 'Prio Replenish';
  return null;
}

// Read the SAME production-hours value the After-table row displays.
// Row source of truth: order.production_hours (set by the sequencing pipeline).
// Fall back to other field aliases, then to volume / run-rate computation.
function getDisplayedProductionHours(order, line) {
  const candidates = [
    order.production_hours,
    order.production_time,
    order._productionTimeHrs,
  ];
  // Accept 0 as a legitimate displayed value — only fall back when the row
  // genuinely has no value at all (null / undefined / empty / unparseable).
  for (const c of candidates) {
    if (c == null || c === '') continue;
    const n = parseFloat(c);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  return calcProductionHoursOnly(order, line) || 0;
}

// Read the SAME changeover value the After-table row displays.
//
// Row semantics (from applyPreviewChangeovers in PlantAutoSequenceModal.jsx):
//   _changeoverTotal = base + additional_to_NEXT_order
// i.e. the changeover for an order is its OUTGOING cost — the work needed
// AFTER it finishes to switch to whatever comes next. The last order in a
// run has no outgoing changeover (= 0).
//
// At strategy-build time _changeoverTotal is typically NOT yet populated
// (the modal sets it later via applyPreviewChangeovers). To match what the
// row will display we replicate the same formula here using the live rules.
function getDisplayedChangeoverHours(order, nextOrder, changeoverRules) {
  // 1) Prefer any row-stored TOTAL (these fields always represent the same
  //    "outgoing total" the row displays). Note: order.changeover_time is
  //    intentionally NOT in this list — it is the base-only value and would
  //    short-circuit us to e.g. 0.17 instead of the real row total like 0.83.
  const candidates = [
    order._changeoverTotal,
    order._effectiveChangeover,
    order.changeover,
    order._changeoverHrs,
  ];
  for (const c of candidates) {
    if (c == null || c === '') continue;
    const n = parseFloat(c);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  // 2) Last order in the run: no outgoing changeover (matches the row).
  if (!nextOrder) return 0;
  // 3) Replicate applyPreviewChangeovers: base + additional_to_next
  const base = parseFloat(order.changeover_time);
  const safeBase = Number.isNaN(base) ? 0.17 : base;
  const { total: additional } = calculateAdditionalChangeover(order, nextOrder, changeoverRules || []);
  return parseFloat((safeBase + additional).toFixed(3));
}

// Distinguish "true zero margin" from "margin not found in master data".
// Honours the explicit _marginFound flag set by enrichWithMargin /
// ensureMarginPresent so a legitimate 0 margin is not mistaken for missing
// data, and a missing lookup is not mistaken for "true zero".
function getMarginStatus(order) {
  if (order._marginFound === true) {
    const parsed = parseFloat(order._margin);
    return { margin: Number.isNaN(parsed) ? 0 : parsed, marginFound: true };
  }
  if (order._marginFound === false) {
    return { margin: 0, marginFound: false };
  }
  // Flag absent → fall back to inspecting the raw value.
  const raw = order._margin ?? order.margin;
  if (raw == null || raw === '') return { margin: 0, marginFound: false };
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed)) return { margin: 0, marginFound: false };
  return { margin: parsed, marginFound: true };
}

function calculateDisplayedProfitRate({ margin, productionHours, changeoverHours }) {
  const total = (parseFloat(productionHours) || 0) + (parseFloat(changeoverHours) || 0);
  if (total <= 0) return 0;
  return (parseFloat(margin) || 0) / total;
}

// Sanity-check the context just before sending to the AI so the formula the
// AI will repeat back is mathematically consistent with the numbers given.
function validateProfitInsightContext(ctx) {
  const total = (ctx.productionHours || 0) + (ctx.changeoverHours || 0);
  const expected = total > 0 ? Number(((ctx.margin || 0) / total).toFixed(2)) : 0;
  if (Math.abs(expected - (ctx.profitScore || 0)) > 0.01) {
    console.warn('[Profit Insight] Profit score mismatch — correcting', {
      order_id: ctx.order_id,
      margin: ctx.margin,
      productionHours: ctx.productionHours,
      changeoverHours: ctx.changeoverHours,
      ctxProfitScore: ctx.profitScore,
      expectedProfitScore: expected,
    });
    ctx.profitScore = expected;
  }
  return ctx;
}

// Defensive: re-enrich margin from masterData if it's missing on any order.
// Uses the multi-field-alias helper getMarginFromMasterData so the lookup
// works regardless of whether the master-data record uses fg_material_code,
// material_code_fg, or any of the other known aliases. Sets _marginFound
// explicitly so downstream getMarginStatus can distinguish "true zero"
// from "not found in master data".
function ensureMarginPresent(ordersByLine, masterData) {
  if (!masterData || !masterData.length) return ordersByLine;
  const result = {};
  let missCount = 0;
  for (const [line, orders] of Object.entries(ordersByLine)) {
    result[line] = (orders || []).map(order => {
      // If margin already present and explicitly marked as found, keep as-is.
      const existing = parseFloat(order._margin);
      if (order._marginFound === true && !Number.isNaN(existing)) return order;
      const { margin, marginFound, matchedField } = getMarginFromMasterData(order, masterData);
      if (!marginFound) {
        missCount += 1;
        if (missCount <= 5) {
          console.warn('[Margin Lookup] No master-data margin for order', {
            order_id: order.id,
            material_code_fg: order.material_code_fg,
            fg_material_code: order.fg_material_code,
          });
        }
      }
      return {
        ...order,
        _margin: margin,
        _marginFound: marginFound,
        _marginMatchedField: matchedField,
      };
    });
  }
  if (missCount > 5) {
    console.warn(`[Margin Lookup] ${missCount} total orders missing margin (only first 5 logged)`);
  }
  return result;
}

function _siCtx(order, prev, next, strategyMeta, line, lineOrders, index, changeoverRules) {
  const strategyId = strategyMeta?.id || 'rule_based';
  // Use the EXACT values the After-table row displays — never re-estimate.
  const prodHrs = getDisplayedProductionHours(order, line);
  // Outgoing changeover for THIS order (matches what the After-table shows
  // in its CO column = base + additional cost to switch to the next order).
  const coHrs = getDisplayedChangeoverHours(order, next, changeoverRules);
  // Outgoing changeover for the NEXT order (= cost to switch from next to
  // next-next). Used purely as informational context for the AI prompt.
  const nextNext = (lineOrders && index + 2 < lineOrders.length) ? lineOrders[index + 2] : null;
  const nextCoHrs = next
    ? getDisplayedChangeoverHours(next, nextNext, changeoverRules)
    : 0;
  const { margin, marginFound } = getMarginStatus(order);
  const profitScore = calculateDisplayedProfitRate({ margin, productionHours: prodHrs, changeoverHours: coHrs });
  const effectiveAvailDate = order._aiSuggestedDate || order.target_avail_date || null;
  const originalAvailDate = order._originalTargetDate || order.target_avail_date || null;
  const ctx = {
    strategy: strategyId,
    line,
    position: index + 1,
    totalOrders: lineOrders.length,
    order_id: String(order.id),
    item_description: order.item_description,
    category: order.category,
    color: order.color,
    diameter: order.diameter,
    form: order.form,
    materialSignature: getMaterialSignature(order),
    effectiveAvailDate,
    originalAvailDate: effectiveAvailDate !== originalAvailDate ? originalAvailDate : null,
    n10dStatus: order._n10dStatus || '',
    protectedReason: _siGetProtectedReason(order),
    feasibilityReason: order._aiFeasibilityReason || null,
    completionAfterAvail: order._aiCompletionAfterAvail ?? false,
    delayRiskUnresolved: order._aiDelayRiskUnresolved ?? false,
    estimatedStart: order._aiEstimatedStart || null,
    estimatedCompletion: order._aiEstimatedCompletion || null,
    balancedHeuristicApplied: order._balancedHeuristicApplied || false,
    profitHeuristicApplied: order._profitHeuristicApplied || false,
    previousOrder: prev ? {
      order_id: String(prev.id),
      item_description: prev.item_description,
      materialSignature: getMaterialSignature(prev),
      category: prev.category,
      color: prev.color,
    } : null,
    nextOrder: next ? {
      order_id: String(next.id),
      item_description: next.item_description,
      materialSignature: getMaterialSignature(next),
    } : null,
    previousChangeover: Number(coHrs.toFixed(2)),
    nextChangeover: Number(nextCoHrs.toFixed(2)),
    productionHours: Number(prodHrs.toFixed(2)),
    changeoverHours: Number(coHrs.toFixed(2)),
    margin: Number(margin.toFixed(2)),
    marginFound,
    profitScore: Number(profitScore.toFixed(2)),
    strategyName: strategyMeta?.name || strategyId,
    strategyReasoning: strategyMeta?.reasoningSummary || '',
    emphasizesProfit: !!strategyMeta?.emphasizesProfit,
  };
  // Run the profit-formula sanity check only when the chosen strategy
  // actually uses profit/margin reasoning — otherwise the formula is
  // informational, not the basis for placement.
  return strategyMeta?.emphasizesProfit ? validateProfitInsightContext(ctx) : ctx;
}

// Safe deterministic insight when AI generation is missing/unusable.
// Branches by protected status / margin availability and tailors language to
// the specific AI strategy's name, so the user never sees a generic
// boilerplate where a more accurate explanation is possible.
function getFallbackProfitInsight(ctx) {
  const sName = ctx.strategyName || 'this strategy';
  // Feasibility-driven advancement (delay-avoidance / underutilized-day fill)
  // is the strongest known reason — surface it even when AI insight gen fails.
  if (ctx.feasibilityReason) {
    return {
      short: ctx.feasibilityReason.length > 100
        ? ctx.feasibilityReason.substring(0, 97) + '...'
        : ctx.feasibilityReason,
      long: `${ctx.feasibilityReason} This timing-driven advancement was applied by the "${sName}" strategy's feasibility pass.`,
    };
  }
  // Protected orders (MTO / Critical / Urgent / Monitor) are never moved by
  // any AI strategy — say so explicitly instead of attributing the placement
  // to profit/margin or material reasoning.
  if (ctx.protectedReason) {
    return {
      short: `Protected order — held by ${ctx.protectedReason}, not subject to AI reordering.`,
      long: `This order is protected (${ctx.protectedReason}). The "${sName}" strategy does not reorder or change the date of protected orders; it only adjusts Flexible/Sufficient orders within their safe windows.`,
    };
  }
  if (ctx.emphasizesProfit) {
    if (!ctx.marginFound) {
      return {
        short: `Scheduled within the "${sName}" strategy, but margin data is unavailable.`,
        long: `This order is part of the "${sName}" sequence, but no margin value was found in master data for this item. Its placement still respects safe scheduling, date constraints, and operational flow.`,
      };
    }
    return {
      short: `Scheduled using the "${sName}" strategy.`,
      long: `This order was evaluated using profitability scoring under the "${sName}" strategy. Profit Score = ${ctx.margin.toFixed(2)} ÷ (${ctx.productionHours.toFixed(2)} + ${ctx.changeoverHours.toFixed(2)}) = ${ctx.profitScore.toFixed(2)}.`,
    };
  }
  return {
    short: `Placed by the "${sName}" strategy.`,
    long: `This order was sequenced under the "${sName}" strategy${ctx.strategyReasoning ? ` — ${ctx.strategyReasoning}` : ''}. Its placement respects safe scheduling, date constraints, and material continuity.`,
  };
}

function _siBuildPrompt(strategyMeta, allContexts) {
  const strategyId = strategyMeta?.id || 'rule_based';
  const isRuleBased = strategyId === 'rule_based';
  const sLabel = isRuleBased ? 'Standard Sequence' : (strategyMeta?.name || strategyId);
  const reasoningLine = strategyMeta?.reasoningSummary
    ? `Strategy reasoning: ${strategyMeta.reasoningSummary}`
    : '';
  const sBehavior = isRuleBased
    ? 'Explain placement by chronology, future dispatch urgency (Critical/Urgent/Monitor/Flexible), protected (MTO) rules, and avail dates.'
    : strategyMeta?.emphasizesProfit
    ? 'Explain placement under this AI-generated strategy. Reference profit score = Margin ÷ (Production Hours + Changeover Hours), material compatibility, changeover cost, and safe-window date choice. Always include the profit-score formula with actual values in "long". Use the term "Profit Score" — not "Profit Rate" — and never show /hr units.'
    : 'Explain placement under this AI-generated strategy. Reference material compatibility (same category+color = fewer changeovers), changeover cost, safe-window date choice, and the strategy reasoning above. If effectiveAvailDate differs from originalAvailDate, mention the AI moved the date.';

  const compact = allContexts.map(c => ({
    order_id: c.order_id,
    strategy: c.strategy,
    line: c.line,
    position: c.position,
    totalOrders: c.totalOrders,
    materialSignature: c.materialSignature,
    category: c.category,
    color: c.color,
    effectiveAvailDate: c.effectiveAvailDate,
    originalAvailDate: c.originalAvailDate,
    n10dStatus: c.n10dStatus,
    protectedReason: c.protectedReason,
    feasibilityReason: c.feasibilityReason,
    completionAfterAvail: c.completionAfterAvail,
    delayRiskUnresolved: c.delayRiskUnresolved,
    estimatedStart: c.estimatedStart,
    estimatedCompletion: c.estimatedCompletion,
    balancedHeuristicApplied: c.balancedHeuristicApplied,
    profitHeuristicApplied: c.profitHeuristicApplied,
    previousChangeover: c.previousChangeover,
    nextChangeover: c.nextChangeover,
    productionHours: c.productionHours,
    changeoverHours: c.changeoverHours,
    margin: c.margin,
    marginFound: c.marginFound,
    profitScore: c.profitScore,
    previousOrder: c.previousOrder
      ? { materialSignature: c.previousOrder.materialSignature, category: c.previousOrder.category, color: c.previousOrder.color }
      : null,
    nextOrder: c.nextOrder ? { materialSignature: c.nextOrder.materialSignature } : null,
  }));

  const profitRules = strategyMeta?.emphasizesProfit ? `

CRITICAL RULES FOR THIS PROFIT-EMPHASISING STRATEGY (MUST FOLLOW EXACTLY):
- Each order context already contains the EXACT numeric values displayed in the row: margin, productionHours, changeoverHours, profitScore.
- DO NOT estimate, infer, recompute, round, or substitute these values. Use them verbatim.
- The "long" explanation MUST include the formula written with the EXACT supplied numbers:
    Profit Score = [margin] ÷ ([productionHours] + [changeoverHours]) = [profitScore]
  using the values from this row's context — never your own arithmetic.
- ALWAYS say "Profit Score" — never "Profit Rate". Never append "/hr" or "per hour" to any profit value.
- Margin is stored as a percentage, so Profit Score is a profitability ranking score, not a currency rate.
- If marginFound = false, DO NOT frame profitability as a meaningful signal. Say honestly that margin data is unavailable / not found in master data, and explain placement using only the non-margin factors (date constraints, protected reason, changeover, line flow).
- If marginFound = true and margin = 0, say margin is zero (not "missing").
- Never replace a provided value with an estimate even if it looks unusual.` : '';

  return `You are generating row-level sequencing insights for a feed mill production scheduling system.
Selected strategy: ${sLabel}
${reasoningLine}
Strategy behavior: ${sBehavior}

For each order generate:
- "short": one concise sentence for table display (max ~100 chars, no product name)
- "long": 2-4 sentences with actual values from context, richer explanation that ties the placement to this specific strategy's intent

Rules:
- Use ONLY data provided; never invent or estimate values
- If protectedReason is not null, clearly state it in both short and long, AND note that this strategy does not reorder protected orders
- If feasibilityReason is not null, that text is the PRIMARY reason this date was chosen — surface it verbatim or paraphrased in both short and long. It explains a real timing-driven advancement (delay-avoidance or underutilized-day filling) and outranks generic strategy reasoning.
- estimatedStart and estimatedCompletion are the exact cursor-computed datetimes for this order (format "YYYY-MM-DD HH:MM"). When present, use them in your explanation to ground the insight in real times (e.g. "starts at 12:19 PM on May 12, completes at 04:18 AM on May 13"). Never invent or estimate these values — only use what is provided.
- HIGHEST PRIORITY RULE — delayRiskUnresolved=true means the order's estimatedCompletion is confirmed to be later than its avail date AND no earlier placement was feasible. This is a hard delay-risk case. Both short and long MUST: (1) lead with the delay-risk statement, (2) cite the exact estimatedCompletion and effectiveAvailDate, (3) state that no earlier slot was available. Example short: "Delay risk — projected to complete [estimatedCompletion], after its [effectiveAvailDate] avail date." Example long: adds that no earlier feasible slot existed in the current sequence. Do NOT frame the current date suggestion as valid or acceptable when delayRiskUnresolved=true.
- completionAfterAvail=true (but delayRiskUnresolved=false) means advancement WAS applied — a feasibilityReason will be present explaining it. Follow the feasibilityReason rule instead.
- completionAfterAvail=false means completion is on or before the avail date — do NOT treat early completion as a problem or mention it as a concern.
- If effectiveAvailDate differs from originalAvailDate AND no feasibilityReason is present, mention the AI moved the date
- If previousChangeover > 0, reference the changeover cost
- If order shares category+color with previous/next, mention material grouping
- Do not repeat the product name (user sees it in the table)${profitRules}

Return ONLY valid JSON — no markdown, no text outside the JSON:
{"results":[{"order_id":"...","short":"...","long":"..."}]}

Order contexts:
${JSON.stringify(compact)}`;
}

// Tolerant JSON parser. The AI sometimes returns markdown-fenced JSON, or
// the response is truncated by max_tokens mid-array. We:
//   1) try a direct JSON.parse on the whole text
//   2) try to extract a fenced ```json block
//   3) try the first {...} block (greedy)
//   4) as a last resort, scan for any {"order_id":"...","short":"...",
//      "long":"..."} object literals individually so a truncated array
//      still yields the entries that DID complete.
function _siParseResponse(text) {
  if (!text || typeof text !== 'string') return { results: [] };
  // 1) direct parse
  try {
    const direct = JSON.parse(text);
    if (direct && Array.isArray(direct.results)) return direct;
  } catch (_) { /* fall through */ }
  // 2) fenced block
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      const parsed = JSON.parse(fence[1]);
      if (parsed && Array.isArray(parsed.results)) return parsed;
    } catch (_) { /* fall through */ }
  }
  // 3) greedy outer object
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]);
      if (parsed && Array.isArray(parsed.results)) return parsed;
    } catch (_) { /* fall through to entry-by-entry */ }
  }
  // 4) entry-by-entry recovery for truncated responses
  const results = [];
  // Locate each {"order_id"...} object literal. We can't use a simple regex
  // because short/long contain nested punctuation, so we walk braces.
  const indices = [];
  const idRegex = /"order_id"\s*:/g;
  let match;
  while ((match = idRegex.exec(text)) !== null) {
    // Step back to the opening '{' of this object
    let i = match.index;
    while (i > 0 && text[i] !== '{') i--;
    indices.push(i);
  }
  for (const start of indices) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(text.slice(start, i + 1));
            if (obj && obj.order_id != null) results.push(obj);
          } catch (_) { /* skip malformed entry */ }
          break;
        }
      }
    }
  }
  if (results.length) return { results };
  console.error('[aiSequenceStrategies] insight parse: no recoverable entries (response length=', text.length, ', preview=', text.slice(0, 200), ')');
  return { results: [] };
}

function _siFallback(strategyMeta) {
  const id = strategyMeta?.id || 'rule_based';
  if (id === 'rule_based') return {
    short: 'Placed according to chronology and priority rules.',
    long: 'This order was positioned using standard sequencing logic based on availability date and future dispatch urgency.',
  };
  const sName = strategyMeta?.name || 'AI strategy';
  const reasoning = strategyMeta?.reasoningSummary;
  return {
    short: `Placed by the "${sName}" strategy.`,
    long: `This order was positioned under the "${sName}" strategy${reasoning ? ` — ${reasoning}` : ''} while respecting protected orders, date constraints, and operational flow.`,
  };
}

async function generateStrategyInsights({ strategyMeta, ordersByLine, changeoverRules, masterData }) {
  const strategyId = strategyMeta?.id || 'rule_based';
  // Defensive: when the strategy actually emphasises profit/margin, ensure
  // margin is present on every order before building the context. The
  // insight pipeline must use the same row values the user sees in the
  // After table; if margin was stripped or missed during earlier enrichment
  // we re-attach it from masterData here.
  let workingOrders = ordersByLine;
  if (strategyMeta?.emphasizesProfit) {
    workingOrders = ensureMarginPresent(ordersByLine, masterData);
  }

  // Build one flat list of row contexts for all lines, keyed for fallback use.
  const allCtx = [];
  const ctxById = new Map();
  for (const [line, orders] of Object.entries(workingOrders)) {
    if (!orders || orders.length === 0) continue;
    orders.forEach((order, idx) => {
      const prev = idx > 0 ? orders[idx - 1] : null;
      const next = idx < orders.length - 1 ? orders[idx + 1] : null;
      const ctx = _siCtx(order, prev, next, strategyMeta, line, orders, idx, changeoverRules);
      allCtx.push(ctx);
      ctxById.set(String(order.id), ctx);
    });
  }
  if (allCtx.length === 0) return workingOrders;

  // One AI call per strategy for all lines.
  // maxTokens: scaled to the number of orders (each row produces a short +
  // long entry, ~80-120 tokens). 4500 base covers ~30 orders comfortably; we
  // grow it for larger runs so the response is not truncated mid-array.
  const dynamicMaxTokens = Math.min(8000, Math.max(4500, allCtx.length * 130));
  let resultMap = new Map();
  try {
    const sysPrompt = 'You are a production scheduling insight generator. Return only valid JSON as instructed.';
    const userPrompt = _siBuildPrompt(strategyMeta, allCtx);
    const response = await callSequenceStrategyAI(sysPrompt, userPrompt, dynamicMaxTokens);
    const parsed = _siParseResponse(response);
    // Build the lookup with multiple key forms so the AI's response matches
    // even if it returns a numeric id when the source id is a zero-padded
    // string (or vice versa). We register every viable spelling: raw String,
    // numerically-normalised (parseFloat round-trip), and trimmed.
    for (const r of (parsed.results || [])) {
      if (r == null || r.order_id == null) continue;
      const raw = String(r.order_id);
      resultMap.set(raw, r);
      const trimmed = raw.trim();
      if (trimmed !== raw) resultMap.set(trimmed, r);
      const num = Number(trimmed);
      if (!Number.isNaN(num)) resultMap.set(String(num), r);
    }
    if (resultMap.size < allCtx.length) {
      const expectedSample = allCtx.slice(0, 3).map(c => c.order_id);
      const gotSample = (parsed.results || []).slice(0, 3).map(r => r && r.order_id);
      console.warn(`[aiSequenceStrategies] Insight AI returned ${(parsed.results || []).length} entries for ${(allCtx.length)} ${strategyId} rows (responseLen=${(response || '').length}, maxTokens=${dynamicMaxTokens}). Sample expected ids=${JSON.stringify(expectedSample)} got ids=${JSON.stringify(gotSample)}. Missing rows will use deterministic fallback.`);
    }
  } catch (err) {
    console.error(`[aiSequenceStrategies] Insight generation failed for ${strategyId}:`, err && err.message ? err.message : err);
  }

  // Write insights back onto orders. For any AI strategy, prefer the
  // value-aware contextual fallback so missing-AI rows still show the
  // correct strategy-named explanation (and the profit-score formula when
  // the strategy emphasises profit) instead of generic boilerplate.
  const updated = {};
  for (const [line, orders] of Object.entries(workingOrders)) {
    updated[line] = (orders || []).map(order => {
      const ai = resultMap.get(String(order.id));
      let insight;
      if (ai && ai.short && ai.long) {
        insight = { short: ai.short, long: ai.long };
      } else if (strategyId !== 'rule_based') {
        const ctx = ctxById.get(String(order.id));
        insight = ctx ? getFallbackProfitInsight(ctx) : _siFallback(strategyMeta);
      } else {
        insight = _siFallback(strategyMeta);
      }
      return {
        ...order,
        _strategyInsights: {
          ...(order._strategyInsights || {}),
          [strategyId]: insight,
        },
      };
    });
  }
  return updated;
}

// ─── Per-line AI strategy primitives ──────────────────────────────────────
// Per-spec the strategy options are now generated PER LINE: each line gets its
// own Standard + two AI-generated options whose names/themes/reasoning come
// from a single AI call scoped to that line's lineup. The plant-wide variants
// above remain in the file as legacy helpers but are no longer called.

// Build the per-line AI strategy prompt.
//
// Standard already handles: chronology, urgent/critical date protection, and
// N10D-driven date ordering. So we MUST tell the AI exactly what Standard
// does and forbid trivial "critical first / urgent first / sort by dates"
// strategies that simply mirror Standard. Strategies have to introduce a
// distinct sequencing IDEA (material clustering, profit advancement, slack
// distribution, line-flow smoothing, etc.) and produce a sequence that is
// meaningfully different from Standard AND from each other.
//
// We pass:
//   • full per-order context (status flags, material signature, margin,
//     profit_score, production hours, original avail date)
//   • the current Standard sequence positions for this line (so the AI can
//     compare against the baseline rather than re-invent it)
//   • live changeover rules
function buildLineStrategyPrompt({ line, lineOrders, standardSequence, changeoverRules, inferredTargetMap, retryAddendum = '' }) {
  const N10D_URGENCY = { Critical: 1, Urgent: 2, Monitor: 3, Flexible: 4 };

  // Build a quick lookup of standard-sequence position by order id, so we
  // can stamp `standard_position` onto each per-order context block. The AI
  // sees both the lineup AND each order's position in the rule-based
  // baseline, which makes it much easier to reason about deviations.
  const standardPosById = {};
  (standardSequence || []).forEach((o, i) => {
    if (o && o.id != null) standardPosById[o.id] = i + 1;
  });

  // Material signature collapses the four fields the changeover engine cares
  // about (category | color | diameter | form) into one short label. Easy
  // for the AI to spot adjacent clusters.
  const matSig = (o) => [o.category, o.color, o.diameter, o.form]
    .map(v => (v == null || v === '') ? '-' : String(v))
    .join('|');

  const orderDetails = lineOrders.map(o => {
    const effectiveAvail = getEffectiveAvailISO(o, inferredTargetMap) || null;
    const _today0 = new Date(); _today0.setHours(0, 0, 0, 0);
    const _todayISO = _toLocalISO(_today0);
    let n10d_days_remaining = 999;
    if (effectiveAvail) {
      const deadline = new Date(effectiveAvail);
      n10d_days_remaining = Math.max(0, Math.ceil((deadline - _today0) / 86400000));
    }
    const mto = isMTO(o);
    const critical = isCritical(o);
    const urgent = o._n10dStatus === 'Urgent';
    const monitor = o._n10dStatus === 'Monitor';
    const flexible = !mto && !critical && !urgent && !monitor;

    const isOriginalDateOverdue = !!(effectiveAvail && effectiveAvail < _todayISO);
    const aiAnchorDate = resolveAISchedulingAnchor(effectiveAvail, _todayISO);
    if (isOriginalDateOverdue) {
      console.debug('[AI Overdue Date Rollforward]', {
        orderId: o.id,
        originalAvailDate: effectiveAvail,
        currentSchedulingDate: _todayISO,
        isOriginalDateOverdue: true,
        effectiveAiSchedulingDate: aiAnchorDate,
        strategyTitle: 'buildLineStrategyPrompt',
      });
    }

    let safe_window_end = isOriginalDateOverdue && !flexible ? aiAnchorDate : effectiveAvail;
    if (flexible) {
      if (effectiveAvail) {
        const d = new Date(effectiveAvail); d.setDate(d.getDate() + 14);
        safe_window_end = d.toISOString().substring(0, 10);
      } else {
        const d = new Date(); d.setDate(d.getDate() + 24);
        safe_window_end = d.toISOString().substring(0, 10);
      }
    }
    const originalAvail = o._originalTargetDate || o.target_avail_date || null;
    return {
      id: o.id,
      description: (o.item_description || '').substring(0, 60),
      material_code: o.material_code || o.fg_code || null,
      material_signature: matSig(o),
      volume: parseFloat(o.volume || o.total_volume_mt || 0) || 0,
      current_avail_date: aiAnchorDate || o.target_avail_date || null,
      original_avail_date: originalAvail,
      avail_date_changed: !!(originalAvail && effectiveAvail && originalAvail !== effectiveAvail),
      safe_window_end,
      n10d_days_remaining,
      future_dispatch_status: o._n10dStatus || 'Flexible',
      urgency_rank: mto ? 1 : (N10D_URGENCY[o._n10dStatus] ?? 4),
      is_mto: mto,
      is_critical: critical,
      is_urgent: urgent,
      is_monitor: monitor,
      is_flexible: flexible,
      margin: parseFloat(o._margin) || 0,
      profit_score: o._profitRate != null ? parseFloat(o._profitRate.toFixed(3)) : 0,
      production_hours: parseFloat(o.production_hours) || 0,
      changeover_hours: parseFloat(o._changeoverTotal ?? o.changeover_time ?? 0) || 0,
      color: o.color || null,
      diameter: o.diameter || null,
      category: o.category || null,
      form: o.form || null,
      standard_position: standardPosById[o.id] || null,
    };
  });

  // Per-transition changeover costs for the standard sequence.
  // Computed BEFORE standardContext so the cost can be stamped onto each row.
  const _co_rules = changeoverRules || getFallbackChangeoverRules();
  const _stdSeq   = standardSequence || [];
  const transitionCosts = [];   // [{fromPos, toPos, fromId, toId, cost}]
  let   totalStdChangeover = 0;
  for (let i = 0; i < _stdSeq.length - 1; i++) {
    const from = _stdSeq[i];
    const to   = _stdSeq[i + 1];
    const cost = parseFloat(calculateChangeoverBetween(from, to, _co_rules)) || 0;
    transitionCosts.push({ fromPos: i + 1, toPos: i + 2, fromId: from.id, toId: to.id, cost });
    totalStdChangeover += cost;
  }

  // Compact view of the Standard baseline for THIS line — gives the AI a
  // direct, compact reference of "what the rule-based system already
  // produced" so it can deliberately deviate.
  // `changeover_to_next_hours` lets the AI see exactly which transitions are
  // costly and reason about which order pairs to re-sequence.
  const standardContext = _stdSeq.map((o, i) => ({
    position: i + 1,
    order_id: o.id,
    avail_date: getEffectiveAvailISO(o, inferredTargetMap) || o.target_avail_date || null,
    material_signature: matSig(o),
    form: o.form || null,
    future_dispatch_status: o._n10dStatus || (isMTO(o) ? 'MTO' : 'Flexible'),
    is_protected: isMTO(o) || isCritical(o) || o._n10dStatus === 'Urgent' || o._n10dStatus === 'Monitor',
    changeover_to_next_hours: transitionCosts[i]?.cost ?? null,
  }));

  const countCritical = lineOrders.filter(o => isCritical(o)).length;
  const countUrgent = lineOrders.filter(o => o._n10dStatus === 'Urgent').length;
  const countMonitor = lineOrders.filter(o => o._n10dStatus === 'Monitor').length;
  const countSufficient = lineOrders.filter(o => !isMTO(o) && !isCritical(o) && o._n10dStatus !== 'Urgent' && o._n10dStatus !== 'Monitor').length;
  const countMTO = lineOrders.filter(isMTO).length;
  const flexibleCount = countSufficient;
  const lowFlexibility = flexibleCount < 2;

  // Pass `line` so the rules section explicitly resolves to FM1/FM2/FM3 for
  // THIS specific line (with stacking + directional examples baked in). This
  // removes the "AI has to mentally re-map the FM column" failure mode that
  // previously caused changeover-focused strategies to use generic estimates.
  const dynamicChangeoverSection = buildDynamicChangeoverPromptSection(
    changeoverRules || getFallbackChangeoverRules(),
    line
  );

  const todayISO = _toLocalISO(new Date());
  const earliest = (() => { const d = new Date(); d.setDate(d.getDate() + 2); return _toLocalISO(d); })();

  // Aggregate per-date order count + production hours so the AI can see which
  // days are empty / lightly loaded and choose better candidate dates.
  const _dlByDate = {};
  for (const od of orderDetails) {
    const dt = od.current_avail_date;
    if (!dt || !/^\d{4}-\d{2}-\d{2}/.test(dt)) continue;
    if (!_dlByDate[dt]) _dlByDate[dt] = { n: 0, h: 0 };
    _dlByDate[dt].n += 1;
    _dlByDate[dt].h += (od.production_hours || 0);
  }
  const dailyLoadSummary = Object.entries(_dlByDate)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([dt, { n, h }]) => `  ${dt}: ${n} order${n !== 1 ? 's' : ''}, ${h.toFixed(1)}h`)
    .join('\n') || '  (no dated orders yet)';

  const systemPrompt = `You are an AI production scheduling strategist for a feed manufacturing plant. You analyse ONE production line at a time and propose TWO genuinely distinct sequencing strategies that DERIVE FROM THE ACTUAL LINEUP ANALYSIS — not from preset themes. The Standard Sequence already handles chronology, MTO/Critical/Urgent/Monitor protection, and future-dispatch-driven date ordering. Your job is to first analyse what is really happening on this specific line, identify the real tensions and opportunities, and only THEN invent two strategies that emerge from those observations. Avoid generic reusable labels (material clustering, profit optimization, balanced flow, critical first) unless your line analysis strongly justifies them. Hard deadline rules always override optimisation. Respond ONLY with valid JSON.`;

  const userPrompt = `You are analysing a single production line: "${line}".
The current lineup on this line has already gone through cross-line combination, line assignment, future dispatch date enrichment, and the rule-based Standard Sequence has already been built. Your job is to propose exactly TWO alternative sequencing strategies that go beyond the Standard baseline.

════════════════════════════════════════════
WHAT THE STANDARD SEQUENCE ALREADY DOES (do NOT just repeat this)
════════════════════════════════════════════
The Standard Sequence has already:
  • Sorted orders chronologically by their effective avail dates / future dispatch logic.
  • Pinned MTO orders to their actual contracted dates.
  • Pushed Critical orders to position 1 today.
  • Held Urgent / Monitor orders no later than their current avail date.
  • Allowed flexible (Sufficient) orders to land at their default chronology.

Therefore, do NOT propose a strategy whose entire idea is "critical first", "urgent first", "deadline first", or "sort by dates". Standard already does all of that. A strategy whose ordering is effectively the same as Standard is NOT a valid AI strategy.

════════════════════════════════════════════
CURRENT LINEUP — ${line} (${lineOrders.length} orders — Critical: ${countCritical} | Urgent: ${countUrgent} | Monitor: ${countMonitor} | Sufficient: ${countSufficient} | MTO: ${countMTO})
════════════════════════════════════════════
Every order_id below must appear exactly once per strategy with a suggested_date.

${JSON.stringify(orderDetails, null, 2)}

════════════════════════════════════════════
STANDARD SEQUENCE (current baseline for ${line}) — for COMPARISON only
════════════════════════════════════════════
This is what the rule-based engine already produced. Your strategies should deviate from this in a way that adds value (clustering, profitability, slack, flow). Repeating this ordering verbatim does not qualify as an AI strategy.

${JSON.stringify(standardContext, null, 2)}

════════════════════════════════════════════
TRANSITION ANALYSIS — CURRENT CHANGEOVER COST IN STANDARD LINEUP (${line})
════════════════════════════════════════════
Total changeover hours in the current Standard sequence: ${totalStdChangeover.toFixed(2)}h

Per-transition costs (only transitions > 0h shown):
${transitionCosts.filter(t => t.cost > 0).length === 0
  ? '  (no changeovers detected — lineup is already fully compatible)'
  : transitionCosts
      .filter(t => t.cost > 0)
      .map(t => {
        const fromO = _stdSeq[t.fromPos - 1];
        const toO   = _stdSeq[t.toPos - 1];
        const flag = t.cost >= 2 ? ' ⚠ COSTLY' : t.cost >= 1 ? ' ↑ moderate' : '';
        return `  Pos ${t.fromPos}→${t.toPos}: ${t.cost.toFixed(2)}h${flag}  [${matSig(fromO)}] → [${matSig(toO)}]`;
      })
      .join('\n')
}

Top transitions to consider fixing (highest cost first):
${(() => {
  const top = transitionCosts.filter(t => t.cost >= 1).sort((a, b) => b.cost - a.cost).slice(0, 4);
  if (top.length === 0) return '  (no transitions ≥ 1h — changeover profile is already low-cost)';
  return top.map((t, i) => {
    const fromO = _stdSeq[t.fromPos - 1];
    const toO   = _stdSeq[t.toPos - 1];
    const fromProtected = isMTO(fromO) || isCritical(fromO) || fromO?._n10dStatus === 'Urgent' || fromO?._n10dStatus === 'Monitor';
    const toProtected   = isMTO(toO)   || isCritical(toO)   || toO?._n10dStatus   === 'Urgent' || toO?._n10dStatus   === 'Monitor';
    const fixable = !fromProtected && !toProtected ? 'both flexible — can be regrouped' : fromProtected ? 'from-order protected' : 'to-order protected';
    return `  ${i + 1}. Pos ${t.fromPos}→${t.toPos}: ${t.cost.toFixed(2)}h  [${matSig(fromO)}] → [${matSig(toO)}]  (${fixable})`;
  }).join('\n');
})()}

${dynamicChangeoverSection}

════════════════════════════════════════════
HARD RULES — apply to BOTH strategies; non-negotiable.
════════════════════════════════════════════
RULE 1 — DEADLINE PROTECTION
  • is_mto: true               → suggested_date = current_avail_date verbatim (immutable contract). Position by date.
  • future_dispatch_status "Critical"     → suggested_date = TODAY (${todayISO}). Pin to position 1 in the line.
  • is_urgent or is_monitor    → may move EARLIER but NEVER later than current_avail_date (HARD ceiling).
  • is_flexible (Sufficient)   → free to move within [today+2 = ${earliest}, safe_window_end].
RULE 2 — Every order_id appears exactly once per strategy.
RULE 3 — Output covers ONLY this line. Do not invent orders. Do not move orders to other lines.
RULE 4 — SUFFICIENT ORDERS MUST SHOW REAL DATE CHANGES
  • A Sufficient (is_flexible: true) order MUST receive a suggested_date DIFFERENT from its current_avail_date.
  • Do NOT copy current_avail_date for any Sufficient order — find a genuinely better slot within [today+2 = ${earliest}, safe_window_end].
  • For advance_flexible_orders strategies: every Sufficient order's suggested_date MUST be EARLIER than its current_avail_date (≥ ${earliest}).
  • For deferral / load-shifting strategies: some Sufficient orders SHOULD move LATER than current_avail_date (up to safe_window_end = current_avail_date + 14 days).
  • The current_avail_date is just one candidate — only keep it if it genuinely scores best vs all alternatives.
  • A date only counts as "changed" when your output's suggested_date differs from the order's current_avail_date.

CURRENT DAY LOAD ON ${line} — dates with 0 orders are EMPTY and are strong candidates for placing flexible orders.
  Dates with high hours (> 12h) are overloaded — avoid adding more. Look for gaps:
${dailyLoadSummary}

════════════════════════════════════════════
STAGE A — ANALYSE THIS LINE FIRST (do not skip)
════════════════════════════════════════════
Before proposing any strategy, mentally answer:
  1. What constraints DOMINATE this lineup? (e.g. cluster of MTOs, several Critical orders pinned to today, few flexible orders, very tight window between consecutive deadlines, heavy production_hours concentration, etc.)
  2. What flexibility EXISTS beyond Standard's date-driven sequence? (which flexible orders can move, how far, into which gaps)
  3. What are the real SEQUENCING TENSIONS on this specific line? Examples (pick whichever apply — do NOT invent tensions that aren't there):
       • date rigidity vs flexibility
       • changeover burden vs profitability opportunity
       • slack preservation vs batching opportunity
       • sequence continuity vs deadline protection
       • large runs vs small urgent runs
       • limited margin variation vs high material variation
       • high volume concentration vs dispersed deadlines
  4. What meaningful alternative sequencing GOALS are actually possible here?

════════════════════════════════════════════
STAGE A.5 — MULTI-DIMENSION ANALYSIS (REQUIRED)
════════════════════════════════════════════
Before generating strategies, you MUST evaluate ALL THREE of these scheduling dimensions for this line:

  1. CHANGEOVER REDUCTION
     The Standard sequence has a total changeover cost of ${totalStdChangeover.toFixed(2)}h across ALL adjacent pairs.
     Use the TRANSITION ANALYSIS above to understand where that cost is concentrated.

     Changeover reduction is meaningful when you can find an ordering whose TOTAL cost across ALL
     adjacent pairs is genuinely lower — not just one expensive transition fixed while others grow.
     When you consider a reorder, keep the whole chain in mind: fixing a 1.0h pair that introduces
     0.8h + 0.8h elsewhere is a net loss, even if the targeted pair improved.

     Use the Changeover Rules above and each order's attributes (category, color, diameter, form) to
     reason about which groupings are compatible and where real savings exist. Changeover is one
     dimension among three — choose it as your primary_emphasis only when you believe a genuine
     improvement to the total is achievable within the hard constraints.

     If the transition analysis shows all transitions are already low (< 0.5h), changeover is not
     the lever to pull here — say so, and choose a different primary_emphasis instead.
     Using the Changeover Rules above, confirm your assessment before declaring
     changeover_consideration relevance.

  2. MTS / FLEXIBLE ADVANCEMENT
     Assess whether eligible flexible orders can be safely moved earlier — into lightly-loaded
     earlier days, into days that today carry only one order, or simply compressed forward
     within the safe window. Look at safe_window_end vs current_avail_date for each flexible.
     Does pulling work earlier improve utilisation without shifting protected orders?

  3. PROFITABILITY / ${AI_PROFITABILITY_LABEL.toUpperCase()}
     Assess whether ${AI_PROFITABILITY_LABEL_LOWER} spread across eligible orders is meaningful enough
     to influence sequencing. If a higher-${AI_PROFITABILITY_LABEL_LOWER} flexible can safely be sequenced ahead of a
     lower-${AI_PROFITABILITY_LABEL_LOWER} flexible, profitability is a useful lever. If ${AI_PROFITABILITY_LABEL_PLURAL} are bunched and
     differences are marginal, profitability is a weak lever on this line.

You ARE ALLOWED to deprioritize one or more dimensions if the line analysis justifies it,
but you MUST explain why in deprioritization_reason. Do NOT pretend a dimension matters
when it doesn't, and do NOT force all three equally if the line does not support that.

For each strategy, decide:
  • which ONE dimension is the PRIMARY emphasis
  • which ONE is the SECONDARY emphasis
  • which (if any) are DEPRIORITIZED — and why

Then make sure the strategy's order sequence VISIBLY ACTS on the primary emphasis (and,
where compatible, the secondary). The After table will be evaluated for whether it
actually reflects what you declared.

The two strategies you generate in Stage B MUST emerge from these observations. If a strategy idea cannot be supported by the analysis above, do not output it.

════════════════════════════════════════════
STAGE B — DERIVE TWO STRATEGIES FROM YOUR ANALYSIS
════════════════════════════════════════════
Each strategy MUST:
  1. Be derived from a specific observation about THIS line (not from a preset theme).
  2. Produce an ordering meaningfully different from the Standard baseline above (different positions for at least 2 flexible orders OR a different suggested_date for at least one flexible order).
  3. Have a primary objective that is GENUINELY DIFFERENT from the other strategy (one creates downstream slack, one compresses compatible flexible runs, one protects large runs from fragmentation, one advances stronger-value flexible orders, one smooths the middle queue, one preserves late-window capacity, etc.).
  4. Carry a line-specific name (3-5 words) that reflects the actual sequencing idea you discovered. Examples of the *style* of name we want (do not copy these verbatim — invent your own that fits the line):
       Early Slack Recovery, Mid-Queue Compression, Late-Window Protection,
       Large-Run Containment, Flexible Gap Filling, Protected Front Smoothed Middle,
       Batch Window Consolidation.

════════════════════════════════════════════
DO NOT default to GENERIC TEMPLATE STRATEGIES
════════════════════════════════════════════
The following strategy *themes* are forbidden as the primary idea unless the line analysis strongly justifies them, AND your line_specific_observation explains exactly why this line uniquely fits that idea:
  ✗ Material clustering / Material continuity / Changeover reduction
  ✗ Profit score optimization / Profitability-driven scheduling
  ✗ Balanced flow / Efficiency focus
  ✗ Critical first / Urgent first / Critical First Then Flexible

The following STRATEGY NAMES are blacklisted unless followed by a strong line-specific justification:
  ✗ "Material Clustering for Efficiency", "Material Continuity Optimization"
  ✗ "Profit Score Optimization", "Profitability-Driven Scheduling"
  ✗ "Critical First", "Critical First, Then Flexible", "Balanced Flow", "Efficiency Focus"

If you choose a theme that resembles one of these, you MUST explain in line_specific_observation what concretely about THIS line's order mix, dates, materials, or flexibility profile makes it the right fit — vague justifications will be rejected.

${retryAddendum ? `\n════════════════════════════════════════════\nRETRY FEEDBACK — your previous attempt was rejected\n════════════════════════════════════════════\n${retryAddendum}\n\nPlease re-analyse the line and produce two strategies that genuinely emerge from the lineup, not from preset themes.\n\n` : ''}${lowFlexibility ? `NOTE: This line has only ${flexibleCount} flexible order(s) so sequencing room is limited. You may still propose two strategies, but explain in difference_from_standard / reasoning_summary that flexibility is constrained, and choose ideas that exploit whatever room exists (e.g. material clustering inside a tight window, slack preservation around the few movable orders).\n\n` : ''}For EACH strategy, return:
  • strategy_name                   — line-specific name (3-5 words) reflecting your discovered idea
  • subtitle                        — short tag like "AI-generated strategy"
  • short_description               — one sentence (≤ 140 chars) describing what the strategy ACTUALLY does — describe only effects that will be visibly reflected in the final order sequence. Do NOT claim grouping, clustering, or ordering effects that date constraints prevent from showing clearly (e.g. do not say "groups yellow 3mm orders early" if those orders have different avail dates that force them apart). If only one primary effect is achievable (e.g. "places red order last"), describe only that.
  • line_specific_observation       — one sentence stating what you observed about THIS line that motivated the strategy (e.g. "This line has 3 flexible orders sharing the same safe window but spread unevenly across the queue.")
  • why_this_strategy_fits_this_line — one sentence explaining why this particular strategy is the right response to that observation
  • difference_from_standard        — one sentence explaining how this sequence differs from the Standard baseline above
  • distinct_focus                  — 2-4 word label of the strategy's primary focus (e.g. "Slack creation", "Mid-queue compression", "Late-window protection")
  • reasoning_summary               — 2-3 sentences synthesising the above
  • changeover_consideration        — REQUIRED object: { relevance: "high"|"medium"|"low", summary: "..." } describing what you observed about changeover-reduction opportunity on this line.
  • mts_advancement_consideration   — REQUIRED object: { relevance: "high"|"medium"|"low", summary: "..." } describing what you observed about MTS / flexible advancement opportunity.
  • profitability_consideration     — REQUIRED object: { relevance: "high"|"medium"|"low", summary: "..." } describing what you observed about ${AI_PROFITABILITY_LABEL_LOWER} opportunity (use ${AI_PROFITABILITY_LABEL_LOWER} as the active profitability signal — do NOT mention "${AI_PROFITABILITY_BASIS === 'margin' ? 'profit score' : 'margin'}" in your summary).
  • primary_emphasis                — REQUIRED string. One of: "changeover reduction", "MTS advancement", "profitability". Which dimension this strategy emphasises FIRST.
  • secondary_emphasis              — REQUIRED string. One of the three dimensions, different from primary. Or "none" if the line truly only supports one lever.
  • deprioritized_factors           — REQUIRED array of strings (subset of the three dimensions). May be empty. Anything you list here will not be expected to dominate the After table.
  • deprioritization_reason         — REQUIRED short string explaining why the deprioritized factor(s) make sense to deprioritize on this specific line. Use "" if none deprioritized.
  • tradeoff_summary                — REQUIRED 1-2 sentence summary of the tradeoff this strategy makes (what it gains, what it gives up).
  • execution_intent                — REQUIRED structured plan that the app will enforce. Object with:
      • primary_goal              — one of:
          - "advance_flexible_orders"        (move eligible flexible orders into earlier safe slots / fill light early days)
          - "group_swine_by_diameter"        (cluster swine orders adjacent by diameter to cut diameter changeovers)
          - "compress_compatible_runs"       (reorder so material/diameter compatible orders sit adjacent for changeover savings)
          - "create_downstream_slack"        (front-load runnable work to free later capacity)
          - "protect_late_window_capacity"   (avoid pushing flexible work into late dates so Monitor/MTO room is preserved)
          - "stabilize_mid_queue"            (smooth mid-week load so neither end is overloaded)
          - "generic_optimization"           (use only if none of the above truly fits — your strategy_name and observation must justify it)
      • secondary_goal            — short string, additional outcome the strategy also tries to achieve
      • date_behavior             — short string, what the strategy does with dates (e.g. "pull eligible flexible orders into earlier safe slots", "keep all dates as-is", "spread flexible orders across underused days")
      • grouping_behavior         — short string, how the strategy clusters orders (e.g. "cluster swine by diameter", "group by material family", "no special grouping")
      • slack_behavior            — short string, how the strategy uses available capacity (e.g. "fill underutilized early days when safe", "preserve late-window slack", "no special slack handling")
  • orders                          — ordered array [{ order_id, position, suggested_date }] for THIS line only. The order sequence MUST visibly act on primary_goal — e.g. if primary_goal is "advance_flexible_orders" then eligible flexible orders MUST appear earlier in your sequence than they do in the Standard baseline; if primary_goal is "group_swine_by_diameter" then swine orders sharing a diameter MUST be adjacent or near-adjacent. A sequence that ignores its own primary_goal will be rejected.
  • optional dateAdjustments        — array of notable date moves with order_id + original + new + reason

${AI_PROFITABILITY_BASIS === 'margin'
  ? `MARGIN (use only when your strategy genuinely emphasises profitability AND the line analysis justifies it):
  Use margin (margin %) DIRECTLY as the profitability signal — higher-margin orders are considered more profitable.
  Use margin as a tie-breaker after the primary clustering / advancement objective.
  DO NOT reference "profit score" in your reasoning — margin is the active profitability signal for this run.`
  : `PROFIT SCORE (use only when your strategy genuinely emphasises profitability AND the line analysis justifies it):
  Profit Score = Margin ÷ (Production Hours + Changeover Hours).
  Higher = more margin per total machine-hour consumed.`}

RESPONSE FORMAT — JSON only, no markdown, no commentary:
{
  "strategies": [
    {
      "strategy_id": "ai_option_1",
      "strategy_name": "...",
      "subtitle": "AI-generated strategy",
      "short_description": "...",
      "line_specific_observation": "...",
      "why_this_strategy_fits_this_line": "...",
      "difference_from_standard": "...",
      "distinct_focus": "...",
      "reasoning_summary": "...",
      "changeover_consideration":     { "relevance": "medium", "summary": "..." },
      "mts_advancement_consideration": { "relevance": "high",  "summary": "..." },
      "profitability_consideration":  { "relevance": "low",    "summary": "..." },
      "primary_emphasis": "MTS advancement",
      "secondary_emphasis": "changeover reduction",
      "deprioritized_factors": ["profitability"],
      "deprioritization_reason": "Profit score spread across eligible orders is too small to justify changing the sequence materially.",
      "tradeoff_summary": "Pulls flexible orders earlier to use safe lightly-loaded days; preserves compatible grouping where practical; profitability is set aside because score variation is weak.",
      "execution_intent": {
        "primary_goal": "advance_flexible_orders",
        "secondary_goal": "preserve material compatibility where possible",
        "date_behavior": "pull eligible flexible orders into earlier safe slots",
        "grouping_behavior": "prefer nearby compatible materials when advancing",
        "slack_behavior": "fill underutilized early days when safe"
      },
      "orders": [
        { "order_id": "xxx", "position": 1, "suggested_date": "${earliest}" }
      ],
      "dateAdjustments": []
    },
    {
      "strategy_id": "ai_option_2",
      "strategy_name": "...",
      "subtitle": "AI-generated strategy",
      "short_description": "...",
      "line_specific_observation": "...",
      "why_this_strategy_fits_this_line": "...",
      "difference_from_standard": "...",
      "distinct_focus": "...",
      "reasoning_summary": "...",
      "changeover_consideration":     { "relevance": "high",   "summary": "..." },
      "mts_advancement_consideration": { "relevance": "low",    "summary": "..." },
      "profitability_consideration":  { "relevance": "medium", "summary": "..." },
      "primary_emphasis": "changeover reduction",
      "secondary_emphasis": "profitability",
      "deprioritized_factors": ["MTS advancement"],
      "deprioritization_reason": "Most flexible orders on this line are already near their target dates so further advancement gives little.",
      "tradeoff_summary": "Clusters compatible runs to cut changeovers; uses profit score only as a tie-breaker; advancement is not the lever here.",
      "execution_intent": {
        "primary_goal": "group_swine_by_diameter",
        "secondary_goal": "keep dates safe",
        "date_behavior": "adjust flexible swine orders within safe windows to improve grouping",
        "grouping_behavior": "cluster swine orders with same or compatible diameter",
        "slack_behavior": "do not scatter grouped swine runs unnecessarily"
      },
      "orders": [ ... ],
      "dateAdjustments": []
    }
  ]
}`;

  return { systemPrompt, userPrompt };
}

// Tolerant parser for the per-line response. Same fallback chain as the
// plant-wide variant but typed for line-scoped strategies.
function parseLineStrategyResponse(content) {
  if (!content || typeof content !== 'string') return { strategies: [] };
  const tryParseStrategies = (txt) => {
    try {
      const obj = JSON.parse(txt);
      if (obj && Array.isArray(obj.strategies)) return obj.strategies;
    } catch (_) { /* fall through */ }
    return null;
  };
  let arr = tryParseStrategies(content);
  if (arr) return { strategies: arr };
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    arr = tryParseStrategies(fence[1]);
    if (arr) return { strategies: arr };
  }
  const greedy = content.match(/\{[\s\S]*\}/);
  if (greedy) {
    arr = tryParseStrategies(greedy[0]);
    if (arr) return { strategies: arr };
  }
  console.error('[aiSequenceStrategies] line parse failed (length=', content.length, ', preview=', content.slice(0, 200), ')');
  return { strategies: [] };
}

// Failed shell for a per-line AI strategy slot. Mirrors the plant-wide shell
// but is line-scoped so the modal can render a clear "AI Unavailable" card
// inside that specific line's tab without affecting the other lines.
function buildFailedLineAIStrategyShell(line, slotIndex, reason = 'AI strategy generation failed') {
  const slot = slotIndex === 0 ? 'ai_option_1' : 'ai_option_2';
  const visuals = STRATEGY_VISUALS[slotIndex] || STRATEGY_VISUALS[0];
  return {
    id: slot,
    name: 'AI Strategy Unavailable',
    theme: 'AI-generated strategy',
    description: `AI could not generate this strategy for ${line}.`,
    icon: visuals.icon,
    color: visuals.color,
    reasoningSummary: reason,
    aiReasoning: reason,
    orders: [],
    metrics: calculateStrategyMetrics({ [line]: [] }),
    dateAdjustments: [],
    isAIRecommended: false,
    isAI: true,
    isAIGenerated: true,
    aiFailed: true,
    sourceType: 'ai_generated',
    line,
  };
}

// ─── Strategy execution-intent layer (per spec §3-§7) ────────────────────
// The AI is asked to return a structured `execution_intent` block whose
// `primary_goal` is one of a small enum. We normalise the block here, then
// dispatch on primary_goal to a deterministic refinement function that
// reorders the AI's sequence to actually act on its declared intent. The
// result still flows through applyAISequenceToOrders, which enforces hard
// constraints (MTO/firm chronology, safe-window clamp), so the refinement
// can only swap positions that the existing pipeline would already allow.

const SUPPORTED_PRIMARY_GOALS = new Set([
  'advance_flexible_orders',
  'group_swine_by_diameter',
  'compress_compatible_runs',
  'create_downstream_slack',
  'protect_late_window_capacity',
  'stabilize_mid_queue',
  'generic_optimization',
]);

function normalizeExecutionIntent(raw) {
  const intent = (raw && typeof raw === 'object') ? raw : {};
  const rawGoal = String(intent.primary_goal || '').trim().toLowerCase().replace(/\s+/g, '_');
  const primary_goal = SUPPORTED_PRIMARY_GOALS.has(rawGoal) ? rawGoal : 'generic_optimization';
  return {
    primary_goal,
    secondary_goal: String(intent.secondary_goal || '').trim(),
    date_behavior: String(intent.date_behavior || '').trim(),
    grouping_behavior: String(intent.grouping_behavior || '').trim(),
    slack_behavior: String(intent.slack_behavior || '').trim(),
  };
}

// ─── Multi-dimension emphasis normalisers (per spec §§1-6, §11) ──────────
// The AI emits three "consideration" objects (one per dimension) plus a
// declared primary/secondary/deprioritized emphasis. We canonicalise the
// dimension labels into a small enum so downstream code (faithfulness
// weighting, row insights, UI badges) can switch on them without having
// to re-parse free-form strings each time.

// Canonical dimension keys.
const EMPHASIS_DIMENSIONS = ['changeover', 'mts', 'profitability'];

// Map a free-form label ("changeover reduction", "MTS advancement",
// "profit", "profitability", "advance flexible orders", …) to the
// canonical key, or null if it doesn't look like one of the three.
function canonicalizeEmphasisLabel(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s === 'none' || s === '-' || s === '—') return null;
  if (/(change\s*over|grouping|cluster|compat|material)/.test(s)) return 'changeover';
  if (/(mts|advance|flexible|earlier|advancement)/.test(s)) return 'mts';
  if (/(profit|margin|revenue)/.test(s)) return 'profitability';
  return null;
}

function normalizeRelevance(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'high' || s === 'medium' || s === 'low') return s;
  return 'medium';
}

function normalizeConsideration(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  return {
    relevance: normalizeRelevance(c.relevance),
    summary:   String(c.summary || '').trim(),
  };
}

function normalizeEmphasisBlock(aiStrategy) {
  const primary = canonicalizeEmphasisLabel(aiStrategy?.primary_emphasis);
  const secondary = canonicalizeEmphasisLabel(aiStrategy?.secondary_emphasis);
  // Deprioritized may be array or string.
  let deprioritizedRaw = aiStrategy?.deprioritized_factors;
  if (typeof deprioritizedRaw === 'string') deprioritizedRaw = [deprioritizedRaw];
  if (!Array.isArray(deprioritizedRaw)) deprioritizedRaw = [];
  const deprioritized = Array.from(new Set(
    deprioritizedRaw.map(canonicalizeEmphasisLabel).filter(Boolean)
  ));
  return {
    primary,                                                // 'changeover'|'mts'|'profitability'|null
    secondary: secondary && secondary !== primary ? secondary : null,
    deprioritized,                                          // string[]
    deprioritizationReason: String(aiStrategy?.deprioritization_reason || '').trim(),
    tradeoffSummary:        String(aiStrategy?.tradeoff_summary || '').trim(),
  };
}

// Pretty label for display ("changeover" → "Changeover reduction").
function emphasisDimensionLabel(key) {
  if (key === 'changeover')    return 'Changeover reduction';
  if (key === 'mts')           return 'MTS advancement';
  if (key === 'profitability') return 'Profitability';
  return null;
}

// ─── AI profitability basis (TEST CONFIG — easily revertible) ──────────────
// Controls which signal the AI treats as "profitability" in:
//   • the 3-dimension analysis (Stage A.5 of the line strategy prompt)
//   • cluster tie-breaks inside execution refinement functions
//   • row-level sequence insight text in the AI-powered table
//   • the rightmost column of the AI-powered sequence table
//
// To restore the legacy profit-score behaviour, change this single constant
// to 'profit_score'. All consumers read from these exports — no further
// edits required.
export const AI_PROFITABILITY_BASIS = 'margin'; // 'margin' | 'profit_score'
export const AI_PROFITABILITY_LABEL        = AI_PROFITABILITY_BASIS === 'margin' ? 'Margin'  : 'Profit Score';
export const AI_PROFITABILITY_LABEL_LOWER  = AI_PROFITABILITY_BASIS === 'margin' ? 'margin'  : 'profit score';
export const AI_PROFITABILITY_LABEL_PLURAL = AI_PROFITABILITY_BASIS === 'margin' ? 'margins' : 'profit scores';

// Active profitability value reader. When basis === 'margin', returns the
// raw margin %; when 'profit_score', returns the legacy _profitRate
// (margin ÷ runtime-hours stamped by enrichWithMargin). The legacy
// _profitRate / _profitScore fields remain on order objects regardless of
// basis — they are simply no longer the active signal during margin mode.
export function getAIProfitabilityValue(order) {
  if (order == null) return 0;
  if (AI_PROFITABILITY_BASIS === 'margin') {
    return parseFloat(order.margin ?? order._margin ?? 0) || 0;
  }
  // Profit-score path — prefer stamped _profitRate / _profitScore; fall back
  // to margin ÷ production_hours so unstamped orders still receive a usable
  // ranking signal (preserves legacy behaviour for clean revert).
  const stamped = parseFloat(order._profitScore ?? order._profitRate ?? order.profit_score ?? NaN);
  if (!Number.isNaN(stamped) && stamped !== 0) return stamped;
  const margin  = parseFloat(order.margin ?? order._margin) || 0;
  const prodHrs = parseFloat(order.production_hours) || 0;
  return prodHrs > 0 ? margin / prodHrs : (Number.isNaN(stamped) ? 0 : stamped);
}

// Cluster tie-break reader — delegates to getAIProfitabilityValue so flipping
// AI_PROFITABILITY_BASIS automatically switches every intra-cluster sort
// without further edits. Kept as a named function for call-site readability.
function getProfitScoreFromOrder(order) {
  const value = getAIProfitabilityValue(order);
  if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'production') {
    console.debug('[AI Profitability Basis]', {
      activeBasis: AI_PROFITABILITY_BASIS,
      orderId: order?.id ?? order?.order_id,
      item: (order?.item_description || '').substring(0, 40),
      margin: parseFloat(order?.margin ?? order?._margin ?? 0) || 0,
      profitScore: parseFloat(order?._profitScore ?? order?._profitRate ?? 0) || 0,
      valueUsedForAI: value,
    });
  }
  return value;
}

// Build a quick lookup of {order_id → enriched order object} so the
// refinement helpers can read status / category / diameter without having
// to thread the original orders array everywhere.
// NOTE: enriched line orders carry `id` (not `order_id`). We accept both
// field names so the lookup is never accidentally empty.
function buildOrderLookup(lineOrders) {
  const map = new Map();
  for (const o of (lineOrders || [])) {
    const key = o?.id ?? o?.order_id;
    if (key != null) map.set(String(key), o);
  }
  return map;
}

// Top-level dispatcher. Returns a refined version of the AI's
// `[{order_id, position, suggested_date}, ...]` array. If the goal is
// unsupported (or one of the not-yet-implemented goals) we return the
// AI's array unchanged — the AI plan is still respected, we just don't
// refine it further.
function executeAIStrategyForLine({ aiOrderEntries, primaryGoal, lineOrders, secondaryEmphasis }) {
  if (!Array.isArray(aiOrderEntries) || aiOrderEntries.length === 0) return aiOrderEntries;
  const lookup = buildOrderLookup(lineOrders);
  switch (primaryGoal) {
    case 'advance_flexible_orders':
      return applyFlexibleDateAdvancementIntent(aiOrderEntries, lookup, secondaryEmphasis);
    case 'group_swine_by_diameter':
      return applySwineDiameterGroupingIntent(aiOrderEntries, lookup, secondaryEmphasis);
    case 'compress_compatible_runs':
      return applyCompressCompatibleRunsIntent(aiOrderEntries, lookup, secondaryEmphasis);
    case 'create_downstream_slack':
    case 'protect_late_window_capacity':
    case 'stabilize_mid_queue':
    case 'generic_optimization':
    default:
      return aiOrderEntries;
  }
}

// Helper: split AI entries into "anchored" (protected) and "movable"
// (flexible) buckets while preserving the AI's relative order in each
// bucket. Anchored entries keep their absolute index so the refined
// sequence interleaves movable entries around them without shifting any
// chronology-protected order out of place.
function partitionEntries(entries, lookup) {
  const anchored = []; // { entry, index }
  const movable  = []; // entry
  entries.forEach((entry, index) => {
    const order = lookup.get(String(entry?.order_id));
    if (order && isProtectedOrder(order)) {
      anchored.push({ entry, index });
    } else {
      movable.push(entry);
    }
  });
  return { anchored, movable };
}

// Reassemble a sequence from anchored entries (with fixed indices) plus
// an ordered list of movable entries. Movable entries fill all index
// slots not claimed by anchors, in the supplied order. If the resulting
// array is short anything (e.g. malformed inputs or duplicate ids in the
// AI response made bucket sizes inconsistent) we fall back to the
// original AI entries rather than silently shrink the line — losing
// orders before the safe-window clamp would degrade the preview far
// more than skipping the refinement.
function reassembleEntries(totalLength, anchored, movableInOrder, originalEntries) {
  const out = new Array(totalLength);
  for (const { entry, index } of anchored) {
    if (index >= 0 && index < totalLength) out[index] = entry;
  }
  let mi = 0;
  for (let i = 0; i < totalLength; i += 1) {
    if (out[i] === undefined) {
      out[i] = movableInOrder[mi];
      mi += 1;
    }
  }
  for (let i = 0; i < totalLength; i += 1) {
    if (!out[i]) {
      console.warn('[aiSequenceStrategies] strategy refinement produced an incomplete sequence; falling back to AI sequence as-is.');
      return originalEntries;
    }
  }
  return out;
}

// Refinement: ADVANCE_FLEXIBLE_ORDERS
// Bubble eligible flexible orders earlier in the sequence by sorting the
// movable bucket so flexible orders appear before any non-protected
// orders that the AI happened to place before them (rare but possible)
// and so they cluster toward the start. Anchored protected orders keep
// their original positions to preserve chronology.
function applyFlexibleDateAdvancementIntent(entries, lookup, secondaryEmphasis) {
  const { anchored, movable } = partitionEntries(entries, lookup);
  if (movable.length <= 1) return entries;
  // Movable bucket is already all-flexible (protected went to anchored).
  // Sort priority:
  //   1. Earliest suggested_date (primary advancement driver)
  //   2. Profit score DESC — when secondaryEmphasis is 'profitability' and
  //      dates are equal, higher-margin orders are scheduled first.
  //   3. Material compatibility (changeover reduction as final tiebreak)
  const profitabilitySecondary = secondaryEmphasis === 'profitability';
  const sortedMovable = movable.slice().sort((a, b) => {
    const da = String(a?.suggested_date || '');
    const db = String(b?.suggested_date || '');
    if (da !== db) return da < db ? -1 : 1;
    if (profitabilitySecondary) {
      const oa = lookup.get(String(a?.order_id));
      const ob = lookup.get(String(b?.order_id));
      const sa = getProfitScoreFromOrder(oa);
      const sb = getProfitScoreFromOrder(ob);
      if (Math.abs(sa - sb) > 0.01) return sb - sa; // higher profit first
    }
    const oa = lookup.get(String(a?.order_id));
    const ob = lookup.get(String(b?.order_id));
    if (oa && ob) return compareMaterialCompatibility(oa, ob);
    return 0;
  });
  // ── Deterministic date compression ────────────────────────────────────────
  // After sorting by AI-suggested dates, compress the movable sequence so
  // dates actually advance toward today+2 instead of staying at the original
  // avail dates. Starting from today+2 with 2-day spacing we assign earlier
  // dates to any entry whose AI-suggested date is later than the cursor.
  // We ONLY advance (cursor < aiDate) — never push an entry later.
  const _advT2 = new Date();
  _advT2.setDate(_advT2.getDate() + 2);
  let _advCursor = new Date(_advT2);
  for (const e of sortedMovable) {
    const aiDate = e.suggested_date || '';
    const cursorISO = _advCursor.toISOString().substring(0, 10);
    if (aiDate && cursorISO < aiDate) {
      e.suggested_date = cursorISO;
    }
    _advCursor.setDate(_advCursor.getDate() + 2);
  }
  return reassembleEntries(entries.length, anchored, sortedMovable, entries);
}

// Refinement: GROUP_SWINE_BY_DIAMETER
// Cluster swine orders sharing the same diameter so they appear adjacent
// in the movable bucket. Non-swine flexible orders keep their AI
// position relative to one another but are pushed to wherever leaves
// the swine clusters intact. Anchored protected orders are untouched.
function isSwineOrder(o) {
  return String(o?.category || '').trim().toLowerCase() === 'swine';
}

function applySwineDiameterGroupingIntent(entries, lookup, secondaryEmphasis) {
  const { anchored, movable } = partitionEntries(entries, lookup);
  if (movable.length <= 1) return entries;
  const profitabilitySecondary = secondaryEmphasis === 'profitability';
  // Group by category: swine first (clustered by diameter), then
  // non-swine in their original AI order.
  const swineByDiameter = new Map(); // diameter → entries[]
  const swineDiameterFirstSeen = new Map(); // diameter → firstIndex (for stable cluster order)
  const nonSwine = [];
  movable.forEach((entry, idx) => {
    const o = lookup.get(String(entry?.order_id));
    if (o && isSwineOrder(o)) {
      const dia = String(o.diameter || '').trim().toLowerCase() || '__no_dia__';
      if (!swineByDiameter.has(dia)) {
        swineByDiameter.set(dia, []);
        swineDiameterFirstSeen.set(dia, idx);
      }
      swineByDiameter.get(dia).push(entry);
    } else {
      nonSwine.push(entry);
    }
  });
  // Order diameter-clusters by where they first appeared in the AI
  // sequence so we don't arbitrarily reshuffle the AI's higher-level
  // intent (e.g. if AI led with 4.00mm cluster, keep 4.00mm leading).
  const orderedDiameters = Array.from(swineDiameterFirstSeen.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([dia]) => dia);
  const clusteredSwine = [];
  for (const dia of orderedDiameters) {
    let clusterEntries = swineByDiameter.get(dia);
    // When profitability is the secondary dimension, sort within each
    // diameter cluster by profit score DESC so higher-value orders run
    // first — the primary diameter-grouping objective is already satisfied.
    if (profitabilitySecondary && clusterEntries.length > 1) {
      clusterEntries = clusterEntries.slice().sort((a, b) => {
        const oa = lookup.get(String(a?.order_id));
        const ob = lookup.get(String(b?.order_id));
        return getProfitScoreFromOrder(ob) - getProfitScoreFromOrder(oa);
      });
      if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'production') {
        console.debug('[AI Cluster Profitability Check]', {
          clusterKey: `swine|${dia}`,
          profitabilitySecondary,
          orders: clusterEntries.map((e, i) => {
            const o = lookup.get(String(e?.order_id));
            return { index: i, orderId: e.order_id, item: (o?.item_description || '').substring(0, 40), date: e.suggested_date, profitScore: getProfitScoreFromOrder(o), diameter: o?.diameter };
          }),
        });
      }
    }
    clusteredSwine.push(...clusterEntries);
  }
  // Place the (now diameter-clustered) swine block first, then non-swine
  // flexibles. This visibly satisfies the strategy's grouping promise
  // while still respecting the AI's anchored protected positions.
  const sortedMovable = clusteredSwine.concat(nonSwine);
  return reassembleEntries(entries.length, anchored, sortedMovable, entries);
}

// Refinement: COMPRESS_COMPATIBLE_RUNS
// Groups flexible (movable) orders by category|color cluster key so that
// same-material orders appear adjacent in the pre-clamp position array.
// Clusters are ordered by their earliest AI-suggested date to preserve the
// AI's rough timeline intent. Anchored (firm) orders keep their original
// positions so the downstream date-sort still places them correctly.
function applyCompressCompatibleRunsIntent(entries, lookup, secondaryEmphasis) {
  const { anchored, movable } = partitionEntries(entries, lookup);
  if (movable.length <= 1) return entries;
  const profitabilitySecondary = secondaryEmphasis === 'profitability';

  const getCatKey = (e) => {
    const o = lookup.get(String(e?.order_id));
    return `${((o?.category) || '_').toLowerCase()}|${((o?.color) || '_').toLowerCase()}`;
  };

  // Group movable entries by category|color cluster key, recording the first
  // AI-sequence index at which each cluster appeared (for stable ordering).
  const clusterMap    = new Map();
  const firstSeenIdx  = new Map();
  movable.forEach((e, idx) => {
    const k = getCatKey(e);
    if (!clusterMap.has(k)) {
      clusterMap.set(k, []);
      firstSeenIdx.set(k, idx);
    }
    clusterMap.get(k).push(e);
  });

  // Order clusters by first-appearance index (preserves the AI's higher-level
  // intent — e.g. if the AI led with Poultry, keep Poultry leading).
  const orderedKeys = [...firstSeenIdx.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([k]) => k);

  // Within each cluster:
  //   1. Sort by suggested_date (chronological primary)
  //   2. When dates are equal and profitability is secondary → profit score DESC
  //   3. Diameter sub-sort: group same-diameter orders adjacent within the
  //      cluster to minimise intra-cluster changeover costs (a cluster of
  //      "Poultry|Yellow" orders may still incur diameter changeovers if
  //      diameters are interleaved — grouping 4.0mm together then 6.0mm etc.
  //      eliminates those intra-cluster transitions without breaking the
  //      primary category|color clustering intent)
  //   4. Final fallback: AI-suggested position (preserves AI ordering intent)
  const sortedMovable = [];
  for (const key of orderedKeys) {
    const clEntries = clusterMap.get(key).slice().sort((a, b) => {
      const da = String(a.suggested_date || '');
      const db = String(b.suggested_date || '');
      if (da !== db) return da < db ? -1 : 1;
      if (profitabilitySecondary) {
        const oa = lookup.get(String(a?.order_id));
        const ob = lookup.get(String(b?.order_id));
        const sa = getProfitScoreFromOrder(oa);
        const sb = getProfitScoreFromOrder(ob);
        if (Math.abs(sa - sb) > 0.01) return sb - sa; // higher profit first
      }
      // Diameter sub-sort: keep same-diameter orders adjacent within the cluster
      const oa2 = lookup.get(String(a?.order_id));
      const ob2 = lookup.get(String(b?.order_id));
      const dia_a = String(oa2?.diameter || '').trim().toLowerCase();
      const dia_b = String(ob2?.diameter || '').trim().toLowerCase();
      if (dia_a && dia_b && dia_a !== dia_b) return dia_a < dia_b ? -1 : 1;
      return (a.position || 0) - (b.position || 0);
    });
    if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'production') {
      console.debug('[AI Cluster Profitability Check]', {
        clusterKey: key,
        profitabilitySecondary,
        orders: clEntries.map((e, i) => {
          const o = lookup.get(String(e?.order_id));
          return { index: i, orderId: e.order_id, item: (o?.item_description || '').substring(0, 40), date: e.suggested_date, profitScore: getProfitScoreFromOrder(o), category: o?.category };
        }),
      });
    }
    sortedMovable.push(...clEntries);
  }

  return reassembleEntries(entries.length, anchored, sortedMovable, entries);
}

// ─── Validation helper ──────────────────────────────────────────────────────
// Count the number of disjoint contiguous segments a category forms in an
// order sequence. A perfectly clustered category has exactly 1 segment.
function countCategorySegments(orders, categoryName) {
  let segments = 0;
  let inSegment = false;
  for (const o of orders) {
    const isTarget = (o.category || '').toLowerCase() === categoryName.toLowerCase();
    if (isTarget && !inSegment)  { segments++;  inSegment = true; }
    else if (!isTarget)           { inSegment = false; }
  }
  return segments;
}

// ─── Post-sort cluster enforcer ─────────────────────────────────────────────
// After applyAISequenceToOrders sorts orders chronologically, firm orders
// with intermediate dates can split flexible material clusters. This pass
// detects category clusters that are non-contiguous due to interposing
// FLEXIBLE orders and moves those intruders to just after the cluster —
// without changing any dates (position-only fix so cascade dates stay valid).
//
// Rules:
//   • Only clusters with 2+ flexible members are examined.
//   • Firm orders (MTO/Critical/Urgent/Monitor) inside a cluster span form
//     an immovable "wall" — the enforcer logs a debug message and skips.
//   • When no firm wall exists, intruding flexible orders are extracted and
//     placed immediately after the last cluster member, preserving their
//     relative order.
//   • Multiple clusters are processed in sequence (each pass rebuilds seq).
function enforceContiguousClusters(orders) {
  if (!orders || orders.length <= 2) return orders;
  const isFirmO = o => isMTO(o) || FIRM_STATUSES.has(o._n10dStatus);
  const catKey  = o => `${(o.category || '_').toLowerCase()}|${(o.color || '_').toLowerCase()}`;

  // Count flexible members per cluster key — singletons need no work.
  const flexCountMap = new Map();
  for (const o of orders) {
    if (isFirmO(o)) continue;
    const k = catKey(o);
    flexCountMap.set(k, (flexCountMap.get(k) || 0) + 1);
  }
  const targetKeys = [...flexCountMap.entries()]
    .filter(([, n]) => n >= 2)
    .map(([k]) => k);
  if (targetKeys.length === 0) return orders;

  let seq = orders.slice();
  for (const key of targetKeys) {
    // Locate first and last positions of this cluster in the current sequence.
    let first = -1, last = -1;
    for (let i = 0; i < seq.length; i++) {
      if (!isFirmO(seq[i]) && catKey(seq[i]) === key) {
        if (first === -1) first = i;
        last = i;
      }
    }
    if (first === -1 || first === last) continue;

    // Detect firm walls between first and last.
    const firmWalls = [];
    for (let i = first + 1; i < last; i++) {
      if (isFirmO(seq[i])) firmWalls.push(seq[i]);
    }
    if (firmWalls.length > 0) {
      console.debug('[enforceContiguousClusters] firm wall prevents full consolidation of cluster:', key, {
        firmOrders: firmWalls.map(o => ({
          id: o.id,
          category: o.category,
          status: o._n10dStatus || (isMTO(o) ? 'MTO' : 'unknown'),
          reason: isMTO(o) ? 'mto_date_protection' : `${(o._n10dStatus || '').toLowerCase()}_deadline`,
        })),
      });
      continue;
    }

    // No firm walls — partition the span into cluster members and intruders.
    const clusterMembers = [];
    const intruders      = [];
    for (let i = first; i <= last; i++) {
      if (!isFirmO(seq[i]) && catKey(seq[i]) === key) {
        clusterMembers.push(seq[i]);
      } else {
        intruders.push(seq[i]);
      }
    }
    if (intruders.length === 0) continue; // already contiguous

    // Rebuild: [before] + [cluster block] + [displaced intruders] + [after].
    seq = [
      ...seq.slice(0, first),
      ...clusterMembers,
      ...intruders,
      ...seq.slice(last + 1),
    ];
    console.debug('[enforceContiguousClusters] consolidated cluster', key, {
      clusterSize:    clusterMembers.length,
      intrudersMoved: intruders.length,
    });
  }

  // Re-stamp sequential prio on the enforced sequence.
  seq.forEach((o, i) => { o.prio = i + 1; });
  return seq;
}

// Post-AI date enforcement: for any Sufficient order whose AI-suggested date
// equals its current effective avail date (the AI didn't move it), use the
// load-balancing heuristic (chooseBestBalancedDate) to find a genuinely better
// slot. This acts as a deterministic fallback for when the AI ignores RULE 4
// of the line prompt. Runs BEFORE applyAISequenceToOrders so improved dates
// flow through the safe-window clamp and chronological sort correctly.
// Updates a running dailyLoadMap so each sequential assignment sees the effect
// of earlier placements (no double-booking light days).
function enforceFlexibleDateMovesOnEntries(entries, lineOrders, line, changeoverRules, inferredTargetMap) {
  if (!entries || entries.length === 0) return entries;
  const lookup = buildOrderLookup(lineOrders);
  const earliest = new Date();
  earliest.setDate(earliest.getDate() + 2);
  const earliestISO = earliest.toISOString().substring(0, 10);
  const rules = changeoverRules || getFallbackChangeoverRules();

  // Seed load map from the line's current orders so we start from real load.
  const dailyLoadMap = buildDailyLoadMap(lineOrders, line);

  let movedCount = 0;
  const result = [];

  for (const e of entries) {
    const order = lookup.get(String(e?.order_id));
    if (!order) { result.push(e); continue; }

    // Protected orders are immutable — leave entirely alone.
    if (isMTO(order) || FIRM_STATUSES.has(order._n10dStatus)) {
      result.push(e);
      continue;
    }

    const effectiveAvail = getEffectiveAvailISO(order, inferredTargetMap);
    const aiDate = e.suggested_date;

    // AI already moved the date — respect it, just account for load.
    if (aiDate && effectiveAvail && aiDate !== effectiveAvail) {
      if (!dailyLoadMap.has(aiDate)) dailyLoadMap.set(aiDate, { orderCount: 0, totalHours: 0 });
      const bkt = dailyLoadMap.get(aiDate);
      bkt.orderCount += 1;
      bkt.totalHours += orderProductionHours(order, line);
      result.push(e);
      continue;
    }

    // AI returned the same date as current (or no date) — find a better slot.
    const safeEnd = effectiveAvail
      ? (() => { const d = new Date(effectiveAvail); d.setDate(d.getDate() + 14); return d.toISOString().substring(0, 10); })()
      : (() => { const d = new Date(); d.setDate(d.getDate() + 24); return d.toISOString().substring(0, 10); })();

    const bestDate = chooseBestBalancedDate(
      order, line, lineOrders,
      { start: earliestISO, end: safeEnd },
      dailyLoadMap, rules,
    );

    // Update load map with this new assignment so subsequent orders see it.
    if (!dailyLoadMap.has(bestDate)) dailyLoadMap.set(bestDate, { orderCount: 0, totalHours: 0 });
    const bucket = dailyLoadMap.get(bestDate);
    bucket.orderCount += 1;
    bucket.totalHours += orderProductionHours(order, line);

    const moved = bestDate !== effectiveAvail;
    if (moved) movedCount++;

    const newEntry = { ...e, suggested_date: bestDate };
    if (!newEntry.reasoning && moved) {
      newEntry.reasoning = `Heuristic date move: ${effectiveAvail || 'unset'} → ${bestDate} (AI kept original; load-balancing heuristic found lighter slot).`;
    }

    console.debug('[AI Date Suggestion]', {
      orderId:     order.id,
      item:        (order.item_description || '').substring(0, 40),
      status:      order._n10dStatus || 'Sufficient',
      originalDate: effectiveAvail,
      aiDate:       aiDate || null,
      chosenDate:   bestDate,
      safeWindow:   { earliest: earliestISO, latest: safeEnd },
      moved,
    });

    result.push(newEntry);
  }

  if (movedCount > 0) {
    console.debug(`[AI Date Enforcement] Heuristic moved ${movedCount} Sufficient order(s) off their original avail date on ${line}.`);
  }

  return result;
}

// Apply one AI-returned strategy to a single line's enriched orders. Reuses
// the existing safe-window clamp pipeline by wrapping the line's orders in a
// {[line]: [...]} map, then unwraps the result back to a flat array. Each
// surviving order is stamped with strategy meta so the modal-side insight
// fallback can show the AI-generated name/reasoning instead of placeholders.
// ─── Strategy claim alignment helpers ─────────────────────────────────────
// Build a factually-correct short description derived from the ACTUAL final
// sequence rather than the AI's pre-execution intent text.
function _buildFinalSequenceDescription(finalOrders, standardOrders, changeoverRules) {
  const n = finalOrders.length;
  if (!n) return '';
  const first = finalOrders[0];
  const last  = finalOrders[n - 1];
  const firstCat = (first?.category || '').trim();
  const lastCat  = (last?.category  || '').trim();

  const stdCO   = calculateTotalChangeoverTime(standardOrders || [], changeoverRules);
  const finalCO = calculateTotalChangeoverTime(finalOrders, changeoverRules);
  const saved   = Number((stdCO - finalCO).toFixed(2));

  const stdPosById = new Map((standardOrders || []).map((o, i) => [String(o.id), i]));
  const movedCount = finalOrders.filter((o, i) => {
    const si = stdPosById.get(String(o.id));
    return si != null && Math.abs(si - i) >= 1 && !isProtectedOrder(o);
  }).length;

  if (firstCat && lastCat && firstCat !== lastCat) {
    const savingStr = saved > 0 ? ` Achieves ${saved}h changeover saving vs Standard.` : '';
    return `Runs the ${firstCat} block first and closes with ${lastCat} to group compatible materials and reduce inter-category transitions.${savingStr}`;
  }
  if (movedCount > 0 && saved > 0) {
    return `Repositions ${movedCount} flexible order${movedCount !== 1 ? 's' : ''} from the Standard baseline, reducing total changeover by ${saved}h.`;
  }
  if (movedCount > 0) {
    return `Repositions ${movedCount} flexible order${movedCount !== 1 ? 's' : ''} for improved scheduling continuity.`;
  }
  return '';
}

// Detect and fix positional claims in AI-generated description/reasoning that
// contradict the actual final After-table sequence.  The deterministic
// execution layer (executeAIStrategyForLine, applyAISequenceToOrders,
// enforceContiguousClusters) can produce a different ordering from what the
// AI intended, so we must validate claims AFTER the final sequence is known.
function _sanitizeStrategyTexts({ rawDescription, reasoningSummary, differenceFromStandard, finalOrders, standardOrders, changeoverRules, strategyName }) {
  const combinedText = `${rawDescription} ${reasoningSummary} ${differenceFromStandard}`;
  const catMatchIdx  = (cat) => finalOrders.findIndex(o =>
    String(o?.category || '').trim().toLowerCase() === cat.toLowerCase()
  );

  // Claim patterns: [regex, category to check, claimed position]
  const CLAIM_PATTERNS = [
    { regex: /\b(places?|moves?|puts?|keeps?|runs?|sends?)\s+(the\s+)?(single\s+)?(swine)\s+(order\s+)?(last|at\s+(the\s+)?end|to\s+(the\s+)?last|to\s+position\s+\d+\s+last)/i,  cat: 'Swine', claimedPos: 'last'  },
    { regex: /\b(swine)\s+(order\s+)?((runs?|goes?|is\s+placed?|placed?)\s+)?last\b/i,                                                                                            cat: 'Swine', claimedPos: 'last'  },
    { regex: /\bby\s+moving\s+(the\s+)?swine\s+(order\s+)?to\s+(last|the\s+end)\b/i,                                                                                             cat: 'Swine', claimedPos: 'last'  },
    { regex: /\b(places?|moves?|puts?|keeps?|runs?)\s+(the\s+)?(single\s+)?(swine)\s+(order\s+)?(first|at\s+(the\s+)?start|to\s+position\s+1)\b/i,                               cat: 'Swine', claimedPos: 'first' },
    { regex: /\bswine\s+(order\s+)?(is\s+)?moved\s+to\s+(last|the\s+end|position\s+\d+)\b/i,                                                                                     cat: 'Swine', claimedPos: 'last'  },
  ];

  const falseClaimDetails = [];
  for (const { regex, cat, claimedPos } of CLAIM_PATTERNS) {
    if (!regex.test(combinedText)) continue;
    const idx = catMatchIdx(cat);
    if (idx < 0) continue; // category not present — can't validate
    const isActuallyLast  = idx === finalOrders.length - 1;
    const isActuallyFirst = idx === 0;
    const holds = claimedPos === 'last' ? isActuallyLast : isActuallyFirst;
    if (!holds) {
      falseClaimDetails.push({ cat, claimedPos, actualPosition: idx + 1, totalOrders: finalOrders.length });
    }
  }

  const swineFinalIdx = catMatchIdx('Swine');
  console.debug('[Strategy Claim Alignment]', {
    strategyName,
    description: rawDescription.substring(0, 140),
    hasFalseClaim: falseClaimDetails.length > 0,
    falseClaimDetails,
    swineFinalPosition: swineFinalIdx >= 0 ? swineFinalIdx + 1 : null,
    totalOrders: finalOrders.length,
    finalOrders: finalOrders.map((o, i) => ({
      position: i + 1,
      orderId: o.id,
      item: (o.item_description || '').substring(0, 40),
      category: o.category,
    })),
  });

  if (falseClaimDetails.length === 0) {
    return { description: rawDescription, reasoningSummary, differenceFromStandard, wasSanitized: false };
  }

  // Build a factually correct replacement description from the actual sequence
  const correctedDesc = _buildFinalSequenceDescription(finalOrders, standardOrders, changeoverRules)
    || rawDescription
        .replace(/\b(places?|moves?|puts?)\s+(the\s+)?(single\s+)?swine\s+(order\s+)?last\b/gi, 'repositions Swine orders within the sequence')
        .replace(/\bby\s+moving\s+(the\s+)?swine\s+(order\s+)?to\s+(last|the\s+end)\b/gi, 'by repositioning Swine orders');

  // Soft-patch reasoning — neutralise provably-false move sentences
  const sanitizedReasoning = reasoningSummary
    .replace(/[Bb]y moving (the\s+)?[Ss]wine (order\s+)?to (last|the end)[,.]?/g, 'By repositioning Swine orders,')
    .replace(/[Mm]oving (the\s+)?[Ss]wine (order\s+)?to (last|the end)/gi, 'repositioning Swine orders')
    .replace(/[Ss]wine order moves? from position \d+ to \d+/gi,
      swineFinalIdx >= 0 ? `Swine order is at position ${swineFinalIdx + 1}` : 'Swine order repositioned');

  // Soft-patch differenceFromStandard
  const sanitizedDiff = differenceFromStandard
    .replace(/[Ss]wine order moves? from position \d+ to \d+/gi,
      swineFinalIdx >= 0 ? `Swine order remains at position ${swineFinalIdx + 1}` : 'Swine order repositioned')
    .replace(/,?\s*Poultry orders? move up[,.]?/gi, '')
    .trim();

  return { description: correctedDesc, reasoningSummary: sanitizedReasoning, differenceFromStandard: sanitizedDiff, wasSanitized: true };
}

// ─── Schedule-feasibility enforcement ─────────────────────────────────────
// Validates _aiSuggestedDate for every order against the actual production
// timeline.  The cursor simulation mirrors computeAtRiskOrders: it advances
// a running clock from 08:00 AM today, consuming (production + changeover)
// hours per order.  When the clock's calendar date differs from the order's
// _aiSuggestedDate we have a completion-day mismatch — the AI suggested a
// date the order cannot actually finish on.
//
// Resolution: update _aiSuggestedDate to the completion date (never MTO).
// Protected (Critical/Urgent/Monitor) dates are also moved when infeasible —
// the correction only shifts them forward so the displayed date remains
// meaningful (an Urgent order showing May 11 when it will actually finish
// May 12 is more misleading than showing May 12 outright).
//
// The function mutates the array in-place and returns it so callers can
// chain it without additional variables.
//
// Emits: [AI Suggested Date Feasibility] per order (spec §10).
function enforceCompletionFeasibility(orderedOrders, line, changeoverRules, inferredTargetMap, strategyTitle) {
  if (!orderedOrders || orderedOrders.length === 0) return orderedOrders;

  const runRate = getLineRunRate(line);
  const toISO = (d) =>
    `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

  // Running cursor: 8:00 AM today is the earliest production start.
  const cursor = new Date();
  cursor.setHours(8, 0, 0, 0);

  // Track cumulative hours per day for the debug log's context field.
  const dayUsed = new Map();

  for (const order of orderedOrders) {
    const vol      = parseFloat(order.volume_override || order.volume || order.total_volume_mt || 0) || 0;
    // Prefer the stored production_hours (the authoritative value shown in the
    // modal and computed by the sequencing pipeline) over vol/runRate, which can
    // give wrong results when volume is in batches rather than MT.  This mirrors
    // the pattern used by applyPreviewChangeovers and all display helpers.
    const prodHrs  = parseFloat(order.production_hours) || (runRate > 0 ? vol / runRate : 0);
    const coHrs    = parseFloat(order._changeoverTotal ?? order.changeover_time ?? 0) || 0;
    const orderHrs = prodHrs + coHrs;

    const candidateDate = order._aiSuggestedDate;

    // Save cursor position BEFORE we advance it to candidateDate's 8 AM.
    // This represents when all prior orders in the sequence actually finish
    // and is needed for the FIRM ceiling back-calculation below.
    const cursorBeforeAdvance = new Date(cursor.getTime());

    // If the order has a future suggested date, advance the cursor to
    // 8:00 AM of that day so earlier-completed orders don't bleed into it.
    if (candidateDate && /^\d{4}-\d{2}-\d{2}/.test(candidateDate)) {
      // PHT 8 AM = UTC midnight of the same date
      const dayStart = new Date(`${candidateDate}T00:00:00.000Z`);
      if (cursor < dayStart) cursor.setTime(dayStart.getTime());
    }

    const cumulativeBefore = dayUsed.get(toISO(cursor)) || 0;

    // Capture exact start moment (after any day-advance, before adding order hours).
    // Stamped on the order below as _aiEstimatedStart so the AI insight builder
    // can cite the real start time instead of just a boolean flag.
    const orderStartTime = new Date(cursor.getTime());

    // Project completion
    const completionTime = new Date(cursor.getTime() + orderHrs * 3_600_000);
    const completionISO  = toISO(completionTime);

    const dateAccepted = !candidateDate || completionISO <= candidateDate;
    const fallbackDate = dateAccepted ? null : completionISO;

    // ── Avail vs Estimated Completion check (all orders with a known deadline) ─
    // Used as a guide/signal only — never a hard blocker. The only true delay
    // risk is when completion > end-of-avail-date (23:59:59).  Completion
    // earlier than the avail date is always acceptable and should not trigger
    // any forced correction or warning.
    const effectiveAvailAll = getEffectiveAvailISO(order, inferredTargetMap);
    // PHT 23:59:59 = UTC 15:59:59 of the same date (UTC+8, so 23:59−8 = 15:59 UTC)
    const availDateEnd = effectiveAvailAll ? new Date(`${effectiveAvailAll}T15:59:59.999Z`) : null;
    const isCompletionAfterAvailDate = availDateEnd ? completionTime > availDateEnd : false;
    // Stamp on the order so insight context and downstream consumers can
    // surface the delay-risk signal without repeating this calculation.
    order._aiCompletionAfterAvail = isCompletionAfterAvailDate;

    if (effectiveAvailAll) {
      console.debug('[AI Avail vs Estimated Completion Check]', {
        orderId:                      order.id,
        availDate:                    effectiveAvailAll,
        projectedEstimatedCompletion: completionTime.toISOString().replace('T', ' ').substring(0, 16),
        startDateTime:                cursor.toISOString().replace('T', ' ').substring(0, 16),
        isCompletionAfterAvailDate,
        isCompletionBeforeAvailDate:  !isCompletionAfterAvailDate,
        usingAsGuideOnly:             true,
      });
    }

    if (candidateDate) {
      const ordersBeforeOnDate = orderedOrders
        .filter(o => (o._aiSuggestedDate || '') === candidateDate
                   && String(o.id) !== String(order.id))
        .slice(0, 5)
        .map(o => ({
          orderId:         o.id,
          productionHours: parseFloat(o.production_hours) || 0,
          changeoverHours: parseFloat(o._changeoverTotal ?? o.changeover_time ?? 0) || 0,
        }));

      const isFirmForLog     = FIRM_STATUSES.has(order._n10dStatus);
      // Re-use the already-computed avail (avoids a second map lookup).
      const effectiveAvailForLog = isFirmForLog ? effectiveAvailAll : null;
      const ceilingProtected = isFirmForLog && !dateAccepted
        && (!effectiveAvailForLog || fallbackDate > effectiveAvailForLog);

      console.debug('[AI Suggested Date Feasibility]', {
        strategyTitle,
        orderId:                  order.id,
        item:                     (order.item_description || '').substring(0, 50),
        n10dStatus:               order._n10dStatus || 'Sufficient',
        candidateDate,
        ordersBeforeOnDate,
        cumulativeHoursBefore:    parseFloat(cumulativeBefore.toFixed(2)),
        orderProductionHours:     parseFloat(prodHrs.toFixed(2)),
        orderChangeoverHours:     parseFloat(coHrs.toFixed(2)),
        projectedCompletion:      completionTime.toISOString().replace('T', ' ').substring(0, 19),
        dayEnd:                   `${candidateDate} 23:59:59`,
        suggestedDateAccepted:    dateAccepted,
        fallbackNextFeasibleDate: fallbackDate,
        // For FIRM orders: was the ceiling protection triggered?
        // true  → completion overflowed the avail ceiling; date NOT pushed
        // false → no overflow or order is not FIRM; normal bump applies
        firmCeilingProtected:     ceilingProtected,
        effectiveAvailCeiling:    effectiveAvailForLog,
      });
    }

    // ── Adjust date if infeasible (MTO contracts are never touched) ──────────
    // After any adjustment we must recompute the effective completion time
    // from the (potentially repositioned) cursor so the cursor carried into
    // the next iteration is always accurate.
    let effectiveCompletionTime = completionTime; // may be updated below

    if (!dateAccepted && !isMTO(order)) {
      const isFirm = FIRM_STATUSES.has(order._n10dStatus);
      // Re-use the avail already computed above (avoids a third map lookup).
      const effectiveAvail = effectiveAvailAll;

      // Universal back-calc advance: any non-MTO order with a known deadline
      // that overflows its candidateDate gets a chance to be ADVANCED to an
      // earlier day so completion lands within the deadline. Previously this
      // protected only Critical/Urgent/Monitor (FIRM) — Sufficient/Flexible
      // were forward-bumped past their target instead, causing late risk on
      // long-running orders sitting on underutilized late days.
      const overflowsCeiling = effectiveAvail && completionISO > effectiveAvail;

      if (overflowsCeiling) {
        // Back-calculate the latest 8 AM start that finishes on or before the
        // deadline (23:59:59 of effectiveAvail).
        const deadlineMoment = new Date(`${effectiveAvail}T23:59:59`);
        const latestStart    = new Date(deadlineMoment.getTime() - orderHrs * 3_600_000);

        // Find latest 8 AM ≤ latestStart
        const advancedDay = new Date(latestStart);
        advancedDay.setHours(8, 0, 0, 0);
        if (advancedDay > latestStart) {
          advancedDay.setDate(advancedDay.getDate() - 1);
          advancedDay.setHours(8, 0, 0, 0);
        }

        // Use cursorBeforeAdvance (true feasibility boundary — when prior
        // orders actually finish), not cursor (which was pushed forward to
        // 8 AM of candidateDate purely for the projection).
        if (advancedDay >= cursorBeforeAdvance) {
          // Slot is available — advance the order to this earlier day.
          const advancedISO = toISO(advancedDay);
          order._aiSuggestedDate = advancedISO;
          order._aiSuggestedDateIsFlexible = isFirm
            ? false
            : (order._aiSuggestedDateIsFlexible ?? true);
          const newStart = advancedDay >= cursorBeforeAdvance ? advancedDay : cursorBeforeAdvance;
          cursor.setTime(newStart.getTime());
          effectiveCompletionTime = new Date(cursor.getTime() + orderHrs * 3_600_000);

          // Stamp a timing-grounded reason and prepend to AI reasoning so
          // downstream insight rendering surfaces the real "why". Save the
          // original AI text once into _aiReasoningOriginal so re-stamping
          // (e.g. gap-fill on top of feasibility) doesn't compound prefixes
          // and always reflects the latest _aiFeasibilityReason.
          const startTimeStr = `${String(cursorBeforeAdvance.getHours()).padStart(2,'0')}:${String(cursorBeforeAdvance.getMinutes()).padStart(2,'0')}`;
          const projCompletionStr = completionTime.toISOString().replace('T', ' ').substring(0, 16);
          order._aiFeasibilityReason =
            `Advanced from ${candidateDate} to ${advancedISO}: keeping it on ${candidateDate} would start at ${startTimeStr} ` +
            `and finish at ${projCompletionStr}, exceeding the avail date (${effectiveAvail}).`;
          if (order._aiReasoningOriginal === undefined) {
            order._aiReasoningOriginal = order._aiReasoning || '';
          }
          const aiSuffix = order._aiReasoningOriginal ? ` (AI: ${order._aiReasoningOriginal})` : '';
          order._aiReasoning = order._aiFeasibilityReason + aiSuffix;

          console.debug('[AI Delay-Aware Advancement]', {
            orderId:                  order.id,
            n10dStatus:               order._n10dStatus || 'Sufficient',
            targetAvailDate:          effectiveAvail,
            candidateStart:           cursorBeforeAdvance.toISOString().replace('T',' ').substring(0,16),
            productionHours:          parseFloat(orderHrs.toFixed(2)),
            projectedCompletion:      projCompletionStr,
            completesWithinTargetDate: false,
            advancedEarlier:          true,
            suggestedDate:            advancedISO,
          });
          console.debug('[AI Sequence Insight Reason]', {
            orderId:             order.id,
            primaryReason:       'delay_avoidance',
            targetAvailDate:     effectiveAvail,
            projectedStart:      cursorBeforeAdvance.toISOString().replace('T',' ').substring(0,16),
            projectedCompletion: projCompletionStr,
            suggestedDate:       advancedISO,
          });
          // Legacy log retained for compatibility with existing dashboards.
          console.debug('[AI Feasibility Ceiling Advance]', {
            strategyTitle,
            orderId:        order.id,
            n10dStatus:     order._n10dStatus,
            originalDate:   candidateDate,
            advancedDate:   advancedISO,
            newCompletion:  effectiveCompletionTime.toISOString().replace('T', ' ').substring(0, 16),
            deadline:       `${effectiveAvail} 23:59:59`,
            reason:         `production ${orderHrs.toFixed(2)}h overflows ${candidateDate}; backed up to fit ceiling`,
          });
        } else {
          // Cannot advance — bump the displayed date forward to the actual
          // completion date for ALL orders (FIRM and non-FIRM alike).
          // computeAtRiskOrders uses getEffectiveAvailISO (the original
          // target_avail_date), not _aiSuggestedDate, so at-risk detection
          // is unaffected. Showing the real completion date is always more
          // meaningful than preserving a stale deadline the order cannot meet.
          // FIRM orders keep isFlexible=false to preserve their characteristics.
          order._aiSuggestedDate           = completionISO;
          order._aiSuggestedDateIsFlexible = isFirm ? false : (order._aiSuggestedDateIsFlexible ?? true);
        }
      } else {
        // Overflowed candidateDate but either:
        //   a) completion is still within the avail deadline, OR
        //   b) no avail deadline is known (FIRM or non-FIRM).
        // In ALL cases stamp the real completion date. A stale earlier date is
        // always more misleading than showing when production actually finishes.
        // This closes the previous gap where FIRM orders with no effectiveAvail
        // were silently left at an infeasible candidateDate.
        order._aiSuggestedDate           = completionISO;
        order._aiSuggestedDateIsFlexible = isFirm ? false : (order._aiSuggestedDateIsFlexible ?? true);
      }
    }

    // Stamp the exact cursor-computed start and completion times so the AI
    // insight builder receives real datetimes, not just a boolean flag.
    // These reflect any date adjustments made above (advance/bump).
    order._aiEstimatedStart      = orderStartTime.toISOString().replace('T', ' ').substring(0, 16);
    order._aiEstimatedCompletion = effectiveCompletionTime.toISOString().replace('T', ' ').substring(0, 16);

    // Mark as an unresolved delay-risk when:
    //   • completion exceeds the avail date (real timing conflict), AND
    //   • no feasibility advancement was applied (_aiFeasibilityReason is null).
    // Covers two cases:
    //   a) FIRM orders where advancement wasn't feasible — date stays at original
    //   b) non-FIRM orders that were forward-bumped but still complete after avail
    // The insight builder uses this flag to lead with a clear delay-risk statement
    // instead of treating the current date suggestion as valid.
    order._aiDelayRiskUnresolved = order._aiCompletionAfterAvail === true && !order._aiFeasibilityReason;

    // Accumulate daily usage and advance the cursor.
    const assignedDate = order._aiSuggestedDate || toISO(cursor);
    dayUsed.set(assignedDate, (dayUsed.get(assignedDate) || 0) + orderHrs);
    cursor.setTime(effectiveCompletionTime.getTime());
  }

  return orderedOrders;
}

// ─── Gap-filling pass ──────────────────────────────────────────────────────
// Pulls movable Sufficient/Flexible orders into underutilized early days so
// production capacity isn't wasted while later days are overloaded. Runs
// AFTER enforceCompletionFeasibility so all dates are already feasible-safe.
//
// Hard constraints on candidates:
//   • not MTO (contracts immutable)
//   • not FIRM (Critical/Urgent/Monitor — feasibility already placed them)
//   • no manually-set start_date (user anchor wins)
//   • production+changeover hours fit in the day's remaining capacity
//   • a full cursor-sweep validation confirms no order in the resulting
//     sequence completes past its own avail-date deadline
//
// Underutilized = day total < UNDERUTILIZED_THRESHOLD hours (12h for MTS primary, 16h for secondary).
// Emits: [AI Gap Fill Evaluation] per evaluated day, [AI Sequence Insight Reason] per move.
function applyGapFillingPass(orderedOrders, line, inferredTargetMap, strategyTitle, emphasis, mtsConsideration) {
  if (!orderedOrders || orderedOrders.length === 0) return orderedOrders;

  // ── Strategy gating: gap-fill is MTS-aligned behavior ────────────────────
  // Full gap-fill (12h threshold): MTS is primary emphasis.
  // Reduced gap-fill (16h threshold): MTS is secondary (less aggressive).
  // Skip entirely: MTS is deprioritized, or not in emphasis at all.
  const mtsDeprioritized = Array.isArray(emphasis?.deprioritized)
    ? emphasis.deprioritized.some(d => /^mts/i.test(String(d)))
    : /^mts/i.test(String(emphasis?.deprioritized || ''));
  const mtsPrimary   = emphasis?.primary   === 'mts';
  const mtsSecondary = emphasis?.secondary === 'mts';
  if (mtsDeprioritized || (!mtsPrimary && !mtsSecondary)) {
    console.debug('[AI Gap Fill Skipped] MTS not in strategy emphasis', {
      strategyTitle,
      primary:       emphasis?.primary   || null,
      secondary:     emphasis?.secondary || null,
      deprioritized: emphasis?.deprioritized || [],
    });
    return orderedOrders;
  }

  const DAY_CAP_HRS = 24;
  // Full strength for MTS primary; raise bar for secondary so gap-fill is
  // less disruptive when the strategy's primary goal is something else.
  const UNDERUTILIZED_THRESHOLD = mtsPrimary ? 12 : 16;
  const toISO = (d) =>
    `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

  const orderHrs = (o) =>
    (parseFloat(o.production_hours) || 0)
    + (parseFloat(o._changeoverTotal ?? o.changeover_time ?? 0) || 0);

  // Canonical comparator — must match the final sort applied in
  // applyLineAIStrategy, otherwise validate() can approve a move under one
  // intra-day order that the final emitted sequence won't honor.
  const canonicalCompare = (a, b) => {
    const dA = effectiveProductionDateKey(a);
    const dB = effectiveProductionDateKey(b);
    if (dA < dB) return -1;
    if (dA > dB) return  1;
    const posA = a._aiPosition ?? Infinity;
    const posB = b._aiPosition ?? Infinity;
    if (posA !== posB) return posA - posB;
    return (a._originalIndex ?? 0) - (b._originalIndex ?? 0);
  };

  // Cursor sim → Map<orderId, completionDate>. Same model as feasibility pass.
  function simulate(seq) {
    // PHT 8 AM today = UTC midnight today (PHT = UTC+8, so 8AM−8h = 0AM UTC)
    const _todayPHT = new Date(new Date().getTime() + _PHT_MS).toISOString().substring(0, 10);
    const cursor = new Date(`${_todayPHT}T00:00:00.000Z`);
    const completions = new Map();
    for (const o of seq) {
      const candidate = o._aiSuggestedDate;
      if (candidate && /^\d{4}-\d{2}-\d{2}/.test(candidate)) {
        // PHT 8 AM = UTC midnight of same date
        const dayStart = new Date(`${candidate}T00:00:00.000Z`);
        if (cursor < dayStart) cursor.setTime(dayStart.getTime());
      }
      const completion = new Date(cursor.getTime() + orderHrs(o) * 3_600_000);
      completions.set(String(o.id), completion);
      cursor.setTime(completion.getTime());
    }
    return completions;
  }

  // Validate: every order must satisfy two constraints:
  //   1. Completes before its hard avail deadline (when known).
  //   2. Completes within its own suggested production day — prevents gap-fill
  //      from pulling an order back to a day it physically cannot finish on.
  //      Without this, a 16h order bumped from May 13→May 14 by the feasibility
  //      pass would be pulled back to May 13 (underutilized) because gap-fill
  //      only checked remaining hours capacity, not whether completion stays
  //      within that calendar day.
  function validate(seq) {
    const completions = simulate(seq);
    for (const o of seq) {
      const comp = completions.get(String(o.id));
      if (!comp) continue;
      // Constraint 1: hard avail deadline
      const eff = getEffectiveAvailISO(o, inferredTargetMap);
      if (eff && comp > new Date(`${eff}T23:59:59`)) return false;
      // Constraint 2: completion must not spill past the suggested production day
      const sugDate = o._aiSuggestedDate;
      if (sugDate && /^\d{4}-\d{2}-\d{2}/.test(sugDate)) {
        if (comp > new Date(`${sugDate}T23:59:59`)) return false;
      }
    }
    return true;
  }

  function buildDayUsage(seq) {
    const map = new Map();
    for (const o of seq) {
      const date = o._aiSuggestedDate;
      if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) continue;
      map.set(date, (map.get(date) || 0) + orderHrs(o));
    }
    return map;
  }

  let madeChange = true;
  let safety = 0;
  while (madeChange && safety < 20) {
    madeChange = false;
    safety++;

    const dayUsage = buildDayUsage(orderedOrders);
    const sortedDays = [...dayUsage.keys()].sort();

    for (const day of sortedDays) {
      const used = dayUsage.get(day) || 0;
      if (used >= UNDERUTILIZED_THRESHOLD) continue;
      const remaining = DAY_CAP_HRS - used;

      const candidates = orderedOrders.filter(o => {
        if (isMTO(o)) return false;
        // Critical orders are true anchors — never gap-filled.
        // Urgent and Monitor can fill gaps (moving them EARLIER is safe;
        // validate() enforces their hard avail-date ceiling so they can
        // never be pushed later than their original date).
        if (isCritical(o)) return false;
        if (o.start_date) return false;
        if (!o._aiSuggestedDate || !/^\d{4}-\d{2}-\d{2}/.test(o._aiSuggestedDate)) return false;
        if (o._aiSuggestedDate <= day) return false;
        return orderHrs(o) <= remaining;
      });

      if (candidates.length === 0) continue;

      // Prefer largest-fit so we maximize utilization in one move.
      candidates.sort((a, b) => orderHrs(b) - orderHrs(a));

      console.debug('[AI Gap Fill Evaluation]', {
        strategyTitle,
        line,
        underutilizedDate: day,
        remainingHours:    parseFloat(remaining.toFixed(2)),
        candidateOrders:   candidates.slice(0, 5).map(o => ({
          orderId:         o.id,
          availDate:       getEffectiveAvailISO(o, inferredTargetMap),
          productionHours: parseFloat((parseFloat(o.production_hours) || 0).toFixed(2)),
          changeoverHours: parseFloat((parseFloat(o._changeoverTotal ?? o.changeover_time ?? 0) || 0).toFixed(2)),
          movable:         true,
        })),
        selectedOrderIds:  [],
      });

      // Try each candidate; apply the first one whose trial sequence validates.
      let movedId = null;
      for (const cand of candidates) {
        const originalDate = cand._aiSuggestedDate;
        // Build trial: shallow-clone the candidate with the new date so we can
        // sort with the canonical comparator (which reads _aiSuggestedDate
        // via effectiveProductionDateKey) without mutating the live order.
        const trialCand = { ...cand, _aiSuggestedDate: day };
        const trial = orderedOrders.map(o => o === cand ? trialCand : o);
        trial.sort(canonicalCompare);

        if (validate(trial)) {
          cand._aiSuggestedDate = day;
          cand._aiFeasibilityReason =
            `Advanced from ${originalDate} to ${day}: filled an underloaded production day ` +
            `(${used.toFixed(1)}h used of ${DAY_CAP_HRS}h) while preserving avail-date safety.`;
          if (cand._aiReasoningOriginal === undefined) {
            cand._aiReasoningOriginal = cand._aiReasoning || '';
          }
          const aiSuffix = cand._aiReasoningOriginal ? ` (AI: ${cand._aiReasoningOriginal})` : '';
          cand._aiReasoning = cand._aiFeasibilityReason + aiSuffix;
          movedId = cand.id;

          console.debug('[AI Sequence Insight Reason]', {
            orderId:             cand.id,
            primaryReason:       'underutilized_day_filling',
            targetAvailDate:     getEffectiveAvailISO(cand, inferredTargetMap),
            projectedStart:      `${day} 08:00`,
            projectedCompletion: null,
            suggestedDate:       day,
          });

          orderedOrders.sort(canonicalCompare);

          madeChange = true;
          break;
        }
      }

      if (movedId) break; // restart day scan from top
    }
  }

  return orderedOrders;
}

// Cursor-simulates the final ordered sequence and stamps _aiSuggestedStartDate /
// _aiSuggestedStartTime on each order so the preview table can show a meaningful
// AI-derived start hint for non-first orders (Part 4).
// Orders that already have a user-set start_date are skipped — user anchor wins.
// Mutates orderedOrders in-place.
function computeAISuggestedStartTimes(orderedOrders) {
  if (!orderedOrders || orderedOrders.length === 0) return;
  const toISO = (d) =>
    `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const cursor = new Date();
  cursor.setHours(8, 0, 0, 0);

  for (const order of orderedOrders) {
    const prodHrs = parseFloat(order.production_hours) || 0;
    const coHrs   = parseFloat(order._changeoverTotal ?? order.changeover_time ?? 0) || 0;
    const orderHrs = prodHrs + coHrs;

    // If the AI scheduled this order on a later day, jump the cursor to 08:00
    // of that day (matching the same advance logic used in enforceCompletionFeasibility).
    const suggestedDay = order._aiSuggestedDate;
    if (suggestedDay && /^\d{4}-\d{2}-\d{2}/.test(suggestedDay)) {
      const dayStart = new Date(`${suggestedDay}T08:00:00`);
      if (dayStart > cursor) cursor.setTime(dayStart.getTime());
    }

    // Stamp only when no user override exists (user anchor always wins).
    if (!order._userSetStartDate && !order.start_date) {
      order._aiSuggestedStartDate = toISO(cursor);
      order._aiSuggestedStartTime =
        `${String(cursor.getHours()).padStart(2,'0')}:${String(cursor.getMinutes()).padStart(2,'0')}`;
    }

    if (orderHrs > 0) cursor.setTime(cursor.getTime() + orderHrs * 3_600_000);
  }
}

function applyLineAIStrategy(aiStrategy, line, enrichedLineOrders, inferredTargetMap, slotIndex, changeoverRules) {
  const slot = slotIndex === 0 ? 'ai_option_1' : 'ai_option_2';
  const visuals = STRATEGY_VISUALS[slotIndex] || STRATEGY_VISUALS[0];

  const name = String(aiStrategy?.strategy_name || '').trim();
  const reasoningSummary = String(aiStrategy?.reasoning_summary || '').trim();
  // New per-spec fields. Optional in the response but, when present, give the
  // UI / insight builder concrete copy to surface (so the row insight reads
  // "Placed by 'X strategy' (focus: Changeover reduction; differs from
  // Standard by …)" instead of generic profit/balanced text).
  const distinctFocus = String(aiStrategy?.distinct_focus || '').trim();
  const differenceFromStandard = String(aiStrategy?.difference_from_standard || '').trim();
  // New per-spec fields (Stage A analysis output). When present, the modal
  // can show "What this line shows" and "Why this fits" inside the
  // expandable AI reasoning section, making it obvious that the strategy
  // was derived from the actual lineup rather than from a preset theme.
  const lineObservation = String(aiStrategy?.line_specific_observation || '').trim();
  const whyFits = String(aiStrategy?.why_this_strategy_fits_this_line || '').trim();
  // Structured execution plan returned by the AI. Validated to a known
  // primary_goal enum so the deterministic refinement layer
  // (executeAIStrategyForLine) can dispatch on it. If the AI omits the
  // block or returns an unknown goal, we fall back to a pass-through
  // generic_optimization so the rest of the pipeline still works.
  const executionIntent = normalizeExecutionIntent(aiStrategy?.execution_intent);
  // Multi-dimension Stage A.5 analysis (per spec §§2-6). Each consideration is
  // an object {relevance, summary}; the emphasis block tells the rest of the
  // pipeline which dimension to weight (faithfulness, row insight, UI badge).
  const changeoverConsideration    = normalizeConsideration(aiStrategy?.changeover_consideration);
  const mtsConsideration           = normalizeConsideration(aiStrategy?.mts_advancement_consideration);
  const profitabilityConsideration = normalizeConsideration(aiStrategy?.profitability_consideration);
  const emphasis                   = normalizeEmphasisBlock(aiStrategy);

  // ── Part 7A: Strategy objective debug log ─────────────────────────────────
  console.debug('[AI Strategy Objective]', {
    strategyId:          slot,
    strategyTitle:       name,
    primaryObjective:    emphasis?.primary   || executionIntent?.primary_goal || null,
    secondaryObjectives: [emphasis?.secondary].filter(Boolean),
    deprioritized:       emphasis?.deprioritized || [],
  });

  const rawOrders = aiStrategy?.orders;
  if (!name) {
    return buildFailedLineAIStrategyShell(line, slotIndex, 'AI strategy missing required strategy_name');
  }
  if (!reasoningSummary) {
    return buildFailedLineAIStrategyShell(line, slotIndex, 'AI strategy missing required reasoning_summary');
  }
  // The AI is told to return a flat ordered array for this single line. Some
  // models still wrap in a {line: [...]} object — accept both shapes here
  // rather than failing the slot for a benign formatting variation.
  let orderArr = null;
  if (Array.isArray(rawOrders)) {
    orderArr = rawOrders;
  } else if (rawOrders && typeof rawOrders === 'object') {
    orderArr = rawOrders[line] || Object.values(rawOrders).flat?.() || null;
    if (!Array.isArray(orderArr)) orderArr = null;
  }
  if (!orderArr || orderArr.length === 0) {
    return buildFailedLineAIStrategyShell(line, slotIndex, 'AI strategy returned no orders for this line');
  }

  // Deterministic refinement layer (per spec §3-§7): take the AI's
  // ordered sequence and reorder it to better match its own declared
  // execution_intent.primary_goal. Hard constraints
  // (MTO/Critical/Urgent/Monitor chronology + safe-window clamp) are
  // still enforced downstream by applyAISequenceToOrders, so this layer
  // only swaps positions among orders the AI is allowed to move.
  const refinedOrderArr = executeAIStrategyForLine({
    aiOrderEntries: orderArr,
    primaryGoal: executionIntent.primary_goal,
    lineOrders: enrichedLineOrders,
    secondaryEmphasis: emphasis.secondary,
  });

  // Deterministic date-move enforcement: for any Sufficient order whose AI-
  // suggested date equals its current avail date (AI didn't move it), use the
  // load-balancing heuristic to find a genuinely better slot. Runs BEFORE
  // applyAISequenceToOrders so improved dates flow through the safe-window
  // clamp and chronological sort correctly.
  const dateEnforcedArr = enforceFlexibleDateMovesOnEntries(
    refinedOrderArr,
    enrichedLineOrders,
    line,
    changeoverRules,
    inferredTargetMap,
  );

  // Wrap into the {line: [...]} shape that applyAISequenceToOrders expects.
  const aiResult = {
    strategy: { [line]: dateEnforcedArr },
    reasoning: reasoningSummary,
    dateAdjustments: aiStrategy.dateAdjustments || [],
  };
  let ordersAfterMap;
  try {
    ordersAfterMap = applyAISequenceToOrders(
      aiResult,
      { [line]: enrichedLineOrders },
      inferredTargetMap,
      { skipClustering: true },
    );
  } catch (err) {
    console.error(`[aiSequenceStrategies] applying ${slot} to ${line} failed:`, err);
    return buildFailedLineAIStrategyShell(line, slotIndex, `Could not apply AI strategy: ${err.message || err}`);
  }
  const rawOrdersAfter = ordersAfterMap[line] || [];
  if (rawOrdersAfter.length === 0) {
    return buildFailedLineAIStrategyShell(line, slotIndex, 'AI strategy produced no schedulable orders after safe-window clamp');
  }

  // ── Capacity-aware date packing (enhancement layer) ───────────────────────
  // Only fires when the strategy's 3-Dimension Analysis indicates MTS
  // flexibility is genuinely appropriate (MTS is primary/secondary and not
  // deprioritized). Mutates _aiSuggestedDate on flexible orders in-place so
  // the subsequent chronological sort and cluster enforcer see the packed dates.
  const packedOrdersAfter = applyCapacityAwarePacking(
    rawOrdersAfter,
    line,
    inferredTargetMap,
    mtsConsideration,
    emphasis,
    name,
    changeoverRules,
  );

  // Re-sort after packing — dates may have shifted so chronological order
  // needs to be re-established before the cluster enforcer runs.
  const reSortedAfterPack = [...packedOrdersAfter].sort((a, b) => {
    const dA = effectiveProductionDateKey(a);
    const dB = effectiveProductionDateKey(b);
    if (dA < dB) return -1;
    if (dA > dB) return  1;
    const posA = a._aiPosition ?? Infinity;
    const posB = b._aiPosition ?? Infinity;
    if (posA !== posB) return posA - posB;
    return (a._originalIndex ?? 0) - (b._originalIndex ?? 0);
  });

  // Post-sort cluster enforcer: make flexible material clusters contiguous.
  // The chronological date-sort can leave firm orders with intermediate dates
  // splitting a flexible cluster. This pass moves interposing flexible orders
  // to just outside the cluster span — no dates are changed, only positions.
  const ordersAfter = enforceContiguousClusters(reSortedAfterPack);

  // ── Completion-feasibility pass ───────────────────────────────────────────
  // Validates every _aiSuggestedDate against the real production timeline.
  // Orders that would complete after midnight of their suggested date get
  // rolled forward to their actual completion date (MTO orders are never moved).
  // Mutates ordersAfter in-place.
  enforceCompletionFeasibility(ordersAfter, line, changeoverRules, inferredTargetMap, name);

  // ── Gap-filling pass ──────────────────────────────────────────────────────
  // After feasibility-safe dates are set, look for underutilized early days
  // and pull movable Sufficient/Flexible orders into them. Validates each
  // candidate move against the full sequence before applying.
  // Strategy-gated: full for MTS primary, reduced for secondary, skipped otherwise.
  applyGapFillingPass(ordersAfter, line, inferredTargetMap, name, emphasis, mtsConsideration);

  // Re-sort after feasibility / gap-fill — pushing or pulling dates can
  // create inversions where a later order in the array now has an earlier
  // date than the order that was just moved. Sort in-place to restore
  // chronological order.
  ordersAfter.sort((a, b) => {
    const dA = effectiveProductionDateKey(a);
    const dB = effectiveProductionDateKey(b);
    if (dA < dB) return -1;
    if (dA > dB) return  1;
    const posA = a._aiPosition ?? Infinity;
    const posB = b._aiPosition ?? Infinity;
    if (posA !== posB) return posA - posB;
    return (a._originalIndex ?? 0) - (b._originalIndex ?? 0);
  });

  // ── Part 4: AI-suggested start date/time ──────────────────────────────────
  // Cursor-sim the final ordered sequence and stamp _aiSuggestedStartDate /
  // _aiSuggestedStartTime on each order so the modal can display meaningful
  // AI-suggested start hints for non-first orders.
  computeAISuggestedStartTimes(ordersAfter);

  // Strategy execution fidelity debug log (per spec §10).
  if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'production') {
    const isChangeoverGoal = executionIntent.primary_goal === 'compress_compatible_runs'
      || emphasis.primary === 'changeover';

    // [AI Changeover Strategy Input] — the raw AI-suggested lineup BEFORE
    // local refinement; shows what the model sent back so we can compare it
    // against the final result and assess how much the execution layer moved.
    if (isChangeoverGoal) {
      const coRules = changeoverRules || getFallbackChangeoverRules();
      console.debug('[AI Changeover Strategy Input]', {
        lineId:   line,
        strategy: executionIntent.primary_goal,
        lineup:   enrichedLineOrders.map((order, index) => {
          const nextOrder = enrichedLineOrders[index + 1];
          const changeoverToNext = nextOrder
            ? (parseFloat(calculateChangeoverBetween(order, nextOrder, coRules)) || 0)
            : null;
          return {
            position:        index + 1,
            orderId:         order.id,
            item:            (order.item_description || '').substring(0, 50),
            form:            order.form || null,
            color:           order.color || null,
            diameter:        order.diameter || null,
            category:        order.category || null,
            changeoverToNext,
            movable:         !isProtectedOrder(order),
          };
        }),
      });
    }

    console.debug('[AI Strategy Execution Check]', {
      lineId:        line,
      strategyId:    slot,
      strategyName:  executionIntent.primary_goal,
      finalSequence: ordersAfter.map(o => ({
        id:       o.id,
        item:     (o.item_description || '').substring(0, 40),
        category: o.category,
        color:    o.color || null,
        diameter: o.diameter || null,
        status:   o._n10dStatus || (isMTO(o) ? 'MTO' : 'Flexible'),
      })),
    });

    // [AI Changeover Strategy Result] — the final post-execution lineup with
    // per-transition changeover costs, plus a direct vs-baseline comparison
    // so we can immediately see if the strategy actually beat Standard or
    // regressed (which is exactly the failure mode the spec §9 retry guards).
    if (isChangeoverGoal) {
      const coRules = changeoverRules || getFallbackChangeoverRules();
      const finalLineup = ordersAfter.map((order, index) => {
        const nextOrder = ordersAfter[index + 1];
        const changeoverToNext = nextOrder
          ? (parseFloat(calculateChangeoverBetween(order, nextOrder, coRules)) || 0)
          : null;
        return {
          position:        index + 1,
          orderId:         order.id,
          item:            (order.item_description || '').substring(0, 50),
          form:            order.form || null,
          color:           order.color || null,
          diameter:        order.diameter || null,
          changeoverToNext,
        };
      });
      // Reuse calculateTotalChangeoverTime so the debug verdict matches the
      // exact total the retry gate (_buildRetryAddendum, _scoreAttemptWeakness)
      // sees — single source of truth, no inline-loop drift.
      const finalCO    = parseFloat(calculateTotalChangeoverTime(ordersAfter,        coRules).toFixed(2));
      const baselineCO = parseFloat(calculateTotalChangeoverTime(enrichedLineOrders, coRules).toFixed(2));
      const delta      = parseFloat((finalCO - baselineCO).toFixed(2));
      console.debug('[AI Changeover Strategy Result]', {
        lineId:                  line,
        strategy:                executionIntent.primary_goal,
        totalFinalChangeover:    finalCO,
        totalBaselineChangeover: baselineCO,
        deltaVsBaseline:         delta,
        verdict:                 delta < -0.05 ? 'IMPROVED' : (delta > 0.05 ? 'REGRESSED' : 'NEUTRAL'),
        finalLineup,
      });
    }

    // ── Part 7D: [AI Profitability Prioritization] per-order ─────────────────
    const isProfitGoal = emphasis.primary === 'profitability';
    if (isProfitGoal) {
      ordersAfter.forEach((o, idx) => {
        const marginPct = parseFloat(o._margin) || 0;
        const prodHrs   = parseFloat(o.production_hours) || 0;
        const coHrs     = parseFloat(o._changeoverTotal ?? o.changeover_time ?? 0) || 0;
        const totalHrs  = prodHrs + coHrs;
        const profitScore = totalHrs > 0 ? marginPct / totalHrs : 0;
        const effAvail = getEffectiveAvailISO(o, inferredTargetMap);
        const hardDeadlineRisk = isMTO(o) || FIRM_STATUSES.has(o._n10dStatus);
        console.debug('[AI Profitability Prioritization]', {
          orderId:           o.id,
          marginPercent:     parseFloat(marginPct.toFixed(2)),
          priorityScore:     parseFloat(profitScore.toFixed(4)),
          hardDeadlineRisk,
          scheduledPosition: idx + 1,
          suggestedDate:     o._aiSuggestedDate || null,
          availDate:         effAvail || null,
        });
      });
    }

    // ── Part 7E: [AI Changeover Optimization] per-transition ─────────────────
    if (isChangeoverGoal) {
      const coRulesCO = changeoverRules || getFallbackChangeoverRules();
      ordersAfter.forEach((o, idx) => {
        const prev = ordersAfter[idx - 1];
        if (!prev) return;
        const projectedChangeover = parseFloat(calculateChangeoverBetween(prev, o, coRulesCO)) || 0;
        console.debug('[AI Changeover Optimization]', {
          orderId:            o.id,
          previousOrderId:    prev.id,
          previousAttributes: { form: prev.form || null, color: prev.color || null, diameter: prev.diameter || null, category: prev.category || null },
          currentAttributes:  { form: o.form   || null, color: o.color   || null, diameter: o.diameter   || null, category: o.category   || null },
          projectedChangeover: parseFloat(projectedChangeover.toFixed(2)),
          groupingReason: (prev.category === o.category && prev.color === o.color)
            ? 'same_category_color' : (prev.category === o.category ? 'same_category' : 'sequential'),
        });
      });
    }

    const catCounts = {};
    for (const o of ordersAfter) {
      const c = `${o.category || 'unknown'}|${o.color || '?'}`;
      catCounts[c] = (catCounts[c] || 0) + 1;
    }
    for (const [cat, cnt] of Object.entries(catCounts)) {
      if (cnt < 2) continue;
      const [category, color] = cat.split('|');
      const segs = countCategorySegments(ordersAfter.map(o => ({
        ...o,
        category: `${o.category || ''}|${o.color || ''}`,
      })), cat);
      if (segs > 1) {
        console.debug(`[Cluster Check] "${category}|${color}" has ${segs} disjoint segments in After table.`);
      }
    }
  }

  const subtitle = String(aiStrategy.subtitle || 'AI-generated strategy').trim();

  // ── Claim alignment: patch description/reasoning from actual final sequence ─
  // The AI writes short_description + reasoning_summary BEFORE the deterministic
  // execution layer runs. If that layer produces a different final order than the
  // AI intended (e.g. "places Swine last" but execution clusters Swine first),
  // the description would be factually wrong in the After table. _sanitizeStrategyTexts
  // detects false concrete positional claims and replaces them with fact-derived text.
  const _sanit = _sanitizeStrategyTexts({
    rawDescription:        String(aiStrategy.short_description || '').trim(),
    reasoningSummary,
    differenceFromStandard,
    finalOrders:           ordersAfter,
    standardOrders:        enrichedLineOrders,
    changeoverRules,
    strategyName:          name,
  });
  const description              = _sanit.description || `AI-generated sequencing strategy for ${line}.`;
  const displayReasoningSummary  = _sanit.reasoningSummary;
  const displayDiffFromStandard  = _sanit.differenceFromStandard;

  // Stamp strategy meta on each order so downstream consumers (insight
  // generator, modal-side fallback, render) can show the AI-generated
  // name/reasoning AND the new distinct-focus / difference-from-standard
  // fields instead of a generic placeholder.
  for (const o of ordersAfter) {
    o._aiStrategyId = slot;
    o._aiStrategyName = name;
    o._aiStrategyReasoning = displayReasoningSummary;
    o._aiStrategyDistinctFocus = distinctFocus;
    o._aiStrategyDifferenceFromStandard = displayDiffFromStandard;
    o._aiStrategyLineObservation = lineObservation;
    o._aiStrategyWhyFits = whyFits;
    o._aiStrategyExecutionIntent = executionIntent;
    o._aiStrategyPrimaryGoal = executionIntent.primary_goal;
    // Multi-dimension emphasis stamp — read by the row-level Sequence Insight
    // builder so the per-order copy can mention the strategy's actual focus
    // (e.g. "advancement-focused", "changeover-reduction-focused").
    o._aiStrategyPrimaryEmphasis    = emphasis.primary;
    o._aiStrategySecondaryEmphasis  = emphasis.secondary;
    o._aiStrategyDeprioritized      = emphasis.deprioritized;
    o._aiStrategyTradeoffSummary    = emphasis.tradeoffSummary;
    o._aiStrategyLine = line;
  }

  return {
    id: slot,
    name,
    theme: subtitle,
    description,
    icon: visuals.icon,
    color: visuals.color,
    reasoningSummary: displayReasoningSummary,
    aiReasoning: displayReasoningSummary,
    distinctFocus,
    differenceFromStandard: displayDiffFromStandard,
    lineObservation,
    whyFits,
    executionIntent,
    primaryGoal: executionIntent.primary_goal,
    // Multi-dimension Stage A.5 outputs surfaced on the strategy object so the
    // modal "View AI reasoning" panel and the row-level Sequence Insight can
    // read them without digging into per-order stamps.
    changeoverConsideration,
    mtsConsideration,
    profitabilityConsideration,
    primaryEmphasis: emphasis.primary,
    secondaryEmphasis: emphasis.secondary,
    deprioritizedFactors: emphasis.deprioritized,
    deprioritizationReason: emphasis.deprioritizationReason,
    tradeoffSummary: emphasis.tradeoffSummary,
    orders: ordersAfter,
    metrics: calculateStrategyMetrics({ [line]: ordersAfter }),
    dateAdjustments: aiResult.dateAdjustments,
    isAIRecommended: false,
    isAI: true,
    isAIGenerated: true,
    aiFailed: false,
    // Uniqueness flags — set later by generateLineStrategies after
    // comparing this strategy's order sequence against Standard and the
    // sibling AI option. Default to false so a strategy is only marked
    // low-distinction when we have positive evidence of similarity.
    isLowDistinction: false,
    lowDistinctionReason: '',
    sourceType: 'ai_generated',
    line,
  };
}

// ─── Uniqueness validation ────────────────────────────────────────────────
// Compare two sequences (arrays of order objects) and decide whether they
// are meaningfully different. The threshold (per spec §10) is:
//   • at least 2 flexible orders ended up at different positions, OR
//   • at least one flexible order was given a different suggested_date.
// Protected orders (MTO / Critical / Urgent / Monitor) are excluded from
// the comparison because they are date-pinned by the hard rules and any
// valid strategy will land them in the same position; comparing them
// would always overstate similarity.
function _flexiblePositionMap(seq) {
  const m = {};
  (seq || []).forEach((o, i) => {
    if (!o || o.id == null) return;
    const isProtected = isMTO(o) || isCritical(o)
      || o._n10dStatus === 'Urgent' || o._n10dStatus === 'Monitor';
    if (isProtected) return;
    m[o.id] = {
      pos: i + 1,
      date: o._aiSuggestedDate || o.target_avail_date || null,
    };
  });
  return m;
}

// ─── Generic-title blacklist ──────────────────────────────────────────────
// Blacklist drawn directly from the spec — these are the names the AI keeps
// reaching for when it falls back to old templates instead of analysing the
// line. A blacklist HIT alone does NOT reject the strategy: a strong
// `line_specific_observation` justification can still rescue it. The hit
// only flags the strategy as a generic-title candidate that the retry path
// will consider re-rolling.
const _GENERIC_TITLE_PATTERNS = [
  /material\s+clustering/i,
  /material\s+continuity/i,
  /changeover\s+reduction/i,
  /profit(\s+score)?\s+optimi[sz]ation/i,
  /profitabil(ity|ity-driven)/i,
  /balanced\s+flow/i,
  /efficiency\s+focus/i,
  /^critical\s+first(\b|,)/i,
  /critical\s+first.*flexible/i,
  /urgent\s+first/i,
];

// A strategy fails the genericity gate when its title matches one of the
// blacklist patterns AND the line_specific_observation is missing or too
// short to count as a real justification (< 30 chars of substantive text).
function _hasGenericTitle(strategy) {
  if (!strategy || strategy.aiFailed) return false;
  const name = String(strategy.name || '').trim();
  if (!name) return false;
  const isGenericName = _GENERIC_TITLE_PATTERNS.some(rx => rx.test(name));
  if (!isGenericName) return false;
  const obs = String(strategy.lineObservation || '').trim();
  // A well-justified blacklisted name carries a substantive observation.
  return obs.length < 30;
}

// ─── Strategy faithfulness scorer (per spec §§6-10, Prompt_1777523216167) ─
// After execution, score how strongly the final order sequence reflects
// the strategy's declared primary_goal. Returns:
//   {
//     score:   0..100 (one decimal)
//     rating:  'Strongly reflected' | 'Mostly reflected' | …
//     weak:    bool   (score < 50 — feeds retry/low-distinction)
//     goal:    primary_goal string
//     breakdown: { intentAlignment, dateAlignment, groupingAlignment,
//                  differenceFromStandardScore, constraintExecutionScore,
//                  ...goal-specific subchecks }
//     notes:   string[] (human-readable explanation lines)
//     reasons: string[] (legacy field — same as notes plus a header line
//              when weak; consumed by retry-addendum builder)
//   }
//
// Top-level formula (per spec §8):
//   intentAlignment      * 0.40
//   dateAlignment        * 0.20
//   groupingAlignment    * 0.20
//   differenceFromStandardScore * 0.10
//   constraintExecutionScore    * 0.10
//
// Per-goal evaluators contribute the first three components; the last two
// are universal so a strategy that violates hard rules or trivially copies
// Standard cannot score 100 just because it "looks" aligned.
function _adjacentSameDiameterSwinePairs(orders) {
  let pairs = 0;
  for (let i = 1; i < orders.length; i += 1) {
    const a = orders[i - 1];
    const b = orders[i];
    if (!isSwineOrder(a) || !isSwineOrder(b)) continue;
    const da = String(a?.diameter || '').trim().toLowerCase();
    const db = String(b?.diameter || '').trim().toLowerCase();
    if (!da || !db) continue;
    if (da === db) pairs += 1;
  }
  return pairs;
}

function _faithfulnessRating(score) {
  if (score >= 90) return 'Strongly reflected';
  if (score >= 75) return 'Mostly reflected';
  if (score >= 60) return 'Adequately reflected';
  if (score >= 50) return 'Weakly reflected';
  return 'Poorly reflected';
}

function _faithfulnessBand(score) {
  if (score == null || !Number.isFinite(score)) return 'unknown';
  if (score >= 90) return 'high';
  if (score >= 75) return 'good';
  if (score >= 60) return 'medium';
  return 'low';
}

// Universal: how meaningfully does the final sequence differ from Standard?
// Counts position + date changes among shared flexible orders. A strategy
// that just mirrors Standard scores low; one that meaningfully reshuffles
// the flexible bucket scores high.
function _differenceFromStandardScore(standardOrders, finalOrders) {
  const std = _flexiblePositionMap(standardOrders);
  const fin = _flexiblePositionMap(finalOrders);
  const sharedIds = Object.keys(std).filter(id => id in fin);
  if (sharedIds.length === 0) return 50; // nothing flexible to compare
  let posDiffs = 0;
  let dateDiffs = 0;
  for (const id of sharedIds) {
    if (std[id].pos !== fin[id].pos) posDiffs += 1;
    if ((std[id].date || null) !== (fin[id].date || null)) dateDiffs += 1;
  }
  // Each shared flexible order can contribute up to 2 (one pos + one date).
  const maxMovements = Math.max(1, sharedIds.length * 2);
  return Math.max(0, Math.min(100, Math.round(((posDiffs + dateDiffs) / maxMovements) * 100)));
}

// Universal: did the strategy stay inside hard constraints? Re-uses the
// metrics already on the strategy (violations + risk), which were computed
// after the safe-window clamp + chronological re-sort ran.
function _constraintExecutionScore(strategy) {
  const violations = (strategy?.metrics?.violations || 0);
  if (violations > 0) return Math.max(0, 100 - violations * 25);
  const risk = strategy?.metrics?.riskLevel || 'Low';
  const riskMap = { Low: 100, Medium: 80, High: 60, Violated: 0 };
  return riskMap[risk] != null ? riskMap[risk] : 80;
}

// Goal: advance_flexible_orders — score how aggressively eligible flexible
// orders were pulled earlier in the sequence and how well early slack was
// utilised, while penalising material-compatibility regressions.
function evaluateFlexibleDateAdvancementFaithfulness({ standardOrders, finalOrders }) {
  const breakdown = {};
  const notes = [];

  const stdIdx = new Map();
  standardOrders.forEach((o, i) => {
    if (o && o.id != null) stdIdx.set(String(o.id), { idx: i, date: o._aiSuggestedDate || o.target_avail_date || null });
  });

  // Eligible = flexible (non-protected) orders present in both sequences.
  const flexible = finalOrders.filter(o => o && o.id != null && !isProtectedOrder(o) && stdIdx.has(String(o.id)));
  const eligibleCount = flexible.length;

  if (eligibleCount === 0) {
    // No flexible orders to advance — strategy has nothing to act on.
    // Score this neutral-to-good (70) so it doesn't drag faithfulness on
    // heavily-constrained lines. Notes call out the situation explicitly.
    notes.push('No flexible orders available to advance on this line — the line is constrained by protected orders.');
    breakdown.flexibleAdvanceRatio = 70;
    breakdown.earlySlackUtilizationScore = 70;
    breakdown.queueCompressionScore = 70;
    breakdown.compatibilityPreservationScore = 100;
    return { intentAlignment: 70, dateAlignment: 70, groupingAlignment: 100, breakdown, notes };
  }

  // 1. flexibleAdvanceRatio — fraction of eligible flexibles whose final
  //    sequence index is earlier than their standard index.
  let advanced = 0;
  let dateEarlier = 0;
  flexible.forEach((o) => {
    const stdEntry = stdIdx.get(String(o.id));
    const finalIdx = finalOrders.indexOf(o);
    if (finalIdx >= 0 && finalIdx < stdEntry.idx) advanced += 1;
    const finDate = o._aiSuggestedDate || o.target_avail_date || null;
    if (stdEntry.date && finDate && finDate < stdEntry.date) dateEarlier += 1;
  });
  const flexibleAdvanceRatio = Math.round((advanced / eligibleCount) * 100);

  // 2. earlySlackUtilizationScore — fraction of eligible flexibles that
  //    landed in the front half of the line (proxy for filling early slack).
  const halfMark = Math.max(1, Math.ceil(finalOrders.length / 2));
  const inEarlyHalf = flexible.filter(o => finalOrders.indexOf(o) < halfMark).length;
  const earlySlackUtilizationScore = Math.round((inEarlyHalf / eligibleCount) * 100);

  // 3. queueCompressionScore — combines position advancement and date
  //    earliness so a strategy that only reshuffles positions but never
  //    pulls an actual date forward scores below one that does both.
  const queueCompressionScore = Math.round(((advanced + dateEarlier) / (eligibleCount * 2)) * 100);

  // 4. compatibilityPreservationScore — adjacent same-material pairs in
  //    Final vs Standard. Maintained or improved → 100; regressed →
  //    proportional. Strategies that scatter compatible material in the
  //    name of advancement get docked.
  const countMatPairs = (seq) => {
    let pairs = 0;
    let total = 0;
    for (let i = 1; i < seq.length; i += 1) {
      const a = seq[i - 1];
      const b = seq[i];
      if (!a || !b) continue;
      total += 1;
      const ma = String(a.material_code || a.material || '').trim();
      const mb = String(b.material_code || b.material || '').trim();
      if (ma && mb && ma === mb) pairs += 1;
    }
    return { pairs, total };
  };
  const stdMat = countMatPairs(standardOrders);
  const finMat = countMatPairs(finalOrders);
  const stdRatio = stdMat.total ? stdMat.pairs / stdMat.total : 0;
  const finRatio = finMat.total ? finMat.pairs / finMat.total : 0;
  const compatibilityPreservationScore = stdRatio === 0
    ? 100
    : Math.max(0, Math.min(100, Math.round((finRatio / stdRatio) * 100)));

  notes.push(`${advanced} of ${eligibleCount} flexible order${eligibleCount === 1 ? '' : 's'} moved to an earlier sequence position than in Standard.`);
  if (dateEarlier > 0) notes.push(`${dateEarlier} flexible order${dateEarlier === 1 ? '' : 's'} also got an earlier suggested date.`);
  if (compatibilityPreservationScore < 80 && stdRatio > 0) {
    notes.push(`Material adjacency dropped from Standard (${(stdRatio * 100).toFixed(0)}% to ${(finRatio * 100).toFixed(0)}%) — advancement came at the cost of changeovers.`);
  }

  breakdown.flexibleAdvanceRatio = flexibleAdvanceRatio;
  breakdown.earlySlackUtilizationScore = earlySlackUtilizationScore;
  breakdown.queueCompressionScore = queueCompressionScore;
  breakdown.compatibilityPreservationScore = compatibilityPreservationScore;

  const intentAlignment = Math.round(
    (flexibleAdvanceRatio + earlySlackUtilizationScore + queueCompressionScore) / 3,
  );
  // Date alignment === how much the actual date plan moved earlier.
  const dateAlignment = queueCompressionScore;
  const groupingAlignment = compatibilityPreservationScore;

  return { intentAlignment, dateAlignment, groupingAlignment, breakdown, notes };
}

// Goal: group_swine_by_diameter — score how tightly swine orders are
// clustered in the final sequence and whether same-diameter adjacency
// improved over Standard.
function evaluateSwineDiameterGroupingFaithfulness({ standardOrders, finalOrders }) {
  const breakdown = {};
  const notes = [];

  const finSwineIdx = [];
  finalOrders.forEach((o, i) => { if (isSwineOrder(o)) finSwineIdx.push(i); });
  const finSwineCount = finSwineIdx.length;
  const stdSwineCount = standardOrders.filter(isSwineOrder).length;

  if (finSwineCount === 0 && stdSwineCount === 0) {
    notes.push('No swine orders on this line — diameter grouping is not applicable.');
    breakdown.swineClusterScore = 70;
    breakdown.diameterAdjacencyScore = 70;
    breakdown.fragmentationReductionScore = 70;
    breakdown.safeDateGroupingScore = 70;
    return { intentAlignment: 70, dateAlignment: 70, groupingAlignment: 70, breakdown, notes };
  }

  // 1. swineClusterScore — based on average gap between consecutive swine
  //    orders. A perfect cluster has gap=0; a fully scattered set has gap
  //    approaching the line length.
  let totalGap = 0;
  let gapCount = 0;
  for (let i = 1; i < finSwineIdx.length; i += 1) {
    totalGap += finSwineIdx[i] - finSwineIdx[i - 1] - 1;
    gapCount += 1;
  }
  const avgGap = gapCount > 0 ? totalGap / gapCount : 0;
  const lineSpan = Math.max(1, finalOrders.length - 1);
  const swineClusterScore = Math.max(0, Math.min(100, Math.round(100 - (avgGap / lineSpan) * 100)));

  // 2. diameterAdjacencyScore — fraction of consecutive-swine adjacencies
  //    that share a diameter, normalised by the maximum achievable.
  const finPairs = _adjacentSameDiameterSwinePairs(finalOrders);
  const stdPairs = _adjacentSameDiameterSwinePairs(standardOrders);
  const maxPossiblePairs = Math.max(1, finSwineCount - 1);
  const diameterAdjacencyScore = Math.max(0, Math.min(100, Math.round((finPairs / maxPossiblePairs) * 100)));

  // 3. fragmentationReductionScore — improvement vs Standard. Equal counts
  //    score 75 (held the line); strict gains push toward 100; regressions
  //    drop below 50.
  let fragmentationReductionScore;
  if (stdPairs === 0 && finPairs === 0) fragmentationReductionScore = 60;
  else if (stdPairs === 0) fragmentationReductionScore = 100;
  else if (finPairs >= stdPairs) {
    const gain = (finPairs - stdPairs) / Math.max(1, stdPairs);
    fragmentationReductionScore = Math.min(100, Math.round(75 + gain * 25));
  } else {
    const loss = (stdPairs - finPairs) / Math.max(1, stdPairs);
    fragmentationReductionScore = Math.max(0, Math.round(50 - loss * 50));
  }

  // 4. safeDateGroupingScore — fraction of swine orders whose final
  //    position differs from Standard, signalling the strategy used safe
  //    movement to support clustering rather than passively accepting the
  //    Standard layout.
  const stdSwineIdxMap = new Map();
  standardOrders.forEach((o, i) => { if (isSwineOrder(o) && o.id != null) stdSwineIdxMap.set(String(o.id), i); });
  let swineMoved = 0;
  finalOrders.forEach((o, i) => {
    if (!isSwineOrder(o) || o.id == null) return;
    const sIdx = stdSwineIdxMap.get(String(o.id));
    if (sIdx != null && sIdx !== i) swineMoved += 1;
  });
  const safeDateGroupingScore = finSwineCount > 0
    ? Math.max(0, Math.min(100, Math.round((swineMoved / finSwineCount) * 100)))
    : 50;

  notes.push(`${finPairs} adjacent same-diameter swine pair${finPairs === 1 ? '' : 's'} in After (Standard had ${stdPairs}).`);
  if (finPairs > stdPairs) notes.push(`Reduced swine diameter fragmentation by ${finPairs - stdPairs} pair${(finPairs - stdPairs) === 1 ? '' : 's'} vs Standard.`);
  if (finPairs < stdPairs) notes.push(`Swine diameter adjacency regressed by ${stdPairs - finPairs} pair${(stdPairs - finPairs) === 1 ? '' : 's'} vs Standard.`);

  breakdown.swineClusterScore = swineClusterScore;
  breakdown.diameterAdjacencyScore = diameterAdjacencyScore;
  breakdown.fragmentationReductionScore = fragmentationReductionScore;
  breakdown.safeDateGroupingScore = safeDateGroupingScore;

  const intentAlignment = Math.round(
    (swineClusterScore + diameterAdjacencyScore + fragmentationReductionScore) / 3,
  );
  const dateAlignment = safeDateGroupingScore;
  const groupingAlignment = diameterAdjacencyScore;

  return { intentAlignment, dateAlignment, groupingAlignment, breakdown, notes };
}

// Faithfulness evaluator for compress_compatible_runs.
// Measures how many disjoint category|color segments the final sequence has
// vs Standard. The cluster key matches what applyCompressCompatibleRunsIntent
// actually uses (category|color), so the score accurately reflects the
// execution layer's real clustering achievement rather than a coarser proxy.
// Fewer segments per cluster → better clustering → higher score.
function evaluateCompressCompatibleRunsFaithfulness({ standardOrders, finalOrders }) {
  const breakdown = {};
  const notes     = [];

  const isFirmO = o => isMTO(o) || FIRM_STATUSES.has(o._n10dStatus);
  // Use category|color to match the execution clustering key exactly.
  const catKeyOf = o => `${(o.category || '').toLowerCase()}|${(o.color || '').toLowerCase()}`;

  // Only assess categories with 2+ flexible members (singletons can't cluster).
  const flexCatCount = new Map();
  for (const o of finalOrders) {
    if (isFirmO(o)) continue;
    const k = catKeyOf(o);
    flexCatCount.set(k, (flexCatCount.get(k) || 0) + 1);
  }
  const clusterableKeys = [...flexCatCount.entries()]
    .filter(([, n]) => n >= 2)
    .map(([k]) => k);

  if (clusterableKeys.length === 0) {
    notes.push('No category with 2+ flexible orders — compact-run clustering not applicable on this line.');
    breakdown.categorySegmentScore       = 70;
    breakdown.clusterCompactnessScore    = 70;
    breakdown.fragmentationReductionScore = 70;
    return { intentAlignment: 70, dateAlignment: 70, groupingAlignment: 70, breakdown, notes };
  }

  let totalSegFin = 0, totalSegStd = 0;
  let totalGap = 0, totalGapCount = 0;

  for (const cat of clusterableKeys) {
    // Count segments in final and standard sequences.
    const segCount = (allOrders) => {
      let segs = 0, inSeg = false;
      for (const o of allOrders) {
        const isTarget = catKeyOf(o) === cat && !isFirmO(o);
        if (isTarget && !inSeg)  { segs++;  inSeg = true; }
        else if (!isTarget)       { inSeg = false; }
      }
      return segs;
    };
    const finSegs = segCount(finalOrders);
    const stdSegs = segCount(standardOrders);
    totalSegFin += finSegs;
    totalSegStd += stdSegs;

    // Positional gap between consecutive same-category flexible members.
    const finalIdx = [];
    finalOrders.forEach((o, i) => { if (catKeyOf(o) === cat && !isFirmO(o)) finalIdx.push(i); });
    for (let i = 1; i < finalIdx.length; i++) {
      totalGap += finalIdx[i] - finalIdx[i - 1] - 1;
      totalGapCount++;
    }

    notes.push(`${cat}: ${finSegs} segment${finSegs !== 1 ? 's' : ''} in After (Standard: ${stdSegs}).`);
    if (finSegs < stdSegs) notes.push(`  ✓ Cluster consolidated for "${cat}" vs Standard.`);
    if (finSegs > stdSegs) notes.push(`  ✗ Fragmentation increased for "${cat}" vs Standard.`);
  }

  // categorySegmentScore: ideal = 1 segment per clusterable category.
  const idealSegs = clusterableKeys.length;
  const segScore = totalSegFin <= idealSegs
    ? 100
    : Math.max(0, Math.round(100 - ((totalSegFin - idealSegs) / Math.max(1, totalSegStd - idealSegs)) * 50));
  breakdown.categorySegmentScore = segScore;

  // clusterCompactnessScore: based on average positional gap between members.
  // We use a 2× penalty multiplier (avgGap * 2 / lineLen) so that even a single
  // intruding order between two cluster members produces a meaningfully low score
  // rather than a misleadingly high one. The previous 1× formula allowed a gap of
  // 2 intruders in a 6-order line to score 80% — this corrects that.
  const avgGap = totalGapCount > 0 ? totalGap / totalGapCount : 0;
  const lineLen = Math.max(1, finalOrders.length - 1);
  const compactnessScore = Math.max(0, Math.min(100, Math.round(100 - (avgGap * 2 / lineLen) * 100)));
  breakdown.clusterCompactnessScore = compactnessScore;

  // fragmentationReductionScore: rewards achieving fully contiguous clusters;
  // penalises any remaining fragmentation even when the final is not worse than
  // Standard. The previous formula awarded 75-85 as long as we didn't regress,
  // which inflated scores when yellow-3mm-style clusters remained visibly split.
  let fragmentationReductionScore;
  if (totalSegFin === idealSegs) {
    // Perfect: every clusterable category has exactly 1 contiguous block.
    fragmentationReductionScore = 100;
  } else {
    const remaining   = totalSegFin - idealSegs;           // extra segments vs perfect
    const improvement = Math.max(0, totalSegStd - totalSegFin); // segs eliminated vs Standard
    if (totalSegFin <= totalSegStd) {
      // Improved vs Standard but not yet perfect — base credit for improvement,
      // minus a 15-point penalty per remaining extra segment.
      const base    = Math.min(90, Math.round(60 + improvement * 10));
      const penalty = remaining * 15;
      fragmentationReductionScore = Math.max(20, base - penalty);
    } else {
      // Regressed vs Standard — strong penalty.
      fragmentationReductionScore = Math.max(0, Math.round(40 - (totalSegFin - totalSegStd) * 15));
    }
  }
  breakdown.fragmentationReductionScore = fragmentationReductionScore;

  const intentAlignment   = Math.round((segScore + compactnessScore + fragmentationReductionScore) / 3);
  const dateAlignment     = compactnessScore;
  const groupingAlignment = segScore;

  return { intentAlignment, dateAlignment, groupingAlignment, breakdown, notes };
}

// Goals without a dedicated helper — score from the universal
// difference-from-Standard signal so a strategy that demonstrably reshapes
// the queue still earns credit, while a near-copy of Standard does not.
function evaluateGenericStrategyFaithfulness({ standardOrders, finalOrders }) {
  const breakdown = {};
  const diff = _differenceFromStandardScore(standardOrders, finalOrders);
  const notes = [
    'No dedicated execution helper for this primary_goal yet — scoring from observable differences vs Standard.',
  ];
  breakdown.differenceFromStandardScore = diff;
  return { intentAlignment: diff, dateAlignment: diff, groupingAlignment: diff, breakdown, notes };
}

// Map breakdown component names → which dimension "owns" the component.
// Used so the deprioritization floor knows which sub-scores belong to a
// deprioritized dimension (and therefore should not drag the total).
const COMPONENT_DIMENSION = {
  // changeover-reduction signal
  compatibilityPreservationScore: 'changeover',
  diameterAdjacencyScore:         'changeover',
  fragmentationReductionScore:    'changeover',
  swineClusterScore:              'changeover',
  safeDateGroupingScore:          'changeover',
  categorySegmentScore:           'changeover',
  clusterCompactnessScore:        'changeover',
  // mts-advancement signal
  flexibleAdvanceRatio:           'mts',
  earlySlackUtilizationScore:     'mts',
  queueCompressionScore:          'mts',
  // profitability signal — no dedicated evaluator yet
};

// If the strategy explicitly deprioritized a dimension, floor every
// breakdown component owned by that dimension to a "neutral-good" 75 so
// the deprioritized-by-design dimension does not drag the total. We
// also mirror the floored values into the recomputed inner aggregates
// (intent / date / grouping) so the final weighted score reflects them.
// Returns the (possibly mutated) inner object plus notes describing what
// was relaxed.
function applyDeprioritizationFloor(inner, deprioritizedDims) {
  if (!Array.isArray(deprioritizedDims) || deprioritizedDims.length === 0) return { inner, notes: [] };
  const floor = 75;
  const notes = [];
  const relaxed = new Set();
  for (const [comp, dim] of Object.entries(COMPONENT_DIMENSION)) {
    if (!deprioritizedDims.includes(dim)) continue;
    if (inner.breakdown[comp] != null && inner.breakdown[comp] < floor) {
      inner.breakdown[comp] = floor;
      relaxed.add(dim);
    }
  }
  // Re-derive the high-level axes from any goal-specific components that
  // got floored. The per-goal evaluators above set intentAlignment as the
  // mean of their component scores, so a re-mean here keeps the contract.
  // We only update each axis when we actually have mapped components for it
  // — otherwise we keep the original value (mean([]) is NaN and would
  // poison the final score).
  const safeMean = (arr) => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  const goalComponents = Object.entries(inner.breakdown).filter(([k]) => COMPONENT_DIMENSION[k]);
  if (goalComponents.length > 0) {
    const allMean        = safeMean(goalComponents.map(([, v]) => v));
    const changeoverMean = safeMean(goalComponents.filter(([k]) => COMPONENT_DIMENSION[k] === 'changeover').map(([, v]) => v));
    const mtsMean        = safeMean(goalComponents.filter(([k]) => COMPONENT_DIMENSION[k] === 'mts').map(([, v]) => v));
    if (allMean        != null) inner.intentAlignment   = allMean;
    if (changeoverMean != null) inner.groupingAlignment = changeoverMean;
    if (mtsMean        != null) inner.dateAlignment     = mtsMean;
  }
  for (const dim of relaxed) {
    notes.push(`${emphasisDimensionLabel(dim) || dim} was deprioritized by this strategy, so its sub-scores were floored to ${floor} when computing faithfulness.`);
  }
  return { inner, notes };
}

function evaluateStrategyFaithfulness({ strategy, standardOrders, finalOrders }) {
  const goal = strategy?.primaryGoal || strategy?.executionIntent?.primary_goal || 'generic_optimization';
  if (!Array.isArray(finalOrders) || finalOrders.length === 0) {
    const empty = ['Final sequence is empty — cannot assess faithfulness.'];
    return {
      score: 0, rating: _faithfulnessRating(0), weak: true, goal,
      breakdown: {}, notes: empty, reasons: empty,
    };
  }

  let inner;
  switch (goal) {
    case 'advance_flexible_orders':
      inner = evaluateFlexibleDateAdvancementFaithfulness({ standardOrders, finalOrders });
      break;
    case 'group_swine_by_diameter':
      inner = evaluateSwineDiameterGroupingFaithfulness({ standardOrders, finalOrders });
      break;
    case 'compress_compatible_runs':
      inner = evaluateCompressCompatibleRunsFaithfulness({ standardOrders, finalOrders });
      break;
    default:
      // If the strategy's primary_goal didn't map to a recognised clustering goal
      // (i.e. the AI returned something like "changeover_reduction" that isn't in
      // SUPPORTED_PRIMARY_GOALS and was normalised to "generic_optimization"), but
      // it still declared changeover as its primary emphasis, evaluate it with the
      // cluster-quality scorer — NOT the generic difference-from-standard scorer.
      // The generic scorer only measures "did orders move?" which inflates scores
      // when many orders changed position regardless of whether clustering improved.
      if (strategy?.primaryEmphasis === 'changeover') {
        inner = evaluateCompressCompatibleRunsFaithfulness({ standardOrders, finalOrders });
        inner.notes = (inner.notes || []).concat(
          'primary_goal was not a recognised clustering goal; cluster-quality evaluator used because strategy declared changeover as primary emphasis.'
        );
      } else {
        inner = evaluateGenericStrategyFaithfulness({ standardOrders, finalOrders });
      }
  }

  // Apply the strategy's declared deprioritization to the breakdown so a
  // dimension the strategy intentionally set aside doesn't drag the score.
  const { inner: floored, notes: floorNotes } = applyDeprioritizationFloor(
    inner,
    strategy?.deprioritizedFactors || []
  );
  inner = floored;

  const differenceFromStandardScore = _differenceFromStandardScore(standardOrders, finalOrders);
  const constraintExecutionScore = _constraintExecutionScore(strategy);

  const breakdown = {
    intentAlignment: inner.intentAlignment,
    dateAlignment: inner.dateAlignment,
    groupingAlignment: inner.groupingAlignment,
    differenceFromStandardScore,
    constraintExecutionScore,
    ...inner.breakdown,
  };

  const score = Math.round((
    inner.intentAlignment * 0.40
    + inner.dateAlignment * 0.20
    + inner.groupingAlignment * 0.20
    + differenceFromStandardScore * 0.10
    + constraintExecutionScore * 0.10
  ) * 10) / 10;

  const rating = _faithfulnessRating(score);
  const weak = score < 50;
  const notes = inner.notes.slice().concat(floorNotes);
  const reasons = notes.slice();
  if (weak) reasons.unshift(`Faithfulness ${score.toFixed(1)}/100 (${rating}) — sequence does not visibly act on declared goal "${goal}".`);

  return { score, rating, weak, goal, breakdown, notes, reasons };
}

// Build a short retry-feedback string explaining what was wrong with the
// previous attempt, so the second AI call can do better. Empty string means
// the previous attempt was good enough — no retry needed.
// Detects whether a strategy's declared emphasis is changeover-reduction.
// Used to gate the "did your sequence actually reduce changeover vs Standard?"
// regression check — we only penalise CO regression on strategies that
// PROMISED to reduce CO, not on strategies that explicitly emphasised
// MTS advancement or profitability (which may legitimately accept slightly
// higher CO in exchange for their primary lever).
function _strategyEmphasizesChangeover(opt) {
  if (!opt || opt.aiFailed) return false;
  if (opt.primaryEmphasis === 'changeover') return true;
  const goal = opt.executionIntent?.primary_goal || '';
  if (goal === 'compress_compatible_runs') return true;
  return false;
}

function _buildRetryAddendum(opt1, opt2, standardOrders, changeoverRules = null) {
  const reasons = [];

  // Changeover regression check (per spec §9): a strategy that emphasises
  // changeover reduction but ends up with MORE total changeover than the
  // Standard baseline has actively made things worse. Compute total CO using
  // the same engine the After-table uses, and emit a concrete feedback line
  // telling the AI exactly how many hours it lost so the retry can fix it.
  if (changeoverRules && standardOrders && standardOrders.length > 1) {
    const standardCO = calculateTotalChangeoverTime(standardOrders, changeoverRules);
    const checkRegression = (opt, slotNum) => {
      if (!opt || opt.aiFailed || !_strategyEmphasizesChangeover(opt)) return;
      const strategyCO = calculateTotalChangeoverTime(opt.orders || [], changeoverRules);
      // Tolerate equal-or-better and a tiny rounding margin (0.05h ≈ 3 min).
      // Anything above that is a real regression on a strategy that promised
      // to reduce CO.
      if (strategyCO > standardCO + 0.05) {
        const delta = (strategyCO - standardCO).toFixed(2);
        reasons.push(
          `- Strategy ${slotNum} ("${opt.name}") declared changeover reduction as its primary emphasis, but its final sequence produced ${strategyCO.toFixed(2)}h of total changeover vs the Standard baseline's ${standardCO.toFixed(2)}h — that is ${delta}h WORSE, not better. Re-sequence by minimising the sum of adjacent transition costs from the LIVE CHANGEOVER RULES section: cluster orders that share color + diameter + category, place Red/Green orders LATE in the run (Red→Any costs 1.0h but Any→Red costs 0.5h), and do not separate same-material orders unless protected dates force it. Your retry MUST achieve total changeover ≤ ${standardCO.toFixed(2)}h or drop the changeover-reduction emphasis entirely.`
        );
      }
    };
    checkRegression(opt1, 1);
    checkRegression(opt2, 2);
  }

  // Failed slots → tell the AI which slot was missing/invalid so the retry
  // can produce valid JSON with all required fields. A first-pass parse or
  // apply failure absolutely deserves a retry.
  if (opt1 && opt1.aiFailed) {
    reasons.push(`- Strategy 1 was missing or invalid (could not be parsed/applied). Return a complete, valid Strategy 1 with strategy_name, line_specific_observation, why_this_strategy_fits_this_line, difference_from_standard, distinct_focus, reasoning_summary, and an orders array covering every order on this line.`);
  }
  if (opt2 && opt2.aiFailed) {
    reasons.push(`- Strategy 2 was missing or invalid (could not be parsed/applied). Return a complete, valid Strategy 2 with all required fields.`);
  }
  if (opt1 && !opt1.aiFailed && _hasGenericTitle(opt1)) {
    reasons.push(`- Strategy 1 ("${opt1.name}") used a generic template name without a strong line-specific observation. Re-derive it from the actual lineup.`);
  }
  if (opt2 && !opt2.aiFailed && _hasGenericTitle(opt2)) {
    reasons.push(`- Strategy 2 ("${opt2.name}") used a generic template name without a strong line-specific observation. Re-derive it from the actual lineup.`);
  }
  // Weak analysis fields — strategies should carry an observation and a
  // why-fits explanation derived from the actual lineup. Empty or token
  // single-word values defeat the whole "analyse first" instruction.
  if (opt1 && !opt1.aiFailed && (!opt1.lineObservation || opt1.lineObservation.length < 30 || !opt1.whyFits || opt1.whyFits.length < 30)) {
    reasons.push(`- Strategy 1 is missing a substantive line_specific_observation or why_this_strategy_fits_this_line. Each must be a real sentence rooted in this line's order mix, dates, materials, or flexibility profile.`);
  }
  if (opt2 && !opt2.aiFailed && (!opt2.lineObservation || opt2.lineObservation.length < 30 || !opt2.whyFits || opt2.whyFits.length < 30)) {
    reasons.push(`- Strategy 2 is missing a substantive line_specific_observation or why_this_strategy_fits_this_line. Each must be a real sentence rooted in this line's order mix, dates, materials, or flexibility profile.`);
  }
  if (opt1 && !opt1.aiFailed && !areStrategiesMeaningfullyDifferent(standardOrders, opt1.orders)) {
    reasons.push(`- Strategy 1 produced a sequence too close to the Standard baseline. Introduce more meaningful position swaps or date moves on flexible orders.`);
  }
  if (opt2 && !opt2.aiFailed && !areStrategiesMeaningfullyDifferent(standardOrders, opt2.orders)) {
    reasons.push(`- Strategy 2 produced a sequence too close to the Standard baseline. Introduce more meaningful position swaps or date moves on flexible orders.`);
  }
  if (opt1 && !opt1.aiFailed && opt2 && !opt2.aiFailed
      && !areStrategiesMeaningfullyDifferent(opt1.orders, opt2.orders)) {
    reasons.push(`- Strategy 1 and Strategy 2 produced near-identical sequences. Make their primary objectives genuinely different (one creates downstream slack, one compresses runs, one protects large blocks, etc.).`);
  }
  // Faithfulness: a strategy whose final sequence does not visibly act
  // on its declared primary_goal is the exact failure mode we are trying
  // to fix. Tell the AI exactly what its previous attempt failed to do.
  if (opt1 && !opt1.aiFailed && opt1.faithfulness && opt1.faithfulness.weak) {
    const goal = opt1.faithfulness.goal || (opt1.executionIntent && opt1.executionIntent.primary_goal) || 'its declared primary_goal';
    const why = (opt1.faithfulness.reasons || []).join(' ');
    reasons.push(`- Strategy 1's final sequence did not visibly act on its declared primary_goal "${goal}". ${why} Re-do its orders array so the sequence clearly reflects what the strategy promises.`);
  }
  if (opt2 && !opt2.aiFailed && opt2.faithfulness && opt2.faithfulness.weak) {
    const goal = opt2.faithfulness.goal || (opt2.executionIntent && opt2.executionIntent.primary_goal) || 'its declared primary_goal';
    const why = (opt2.faithfulness.reasons || []).join(' ');
    reasons.push(`- Strategy 2's final sequence did not visibly act on its declared primary_goal "${goal}". ${why} Re-do its orders array so the sequence clearly reflects what the strategy promises.`);
  }
  return reasons.join('\n');
}

// Pick the better of two generated attempts. We prefer the attempt whose
// strategies have FEWER weak signals (failed slot + generic title + missing
// analysis fields + sequences too close to Standard + AI1≈AI2). Ties favour
// the second attempt — it had the retry feedback so we trust it more on
// equal weakness counts.
function _scoreAttemptWeakness(opt1, opt2, standardOrders, changeoverRules = null) {
  let weak = 0;
  // Pre-compute Standard CO once so per-option regression checks are cheap.
  const standardCO = (changeoverRules && standardOrders && standardOrders.length > 1)
    ? calculateTotalChangeoverTime(standardOrders, changeoverRules)
    : null;
  const scoreOne = (o) => {
    if (!o || o.aiFailed) return 3; // a failed slot is strictly worse than any weak-but-valid slot
    let n = 0;
    if (_hasGenericTitle(o)) n += 1;
    if (!o.lineObservation || o.lineObservation.length < 30) n += 1;
    if (!o.whyFits || o.whyFits.length < 30) n += 1;
    if (!areStrategiesMeaningfullyDifferent(standardOrders, o.orders)) n += 1;
    // Weak faithfulness — sequence does not visibly act on declared goal.
    if (o.faithfulness && o.faithfulness.weak) n += 1;
    // Changeover regression (per spec §9): a CO-emphasis strategy whose
    // measured CO is worse than Standard counts as weak so the retry
    // attempt that fixed the regression wins the tie-break.
    if (standardCO != null && _strategyEmphasizesChangeover(o)) {
      const strategyCO = calculateTotalChangeoverTime(o.orders || [], changeoverRules);
      if (strategyCO > standardCO + 0.05) n += 1;
    }
    return n;
  };
  weak += scoreOne(opt1);
  weak += scoreOne(opt2);
  if (opt1 && !opt1.aiFailed && opt2 && !opt2.aiFailed
      && !areStrategiesMeaningfullyDifferent(opt1.orders, opt2.orders)) {
    weak += 1;
  }
  return weak;
}

function areStrategiesMeaningfullyDifferent(seqA, seqB) {
  const a = _flexiblePositionMap(seqA);
  const b = _flexiblePositionMap(seqB);
  let posDiffs = 0;
  let dateDiffs = 0;
  const sharedIds = Object.keys(a).filter(id => id in b);
  // If there are no shared flexible orders to compare, the line is fully
  // protected (MTO/Critical/Urgent/Monitor only) and any two valid
  // sequences will be position-pinned by the hard rules. Treat as NOT
  // meaningfully different so the soft-flag fires correctly for the user.
  if (sharedIds.length === 0) return false;
  for (const id of sharedIds) {
    if (a[id].pos !== b[id].pos) posDiffs += 1;
    if ((a[id].date || null) !== (b[id].date || null)) dateDiffs += 1;
  }
  return posDiffs >= 2 || dateDiffs >= 1;
}

// Per-line recommendation — winner is chosen primarily from metrics visible
// on the strategy card (faithfulness, changeover time, time-saved, MTS
// adjusted) so the badge is easy to explain to users. Hidden metrics (Min.
// Slack, violations, risk) are used ONLY as safety gates that disqualify
// unsafe strategies before scoring begins — they do not contribute to the
// winner score.
//
// Gate criteria (hidden — safety only):
//   • violations > 0
//   • Min. Slack < 1.5 h
//   • Faithfulness < 60 (also used as gate so cards with weak execution
//     are never recommended even if other metrics look attractive)
//
// Scoring among eligible strategies (visible card metrics):
//   • Faithfulness             35%  — how well the sequence reflects the declared intent
//   • Changeover improvement   25%  — lower totalChangeoverHours is better
//   • Time-saved improvement   25%  — more negative timeSavedDeltaHours is better (vs Standard)
//   • MTS adjusted             15%  — more flexible orders repositioned is better
//
// Standard is never eligible for recommendation.
function determineLineRecommendation(lineStrategies) {
  if (lineStrategies.rule_based) lineStrategies.rule_based.isAIRecommended = false;

  const candidates = ['ai_option_1', 'ai_option_2']
    .map(id => lineStrategies[id])
    .filter(s => s && !s.aiFailed && s.metrics);

  // ── Safety gates (hidden — disqualify only, do not score) ─────────────────
  const eligible = candidates.filter(s => {
    if ((s.metrics.violations || 0) > 0) return false;
    const slack = parseFloat(s.metrics.minSlackHours);
    if (!Number.isFinite(slack) || slack < 1.5) return false;

    // ── CO-emphasis gate ────────────────────────────────────────────────────
    // A CO-emphasis strategy must produce a MEANINGFUL saving vs Standard to
    // be Recommended. "Meaningful" = at least 0.1h (6 min) of actual reduction.
    //   timeSavedDeltaHours positive  → strategy CO > Standard (worse)
    //   timeSavedDeltaHours ≈ 0       → equal to Standard (no improvement)
    //   timeSavedDeltaHours negative  → strategy CO < Standard (saved time)
    // Equal-to-Standard is not a successful optimisation; Standard is preferred.
    const isCOEmphasis = _strategyEmphasizesChangeover(s);
    const delta        = parseFloat(s.metrics?.timeSavedDeltaHours);
    const hasMeaningfulCOSaving = isCOEmphasis && Number.isFinite(delta) && delta < -0.1;

    if (isCOEmphasis) {
      if (Number.isFinite(delta) && delta > -0.1) {
        const reason = delta > 0.05
          ? 'CO-emphasis strategy produced HIGHER total changeover than Standard'
          : 'CO-emphasis strategy produced NO meaningful changeover saving (< 0.1h); Standard is preferred';
        console.debug('[AI Strategy Recommendation] disqualified — CO-emphasis without meaningful saving', {
          id: s.id, name: s.name,
          totalChangeoverHours:    s.metrics?.totalChangeoverHours,
          standardChangeoverHours: s.metrics?.standardChangeoverHours,
          timeSavedDeltaHours: delta, requiredThreshold: -0.1, reason,
        });
        return false;
      }
    }

    // ── Faithfulness gate ───────────────────────────────────────────────────
    // When a CO-emphasis strategy has verified measured savings (≥ 0.1h) the
    // measured CO delta IS the ground truth, so faithfulness is less critical.
    // Relax the floor to 45% in that case; otherwise keep the standard 60%.
    const faith = s.metrics.faithfulnessScore;
    if (faith != null && Number.isFinite(faith)) {
      const faithFloor = hasMeaningfulCOSaving ? 45 : 60;
      if (faith < faithFloor) {
        console.debug('[AI Strategy Recommendation] disqualified — faithfulness below floor', {
          id: s.id, name: s.name, faith, faithFloor,
          note: hasMeaningfulCOSaving
            ? 'CO-savings confirmed but faithfulness still below relaxed 45% floor'
            : 'No verified CO saving — standard 60% faithfulness floor applies',
        });
        return false;
      }
    }

    return true;
  });
  if (eligible.length === 0) {
    console.debug('[AI Strategy Recommendation] no eligible candidates after safety gates', {
      candidates: candidates.map(s => ({
        id: s.id,
        violations: s.metrics.violations,
        minSlackHours: s.metrics.minSlackHours,
        faithfulnessScore: s.metrics.faithfulnessScore,
      })),
    });
    return null;
  }

  // ── Visible-metric scoring ─────────────────────────────────────────────────
  // Weights: faithfulness 25%, CO improvement 10% (moderate),
  //          time-saved 15%, MTS adjusted 10%, orders-at-risk 10%,
  //          daily utilization 30% (MAJOR factor — better daily line
  //          loading often outweighs small total-CO changes).
  // ordersAtRisk: fewer is better — lower count → higher score.
  const faithRaws  = eligible.map(s => {
    const f = s.metrics.faithfulnessScore;
    return (f != null && Number.isFinite(f)) ? f : 75;
  });
  const coHours    = eligible.map(s => parseFloat(s.metrics.totalChangeoverHours) || 0);
  const timeSaved  = eligible.map(s => parseFloat(s.metrics.timeSavedDeltaHours) || 0);
  const mtsAdj     = eligible.map(s => s.metrics.mtsAdjusted || 0);
  const atRiskNums = eligible.map(s => s.metrics.ordersAtRisk ?? 0);
  const utilDeltas = eligible.map(s => parseFloat(s.metrics.utilizationDelta) || 0);

  // Normalise each dimension so scores are always in [0, 1].
  // Range-based norms: when all candidates tie on a dimension every one gets 0.5.
  const maxFaith    = Math.max(...faithRaws, 1);
  const maxCO       = Math.max(...coHours, 0.0001);
  const minCO       = Math.min(...coHours);
  const coDelta     = Math.max(0.0001, maxCO - minCO);
  const maxTS       = Math.max(...timeSaved);          // most positive (worst saved)
  const minTS       = Math.min(...timeSaved);          // most negative (best saved)
  const tsDelta     = Math.max(0.0001, maxTS - minTS);
  const maxMTS      = Math.max(...mtsAdj, 1);
  const maxAtRisk   = Math.max(...atRiskNums, 1);      // 1 floor avoids /0 when all are 0
  const maxUtil     = Math.max(...utilDeltas);
  const minUtil     = Math.min(...utilDeltas);
  const utilRange   = Math.max(0.0001, maxUtil - minUtil);

  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < eligible.length; i++) {
    const s = eligible[i];
    const faithScore   = faithRaws[i] / maxFaith;
    const coScore      = (maxCO - coHours[i]) / coDelta;   // lower CO → higher score
    const tsScore      = (maxTS - timeSaved[i]) / tsDelta;  // more saved (negative) → higher score
    const mtsScore     = mtsAdj[i] / maxMTS;
    const atRiskScore  = 1 - (atRiskNums[i] / maxAtRisk);  // fewer at-risk → higher score
    const utilScore    = (utilDeltas[i] - minUtil) / utilRange; // higher delta → higher score
    const total        = 0.25 * faithScore + 0.10 * coScore + 0.15 * tsScore
                       + 0.10 * mtsScore   + 0.10 * atRiskScore + 0.30 * utilScore;

    // Store the breakdown on the strategy so the UI can surface it.
    s._recommendationScore = {
      total:      parseFloat(total.toFixed(3)),
      components: [
        { key: 'dailyUtilization', label: 'Daily utilization', weight: 0.30, score: parseFloat(utilScore.toFixed(3))  },
        { key: 'faithfulness',     label: 'Faithfulness',      weight: 0.25, score: parseFloat(faithScore.toFixed(3)) },
        { key: 'timeSaved',        label: 'Time saved',        weight: 0.15, score: parseFloat(tsScore.toFixed(3))    },
        { key: 'changeover',       label: 'Changeover',        weight: 0.10, score: parseFloat(coScore.toFixed(3))    },
        { key: 'mtsAdjusted',      label: 'MTS adjusted',      weight: 0.10, score: parseFloat(mtsScore.toFixed(3))   },
        { key: 'ordersAtRisk',     label: 'Orders at risk',    weight: 0.10, score: parseFloat(atRiskScore.toFixed(3))},
      ],
    };

    console.debug('[AI Strategy Recommendation]', {
      id: s.id,
      faithfulnessScore: faithRaws[i],
      totalChangeoverHours: coHours[i],
      timeSavedDeltaHours: timeSaved[i],
      mtsAdjusted: mtsAdj[i],
      ordersAtRisk: atRiskNums[i],
      utilizationDelta: utilDeltas[i],
      faithScore: faithScore.toFixed(3),
      coScore: coScore.toFixed(3),
      tsScore: tsScore.toFixed(3),
      mtsScore: mtsScore.toFixed(3),
      atRiskScore: atRiskScore.toFixed(3),
      utilScore: utilScore.toFixed(3),
      totalWeightedScore: total.toFixed(3),
    });

    if (total > bestScore) { bestScore = total; best = s; }
  }

  if (best) {
    best.isAIRecommended = true;
    console.debug('[AI Strategy Recommendation] winner →', best.id, { score: bestScore.toFixed(3) });
    return best.id;
  }
  return null;
}

// Per-line orchestrator — builds Standard + 2 AI options + insights for one
// line. Always returns a valid lineStrategies object even if the AI call
// fails entirely (Standard remains usable; failed AI slots become shells).
export async function generateLineStrategies({ line, lineOrders, masterData, inferredTargetMap, changeoverRules, signal }) {
  // ── 1. Standard sequence for this line ──
  // We reuse the plant-wide rule_based builder by passing a single-line map
  // and slicing the result. This keeps a single source of truth for what
  // "Standard" means and avoids duplicating the rule-based logic.
  const ruleBasedPlant = buildRuleBasedStrategy({ [line]: lineOrders }, masterData);
  const standardOrders = ruleBasedPlant.orders[line] || [];
  const standard = {
    id: 'rule_based',
    name: ruleBasedPlant.name || 'Standard Sequence',
    theme: ruleBasedPlant.theme || 'Rule-based',
    description: ruleBasedPlant.description
      || 'Follows the current rule-based sequencing flow using dates and priority rules.',
    icon: ruleBasedPlant.icon,
    color: ruleBasedPlant.color,
    orders: standardOrders,
    metrics: calculateStrategyMetrics({ [line]: standardOrders }),
    isAIRecommended: false,
    isAI: false,
    aiFailed: false,
    sourceType: 'rule_based',
    line,
    reasoningSummary: '',
  };

  // ── 2. Enrich + AI call for this line ──
  const enrichedMap = enrichWithMargin({ [line]: lineOrders }, masterData);
  const enrichedLineOrders = enrichedMap[line] || [];

  // ── Helper: run one AI attempt for this line ──
  // Wraps the prompt build + AI call + parse + apply pipeline so we can
  // call it twice (initial attempt + optional retry with feedback) without
  // duplicating the failure-handling code.
  const runAttempt = async (retryAddendum) => {
    const { systemPrompt, userPrompt } = buildLineStrategyPrompt({
      line,
      lineOrders: enrichedLineOrders,
      // Pass the Standard baseline so the AI can compare against it instead
      // of re-inventing date-only sequencing. enrichedLineOrders is the
      // post-margin enrichment of the same orders standardOrders contains,
      // so positions match. Standard's order array is what the AI sees.
      standardSequence: standardOrders,
      changeoverRules,
      inferredTargetMap,
      retryAddendum,
    });
    // 3000 tokens is generous for a single line: 2 strategies × per-line
    // ordering + names + descriptions + reasoning. ~50 orders fits comfortably.
    const content = await callSequenceStrategyAI(systemPrompt, userPrompt, 3000, signal, line);
    const { strategies: aiStrategies } = parseLineStrategyResponse(content);
    const a = aiStrategies[0] || null;
    const b = aiStrategies[1] || null;
    const opt1 = a
      ? applyLineAIStrategy(a, line, enrichedLineOrders, inferredTargetMap, 0, changeoverRules)
      : buildFailedLineAIStrategyShell(line, 0, 'AI returned no strategy in slot 1');
    const opt2 = b
      ? applyLineAIStrategy(b, line, enrichedLineOrders, inferredTargetMap, 1, changeoverRules)
      : buildFailedLineAIStrategyShell(line, 1, 'AI returned no strategy in slot 2');
    return { opt1, opt2 };
  };

  // Stamp faithfulness on each non-failed AI option so the retry-feedback
  // builder, weakness scorer, and low-distinction block can all see whether
  // the strategy actually delivered on its declared primary_goal.
  const _stampFaithfulness = (opt) => {
    if (!opt || opt.aiFailed) return;
    const f = evaluateStrategyFaithfulness({ strategy: opt, standardOrders, finalOrders: opt.orders });
    opt.faithfulness = f;
    // Mirror onto metrics so the StrategyCard metrics box and the
    // recommendation logic both have a single, well-typed access path.
    if (opt.metrics) {
      opt.metrics.faithfulnessScore = f.score;
      opt.metrics.faithfulnessRating = f.rating;
      opt.metrics.faithfulnessBreakdown = f.breakdown;
      opt.metrics.faithfulnessNotes = f.notes;
    }
  };

  let ai_option_1, ai_option_2;
  try {
    // First attempt with no retry feedback.
    const first = await runAttempt('');
    ai_option_1 = first.opt1;
    ai_option_2 = first.opt2;
    _stampFaithfulness(ai_option_1);
    _stampFaithfulness(ai_option_2);

    // Distinctiveness gate: if the first attempt looks generic / too close
    // to Standard / both options too similar / OR a strategy under-delivered
    // on its own primary_goal, build a retry addendum and run ONE additional
    // attempt. Per the spec we never outright fail a line — the better of
    // the two attempts is kept and any residual weakness is left for the
    // soft `isLowDistinction` flag below.
    const retryAddendum = _buildRetryAddendum(ai_option_1, ai_option_2, standardOrders, changeoverRules);
    if (retryAddendum) {
      try {
        const second = await runAttempt(retryAddendum);
        _stampFaithfulness(second.opt1);
        _stampFaithfulness(second.opt2);
        const firstWeak = _scoreAttemptWeakness(ai_option_1, ai_option_2, standardOrders, changeoverRules);
        const secondWeak = _scoreAttemptWeakness(second.opt1, second.opt2, standardOrders, changeoverRules);
        // Tie-breaker: keep the retry attempt because it had the feedback.
        if (secondWeak <= firstWeak) {
          ai_option_1 = second.opt1;
          ai_option_2 = second.opt2;
        }
      } catch (retryErr) {
        // Re-propagate abort so the caller can handle it cleanly.
        if (retryErr?.name === 'AbortError') throw retryErr;
        // Any other retry failure is non-fatal — keep the first attempt as-is.
        console.warn(`[aiSequenceStrategies] line ${line} retry failed, keeping first attempt:`, retryErr);
      }
    }
  } catch (err) {
    // Propagate AbortError up so generateSequenceStrategies / Dashboard can
    // handle cancellation cleanly instead of converting it to a failed shell.
    if (err?.name === 'AbortError') throw err;
    console.error(`[aiSequenceStrategies] line ${line} AI call failed:`, err);
    const reason = `AI call failed: ${err && err.message ? err.message : err}`;
    ai_option_1 = buildFailedLineAIStrategyShell(line, 0, reason);
    ai_option_2 = buildFailedLineAIStrategyShell(line, 1, reason);
  }

  // ── 2.5. Uniqueness validation ──
  // For each AI option that successfully applied, check whether its sequence
  // is meaningfully different from Standard. Per spec §13 we do NOT outright
  // fail a low-distinction strategy (low-flexibility lines may genuinely
  // produce two close-to-Standard alternatives). Instead we soft-flag it
  // with `isLowDistinction: true` + a reason so the UI can surface the
  // caveat and the recommendation logic can still consider it.
  if (!ai_option_1.aiFailed && !areStrategiesMeaningfullyDifferent(standardOrders, ai_option_1.orders)) {
    ai_option_1.isLowDistinction = true;
    ai_option_1.lowDistinctionReason = 'Sequence is very close to Standard — limited flexibility on this line.';
  }
  if (!ai_option_2.aiFailed && !areStrategiesMeaningfullyDifferent(standardOrders, ai_option_2.orders)) {
    ai_option_2.isLowDistinction = true;
    ai_option_2.lowDistinctionReason = 'Sequence is very close to Standard — limited flexibility on this line.';
  }
  // Faithfulness flag (per spec §9): if the sequence does not visibly
  // act on its own declared primary_goal, soft-flag it so the UI can
  // warn the user that the strategy card is stronger than the result.
  // This is independent of distinct-from-Standard — a strategy can be
  // VERY different from Standard yet still not deliver on its claim.
  if (!ai_option_1.aiFailed && ai_option_1.faithfulness && ai_option_1.faithfulness.weak) {
    ai_option_1.isLowDistinction = true;
    const why = (ai_option_1.faithfulness.reasons || [])[0]
      || `Sequence does not visibly act on declared primary_goal "${ai_option_1.faithfulness.goal || 'unknown'}".`;
    ai_option_1.lowDistinctionReason = ai_option_1.lowDistinctionReason
      ? `${ai_option_1.lowDistinctionReason} ${why}`
      : why;
  }
  if (!ai_option_2.aiFailed && ai_option_2.faithfulness && ai_option_2.faithfulness.weak) {
    ai_option_2.isLowDistinction = true;
    const why = (ai_option_2.faithfulness.reasons || [])[0]
      || `Sequence does not visibly act on declared primary_goal "${ai_option_2.faithfulness.goal || 'unknown'}".`;
    ai_option_2.lowDistinctionReason = ai_option_2.lowDistinctionReason
      ? `${ai_option_2.lowDistinctionReason} ${why}`
      : why;
  }
  // Compare AI options against EACH OTHER. If they are near-duplicates the
  // second one carries the flag (the first option keeps its primary status).
  if (!ai_option_1.aiFailed && !ai_option_2.aiFailed
      && !areStrategiesMeaningfullyDifferent(ai_option_1.orders, ai_option_2.orders)) {
    ai_option_2.isLowDistinction = true;
    ai_option_2.lowDistinctionReason = ai_option_2.lowDistinctionReason
      || 'Near-duplicate of the first AI strategy — limited room for two distinct alternatives.';
  }

  // ── 2.6. Stamp changeover comparison metrics ──
  // Re-compute totalChangeoverHours per strategy from THAT strategy's final
  // sequence using the live changeoverRules (same formula the After-table
  // row uses). This overwrites the approximate value calculateStrategyMetrics
  // produced (which had no rules and could not see the next-order context),
  // and is what makes each card show its own number instead of all sharing
  // Standard's total.
  const standardCO = calculateTotalChangeoverTime(standard.orders, changeoverRules);
  if (standard.metrics) {
    standard.metrics.totalChangeoverHours    = standardCO;
    standard.metrics.standardChangeoverHours = standardCO;
    // Standard IS the baseline — delta vs itself is always 0.
    standard.metrics.timeSavedDeltaHours     = 0;
  }
  const _stampChangeover = (opt) => {
    if (!opt || !opt.metrics) return;
    const { strategyCO, deltaHours } = calculateTimeSavedVsStandard(
      standard.orders,
      opt.orders || [],
      changeoverRules
    );
    opt.metrics.totalChangeoverHours    = strategyCO;
    opt.metrics.standardChangeoverHours = standardCO;
    // Signed delta: negative means this strategy reduced changeover time vs Standard.
    opt.metrics.timeSavedDeltaHours     = deltaHours;
  };
  _stampChangeover(ai_option_1);
  _stampChangeover(ai_option_2);

  // ── 2.7. Stamp accurate at-risk order counts ──
  // Re-runs the timing simulation for each strategy using the correctly-stamped
  // changeover values (available after _stampChangeover above). Updates
  // ordersAtRisk, overdueCount, delayedCount, compromisedCount in each
  // strategy's metrics object.
  const _stampRisk = (opt) => {
    if (!opt || !opt.metrics) return;
    const flatOrders = Array.isArray(opt.orders)
      ? opt.orders
      : Object.values(opt.orders || {}).flat();
    const risk = computeAtRiskOrders(flatOrders, line, inferredTargetMap, changeoverRules);
    opt.metrics.ordersAtRisk     = risk.ordersAtRisk;
    opt.metrics.overdueCount     = risk.overdueCount;
    opt.metrics.delayedCount     = risk.delayedCount;
    opt.metrics.compromisedCount = risk.compromisedCount; // internal only
    opt.metrics.riskSeverity     = risk.resolvedSeverity; // 'High' or 'Low'
    console.debug('[Orders At Risk Severity]', {
      strategyId: opt.id,
      title: opt.name,
      atRiskCount: risk.ordersAtRisk,
      overdueCount: risk.overdueCount,
      delayedCount: risk.delayedCount,
      compromisedCount: risk.compromisedCount,
      resolvedSeverity: risk.resolvedSeverity,
    });
  };
  _stampRisk(standard);
  _stampRisk(ai_option_1);
  _stampRisk(ai_option_2);

  // ── 2.8. Stamp daily utilization KPI ──
  // Computes per-day capacity usage from the strategy's actual sequence
  // (production hours + changeovers). Records perDay breakdown +
  // averageUtilization on each strategy's metrics, then stamps a delta
  // vs Standard so the StrategyCard can render the comparison directly.
  const _stampUtilization = (opt) => {
    if (!opt || !opt.metrics) return;
    const flatOrders = Array.isArray(opt.orders)
      ? opt.orders
      : Object.values(opt.orders || {}).flat();
    // Pass inferredTargetMap so Standard orders whose avail date lives in
    // the inferred threshold map (not on target_avail_date) are bucketed
    // correctly — this is the root cause of Standard showing "(no date)".
    const util = computeDailyUtilization(flatOrders, line, changeoverRules, inferredTargetMap);
    opt.metrics.dailyUtilization = util;                         // { perDay, averageUtilization }
    opt.metrics.averageUtilization = util.averageUtilization;
  };
  _stampUtilization(standard);
  _stampUtilization(ai_option_1);
  _stampUtilization(ai_option_2);

  const standardAvgUtil = standard.metrics?.averageUtilization ?? 0;
  [standard, ai_option_1, ai_option_2].forEach(opt => {
    if (!opt || !opt.metrics) return;
    opt.metrics.standardAverageUtilization = standardAvgUtil;
    opt.metrics.utilizationDelta = parseFloat(
      (((opt.metrics.averageUtilization ?? 0) - standardAvgUtil)).toFixed(1)
    );
    const groupedRows = opt.metrics.dailyUtilization?.perDay || [];
    console.debug('[Daily Utilization KPI]', {
      strategyId: opt.id,
      title: opt.name,
      standardAverageUtilization: standardAvgUtil,
      strategyAverageUtilization: opt.metrics.averageUtilization,
      utilizationDelta: opt.metrics.utilizationDelta,
      perDay: groupedRows.map(d => ({
        date: d.date,
        orderCount: d.orderCount,
        usedHours: d.usedHours,
        utilizationPercent: d.utilizationPercent,
      })),
    });
    console.debug('[Daily Utilization Average]', {
      strategyId: opt.id,
      title: opt.name,
      validDatedRows: groupedRows
        .filter(r => r.date && r.date !== '(no date)')
        .map(r => ({
          availDate: r.date,
          utilizationPercent: r.utilizationPercent,
        })),
      strategyAverageUtilization: opt.metrics.averageUtilization,
      standardAverageUtilization: standardAvgUtil,
      deltaVsStandard: opt.metrics.utilizationDelta,
    });
    console.debug('[Daily Utilization Breakdown]', {
      strategyId: opt.id,
      title: opt.name,
      groupedBy: 'availDate',
      availDatesFound: groupedRows.map(r => r.date),
      groupedRows: groupedRows.map(r => ({
        availDate: r.date,
        orderCount: r.orderCount,
        usedHours: r.usedHours,
        utilizationPercent: r.utilizationPercent,
      })),
    });
    const flatOrders = Array.isArray(opt.orders)
      ? opt.orders
      : Object.values(opt.orders || {}).flat();
    console.debug('[Daily Utilization Source Check]', {
      strategyId: opt.id,
      title: opt.name,
      sourceUsed: 'afterTableResult',
      rowCount: flatOrders.length,
      availDatesFound: groupedRows.map(r => r.date),
      groupedRows: groupedRows.map(r => ({
        availDate: r.date,
        orderCount: r.orderCount,
        usedHours: r.usedHours,
        utilizationPercent: r.utilizationPercent,
      })),
    });
  });

  // ── Risk summary debug log (spec §9) ──
  const _logRiskSummary = (opt) => {
    if (!opt || !opt.metrics) return;
    console.debug('[Sequence Risk Summary]', {
      strategyId:      opt.id,
      title:           opt.name,
      ordersAtRisk:    opt.metrics.ordersAtRisk    ?? 0,
      overdueCount:    opt.metrics.overdueCount    ?? 0,
      delayedCount:    opt.metrics.delayedCount    ?? 0,
      compromisedCount: opt.metrics.compromisedCount ?? 0,
    });
  };
  _logRiskSummary(standard);
  _logRiskSummary(ai_option_1);
  _logRiskSummary(ai_option_2);

  // ── Post-generation truthfulness patch (spec §5 / §6) ────────────────────
  // After measuring the real changeover totals, if a CO-emphasis strategy
  // turned out WORSE than Standard the card description and 3D-analysis panel
  // must be corrected — otherwise they contradict the red "+Xh" metric the
  // user can already see.  We leave the AI's title and sequence intact; we
  // only fix the text that makes factually false claims about the outcome.
  const _patchIfCOWorse = (opt) => {
    if (!opt || opt.aiFailed || !opt.metrics) return;
    if (!_strategyEmphasizesChangeover(opt)) return;
    const delta = parseFloat(opt.metrics.timeSavedDeltaHours);
    if (!Number.isFinite(delta) || delta <= 0.05) return; // not worse — nothing to patch

    const actualCO   = (opt.metrics.totalChangeoverHours   ?? 0).toFixed(2);
    const baselineCO = (opt.metrics.standardChangeoverHours ?? standardCO).toFixed(2);
    const worseBy    = Math.abs(delta).toFixed(2);

    // Correct the 3D-analysis consideration panel so "HIGH PRIMARY" becomes
    // "LOW PRIMARY" and the summary states the real measured result.
    if (opt.changeoverConsideration) {
      opt.changeoverConsideration.relevance = 'low';
      opt.changeoverConsideration.summary =
        `Measured result: this sequence produced ${actualCO}h total changeover — ` +
        `${worseBy}h more than the Standard baseline (${baselineCO}h). ` +
        `The intended reduction was not achieved; the reorder introduced more ` +
        `expensive transitions than it eliminated.`;
    }

    console.debug('[AI Strategy Truthfulness Patch] corrected CO-worse strategy', {
      id: opt.id, name: opt.name, actualCO, baselineCO, worseBy,
    });
  };
  _patchIfCOWorse(ai_option_1);
  _patchIfCOWorse(ai_option_2);

  // ── Post-generation measured-outcome enrichment (spec §5) ─────────────────
  // For every CO-emphasis strategy that _patchIfCOWorse did NOT fully replace
  // (i.e. the strategy is equal to or better than Standard), append a concise
  // "Measured:" line to the changeoverConsideration summary so the 3D-analysis
  // panel always shows what was actually computed — not just what the AI predicted.
  // This closes the gap where the AI says "removes the 1.50h penalty" but
  // constraints caused the real saving to be smaller (or zero).
  const _enrichCOSummaryWithMeasuredFact = (opt) => {
    if (!opt || opt.aiFailed || !opt.metrics) return;
    if (!_strategyEmphasizesChangeover(opt)) return;
    const delta = parseFloat(opt.metrics.timeSavedDeltaHours);
    if (!Number.isFinite(delta)) return;
    // _patchIfCOWorse already replaced the summary for worse-than-Standard cases.
    if (delta > 0.05) return;

    if (!opt.changeoverConsideration) return;
    const actualCO   = (opt.metrics.totalChangeoverHours   ?? 0).toFixed(2);
    const baselineCO = (opt.metrics.standardChangeoverHours ?? standardCO).toFixed(2);

    let measuredLine;
    if (delta < -0.05) {
      // Genuine saving
      const saved = Math.abs(delta).toFixed(2);
      measuredLine =
        `Measured: ${actualCO}h total — saved ${saved}h vs Standard baseline (${baselineCO}h). ` +
        `Reduction achieved as described.`;
    } else {
      // Effectively equal (within ±0.05h noise)
      measuredLine =
        `Measured: ${actualCO}h total — equal to Standard baseline (${baselineCO}h). ` +
        `The sequence rearranged orders but date or constraint limits offset the intended savings.`;
    }

    opt.changeoverConsideration.summary =
      `${opt.changeoverConsideration.summary} ${measuredLine}`;
  };
  _enrichCOSummaryWithMeasuredFact(ai_option_1);
  _enrichCOSummaryWithMeasuredFact(ai_option_2);

  // Per-strategy debug log so we can verify the three cards diverge when the
  // sequences differ. Safe to keep — `console.debug` is filtered by default.
  // Also dump the per-row CO contributions so we can verify the totals match
  // what the After table actually shows.
  const _rowCOTrace = (ords) => (ords || []).map((o, i, arr) => {
    const next = arr.slice(i + 1).find(n => {
      const s = (n?.status || '').toLowerCase();
      return s !== 'done' && s !== 'completed' && s !== 'cancel_po';
    }) || null;
    let co = 0;
    const st = (o?.status || '').toLowerCase();
    if (st === 'done' || st === 'completed' || st === 'cancel_po') {
      co = (o.frozen_changeover != null ? parseFloat(o.frozen_changeover) : parseFloat(o.changeover_time ?? 0)) || 0;
    } else if (next) {
      const baseRaw = parseFloat(o.changeover_time);
      const base = Number.isFinite(baseRaw) ? baseRaw : (((o.form || '').trim().toUpperCase() === 'C') ? 0.33 : 0.17);
      const { total: add } = calculateAdditionalChangeover(o, next, changeoverRules || []);
      co = parseFloat((base + add).toFixed(3));
    }
    return { id: o?.id, item: o?.item_description?.slice(0, 30), co };
  });
  console.debug('[Strategy Changeover Metrics]', {
    line,
    standard: standard.metrics?.totalChangeoverHours,
    ai_option_1: ai_option_1.metrics?.totalChangeoverHours,
    ai_option_1_delta: ai_option_1.metrics?.timeSavedDeltaHours,
    ai_option_2: ai_option_2.metrics?.totalChangeoverHours,
    ai_option_2_delta: ai_option_2.metrics?.timeSavedDeltaHours,
    standardRows: _rowCOTrace(standard.orders),
    ai1Rows: ai_option_1.aiFailed ? 'FAILED' : _rowCOTrace(ai_option_1.orders),
    ai2Rows: ai_option_2.aiFailed ? 'FAILED' : _rowCOTrace(ai_option_2.orders),
  });

  // ── Spec §11 — AI Whole-Sequence Optimization debug log ──────────────────
  // Emits the full candidate ordering for each AI strategy alongside the
  // per-adjacent-pair changeover costs so reviewers can verify:
  //   (a) the AI evaluated the whole sequence, not just one pair
  //   (b) the final total beats Standard when the strategy claims CO reduction
  //   (c) description and faithfulness match the actual result
  const _coRules = changeoverRules || getFallbackChangeoverRules();
  const _logWholeSequence = (opt) => {
    if (!opt || opt.aiFailed) return;
    const candidateOrdering = (opt.orders || []).map((o, index, arr) => {
      const next = arr[index + 1] || null;
      const coToNext = next
        ? (parseFloat(calculateChangeoverBetween(o, next, _coRules)) || 0)
        : null;
      return {
        position:  index + 1,
        orderId:   o.id,
        item:      (o.item_description || '').substring(0, 40),
        color:     o.color,
        diameter:  o.diameter,
        category:  o.category,
        availDate: String(o.target_avail_date || o.avail_date || '').substring(0, 10),
        movable:   !isMTO(o) && !FIRM_STATUSES.has(o._n10dStatus),
        coToNext,
      };
    });
    const totalAdjacentChangeover = opt.metrics?.totalChangeoverHours ?? 0;
    const deltaVsStandard         = opt.metrics?.timeSavedDeltaHours  ?? 0;
    console.debug('[AI Whole-Sequence Optimization]', {
      lineId:                    line,
      strategyId:                opt.id,
      strategyTitle:             opt.name,
      strategyDescription:       opt.description,
      candidateOrdering,
      totalAdjacentChangeover,
      standardSequenceChangeover: standardCO,
      deltaVsStandard,
      beatStandard:              deltaVsStandard <= 0,
      faithfulness:              opt.metrics?.faithfulnessScore ?? null,
    });
  };
  _logWholeSequence(ai_option_1);
  _logWholeSequence(ai_option_2);

  // ── 3. Strategy-aware insights per option (parallel) ──
  // generateStrategyInsights still expects an ordersByLine map, so we wrap
  // each option's flat order array under the line key, run the insight
  // generation, and then unwrap the result back to a flat array.
  const stdMeta = { id: 'rule_based', name: standard.name, reasoningSummary: '', emphasizesProfit: false, isAI: false };
  const opt1Meta = { id: 'ai_option_1', name: ai_option_1.name, reasoningSummary: ai_option_1.reasoningSummary, emphasizesProfit: _strategyEmphasizesProfit(ai_option_1), isAI: true };
  const opt2Meta = { id: 'ai_option_2', name: ai_option_2.name, reasoningSummary: ai_option_2.reasoningSummary, emphasizesProfit: _strategyEmphasizesProfit(ai_option_2), isAI: true };

  const insightTasks = [
    generateStrategyInsights({ strategyMeta: stdMeta, ordersByLine: { [line]: standard.orders }, changeoverRules, masterData }),
    ai_option_1.aiFailed
      ? Promise.resolve({ [line]: ai_option_1.orders })
      : generateStrategyInsights({ strategyMeta: opt1Meta, ordersByLine: { [line]: ai_option_1.orders }, changeoverRules, masterData }),
    ai_option_2.aiFailed
      ? Promise.resolve({ [line]: ai_option_2.orders })
      : generateStrategyInsights({ strategyMeta: opt2Meta, ordersByLine: { [line]: ai_option_2.orders }, changeoverRules, masterData }),
  ];
  const [stdInsights, opt1Insights, opt2Insights] = await Promise.all(insightTasks);
  standard.orders = stdInsights[line] || standard.orders;
  ai_option_1.orders = opt1Insights[line] || ai_option_1.orders;
  ai_option_2.orders = opt2Insights[line] || ai_option_2.orders;

  // ── 4. Per-line recommendation (AI options only) ──
  const lineStrategies = { rule_based: standard, ai_option_1, ai_option_2 };
  lineStrategies.recommended = determineLineRecommendation(lineStrategies);
  return lineStrategies;
}

// ─── Top-level orchestrator ────────────────────────────────────────────────
// Per-spec the strategy options are now PER LINE: each active line gets its
// own Standard + two AI-generated strategies via one AI call scoped to that
// line. We fan out across lines in parallel (each line is independent — the
// AI for Line 1 has no dependency on the AI for Line 2). If any single line
// fails, only that line's AI slots become "AI Unavailable" shells — the rest
// of the plant still gets its strategies. The exported shape is
// `{ byLine: { [lineKey]: { rule_based, ai_option_1, ai_option_2, recommended } } }`
// which the modal consumes to render three strategy cards inside each line tab.
export async function generateSequenceStrategies(sequencedResults, masterData, inferredTargetMap = {}, changeoverRules = null, signal) {
  // Defensive fallback: if caller didn't pass live rules, use defaults so the
  // AI prompt + heuristic still get a coherent cost matrix instead of zeros.
  let effectiveRules = changeoverRules;
  if (!effectiveRules || !Array.isArray(effectiveRules) || effectiveRules.length === 0) {
    console.warn("[aiSequenceStrategies] changeoverRules not supplied — using fallback defaults");
    effectiveRules = getFallbackChangeoverRules();
  }

  const lines = Object.keys(sequencedResults || {});
  if (lines.length === 0) {
    return { byLine: {} };
  }

  // Process lines sequentially — one at a time — to avoid bursting multiple
  // simultaneous AI calls that trigger Azure rate-limiting (429) in production.
  // Each line is still isolated with its own try/catch so a single-line
  // failure never blocks the remaining lines from succeeding.
  const buildFallback = (line, err) => {
    if (err?.name === 'AbortError') throw err;
    console.error(`[aiSequenceStrategies] generateLineStrategies(${line}) threw:`, err?.message || err);
    const ruleBasedPlant = buildRuleBasedStrategy({ [line]: sequencedResults[line] || [] }, masterData);
    const standardOrders = ruleBasedPlant.orders[line] || [];
    const standard = {
      id: 'rule_based',
      name: ruleBasedPlant.name || 'Standard Sequence',
      theme: ruleBasedPlant.theme || 'Rule-based',
      description: ruleBasedPlant.description
        || 'Follows the current rule-based sequencing flow using dates and priority rules.',
      icon: ruleBasedPlant.icon,
      color: ruleBasedPlant.color,
      orders: standardOrders,
      metrics: calculateStrategyMetrics({ [line]: standardOrders }),
      isAIRecommended: false,
      isAI: false,
      aiFailed: false,
      sourceType: 'rule_based',
      line,
      reasoningSummary: '',
    };
    const reason = `Line strategy generation failed: ${err && err.message ? err.message : err}`;
    return {
      rule_based: standard,
      ai_option_1: buildFailedLineAIStrategyShell(line, 0, reason),
      ai_option_2: buildFailedLineAIStrategyShell(line, 1, reason),
      recommended: null,
    };
  };

  const lineResults = [];
  for (const line of lines) {
    // Check for cancellation between lines so the user can abort mid-run.
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const result = await generateLineStrategies({
        line,
        lineOrders: sequencedResults[line] || [],
        masterData,
        inferredTargetMap,
        changeoverRules: effectiveRules,
        signal,
      });
      lineResults.push(result);
    } catch (err) {
      lineResults.push(buildFallback(line, err));
    }
  }

  const byLine = {};
  lines.forEach((line, i) => { byLine[line] = lineResults[i]; });
  // Stamp the ISO date this result was generated so the modal can detect
  // stale results when the user views them on a later day.
  const _runDate = _toLocalISO(new Date());
  return { byLine, _runDate };
}
