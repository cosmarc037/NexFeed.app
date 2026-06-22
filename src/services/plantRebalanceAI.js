/*
 * plantRebalanceAI.js — Stage 5.5 of the auto-sequence pipeline.
 *
 * Runs AFTER the deterministic combine+placement step and BEFORE per-line AI
 * sequencing. Sends a compact plant-wide snapshot to Azure OpenAI (same model
 * as the sequencing AI) and receives back up to 5 cross-line order diversion
 * suggestions aimed at:
 *   1. Protecting MTO deadlines — move lower-priority orders off overloaded
 *      lines so MTO orders can be produced before their contractual date.
 *   2. Balancing line load — reduce large load-hour gaps between lines that
 *      share eligible orders.
 *
 * LOAD BASIS: the per-line "load hours" used here are production time +
 * sequence-aware changeover, summed from the Stage-5 (post-placement,
 * pre-5.5) snapshot the caller passes in. This MATCHES the plant summary
 * table's "Total Hrs" column — it is deliberately NOT a flat MT ÷ run-rate
 * estimate, so a diversion the AI considers "balancing" agrees with what the
 * summary table shows. The orders carry production_hours (effVol ÷ per-order
 * run rate, batch-ceiling) and _changeoverTotal (set by applyPreviewChangeovers
 * during plantLevelCombineAndPlace) before this module ever sees them.
 *
 * Three exports:
 *   buildRebalancePrompt  — builds { systemPrompt, userPrompt }
 *   parseRebalanceResponse — extracts [{orderId, fromLine, toLine, reason}]
 *   applyDiversions        — moves orders between line arrays and returns
 *                            { sequencedByLine, diversionLog }
 *
 * Stage 5.5 does not RE-optimise changeovers (per-line sequencing does that);
 * it only reads the already-computed changeover load to judge line balance.
 */

import { orderProductionHours, orderChangeoverHours } from "@/utils/lineHours";

const PLANT_RUN_RATE_COL = {
  'Line 1': 'line_1_run_rate', 'Line 2': 'line_2_run_rate',
  'Line 3': 'line_3_run_rate', 'Line 4': 'line_4_run_rate',
  'Line 5': 'line_5_run_rate',
  'Line 6': 'line_6_run_rate', 'Line 7': 'line_7_run_rate',
};

// Line 5 (Powermix) is excluded from Stage 5.5 rebalancing.
// Its orders require a dedicated SFG1 production step and cannot share
// capacity with Feedmill lines without violating Powermix constraints.
// Diversions involving Line 5 ↔ non-Line 5 are never generated.
const PLANT_ALL_LINES = ['Line 1', 'Line 2', 'Line 3', 'Line 4', 'Line 6', 'Line 7'];

const MTO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

const _PHT_MS = 8 * 3600_000;
function _toLocalISO(d) {
  return new Date(d.getTime() + _PHT_MS).toISOString().substring(0, 10);
}

function isMTO(order) {
  if (!order.target_avail_date || !MTO_DATE_RE.test(String(order.target_avail_date))) return false;
  const isN10DSourced = order.avail_date_source === 'auto_sequence' || order.date_source === 'n10d';
  return !isN10DSourced;
}

function getEffectiveVolumeMT(order) {
  for (const v of [order.volume_override, order.volume, order.total_volume_mt, order.volume_mt]) {
    const p = parseFloat(v);
    if (!Number.isNaN(p) && p > 0) return p;
  }
  return 0;
}

// Per-line LOAD hours = Σ(production hours) + Σ(sequence-aware changeover), taken
// from the Stage-5 post-placement snapshot. This is a byte-for-byte mirror of the
// plant summary table's "Total Hrs" basis: both go through @/utils/lineHours, which
// RECOMPUTES production hours per order (effVol ÷ own run rate, Mash → 0) rather than
// trusting the stored production_hours (stale on combined orders). _changeoverTotal
// is the adjacency-aware changeover set by applyPreviewChangeovers. NO volume ÷
// flat-rate fallback — so the AI's load view can never diverge from the table.
function computeLineQueueHours(orders, line) { // eslint-disable-line no-unused-vars
  return (orders || []).reduce(
    (sum, o) => sum + orderProductionHours(o) + orderChangeoverHours(o),
    0,
  );
}

