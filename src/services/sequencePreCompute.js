// Pre-computation stage for the compact AI sequence pipeline.
// This module is Stage 1 of 3:
//   Stage 1 (this file)  — compute all constraint data from raw orders
//   Stage 2 (caller)     — build a compact AI prompt, call Azure OpenAI
//   Stage 3 (sequencePostProcess.js) — map AI's ID array → full strategy object
//
// Nothing in here calls the AI or mutates orders.
// Export: computeLineContext(line, lineOrders, standardSequence, changeoverRules, inferredTargetMap)

import {
  calculateChangeoverBetween,
  getFallbackChangeoverRules,
} from "@/utils/changeoverCalc";

// ── Shared constants (mirrored from aiSequenceStrategies.js) ─────────────
const _PHT_MS = 8 * 3600_000;
function _toLocalISO(d) {
  return new Date(d.getTime() + _PHT_MS).toISOString().substring(0, 10);
}
const MTO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const DAY_CAPACITY_HOURS = 24;
const UNDERLOADED_THRESHOLD_HOURS = 12;
const MASH_ALLOWANCE_DAYS = 3;

function isMash(o) {
  const f = String(o?.form || '').trim().toUpperCase();
  return f === 'M' || f === 'MASH';
}

function isMTO(o) {
  if (!o.target_avail_date || !MTO_DATE_RE.test(String(o.target_avail_date))) return false;
  const isN10DSourced = o.avail_date_source === 'auto_sequence' || o.date_source === 'n10d';
  return !isN10DSourced;
}

function isCritical(o) {
  return o._n10dStatus === 'Critical' || o._dateCategory === 'critical';
}

function mashEarliestISO(availISO) {
  const floor = _toLocalISO(new Date());
  if (!availISO || !MTO_DATE_RE.test(String(availISO))) return floor;
  const d = new Date(availISO); d.setDate(d.getDate() - MASH_ALLOWANCE_DAYS);
  const start = _toLocalISO(d);
  return start > floor ? start : floor;
}

function getEffectiveAvailISO(order, inferredTargetMap) {
  if (order.target_avail_date && MTO_DATE_RE.test(String(order.target_avail_date))) {
    return String(order.target_avail_date).substring(0, 10);
  }
  const inf = (inferredTargetMap || {})[order.material_code]
           || (inferredTargetMap || {})[order.material_code_fg];
  if (inf?.targetDate && MTO_DATE_RE.test(String(inf.targetDate))) {
    return String(inf.targetDate).substring(0, 10);
  }
  if (order._effectiveDate instanceof Date && !isNaN(order._effectiveDate)) {
    return _toLocalISO(order._effectiveDate);
  }
  return null;
}

function resolveAISchedulingAnchor(effectiveAvail, todayISO) {
  if (effectiveAvail && effectiveAvail < todayISO) return todayISO;
  return effectiveAvail;
}

/**
 * Pre-compute all context the compact AI prompt builder needs for one line.
 *
 * @param {string}   line              - Line key, e.g. "Line 1"
 * @param {object[]} lineOrders        - Already enriched (margin, N10D, etc.) orders for this line
 * @param {object[]} standardSequence  - Standard (rule-based) ordered sequence for this line
 * @param {object}   changeoverRules   - User-configured changeover rules (or null → fallback)
 * @param {object}   inferredTargetMap - N10D inferred target-date lookup
 * @returns Context object consumed by buildCompactLineStrategyPrompt and buildStrategyFromSequence
 */
