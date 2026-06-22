// Post-processing stage for the compact AI sequence pipeline.
// This module is Stage 3 of 3:
//   Stage 1 (sequencePreCompute.js) — compute constraint data from raw orders
//   Stage 2 (caller)                — build compact AI prompt, call Azure OpenAI
//   Stage 3 (this file)             — translate AI's ordered ID array into a full
//                                    strategy object with deterministic scheduling
//
// ARCHITECTURE:
// buildStrategyFromSequence() is the single entry point for Stage 3. It:
//   a) Accepts the AI's compact response (flat ordered ID arrays) and the pre-computed
//      context from Stage 1 (computeLineContext)
//   b) Enforces hard constraint tier-ordering (Critical first, then Urgent/Monitor,
//      MTO by date, Flexible in AI-rank order)
//   c) Assigns production dates via a capacity-aware scheduler that tracks
//      committed hours per day and finds the first day with available headroom
//   d) Runs a gap-fill pass to advance flexible orders onto underloaded days
//   e) Applies the mash early-production invariant (mash must be within [floor, avail])
//   f) Returns an aiStrategy object (with orders[].suggested_date populated) that
//      applyLineAIStrategy uses for final metadata stamping and metric assembly
//
// This consolidates the scheduling logic previously duplicated across
// applyAISequenceToOrders, applyLineAIStrategy, and applyBalancedDateHeuristic.
// The downstream applyLineAIStrategy in pure-AI mode only applies position-sort
// and stamps metadata; it does NOT re-run date scheduling.
//
// Export: buildStrategyFromSequence(rawStrategy, ctx)

import { getDiameterKey } from '../utils/changeoverCalc';

// ── Shared constants ──────────────────────────────────────────────────────
const _PHT_MS = 8 * 3600_000;
function _toLocalISO(d) {
  return new Date(d.getTime() + _PHT_MS).toISOString().substring(0, 10);
}
const MTO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const MASH_ALLOWANCE_DAYS = 3;

// Idle-capacity advancement gate (user-confirmed "conditional MTS advancement").
// A Flexible order may only be pulled onto an earlier underloaded day when the
// changeover the move ADDS is small relative to the production hours it places:
// added_changeover / production_hours must be <= this ratio. Moving onto a day
// that already runs a die-compatible (same category|color|diameter) order adds
// ~zero changeover and is always allowed. Tunable: raise to advance more
// aggressively, lower to favour die-continuity even harder.
const IDLE_FILL_CHANGEOVER_RATIO = 0.25;
// Base changeover cost assumed when a pair is absent from ctx.changeoverMatrix
// (the matrix omits transitions at or below this minimum threshold).
const BASE_CHANGEOVER_HOURS = 0.17;

function isMash(o) {
  const f = String(o?.form || '').trim().toUpperCase();
  return f === 'M' || f === 'MASH';
}

function mashEarliestISO(availISO) {
  const floor = _toLocalISO(new Date());
  if (!availISO || !MTO_DATE_RE.test(String(availISO))) return floor;
  const d = new Date(availISO); d.setDate(d.getDate() - MASH_ALLOWANCE_DAYS);
  const start = _toLocalISO(d);
  return start > floor ? start : floor;
}

// Priority tiers for deterministic constraint enforcement.
// Lower tier = placed earlier regardless of AI's ranking.
const CONSTRAINT_TIER = {
  critical: 0,  // must be position 1 — always
  urgent:   1,  // must not be delayed
  monitor:  2,  // must not be delayed
  mto:      3,  // date-anchored; sort chronologically within tier
  flexible: 4,  // AI's relative order is preserved within this tier
};

// Estimate committed production hours for one order.
// Falls back to volume/run-rate when production_hours is absent.
function _orderHours(od) {
  const ph = parseFloat(od.order.production_hours) ||
             Math.max(1, (parseFloat(od.order.production_volume || od.order.total_volume_mt || 0) / 20));
  const ch = parseFloat(od.order._changeoverTotal ?? od.order.changeover_time ?? 0) || 0;
  return ph + ch;
}