function canProduceOnLine(order, line, kbList) {
  const rrKey = PLANT_RUN_RATE_COL[line];
  if (!rrKey) return false;
  const isGen = order.is_powermix_generated === true || order.is_powermix_generated === 'true';
  const code = isGen
    ? String(order.kb_sfg_material_code || '').trim()
    : String(order.material_code_fg || order.material_code || '').trim();
  if (!code) return false;
  const entry = kbList.find(r => String(r.fg_material_code || '').trim() === code);
  return !!(entry && parseFloat(entry[rrKey] || 0) > 0);
}

function getEligibleLines(order, kbList, shutdownLineSet) {
  return PLANT_ALL_LINES.filter(l => !shutdownLineSet.has(l) && canProduceOnLine(order, l, kbList));
}

function getUrgencyLabel(order, inferredTargetMap) {
  const mc = order.material_code || order.material_code_fg;
  const inf = mc ? (inferredTargetMap || {})[mc] : null;
  if (inf?.status) {
    if (inf.status === 'Critical') return 'Critical';
    if (inf.status === 'Urgent') return 'Urgent';
    if (inf.status === 'Monitor') return 'Monitor';
  }
  if (isMTO(order)) return 'MTO';
  return 'MTS';
}

function isMTOAtRisk(order, queueHours) {
  if (!isMTO(order)) return false;
  const deadline = Date.parse(String(order.target_avail_date));
  if (isNaN(deadline)) return false;
  const hoursUntilDeadline = (deadline - Date.now()) / 3600_000;
  return hoursUntilDeadline < queueHours;
}