export function computeLineContext(line, lineOrders, standardSequence, changeoverRules, inferredTargetMap) {
  if (!Array.isArray(lineOrders)) throw new Error(`[computeLineContext] lineOrders must be an array, got ${typeof lineOrders}`);
  if (!Array.isArray(standardSequence)) throw new Error(`[computeLineContext] standardSequence must be an array, got ${typeof standardSequence}`);
  const todayISO = _toLocalISO(new Date());
  const today0   = new Date(); today0.setHours(0, 0, 0, 0);

  const coRules = changeoverRules || getFallbackChangeoverRules();

  // ── Per-order compact metadata (spec-named fields) ────────────────────────
  // Field names match the task spec exactly:
  //   urgency_rank, days_remaining, cluster_id, profit_score, is_pinned,
  //   safe_window_start, safe_window_end
  // Plus internal helpers needed by Stage 3 (mto, critical, isMashOrder, etc.)
  const orders = lineOrders.map(o => {
    const effAvail  = getEffectiveAvailISO(o, inferredTargetMap) || null;
    const anchor    = resolveAISchedulingAnchor(effAvail, todayISO);
    const daysLeft  = effAvail
      ? Math.max(0, Math.ceil((new Date(effAvail) - today0) / 86400000))
      : 999;
    const mto       = isMTO(o);
    const critical  = isCritical(o);
    // Velocity (demand stability) — SECONDARY AI priority signal, sourced from
    // the N10D inferredTargetMap. Stamped onto the live order (_velocity) so it
    // flows through to the ranked/finalRows objects the modal renders.
    const velocity  = (inferredTargetMap || {})[o.material_code]?.velocity
                   || (inferredTargetMap || {})[o.material_code_fg]?.velocity
                   || null;
    o._velocity = velocity;
    const urgent    = o._n10dStatus === 'Urgent';
    const monitor   = o._n10dStatus === 'Monitor';
    const flexible  = !mto && !critical && !urgent && !monitor;
    const mashOrder = isMash(o);

    // urgency_rank: 0=Critical, 1=Urgent, 2=Monitor, 3=MTO-flexible, 4=Flexible
    //
    // KEY RULES:
    // (A) MTO orders with hard avail ≤ today are functionally Critical (rank 0):
    //     they must complete today and cannot be bumped by Urgent MTS orders.
    // (B) ANY order (including Sufficient/Flexible) with effAvail ≤ today is
    //     elevated to minimum Monitor (rank 2): placing a large Monitor-tier
    //     combined order before a small "due today" flexible order would push
    //     the small order past midnight, causing a delay-risk badge. Sharing
    //     rank 2 lets Stage 3's SJF sort run shorter jobs first, maximising
    //     the count that finish within the deadline day.
    //     N10D-inferred dates where avail=today are also covered — if N10D
    //     says stock runs out today, production genuinely needs to happen today.
    const isMTODueToday = mto && effAvail != null && effAvail <= todayISO;
    const isDueToday    = !critical && !isMTODueToday && effAvail != null && effAvail <= todayISO;
    const urgency_rank = (critical || isMTODueToday) ? 0
                       : urgent ? 1
                       : (monitor || isDueToday) ? 2
                       : mto ? 3 : 4;

    // profit_score: margin percentage (0-100 scale)
    const profit_score = Math.round(parseFloat(o._margin ?? o.margin ?? 0) * 10) / 10;

    // is_pinned: true when order must stay on a specific date
    const is_pinned = mto || critical;

    // safe_window_start: earliest date this order can legally start production
    let safe_window_start;
    if (critical || isMTODueToday) {
      // Due today or overdue: must start immediately
      safe_window_start = todayISO;
    } else if (mashOrder) {
      // Mash: can produce MASH_ALLOWANCE_DAYS before the avail date
      safe_window_start = mashEarliestISO(effAvail);
    } else if (mto) {
      // MTO (non-mash): cannot produce before its avail/target date
      safe_window_start = effAvail || todayISO;
    } else {
      // Urgent / Monitor / Flexible: can start as early as today
      safe_window_start = todayISO;
    }

    // safe_window_end: latest date before the order becomes "at risk"
    let safe_window_end;
    if (flexible && !effAvail) {
      // Fully flexible: virtual ceiling of today+10
      const d = new Date(today0); d.setDate(d.getDate() + 10);
      safe_window_end = _toLocalISO(d);
    } else {
      // Use anchor (= max(effAvail, today) for overdue avail) as ceiling
      safe_window_end = anchor || effAvail || null;
    }

    const clusterKey = `${(o.category || '_').toLowerCase()}|${(o.color || '_').toLowerCase()}|${(o.diameter || '_')}`;

    const volume_mt = Math.round(parseFloat(o.volume_override || o.volume || o.total_volume_mt || 0) || 0);

    return {
      id:              String(o.id),
      // Spec-named fields
      urgency_rank,
      days_remaining:  daysLeft,
      cluster_id:      null, // populated after cluster computation below
      profit_score,
      is_pinned,
      safe_window_start,
      safe_window_end,
      volume_mt,
      // Compact display fields (for prompt table)
      desc:   (o.item_description || '').substring(0, 30),
      status: mto ? 'MTO' : (o._n10dStatus || 'Flexible'),
      velocity,
      // Internal fields used by Stage 3 scheduler
      effAvail,
      anchor,
      mto, critical, urgent, monitor, flexible,
      isMashOrder: mashOrder,
      clusterKey,
      order: o,
    };
  });

  // ── Material clusters (2+ orders sharing category|color|diameter) ────────
  const clusterGroups = new Map();
  orders.forEach(od => {
    if (!clusterGroups.has(od.clusterKey)) clusterGroups.set(od.clusterKey, []);
    clusterGroups.get(od.clusterKey).push(od.id);
  });
  const clusters = [];
  let cidx = 1;
  clusterGroups.forEach((ids, key) => {
    if (ids.length >= 2) clusters.push({ label: `C${cidx++}`, key, ids });
  });
  const clusterById = new Map();
  clusters.forEach(c => c.ids.forEach(id => clusterById.set(id, c.label)));

  // Back-fill cluster_id on each order now that cluster labels are known
  orders.forEach(od => {
    od.cluster_id = clusterById.get(od.id) || null;
  });

  // ── Day-load profile from standard sequence ──────────────────────────────
  const dayLoad = new Map();
  (standardSequence || []).forEach(o => {
    const d = o._aiSuggestedDate || o.target_avail_date || null;
    if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return;
    const h = (parseFloat(o.production_hours) || 0)
            + (parseFloat(o._changeoverTotal ?? o.changeover_time ?? 0) || 0);
    dayLoad.set(d, (dayLoad.get(d) || 0) + h);
  });
  const loadProfile = [...dayLoad.entries()]
    .sort(([a], [b]) => a < b ? -1 : 1).slice(0, 6)
    .map(([date, h]) => ({
      date,
      h:          Math.round(h * 10) / 10,
      underloaded: h < UNDERLOADED_THRESHOLD_HOURS,
    }));

  // ── Top 4 expensive changeovers in standard sequence ────────────────────
  const topChangeoversStd = [];
  for (let i = 0; i < (standardSequence || []).length - 1; i++) {
    const a = standardSequence[i], b = standardSequence[i + 1];
    const cost = parseFloat(calculateChangeoverBetween(a, b, coRules)) || 0;
    if (cost > 0.17) topChangeoversStd.push({ from: String(a.id), to: String(b.id), cost });
  }
  topChangeoversStd.sort((a, b) => b.cost - a.cost);

  // ── Full pairwise N×N changeover cost matrix ─────────────────────────────
  // Pre-computes the changeover cost between every pair of orders on this line.
  // Used by:
  //   - Stage 2 (compact prompt): top-N pairs from the full matrix surface
  //     reorder opportunities the AI can exploit (beyond just the standard seq)
  //   - Stage 3 (scheduler): to compute the actual changeover cost of the
  //     AI's proposed sequence when selecting capacity-aware production dates
  // Only pairs with cost above the minimum threshold are stored.
  const changeoverMatrix = {};
  for (let i = 0; i < lineOrders.length; i++) {
    for (let j = 0; j < lineOrders.length; j++) {
      if (i === j) continue;
      const cost = parseFloat(calculateChangeoverBetween(lineOrders[i], lineOrders[j], coRules)) || 0;
      if (cost > 0.17) {
        const fromId = String(lineOrders[i].id);
        if (!changeoverMatrix[fromId]) changeoverMatrix[fromId] = {};
        changeoverMatrix[fromId][String(lineOrders[j].id)] = Math.round(cost * 100) / 100;
      }
    }
  }

  const standardSeqIds = (standardSequence || []).map(o => String(o.id));

  return {
    line,
    todayISO,
    orders,
    clusters,
    clusterById,
    loadProfile,
    topChangeovers:  topChangeoversStd.slice(0, 4),
    changeoverMatrix,
    standardSeqIds,
    inferredTargetMap,
    changeoverRules,
    coRules,
    DAY_CAPACITY_HOURS,
    UNDERLOADED_THRESHOLD_HOURS,
  };
}