// Find the earliest calendar day >= fromISO where dayLoad has enough headroom.
// Respects the safeEndISO ceiling (stops searching if exceeded).
// Falls back to fromISO itself if no day is found within 60 iterations.
function _findCapacityDay(fromISO, neededHrs, dayLoad, capHrs, safeEndISO) {
  let d = new Date(fromISO + 'T00:00:00');
  for (let i = 0; i < 60; i++) {
    const iso = _toLocalISO(d);
    if (safeEndISO && iso > safeEndISO) break;
    if ((dayLoad[iso] || 0) + neededHrs <= capHrs) return iso;
    d.setDate(d.getDate() + 1);
  }
  return fromISO; // fallback: earliest legal date even if over capacity
}

/**
 * Convert a compact AI strategy (flat ordered ID array) into a full aiStrategy
 * object that applyLineAIStrategy can consume.
 *
 * Stage 3 responsibilities (all deterministic — no AI involvement):
 *   1. Tier-sort: enforce Critical → Urgent/Monitor → MTO (chrono) → Flexible (AI rank)
 *   2. Capacity-aware date assignment: find earliest day with headroom for each order
 *   3. Gap-fill: advance flexible orders onto underloaded days where possible
 *   4. Mash invariant: clamp mash order dates to [floor, avail]
 *
 * @param {object} rawStrategy  - AI's compact strategy: { name, reasoning, sequence }
 * @param {object} ctx          - Context from computeLineContext()
 * @returns aiStrategy compatible with applyLineAIStrategy()
 */