/**
 * Build a compact system + user prompt for the plant-wide rebalance AI call.
 *
 * @param {object}   sequencedByLine   - Output from plantLevelCombineAndPlace
 * @param {object[]} kbList            - Knowledge Base records array
 * @param {object}   inferredTargetMap - N10D urgency map { [materialCode]: {status, targetDate} }
 * @param {string[]} shutdownLines     - Lines currently shutdown (excluded as destinations)
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
export function buildRebalancePrompt(sequencedByLine, kbList, inferredTargetMap, shutdownLines = []) {
  const shutdownLineSet = new Set(shutdownLines || []);
  const todayISO = _toLocalISO(new Date());

  const activeLines = PLANT_ALL_LINES.filter(l => !shutdownLineSet.has(l));

  // ── Per-line stats ─────────────────────────────────────────────────────────
  const lineQueueHours = {};
  const lineMTORisks = {};
  for (const line of activeLines) {
    const orders = sequencedByLine[line] || [];
    const queueHrs = computeLineQueueHours(orders, line);
    lineQueueHours[line] = queueHrs;
    lineMTORisks[line] = orders.filter(o => isMTOAtRisk(o, queueHrs)).length;
  }

  // Average queue across active lines (determines "overloaded" threshold)
  const avgQueueHrs = activeLines.reduce((s, l) => s + lineQueueHours[l], 0) / Math.max(1, activeLines.length);
  const OVERLOAD_THRESHOLD = avgQueueHrs + 8; // ≥ 8 h above plant average = overloaded

  // ── Candidate order selection ─────────────────────────────────────────────
  // Include orders that are on overloaded lines OR are MTO orders at deadline
  // risk, AND are eligible to run on at least one OTHER active line.
  const candidates = [];

  for (const line of activeLines) {
    const orders = sequencedByLine[line] || [];
    const queueHrs = lineQueueHours[line];
    const isOverloaded = queueHrs > OVERLOAD_THRESHOLD;

    for (const order of orders) {
      const mtoRisk = isMTOAtRisk(order, queueHrs);
      if (!isOverloaded && !mtoRisk) continue;

      const eligibleLines = getEligibleLines(order, kbList, shutdownLineSet);
      const altLines = eligibleLines.filter(l => l !== line);
      if (altLines.length === 0) continue;

      candidates.push({
        id: order.id,
        desc: String(order.item_description || order.material_code || 'Unknown').substring(0, 28),
        vol: +getEffectiveVolumeMT(order).toFixed(1),
        urgency: getUrgencyLabel(order, inferredTargetMap),
        deadline: isMTO(order) ? String(order.target_avail_date).substring(0, 10) : '—',
        currentLine: line,
        altLines,
        mtoRisk,
      });

      if (candidates.length >= 30) break;
    }
    if (candidates.length >= 30) break;
  }

  // ── System prompt ─────────────────────────────────────────────────────────
  const systemPrompt = `You are a feed production scheduling optimizer. Given a plant-wide order snapshot (post-placement, pre-sequence), suggest up to 5 cross-line diversions to:
1. Protect MTO deadlines — move orders off lines where MTO orders are at deadline risk.
2. Balance line load — reduce load-hour imbalances (load hours = production time + changeovers; plant average: ${avgQueueHrs.toFixed(1)}h).

RULES:
- Only suggest moves for orders listed in DIVERSION CANDIDATES (KB eligibility already verified).
- A candidate may only move to one of its listed Alt Lines — never to any other line.
- Prefer moving MTS/lower-urgency orders before moving MTO or Critical orders.
- Do not suggest more than 5 diversions total.
- Output ONLY valid JSON: {"diversions":[{"orderId":<number>,"fromLine":"<line>","toLine":"<line>","reason":"<one concise sentence>"}]}
- If no beneficial diversion exists, return {"diversions":[]}.`;

  // ── User prompt ────────────────────────────────────────────────────────────
  const lineSummaryText = activeLines.map(l => {
    const qh = lineQueueHours[l].toFixed(1);
    const cnt = (sequencedByLine[l] || []).length;
    const risks = lineMTORisks[l];
    const riskTag = risks > 0 ? `  ⚠️ ${risks} MTO at deadline risk` : '';
    const overTag = lineQueueHours[l] > OVERLOAD_THRESHOLD ? '  [OVERLOADED]' : '';
    return `  ${l}: ${qh}h load, ${cnt} orders${overTag}${riskTag}`;
  }).join('\n');

  const candidateText = candidates.length > 0
    ? candidates.map(c => {
        const riskTag = c.mtoRisk ? ' [MTO DEADLINE RISK]' : '';
        return `  ID ${c.id}: "${c.desc}" | ${c.vol} MT | ${c.urgency}${riskTag} | Deadline: ${c.deadline} | On: ${c.currentLine} | Alt Lines: ${c.altLines.join(', ')}`;
      }).join('\n')
    : '  (none — all orders are single-line-eligible or load is balanced)';

  const userPrompt = `Today: ${todayISO}

LINE SUMMARY (load hours = production time + changeovers, from the Stage-5 post-placement snapshot):
${lineSummaryText}

DIVERSION CANDIDATES (eligible on 2+ active lines, from overloaded or MTO-risk lines):
${candidateText}

Respond with JSON only.`;

  return { systemPrompt, userPrompt };
}

/**
 * Parse the AI's JSON response into a validated diversion list.
 * Returns [] on any parse failure — never throws.
 *
 * @param {string} content - Raw AI response text
 * @returns {{ orderId: string|number, fromLine: string, toLine: string, reason: string }[]}
 */
export function parseRebalanceResponse(content) {
  if (!content) return [];
  try {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed.diversions)) return [];
    return parsed.diversions
      .filter(d => d.orderId != null && d.fromLine && d.toLine && d.reason)
      .slice(0, 5);
  } catch {
    return [];
  }
}

// Float tolerance (hours) for the no-regression guard below — a move is only
// rejected when it raises the peak load by MORE than this, so genuinely
// load-neutral relocations are not blocked by rounding noise.
const REGRESSION_TOLERANCE_HOURS = 0.01;

// Per-order LOAD contribution = production hours + sequence-aware changeover,
// on the SAME shared lineHours basis as computeLineQueueHours / the summary table.
function orderLoadHours(order) {
  return orderProductionHours(order) + orderChangeoverHours(order);
}

/**
 * Apply a list of AI-suggested diversions to the sequencedByLine map.
 * Mutates line arrays by moving order objects; also sets feedmill_line on
 * each moved order so downstream stages (which group by feedmill_line) see
 * the new assignment.
 *
 * NO-REGRESSION (ANTI-OVERSHOOT) GUARD
 * ------------------------------------
 * Diversions are applied sequentially, and each one is committed ONLY if it
 * does not make the busier of the two affected lines carry MORE load than it
 * did before the move. Load uses the SAME basis as the summary table and the
 * AI prompt (production hours + sequence-aware changeover, via @/utils/lineHours).
 *
 * Without this guard the rebalancer can "rob Peter to pay Paul": relieve a line
 * that is only just over threshold by dumping a large order onto another line
 * that then becomes an even worse bottleneck. A diversion only touches two
 * lines, so comparing the peak load of just those two lines (before vs after)
 * is a complete check — every other line is untouched and cannot regress.
 *
 * A genuine MTO-deadline-protection move relieves the heaviest line (that is
 * why its MTO is at risk), so it lowers the two-line peak and passes the guard
 * naturally; no MTO carve-out is required.
 *
 * Rejected diversions are returned in `skippedDiversions` (with the computed
 * before/after peak load) for tracing — they are NOT applied.
 *
 * @param {object}   sequencedByLine - { [line]: order[] } from plantLevelCombineAndPlace
 * @param {object[]} diversions      - Parsed diversion list from parseRebalanceResponse
 * @returns {{ sequencedByLine: object, diversionLog: object[], skippedDiversions: object[] }}
 */
export function applyDiversions(sequencedByLine, diversions) {
  if (!diversions || diversions.length === 0) {
    return { sequencedByLine, diversionLog: [], skippedDiversions: [] };
  }

  const updated = {};
  for (const [line, orders] of Object.entries(sequencedByLine)) {
    updated[line] = [...(orders || [])];
  }

  const diversionLog = [];
  const skippedDiversions = [];

  for (let proposalIndex = 0; proposalIndex < diversions.length; proposalIndex++) {
    const diversion = diversions[proposalIndex];
    const { orderId, fromLine, toLine, reason } = diversion;
    const fromOrders = updated[fromLine];
    if (!Array.isArray(fromOrders)) continue;

    const idx = fromOrders.findIndex(o => String(o.id) === String(orderId));
    if (idx === -1) continue;

    if (!Array.isArray(updated[toLine])) continue;

    const order = fromOrders[idx];
    const orderName = order.item_description || order.material_code || String(orderId);

    // ── No-regression / anti-overshoot guard ──────────────────────────────
    // Evaluate against the running (post prior-diversion) state so chained
    // moves account for one another. fromBefore still INCLUDES this order;
    // toBefore EXCLUDES it. Reject if the move raises the two-line peak load.
    const orderLoad  = orderLoadHours(order);
    const fromBefore = computeLineQueueHours(fromOrders, fromLine);
    const toBefore   = computeLineQueueHours(updated[toLine], toLine);
    const beforeMax  = Math.max(fromBefore, toBefore);
    const afterMax   = Math.max(fromBefore - orderLoad, toBefore + orderLoad);

    if (afterMax > beforeMax + REGRESSION_TOLERANCE_HOURS) {
      skippedDiversions.push({
        proposalIndex,
        orderId: String(orderId),
        orderName,
        fromLine,
        toLine,
        reason,
        skipReason: 'no-regression guard: move would raise peak line load',
        beforeMaxHours: +beforeMax.toFixed(2),
        afterMaxHours: +afterMax.toFixed(2),
      });
      continue;
    }

    // Commit the move.
    fromOrders.splice(idx, 1);
    const movedOrder = {
      ...order,
      feedmill_line: toLine,
      _rebalancedFrom: fromLine,
      _rebalancedReason: reason,
    };
    updated[toLine].push(movedOrder);

    diversionLog.push({
      proposalIndex,
      orderId: String(orderId),
      orderName,
      fromLine,
      toLine,
      reason,
      beforeMaxHours: +beforeMax.toFixed(2),
      afterMaxHours: +afterMax.toFixed(2),
    });
  }

  return { sequencedByLine: updated, diversionLog, skippedDiversions };
}