export function buildStrategyFromSequence(rawStrategy, ctx) {
  const {
    todayISO,
    orders: ctxOrders,
    changeoverMatrix,
    DAY_CAPACITY_HOURS,
    UNDERLOADED_THRESHOLD_HOURS,
  } = ctx;
  const lookup = new Map(ctxOrders.map(od => [od.id, od]));

  // Accept both new compact format (sequence = array of IDs) and old format
  // (orders = array of objects with order_id fields) as a fallback.
  const rawSeqIds = Array.isArray(rawStrategy.sequence)
    ? rawStrategy.sequence.map(String)
    : (Array.isArray(rawStrategy.orders)
        ? rawStrategy.orders.map(e => String(e?.order_id ?? e?.id ?? e ?? ''))
        : []);

  // ── Step 1: Deterministic tier sort ──────────────────────────────────────
  // Classify each ID into a constraint tier, then stable-sort.
  // Sort key priority:
  //   a) Tier (Critical=0 first, Flexible=4 last)
  //   b) Within same tier: earlier effAvail first (EDF — Earliest Deadline First)
  //   c) Within same tier AND same deadline: shorter jobs first (SJF)
  //      This maximises the count of orders that complete before their deadline
  //      when production capacity is shared across a day. For example, when
  //      several Critical (urgency_rank=0) orders share the same avail date,
  //      placing the 1.24h order before the 8.91h order ensures the short order
  //      finishes well within the deadline window even if the long one overruns.
  //   d) Fallback: AI's relative rank (preserves the AI's ordering intent)
  const tiered = rawSeqIds.map((eid, aiRank) => {
    const od = lookup.get(eid);
    if (!od) return { eid, aiRank, tier: 99, effAvail: null, estHours: 0 };
    let tier;
    // Always derive the tier from od.urgency_rank (set by Stage 1) rather than
    // the raw boolean flags alone. Stage 1 can elevate orders beyond what the
    // raw flags reflect — e.g. isDueToday Flexible orders become urgency_rank=2
    // (Monitor tier) so SJF correctly places them before larger Monitor orders
    // that share the same deadline day.
    const rank = typeof od.urgency_rank === 'number' ? od.urgency_rank : 4;
    if      (rank === 0 || od.critical) tier = CONSTRAINT_TIER.critical;
    else if (rank === 1 || od.urgent)   tier = CONSTRAINT_TIER.urgent;
    else if (rank === 2 || od.monitor)  tier = CONSTRAINT_TIER.monitor;
    else if (rank === 3 || od.mto)      tier = CONSTRAINT_TIER.mto;
    else                                tier = CONSTRAINT_TIER.flexible;
    return { eid, aiRank, tier, effAvail: od.effAvail, estHours: _orderHours(od) };
  });

  tiered.sort((a, b) => {
    // Primary: tier order
    if (a.tier !== b.tier) return a.tier - b.tier;

    // Secondary: EDF — earlier avail date first
    const da = a.effAvail || '9999-12-31';
    const db = b.effAvail || '9999-12-31';
    if (da !== db) return da < db ? -1 : 1;

    // Tertiary (Flexible tier only): defer directly to AI rank.
    // SJF would override the AI's optimization intent (changeover-adjacency
    // vs profit/volume-first) and produce identical after-sequences for two
    // strategies with different objectives. Flexible orders have no hard
    // throughput deadline, so the AI's relative ranking IS the schedule.
    if (a.tier === CONSTRAINT_TIER.flexible) {
      return a.aiRank - b.aiRank;
    }

    // Tertiary (Constrained tiers 0-3): SJF — shorter jobs first to maximise
    // the count of constrained orders that complete before their deadline day.
    // Only apply when the deadline is real (not the '9999-12-31' placeholder).
    if (da !== '9999-12-31' && Math.abs(a.estHours - b.estHours) > 0.1) {
      return a.estHours - b.estHours;
    }

    // Fallback: preserve AI's relative order within tier
    return a.aiRank - b.aiRank;
  });

  // ── Step 1b: Flexible-tier die-continuity regroup ────────────────────────
  // In pure-AI mode the FINAL production adjacency (and therefore total
  // changeover / die-change time) follows this sequence order verbatim — the
  // downstream date gap-fill only relabels calendar dates, it does NOT reorder
  // production. So to honour "advance MTS only when needed" we must group
  // die-compatible (same category|color|diameter) Flexible orders contiguously
  // HERE, rather than scatter them in raw AI rank order.
  //
  // Policy (user-confirmed — "most aggressive die-continuity preservation"):
  //   - Keep Flexible orders clustered by die; do not pull them apart merely to
  //     honour the AI's raw rank. Deadlines remain enforced by the Step-2
  //     capacity scheduler (each order's ceiling = safe_window_end), so grouping
  //     can never push an order past its availability date.
  //   - Greedy grouping preserves the AI's lead ordering of clusters: walk the
  //     AI-ranked Flexible list; the first time a cluster appears, emit it and
  //     immediately pull every later same-cluster Flexible order adjacent.
  //   - Within an identical cluster: order by EDF (earlier availability first),
  //     then by margin (profit%) DESCENDING for orders sharing the same day.
  //
  // Constrained tiers (Critical/Urgent/Monitor/MTO) are never touched here.
  const flexStart = tiered.findIndex(t => t.tier === CONSTRAINT_TIER.flexible);
  if (flexStart !== -1) {
    const head    = tiered.slice(0, flexStart);
    const rest    = tiered.slice(flexStart);
    const flex    = rest.filter(t => t.tier === CONSTRAINT_TIER.flexible);
    const tailMisc = rest.filter(t => t.tier !== CONSTRAINT_TIER.flexible);
    const keyOf = (t) => lookup.get(t.eid)?.clusterKey || `__solo_${t.eid}`;
    const diaOf = (t) => {
      const od = lookup.get(t.eid);
      return getDiameterKey(od) || getDiameterKey(od?.order) || '';
    };
    const emitted = new Set();
    // Build (and mark emitted) one whole exact-cluster run, EDF then margin DESC.
    const buildRun = (key) => {
      const run = flex.filter(x => !emitted.has(x.eid) && keyOf(x) === key);
      run.forEach(x => emitted.add(x.eid));
      // Within an identical cluster: EDF first, then margin (profit%) DESC for
      // orders that share the same delivery/availability day.
      run.sort((a, b) => {
        const da = a.effAvail || '9999-12-31';
        const db = b.effAvail || '9999-12-31';
        if (da !== db) return da < db ? -1 : 1;
        const ma = lookup.get(a.eid)?.profit_score ?? 0;
        const mb = lookup.get(b.eid)?.profit_score ?? 0;
        if (ma !== mb) return mb - ma;
        return a.aiRank - b.aiRank;
      });
      return run;
    };
    // ── Diameter-streak layer (SEPARATE from, and underneath, the exact-cluster
    // grouping) ──────────────────────────────────────────────────────────────
    // A die (diameter) change is the costliest changeover, so emit the exact
    // cluster-runs GROUPED BY DIAMETER. Walk the AI/EDF-ranked Flexible list;
    // the first time a diameter appears, emit its first cluster-run and then
    // immediately pull every later not-yet-emitted same-diameter cluster-run
    // adjacent. This keeps same-diameter orders contiguous WITHOUT ever
    // splitting an exact category|color|diameter cluster (each run is emitted
    // whole, preserving the C1/C2 grouping). Orders with no known diameter fall
    // back to plain cluster grouping. Deadlines remain enforced by the Step-2
    // capacity scheduler (ceiling = safe_window_end), so grouping can never push
    // a Flexible order past its availability date.
    const grouped = [];
    // Emit every not-yet-emitted Flexible cluster-run of one diameter, in EDF
    // order (buildRun handles the within-cluster EDF→margin sort).
    const emitDia = (dia) => {
      for (const u of flex) {
        if (emitted.has(u.eid)) continue;
        if (diaOf(u) !== dia) continue;
        grouped.push(...buildRun(keyOf(u)));
      }
    };
    // HEAD-CONTINUITY: start the Flexible diameter sequence with the diameter of
    // the constrained (head) order produced LAST (latest effAvail). The head
    // tiers (Critical/Urgent/Monitor/MTO) are fixed and run before the Flexible
    // block, so leading the Flexible block with a DIFFERENT diameter inserts an
    // avoidable die change right after the head — the "…4mm(head) → 3mm(flex) →
    // 4mm(flex)…" break. By continuing the head's trailing diameter first, the
    // matching Flexible orders advance to fill the early underloaded capacity
    // WITHOUT splitting the streak, and the other diameters cluster after them.
    // This only reorders whole diameter blocks — exact clusters stay intact and
    // Step-2 still enforces every order's deadline ceiling.
    // `head` is already in production-position order (Critical → Urgent →
    // Monitor → MTO), so the order produced immediately BEFORE the Flexible
    // block is the last head entry with a known diameter. Use exactly that
    // diameter (walking from the tail, skipping unknown-diameter orders) — not a
    // latest-effAvail heuristic, which mishandles same-date ties.
    let preferredFirstDia = '';
    for (let h = head.length - 1; h >= 0; h--) {
      const hd = lookup.get(head[h].eid);
      const hdia = getDiameterKey(hd) || getDiameterKey(hd?.order) || '';
      if (hdia) { preferredFirstDia = hdia; break; }
    }
    if (preferredFirstDia && flex.some(u => !emitted.has(u.eid) && diaOf(u) === preferredFirstDia)) {
      emitDia(preferredFirstDia);
    }
    for (const t of flex) {
      if (emitted.has(t.eid)) continue;
      const dia = diaOf(t);
      if (!dia) { grouped.push(...buildRun(keyOf(t))); continue; }
      emitDia(dia);
    }
    tiered.length = 0;
    tiered.push(...head, ...grouped, ...tailMisc);
  }

  const constrainedSeq = tiered
    .filter(t => lookup.has(t.eid))
    .map(t => t.eid);

  // ── Step 2: Capacity-aware date assignment ────────────────────────────────
  // For each order in the constraint-sorted sequence, find the earliest day
  // >= its safe_window_start that still has sufficient remaining capacity.
  // dayLoad tracks committed hours per calendar date so capacity is shared
  // across all orders in the sequence (not just per-day averages).
  const dayLoad = {};
  const orders = [];
  // Latest date assigned to a Flexible order so far. Flexible orders are
  // emitted diameter-grouped (Step 1b), so flooring each Flexible order's search
  // at the previous Flexible date keeps their dates MONOTONIC along that grouped
  // order — preventing a later (e.g. 3mm) order from back-filling an earlier day
  // among an earlier (e.g. 4mm) block when a large order got bumped forward,
  // which would re-break the die streak in the date view. Hard tiers are
  // unaffected; the floor is also capped by each order's own ceiling so it can
  // never push a Flexible order past its safe window.
  let flexFloorISO = '';

  for (let i = 0; i < constrainedSeq.length; i++) {
    const eid = constrainedSeq[i];
    const od  = lookup.get(eid);
    if (!od) continue;

    const hrs = _orderHours(od);
    // NOTE: isMashOrder is checked BEFORE mto — a mash order that is also MTO
    // must receive the mash early-production allowance (avail − MASH_ALLOWANCE_DAYS),
    // not be pinned verbatim to its contractual avail date.
    let assigned;
    if (od.critical) {
      // Critical: today regardless of capacity (always must go first)
      assigned = todayISO;
    } else if (od.isMashOrder) {
      // Mash (including mash+MTO): produce in [mash_floor, avail]
      const mash_floor = mashEarliestISO(od.effAvail);
      const ceiling = od.effAvail || null;
      assigned = _findCapacityDay(mash_floor, hrs, dayLoad, DAY_CAPACITY_HOURS, ceiling);
    } else if (od.mto) {
      // MTO (non-mash): verbatim avail date — no capacity search
      assigned = od.effAvail || od.order.target_avail_date || todayISO;
    } else if (od.urgent || od.monitor || (typeof od.urgency_rank === 'number' && od.urgency_rank <= 2)) {
      // Firm (urgency_rank ≤ 2): Urgent, Monitor, or isDueToday orders.
      // Schedule as early as possible, ceiling = anchor/avail (today for isDueToday).
      const ceiling = od.anchor || od.effAvail || null;
      assigned = _findCapacityDay(todayISO, hrs, dayLoad, DAY_CAPACITY_HOURS, ceiling);
    } else {
      // Flexible: earliest day with capacity within safe window. Floor the
      // search at the previous Flexible order's date (die-streak monotonicity),
      // but only when that floor does not exceed this order's own ceiling — a
      // hard deadline always wins over streak preservation.
      const ceiling = od.safe_window_end || od.safeEnd || null;
      let fromISO = todayISO;
      if (flexFloorISO && flexFloorISO > fromISO && (!ceiling || flexFloorISO <= ceiling)) {
        fromISO = flexFloorISO;
      }
      assigned = _findCapacityDay(fromISO, hrs, dayLoad, DAY_CAPACITY_HOURS, ceiling);
      if (!flexFloorISO || assigned > flexFloorISO) flexFloorISO = assigned;
    }

    dayLoad[assigned] = (dayLoad[assigned] || 0) + hrs;
    orders.push({
      order_id:       eid,
      position:       i + 1,
      suggested_date: assigned,
      reason:         `Capacity-aware rank ${i + 1} (${rawStrategy.name || 'strategy'})`,
    });
  }

  // ── Step 3: Conditional gap-fill pass ─────────────────────────────────────
  // After capacity scheduling, scan for underloaded days that occur before a
  // flexible order's currently-assigned date. A flexible order is advanced to
  // an earlier underloaded day ONLY when the move is genuinely beneficial
  // (user-confirmed "conditional MTS advancement"):
  //   (a) the candidate day already runs a die-compatible (same clusterKey)
  //       order — advancing joins a compatible run, adding ~zero changeover; or
  //   (b) the candidate day is empty (opening a fresh run adds no changeover); or
  //   (c) the changeover the move would ADD is small relative to the production
  //       hours it places: added_changeover / hrs <= IDLE_FILL_CHANGEOVER_RATIO.
  // Otherwise the order stays clustered on its assigned date. We never advance
  // merely to fill an early calendar slot, and deadlines are unaffected because
  // gap-fill only ever moves orders EARLIER (within the safe window).
  //
  // DIE-STREAK INVARIANT (top priority): the die (diameter) change is the
  // costliest changeover, so an advance is ALSO rejected when it would break a
  // diameter streak in the effective (date, then production-position) ordering —
  // i.e. when it would make a diameter re-appear after a different diameter ran
  // in between (the "4mm → 3mm → 4mm" the planner sees in the date view). MTS
  // orders are still advanced to fill capacity, but only into a slot that keeps
  // their diameter contiguous (e.g. packing a 3mm block right after the 4mm
  // block instead of interleaving it). Hard constraints are untouched — only
  // flexible orders move, and only ever earlier within their safe window.
  //
  // Track which orders/cluster-keys occupy each assigned day so candidate moves
  // can be evaluated against real die-compatibility and transition cost.
  const dayOrderIds = {};
  for (const entry of orders) {
    (dayOrderIds[entry.suggested_date] ||= []).push(entry.order_id);
  }
  // Cheapest changeover (hrs) between two order IDs via the pre-computed matrix.
  // Pairs absent from the matrix sit at/below BASE_CHANGEOVER_HOURS.
  const coBetween = (fromId, toId) => {
    const row = changeoverMatrix?.[String(fromId)];
    const v = row ? row[String(toId)] : undefined;
    return typeof v === 'number' ? v : BASE_CHANGEOVER_HOURS;
  };

  // Diameter key for an order ID via the shared helper (unknown → '').
  const diaOfId = (id) => {
    const m = lookup.get(id);
    return getDiameterKey(m) || getDiameterKey(m?.order) || '';
  };
  // Would moving `movingId` to `newDate` keep every diameter contiguous in the
  // effective production order? The floor runs orders sorted by (suggested_date,
  // production position), so we replay that ordering with the hypothetical move
  // and fail if any KNOWN diameter re-appears after another diameter intervened.
  // Orders with an unknown diameter are transparent (they neither anchor nor
  // break a run) so this never over-constrains on missing data.
  const wouldKeepDiameterContiguous = (movingId, newDate) => {
    const seq = orders.map(e => ({
      dia:  diaOfId(e.order_id),
      date: e.order_id === movingId ? newDate : e.suggested_date,
      pos:  e.position,
    }));
    seq.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.pos - b.pos));
    const seen = new Set();
    let prev = null;
    for (const it of seq) {
      if (!it.dia) continue; // unknown diameter — transparent
      if (it.dia !== prev) {
        if (seen.has(it.dia)) return false; // re-appeared after a gap → die break
        seen.add(it.dia);
        prev = it.dia;
      }
    }
    return true;
  };

  for (const entry of orders) {
    const od = lookup.get(entry.order_id);
    if (!od || !od.flexible) continue;

    const hrs = _orderHours(od);
    const currentDate = entry.suggested_date;
    const safeStart = od.safe_window_start || todayISO;

    // Scan forward from safeStart, looking for an underloaded day before currentDate
    let d = new Date(safeStart + 'T00:00:00');
    const targetD = new Date(currentDate + 'T00:00:00');
    while (d < targetD) {
      const candidate = _toLocalISO(d);
      const load = dayLoad[candidate] || 0;
      if (load < UNDERLOADED_THRESHOLD_HOURS && load + hrs <= DAY_CAPACITY_HOURS) {
        // Evaluate the die-continuity / changeover impact of advancing here.
        const membersOnDay = (dayOrderIds[candidate] || [])
          .filter(id => id !== entry.order_id);
        // Die-compatible = exact cluster match OR same diameter. The diameter
        // (die) change is the dominant cost, so a day already running the same
        // diameter adds ~zero die cost even when color/category differ —
        // advancing onto it preserves the diameter streak.
        const odDia = getDiameterKey(od) || getDiameterKey(od.order);
        const sameDie = membersOnDay.some(id => {
          const m = lookup.get(id);
          if (!m) return false;
          if (m.clusterKey === od.clusterKey) return true;
          const mDia = getDiameterKey(m) || getDiameterKey(m.order);
          return !!odDia && mDia === odDia;
        });
        let addedCO = 0;
        if (!sameDie && membersOnDay.length) {
          addedCO = Math.min(...membersOnDay.map(id => coBetween(id, od.id)));
        }
        const ratioOK = hrs > 0 ? (addedCO / hrs) <= IDLE_FILL_CHANGEOVER_RATIO : addedCO === 0;
        if (!(sameDie || ratioOK)) {
          d.setDate(d.getDate() + 1);
          continue;
        }
        // DIE-STREAK GUARD (overrides the benefit checks above): reject any
        // advance that would split a diameter run in the effective production
        // order. This keeps MTS advancement from interleaving diameters — the
        // order simply keeps scanning for a later (still earlier-than-current)
        // streak-safe slot, or stays put if none exists.
        if (!wouldKeepDiameterContiguous(entry.order_id, candidate)) {
          d.setDate(d.getDate() + 1);
          continue;
        }
        // Move to this underloaded day — free up the current slot
        dayLoad[currentDate] = Math.max(0, (dayLoad[currentDate] || 0) - hrs);
        if ((dayLoad[currentDate] || 0) <= 0) delete dayLoad[currentDate];
        dayLoad[candidate] = load + hrs;
        // Keep the day→order maps in sync for subsequent evaluations.
        if (Array.isArray(dayOrderIds[currentDate])) {
          dayOrderIds[currentDate] = dayOrderIds[currentDate].filter(id => id !== entry.order_id);
        }
        (dayOrderIds[candidate] ||= []).push(entry.order_id);
        entry.suggested_date = candidate;
        break;
      }
      d.setDate(d.getDate() + 1);
    }
  }

  // ── Step 4: Mash early-production invariant ───────────────────────────────
  // Defense-in-depth: ensure every mash order's suggested_date is within
  // [mash_floor, effAvail]. The capacity scheduler already respects this window
  // but this pass catches any edge case where clamps or gap-fill moved a mash
  // order outside the legal window.
  for (const entry of orders) {
    const od = lookup.get(entry.order_id);
    if (!od || !od.isMashOrder) continue;
    const effAvail = od.effAvail;
    if (!effAvail || !MTO_DATE_RE.test(String(effAvail))) continue;
    const floor = mashEarliestISO(effAvail);
    const cur = entry.suggested_date;
    if (cur < floor) entry.suggested_date = floor;
    else if (cur > effAvail) entry.suggested_date = effAvail;
  }

  // ── Step 5: Build aiStrategy object ──────────────────────────────────────
  // Produce the shape that applyLineAIStrategy expects. The orders[].suggested_date
  // values from Steps 2-4 are consumed by applyAISequenceToOrders → resolveSuggestedDate
  // (in pure-AI mode, resolveSuggestedDate accepts the suggested_date verbatim,
  // only clamping it to [today, safeEnd] for format safety).
  return {
    strategy_name:                    String(rawStrategy.name || rawStrategy.strategy_name || '').trim(),
    reasoning_summary:                String(rawStrategy.reasoning || rawStrategy.reasoning_summary || '').trim(),
    distinct_focus:                   String(rawStrategy.distinct_focus || '').trim(),
    difference_from_standard:         String(rawStrategy.difference_from_standard || '').trim(),
    line_specific_observation:        String(rawStrategy.line_specific_observation || '').trim(),
    why_this_strategy_fits_this_line: String(rawStrategy.why_this_strategy_fits_this_line || rawStrategy.line_specific_observation || '').trim(),
    primary_emphasis:                 rawStrategy.primary_emphasis || null,
    secondary_emphasis:               rawStrategy.secondary_emphasis || null,
    deprioritized_factors:            Array.isArray(rawStrategy.deprioritized_factors) ? rawStrategy.deprioritized_factors : [],
    execution_intent:                 rawStrategy.execution_intent || { primary_goal: 'generic_optimization' },
    orders,
    dateAdjustments: [],
  };
}
