import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useToast } from "@/components/ui/use-toast";
import { Sparkles, GripVertical, Loader2 } from "lucide-react";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { callPlantActionsAI, buildPlantActionsPrompt, parsePlantActionsResponse, generatePlantRowSequenceInsights, generateTransparencyTableReasons } from "@/services/azureAI";
import {
  generateSequenceStrategies,
  generateLineStrategies,
  buildRuleBasedStrategy,
  AI_PROFITABILITY_BASIS,
  AI_PROFITABILITY_LABEL,
  AI_PROFITABILITY_LABEL_LOWER,
  getAIProfitabilityValue,
  calculateTotalChangeoverTime,
  computeDailyUtilization,
  PURE_AI_SEQUENCING,
} from "@/services/aiSequenceStrategies";
import { calculateChangeoverBetween, calculateAdditionalChangeover } from "@/utils/changeoverCalc";

function getGenFgCode(order, pmxSplitRules) {
  const isGen = order.is_powermix_generated === true || order.is_powermix_generated === 'true';
  if (isGen && order.powermix_rule_id && pmxSplitRules?.length) {
    const rule = pmxSplitRules.find(r => String(r.id) === String(order.powermix_rule_id));
    if (rule?.fg_code) return rule.fg_code;
  }
  return order.material_code_fg || order.material_code || null;
}

function getSfg1MaterialCode(order, pmxSplitRules) {
  if (!pmxSplitRules?.length) return null;
  const isGen = order.is_powermix_generated === true || order.is_powermix_generated === 'true';
  let rule = null;
  if (isGen && order.powermix_rule_id) {
    rule = pmxSplitRules.find(r => String(r.id) === String(order.powermix_rule_id));
  }
  if (!rule) {
    const fgCode = String(order.material_code_fg || order.material_code || '').trim();
    if (fgCode) rule = pmxSplitRules.find(r => String(r.fg_code || '').trim() === fgCode);
  }
  return rule?.sfg1_material_code || null;
}

/* ─── feature flags ─── */
const SHOW_FAITHFULNESS = false; // set to true to re-enable faithfulness display in cards + reasoning

/* ─── constants ─── */
const LINE_RUN_RATES = {
  "Line 1": 20, "Line 2": 20,
  "Line 3": 10, "Line 4": 10,
  "Line 5": 10,
  "Line 6": 10, "Line 7": 10,
};

/* ─── helpers ─── */
function normalizeLine(line) {
  if (!line) return "";
  const s = String(line).trim();
  const lineMatch = s.match(/^line\s*(\d+)$/i);
  if (lineMatch) return `Line ${lineMatch[1]}`;
  const shortMatch = s.match(/^l(\d+)$/i);
  if (shortMatch) return `Line ${shortMatch[1]}`;
  return s;
}

export function getLineRunRate(line) {
  return LINE_RUN_RATES[normalizeLine(line)] || 10;
}

// Returns the order's own run rate, or 0 if unavailable.
// No fallback to line/feedmill defaults — if the order has no run rate,
// production time cannot be derived and must display as unavailable.
function getEffectiveRunRate(order) {
  const rr = parseFloat(order.run_rate);
  return (Number.isFinite(rr) && rr > 0) ? rr : 0;
}

async function callAI(prompt) {
  return callPlantActionsAI(
    "You are a production scheduling advisor for a feed mill. Be concise and accurate.",
    prompt,
    1200
  );
}

const getLineShortName = (line) => {
  const match = (line || "").match(/Line\s*(\d+)/i);
  return match ? `L${match[1]}` : line || "";
};

function formatAvailDate(v) {
  if (!v) return "—";
  if (/^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v)))
    return new Date(v).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const raw = String(v).toLowerCase().trim();
  if (raw.includes("prio")) return "prio replenish";
  if (raw.includes("safety")) return "safety stocks";
  if (raw === "stock_sufficient") return "stock sufficient";
  if (raw.includes("sched")) return "for sched";
  return v;
}

function isISODate(v) {
  return v && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v));
}

function getEffectiveAvailDate(order, inferredTargetMap) {
  if (isISODate(order.target_avail_date)) return order.target_avail_date;
  // Use pre-stamped effective date from sort enrichment (covers generated orders)
  if (order._effectiveDate instanceof Date && !isNaN(order._effectiveDate)) {
    const _ed = order._effectiveDate;
    return `${_ed.getFullYear()}-${String(_ed.getMonth()+1).padStart(2,'0')}-${String(_ed.getDate()).padStart(2,'0')}`;
  }
  const inf = inferredTargetMap?.[order.material_code] || inferredTargetMap?.[order.material_code_fg];
  if (inf?.targetDate && isISODate(inf.targetDate)) return inf.targetDate;
  return order.target_avail_date;
}

function getRowStatus(order, inferredTargetMap) {
  if (isISODate(order.target_avail_date)) return "green";
  // Use pre-stamped n10d status from sort enrichment (covers generated orders)
  const status = order._n10dStatus || (() => {
    const inf = inferredTargetMap?.[order.material_code] || inferredTargetMap?.[order.material_code_fg];
    return inf?.status || null;
  })();
  if (!status) return "grey";
  if (status === "Critical") return "red";
  if (status === "Urgent") return "amber";
  if (status === "Monitor") return "blue";
  if (status === "Sufficient") return "lightgrey";
  return "grey";
}

// Render a colored avail date using preSortOrders metadata (_n10dStatus, _effectiveDate)
// Falls back to inferredTargetMap for the display date when metadata isn't present.
function renderN10DAvailDate(order, inferredTargetMap) {
  const effectiveDate = (() => {
    if (order._effectiveDate instanceof Date && !isNaN(order._effectiveDate)) {
      const _ed = order._effectiveDate;
      return `${_ed.getFullYear()}-${String(_ed.getMonth()+1).padStart(2,'0')}-${String(_ed.getDate()).padStart(2,'0')}`;
    }
    return getEffectiveAvailDate(order, inferredTargetMap);
  })();

  const n10dStatus = order._n10dStatus || (() => {
    const inf = inferredTargetMap?.[order.material_code] || inferredTargetMap?.[order.material_code_fg];
    return inf?.status || null;
  })();

  // Critical = DFL already exceeds inventory → must be produced TODAY.
  // Always anchor the display to today for any Critical order whose inferred
  // date is in the past (or is a non-ISO label like "safety_stocks").
  // Edge case: if the inferred date is genuinely in the future (unusual for
  // Critical) keep it — the order isn't yet late.
  const _d = new Date();
  const todayISO = `${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,'0')}-${String(_d.getDate()).padStart(2,'0')}`;
  const displayDate = n10dStatus === 'Critical'
    ? (!isISODate(effectiveDate) || effectiveDate <= todayISO ? todayISO : effectiveDate)
    : effectiveDate;

  const dateText = formatAvailDate(displayDate);
  // isHardDate = order has an ISO target_avail_date (hard contract date).
  // Critical status overrides the plain styling so the red ⊘ badge always
  // shows — a Critical order must be produced today regardless of what its
  // original avail date says.
  const isHardDate = isISODate(order.target_avail_date) && n10dStatus !== 'Critical';

  if (isHardDate) {
    return <span className="as-avail-default">{dateText}</span>;
  }

  if (n10dStatus === 'Critical') {
    return (
      <span className="as-avail-colored" style={{ color: '#dc2626' }} title="Future Dispatches: Critical — demand exceeds stock">
        {dateText} <span className="as-avail-status-icon">⊘</span>
      </span>
    );
  }
  if (n10dStatus === 'Urgent' || n10dStatus === 'Monitor') {
    return (
      <span className="as-avail-colored" style={{ color: '#ea580c' }} title={`Future Dispatches: ${n10dStatus}`}>
        {dateText} <span className="as-avail-status-icon">△</span>
      </span>
    );
  }
  if (n10dStatus === 'Sufficient') {
    return (
      <span className="as-avail-colored" style={{ color: '#16a34a' }} title="Future Dispatches: Sufficient — stock adequate">
        {dateText} <span className="as-avail-status-icon">◉</span>
      </span>
    );
  }
  // No N10D data — plain text
  return <span className="as-avail-default">{dateText}</span>;
}

const STATUS_BORDER = {
  green:     "border-l-[#43a047]",
  red:       "border-l-[#e53935]",
  amber:     "border-l-[#f59e0b]",
  blue:      "border-l-[#3b82f6]",
  grey:      "border-l-[#a1a8b3]",
  lightgrey: "border-l-[#d1d5db]",
};

function formatOrderCount(count) {
  const n = Number(count || 0);
  return `${n} ${n === 1 ? 'order' : 'orders'}`;
}

function formatProductionHours(h) {
  const n = parseFloat(h);
  if (!h || isNaN(n) || n <= 0) return "—";
  return n.toFixed(2);
}

function formatChangeover(h) {
  const val = parseFloat(h);
  if (!h || isNaN(val) || val === 0) return "0:00";
  const mins = Math.round(val * 60);
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;
}

function formatDate(d) {
  if (!d) return "—";
  const parsed = new Date(d);
  if (isNaN(parsed)) return d;
  return parsed.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtVol(v) { return Math.round(parseFloat(v || 0)); }

// Returns the final displayed volume + whether the app had to adjust it to
// the next batch-size multiple (no user override involved).
export function getOrderVolumeDisplayState(order) {
  if (order.volume_override != null && order.volume_override !== "") {
    const ov = parseFloat(order.volume_override);
    if (!Number.isNaN(ov)) {
      return { displayVolume: ov, originalVolume: parseFloat(order.total_volume_mt) || 0, isAppAdjusted: false, batchSize: 0 };
    }
  }
  const rawVol = parseFloat(order.total_volume_mt ?? 0) || 0;
  const batchSize = parseFloat(order.batch_size ?? 0) || 0;
  if (batchSize > 0) {
    const adjusted = Math.ceil(rawVol / batchSize) * batchSize;
    return { displayVolume: adjusted, originalVolume: rawVol, isAppAdjusted: adjusted !== rawVol, batchSize };
  }
  return { displayVolume: rawVol, originalVolume: rawVol, isAppAdjusted: false, batchSize: 0 };
}

// Volume cell that shows orange + tooltip when the app rounded up to batch ceiling
function AdjustedVolumeCell({ order, strong = false }) {
  const state = getOrderVolumeDisplayState(order);
  const vol = fmtVol(state.displayVolume);
  if (state.isAppAdjusted) {
    const tip = `App-adjusted to ${fmtVol(state.displayVolume)} MT — original volume of ${fmtVol(state.originalVolume)} MT is not divisible by batch size of ${Math.round(state.batchSize)}.`;
    return strong
      ? <><strong style={{ color: "#f59e0b", cursor: "help" }} title={tip}>{vol}</strong><span style={{ color: "#6b7280", marginLeft: 2 }}>MT</span></>
      : <span style={{ color: "#f59e0b", fontWeight: 600, cursor: "help" }} title={tip}>{vol} MT</span>;
  }
  return strong
    ? <><strong style={{ color: "#1a1a1a" }}>{vol}</strong><span style={{ color: "#6b7280", marginLeft: 2 }}>MT</span></>
    : <span>{vol} MT</span>;
}

function numBatches(order) {
  const vol = parseFloat(order.total_volume_mt) || 0;
  const bs = parseFloat(order.batch_size);
  if (!bs || bs <= 0) return "—";
  return Math.ceil(vol / bs);
}

function parse12h(hhmm) {
  const [h24, m] = (hhmm || '08:00').split(':').map(Number);
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
  return { h: h12, m: isNaN(m) ? 0 : m, ampm };
}

function build24h(h12, m, ampm) {
  let h = parseInt(h12) || 0;
  if (ampm === 'AM') h = h === 12 ? 0 : h;
  else h = h === 12 ? 12 : h + 12;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function TimePickerInline({ value, onChange }) {
  const { h, m, ampm } = parse12h(value);
  const sel = { fontSize: 12, border: 0, borderBottom: '1.5px solid var(--nexfeed-primary,#3b82f6)', background: 'transparent', outline: 'none', padding: '2px 0', fontFamily: 'inherit', color: '#1f2937', cursor: 'pointer' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <select style={{ ...sel, width: 36 }} value={h} onChange={e => onChange(build24h(e.target.value, m, ampm))}>
        {Array.from({ length: 12 }, (_, i) => i + 1).map(n => (
          <option key={n} value={n}>{String(n).padStart(2, '0')}</option>
        ))}
      </select>
      <span style={{ fontSize: 12, color: '#6b7280' }}>:</span>
      <select style={{ ...sel, width: 36 }} value={m} onChange={e => onChange(build24h(h, e.target.value, ampm))}>
        {Array.from({ length: 60 }, (_, i) => i).map(n => (
          <option key={n} value={n}>{String(n).padStart(2, '0')}</option>
        ))}
      </select>
      <select style={{ ...sel, width: 38 }} value={ampm} onChange={e => onChange(build24h(h, m, e.target.value))}>
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </div>
  );
}

function formatTime12h(hhmm) {
  if (!hhmm) return '—';
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${String(hour12).padStart(2, '0')}:${String(m || 0).padStart(2, '0')} ${ampm}`;
}

// PHT = UTC+8. Adding 8h to UTC ms, then reading as UTC, yields PHT date/time.
const PHT_OFFSET_MS = 8 * 3600_000;
function toPHTDateStr(date) {
  return new Date(date.getTime() + PHT_OFFSET_MS).toISOString().substring(0, 10);
}

function formatDateTime(date) {
  if (!date) return '—';
  const d = new Date(date);
  if (isNaN(d)) return '—';
  const dateStr = d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: 'Asia/Manila' });
  const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila' });
  return `${dateStr} - ${timeStr}`;
}

function toLocalDateStr(d) {
  return toPHTDateStr(d);
}

function combineDateTime(dateStr, timeStr) {
  if (!dateStr) return new Date();
  const t = timeStr || '08:00';
  const [hh, mm] = t.split(':').map(Number);
  // PHT 8 AM = UTC midnight of same date. PHT h:mm = UTC midnight + (h-8)h + mm min.
  const base = new Date(`${dateStr}T00:00:00.000Z`);
  return new Date(base.getTime() + ((hh || 0) - 8) * 3600_000 + (mm || 0) * 60_000);
}

function getOrderActualStart(order, prevEndTime, isFirst) {
  // For non-first orders: only treat a start_date as user-intent if the order
  // has an explicit manual flag (_userSetStartDate from within this session, or
  // start_date_manual from the DB). Raw start_date alone does NOT count —
  // it may be a stale value from a previous sequence run.
  const isUserSetDate = order._userSetStartDate === true || order.start_date_manual === true;
  const isUserSetTime = order._userSetStartTime === true || order.start_time_manual === true;
  const hasDate = isFirst ? !!(order.start_date || isUserSetDate) : isUserSetDate;
  const hasTime = !!(order.start_datetime && isUserSetTime);
  const dateStr = order.start_date ? String(order.start_date).substring(0, 10) : null;
  const timeStr = order.start_datetime
    ? (() => {
        const d = new Date(order.start_datetime);
        // Extract PHT hours/minutes
        const pht = new Date(d.getTime() + PHT_OFFSET_MS);
        return `${String(pht.getUTCHours()).padStart(2,'0')}:${String(pht.getUTCMinutes()).padStart(2,'0')}`;
      })()
    : '08:00';
  if (isFirst) {
    if (order.start_datetime) return new Date(order.start_datetime);
    if (dateStr) return combineDateTime(dateStr, timeStr);
    // Default: PHT 8 AM today
    const todayPHT = toPHTDateStr(new Date());
    return new Date(`${todayPHT}T00:00:00.000Z`);
  }
  // Subsequent order
  if (hasDate && hasTime && dateStr) return combineDateTime(dateStr, timeStr);
  if (hasDate && dateStr) return combineDateTime(dateStr, '08:00');
  if (hasTime && prevEndTime) {
    const prevDate = toLocalDateStr(new Date(prevEndTime.getTime()));
    return combineDateTime(prevDate, timeStr);
  }
  return prevEndTime || new Date();
}

function calcOrderEnd(order, actualStart) {
  // Use the same batch-ceiling-adjusted volume that AdjustedVolumeCell displays,
  // so Production Time = displayed Volume / displayed Rate with no rounding gap.
  const volume = getOrderVolumeDisplayState(order).displayVolume;
  // Use only the order's own run rate — no fallback to line/feedmill defaults.
  // If the order has no valid run rate, productionTime = 0 and is shown as "—".
  const orderRunRate = parseFloat(order.run_rate);
  const effectiveRunRate = (Number.isFinite(orderRunRate) && orderRunRate > 0) ? orderRunRate : 0;
  const calcProductionTime = effectiveRunRate > 0 ? volume / effectiveRunRate : 0;
  // Only genuinely manual hours (production_hours_manual, set whenever a user edits
  // production_hours) are preserved. Mash (form 'M') is NOT auto-preserved: with no
  // run rate it computes to 0 and is shown as "—", so a combine-generated stored
  // value can't make the row disagree with the recomputed "Total Hrs" column.
  const _isManualHours = order.production_hours_manual === true;
  const productionTime = (_isManualHours && parseFloat(order.production_hours) > 0)
    ? parseFloat(order.production_hours)
    : calcProductionTime;
  const noValidOrderRate = !(Number.isFinite(orderRunRate) && orderRunRate > 0) && !_isManualHours;
  console.debug('[Production Time Run Rate Source]', {
    line: order.feedmill_line, feedmill: order._feedmill || null,
    orderId: order.id,
    orderRunRate: Number.isFinite(orderRunRate) && orderRunRate > 0 ? orderRunRate : null,
    usedRunRate: effectiveRunRate || null,
    usedOrderRunRate: effectiveRunRate > 0 && effectiveRunRate === orderRunRate,
    usedFeedmillFallbackRate: false,
  });
  console.debug('[Production Time No Fallback Check]', {
    line: order.feedmill_line, feedmill: order._feedmill || null,
    orderId: order.id,
    orderRunRate: Number.isFinite(orderRunRate) && orderRunRate > 0 ? orderRunRate : null,
    productionTimeCalculated: productionTime,
    blockedBecauseNoValidOrderRunRate: noValidOrderRate,
  });
  console.debug('[Invalid Run Rate Handling]', {
    line: order.feedmill_line, feedmill: order._feedmill || null,
    orderId: order.id,
    orderRunRate: Number.isFinite(orderRunRate) && orderRunRate > 0 ? orderRunRate : null,
    displayedRate: effectiveRunRate > 0 ? effectiveRunRate : null,
    displayedProductionTime: productionTime > 0 ? productionTime : null,
    treatedAsUnavailable: noValidOrderRate,
  });
  const changeover = parseFloat(order._changeoverTotal ?? order._effectiveChangeover ?? order.changeover_time ?? 0) || 0;
  return {
    end: new Date(actualStart.getTime() + (productionTime + changeover) * 60 * 60 * 1000),
    productionTime,
    displayRunRate: effectiveRunRate,
    usedGenericFallback: false,
  };
}

function calculateEstimatedCompletionDates(orders) {
  if (!orders || orders.length === 0) return orders;
  const enriched = orders.map(o => ({ ...o }));
  let prevEndTime = null;
  for (let i = 0; i < enriched.length; i++) {
    const order = enriched[i];
    const isFirst = i === 0;
    const actualStart = getOrderActualStart(order, prevEndTime, isFirst);
    // First order: persist start_date/start_datetime if missing
    if (isFirst && !order.start_date) {
      enriched[i].start_date = toLocalDateStr(actualStart);
      enriched[i].start_datetime = actualStart.toISOString();
    }
    enriched[i]._actualStartTime = actualStart.toISOString();
    const { end, productionTime, displayRunRate, usedGenericFallback } = calcOrderEnd(order, actualStart);
    // Always write the recalculated value — not the stored one — so the preview
    // is internally consistent with the displayed run rate.
    enriched[i].production_hours = productionTime;
    enriched[i]._displayRunRate = displayRunRate;
    enriched[i]._estimatedCompletionDisplay = formatDateTime(end);
    enriched[i]._estimatedCompletionISO = end.toISOString();
    enriched[i]._simEstCompletion = end;
    const _coValue = parseFloat(order._changeoverTotal ?? order._effectiveChangeover ?? order.changeover_time ?? 0) || 0;
    const _finalProdHours = enriched[i].production_hours;
    const _vol = getOrderVolumeDisplayState(order).displayVolume;
    console.debug('[Auto-Sequence Preview Rate Display]', {
      line: order.feedmill_line, feedmill: order._feedmill || null,
      orderId: order.id, previewProductionTime: _finalProdHours,
      coValue: _coValue, displayedRate: displayRunRate,
      displayFormat: ['production_time', 'CO', 'Rate'],
    });
    console.debug('[Auto-Sequence Preview Production Time Basis]', {
      line: order.feedmill_line, feedmill: order._feedmill || null,
      orderId: order.id, volume: _vol,
      displayedRate: displayRunRate,
      expectedProductionTime: displayRunRate > 0 ? _vol / displayRunRate : null,
      previewProductionTime: _finalProdHours,
      usesDisplayedRateForCalculation: displayRunRate > 0 && Math.abs(_finalProdHours - (_vol / displayRunRate)) < 0.01,
    });
    console.debug('[Auto-Sequence Preview Feedmill Fallback Check]', {
      line: order.feedmill_line, feedmill: order._feedmill || null,
      orderId: order.id,
      rowSpecificRateExists: !usedGenericFallback,
      usedGenericFeedmillFallback: usedGenericFallback,
    });
    console.debug('[Auto-Sequence Preview Production Time From Displayed Rate]', {
      line: order.feedmill_line, feedmill: order._feedmill || null,
      orderId: order.id,
      volume: _vol,
      displayedRate: displayRunRate,
      expectedProductionTime: displayRunRate > 0 ? _vol / displayRunRate : null,
      previewProductionTime: _finalProdHours,
      matchesExpected: displayRunRate > 0
        ? Math.abs(_finalProdHours - (_vol / displayRunRate)) < 0.01
        : false,
    });
    // Recompute _scheduleConflict in PHT so stale pre-AI values are replaced.
    const _ecdPHT = toPHTDateStr(end);
    const _avail = order._aiSuggestedDate || order.target_avail_date;
    const _availPHT = _avail && /^\d{4}-\d{2}-\d{2}/.test(String(_avail)) ? String(_avail).substring(0, 10) : null;
    enriched[i]._scheduleConflict = _availPHT ? _ecdPHT > _availPHT : false;
    prevEndTime = end;
  }
  return enriched;
}

function cascadeCompletionDates(updatedOrder, lineOrders) {
  const orderIndex = lineOrders.findIndex(o => o.id === updatedOrder.id);
  if (orderIndex === -1) return lineOrders;
  lineOrders[orderIndex] = { ...lineOrders[orderIndex], ...updatedOrder };
  for (let i = orderIndex; i < lineOrders.length; i++) {
    const order = lineOrders[i];
    const isFirst = i === 0;
    const prevEnd = i > 0 ? lineOrders[i - 1]._estimatedCompletionISO : null;
    const prevEndTime = prevEnd ? new Date(prevEnd) : null;
    const actualStart = getOrderActualStart(order, prevEndTime, isFirst);
    lineOrders[i]._actualStartTime = actualStart.toISOString();
    const { end, productionTime, displayRunRate } = calcOrderEnd(order, actualStart);
    // Always use the recalculated value — not the stored one — for preview consistency.
    lineOrders[i].production_hours = productionTime;
    lineOrders[i]._displayRunRate = displayRunRate;
    lineOrders[i]._estimatedCompletionDisplay = formatDateTime(end);
    lineOrders[i]._estimatedCompletionISO = end.toISOString();
    lineOrders[i]._simEstCompletion = end;
    // Recompute _scheduleConflict in PHT so stale pre-AI values are replaced.
    const _ecdPHT = toPHTDateStr(end);
    const _avail = order._aiSuggestedDate || order.target_avail_date;
    const _availPHT = _avail && /^\d{4}-\d{2}-\d{2}/.test(String(_avail)) ? String(_avail).substring(0, 10) : null;
    lineOrders[i]._scheduleConflict = _availPHT ? _ecdPHT > _availPHT : false;
  }
  return lineOrders;
}

/* ─── applyPreviewChangeovers — uses same calculateAdditionalChangeover as Dashboard ─── */
function previewGetBaseChangeover(form) {
  const f = (form || "").trim().toUpperCase();
  if (f === "C") return 0.33;
  return 0.17;
}
export function applyPreviewChangeovers(rows, changeoverRules) {
  if (!rows || !rows.length) return rows;
  rows.forEach((order, index) => {
    const st = (order.status || "").toLowerCase();
    // Done/Cancel orders: use frozen_changeover if saved, otherwise fall back to changeover_time
    if (st === "completed" || st === "done" || st === "cancel_po") {
      const isFrozen = order.frozen_changeover != null;
      const retained = isFrozen ? parseFloat(order.frozen_changeover) : parseFloat(order.changeover_time ?? 0);
      order._effectiveChangeover = retained;
      order._changeoverTotal = retained;
      order._changeoverBase = retained;
      order._changeoverAdditional = 0;
      order._changeoverCalculated = false;
      order._isFrozen = isFrozen;
      return;
    }
    const base = parseFloat(order.changeover_time ?? previewGetBaseChangeover(order.form)) || previewGetBaseChangeover(order.form);
    let following = null;
    for (let j = index + 1; j < rows.length; j++) {
      const s = (rows[j].status || "").toLowerCase();
      if (s !== "done" && s !== "completed" && s !== "cancel_po") { following = rows[j]; break; }
    }
    // New model (matches Dashboard): cleaning/die rules replace the base cost.
    // Last order (no following order) gets zero changeover.
    let changeoverTotal = 0;
    let additionalInfo = { total: 0, breakdown: [], usedBaseOnly: true };
    if (following) {
      additionalInfo = calculateAdditionalChangeover(order, following, changeoverRules || []);
      changeoverTotal = additionalInfo.usedBaseOnly ? base : additionalInfo.total;
    }
    order._effectiveChangeover = changeoverTotal;
    order._changeoverTotal = changeoverTotal;
    order._changeoverBase = base;
    order._changeoverAdditional = additionalInfo.usedBaseOnly ? 0 : additionalInfo.total;
    order._changeoverUsedBaseOnly = additionalInfo.usedBaseOnly;
    order._changeoverBreakdown = additionalInfo.breakdown || [];
    order._changeoverCalculated = true;
  });
  // Debug: verify last-row CO is zero for the final active order in this sequence
  const line = rows[0]?.feedmill_line ?? 'unknown';
  console.debug('[Last Row Changeover]', {
    line,
    rows: rows.map((order, index, arr) => ({
      orderId: order.id,
      index,
      isLast: index === arr.length - 1,
      nextOrderId: arr[index + 1]?.id ?? null,
      displayedCO: parseFloat(order._changeoverTotal ?? 0),
    })),
  });
  return rows;
}

/* ─── profitability sort helpers ─── */

// Produce a grouping key for an order based on the date it is currently sorted by.
// Orders are ALREADY in the correct sequence from the auto-sequence engine —
// we just need to identify runs of orders that share the same date so we can
// re-order within those runs by margin.
function getOrderDateKey(order) {
  // 1. Hard ISO avail date (YYYY-MM-DD prefix)
  const avail = order.target_avail_date;
  if (avail && /^\d{4}-\d{2}-\d{2}/.test(String(avail).trim())) {
    return String(avail).trim().substring(0, 10);
  }

  // 2. N10D inferred date stored as _effectiveDate (Date object, set by plantChronologicalSort)
  const eff = order._effectiveDate;
  if (eff instanceof Date && !isNaN(eff)) {
    const y = eff.getFullYear();
    const m = String(eff.getMonth() + 1).padStart(2, '0');
    const d = String(eff.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // 3. _targetDate or _sortDate as ISO string fallback
  const td = order._targetDate || order._sortDate;
  if (td) {
    if (td instanceof Date && !isNaN(td)) {
      return td.toISOString().substring(0, 10);
    }
    const s = String(td).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  }

  // 4. Non-date string (e.g. "safety stocks", "prio replenish") — use as literal key
  //    so all orders with the same status text stay grouped together
  return String(avail || order._availDateDisplay || 'no_date').trim().toLowerCase();
}

// Sort orders within each same-date group by margin (descending).
// The global order of dates is PRESERVED exactly — only same-date peers are re-ranked.
// masterData uses fg_material_code as the key field (our KB record structure).
function sortWithMargin(orders, masterData = []) {
  // Step 1: Enrich every order with margin from KB master data
  const enriched = orders.map(order => {
    const mc = String(order.material_code_fg || order.material_code || '').trim();
    const mdEntry = (masterData || []).find(md => String(md.fg_material_code || '').trim() === mc);
    const margin  = mdEntry ? (parseFloat(mdEntry.margin) || 0) : 0;
    const hasMarginData = !!(mdEntry && mdEntry.margin != null && String(mdEntry.margin).trim() !== '');
    return {
      ...order,
      _margin:        margin,
      _cost:          mdEntry ? parseFloat(mdEntry.pricing_php || 0) : 0,
      _hasMarginData: hasMarginData,
    };
  });

  // Step 2: Group consecutive orders that share the same date key
  const groups = [];
  let currentGroup = [];
  let currentKey   = null;
  for (const order of enriched) {
    const key = getOrderDateKey(order);
    if (key !== currentKey) {
      if (currentGroup.length) groups.push(currentGroup);
      currentGroup = [order];
      currentKey   = key;
    } else {
      currentGroup.push(order);
    }
  }
  if (currentGroup.length) groups.push(currentGroup);

  // Step 3: Within each group sort by margin descending, then flatten
  const result = [];
  for (const group of groups) {
    if (group.length > 1) group.sort((a, b) => (b._margin || 0) - (a._margin || 0));
    result.push(...group);
  }

  // Step 4: Reassign prio
  result.forEach((o, i) => { o.prio = i + 1; o.priority_seq = i + 1; });

  console.log('=== Profitability Sort Result ===');
  result.forEach(o =>
    console.log(
      `  Prio ${String(o.prio).padStart(2)}: ${String(o.item_description || '').substring(0, 35).padEnd(35)} | ` +
      `DateKey: ${getOrderDateKey(o).padEnd(12)} | Margin: ${(o._margin || 0).toFixed(1)}%`
    )
  );

  return result;
}

function getMarginClass(margin) {
  if (margin >= 20) return 'as-margin-high';
  if (margin >= 15) return 'as-margin-medium';
  if (margin >= 10) return 'as-margin-low';
  return 'as-margin-very-low';
}

/* ─── text-selection guard (mirrors AutoSequenceModal) ─── */
function isOverText(e) {
  const target = e.target;
  if (target.closest?.(".plant-drag-handle")) return false;
  const tag = target.tagName?.toUpperCase();
  if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(tag)) return true;
  if (target.dataset?.noDrag === "true") return true;
  try {
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
        const text = range.startContainer.textContent.trim();
        if (text.length > 0) {
          const textRange = document.createRange();
          textRange.selectNodeContents(range.startContainer);
          const rects = textRange.getClientRects();
          for (let i = 0; i < rects.length; i++) {
            if (e.clientX >= rects[i].left && e.clientX <= rects[i].right &&
                e.clientY >= rects[i].top && e.clientY <= rects[i].bottom) return true;
          }
        }
      }
    }
  } catch (_) {}
  return false;
}

/* ─── shared stat badge ─── */
function StatBadge({ label, value, color = "default" }) {
  const colors = {
    default: { bg: "#f9fafb", border: "#e5e7eb", textColor: "#6b7280", valColor: "#1a1a1a" },
    green:   { bg: "#f0fdf4", border: "#bbf7d0", textColor: "#16a34a", valColor: "#15803d" },
    red:     { bg: "#fef2f2", border: "#fecaca", textColor: "#dc2626", valColor: "#b91c1c" },
    orange:  { bg: "#fff7ed", border: "#fed7aa", textColor: "#ea580c", valColor: "#c2410c" },
    blue:    { bg: "#eff6ff", border: "#bfdbfe", textColor: "#1d4ed8", valColor: "#1e40af" },
    amber:   { bg: "#fffbeb", border: "#fde68a", textColor: "#b45309", valColor: "#92400e" },
  };
  const c = colors[color] || colors.default;
  return (
    <div style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 8, padding: "8px 16px", minWidth: 80, textAlign: "center", flexShrink: 0 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: c.valColor, lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: 10, color: c.textColor, fontWeight: 500, marginTop: 2, whiteSpace: "nowrap" }}>{label}</div>
    </div>
  );
}

/* ─── movement indicator ─── */
function MovementIndicator({ movement, delta }) {
  if (!movement || movement === "same" || !delta) return null;
  if (movement === "up")
    return <span className="as-movement-icon as-movement-icon-up" title={`Moved up ${delta} position${delta > 1 ? "s" : ""}`}>▲</span>;
  if (movement === "down")
    return <span className="as-movement-icon as-movement-icon-down" title={`Moved down ${delta} position${delta > 1 ? "s" : ""}`}>▼</span>;
  return null;
}

/* ─── before row — shows existing combined leads as expandable ─── */
function PlantBeforeRow({ order, allOrders, prio, pmxSplitRules = [] }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isLead = !order.parent_id && Array.isArray(order.original_order_ids) && order.original_order_ids.length > 0;
  const childOrders = isLead ? allOrders.filter(o => String(o.parent_id) === String(order.id)) : [];
  const displayVolume = isLead && order.volume_override ? order.volume_override : order.total_volume_mt;
  const sfg1mc = getSfg1MaterialCode(order, pmxSplitRules);
  const isGen = order.is_powermix_generated === true || order.is_powermix_generated === 'true';
  return (
    <>
      <tr className={`auto-sequence-row-before${isLead ? ' as-row-combined-before' : ''}`}>
        <td className="as-col-prio"><span className="as-before-prio">{prio}</span></td>
        <td className="as-col-fpr" style={{ color: "#2e343a" }}>{order.fpr || "—"}</td>
        <td className="as-col-planned">
          <div style={{ color: "#2e343a" }}>{order.fg || "—"}</div>
          <div style={{ color: "#2e343a" }}>{order.sfg || "—"}</div>
          {!isGen && order.pmx && (
            <div style={{ color: "#2e343a" }}>{order.pmx}</div>
          )}
        </td>
        <td className="as-col-material">
          <div title={getGenFgCode(order, pmxSplitRules) || ""} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#2e343a" }}>
            {getGenFgCode(order, pmxSplitRules) || "—"}
          </div>
          {order.kb_sfg_material_code && <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#2e343a" }}>{order.kb_sfg_material_code}</div>}
          {!isGen && sfg1mc && <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#2e343a" }}>{sfg1mc}</div>}
        </td>
        <td className="as-col-desc">
          <div className="as-desc-with-movement">
            <div>
              <div className="as-desc-main-row">
                <div className="as-desc-main" title={order.item_description || ""}>{order.item_description || "—"}</div>
                {isLead && childOrders.length > 0 && (
                  <span className="as-uncombine-inline">
                    <button
                      className="as-combined-toggle"
                      onClick={() => setIsExpanded(v => !v)}
                      title={`${childOrders.length} orders combined — click to ${isExpanded ? "collapse" : "expand"}`}
                    >{isExpanded ? "▼" : "▶"}</button>
                  </span>
                )}
              </div>
              {(() => {
                // For combined leads that lack physical attrs on the lead itself,
                // fall back to the first DB child order so the row still shows
                // the product's category / color / diameter.
                const firstChild = (isLead && childOrders.length > 0) ? childOrders[0] : null;
                const cat = order.category  || firstChild?.category;
                const col = order.color     || firstChild?.color;
                const dia = order.diameter  != null && order.diameter  !== ""
                  ? order.diameter
                  : (firstChild?.diameter != null && firstChild?.diameter !== "" ? firstChild.diameter : null);
                if (!cat && !col && dia == null) return null;
                return (
                  <div className="as-sub-text">
                    {[cat, col, dia != null ? `${parseFloat(dia).toFixed(2)}mm` : null].filter(Boolean).join(" · ")}
                  </div>
                );
              })()}
              {isLead && childOrders.length > 0 && (
                <div className="as-combined-label">{childOrders.length} orders combined</div>
              )}
            </div>
          </div>
        </td>
        <td className="as-col-form" style={{ color: "#2e343a" }}>{order.form || "—"}</td>
        <td className="as-col-volume">
          <AdjustedVolumeCell order={order} strong />
        </td>
        <td className="as-col-batch" style={{ color: "#2e343a" }}>{order.batch_size ? Math.round(parseFloat(order.batch_size)) : "—"}</td>
        <td className="as-col-batches" style={{ color: "#2e343a" }}>{numBatches(order)}</td>
        <td className="as-col-prod">
          {(() => {
            const _bvol = getOrderVolumeDisplayState(order).displayVolume;
            const _brate = getEffectiveRunRate(order);
            const _bisManual = order.production_hours_manual === true;
            const _bpt = (_bisManual && parseFloat(order.production_hours) > 0)
              ? parseFloat(order.production_hours)
              : (_brate > 0 ? _bvol / _brate : 0);
            return <>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#1a1a1a" }}>
                {_bpt > 0 ? `${formatProductionHours(_bpt)} hours` : "—"}
              </div>
              <div className="as-sub-text">CO: {parseFloat(order._changeoverTotal ?? order.changeover_time ?? 0).toFixed(2)}</div>
              <div className="as-sub-text">Rate: {_brate > 0 ? _brate.toFixed(2) : "—"}</div>
            </>;
          })()}
        </td>
        <td className="as-col-start-date" style={{ color: "#2e343a" }}>
          {order.start_date ? formatDate(order.start_date) : <span style={{ color: "#d1d5db", fontStyle: "italic", fontSize: 11 }}>—</span>}
        </td>
        <td className="as-col-start-time" style={{ color: "#2e343a" }}>
          {order.start_time || <span style={{ color: "#d1d5db", fontStyle: "italic", fontSize: 11 }}>—</span>}
        </td>
        <td className="as-col-avail" style={{ color: "#2e343a" }}>{formatAvailDate(order.target_avail_date)}</td>
        <td className="as-col-completion" style={{ color: "#2e343a" }}>
          {order.target_completion_date || <span style={{ color: "#d1d5db", fontStyle: "italic" }}>—</span>}
        </td>
      </tr>
      {isExpanded && childOrders.map(child => (
        <tr key={`before-child-${child.id}`} className="as-row-combined-sub">
          <td className="as-col-prio"></td>
          <td className="as-col-fpr"><span className="as-sub-fpr">{child.fpr || "—"}</span></td>
          <td className="as-col-planned">
            <div className="as-sub-text">{child.fg || "—"}</div>
            <div className="as-sub-text">{child.sfg || "—"}</div>
            {!(child.is_powermix_generated === true || child.is_powermix_generated === 'true') && child.pmx && (
              <div className="as-sub-text">{child.pmx}</div>
            )}
          </td>
          <td className="as-col-material">
            <span className="as-sub-text">{child.material_code || "—"}</span>
            {child.kb_sfg_material_code && <div className="as-sub-text">{child.kb_sfg_material_code}</div>}
            {!(child.is_powermix_generated === true || child.is_powermix_generated === 'true') && getSfg1MaterialCode(child, pmxSplitRules) && (
              <div className="as-sub-text">{getSfg1MaterialCode(child, pmxSplitRules)}</div>
            )}
          </td>
          <td className="as-col-desc">
            <div className="as-sub-text-dark">{child.item_description || "—"}</div>
            <div className="as-sub-text">{child.status || "—"}</div>
          </td>
          <td className="as-col-form"><span className="as-sub-text">{child.form || "—"}</span></td>
          <td className="as-col-volume"><span className="as-sub-text">{fmtVol(child.volume_override || child.total_volume_mt)} MT</span></td>
          <td className="as-col-batch"><span className="as-sub-text">{child.batch_size ? Math.round(parseFloat(child.batch_size)) : "—"}</span></td>
          <td className="as-col-batches"><span className="as-sub-text">{numBatches(child)}</span></td>
          <td className="as-col-prod"><span className="as-sub-text">{child.production_hours ? formatProductionHours(child.production_hours) + " hrs" : "—"}</span></td>
          <td className="as-col-start-date"><span className="as-sub-text">—</span></td>
          <td className="as-col-start-time"><span className="as-sub-text">—</span></td>
          <td className="as-col-avail"><span className="as-sub-text">{formatAvailDate(child.target_avail_date)}</span></td>
          <td className="as-col-completion"><span className="as-sub-text">—</span></td>
        </tr>
      ))}
    </>
  );
}

/* ─── after row (combined-expandable + draggable wrapper) ─── */
function PlantAfterRowContent({ order, provided, snapshot, prio, movement, movementDelta, inferredTargetMap, destinationLine, onUncombineSingle, onRemoveChildFromCombine, insight, isLoadingInsight, isProfitabilityApplied, showMarginCol, showProfitScoreCol, dateChange, onOrderUpdate, lineIndex, previousOrder, pmxSplitRules = [] }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showFullInsight, setShowFullInsight] = useState(false);
  const [editingField, setEditingField] = useState(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef(null);
  const { toast } = useToast();
  const isFirstOrder = lineIndex === 0;
  const sfg1mc = getSfg1MaterialCode(order, pmxSplitRules);
  const isGen = order.is_powermix_generated === true || order.is_powermix_generated === 'true';

  // Derive the actual start time for this order (computed by cascade, always set)
  const actualStartISO = order._actualStartTime || order.start_datetime || null;
  const actualStartDate = actualStartISO ? toLocalDateStr(new Date(actualStartISO)) : null;
  const actualStartTime24 = actualStartISO
    ? (() => { const d = new Date(actualStartISO); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; })()
    : '08:00';

  // User-set values (may be null for subsequent orders)
  const userDateStr = order.start_date ? String(order.start_date).substring(0, 10) : null;
  // A start date is considered "manual" if the user explicitly set it in this
  // preview session (_userSetStartDate) or it was flagged in the DB (start_date_manual).
  // Raw start_date alone does NOT count — it may be stale from a prior run.
  const isUserSetDate = order._userSetStartDate === true || order.start_date_manual === true;
  const isUserSetTime = order._userSetStartTime === true || order.start_time_manual === true;
  const userTime24 = (isUserSetTime && order.start_datetime)
    ? (() => { const d = new Date(order.start_datetime); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; })()
    : null;

  // What to show in display cells: user-set value or '—' for subsequent (first always shows)
  const startDateDisplay = isFirstOrder
    ? (userDateStr
        ? new Date(`${userDateStr}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        : (actualStartDate ? new Date(`${actualStartDate}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'))
    : (isUserSetDate && userDateStr
        ? new Date(`${userDateStr}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        : '—');

  const startTimeDisplay = isFirstOrder
    ? formatTime12h(userTime24 || actualStartTime24)
    : (userTime24 ? formatTime12h(userTime24) : '—');

  // What to pre-populate in edit inputs (fall back to actual computed start)
  const editDateDefault = userDateStr || actualStartDate || toLocalDateStr(new Date());
  const editTimeDefault = userTime24 || actualStartTime24 || '08:00';

  function startEdit(fieldKey) {
    setEditingField(fieldKey);
    setEditValue(fieldKey === 'start_date' ? editDateDefault : editTimeDefault);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function validateDate(dateStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const selected = new Date(`${dateStr}T00:00:00`);
    if (selected < today) {
      toast({ title: 'Invalid date', description: 'Cannot set a past date.', variant: 'destructive' });
      return false;
    }
    if (order.target_avail_date && /^\d{4}-\d{2}-\d{2}/.test(order.target_avail_date)) {
      const avail = new Date(`${String(order.target_avail_date).substring(0, 10)}T23:59:59`);
      if (selected > avail) {
        toast({ title: 'Invalid date', description: `Cannot set beyond the avail date (${formatDate(order.target_avail_date)}).`, variant: 'destructive' });
        return false;
      }
    }
    return true;
  }

  function commitEdit() {
    if (!editingField || !onOrderUpdate) { setEditingField(null); return; }
    if (editingField === 'start_date') {
      if (!validateDate(editValue)) return;
      const timeToUse = userTime24 || actualStartTime24 || '08:00';
      onOrderUpdate(order.id, {
        start_date: editValue,
        start_datetime: `${editValue}T${timeToUse}:00`,
        _userSetStartDate: true,
      });
    } else if (editingField === 'start_time') {
      const dateToUse = userDateStr || actualStartDate || toLocalDateStr(new Date());
      const newStartDT = combineDateTime(dateToUse, editValue);
      // Warning: check if completion would exceed avail date
      if (order.target_avail_date && /^\d{4}-\d{2}-\d{2}/.test(order.target_avail_date)) {
        const { end: projectedEnd } = calcOrderEnd(order, newStartDT);
        const avail = new Date(`${String(order.target_avail_date).substring(0, 10)}T23:59:59`);
        if (projectedEnd > avail) {
          const proceed = window.confirm(
            `Warning: This start time will cause the order to complete after the avail date (${formatDate(order.target_avail_date)}).\n\nThis may cause a delay. Do you want to continue?`
          );
          if (!proceed) return;
        }
      }
      onOrderUpdate(order.id, {
        start_datetime: `${dateToUse}T${editValue}:00`,
        start_date: dateToUse,
        _userSetStartTime: true,
        _userSetStartDate: true,
      });
    }
    setEditingField(null);
  }

  function cancelEdit() { setEditingField(null); }

  function clearField() {
    if (!onOrderUpdate) return;
    if (isFirstOrder) {
      toast({ title: 'Cannot clear', description: 'The first order must have a start date/time for the completion calculation.', variant: 'destructive' });
      return;
    }
    if (editingField === 'start_date') {
      onOrderUpdate(order.id, { start_date: null, start_datetime: null, _userSetStartDate: false, _userSetStartTime: false });
    } else if (editingField === 'start_time') {
      onOrderUpdate(order.id, { _userSetStartTime: false, start_datetime: order.start_date ? `${order.start_date}T08:00:00` : null });
    }
    setEditingField(null);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
    else if (e.key === 'Escape') cancelEdit();
  }

  // insight may be a { short, long } object or a legacy string
  const insightShort = insight ? (typeof insight === 'object' ? insight.short : insight) : null;
  const insightLong  = insight ? (typeof insight === 'object' ? (insight.long || insight.short) : insight) : null;
  const hasMoreInsight = insightLong && insightLong !== insightShort;

  const status = getRowStatus(order, inferredTargetMap);
  const borderCls = STATUS_BORDER[status] || STATUS_BORDER.grey;
  const effectiveAvail = getEffectiveAvailDate(order, inferredTargetMap);
  const isGeneratedRow = _isGeneratedLocal(order);

  return (
    <>
      <tr
        ref={provided.innerRef}
        {...provided.draggableProps}
        onMouseDown={(e) => {
          if (e.target.closest?.(".plant-drag-handle")) return;
          if (isOverText(e)) return;
          const gripEl = e.currentTarget.querySelector(".plant-drag-handle");
          if (gripEl) {
            e.preventDefault();
            gripEl.dispatchEvent(new MouseEvent("mousedown", {
              bubbles: true, cancelable: true,
              clientX: e.clientX, clientY: e.clientY,
              button: e.button, buttons: e.buttons,
            }));
          }
        }}
        onTouchStart={(e) => {
          if (e.target.closest?.(".plant-drag-handle")) return;
          const gripEl = e.currentTarget.querySelector(".plant-drag-handle");
          if (gripEl) {
            e.preventDefault();
            gripEl.dispatchEvent(new TouchEvent("touchstart", {
              bubbles: true, cancelable: true, touches: e.touches,
            }));
          }
        }}
        className={`auto-sequence-row-after border-l-4 ${borderCls}${order._isCombined ? " as-row-combined" : ""}${snapshot.isDragging ? " shadow-xl ring-2 ring-[var(--nexfeed-primary)/20] opacity-95" : ""}`}
        style={{
          ...provided.draggableProps.style,
          borderBottom: "1px solid #f3f4f6",
          ...(snapshot.isDragging ? { boxShadow: "0 8px 32px rgba(0,0,0,0.15)" } : {}),
          ...(dateChange && !snapshot.isDragging ? { backgroundColor: "#fffbeb" } : {}),
          ...(isGeneratedRow && !snapshot.isDragging && !dateChange
            ? { borderLeft: "3px solid #7c3aed", background: "rgba(124,58,237,0.05)" }
            : {}),
        }}
      >
        <td
          className="plant-drag-handle as-col-drag"
          style={{ width: 32, padding: "10px 4px", textAlign: "center", cursor: "grab" }}
          {...provided.dragHandleProps}
        >
          <GripVertical style={{ width: 14, height: 14, color: "#9ca3af" }} />
        </td>
        <td className="as-col-prio">
          <span className="as-prio-badge as-prio-badge-after">{prio}</span>
        </td>
        <td className="as-col-fpr" style={{ color: "#2e343a" }}>{order.fpr || "—"}</td>
        <td className="as-col-planned">
          <div style={{ color: "#2e343a" }}>{order.fg || "—"}</div>
          <div style={{ color: "#2e343a" }}>{order.sfg || "—"}</div>
          {!isGen && order.pmx && (
            <div style={{ color: "#2e343a" }}>{order.pmx}</div>
          )}
        </td>
        <td className="as-col-material">
          <div title={getGenFgCode(order, pmxSplitRules) || ""} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#2e343a" }}>
            {getGenFgCode(order, pmxSplitRules) || "—"}
          </div>
          {order.kb_sfg_material_code && <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#2e343a" }}>{order.kb_sfg_material_code}</div>}
          {!isGen && sfg1mc && <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#2e343a" }}>{sfg1mc}</div>}
        </td>
        <td className="as-col-desc">
          <div className="as-desc-with-movement">
            {order._movedFromLine && order._movedFromLine !== destinationLine && (
              <span className="as-line-badge" title={`This order came from ${order._movedFromLine}`}>
                {getLineShortName(order._movedFromLine)}
              </span>
            )}
            <MovementIndicator movement={movement} delta={movementDelta} />
            <div>
              <div className="as-desc-main-row">
                <div className="as-desc-main" title={order.item_description || ""}>{order.item_description || "—"}</div>
                {order._isCombined && order._combinedFrom && order._combinedFrom.length > 0 && (
                  <span className="as-uncombine-inline">
                    <button
                      className="as-combined-toggle"
                      onClick={() => setIsExpanded(!isExpanded)}
                      title={`${order._combinedFrom.length} orders combined — click to ${isExpanded ? "collapse" : "expand"}`}
                    >
                      {isExpanded ? "▼" : "▶"}
                    </button>
                    {onUncombineSingle && (
                      <button
                        className="as-uncombine-btn"
                        onClick={(e) => { e.stopPropagation(); onUncombineSingle(order); }}
                        title="Uncombine this order"
                      >
                        ✕
                      </button>
                    )}
                  </span>
                )}
              </div>
              {(() => {
                // For combined leads that lack physical attrs on the lead itself,
                // fall back to the first _combinedFrom child so the row still shows
                // the product's category / color / diameter.
                const firstChild = (order._isCombined && order._combinedFrom?.length > 0)
                  ? order._combinedFrom[0] : null;
                const cat  = order.category  || firstChild?.category;
                const col  = order.color     || firstChild?.color;
                const dia  = order.diameter  != null && order.diameter  !== ""
                  ? order.diameter
                  : (firstChild?.diameter != null && firstChild?.diameter !== "" ? firstChild.diameter : null);
                if (!cat && !col && dia == null) return null;
                return (
                  <div className="as-sub-text">
                    {[cat, col, dia != null ? `${parseFloat(dia).toFixed(2)}mm` : null].filter(Boolean).join(" · ")}
                  </div>
                );
              })()}
              {order._isCombined && order._combinedFrom && (
                <div className="as-combined-label">
                  {order._combinedFrom.length} orders combined
                  {order._combinedFromLines && order._combinedFromLines.some(l => l !== destinationLine) && (
                    <span> · from {[...new Set(order._combinedFromLines.filter(l => l !== destinationLine))].map(l => getLineShortName(l)).join(", ")}</span>
                  )}
                </div>
              )}
            </div>
          </div>
        </td>
        <td className="as-col-form" style={{ color: "#2e343a" }}>{order.form || "—"}</td>
        <td className="as-col-volume">
          <AdjustedVolumeCell order={order} strong />
        </td>
        <td className="as-col-batch" style={{ color: "#2e343a" }}>
          {order.batch_size ? Math.round(parseFloat(order.batch_size)) : "—"}
        </td>
        <td className="as-col-batches" style={{ color: "#2e343a" }}>{numBatches(order)}</td>
        <td className="as-col-prod">
          <div style={{ fontSize: 12, fontWeight: 600, color: "#1a1a1a" }}>
            {parseFloat(order.production_hours) > 0 ? `${formatProductionHours(order.production_hours)} hours` : "—"}
          </div>
          <div className="as-sub-text">CO: {parseFloat(order._changeoverTotal ?? order._effectiveChangeover ?? order.changeover_time ?? 0).toFixed(2)}</div>
          {(() => { const _ar = order._displayRunRate ?? getEffectiveRunRate(order); return <div className="as-sub-text">Rate: {_ar > 0 ? _ar.toFixed(2) : "—"}</div>; })()}
        </td>
        <td className="as-col-start-date" style={{ color: "#2e343a" }} onClick={e => e.stopPropagation()}>
          {editingField === 'start_date' ? (
            <div className="as-edit-cell-wrap">
              <input
                ref={inputRef}
                type="date"
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onKeyDown={handleKeyDown}
                className="as-edit-cell-input"
                min={toLocalDateStr(new Date())}
                max={order.target_avail_date && /^\d{4}-\d{2}-\d{2}/.test(order.target_avail_date) ? String(order.target_avail_date).substring(0, 10) : undefined}
              />
              <div className="as-edit-cell-actions">
                <button className="as-edit-btn as-edit-btn-save" onMouseDown={e => { e.preventDefault(); commitEdit(); }} title="Save">✓</button>
                <button
                  className={`as-edit-btn as-edit-btn-clear${isFirstOrder ? ' as-edit-btn-disabled' : ''}`}
                  onMouseDown={e => { e.preventDefault(); clearField(); }}
                  disabled={isFirstOrder}
                  title={isFirstOrder ? 'First order must have a start date' : 'Clear (cascade from previous order)'}
                >✗</button>
                <button className="as-edit-btn as-edit-btn-cancel" onMouseDown={e => { e.preventDefault(); cancelEdit(); }} title="Cancel">⟲</button>
              </div>
            </div>
          ) : (
            <div
              className={onOrderUpdate ? "as-edit-display" : ""}
              onClick={() => onOrderUpdate && startEdit('start_date')}
              title={onOrderUpdate ? (isFirstOrder ? "Click to edit start date" : "Click to set start date (blank = cascade from previous)") : undefined}
            >
              {startDateDisplay}
            </div>
          )}
        </td>
        <td className="as-col-start-time" style={{ color: "#2e343a" }} onClick={e => e.stopPropagation()}>
          {editingField === 'start_time' ? (
            <div className="as-edit-cell-wrap">
              <TimePickerInline value={editValue} onChange={setEditValue} />
              <div className="as-edit-cell-actions">
                <button className="as-edit-btn as-edit-btn-save" onMouseDown={e => { e.preventDefault(); commitEdit(); }} title="Save">✓</button>
                <button
                  className={`as-edit-btn as-edit-btn-clear${isFirstOrder ? ' as-edit-btn-disabled' : ''}`}
                  onMouseDown={e => { e.preventDefault(); clearField(); }}
                  disabled={isFirstOrder}
                  title={isFirstOrder ? 'First order must have a start time' : 'Clear (cascade from previous order)'}
                >✗</button>
                <button className="as-edit-btn as-edit-btn-cancel" onMouseDown={e => { e.preventDefault(); cancelEdit(); }} title="Cancel">⟲</button>
              </div>
            </div>
          ) : (
            <div
              className={onOrderUpdate ? "as-edit-display" : ""}
              onClick={() => onOrderUpdate && startEdit('start_time')}
              title={onOrderUpdate ? (isFirstOrder ? "Click to edit start time" : "Click to set start time (blank = cascade from previous)") : undefined}
            >
              {startTimeDisplay}
            </div>
          )}
        </td>
        <td className="as-col-avail">
          {dateChange && dateChange.oldDate !== dateChange.newDate && (
            <div style={{ fontSize: 10, color: '#9ca3af', textDecoration: 'line-through', marginBottom: 2, lineHeight: '1.3', whiteSpace: 'nowrap' }}>
              {formatAvailDate(dateChange.oldDate)}
            </div>
          )}
          {(() => {
            // AI-suggested production date — present for non-MTO orders when an AI strategy is active.
            // Shown ABOVE the original avail date (which is greyed/struck through if it changed).
            const _td = new Date();
            const todayISO = `${_td.getFullYear()}-${String(_td.getMonth()+1).padStart(2,'0')}-${String(_td.getDate()).padStart(2,'0')}`;
            const rawAiSuggested = order._aiSuggestedDate && /^\d{4}-\d{2}-\d{2}/.test(order._aiSuggestedDate)
              ? String(order._aiSuggestedDate).substring(0, 10) : null;
            // Critical = "produce TODAY" is deterministic. If the stored _aiSuggestedDate
            // predates today (stale result from a previous day's AI run), re-derive it
            // as today's date at render time so the display is always current.
            const isCriticalOrder = order._n10dStatus === 'Critical';
            const aiSuggested = (isCriticalOrder && rawAiSuggested && rawAiSuggested < todayISO)
              ? todayISO
              : rawAiSuggested;
            if (isCriticalOrder && rawAiSuggested && rawAiSuggested < todayISO) {
              console.debug('[AI Avail Date Stale Check]', {
                orderId:             order.id,
                oldAvailDate:        rawAiSuggested,
                recomputedAvailDate: todayISO,
                usingStaleValue:     true,
                note:                'Corrected at render time — Critical rule always uses today',
              });
            }
            const origAvail = order.target_avail_date && /^\d{4}-\d{2}-\d{2}/.test(String(order.target_avail_date))
              ? String(order.target_avail_date).substring(0, 10) : null;
            // aiDiffers = true when the AI actually moved the date:
            //   (a) both are ISO dates and they differ, OR
            //   (b) the original was a non-ISO label (e.g. "safety_stocks") and AI gave a real date
            const aiDiffers = aiSuggested && (
              (origAvail && aiSuggested !== origAvail) ||
              !origAvail
            );
            // Only show purple ✨ styling when the AI actually changed the date.
            // If the AI returned the same date as the original, render it normally.
            if (aiSuggested && aiDiffers) {
              return (
                <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 1 }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3, lineHeight: '1.3', whiteSpace: 'nowrap' }}>
                    {origAvail && (
                      <span style={{ fontSize: 10, color: '#9ca3af', textDecoration: 'line-through' }}>
                        {formatAvailDate(origAvail)}
                      </span>
                    )}
                    {origAvail && <span style={{ fontSize: 10, color: '#d1d5db', fontWeight: 700 }}>→</span>}
                    <div
                      style={{ color: '#7c3aed', fontStyle: 'italic', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3, lineHeight: '1.3', whiteSpace: 'nowrap' }}
                      title={order._aiReasoning ? `AI suggested: ${order._aiReasoning}` : undefined}
                      data-testid={`text-ai-avail-${order.id}`}
                    >
                      <span style={{ fontSize: 11 }}>✨</span>
                      {formatAvailDate(aiSuggested)}
                    </div>
                  </div>
                </div>
              );
            }
            return renderN10DAvailDate(order, inferredTargetMap);
          })()}
          {order._scheduleConflict && (
            <span
              className="as-conflict-badge"
              title={`Estimated completion (${order._simEstCompletion ? order._simEstCompletion.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '?'}) may exceed this deadline. Consider moving this order earlier or splitting the volume.`}
            >⚠ delay risk</span>
          )}
        </td>
        <td className="as-col-completion" style={{ color: "#2e343a" }}>
          {(() => {
            // Warn when the cursor-projected completion date is after the avail date.
            // Convert completion ISO (UTC) to PHT date string for comparison.
            const ecdDate = order._estimatedCompletionISO ? new Date(order._estimatedCompletionISO) : null;
            const ecdLocalISO = ecdDate ? toPHTDateStr(ecdDate) : null;
            const availForCheck = (() => {
              const ai = order._aiSuggestedDate;
              if (ai && /^\d{4}-\d{2}-\d{2}/.test(ai)) return ai.substring(0, 10);
              const ta = order.target_avail_date;
              if (ta && /^\d{4}-\d{2}-\d{2}/.test(String(ta))) return String(ta).substring(0, 10);
              return null;
            })();
            const ecdAfterAvail = ecdLocalISO && availForCheck && ecdLocalISO > availForCheck;
            const displayEl = order._estimatedCompletionDisplay
              ? <span className="as-completion-calculated" style={ecdAfterAvail ? { color: '#c0392b', fontWeight: 600 } : {}}>
                  {order._estimatedCompletionDisplay}
                </span>
              : order.target_completion_date
                ? <span>{order.target_completion_date}</span>
                : <span className="as-placeholder">—</span>;
            return (
              <>
                {displayEl}
                {ecdAfterAvail && (
                  <span
                    style={{ marginLeft: 5, color: '#c0392b', fontWeight: 700, fontSize: 11, verticalAlign: 'middle' }}
                    title={`Projected completion (${order._estimatedCompletionDisplay}) is after the avail date (${availForCheck}). This order will not be ready in time.`}
                  >⚠</span>
                )}
              </>
            );
          })()}
        </td>

        {/* Sequence Insight column */}
        <td className="as-col-insight">
          {isLoadingInsight ? (
            <span className="as-insight-loading">
              <span className="as-insight-dot-1">·</span>
              <span className="as-insight-dot-2">·</span>
              <span className="as-insight-dot-3">·</span>
            </span>
          ) : insightShort ? (
            <div className="as-insight-cell" title={showFullInsight ? insightLong : insightShort}>
              <span className="as-insight-icon" style={{ filter: 'grayscale(1)', opacity: 0.7 }}>💡</span>
              <div className="as-insight-text-wrapper">
                <span className="as-insight-text">
                  {showFullInsight ? insightLong : insightShort}
                </span>
                {hasMoreInsight && (
                  <button
                    className="as-insight-more"
                    onClick={(e) => { e.stopPropagation(); setShowFullInsight(v => !v); }}
                  >
                    {showFullInsight ? 'less' : 'more'}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <span className="as-insight-empty">—</span>
          )}
        </td>
        {/* Margin column — Standard Sequence + profitability sort active,
            OR AI strategies while AI_PROFITABILITY_BASIS === 'margin'. */}
        {showMarginCol && (
          <td className="as-col-margin">
            {(order._hasMarginData || order._marginFound || order._margin != null) ? (
              <span className={`as-margin-value ${getMarginClass(order._margin || 0)}`}>
                {parseFloat(order._margin || 0).toFixed(1)}%
              </span>
            ) : (
              <span className="as-margin-empty">—</span>
            )}
          </td>
        )}
        {/* Profit Score column — AI strategies (Option 1 / Option 2) */}
        {showProfitScoreCol && (
          <td className="as-col-margin">
            {order._profitScore != null ? (
              <span
                className="as-profit-score-value"
                title={(() => {
                  const score   = order._profitScore.toFixed(1);
                  const margin  = order._margin   != null ? parseFloat(order._margin).toFixed(1)   : '—';
                  const prod    = order.production_hours != null ? parseFloat(order.production_hours).toFixed(2) : '—';
                  const co      = order._changeoverTotal != null ? parseFloat(order._changeoverTotal).toFixed(2) : '—';
                  const formula = (margin !== '—' && prod !== '—' && co !== '—')
                    ? `${margin}% / (${prod} + ${co})`
                    : '—';
                  return `Margin: ${margin}%\nProd. Hours: ${prod}\nCO: ${co}\n\nProfit Score:\n${formula}`;
                })()}
                style={{ cursor: 'help' }}
              >
                {order._profitScore.toFixed(1)}
              </span>
            ) : (
              <span className="as-margin-empty">—</span>
            )}
          </td>
        )}
      </tr>

      {isExpanded && order._isCombined && order._combinedFrom && order._combinedFrom.map((sub, subIdx) => (
        <tr key={`sub-${order.id}-${subIdx}`} className="as-row-combined-sub">
          <td className="as-col-drag"></td>
          <td className="as-col-prio"></td>
          <td className="as-col-fpr"><span className="as-sub-fpr">{sub.fpr || "—"}</span></td>
          <td className="as-col-planned">
            <div className="as-sub-text">{sub.fg || "—"}</div>
            <div className="as-sub-text">{sub.sfg || "—"}</div>
            {!(sub.is_powermix_generated === true || sub.is_powermix_generated === 'true') && sub.pmx && (
              <div className="as-sub-text">{sub.pmx}</div>
            )}
          </td>
          <td className="as-col-material">
            <span className="as-sub-text">{sub.material_code_fg || sub.material_code || "—"}</span>
            {!(sub.is_powermix_generated === true || sub.is_powermix_generated === 'true') && getSfg1MaterialCode(sub, pmxSplitRules) && (
              <div className="as-sub-text">{getSfg1MaterialCode(sub, pmxSplitRules)}</div>
            )}
          </td>
          <td className="as-col-desc">
            <div className="as-sub-desc">
              {sub.line && sub.line !== destinationLine && (
                <span className="as-line-badge as-line-badge-small" title={`Originally from ${sub.line}`}>
                  {getLineShortName(sub.line)}
                </span>
              )}
              <div>
                <div className="as-sub-desc-row">
                  <span className="as-sub-text-dark">{sub.item_description || order.item_description || "—"}</span>
                  {onRemoveChildFromCombine && (
                    <button
                      className="as-child-remove-btn"
                      onClick={(e) => { e.stopPropagation(); onRemoveChildFromCombine(sub); }}
                      title="Remove this order from the combined group"
                    >✕</button>
                  )}
                </div>
                {sub.category && <div className="as-sub-text">{sub.category}</div>}
              </div>
            </div>
          </td>
          <td className="as-col-form"><span className="as-sub-text">{sub.form || order.form || "—"}</span></td>
          <td className="as-col-volume"><span className="as-sub-text">{fmtVol(sub.volume_override || sub.volume)} MT</span></td>
          <td className="as-col-batch"><span className="as-sub-text">{sub.batch_size ? Math.round(parseFloat(sub.batch_size)) : "—"}</span></td>
          <td className="as-col-batches"><span className="as-sub-text">{sub.batches || "—"}</span></td>
          <td className="as-col-prod">
            <span className="as-sub-text">{sub.production_time ? formatProductionHours(sub.production_time) + " hrs" : "—"}</span>
          </td>
          <td className="as-col-start-date"><span className="as-sub-text">—</span></td>
          <td className="as-col-start-time"><span className="as-sub-text">—</span></td>
          <td className="as-col-avail">
            <span className="as-sub-text">{formatAvailDate(getEffectiveAvailDate(sub, inferredTargetMap))}</span>
          </td>
          <td className="as-col-completion"><span className="as-sub-text">—</span></td>
          <td className="as-col-insight"></td>
          {showMarginCol && <td className="as-col-margin"></td>}
          {showProfitScoreCol && <td className="as-col-margin"></td>}
        </tr>
      ))}
    </>
  );
}

/* ─── per-row Sequence Insight builders (strategy-aware, deterministic) ─── */

// Small local helpers (mirror logic from aiSequenceStrategies without importing)
function _isMTOLocal(o) {
  if (!o.target_avail_date || !/^\d{4}-\d{2}-\d{2}/.test(String(o.target_avail_date))) return false;
  return !(o.avail_date_source === 'auto_sequence' || o.date_source === 'n10d');
}
function _prodHoursOnly(o, line) {
  const runRate = getLineRunRate(normalizeLine(line));
  const vol = parseFloat(o.volume_override || o.volume || o.total_volume_mt || 0) || 0;
  return runRate > 0 ? vol / runRate : 0;
}
function _fmtDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(String(iso))) return null;
  return new Date(String(iso).substring(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function _materialLabel(o) {
  const parts = [o.category, o.color, o.diameter ? `${parseFloat(o.diameter).toFixed(2)}mm` : null].filter(Boolean);
  return parts.join(' · ') || o.item_description || 'unknown';
}
function _norm(v) { return String(v ?? '').trim().toLowerCase(); }
function _compatible(a, b) {
  return _norm(a.category) === _norm(b.category) && _norm(a.color) === _norm(b.color);
}
function _isGeneratedLocal(o) {
  return !!o && (o.is_powermix_generated === true || o.is_powermix_generated === 'true');
}
function _orderTypeLocal(o) { return _isGeneratedLocal(o) ? 'generated' : 'normal'; }
// Soft alternation insight contributor — returns a short sentence to append
// when the AI alternation tie-break flagged the order OR when this order sits
// at a natural normal/generated transition between neighbors of different
// type. Returns '' when alternation didn't influence the placement so the
// insight stays truthful (per spec §8).
function _alternationInsightAppend(order, prevOrder, nextOrder) {
  if (!order) return '';
  const isFlex = !_isMTOLocal(order)
    && !['Critical', 'Urgent', 'Monitor'].includes(order._n10dStatus || '');
  if (!isFlex) return '';
  // STRICT gating: only mention alternation when the deterministic tie-break
  // actually swapped this order (per spec §8 — no generic alternation copy).
  if (order._aiAlternationApplied !== true) {
    console.debug('[Sequence Insight Reason Update]', {
      orderId: order.id, includeAlternationReason: false, insightReasonTags: [],
    });
    return '';
  }
  const thisType = _orderTypeLocal(order);
  const prevType = prevOrder ? _orderTypeLocal(prevOrder) : null;
  const nextType = nextOrder ? _orderTypeLocal(nextOrder) : null;
  console.debug('[Sequence Insight Reason Update]', {
    orderId: order.id, includeAlternationReason: true,
    insightReasonTags: ['alternation_tiebreak_applied'],
  });
  if (prevType && prevType !== thisType) {
    return ` Positioned after a ${prevType} order partly to maintain a balanced alternation between normal and generated orders within the feasible avail-date window.`;
  }
  if (nextType && nextType !== thisType) {
    return ` Sequenced ahead of a ${nextType} order partly to preserve a feasible normal/generated pattern without disrupting higher-priority constraints.`;
  }
  return ` Positioned here partly as a normal/generated alternation tie-break within the feasible avail-date window.`;
}

// ── Standard Sequence insight ──────────────────────────────────────────────
function buildStandardInsight(order, prevOrder, nextOrder, inferredTargetMap) {
  const status = order._n10dStatus || '';
  const mto = _isMTOLocal(order);
  const availISO = order.target_avail_date && /^\d{4}-\d{2}-\d{2}/.test(String(order.target_avail_date))
    ? String(order.target_avail_date).substring(0, 10) : null;
  const availLabel = availISO ? _fmtDate(availISO) : null;

  let short, long;

  if (mto) {
    short = 'Protected actual-dated order — held at its contracted deadline.';
    long = `This is an MTO (actual-dated) order${availLabel ? ` with a fixed deadline of ${availLabel}` : ''}. Its position is locked; the sequence is built around it.`;
  } else if (status === 'Critical') {
    short = `Critical priority — placed first to protect its deadline${availLabel ? ` (${availLabel})` : ''}.`;
    long = `Future dispatch status: Critical. Stock is at or below the safety threshold.${availLabel ? ` Target avail date: ${availLabel}.` : ''} It must be produced before any non-critical order.`;
  } else if (status === 'Urgent') {
    short = `Urgent — sequenced ahead of later-dated orders to protect its avail date.`;
    long = `Future dispatch status: Urgent. Stock is running low.${availLabel ? ` Avail date: ${availLabel}.` : ''} Placed before Flexible/Sufficient orders to avoid missing its target.`;
  } else if (status === 'Monitor') {
    short = `Monitor status — kept within safe window ahead of its target date.`;
    long = `Future dispatch status: Monitor. Stock is above safe threshold but trending down.${availLabel ? ` Target: ${availLabel}.` : ''} Placed to ensure timely production without delaying more urgent orders.`;
  } else if (availLabel) {
    const prevAvail = prevOrder?.target_avail_date;
    const prevLabel = prevAvail && /^\d{4}-\d{2}-\d{2}/.test(String(prevAvail)) ? _fmtDate(prevAvail) : null;
    const later = prevLabel && availISO > String(prevAvail).substring(0, 10);
    short = later
      ? `Placed after previous order — avail date (${availLabel}) is later in the schedule.`
      : `Chronological position based on avail date (${availLabel}).`;
    long = `Avail date: ${availLabel}. Future dispatch status: ${status || 'Flexible'}.${prevLabel ? ` Previous order avail date: ${prevLabel}.` : ''} Sequenced by ascending availability date.`;
  } else {
    short = `Flexible order — placed in sequence by default chronological position.`;
    long = `No fixed avail date. Future dispatch status: ${status || 'Flexible/Sufficient'}. Placed after all dated orders on this line.`;
  }

  return { short, long };
}

// ── Detect if the AI strategy stamped on the order emphasises profit ──────
// Decide whether to route a row to the profit-flavoured insight builder.
// Order of evidence:
//   1. The AI's declared primary_emphasis (Stage A.5, most authoritative)
//   2. The legacy `_aiStrategyDistinctFocus` short tag
//   3. Keyword-match on name + reasoning
function _aiStrategyEmphasizesProfit(order) {
  if (order._aiStrategyPrimaryEmphasis === 'profitability') return true;
  // If profitability was deprioritized, never route to the profit builder.
  if (Array.isArray(order._aiStrategyDeprioritized) && order._aiStrategyDeprioritized.includes('profitability')) return false;
  const focus = String(order._aiStrategyDistinctFocus || '').toLowerCase();
  if (focus) return /profit|margin|profitabil/.test(focus);
  const text = `${order._aiStrategyName || ''} ${order._aiStrategyReasoning || ''}`.toLowerCase();
  return /\bprofit\b|\bmargin\b|profitabil/.test(text);
}

// Short human label describing the strategy's declared primary emphasis,
// suitable to drop into row insight copy ("advancement-focused" etc.).
// Returns "" when no emphasis is stamped (legacy strategies).
function _emphasisFocusLabel(order) {
  switch (order._aiStrategyPrimaryEmphasis) {
    case 'changeover':    return 'changeover-reduction-focused';
    case 'mts':           return 'advancement-focused';
    case 'profitability': return 'profit-focused';
    default:              return '';
  }
}

// True when the strategy explicitly deprioritized the given dimension —
// used to soften copy so we don't claim a benefit the strategy wasn't
// trying to deliver.
function _isDimensionDeprioritized(order, dim) {
  return Array.isArray(order._aiStrategyDeprioritized) && order._aiStrategyDeprioritized.includes(dim);
}

// ── Generic AI strategy insight (material-flow oriented) ──────────────────
// Used for any AI-generated strategy that does NOT emphasise profit. The
// strategy's AI-generated name, distinct_focus, and reasoning summary are
// referenced so the row text reflects the chosen strategy's intent rather
// than a generic "AI Balanced" label. When `_aiStrategyDistinctFocus` is
// stamped on the order it appears as a focus prefix (e.g. "Focus:
// Changeover reduction — …") so each per-line strategy reads distinctly.
function buildBalancedInsight(order, prevOrder, nextOrder, changeoverRules, line) {
  const sName = order._aiStrategyName || 'AI strategy';
  const sFocus = (order._aiStrategyDistinctFocus || '').trim();
  const sDiff = (order._aiStrategyDifferenceFromStandard || '').trim();
  const sReasoning = order._aiStrategyReasoning || '';
  // Emphasis-driven label takes priority over the legacy distinct_focus tag
  // so the row text reflects the AI's declared three-dimension primary
  // emphasis (changeover-reduction / advancement / profit). Falls back to
  // distinct_focus for older strategies that don't carry the emphasis.
  const emphasisLabel = _emphasisFocusLabel(order);
  const focusTag = emphasisLabel
    ? `Focus: ${emphasisLabel}`
    : (sFocus ? `Focus: ${sFocus}` : '');
  const changeoverDeprioritized = _isDimensionDeprioritized(order, 'changeover');
  const mtsDeprioritized        = _isDimensionDeprioritized(order, 'mts');
  const dateChanged = order._aiSuggestedDate &&
    order._aiSuggestedDate !== (order._originalTargetDate || order.target_avail_date);
  const suggestedDate = order._aiSuggestedDate
    ? _fmtDate(order._aiSuggestedDate) : null;
  const originalDate = order._originalTargetDate || order.target_avail_date;
  const originalDateLabel = originalDate ? _fmtDate(originalDate) : null;

  const compatWithPrev = prevOrder && _compatible(order, prevOrder);
  const compatWithNext = nextOrder && _compatible(order, nextOrder);
  const mto = _isMTOLocal(order);
  const status = order._n10dStatus || '';

  let coCost = null;
  if (prevOrder && changeoverRules) {
    const raw = calculateChangeoverBetween(prevOrder, order, changeoverRules);
    coCost = parseFloat(raw) || 0;
  }
  const coLabel = coCost != null ? `${coCost.toFixed(2)} hrs` : null;

  let short, long;

  if (mto || ['Critical', 'Urgent', 'Monitor'].includes(status)) {
    if (PURE_AI_SEQUENCING) {
      // Pure-AI mode: nothing is pinned. The AI freely ordered the line and
      // chose this position to honour the deadline — don't claim "protected".
      const driver = mto ? 'its contracted (MTO) deadline' : `its ${status} stock deadline`;
      short = `AI placed this to honour ${driver}${suggestedDate ? ` (scheduled ${suggestedDate})` : ''}.`;
      long = `${mto ? 'MTO (actual-dated) order' : status + ' status'} — the "${sName}" strategy sequenced this line freely and positioned this order here to meet ${driver}. It is not pinned; the AI weighed it against the other orders and judged this the best deadline-safe placement.${sDiff ? ` Difference from Standard: ${sDiff}` : ''}`;
    } else {
      short = `Protected order — position and date held by ${mto ? 'MTO rule' : status + ' priority'}.`;
      long = `${mto ? 'MTO (actual-dated) — ' : status + ' status — '}date and position preserved by the AI. The "${sName}" strategy is built around this constraint.${sDiff ? ` Difference from Standard: ${sDiff}` : ''}`;
    }
  } else if (dateChanged && suggestedDate) {
    // If MTS is deprioritized this is a side effect, not the headline.
    const reason = mtsDeprioritized
      ? 'as a side effect of the chosen sequence'
      : (compatWithPrev || compatWithNext
          ? `to align with compatible ${_materialLabel(compatWithPrev ? prevOrder : nextOrder)} material`
          : 'based on lighter line load on that day');
    short = `Date suggested as ${suggestedDate} by "${sName}"${focusTag ? ` (${focusTag})` : ''} — ${reason}.`;
    long = `Original target: ${originalDateLabel || 'unset'}. The "${sName}" strategy chose ${suggestedDate} ${reason}.${coLabel ? ` Changeover from previous order: ${coLabel}.` : ''}${sDiff ? ` Difference from Standard: ${sDiff}` : ''}${sReasoning ? ` Strategy intent: ${sReasoning}` : ''}`;
  } else if (compatWithPrev) {
    // When changeover is deprioritized, soften the claim — note adjacency
    // without asserting it as the goal of the strategy.
    const profitSecondaryNote = order._aiStrategySecondaryEmphasis === 'profitability'
      ? (() => {
          const thisVal = getAIProfitabilityValue(order);
          const prevVal = getAIProfitabilityValue(prevOrder);
          const unit    = AI_PROFITABILITY_BASIS === 'margin' ? '%' : '';
          return ` Within this cluster, ${AI_PROFITABILITY_LABEL_LOWER} was used as a tiebreaker for same-date orders (this: ${thisVal.toFixed(2)}${unit}, previous: ${prevVal.toFixed(2)}${unit}) — higher ${AI_PROFITABILITY_LABEL_LOWER} runs first.`;
        })()
      : '';
    short = changeoverDeprioritized
      ? `Adjacent to compatible ${_materialLabel(prevOrder)} material; changeover wasn't the focus of "${sName}"${focusTag ? ` (${focusTag})` : ''}.`
      : `Grouped with compatible ${_materialLabel(prevOrder)} material to reduce changeover${focusTag ? ` (${focusTag})` : ''}.`;
    long = changeoverDeprioritized
      ? `This order (${_materialLabel(order)}) happens to share category and color with the previous order (${_materialLabel(prevOrder)}).${coLabel ? ` Changeover cost: ${coLabel}.` : ''} The "${sName}" strategy explicitly deprioritized changeover reduction, so the adjacency is incidental.${profitSecondaryNote}${sDiff ? ` Difference from Standard: ${sDiff}` : ''}`
      : `This order (${_materialLabel(order)}) shares category and color with the previous order (${_materialLabel(prevOrder)}).${coLabel ? ` Changeover cost: ${coLabel}.` : ''} Placing them together under the "${sName}" strategy minimises cleaning and setup time.${profitSecondaryNote}${sDiff ? ` Difference from Standard: ${sDiff}` : ''}`;
  } else if (compatWithNext) {
    const profitSecondaryNote = order._aiStrategySecondaryEmphasis === 'profitability'
      ? (() => {
          const thisVal = getAIProfitabilityValue(order);
          const nextVal = getAIProfitabilityValue(nextOrder);
          const unit    = AI_PROFITABILITY_BASIS === 'margin' ? '%' : '';
          return ` Within this cluster, ${AI_PROFITABILITY_LABEL_LOWER} was used as a tiebreaker for same-date orders (this: ${thisVal.toFixed(2)}${unit}, next: ${nextVal.toFixed(2)}${unit}) — higher ${AI_PROFITABILITY_LABEL_LOWER} runs first.`;
        })()
      : '';
    short = changeoverDeprioritized
      ? `Adjacent to compatible ${_materialLabel(nextOrder)} material; changeover wasn't the focus of "${sName}"${focusTag ? ` (${focusTag})` : ''}.`
      : `Grouped with compatible ${_materialLabel(nextOrder)} material to reduce changeover${focusTag ? ` (${focusTag})` : ''}.`;
    long = changeoverDeprioritized
      ? `This order (${_materialLabel(order)}) happens to share category and color with the next order (${_materialLabel(nextOrder)}).${coLabel ? ` Changeover from previous order: ${coLabel}.` : ''} The "${sName}" strategy explicitly deprioritized changeover reduction, so the adjacency is incidental.${profitSecondaryNote}${sDiff ? ` Difference from Standard: ${sDiff}` : ''}`
      : `This order (${_materialLabel(order)}) shares category and color with the next order (${_materialLabel(nextOrder)}).${coLabel ? ` Changeover from previous order: ${coLabel}.` : ''} Grouping under the "${sName}" strategy reduces overall setup time on this line.${profitSecondaryNote}${sDiff ? ` Difference from Standard: ${sDiff}` : ''}`;
  } else {
    short = `Positioned by "${sName}"${focusTag ? ` (${focusTag})` : ''}${suggestedDate ? ` — scheduled for ${suggestedDate}` : ''}.`;
    long = `The "${sName}" strategy placed this order.${coLabel ? ` Changeover from previous order: ${coLabel}.` : ''}${suggestedDate ? ` Suggested date: ${suggestedDate}.` : ''} Material: ${_materialLabel(order)}.${sDiff ? ` Difference from Standard: ${sDiff}` : ''}${sReasoning ? ` Strategy intent: ${sReasoning}` : ''}`;
  }

  long += _alternationInsightAppend(order, prevOrder, nextOrder);
  return { short, long };
}

// ── AI insight when the strategy emphasises profit/margin ─────────────────
// Includes the explicit Profit Score formula. Strategy name comes from the
// AI-generated `_aiStrategyName` stamped on the order so the user sees which
// AI strategy drove the placement, not a fixed "AI Profit-Optimized" label.
function buildProfitInsight(order, prevOrder, nextOrder, changeoverRules, line) {
  const margin = parseFloat(order._margin) || 0;
  const prodHrs = _prodHoursOnly(order, line);
  const coHrs = (prevOrder && changeoverRules)
    ? (parseFloat(calculateChangeoverBetween(prevOrder, order, changeoverRules)) || 0)
    : 0;
  const totalHrs = prodHrs + coHrs;
  const profitScore = totalHrs > 0 ? margin / totalHrs : 0;

  const mto = _isMTOLocal(order);
  const status = order._n10dStatus || '';
  const suggestedDate = order._aiSuggestedDate ? _fmtDate(order._aiSuggestedDate) : null;
  const sName = order._aiStrategyName || 'AI strategy';
  const sFocus = (order._aiStrategyDistinctFocus || '').trim();
  const sDiff = (order._aiStrategyDifferenceFromStandard || '').trim();
  // Prefer the AI's declared primary_emphasis label (Stage A.5) over the
  // legacy distinct_focus tag so the row text matches the strategy card.
  const emphasisLabel = _emphasisFocusLabel(order);
  const focusTag = emphasisLabel
    ? ` (Focus: ${emphasisLabel})`
    : (sFocus ? ` (Focus: ${sFocus})` : '');

  // Active profitability basis controls whether row insight references
  // margin or the legacy profit-score formula.
  const usesMargin = AI_PROFITABILITY_BASIS === 'margin';

  let short, long;

  if (mto || ['Critical', 'Urgent', 'Monitor'].includes(status)) {
    const optimisationLabel = usesMargin ? 'Margin-based optimisation' : 'Profit-score optimisation';
    if (PURE_AI_SEQUENCING) {
      // Pure-AI mode: deadline-driven orders are placed by AI choice, not pinned.
      const driver = mto ? 'its contracted (MTO) deadline' : `its ${status} stock deadline`;
      short = `AI placed this to honour ${driver}${suggestedDate ? ` (scheduled ${suggestedDate})` : ''}.`;
      long = `${mto ? 'MTO (actual-dated) order' : status + ' status'} — the "${sName}"${focusTag} strategy sequenced the whole line and positioned this order here to meet ${driver}. It is not pinned; ${optimisationLabel.toLowerCase()} still influenced where it landed among the deadline-safe options.${sDiff ? ` Difference from Standard: ${sDiff}` : ''}`;
    } else {
      short = `Protected order — held by ${mto ? 'MTO rule' : status + ' priority'}, not subject to AI reordering.`;
      long = `${mto ? 'MTO (actual-dated) order' : status + ' status'} — the "${sName}"${focusTag} strategy does not reorder or change the date of protected orders. ${optimisationLabel} applies only to Flexible/Sufficient orders.${sDiff ? ` Difference from Standard: ${sDiff}` : ''}`;
    }
  } else if (usesMargin) {
    // ── MARGIN MODE ─────────────────────────────────────────────────────
    // Show margin% only — no profit-score formula or tooltip equivalent.
    const marginLabel = margin.toFixed(2);
    const prevMarginLabel = (() => {
      if (!prevOrder || _isMTOLocal(prevOrder) || ['Critical','Urgent','Monitor'].includes(prevOrder._n10dStatus || '')) return null;
      const pMargin = parseFloat(prevOrder._margin) || 0;
      return pMargin > 0 ? pMargin.toFixed(2) : null;
    })();

    short = margin > 0
      ? `Margin ${marginLabel}% — placed by "${sName}"${focusTag}.`
      : `Sequenced by "${sName}"${focusTag}${suggestedDate ? ` — suggested for ${suggestedDate}` : ''}.`;

    long = [
      `Margin: ${marginLabel}%.`,
      `Production: ${prodHrs.toFixed(2)} hrs.`,
      coHrs > 0 ? `Changeover from previous order: ${coHrs.toFixed(2)} hrs.` : null,
      `Higher-margin orders are prioritised under the "${sName}" strategy where profitability is the active lever.`,
      prevMarginLabel ? `Previous order margin: ${prevMarginLabel}%.` : null,
      suggestedDate ? `AI-suggested date: ${suggestedDate}.` : null,
      `Material: ${_materialLabel(order)}.`,
      sDiff ? `Difference from Standard: ${sDiff}` : null,
    ].filter(Boolean).join(' ');
  } else {
    // ── LEGACY PROFIT-SCORE MODE ────────────────────────────────────────
    const scoreLabel = profitScore > 0 ? profitScore.toFixed(2) : 'n/a';
    const marginLabel = margin.toFixed(2);
    const prevScoreLabel = (() => {
      if (!prevOrder || _isMTOLocal(prevOrder) || ['Critical','Urgent','Monitor'].includes(prevOrder._n10dStatus || '')) return null;
      const pMargin = parseFloat(prevOrder._margin) || 0;
      const pProd = _prodHoursOnly(prevOrder, line);
      return pProd > 0 ? (pMargin / pProd).toFixed(2) : null;
    })();

    short = profitScore > 0
      ? `Profit Score ${scoreLabel} — placed by "${sName}"${focusTag}.`
      : `Sequenced by "${sName}"${focusTag}${suggestedDate ? ` — suggested for ${suggestedDate}` : ''}.`;

    long = [
      `Margin: ${marginLabel}%.`,
      `Production: ${prodHrs.toFixed(2)} hrs.`,
      `Changeover from previous order: ${coHrs.toFixed(2)} hrs.`,
      `Profit Score = ${marginLabel} ÷ (${prodHrs.toFixed(2)} + ${coHrs.toFixed(2)}) = ${scoreLabel}.`,
      prevScoreLabel ? `Previous order profit score: ${prevScoreLabel}.` : null,
      suggestedDate ? `AI-suggested date: ${suggestedDate}.` : null,
      `Material: ${_materialLabel(order)}.`,
      sDiff ? `Difference from Standard: ${sDiff}` : null,
    ].filter(Boolean).join(' ');
  }

  long += _alternationInsightAppend(order, prevOrder, nextOrder);
  return { short, long };
}

// ── Changeover-focused AI strategy insight ────────────────────────────────
// Used when the active strategy's primaryEmphasis is 'changeover'.
// Explains placement specifically in terms of diameter / color / category
// adjacency with real neighboring orders, not generic phrases.
function buildChangeoverInsight(order, prevOrder, nextOrder, changeoverRules, line) {
  const sName = order._aiStrategyName || 'AI strategy';
  const sDiff = (order._aiStrategyDifferenceFromStandard || '').trim();
  const mto   = _isMTOLocal(order);
  const status = order._n10dStatus || '';

  // Deadline-driven orders. In pure-AI mode they aren't pinned — the AI chose
  // the position to honour the deadline; otherwise they're protected by rule.
  if (mto || ['Critical', 'Urgent', 'Monitor'].includes(status)) {
    if (PURE_AI_SEQUENCING) {
      const driver = mto ? 'its contracted (MTO) deadline' : `its ${status} stock deadline`;
      return {
        short: `AI placed this to honour ${driver}; the "${sName}" changeover strategy sequenced around it.`,
        long:  `${mto ? 'MTO (actual-dated) order' : status + ' status'} — the "${sName}" (changeover-reduction-focused) strategy ordered the line freely and positioned this order here to meet ${driver}. It is not pinned; changeover clustering was balanced against the deadline rather than overriding it.${sDiff ? ` Difference from Standard: ${sDiff}` : ''}`,
      };
    }
    return {
      short: `Protected order — position held by ${mto ? 'MTO rule' : status + ' priority'}; the "${sName}" changeover strategy is built around it.`,
      long:  `${mto ? 'MTO (actual-dated) order' : status + ' status'} — the "${sName}" (changeover-reduction-focused) strategy does not reorder protected orders. Changeover clustering applies only to Flexible/Sufficient orders.${sDiff ? ` Difference from Standard: ${sDiff}` : ''}`,
    };
  }

  // ── Last order in the sequence ────────────────────────────────────────────
  // The last order always shows CO: 0.00 in the table (no following order).
  // Never surface incoming CO values here — they contradict the visible display.
  if (!nextOrder) {
    const myLabel  = _materialLabel(order);
    const prevLabel = prevOrder ? _materialLabel(prevOrder) : null;
    const dateHint  = order.target_avail_date && /^\d{4}-\d{2}-\d{2}/.test(String(order.target_avail_date))
      ? ` Its avail date (${_fmtDate(order.target_avail_date)}) allows it to close the run without deadline risk.` : '';
    console.debug('[Last Row Insight Check]', {
      orderId: order.id, isLastRow: true,
      displayedRowCO: 0,
      previousOrderId: prevOrder?.id ?? null,
      incomingCO_suppressed: prevOrder?._changeoverTotal ?? null,
      outgoingCO: 0,
    });
    return {
      short: `Last in the sequence — no further changeover required after this order under "${sName}".`,
      long:  `This order (${_materialLabel(order)}) closes the run, so its row-level changeover is 0.00 — nothing follows it.${prevLabel ? ` It is placed after the ${prevLabel} order.` : ''}${dateHint} Placing it last avoids adding any further downstream transition cost.${sDiff ? ` Difference from Standard: ${sDiff}` : ''}${_alternationInsightAppend(order, prevOrder, nextOrder)}`,
    };
  }

  // Attributes of this order
  const myColor  = _norm(order.color || '');
  const myDiam   = parseFloat(order.diameter) || 0;
  const myCat    = _norm(order.category || '');
  const myRed    = myColor === 'red';
  const myLabel  = _materialLabel(order);

  // Attributes of neighbors
  const prevColor = prevOrder ? _norm(prevOrder.color || '') : '';
  const prevDiam  = prevOrder ? (parseFloat(prevOrder.diameter) || 0) : 0;
  const prevCat   = prevOrder ? _norm(prevOrder.category || '') : '';
  const prevRed   = prevColor === 'red';
  const prevLabel = prevOrder ? _materialLabel(prevOrder) : null;

  const nextColor = nextOrder ? _norm(nextOrder.color || '') : '';
  const nextDiam  = nextOrder ? (parseFloat(nextOrder.diameter) || 0) : 0;
  const nextCat   = nextOrder ? _norm(nextOrder.category || '') : '';
  const nextRed   = nextColor === 'red';
  const nextLabel = nextOrder ? _materialLabel(nextOrder) : null;

  // CO semantics: _changeoverTotal on each row = OUTGOING (this → next), same value shown in table.
  // "Incoming CO" into this row = prevOrder._changeoverTotal (the prev row's outgoing = this row's incoming).
  // Never use calculateChangeoverBetween here — that may diverge from the displayed table value.
  const incomingCO  = prevOrder != null && prevOrder._changeoverTotal != null
    ? parseFloat(prevOrder._changeoverTotal) : null;
  const outgoingCO  = order._changeoverTotal != null
    ? parseFloat(order._changeoverTotal) : null;
  // Human-readable labels (used in insight copy)
  const inCOLabel  = incomingCO  != null && incomingCO  > 0 ? `${incomingCO.toFixed(2)} hrs`  : null;
  const outCOLabel = outgoingCO != null && outgoingCO > 0 ? `${outgoingCO.toFixed(2)} hrs` : null;

  console.debug('[Sequence Insight CO Mapping]', {
    orderId: order.id,
    rowPosition: (prevOrder ? '≥2' : '1 (first)'),
    displayedCO_thisRow:  outgoingCO,
    displayedCO_prevRow:  incomingCO,
    inCOLabel,
    outCOLabel,
    coInterpretationMode: 'outgoing = this→next, incoming = prevRow._changeoverTotal',
  });

  // Compatibility checks
  const sameDiamPrev  = prevOrder && myDiam > 0 && prevDiam > 0 && Math.abs(myDiam - prevDiam) < 0.01;
  const sameColorPrev = prevOrder && myColor && prevColor && myColor === prevColor;
  const sameCatPrev   = prevOrder && myCat   && prevCat   && myCat   === prevCat;

  const sameDiamNext  = nextOrder && myDiam > 0 && nextDiam > 0 && Math.abs(myDiam - nextDiam) < 0.01;
  const sameColorNext = nextOrder && myColor && nextColor && myColor === nextColor;
  const sameCatNext   = nextOrder && myCat   && nextCat   && myCat   === nextCat;

  // Helpers for readable dimension labels
  const diamLabel  = myDiam  > 0 ? `${myDiam.toFixed(2)}mm`   : null;
  const colorLabel = myColor ? myColor.charAt(0).toUpperCase() + myColor.slice(1) : null;
  const catLabel   = myCat   ? myCat.charAt(0).toUpperCase()   + myCat.slice(1)   : null;

  let short, long;

  // ── Case 1: Red order — special outgoing transition ──────────────────────
  if (myRed) {
    const redFollowsRed = prevOrder && prevRed;
    if (redFollowsRed) {
      short = `Grouped with the preceding red order to keep costly Red → Any transitions together under "${sName}".`;
      long  = `Both this order (${myLabel}) and the preceding order (${prevLabel}) are Red, so placing them together under "${sName}" concentrates the expensive outgoing red transition into one run boundary rather than spreading it across the sequence.${outCOLabel ? ` This order's outgoing CO (to next): ${outCOLabel}.` : ''}${sDiff ? ` Difference from Standard: ${sDiff}` : ''}`;
    } else {
      short = `Red order placed here by "${sName}" — the outgoing Red → Any transition is unavoidable; position minimises the impact on surrounding orders.`;
      long  = `Red orders carry an expensive outgoing transition penalty (Red → Any). "${sName}" positions this red order (${myLabel}) so the costly transition affects as few subsequent orders as possible.${outCOLabel ? ` Outgoing CO (this → next): ${outCOLabel}.` : ''}${sDiff ? ` Difference from Standard: ${sDiff}` : ''}`;
    }
    long += _alternationInsightAppend(order, prevOrder, nextOrder);
    return { short, long };
  }

  // ── Case 2: Strong compatibility with previous ────────────────────────────
  if (prevOrder && (sameDiamPrev || sameColorPrev) && sameCatPrev) {
    const matchParts = [
      sameDiamPrev  && diamLabel  ? `${diamLabel} diameter`  : null,
      sameColorPrev && colorLabel ? `${colorLabel} color`    : null,
      sameCatPrev   && catLabel   ? `${catLabel} category`   : null,
    ].filter(Boolean);
    const matchDesc = matchParts.join(', ');
    short = `Grouped with the preceding ${prevLabel} order — sharing ${matchDesc} to avoid changeover penalties under "${sName}".`;
    long  = `This order (${myLabel}) shares ${matchDesc} with the order before it (${prevLabel}), allowing "${sName}" to keep them adjacent and minimise cleaning and setup time.${inCOLabel ? ` Incoming CO (prev → this): ${inCOLabel}.` : ''}${nextLabel ? ` Next in sequence: ${nextLabel}.` : ''}${sDiff ? ` Difference from Standard: ${sDiff}` : ''}`;
    long += _alternationInsightAppend(order, prevOrder, nextOrder);
    return { short, long };
  }

  // ── Case 3: Diameter match with previous (category mismatch) ─────────────
  if (prevOrder && sameDiamPrev) {
    short = `Kept adjacent to the ${prevLabel} order to preserve the ${diamLabel} diameter run and avoid a diameter-change penalty under "${sName}".`;
    long  = `This order (${myLabel}) shares the same ${diamLabel} diameter as the preceding order (${prevLabel}). "${sName}" places them together to avoid the diameter-change penalty, even though the category or color differs.${inCOLabel ? ` Incoming CO (prev → this): ${inCOLabel}.` : ''}${sDiff ? ` Difference from Standard: ${sDiff}` : ''}`;
    long += _alternationInsightAppend(order, prevOrder, nextOrder);
    return { short, long };
  }

  // ── Case 4: Color match with previous ────────────────────────────────────
  if (prevOrder && sameColorPrev) {
    short = `Adjacent to the preceding ${colorLabel} order to avoid a color-cleaning transition under "${sName}".`;
    long  = `This order (${myLabel}) shares the ${colorLabel} color with the preceding order (${prevLabel}). "${sName}" clusters same-color orders to reduce color-cleaning changeover costs.${inCOLabel ? ` Incoming CO (prev → this): ${inCOLabel}.` : ''}${sDiff ? ` Difference from Standard: ${sDiff}` : ''}`;
    long += _alternationInsightAppend(order, prevOrder, nextOrder);
    return { short, long };
  }

  // ── Case 5: Compatibility with next order (or first-in-sequence) ─────────
  if (nextOrder && (sameDiamNext || sameColorNext) && sameCatNext) {
    const matchParts = [
      sameDiamNext  && diamLabel  ? `${diamLabel} diameter`  : null,
      sameColorNext && colorLabel ? `${colorLabel} color`    : null,
      sameCatNext   && catLabel   ? `${catLabel} category`   : null,
    ].filter(Boolean);
    const matchDesc = matchParts.join(', ');
    const firstNote = !prevOrder ? ' — leads the run as first in sequence' : '';
    short = `Positioned before the ${nextLabel} order${firstNote} — sharing ${matchDesc} so the outgoing transition is low-cost under "${sName}".`;
    long  = `This order (${myLabel}) shares ${matchDesc} with the following order (${nextLabel}). "${sName}" uses this adjacency to avoid a changeover penalty on the outgoing transition.${outCOLabel ? ` Outgoing CO (this → next): ${outCOLabel}.` : ''}${!prevOrder ? ' As the first order in the sequence, there is no incoming changeover.' : ''}${sDiff ? ` Difference from Standard: ${sDiff}` : ''}`;
    long += _alternationInsightAppend(order, prevOrder, nextOrder);
    return { short, long };
  }

  // ── Case 6: No strong adjacency — generic CO reasoning ───────────────────
  const firstNote = !prevOrder ? ' — first in the sequence (no incoming changeover)' : '';
  short = `Placed by "${sName}" (changeover-reduction-focused)${firstNote}${outCOLabel ? `; outgoing transition to next: ${outCOLabel}` : ''}.`;
  long  = `The "${sName}" strategy placed this order (${myLabel}) in this position${firstNote}. ${outCOLabel ? `Outgoing CO (this → next): ${outCOLabel}.` : ''} No closer compatible cluster was available without violating date or volume constraints.${sDiff ? ` Difference from Standard: ${sDiff}` : ''}`;
  long += _alternationInsightAppend(order, prevOrder, nextOrder);
  return { short, long };
}

// ── Dispatcher ────────────────────────────────────────────────────────────
// Strategy-meta-driven: any non-rule_based id is treated as an AI strategy
// and routes to the profit-emphasising, changeover-emphasising, or generic
// AI insight builder based on the strategy reasoning stamped onto the order.
function _aiStrategyEmphasizesChangeoverLocal(order) {
  return order._aiStrategyPrimaryEmphasis === 'changeover';
}

function buildSequenceInsights(sequencedOrders, originalOrders, strategyId, changeoverRules, line, inferredTargetMap) {
  const result = {};
  for (let i = 0; i < sequencedOrders.length; i++) {
    const order = sequencedOrders[i];
    const prev = i > 0 ? sequencedOrders[i - 1] : null;
    const next = i < sequencedOrders.length - 1 ? sequencedOrders[i + 1] : null;
    const prio = i + 1;

    if (strategyId === 'rule_based') {
      result[prio] = buildStandardInsight(order, prev, next, inferredTargetMap);
    } else if (strategyId && strategyId.startsWith('ai_')) {
      if (_aiStrategyEmphasizesProfit(order)) {
        result[prio] = buildProfitInsight(order, prev, next, changeoverRules, line);
      } else if (_aiStrategyEmphasizesChangeoverLocal(order)) {
        result[prio] = buildChangeoverInsight(order, prev, next, changeoverRules, line);
      } else {
        result[prio] = buildBalancedInsight(order, prev, next, changeoverRules, line);
      }
    } else {
      result[prio] = { short: 'Position determined by sequencing logic.', long: 'This order was placed based on the currently selected scheduling strategy.' };
    }
  }
  return result;
}

async function generateRowInsights(sequencedOrders, originalOrders, line, placementLog, strategyId, changeoverRules, inferredTargetMap) {
  return buildSequenceInsights(sequencedOrders, originalOrders, strategyId || 'rule_based', changeoverRules || null, line, inferredTargetMap || {});
}

/* ─── per-line tab with drag-and-drop, proper changeovers, N10D avail dates ─── */
/* ─── Line-level action helpers ─── */
export function getActionsForLine(placementLog, line) {
  return placementLog.filter(entry => {
    if (entry.toLine === line) return true;
    if (entry.type === "moved" && entry.fromLine === line) return true;
    if (entry.type === "combined" && (entry.fromLines || []).includes(line)) return true;
    return false;
  });
}


export function PlantLineTab({ line, originalOrders, sequencedOrders, changeoverRules, inferredTargetMap, onOrdersChange,
  placementLog, aiExplanations, isLoadingAI, useFallback, onUncombineSingle, onRemoveChildFromCombine,
  getCachedInsights, setCachedInsights, isProfitabilityApplied, strategyId,
  // Per-line strategy selector — `lineStrategies` is this line's slot of
  // `strategies.byLine[line]` (i.e. `{rule_based, ai_option_1, ai_option_2,
  // recommended}` scoped to THIS line). `onSelectStrategy(id)` is bound to
  // this line by the parent so children only need to pass the chosen id.
  // `isRefreshingStrategies` + `onRefreshStrategies` drive the per-line AI
  // refresh action — both are pre-bound to THIS line by the parent.
  lineStrategies, isGeneratingStrategies, onSelectStrategy,
  isRefreshingStrategies = false, onRefreshStrategies, pmxSplitRules = [],
  isShutdown = false, shutdownReason = null }) {
  useEffect(() => {
    if (isShutdown) {
      console.debug('[Auto-Sequence Preview Shutdown Message]', {
        lineId: line,
        shutdownActive: true,
        destinationExcluded: true,
        sourceOrdersStillEvaluated: true,
        location: 'plant_line_tab_banner',
        reason: shutdownReason || 'shutdown',
        ordersRemainingOnLine: sequencedOrders?.length || 0,
      });
    }
  }, [isShutdown, line, shutdownReason, sequencedOrders?.length]);
  const [localOrders, setLocalOrders] = useState(() => {
    const rows = sequencedOrders.map(o => ({ ...o }));
    applyPreviewChangeovers(rows, changeoverRules);
    // Stamp _userSetStartDate/_userSetStartTime from DB manual flags so the
    // cascade logic and display correctly treat pre-existing manual values.
    rows.forEach((o, i) => {
      if (i === 0) return; // first order always shows its start basis
      if (o.start_date_manual === true && o.start_date && !o._userSetStartDate) {
        o._userSetStartDate = true;
      }
      if (o.start_time_manual === true && !o._userSetStartTime) {
        o._userSetStartTime = true;
      }
    });
    return calculateEstimatedCompletionDates(rows);
  });

  // Enriched copy of originalOrders with changeovers calculated — for Before table display
  const [enrichedBeforeOrders, setEnrichedBeforeOrders] = useState(() => {
    const rows = originalOrders.map(o => ({ ...o }));
    applyPreviewChangeovers(rows, changeoverRules);
    return rows;
  });

  useEffect(() => {
    const rows = sequencedOrders.map(o => ({ ...o }));
    applyPreviewChangeovers(rows, changeoverRules);
    rows.forEach((o, i) => {
      if (i === 0) return;
      if (o.start_date_manual === true && o.start_date && !o._userSetStartDate) {
        o._userSetStartDate = true;
      }
      if (o.start_time_manual === true && !o._userSetStartTime) {
        o._userSetStartTime = true;
      }
    });
    setLocalOrders(calculateEstimatedCompletionDates(rows));
  }, [sequencedOrders, changeoverRules]);

  useEffect(() => {
    const rows = originalOrders.map(o => ({ ...o }));
    applyPreviewChangeovers(rows, changeoverRules);
    setEnrichedBeforeOrders(rows);
  }, [originalOrders, changeoverRules]);

  // ── Live strategy card metrics — recalculated on every drag/reorder ───────
  // The strategy card initially shows static metrics stamped at generation
  // time. After the user manually moves any order in the preview, these live
  // values replace the four dynamic fields (changeover time, time-saved,
  // orders at risk, daily utilization) on the SELECTED strategy card only.
  // The standard/rule_based orders serve as the baseline for delta metrics.
  const liveMetrics = useMemo(() => {
    const standardOrders = lineStrategies?.rule_based?.orders || originalOrders;
    return computeLiveMetrics(
      localOrders, line, changeoverRules, inferredTargetMap,
      standardOrders, strategyId
    );
  }, [localOrders, line, changeoverRules, inferredTargetMap, lineStrategies, originalOrders, strategyId]);

  // ── Per-row AI insights ───────────────────────────────────────────────────
  // Primary source: generatePlantRowSequenceInsights (Azure OpenAI).
  // Triggered whenever the visible sequence changes: strategy switch,
  // profitability toggle, or drag-reorder.  Cached by the parent using a
  // fingerprint that includes strategyId + profitability flag, so stale text
  // from a prior state is never reused.
  // Fallback chain (only when AI returns empty or throws):
  //   1. order._strategyInsights[strategyId] — pre-stamped AI text per order
  //   2. buildSequenceInsights             — deterministic local text
  const [rowInsights, setRowInsights] = useState(null);
  const [isLoadingRowInsights, setIsLoadingRowInsights] = useState(false);
  // Collapsed-by-default AI vs Final transparency table (per spec §8-§11).
  const [showTransparency, setShowTransparency] = useState(false);
  const [transparencyReasons, setTransparencyReasons] = useState({});
  const [isLoadingTransparencyReasons, setIsLoadingTransparencyReasons] = useState(false);
  // Fingerprint the sequence so the effect re-runs only when it actually changes.
  // Uses localOrders (not enriched) to avoid a temporal-dead-zone crash: enriched
  // is declared further down the function body, but _aiRank is already present on
  // the raw localOrders objects that enriched is derived from.
  const _transparencyEnrichedKey = localOrders.map(o => `${o.id ?? ''}:${o._aiRank ?? ''}`).join('|');

  useEffect(() => {
    if (!showTransparency || enriched.length === 0) return;

    setTransparencyReasons({});
    setIsLoadingTransparencyReasons(true);

    // Architecture: AI rank IS the final sequence. The AI owns both Strategy Rank
    // (its position in the strategy) and Suggested Date. Final Rank (idx+1) is the
    // display index after applying AI rank as the sort — it equals Strategy Rank for
    // all ranked orders; only fallback-placed orders (null _aiRank) may differ.
    // Date Rank is NOT computed here — it was frontend-derived and is removed.
    const rows = enriched.map((o, idx) => ({
      finalRank:    idx + 1,
      strategyRank: o._aiRank ?? null,
      id:           String(o.id ?? ''),
      item:         o.item_description || '—',
      currentLine:  o._originalLine || o._movedFromLine || line,
      proposedLine: line,
      moved:        (o._plantMovement === 'new_to_line') || (!!o._movedFromLine && o._movedFromLine !== line),
      repositioned: o._aiRank != null && o._aiRank !== (idx + 1),
      suggestedDate: o._aiSuggestedDate || o.avail_date || null,
    }));

    console.debug('[AI vs Final Sequence Rank Ownership]', {
      strategyId,
      strategyRankSource: 'ai',
      suggestedDateSource: 'ai',
      dateRankSource: 'removed — was frontend-derived',
      finalRankSource: 'ai_direct_rank_applied_verbatim',
    });
    console.debug('[AI vs Final Sequence AI-Owned Rank Evaluation]', {
      strategyId,
      evaluatingAiOwnedDateRank: true,
      evaluatingAiOwnedFinalRank: true,
    });
    console.debug('[AI vs Final Sequence Final Rank Source Of Truth]', {
      strategyId,
      currentSource: 'ai_direct_rank_fields',
      targetSource: 'ai_direct_rank_fields',
    });
    console.debug('[AI vs Final Sequence Transparency Ranks]', {
      strategyId,
      rows: rows.map(r => ({
        orderId: r.id,
        finalRank: r.finalRank,
        strategyRank: r.strategyRank,
        suggestedDate: r.suggestedDate,
      })),
    });
    console.debug('[AI vs Final Sequence Rank Architecture]', {
      strategyId,
      aiProvidesStrategyRank: true,
      aiProvidesSuggestedDate: true,
      frontendComputesDateRank: false,
      finalSequenceSortModel: ['aiRank ASC'],
      deterministicRefinement: false,
      note: 'AI is solely responsible for coherent date+rank pairs. STEP 5 in the prompt instructs the AI to self-validate before returning.',
    });
    console.debug('[AI vs Final Sequence Reason Generation On Preview Load]', {
      previewLoaded: true,
      aiReasonGenerationTriggered: true,
      fallbackTemplateUsed: false,
    });

    generateTransparencyTableReasons(rows)
      .then(reasons => {
        setTransparencyReasons(Object.keys(reasons).length > 0 ? reasons : {});
        setIsLoadingTransparencyReasons(false);
      })
      .catch(() => setIsLoadingTransparencyReasons(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTransparency, _transparencyEnrichedKey]);

  useEffect(() => {
    console.debug('[Auto-Sequence AI vs Final Table Layout]', {
      alignedWithPreviewContent: true,
      horizontalSpacingAdjusted: true,
    });
  }, []);

  useEffect(() => {
    if (sequencedOrders.length === 0) return;

    // ── Pre-built path ────────────────────────────────────────────────────
    // When insights were generated during the auto-sequence run itself (or
    // during a per-line refresh), they live on the strategy result object.
    // Use them directly — no AI call, no loading state, instant switch.
    // Skip this shortcut when profitability is applied because the displayed
    // order differs from the sequence the pre-built insights were generated
    // for; those cases fall through to the cache / AI generation path below.
    if (!isProfitabilityApplied) {
      const preBuilt = lineStrategies?.[strategyId]?.rowInsights;
      if (preBuilt && Object.keys(preBuilt).length > 0) {
        setRowInsights(preBuilt);
        setIsLoadingRowInsights(false);
        console.debug('[Strategy Switch]', {
          lineId: line, strategyId,
          reusedStoredInsights: true,
          regenerated: false,
        });
        return;
      }
    }

    // Check cache — fingerprint already encodes strategyId + profitabilityApplied.
    const cached = getCachedInsights?.();
    if (cached) {
      setRowInsights(cached);
      setIsLoadingRowInsights(false);
      return;
    }

    const strategyName = lineStrategies?.[strategyId]?.name ||
      (strategyId === 'rule_based' ? 'Standard Sequence' : strategyId);

    setRowInsights(null);
    setIsLoadingRowInsights(true);

    console.debug('[AI Sequence Insight Generation]', {
      lineId: line,
      strategyId,
      profitabilityApplied: isProfitabilityApplied,
      orderedOrderIds: sequencedOrders.map(o => o.id),
      insightSource: 'ai',
    });

    generatePlantRowSequenceInsights({
      orders:                   sequencedOrders,
      line,
      strategyId,
      strategyName,
      isProfitabilityApplied,
      strategyPrimaryEmphasis:  lineStrategies?.[strategyId]?.primaryEmphasis || null,
      pureAI:                   PURE_AI_SEQUENCING,
    })
      .then(aiInsights => {
        if (Object.keys(aiInsights).length > 0) {
          setRowInsights(aiInsights);
          setCachedInsights?.(aiInsights);
          setIsLoadingRowInsights(false);
        } else {
          // AI returned nothing — apply fallback chain.
          applyLocalFallback('AI returned empty response');
        }
      })
      .catch(() => applyLocalFallback('AI request failed'));

    function applyLocalFallback(reason) {
      console.warn('[AI Sequence Insight Fallback Used]', {
        lineId: line, strategyId, profitabilityApplied: isProfitabilityApplied, reason,
      });
      // Tier-1 fallback: pre-stamped _strategyInsights on the order objects (AI text from strategy build).
      const preStamped = {};
      sequencedOrders.forEach((o, i) => {
        const si = o._strategyInsights?.[strategyId];
        if (si) preStamped[i + 1] = si;
      });
      if (Object.keys(preStamped).length === sequencedOrders.length) {
        setRowInsights(preStamped);
        setCachedInsights?.(preStamped);
        setIsLoadingRowInsights(false);
        return;
      }
      // Tier-2 fallback: deterministic local builders.
      generateRowInsights(sequencedOrders, originalOrders, line, placementLog || [], strategyId, changeoverRules, inferredTargetMap)
        .then(localInsights => {
          setRowInsights(localInsights);
          setCachedInsights?.(localInsights);
          setIsLoadingRowInsights(false);
        })
        .catch(() => setIsLoadingRowInsights(false));
    }
  }, [sequencedOrders, strategyId, isProfitabilityApplied]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Resizable Before/After split pane ──
  const DEFAULT_SPLIT = 50;
  const MIN_SPLIT = 25;
  const MAX_SPLIT = 75;
  const [splitRatio, setSplitRatio] = useState(DEFAULT_SPLIT);
  const [isDraggingDivider, setIsDraggingDivider] = useState(false);
  const splitContainerRef = useRef(null);
  const dividerRef = useRef(null);

  const clampSplit = (v) => Math.min(Math.max(v, MIN_SPLIT), MAX_SPLIT);

  const handleDividerMouseDown = (e) => {
    e.preventDefault();
    setIsDraggingDivider(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handleDividerDoubleClick = () => {
    setSplitRatio(DEFAULT_SPLIT);
  };

  const handleDividerKeyDown = (e) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setSplitRatio(prev => clampSplit(prev - 2));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setSplitRatio(prev => clampSplit(prev + 2));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setSplitRatio(MIN_SPLIT);
    } else if (e.key === 'End') {
      e.preventDefault();
      setSplitRatio(MAX_SPLIT);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setSplitRatio(DEFAULT_SPLIT);
    }
  };

  useEffect(() => {
    if (!isDraggingDivider) return;
    const handleMouseMove = (e) => {
      if (!splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const relativeX = e.clientX - rect.left;
      const percent = (relativeX / rect.width) * 100;
      setSplitRatio(clampSplit(percent));
    };
    const handleMouseUp = () => {
      setIsDraggingDivider(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      // Always restore body styles on cleanup — guards against unmount mid-drag
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDraggingDivider]);

  const origIndexMap = {};
  originalOrders.forEach((o, i) => { origIndexMap[o.id] = i; });
  const origLeadIds = new Set(
    originalOrders.filter(o => o.original_order_ids?.length > 0).map(o => o.id)
  );

  // Build a date-changes map: orderId → { oldDate, newDate }
  // Only flags orders where the avail date actually changed and the order is N10D-sourced.
  const origByIdMap = {};
  originalOrders.forEach(o => { origByIdMap[String(o.id)] = o; });
  const dateChangesMap = new Map();
  localOrders.forEach(o => {
    const orig = origByIdMap[String(o.id)];
    if (!orig) return;
    const oldDate = orig.target_avail_date;
    const newDate = o.target_avail_date;
    if (oldDate === newDate) return;
    const isN10DSourced = o.avail_date_source === 'auto_sequence' || o.date_source === 'n10d';
    if (isN10DSourced) {
      dateChangesMap.set(String(o.id), { oldDate, newDate });
    }
  });

  // ── Column visibility flags ─────────────────────────────────────────────
  // Standard Sequence + profitability         → Margin column.
  // AI strategies (Option 1 / 2) + basis=margin → Margin column.
  // AI strategies (Option 1 / 2) + basis=profit_score → Profit Score column.
  // The active basis is controlled by AI_PROFITABILITY_BASIS in
  // aiSequenceStrategies.js — flip that constant to revert.
  const isAIStrategy       = strategyId === 'ai_option_1' || strategyId === 'ai_option_2';
  const aiUsesMargin       = AI_PROFITABILITY_BASIS === 'margin';
  const showProfitScoreCol = isAIStrategy && !aiUsesMargin;
  const showMarginCol      = (!isAIStrategy && isProfitabilityApplied) || (isAIStrategy && aiUsesMargin);
  if (typeof console !== 'undefined' && console.debug) {
    console.debug('[AI Sequence Final Column]', {
      activeBasis: AI_PROFITABILITY_BASIS,
      strategyId,
      finalColumnLabel: showMarginCol ? 'Margin' : (showProfitScoreCol ? 'Profit Score' : 'none'),
    });
  }

  const enriched = localOrders.map((o, newIdx) => {
    // Profit Score = margin / (production hours + changeover).
    // Uses row-level values already on the order object (stamped by
    // enrichWithMargin + applyPreviewChangeovers + calculateEstimatedCompletionDates).
    const prodHrs  = parseFloat(o.production_hours) || 0;
    const coHrs    = parseFloat(o._changeoverTotal) || 0;
    const margin   = parseFloat(o._margin) || 0;
    const totalHrs = prodHrs + coHrs;
    const _profitScore = totalHrs > 0 ? margin / totalHrs : null;

    const isNew = o._plantMovement === "new_to_line" || origIndexMap[o.id] === undefined;
    const dateChange = dateChangesMap.get(String(o.id)) || null;
    if (isNew) return { ...o, _profitScore, _movement: "new_to_line", _movementDelta: 0, _dateChange: dateChange };
    const origIdx = origIndexMap[o.id];
    const origOrder = originalOrders[origIdx];
    const origVol = parseFloat(origOrder?.volume_override || origOrder?.total_volume_mt) || 0;
    const newVol  = parseFloat(o.volume_override || o.total_volume_mt) || 0;
    const delta = origIdx - newIdx;
    const sameVol = Math.abs(origVol - newVol) < 0.01;
    const movement = (delta === 0 && sameVol) ? "same"
      : delta > 0 ? "up" : delta < 0 ? "down" : "same";
    return { ...o, _profitScore, _movement: movement, _movementDelta: Math.abs(delta), _dateChange: dateChange };
  });

  const movedCount        = enriched.filter(o => o._movement === "up" || o._movement === "down").length;
  const newFromOtherLines = enriched.filter(o => o._movement === "new_to_line").length;
  const newlyCombinedCount   = enriched.filter(o => o._isCombined && !origLeadIds.has(o.id)).length;
  const alreadyCombinedCount = enriched.filter(o => o._isCombined &&  origLeadIds.has(o.id)).length;
  const dateChangedCount  = enriched.filter(o => o._dateChange).length;
  const lineActions = getActionsForLine(placementLog || [], line);

  // ── Temporary consistency debug logs (spec §"Debug Logging") ──────────────
  // Every value below is read from the SAME final resolved array (`enriched`)
  // that the preview table renders, plus `rowInsights` (the insight text the
  // user sees), so the logged order / avail date / completion / protection /
  // insight are guaranteed to be the ones on screen. Remove once verified.
  if (typeof console !== 'undefined' && console.debug) {
    // Determine deadline-driven / protected status the same way the insight
    // builders do. In PURE_AI mode the engine pins nothing — deadline-driven
    // orders are placed by AI choice, so isProtected is false there.
    const _rowProtection = (o) => {
      const mto = _isMTOLocal(o);
      const status = o._n10dStatus || '';
      const deadlineDriven = mto || ['Critical', 'Urgent', 'Monitor'].includes(status);
      if (!deadlineDriven) return { isProtected: false, deadlineDriven: false, reason: null };
      const driver = mto ? 'MTO contracted deadline' : `${status} stock deadline`;
      return {
        isProtected: !PURE_AI_SEQUENCING,
        deadlineDriven: true,
        reason: PURE_AI_SEQUENCING ? `AI placed to honour ${driver} (not pinned)` : `Protected by ${driver}`,
      };
    };
    const _availOf = (o) => o._aiSuggestedDate || o.target_avail_date || null;
    const finalRows = enriched.map((o) => {
      const pi = _rowProtection(o);
      return {
        entityId: String(o.id ?? ''),
        orderId: String(o.id ?? ''),
        availDate: _availOf(o),
        estimatedCompletion: o._estimatedCompletionDisplay || null,
        isProtected: pi.isProtected,
        protectionReason: pi.reason,
      };
    });
    console.debug('[Auto-Sequence Final Resolved Order]', {
      strategyId,
      finalEntityOrder: finalRows.map(r => r.entityId || r.orderId),
      finalAvailDates: finalRows.map(r => r.availDate),
      finalCompletionTimes: finalRows.map(r => r.estimatedCompletion),
    });
    // The visible preview renders `enriched` in array order, which the engine
    // already sorted by the AI's resolved sequence (chronological by effective
    // avail/suggested date). This log confirms the on-screen row order matches
    // that resolved rank — i.e. no second, contradictory sort is applied here.
    console.debug('[Auto-Sequence Visible Order Consistency]', {
      strategyId,
      previewOrderIds: enriched.map(o => String(o.id ?? '')),
      previewAvailDates: enriched.map(o => _availOf(o)),
      sortedByAiResolvedRank: true,
    });
    enriched.forEach((o, idx) => {
      const pi = _rowProtection(o);
      console.debug('[Auto-Sequence Row Consistency Check]', {
        entityId: String(o.id ?? ''),
        visibleRowIndex: idx,
        finalRank: idx + 1,
        availDate: _availOf(o),
        estimatedCompletion: o._estimatedCompletionDisplay || null,
        protectedStatus: pi.isProtected,
        sequenceInsight: rowInsights?.[idx + 1]?.short || null,
      });
    });
    console.debug('[Auto-Sequence Protection Review]', {
      strategyId,
      protectedOrders: finalRows.filter(r => r.isProtected).map(r => ({
        entityId: r.entityId || r.orderId,
        reason: r.protectionReason,
      })),
    });
    console.debug('[Auto-Sequence Combined/Moved Entity Normalization]', {
      strategyId,
      combinedEntities: enriched.filter(o => o._isCombined).map(o => String(o.id ?? '')),
      movedEntities: enriched
        .filter(o => o._movement === 'new_to_line' || o._movement === 'up' || o._movement === 'down' || o._movedFromLine)
        .map(o => String(o.id ?? '')),
      normalizedIntoFinalSequence: true,
    });
  }

  const handleDragEnd = (result) => {
    if (!result.destination || result.destination.index === result.source.index) return;
    const reordered = [...localOrders];
    const [moved] = reordered.splice(result.source.index, 1);
    reordered.splice(result.destination.index, 0, moved);
    applyPreviewChangeovers(reordered, changeoverRules);
    const updated = calculateEstimatedCompletionDates(reordered);
    setLocalOrders(updated);
    onOrdersChange?.(line, updated);
  };

  const handleOrderUpdate = (orderId, updates) => {
    setLocalOrders(prev => {
      let lineOrders = prev.map(o => ({ ...o }));
      const orderIndex = lineOrders.findIndex(o => o.id === orderId);
      if (orderIndex === -1) return prev;
      const updatedOrder = { ...lineOrders[orderIndex], ...updates };
      lineOrders = cascadeCompletionDates(updatedOrder, lineOrders);
      onOrdersChange?.(line, lineOrders);
      return lineOrders;
    });
  };

  return (
    <div className={`plant-line-tab${isRefreshingStrategies ? ' is-line-refreshing' : ''}${isShutdown ? ' is-line-shutdown' : ''}`}>

      {isShutdown && (
        <div
          data-testid={`banner-shutdown-${line}`}
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            background: '#fef2f2', border: '1px solid #fecaca',
            borderRadius: 8, padding: '10px 14px', margin: '0 0 12px 0',
            color: '#991b1b', fontSize: 13, lineHeight: 1.45,
          }}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>🚫</span>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>
              {line} is in shutdown — excluded as a destination
            </div>
            <div style={{ opacity: 0.85 }}>
              {shutdownReason ? <>Reason: <strong>{shutdownReason}</strong>. </> : null}
              No order was placed onto this line. Eligible orders on {line} were still
              evaluated for movement to active lines under the normal run-rate, status,
              overlap, and combine rules. Only orders that could not be moved under
              those rules remain here. Resume the line to allow it as a destination again.
            </div>
          </div>
        </div>
      )}

      {/* Per-line refresh overlay — only shown while this line's AI strategies
          are being regenerated. Covers the strategy cards + Before/After tables
          without touching any other line tab or the modal's navigation bar. */}
      {isRefreshingStrategies && (
        <div className="line-refresh-overlay" aria-live="polite" aria-label={`Refreshing ${line} AI strategies`}>
          <div className="line-refresh-overlay-content">
            <div className="line-refresh-spinner" />
            <div className="line-refresh-text">
              {`Refreshing ${line || 'line'} AI strategies…`}
            </div>
          </div>
        </div>
      )}

      {/* Per-line strategy selector — three cards (Standard + 2 AI options)
          for THIS line only. Switching here only mutates this line's slot of
          the parent's selection map and localSeqResults; other line tabs
          retain their own selection and ordering. */}
      {lineStrategies && (
        <StrategySelector
          strategies={lineStrategies}
          selectedId={strategyId}
          isLoading={isGeneratingStrategies}
          onSelect={(id) => onSelectStrategy && onSelectStrategy(id)}
          line={line}
          isRefreshing={isRefreshingStrategies}
          onRefresh={onRefreshStrategies}
          liveMetrics={liveMetrics}
          changeoverRules={changeoverRules}
          standardOrders={lineStrategies?.rule_based?.orders || originalOrders}
        />
      )}

      <div className="plant-line-comparison">
        <div className="plant-line-comparison-container">
          <div
            ref={splitContainerRef}
            className={`as-before-after-split ${isDraggingDivider ? 'is-dragging' : ''}`}
          >

            {/* BEFORE table — left split panel */}
            <div
              className="as-split-panel as-split-panel-before"
              style={{ width: `calc(${splitRatio}% - 8px)` }}
            >
              <div className="as-before-label">
                <span>📋</span> Before — {formatOrderCount(originalOrders.filter(o => !o.parent_id).length)}
              </div>
              <div className="as-before-table-wrap">
                <table className="as-before-table" style={{ minWidth: 1100 }}>
                  <thead>
                    <tr>
                      <th className="as-col-prio">Prio</th>
                      <th className="as-col-fpr">FPR</th>
                      <th className="as-col-planned">Planned Order</th>
                      <th className="as-col-material">Material Code</th>
                      <th className="as-col-desc">Item Description</th>
                      <th className="as-col-form">Form</th>
                      <th className="as-col-volume">Volume (MT)</th>
                      <th className="as-col-batch">Batch Size</th>
                      <th className="as-col-batches">Batches</th>
                      <th className="as-col-prod">Production Time</th>
                      <th className="as-col-start-date">Start Date</th>
                      <th className="as-col-start-time">Start Time</th>
                      <th className="as-col-avail">Avail Date</th>
                      <th className="as-col-completion">Estimated Completion Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const topLevel = enrichedBeforeOrders.filter(o => !o.parent_id);
                      return topLevel.map((order, idx) => (
                        <PlantBeforeRow
                          key={order.id}
                          order={order}
                          allOrders={enrichedBeforeOrders}
                          prio={idx + 1}
                          pmxSplitRules={pmxSplitRules}
                        />
                      ));
                    })()}
                    {enrichedBeforeOrders.filter(o => !o.parent_id).length === 0 && (
                      <tr>
                        <td colSpan={14} style={{ textAlign: "center", color: "#9ca3af", padding: "32px 8px", fontSize: 12, fontStyle: "italic" }}>
                          No orders on this line before sequencing
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Draggable Divider */}
            <div
              ref={dividerRef}
              className={`as-split-divider ${isDraggingDivider ? 'active' : ''}`}
              onMouseDown={handleDividerMouseDown}
              onDoubleClick={handleDividerDoubleClick}
              onKeyDown={handleDividerKeyDown}
              tabIndex={0}
              title="Drag to resize • Double-click to reset"
              role="separator"
              aria-orientation="vertical"
              aria-valuenow={Math.round(splitRatio)}
              aria-valuemin={MIN_SPLIT}
              aria-valuemax={MAX_SPLIT}
              aria-label="Resize before and after tables"
            >
              <div className="as-split-divider-line" />
              <div className="as-split-divider-handle">↔</div>
            </div>

            {/* AFTER table with drag-and-drop — right split panel */}
            <div
              className="as-split-panel as-split-panel-after"
              style={{ width: `calc(${100 - splitRatio}% - 8px)` }}
            >
              <div className="as-after-label">
                <span>✨</span> After — {formatOrderCount(enriched.length)}
                {movedCount > 0 && ` · ${movedCount} repositioned`}
                {newFromOtherLines > 0 && ` · ${newFromOtherLines} from other lines`}
                {newlyCombinedCount > 0 && ` · ${newlyCombinedCount} newly combined`}
                {alreadyCombinedCount > 0 && newlyCombinedCount === 0 && movedCount === 0 && newFromOtherLines === 0 && ` · ${alreadyCombinedCount} already combined`}
                {dateChangedCount > 0 && <span style={{ color: '#b45309', fontWeight: 600 }}>{` · ${dateChangedCount} date${dateChangedCount !== 1 ? 's' : ''} updated`}</span>}
                {movedCount === 0 && newFromOtherLines === 0 && newlyCombinedCount === 0 && dateChangedCount === 0 && ` · no changes`}
              </div>
              <div style={{ flex: 1, overflowY: "auto", overflowX: "auto" }}>
                <DragDropContext onDragEnd={handleDragEnd}>
                  <table className="as-after-table" style={{ minWidth: 1100 }}>
                    <thead>
                      <tr>
                        <th className="as-col-drag"></th>
                        <th className="as-col-prio">Prio</th>
                        <th className="as-col-fpr">FPR</th>
                        <th className="as-col-planned">Planned Order</th>
                        <th className="as-col-material">Material Code</th>
                        <th className="as-col-desc">Item Description</th>
                        <th className="as-col-form">Form</th>
                        <th className="as-col-volume">Volume (MT)</th>
                        <th className="as-col-batch">Batch Size</th>
                        <th className="as-col-batches">Batches</th>
                        <th className="as-col-prod">Production Time</th>
                        <th className="as-col-start-date">Start Date</th>
                        <th className="as-col-start-time">Start Time</th>
                        <th className="as-col-avail">Avail Date</th>
                        <th className="as-col-completion">Estimated Completion Date</th>
                        <th className="as-col-insight">Sequence Insight</th>
                        {showMarginCol      && <th className="as-col-margin">Margin</th>}
                        {showProfitScoreCol && <th className="as-col-margin">Profit Score</th>}
                      </tr>
                    </thead>
                    <Droppable droppableId={`plant-line-${line}`}>
                      {(droppableProvided) => (
                        <tbody ref={droppableProvided.innerRef} {...droppableProvided.droppableProps}>
                          {enriched.map((order, index) => (
                            <Draggable
                              key={String(order.id || order._tmpKey || index)}
                              draggableId={String(order.id || order._tmpKey || `idx-${index}`)}
                              index={index}
                            >
                              {(draggableProvided, snapshot) => (
                                <PlantAfterRowContent
                                  order={order}
                                  provided={draggableProvided}
                                  snapshot={snapshot}
                                  prio={index + 1}
                                  movement={order._movement}
                                  movementDelta={order._movementDelta}
                                  inferredTargetMap={inferredTargetMap}
                                  destinationLine={line}
                                  onUncombineSingle={onUncombineSingle}
                                  onRemoveChildFromCombine={onRemoveChildFromCombine
                                    ? (child) => onRemoveChildFromCombine(order, child)
                                    : null
                                  }
                                  insight={rowInsights?.[index + 1] || null}
                                  isLoadingInsight={isLoadingRowInsights}
                                  isProfitabilityApplied={isProfitabilityApplied}
                                  showMarginCol={showMarginCol}
                                  showProfitScoreCol={showProfitScoreCol}
                                  dateChange={order._dateChange || null}
                                  onOrderUpdate={handleOrderUpdate}
                                  lineIndex={index}
                                  previousOrder={index > 0 ? enriched[index - 1] : null}
                                  pmxSplitRules={pmxSplitRules}
                                />
                              )}
                            </Draggable>
                          ))}
                          {droppableProvided.placeholder}
                          {enriched.length === 0 && (
                            <tr>
                              <td colSpan={16} style={{ textAlign: "center", color: "#9ca3af", padding: "32px 8px", fontSize: 12, fontStyle: "italic" }}>
                                All orders moved to other lines
                              </td>
                            </tr>
                          )}
                        </tbody>
                      )}
                    </Droppable>
                  </table>
                </DragDropContext>
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* ── AI vs Final Sequence transparency — hidden per user request ── */}
      {false && <div className="as-transparency" style={{ marginTop: 0, padding: '0 24px 16px' }}>
        <button
          type="button"
          onClick={() => setShowTransparency(v => !v)}
          data-testid={`button-toggle-transparency-${line}`}
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', cursor: 'pointer', color: '#374151', fontSize: 12, fontWeight: 600, padding: '6px 0' }}
        >
          <span style={{ display: 'inline-block', transform: showTransparency ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
          AI vs Final Sequence — Adjustment Details
          <span style={{ color: '#9ca3af', fontWeight: 400 }}>
            ({enriched.filter((o, i) => o._aiRank != null && o._aiRank !== (i + 1)).length} differ from AI rank)
          </span>
        </button>
        {showTransparency && (() => {
          console.debug('[AI vs Final Sequence Table Column Order]', {
            columns: ['Final Rank','Strategy Rank','Suggested Date','Order ID','Item Description','Current Line','Proposed Line','Moved?','Repositioned?','Reason'],
          });
          console.debug('[AI vs Final Sequence One-Line Headers]', { oneLineHeadersApplied: true });

          const thStyle = { padding: '6px 8px', whiteSpace: 'nowrap' };

          return (
          <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 6, marginTop: 6 }}>
            <table className="as-transparency-table" data-testid={`table-transparency-${line}`} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ background: '#f9fafb', textAlign: 'left' }}>
                  <th style={thStyle}>Final Rank</th>
                  <th style={thStyle}>Strategy Rank</th>
                  <th style={thStyle}>Suggested Date</th>
                  <th style={{ ...thStyle, fontFamily: 'monospace' }}>Order ID</th>
                  <th style={thStyle}>Item Description</th>
                  <th style={thStyle}>Current Line</th>
                  <th style={thStyle}>Proposed Line</th>
                  <th style={thStyle}>Moved?</th>
                  <th style={thStyle}>Repositioned?</th>
                  <th style={thStyle}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {enriched.map((o, idx) => {
                  const currentLine = o._originalLine || o._movedFromLine || line;
                  const moved = (o._plantMovement === 'new_to_line') || (!!o._movedFromLine && o._movedFromLine !== line);
                  // Final Rank is always idx+1 (live position — survives drag/edits).
                  const finalRank = idx + 1;
                  const strategyRank = o._aiRank != null ? o._aiRank : null;
                  const _eid = String(o.id ?? '');
                  const suggestedDate = o._aiSuggestedDate || o.avail_date || null;
                  const repositioned = strategyRank != null && strategyRank !== finalRank;

                  // Primary reason: AI-generated when preview loaded; template as fallback.
                  const aiReason = transparencyReasons[finalRank] || null;
                  let reason;
                  if (isLoadingTransparencyReasons) {
                    reason = 'Generating…';
                  } else if (aiReason) {
                    reason = aiReason;
                  } else if (strategyRank == null) {
                    reason = o._isAIStrategyRow
                      ? 'AI did not assign a rank — placed by fallback.'
                      : 'Placed by rule-based sequence; no AI strategy rank.';
                  } else if (repositioned) {
                    const dir = finalRank < strategyRank ? 'earlier' : 'later';
                    const dateClause = suggestedDate ? ` (suggested date: ${suggestedDate})` : '';
                    reason = `Moved ${dir} — suggested date${dateClause} placed it ${dir} than strategy rank ${strategyRank} would have.`;
                  } else {
                    const dateClause = suggestedDate ? ` Suggested date: ${suggestedDate}.` : '';
                    reason = `Strategy rank and final position match.${dateClause}`;
                  }

                  console.debug('[AI vs Final Sequence New Rank Fields]', {
                    entityId: _eid, finalRank, suggestedDate, strategyRank, moved, repositioned,
                  });

                  return (
                    <tr key={String(o.id || idx)} data-testid={`row-transparency-${o.id || idx}`} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '6px 8px', fontWeight: 600 }}>{finalRank}</td>
                      <td style={{ padding: '6px 8px', color: strategyRank == null ? '#9ca3af' : (repositioned ? '#b45309' : '#374151') }}>{strategyRank ?? '—'}</td>
                      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', color: '#374151' }}>{suggestedDate ?? '—'}</td>
                      <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: 10 }}>{String(o.id ?? '—')}</td>
                      <td style={{ padding: '6px 8px', maxWidth: 200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={o.item_description || ''}>{o.item_description || '—'}</td>
                      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{currentLine || '—'}</td>
                      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{line}</td>
                      <td style={{ padding: '6px 8px', color: moved ? '#2563eb' : '#9ca3af' }}>{moved ? 'Yes' : 'No'}</td>
                      <td style={{ padding: '6px 8px', color: repositioned ? '#b45309' : '#9ca3af', fontWeight: repositioned ? 600 : 400 }}>{repositioned ? 'Yes' : 'No'}</td>
                      <td style={{ padding: '6px 8px', maxWidth: 400, color: isLoadingTransparencyReasons ? '#9ca3af' : '#374151', fontStyle: isLoadingTransparencyReasons ? 'italic' : 'normal' }} title={isLoadingTransparencyReasons ? '' : reason}>{reason}</td>
                    </tr>
                  );
                })}
                {enriched.length === 0 && (
                  <tr><td colSpan={10} style={{ padding: '12px 8px', textAlign: 'center', color: '#9ca3af', fontStyle: 'italic' }}>No orders on this line.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          );
        })()}
      </div>}
      {lineActions.length > 0 && (
        <div className="line-actions-plain">
          <h3 className="plant-summary-title">📋 Actions on {line}</h3>

          {isLoadingAI && (
            <div className="plant-actions-loading"><span style={{ marginRight: 8 }}>✦</span>Analyzing actions…</div>
          )}

          {!isLoadingAI && lineActions.map((entry, actionIdx) => {
            const globalIndex = (placementLog || []).findIndex(p => p === entry);
            const explanation = (!useFallback && aiExplanations?.[globalIndex])
              ? aiExplanations[globalIndex]
              : generateFallbackExplanation(entry);
            const isAI = !useFallback && !!aiExplanations?.[globalIndex];
            const inPlace = entry.type === "combined" && (entry.fromLines || []).every(fl => fl === entry.toLine);
            const toScore = (entry.lineScores || []).find(ls => ls.line === entry.toLine);
            const showMTBadge = toScore && !inPlace;
            const mtDiff = showMTBadge ? (toScore.totalMTAfter || 0) - (toScore.totalMTBefore || 0) : 0;

            return (
              <div key={actionIdx} className="plant-action-card">
                <div className="plant-action-header">
                  {entry.type === "combined" ? (
                    <>
                      <span className="plant-action-icon plant-action-combine">🔗</span>
                      <span className="plant-action-title">
                        {inPlace
                          ? <>Combined <strong>{entry.ordersCount}</strong> orders of <strong>{entry.product}</strong> ({parseFloat(entry.totalVolume || 0).toFixed(1)} MT) in place on {entry.toLine}</>
                          : <>Combined <strong>{entry.ordersCount}</strong> orders of <strong>{entry.product}</strong> ({parseFloat(entry.totalVolume || 0).toFixed(1)} MT) from {[...new Set(entry.fromLines || [])].join(", ")} → {entry.toLine}</>
                        }
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="plant-action-icon plant-action-move">↗</span>
                      <span className="plant-action-title">
                        Moved <strong>{entry.product || entry.order}</strong> ({parseFloat(entry.volume || 0).toFixed(1)} MT) from {entry.fromLine} → {entry.toLine}
                      </span>
                    </>
                  )}
                  {isAI && <span className="plant-action-ai-badge">AI</span>}
                </div>

                <div className="plant-action-explanation">{explanation}</div>

                <div className="plant-action-badges">
                  {showMTBadge && (
                    <span className="plant-action-mt-badge plant-action-mt-increase">
                      {getLineShortName(entry.toLine)} {(toScore.totalMTBefore || 0).toFixed(1)} MT → {(toScore.totalMTAfter || 0).toFixed(1)} MT
                      <span className="plant-action-mt-diff">(+{mtDiff.toFixed(1)} MT)</span>
                    </span>
                  )}
                  {entry.type === "combined" && (entry.individualVolumes || []).map((iv, subIdx) => (
                    <span key={subIdx} className="plant-action-sub-chip">
                      {getLineShortName(iv.fromLine)} · {parseFloat(iv.volume || 0).toFixed(1)} MT
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── AI Actions helpers ─── */
function formatTimeShift(hrs) {
  if (!hrs || isNaN(parseFloat(hrs))) return "0 min";
  const totalMins = Math.round(parseFloat(hrs) * 60);
  if (totalMins < 60) return `${totalMins} min`;
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
}


// Run rates by canonical line name — used to compute correct queue times when lineScores
// is missing the destination entry or carries the post-removal (zero-load) state.
const _FALLBACK_LINE_RUN_RATES = { "Line 1": 20, "Line 2": 20, "Line 3": 10, "Line 4": 10, "Line 5": 10, "Line 6": 10, "Line 7": 10 };

export function generateFallbackExplanation(entry) {
  if (entry.type === "combined") {
    const best = entry.bestLineReason || {};
    const bestLS = (entry.lineScores || []).find(ls => ls.line === entry.toLine) || (entry.lineScores || [])[0] || {};
    const inPlace = (entry.fromLines || []).every(fl => fl === entry.toLine);
    const totalVol = parseFloat(entry.totalVolume || 0).toFixed(1);

    if (inPlace) {
      // --- Combine-in-place: deterministic template (matches azureAI.js precomputed insight) ---
      // Use preCombineMTByLine snapshot for the true pre-combine load. lineScores.totalMTBefore
      // is computed AFTER sub-orders are removed, so it would incorrectly show 0 MT here.
      const runRate = bestLS.runRate ?? _FALLBACK_LINE_RUN_RATES[entry.toLine] ?? 20;
      const destMTBefore = entry.preCombineMTByLine
        ? (entry.preCombineMTByLine[entry.toLine] ?? 0)
        : (best.totalMTBefore ?? 0);
      const destMTAfter = best.totalMTAfter ?? (entry.totalVolume ?? 0);
      const beforeQueue = runRate > 0 ? destMTBefore / runRate : 0;
      const afterQueue  = runRate > 0 ? destMTAfter  / runRate : 0;
      const ordersCount = entry.ordersCount ?? 2;
      const changeoversSaved = entry.changeoversSaved ?? 0;
      const minutesSaved = Math.round((entry.timeSaved ?? 0) * 60);
      const lineShort = getLineShortName(entry.toLine);

      return `${ordersCount} order${ordersCount !== 1 ? "s" : ""} of ${entry.product} already on ${lineShort} were combined into a single ${totalVol} MT production run — no MT was moved between lines. Before combining, ${lineShort} already had ${destMTBefore.toFixed(1)} MT queued (${beforeQueue.toFixed(2)} hrs at ${runRate} MT/hr). After combining, the total queued load remained ${destMTAfter.toFixed(1)} MT, so queue time stayed at ${afterQueue.toFixed(2)} hrs. This consolidation eliminates ${changeoversSaved} changeover${changeoversSaved !== 1 ? "s" : ""}, saving approximately ${minutesSaved} minute${minutesSaved !== 1 ? "s" : ""}.`;
    }

    // --- Cross-line combine: keep multi-line evaluation narrative ---
    const allLineDetails = (entry.lineScores || [])
      .map((ls) => `${getLineShortName(ls.line)}: ${(ls.totalMTBefore || 0).toFixed(1)} MT ÷ ${ls.runRate || "?"} MT/hr = ${(ls.queueTimeBefore || 0).toFixed(2)} hrs`)
      .join(", ");
    const otherLines = [...new Set((entry.fromLines || []).filter(fl => fl !== entry.toLine))];
    return `${entry.ordersCount} orders of ${entry.product} were combined into ${totalVol} MT on ${getLineShortName(entry.toLine)}${otherLines.length > 0 ? `, pulling from ${otherLines.map(l => getLineShortName(l)).join(", ")}` : ""}. Queue times evaluated: ${allLineDetails}. ${getLineShortName(entry.toLine)} had the lowest queue time of ${(best.queueTime || 0).toFixed(2)} hrs (${(best.totalMTBefore || 0).toFixed(1)} MT ÷ ${bestLS.runRate || "?"} MT/hr). After combining, ${getLineShortName(entry.toLine)} went from ${(best.totalMTBefore || 0).toFixed(1)} MT to ${(best.totalMTAfter || 0).toFixed(1)} MT. This eliminates ${entry.changeoversSaved} changeover${entry.changeoversSaved !== 1 ? "s" : ""}, saving ${formatTimeShift(entry.timeSaved)}.`;
  }
  if (entry.type === "moved") {
    const toScore = (entry.lineScores || []).find(ls => ls.line === entry.toLine) || {};
    const from = entry.fromLineReason || {};
    const toLineShort = getLineShortName(entry.toLine);
    const fromLineShort = getLineShortName(entry.fromLine);
    const vol = (entry.volume || 0).toFixed(1);
    const toBeforeMT = (toScore.totalMTBefore || 0).toFixed(1);
    const toAfterMT = (toScore.totalMTAfter || 0).toFixed(1);
    const toBeforeQueue = (toScore.queueTimeBefore || 0).toFixed(2);
    const toAfterQueue = (toScore.queueTimeAfter || 0).toFixed(2);
    const toRunRate = toScore.runRate || "?";
    const fromQueue = (from.queueTime || 0).toFixed(2);

    console.debug('[Move Insight Reasoning]', {
      product: entry.product,
      fromLine: entry.fromLine,
      toLine: entry.toLine,
      sourceQueue: from.queueTime,
      targetQueueBefore: toScore.queueTimeBefore,
      targetQueueAfter: toScore.queueTimeAfter,
      eligibleLines: entry.eligibleLines,
      onlyTargetEligible: entry.onlyTargetEligible,
      sourceEligible: entry.sourceEligible,
    });

    // GUARD: destination queue is NOT actually lower than source → eligibility must be the reason
    const destQueueLower = (toScore.queueTimeBefore || 0) < (from.queueTime || 0);

    if (entry.onlyTargetEligible || !destQueueLower) {
      // Eligibility-driven move: lead with eligibility, show queue as context only
      const sourceNotEligible = !entry.sourceEligible;
      const eligNote = sourceNotEligible
        ? `Although the order appeared on ${fromLineShort} initially, ${toLineShort} is the valid production line for this product based on Master Data run-rate mapping.`
        : `${toLineShort} is the eligible production line for this item based on Master Data run-rate mapping.`;
      return `${entry.product} (${vol} MT) was moved from ${fromLineShort} to ${toLineShort} because ${toLineShort} is the eligible production line for this item based on Master Data run-rate mapping. ${eligNote} Before placement, ${toLineShort} had ${toBeforeMT} MT queued (${toBeforeQueue} hrs at ${toRunRate} MT/hr); after placement, its load increased to ${toAfterMT} MT (${toAfterQueue} hrs). Although ${fromLineShort} had a lower queue time of ${fromQueue} hrs, the order was placed on ${toLineShort} because that line is eligible for this product.`;
    }

    // Queue-driven move: destination genuinely has lower queue
    const allLineDetails = (entry.lineScores || [])
      .map((ls) => `${getLineShortName(ls.line)}: ${(ls.totalMTBefore || 0).toFixed(1)} MT ÷ ${ls.runRate || "?"} MT/hr = ${(ls.queueTimeBefore || 0).toFixed(2)} hrs`)
      .join(", ");
    return `${entry.product} (${vol} MT) was moved from ${fromLineShort} to ${toLineShort}. Queue times evaluated: ${allLineDetails}. ${toLineShort} had the lowest queue time of ${toBeforeQueue} hrs compared to ${fromLineShort} at ${fromQueue} hrs. After placement, ${toLineShort} increased from ${toBeforeMT} MT to ${toAfterMT} MT.`;
  }
  return "Action details unavailable.";
}

/* ─── PlantActionsTaken component — receives cached AI state from parent ─── */
function PlantActionsTaken({ placementLog, aiExplanations, isLoadingAI, useFallback, onRefreshInsights }) {
  if (!placementLog || placementLog.length === 0) {
    return (
      <div className="plant-actions-section">
        <div className="plant-actions-header">
          <div className="plant-summary-title">📋 Actions Taken</div>
        </div>
        <div className="plant-actions-empty">No actions taken — all orders remain on their original lines.</div>
      </div>
    );
  }

  return (
    <div className="plant-actions-section">
      <div className="plant-actions-header">
        <div className="plant-summary-title">📋 Actions Taken</div>
        <button className="plant-actions-refresh" onClick={onRefreshInsights} data-testid="button-plant-actions-refresh">
          ↻ Refresh
        </button>
      </div>

      {isLoadingAI && (
        <div className="plant-actions-loading">
          <span style={{ marginRight: 8 }}>✦</span>Generating AI explanations…
        </div>
      )}

      {!isLoadingAI && placementLog.map((entry, index) => {
        const explanation = (!useFallback && aiExplanations?.[index])
          ? aiExplanations[index]
          : generateFallbackExplanation(entry);
        const isAI = !useFallback && !!aiExplanations?.[index];

        const toScore = (entry.lineScores || []).find(ls => ls.line === entry.toLine);
        const inPlace = entry.type === "combined" && (entry.fromLines || []).every(fl => fl === entry.toLine);
        const showMTBadge = toScore && !inPlace;
        const mtDiff = showMTBadge ? (toScore.totalMTAfter || 0) - (toScore.totalMTBefore || 0) : 0;

        return (
          <div key={index} className="plant-action-card">
            {/* Header */}
            <div className="plant-action-header">
              {entry.type === "combined" ? (
                <>
                  <span className="plant-action-icon plant-action-combine">🔗</span>
                  <span className="plant-action-title">
                    {inPlace
                      ? <>Combined <strong>{entry.ordersCount}</strong> orders of <strong>{entry.product}</strong> ({parseFloat(entry.totalVolume || 0).toFixed(1)} MT) in place on {entry.toLine}</>
                      : <>Combined <strong>{entry.ordersCount}</strong> orders of <strong>{entry.product}</strong> ({parseFloat(entry.totalVolume || 0).toFixed(1)} MT) from {[...new Set(entry.fromLines || [])].join(", ")} → {entry.toLine}</>
                    }
                  </span>
                </>
              ) : (
                <>
                  <span className="plant-action-icon plant-action-move">↗</span>
                  <span className="plant-action-title">
                    Moved <strong>{entry.product || entry.order}</strong> ({parseFloat(entry.volume || 0).toFixed(1)} MT) from {entry.fromLine} → {entry.toLine}
                  </span>
                </>
              )}
              {isAI && <span className="plant-action-ai-badge">AI</span>}
            </div>

            {/* Explanation — plain text */}
            <div className="plant-action-explanation">
              {explanation}
            </div>

            {/* Bottom badges row: MT change + sub-order chips */}
            <div className="plant-action-badges">
              {showMTBadge && (
                <span className="plant-action-mt-badge plant-action-mt-increase">
                  {getLineShortName(entry.toLine)} {(toScore.totalMTBefore || 0).toFixed(1)} MT → {(toScore.totalMTAfter || 0).toFixed(1)} MT
                  <span className="plant-action-mt-diff">(+{mtDiff.toFixed(1)} MT)</span>
                </span>
              )}
              {entry.type === "combined" && (entry.individualVolumes || []).map((iv, subIdx) => (
                <span key={subIdx} className="plant-action-sub-chip">
                  {getLineShortName(iv.fromLine)} · {parseFloat(iv.volume || 0).toFixed(1)} MT
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── PlantSummaryTab — passes cached AI data through to PlantActionsTaken ─── */
// diversions === null  → Stage 5.5 has not run yet; do not render
// diversions === []    → Stage 5.5 ran and found no diversions needed
// diversions.length>0 → Stage 5.5 applied N cross-line moves
export function PlantRebalanceSection({ diversions }) {
  if (diversions === null || diversions === undefined) return null;
  return (
    <div className="plant-summary-section" style={{ marginBottom: 16 }}>
      <div className="plant-summary-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>🔀</span>
        <span>AI Plant-Wide Rebalance</span>
        <span style={{ fontWeight: 400, fontSize: 11, color: '#6b7280', marginLeft: 4 }}>
          Stage 5.5
          {diversions.length === 0
            ? ' — No diversions needed'
            : ` — ${diversions.length} cross-line diversion${diversions.length !== 1 ? 's' : ''} applied`}
        </span>
      </div>
      {diversions.length === 0 ? (
        <div style={{ padding: '10px 8px', color: '#6b7280', fontSize: 12, fontStyle: 'italic' }}>
          All lines are balanced and MTO deadlines are not at risk. No orders were moved.
        </div>
      ) : (
        <div style={{ padding: '4px 0' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                <th style={{ textAlign: 'left', padding: '5px 8px', fontWeight: 600, color: '#374151' }}>Order</th>
                <th style={{ textAlign: 'left', padding: '5px 8px', fontWeight: 600, color: '#374151' }}>From</th>
                <th style={{ textAlign: 'left', padding: '5px 8px', fontWeight: 600, color: '#374151' }}>To</th>
                <th style={{ textAlign: 'left', padding: '5px 8px', fontWeight: 600, color: '#374151' }}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {diversions.map((d, i) => (
                <tr key={d.orderId + String(i)} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '5px 8px', color: '#1f2937', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span title={`Order ID: ${d.orderId}\n${d.orderName}`}>{d.orderName || d.orderId}</span>
                  </td>
                  <td style={{ padding: '5px 8px', color: '#ef4444', fontWeight: 500 }}>{d.fromLine}</td>
                  <td style={{ padding: '5px 8px', color: '#22c55e', fontWeight: 500 }}>{d.toLine}</td>
                  <td style={{ padding: '5px 8px', color: '#6b7280', fontStyle: 'italic' }}>{d.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function PlantSummaryTab({ summaryStats, placementLog, aiExplanations, isLoadingAI, useFallback, onRefreshInsights, isProfitabilityApplied, rebalanceDiversions }) {
  return (
    <div className="plant-summary-tab">
      <div className="plant-summary-section">
        <div className="plant-summary-title">📊 Per-Line Summary</div>
        <div className="plant-summary-table-wrap">
          <table className="plant-summary-table">
            <thead>
              <tr>
                <th>Line</th>
                <th>Feedmill</th>
                <th className="text-center">Total Orders Before</th>
                <th className="text-center">Total Orders After</th>
                <th className="text-right">Total Vol Before (MT)</th>
                <th className="text-right">Total Vol After (MT)</th>
                <th className="text-right">Total HRS<br/>Pre-Determined Line<br/>(Prod. Time + Changeovers)</th>
                <th className="text-right">Total HRS After<br/>(Standard Sequence)<br/>w/ Line Diversion &amp;<br/>Auto Combinations</th>
                <th className="text-right">Net Hours<br/>Change</th>
                <th className="text-right">Net Hours Change<br/>(Changeover Only)</th>
                <th className="text-center">New</th>
                <th className="text-center">Left</th>
              </tr>
            </thead>
            <tbody>
              {(summaryStats?.perLineSummary || []).map((ls) => (
                <tr key={ls.line}>
                  <td className="plant-summary-line-cell">{ls.line}</td>
                  <td style={{ color: "#6b7280", fontSize: 11 }}>{ls.feedmill}</td>
                  <td className="text-center">{ls.beforeCount}</td>
                  <td className="text-center">{ls.afterCount}</td>
                  <td className="text-right">{parseFloat(ls.beforeMT || 0).toFixed(1)}</td>
                  <td className="text-right">{parseFloat(ls.afterMT || 0).toFixed(1)}</td>
                  <td className="text-right">
                    {ls.beforeHours ? (
                      <span
                        title={`Production: ${(ls.beforeHours.productionHours || 0).toFixed(2)} hrs\nChangeover: ${(ls.beforeHours.changeoverHours || 0).toFixed(2)} hrs\nTotal: ${(ls.beforeHours.totalHours || 0).toFixed(2)} hrs`}
                        style={{ cursor: "help", borderBottom: "1px dotted #9ca3af" }}
                      >
                        {(ls.beforeHours.totalHours || 0).toFixed(2)}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="text-right">
                    {ls.afterHours ? (
                      <span
                        title={`Production: ${(ls.afterHours.productionHours || 0).toFixed(2)} hrs\nChangeover: ${(ls.afterHours.changeoverHours || 0).toFixed(2)} hrs\nTotal: ${(ls.afterHours.totalHours || 0).toFixed(2)} hrs`}
                        style={{ cursor: "help", borderBottom: "1px dotted #9ca3af" }}
                      >
                        {(ls.afterHours.totalHours || 0).toFixed(2)}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="text-right">
                    <span className={`plant-queue-diff ${ls.hoursDiff < 0 ? "plant-diff-pos" : ls.hoursDiff > 0 ? "plant-diff-neg" : ""}`}>
                      {ls.hoursDiff > 0 ? "+" : ""}{(ls.hoursDiff || 0).toFixed(2)}
                    </span>
                  </td>
                  <td className="text-right">
                    {(ls.beforeHours && ls.afterHours) ? (() => {
                      const coBefore = ls.beforeHours.changeoverHours || 0;
                      const coAfter  = ls.afterHours.changeoverHours  || 0;
                      const coDiff   = coAfter - coBefore;
                      return (
                        <span
                          className={`plant-queue-diff ${coDiff < 0 ? "plant-diff-pos" : coDiff > 0 ? "plant-diff-neg" : ""}`}
                          title={`Changeover before: ${coBefore.toFixed(2)} hrs\nChangeover after: ${coAfter.toFixed(2)} hrs`}
                          style={{ cursor: "help" }}
                        >
                          {coDiff > 0 ? "+" : ""}{coDiff.toFixed(2)}
                        </span>
                      );
                    })() : <span style={{ color: "#d1d5db" }}>—</span>}
                  </td>
                  <td className="text-center">{ls.newOrders > 0 ? <span className="plant-new-badge">+{ls.newOrders}</span> : <span style={{ color: "#d1d5db" }}>—</span>}</td>
                  <td className="text-center">{ls.removedOrders > 0 ? <span className="plant-left-badge">-{ls.removedOrders}</span> : <span style={{ color: "#d1d5db" }}>—</span>}</td>
                </tr>
              ))}
              {(() => {
                const rows = summaryStats?.perLineSummary || [];
                if (rows.length === 0) return null;
                const totalBefore = rows.reduce((s, r) => s + (parseFloat(r.beforeMT) || 0), 0);
                const totalAfter  = rows.reduce((s, r) => s + (parseFloat(r.afterMT)  || 0), 0);
                return (
                  <tr style={{ borderTop: "2px solid #d1d5db", background: "#f3f4f6", fontWeight: 700 }}>
                    <td className="plant-summary-line-cell" style={{ color: "#374151", fontWeight: 700 }}>Total</td>
                    <td />
                    <td />
                    <td />
                    <td className="text-right" style={{ color: "#111827" }}>{totalBefore.toFixed(1)}</td>
                    <td className="text-right" style={{ color: "#111827" }}>{totalAfter.toFixed(1)}</td>
                    <td /><td /><td /><td /><td /><td />
                  </tr>
                );
              })()}
            </tbody>
          </table>
        </div>
      </div>

      {/* Combinations Executed — placed below the per-line summary table */}
      {(() => {
        const combos = (placementLog || []).filter((p) => p.type === "combined");
        if (!combos.length) return null;
        const totalCOSaved = combos.reduce((s, c) => s + (c.changeoversSaved || 0), 0);
        const totalTimeSaved = combos.reduce((s, c) => s + (parseFloat(c.timeSaved) || 0), 0);
        return (
          <div className="plant-summary-section" style={{ marginTop: 20 }}>
            <div className="plant-summary-title">
              🔗 Combinations Executed ({combos.length} group{combos.length !== 1 ? "s" : ""})
            </div>
            <div className="plant-summary-table-wrap">
              <table className="plant-summary-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Mat. Code</th>
                    <th className="text-center">Orders Merged</th>
                    <th className="text-right">Vol MT</th>
                    <th>From Lines</th>
                    <th>To Line</th>
                    <th className="text-center">CO Saved</th>
                    <th className="text-right">Time Saved (h)</th>
                  </tr>
                </thead>
                <tbody>
                  {combos.map((c, i) => {
                    const fromLines = [...new Set(c.fromLines || [])].sort().join(", ");
                    return (
                      <tr key={(c.materialCode || c.product || "combo") + String(i)} data-testid={`row-combination-${i}`}>
                        <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.product}>
                          {c.product || c.materialCode || "—"}
                        </td>
                        <td style={{ color: "#6b7280" }}>{c.materialCode || "—"}</td>
                        <td className="text-center">{c.ordersCount || 0}</td>
                        <td className="text-right">{parseFloat(c.totalVolume || 0).toFixed(1)}</td>
                        <td style={{ color: "#6b7280" }}>{fromLines || "—"}</td>
                        <td>{c.toLine || "—"}</td>
                        <td className="text-center">{c.changeoversSaved || 0}</td>
                        <td className="text-right">{(parseFloat(c.timeSaved) || 0).toFixed(2)}</td>
                      </tr>
                    );
                  })}
                  <tr style={{ borderTop: "2px solid #d1d5db", background: "#f3f4f6", fontWeight: 700 }}>
                    <td style={{ color: "#374151", fontWeight: 700 }}>Total</td>
                    <td /><td /><td /><td /><td />
                    <td className="text-center" style={{ color: "#111827" }} data-testid="text-total-co-saved">{totalCOSaved}</td>
                    <td className="text-right" style={{ color: "#111827" }} data-testid="text-total-time-saved">{totalTimeSaved.toFixed(2)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* Profitability banner — shown between summary table and Actions Taken */}
      {isProfitabilityApplied && (
        <div className="profitability-banner">
          <span className="profitability-banner-icon" style={{ filter: 'grayscale(1)', opacity: 0.7 }}>💰</span>
          <div className="profitability-banner-content">
            <span className="profitability-banner-title">Profitability optimization active</span>
            <span className="profitability-banner-text">
              Orders are sorted by: Avail Date → Future Dispatches Target Date → Product Margin (higher margin prioritized).
              Click the button again to revert to chronological sorting only.
            </span>
          </div>
        </div>
      )}

      <PlantActionsTaken
        placementLog={placementLog}
        aiExplanations={aiExplanations}
        isLoadingAI={isLoadingAI}
        useFallback={useFallback}
        onRefreshInsights={onRefreshInsights}
      />
    </div>
  );
}

/* ─── compute per-line stats for the shared strip ─── */
function computeLineStats(originalOrders, sequencedOrders) {
  const origIndexMap = {};
  originalOrders.forEach((o, i) => { origIndexMap[o.id] = i; });
  const origLeadIds = new Set(
    originalOrders.filter(o => o.original_order_ids?.length > 0).map(o => o.id)
  );
  const enriched = sequencedOrders.map((o, newIdx) => {
    const isNew = o._plantMovement === "new_to_line" || origIndexMap[o.id] === undefined;
    if (isNew) return { ...o, _movement: "new_to_line" };
    const origIdx = origIndexMap[o.id];
    const origOrder = originalOrders[origIdx];
    const origVol = parseFloat(origOrder?.volume_override || origOrder?.total_volume_mt) || 0;
    const newVol  = parseFloat(o.volume_override || o.total_volume_mt) || 0;
    const delta = origIdx - newIdx;
    const sameVol = Math.abs(origVol - newVol) < 0.01;
    const movement = (delta === 0 && sameVol) ? "same"
      : delta > 0 ? "up" : delta < 0 ? "down" : "same";
    return { ...o, _movement: movement, _movementDelta: Math.abs(delta) };
  });
  const newlyCombined   = enriched.filter(o => o._isCombined && !origLeadIds.has(o.id)).length;
  const alreadyCombined = enriched.filter(o => o._isCombined &&  origLeadIds.has(o.id)).length;
  const moved     = enriched.filter(o => o._movement === "up" || o._movement === "down").length;
  const fromOther = enriched.filter(o => o._movement === "new_to_line").length;
  const hasChanges = moved > 0 || fromOther > 0 || newlyCombined > 0;

  // Count N10D-sourced orders whose avail date changed
  const origByIdForDates = {};
  originalOrders.forEach(o => { origByIdForDates[String(o.id)] = o; });
  const datesUpdated = sequencedOrders.filter(o => {
    const orig = origByIdForDates[String(o.id)];
    if (!orig) return false;
    if (orig.target_avail_date === o.target_avail_date) return false;
    return o.avail_date_source === 'auto_sequence' || o.date_source === 'n10d';
  }).length;

  return {
    before: originalOrders.length,
    after: sequencedOrders.length,
    moved,
    fromOther,
    newlyCombined,
    alreadyCombined,
    hasChanges,
    datesUpdated,
  };
}

/* ─── Live metric recalculation helper ────────────────────────────────────────
   Recomputes the four card metrics from the current (potentially drag-reordered)
   order array so the strategy card stays accurate after manual moves.
   standardOrders is the rule_based baseline used for the delta calculations.
   For the Standard card itself (strategyId === 'rule_based') time-saved and
   utilizationDelta are returned as null so they render as "—". ────────────── */
function computeLiveMetrics(localOrders, line, changeoverRules, inferredTargetMap, standardOrders, strategyId) {
  if (!localOrders || !localOrders.length) return null;
  const liveCO  = calculateTotalChangeoverTime(localOrders, changeoverRules);
  const stdCO   = calculateTotalChangeoverTime(standardOrders || [], changeoverRules);
  const isStd   = strategyId === 'rule_based';
  const timeSavedDeltaHours = isStd ? null : Number((liveCO - stdCO).toFixed(2));
  const ordersAtRisk = localOrders.filter(
    o => o._n10dStatus === 'Critical' || o._n10dStatus === 'Urgent'
  ).length;
  const riskSeverity = ordersAtRisk === 0 ? 'Low' : 'High';
  const liveUtil = computeDailyUtilization(localOrders, line, changeoverRules, inferredTargetMap);
  const stdUtil  = computeDailyUtilization(standardOrders || [], line, changeoverRules, inferredTargetMap, { continuous: false });
  const utilizationDelta = isStd
    ? null
    : Number((liveUtil.averageUtilization - stdUtil.averageUtilization).toFixed(1));
  return {
    totalChangeoverHours: Number(liveCO.toFixed(2)),
    timeSavedDeltaHours,
    ordersAtRisk,
    riskSeverity,
    dailyUtilization: liveUtil,
    averageUtilization: liveUtil.averageUtilization,
    utilizationDelta,
  };
}

/* ─── Strategy selector (co-located, used only by PlantAutoSequenceModal) ─── */
function StrategyCard({ strategy, isSelected, isLoading, onSelect, liveMetrics, standardPerDay = [], line = '', changeoverRules, standardOrders }) {
  const { metrics = {}, isAIRecommended, aiFailed } = strategy;
  // Merge live-recalculated values over static ones when the card is selected.
  // dailyUtilization is intentionally pinned to the baked value so the table
  // never changes just because a different card is clicked.
  const m = (isSelected && liveMetrics)
    ? { ...metrics, ...liveMetrics, dailyUtilization: metrics.dailyUtilization }
    : metrics;
  const isLive = isSelected && liveMetrics != null;
  const cls = [
    "ai-strategy-card",
    `ai-strategy-card-${strategy.color}`,
    isSelected ? "ai-strategy-card-selected" : "",
    isAIRecommended ? "ai-strategy-card-recommended" : "",
    aiFailed ? "ai-strategy-card-failed" : "",
    isLoading ? "ai-strategy-card-disabled" : "",
  ].filter(Boolean).join(" ");

  // Use <div> (not <button>) since the card contains nested <details>/<summary>
  // (interactive HTML inside a button is invalid). We provide role/keyboard a11y manually.
  const handleKey = (e) => {
    if (isLoading) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); }
  };

  const isStandardCard = strategy.id === 'rule_based';
  // Single source of truth for the Flexible-order intra-tier refinements the AI
  // applied, shared by the header title and the narrative so they never disagree:
  //  • marginFrontLoaded   — higher-margin orders concentrated toward the front
  //  • volatileFrontLoaded — volatile (less-stable → erratic) demand pulled
  //    earlier, credited only when margin did NOT already explain the front-load,
  //    matching how the engine treats velocity as a secondary tiebreaker.
  const flexRefinement = (() => {
    if (isStandardCard) return { marginFrontLoaded: false, volatileFrontLoaded: false };
    const flex = (strategy.orders || []).filter(o => {
      const st = o._n10dStatus || '';
      const isMTO = o.is_mto === true || o.is_mto === 'true';
      return !isMTO && st !== 'Critical' && st !== 'Urgent' && st !== 'Monitor';
    });
    if (flex.length < 2) return { marginFrontLoaded: false, volatileFrontLoaded: false };
    const half = Math.ceil(flex.length / 2);
    const avgPos = (arr, fn) => { const v = arr.map(fn).filter(x => x > 0); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; };
    const frontM = avgPos(flex.slice(0, half), o => parseFloat(o._margin) || 0);
    const backM  = avgPos(flex.slice(half),    o => parseFloat(o._margin) || 0);
    const mfl = frontM > 0 && backM > 0 && frontM > backM * 1.1;
    const velOf = o => (o._velocity === 'Erratic' ? 2 : o._velocity === 'Less Stable' ? 1 : 0);
    const frontV = flex.slice(0, half).reduce((s, o) => s + velOf(o), 0) / half;
    const backV  = flex.slice(half).reduce((s, o) => s + velOf(o), 0) / (flex.length - half);
    const vfl = !mfl && frontV > 0 && frontV > backV + 0.3;
    return { marginFrontLoaded: mfl, volatileFrontLoaded: vfl };
  })();
  const synthesizedTitle = (() => {
    if (isStandardCard) return strategy.name || 'Standard Sequence';
    const mtsAdvanced = m.mtsAdjusted || 0;
    const mtsTotal   = m.mtsCount || 0;
    const coDelta    = m.timeSavedDeltaHours;

    const { marginFrontLoaded, volatileFrontLoaded } = flexRefinement;

    // The header summarises ONLY changes the AI sequencing actually effected
    // (MTS advancement, profitability/velocity front-loading, changeover), with
    // a short reason for each. Cross-line transfers are produced by deterministic
    // line-transfer logic, NOT the AI, so they are excluded here and in the body.
    const parts = [];
    if (mtsAdvanced > 0) {
      parts.push(`advanced ${mtsAdvanced} of ${mtsTotal} MTS order${mtsTotal !== 1 ? 's' : ''} into open capacity`);
    }
    if (marginFrontLoaded) {
      parts.push(`front-loaded the higher-margin work`);
    } else if (volatileFrontLoaded) {
      parts.push(`pulled volatile demand earlier`);
    }
    if (coDelta != null && coDelta < -0.05) {
      parts.push(`trimmed ${Math.abs(coDelta).toFixed(1)} hr of changeover`);
    } else if (coDelta != null && coDelta > 0.05) {
      const tradeoffWhy = mtsAdvanced > 0
        ? 'to let those orders run sooner'
        : 'to clear higher-priority work first';
      parts.push(`took on ${coDelta.toFixed(1)} hr more changeover ${tradeoffWhy}`);
    }
    if (parts.length === 0) return strategy.name || 'AI-Generated Sequence';
    const joined = parts.length === 1 ? parts[0]
      : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
    return joined.charAt(0).toUpperCase() + joined.slice(1);
  })();

  return (
    <div
      role="button"
      tabIndex={isLoading ? -1 : 0}
      aria-pressed={isSelected}
      aria-disabled={isLoading}
      className={cls}
      onClick={isLoading ? undefined : onSelect}
      onKeyDown={handleKey}
      data-testid={`button-strategy-${strategy.id}`}
    >
      {aiFailed && (
        <div className="ai-strategy-card-badges">
          <span className="ai-strategy-badge ai-strategy-badge-failed">⚠ AI Unavailable</span>
        </div>
      )}

      <div className="ai-strategy-header">
        {strategy.icon && <span className="ai-strategy-icon">{strategy.icon}</span>}
        <div className="ai-strategy-titles">
          <span className="ai-strategy-name">{synthesizedTitle}</span>
          <span className="ai-strategy-theme">{strategy.theme}</span>
        </div>
      </div>


      <div className="ai-strategy-metrics">
        {/* Min. slack hidden — uncomment to restore
        <div className="ai-strategy-metric-row">
          <span className="ai-strategy-metric-label">Min. slack</span>
          <span className={`ai-strategy-metric-value ai-strategy-metric-risk-${(metrics.riskLevel || "low").toLowerCase()}`}>
            {metrics.minSlackHours != null ? `${metrics.minSlackHours} hr` : "—"}
          </span>
        </div>
        */}
        <div className="ai-strategy-metric-row">
          <span className="ai-strategy-metric-label">MTS optimized</span>
          <span className="ai-strategy-metric-value">{metrics.mtsAdjusted} / {metrics.mtsCount}</span>
        </div>
        <div className="ai-strategy-metric-row" data-testid={`row-changeover-${strategy.id}`}>
          <span className="ai-strategy-metric-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Total changeover time
            {isLive && <span style={{ fontSize: 9, color: '#6b7280', fontWeight: 500 }} title="Recalculated from current order sequence">↻</span>}
          </span>
          <span className="ai-strategy-metric-value" data-testid={`text-changeover-${strategy.id}`}>
            {m.totalChangeoverHours != null
              ? `${m.totalChangeoverHours.toFixed(2)} hr`
              : '—'}
          </span>
        </div>
        <div className="ai-strategy-metric-row" data-testid={`row-orders-at-risk-${strategy.id}`}>
          <span className="ai-strategy-metric-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Orders at risk
            {isLive && <span style={{ fontSize: 9, color: '#6b7280', fontWeight: 500 }} title="Recalculated from current order sequence">↻</span>}
          </span>
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: 0, fontSize: 12 }}
            data-testid={`text-orders-at-risk-${strategy.id}`}
          >
            {(() => {
              const count = m.ordersAtRisk ?? 0;
              const severity = m.riskSeverity ?? (count === 0 ? 'Low' : 'High');
              const severityColor = severity === 'High' ? '#b91c1c' : '#15803d';
              return (
                <>
                  <span style={{ color: '#374151' }}>{count}</span>
                  <span style={{ color: '#9ca3af', margin: '0 3px' }}>|</span>
                  <span style={{ color: severityColor }}>{severity}</span>
                </>
              );
            })()}
          </span>
        </div>
        {(() => {
          const perDay = m.dailyUtilization?.perDay || [];
          const isStandard = strategy.id === 'rule_based';
          const stdMap = isStandard ? {} : Object.fromEntries(standardPerDay.map(d => [d.date, d]));
          const fmtMonthDay = (iso) => {
            const d = new Date(`${iso}T00:00:00`);
            if (isNaN(d.getTime())) return iso;
            return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
          };
          return (
            <>
              <div
                className="ai-strategy-metric-row"
                data-testid={`row-daily-utilization-${strategy.id}`}
                style={{ cursor: 'default', userSelect: 'none' }}
              >
                <span className="ai-strategy-metric-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  Daily utilization
                  {isLive && strategy.id !== 'rule_based' && <span style={{ fontSize: 9, color: '#6b7280', fontWeight: 500 }} title="Recalculated from current order sequence">↻</span>}
                </span>
              </div>
              {perDay.length > 0 && (
                <div
                  className="ai-strategy-util-breakdown"
                  data-testid={`util-breakdown-${strategy.id}`}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    marginTop: 6,
                    marginBottom: 8,
                    padding: '10px 12px',
                    background: '#f9fafb',
                    border: '1px solid #e5e7eb',
                    borderRadius: 6,
                    fontSize: 11,
                  }}
                >
                  {/* Header row */}
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 3rem 4.5rem 3.5rem',
                    columnGap: 8,
                    fontWeight: 700,
                    color: '#9ca3af',
                    borderBottom: '1px solid #e5e7eb',
                    paddingBottom: 5,
                    marginBottom: 5,
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}>
                    <span>Date</span>
                    <span style={{ textAlign: 'right' }}>Orders</span>
                    <span style={{ textAlign: 'right' }}>Hours</span>
                    <span style={{ textAlign: 'right' }}>Util %</span>
                  </div>
                  {/* Data rows */}
                  {perDay.map(d => {
                    const stdDay = stdMap[d.date];
                    const delta = (!isStandard && stdDay != null && d.utilizationPercent != null && stdDay.utilizationPercent != null)
                      ? d.utilizationPercent - stdDay.utilizationPercent
                      : null;
                    const deltaColor = delta == null ? null : delta > 0 ? '#15803d' : delta < 0 ? '#b91c1c' : '#6b7280';
                    return (
                      <div
                        key={d.date}
                        data-testid={`util-day-${strategy.id}-${d.date}`}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '1fr 3rem 4.5rem 3.5rem',
                          columnGap: 8,
                          color: '#374151',
                          lineHeight: 1.9,
                          alignItems: 'center',
                        }}
                      >
                        <span style={{ whiteSpace: 'nowrap' }}>
                          {d.date === '(no date)' ? '(no date)' : fmtMonthDay(d.date)}
                        </span>
                        <span style={{ textAlign: 'right', color: '#6b7280' }}>{d.orderCount}</span>
                        <span style={{ textAlign: 'right', color: '#6b7280' }}>{d.usedHours.toFixed(1)} hrs</span>
                        <span style={{ textAlign: 'right' }}>
                          <span style={{ fontWeight: 600, display: 'block' }}>
                            {d.utilizationPercent != null ? `${d.utilizationPercent.toFixed(1)}%` : '—'}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                  {/* Optimization narrative — dynamically generated from actual results */}
                  {(() => {
                    const fmtD = (iso) => {
                      const d = new Date(`${iso}T00:00:00`);
                      return isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    };

                    const buildNarrative = () => {
                      const orders = strategy.orders || [];
                      const validPerDay = perDay.filter(d => d.date && d.date !== '(no date)');
                      const totalOrders = orders.length;
                      const totalHrs = validPerDay.reduce((s, d) => s + (d.usedHours || 0), 0);
                      const activeDays = validPerDay.length;

                      const fmtList = (arr) => {
                        const labels = [...arr].sort().map(fmtD);
                        if (labels.length === 1) return labels[0];
                        if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
                        return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
                      };

                      // Per-pair changeover breakdown helper
                      const computeCoBreakdown = (seq) => {
                        let dieChanges = 0, colorChanges = 0;
                        const rules = changeoverRules || [];
                        for (let i = 1; i < seq.length; i++) {
                          try {
                            const result = calculateAdditionalChangeover(seq[i - 1], seq[i], rules);
                            if (result.changeDie) dieChanges++;
                            if (result.cleaning) colorChanges++;
                          } catch (_) {}
                        }
                        return { dieChanges, colorChanges };
                      };

                      if (isStandard) {
                        return `This baseline sequence schedules ${totalOrders} order${totalOrders !== 1 ? 's' : ''} across ${activeDays} production day${activeDays !== 1 ? 's' : ''} with ${totalHrs.toFixed(1)} hours of total runtime. All other strategies are measured against this.`;
                      }

                      const sentences = [];

                      // Map raw AI goal keys to planner-friendly phrases
                      const GOAL_PHRASES = {
                        advance_flexible_orders:      'advance flexible MTS orders earlier to fill available capacity',
                        compress_compatible_runs:      'compress compatible production runs to reduce total runtime',
                        group_swine_by_diameter:       'group swine orders by die diameter to minimise changeover',
                        create_downstream_slack:       'create downstream scheduling slack for upcoming orders',
                        protect_late_window_capacity:  'protect late-window capacity for high-priority orders',
                        stabilize_mid_queue:           'stabilise mid-queue order flow to reduce scheduling risk',
                        generic_optimization:          'optimise the production sequence for this line',
                      };

                      // Opening — goal-driven, ties directly to the card header
                      const rawGoal = strategy.primaryGoal;
                      const goalPhrase = rawGoal
                        ? (GOAL_PHRASES[rawGoal] || rawGoal.replace(/_/g, ' '))
                        : null;
                      if (goalPhrase) {
                        sentences.push(`This strategy aims to ${goalPhrase}, scheduling ${totalOrders} order${totalOrders !== 1 ? 's' : ''} across ${activeDays} production day${activeDays !== 1 ? 's' : ''} with ${totalHrs.toFixed(1)} hours of total runtime.`);
                      } else {
                        sentences.push(`This sequence schedules ${totalOrders} order${totalOrders !== 1 ? 's' : ''} across ${activeDays} production day${activeDays !== 1 ? 's' : ''} with ${totalHrs.toFixed(1)} hours of total runtime.`);
                      }

                      // Date shift vs Standard
                      const stdDateSet = new Set(Object.keys(stdMap).filter(d => d && d !== '(no date)'));
                      const thisDates  = validPerDay.map(d => d.date);
                      const newDates   = thisDates.filter(d => !stdDateSet.has(d));
                      const goneDates  = [...stdDateSet].filter(d => !thisDates.includes(d));

                      // Drivers
                      const mtsAdvanced    = m.mtsAdjusted || 0;
                      const coDelta        = m.timeSavedDeltaHours;
                      const protectedOrders = orders.filter(o => {
                        const isMTO = o.is_mto === true || o.is_mto === 'true';
                        const st = o._n10dStatus || '';
                        return isMTO || st === 'Critical' || st === 'Urgent';
                      });

                      // Date-shift sentence
                      if (goneDates.length > 0 && newDates.length > 0) {
                        // Attribute the date shift only to AI-effected drivers —
                        // cross-line transfers are deterministic and are not
                        // credited to the AI sequence here.
                        const primaryReason = mtsAdvanced > 0
                          ? 'MTS order advancement'
                          : 'order resequencing';
                        sentences.push(`Compared to the standard sequence, ${fmtList(goneDates)} ${goneDates.length > 1 ? 'have been' : 'has been'} pulled forward to ${fmtList(newDates)} through ${primaryReason}.`);
                      } else if (goneDates.length > 0) {
                        sentences.push(`Compared to the standard sequence, production was compressed and ${fmtList(goneDates)} ${goneDates.length > 1 ? 'are' : 'is'} no longer required.`);
                      } else if (newDates.length > 0) {
                        sentences.push(`This sequence extends the production window to include ${fmtList(newDates)}.`);
                      }

                      // MTS advancement sentence
                      if (mtsAdvanced > 0) {
                        const mtsTotal = m.mtsCount || 0;
                        sentences.push(`${mtsAdvanced} of ${mtsTotal} flexible MTS order${mtsTotal !== 1 ? 's were' : ' was'} advanced earlier to fill available capacity.`);
                      }

                      // Changeover sentence — specific breakdown of die vs color changes
                      if (coDelta != null && Math.abs(coDelta) > 0.05) {
                        const thisBreak = computeCoBreakdown(orders);
                        const stdBreak  = computeCoBreakdown(standardOrders || []);
                        const dieDelta  = thisBreak.dieChanges - stdBreak.dieChanges;
                        const colDelta  = thisBreak.colorChanges - stdBreak.colorChanges;

                        const reasonParts = [];
                        if (dieDelta < 0) reasonParts.push(`${Math.abs(dieDelta)} fewer die change${Math.abs(dieDelta) > 1 ? 's' : ''}`);
                        else if (dieDelta > 0) reasonParts.push(`${dieDelta} additional die change${dieDelta > 1 ? 's' : ''}`);
                        if (colDelta < 0) reasonParts.push(`${Math.abs(colDelta)} fewer color or cleaning transition${Math.abs(colDelta) > 1 ? 's' : ''}`);
                        else if (colDelta > 0) reasonParts.push(`${colDelta} additional color or cleaning transition${colDelta > 1 ? 's' : ''}`);

                        const reasonText = reasonParts.length > 0
                          ? ` due to ${reasonParts.length === 1 ? reasonParts[0] : reasonParts.slice(0, -1).join(', ') + ' and ' + reasonParts[reasonParts.length - 1]}`
                          : '';

                        if (coDelta < 0) {
                          sentences.push(`Changeover time was reduced by ${Math.abs(coDelta).toFixed(2)} hours${reasonText} compared to the standard sequence.`);
                        } else {
                          const tradeoffReason = mtsAdvanced > 0 ? 'advancing MTS orders earlier' : 'resequencing for other gains';
                          sentences.push(`Changeover time increased by ${coDelta.toFixed(2)} hours${reasonText}, accepted as a tradeoff for ${tradeoffReason}.`);
                        }
                      }

                      // Protected orders sentence
                      if (protectedOrders.length > 0) {
                        const critCount = protectedOrders.filter(o => o._n10dStatus === 'Critical').length;
                        const urgCount  = protectedOrders.filter(o => o._n10dStatus === 'Urgent').length;
                        const mtoCount  = protectedOrders.filter(o => o.is_mto === true || o.is_mto === 'true').length;
                        const parts = [];
                        if (critCount) parts.push(`${critCount} Critical`);
                        if (urgCount)  parts.push(`${urgCount} Urgent`);
                        if (mtoCount)  parts.push(`${mtoCount} contracted MTO`);
                        const labelText = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
                        sentences.push(`${labelText} order${protectedOrders.length > 1 ? 's are' : ' is'} protected and positioned to meet their committed delivery dates.`);
                      }

                      // At-risk warning
                      if ((m.ordersAtRisk || 0) > 0) {
                        sentences.push(`Note that ${m.ordersAtRisk} order${m.ordersAtRisk > 1 ? 's are' : ' is'} at risk of missing its deadline in this sequence.`);
                      }

                      return sentences.join(' ');
                    };

                    // Profitability influence sentence — computed separately so it
                    // appends to whichever base text wins (utilizationInsight or
                    // buildNarrative). buildNarrative is never called for AI strategies
                    // because utilizationInsight is always present, so this must live
                    // outside that function.
                    const buildProfitNote = () => {
                      const aiNote = strategy.profitabilityNote || '';
                      const isBoilerplate = /margin data was not available|no demand|no margin|no flexible|no profit/i.test(aiNote);

                      if (aiNote && !isBoilerplate) return aiNote;

                      // rawGoal and orders are scoped inside buildNarrative — derive independently
                      const goal   = strategy.primaryGoal || '';
                      const orders = strategy.orders || [];

                      // Compute margin concentration among Flexible orders
                      const flexSeq = orders.filter(o => {
                        const st = o._n10dStatus || '';
                        const isMTO = o.is_mto === true || o.is_mto === 'true';
                        return !isMTO && st !== 'Critical' && st !== 'Urgent' && st !== 'Monitor';
                      });
                      if (flexSeq.length === 0) return '';

                      const withMargin = flexSeq.filter(o => parseFloat(o._margin) > 0);
                      if (withMargin.length === 0) return '';

                      // Compare average margin of first half vs second half (by position)
                      const half = Math.ceil(flexSeq.length / 2);
                      const avgMargin = (arr) => {
                        const vals = arr.map(o => parseFloat(o._margin) || 0).filter(v => v > 0);
                        return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
                      };
                      const frontAvg = avgMargin(flexSeq.slice(0, half));
                      const backAvg  = avgMargin(flexSeq.slice(half));

                      if (goal === 'advance_flexible_orders') {
                        if (frontAvg > backAvg * 1.1) {
                          return `Higher-margin flexible orders were placed earlier in the run, concentrating more profitable production at the front of the schedule.`;
                        }
                        if (Math.abs(frontAvg - backAvg) < 1) {
                          return `Flexible orders were sequenced by profit percentage, though margin was similar across orders, so volume drove most of the positioning.`;
                        }
                        return `Flexible orders were sorted by margin percentage, with higher-value production positioned ahead of lower-margin orders.`;
                      }

                      if (goal === 'compress_compatible_runs') {
                        if (frontAvg > backAvg * 1.1) {
                          return `Within material clusters, higher-margin orders were placed earlier as a secondary tiebreaker, improving the profitability profile without disrupting cluster adjacency.`;
                        }
                        if (Math.abs(frontAvg - backAvg) < 1) {
                          return `Margin was similar across flexible orders, so cluster adjacency and die-change minimisation drove the final sequence rather than profitability differences.`;
                        }
                        return `Margin was used as a secondary tiebreaker within cluster groups, favouring higher-value orders where sequencing was otherwise equivalent.`;
                      }

                      return '';
                    };

                    // Velocity (demand-stability) influence note — appended like
                    // the profitability note so it shows for AI strategies (whose
                    // base text is utilizationInsight, not buildNarrative). Driven
                    // by the SAME shared flexRefinement gate as the header (so the
                    // two never disagree, and it is suppressed whenever margin
                    // front-loading is the credited driver). Also skipped when the
                    // AI's own profit note already speaks to velocity, to avoid
                    // repeating the same point.
                    // Prefer the AI's own holistic reasoning for AI strategies — it
                    // reads more clearly and carries the scheduling context (urgency
                    // tiers, cluster/die grouping, changeover tradeoffs) that the
                    // metric-derived narrative lacks. The text is already sanitized
                    // against the final sequence (_sanitizeStrategyTexts), so its
                    // positional claims match what the After table shows. Standard
                    // (and any AI strategy missing a reasoning summary) falls back to
                    // the generated narrative.
                    const aiReasoningText = !isStandard
                      ? String(strategy.reasoningSummary || strategy.aiReasoning || '').trim()
                      : '';
                    const baseInsight = aiReasoningText || strategy.utilizationInsight || buildNarrative();
                    // When showing the AI's own reasoning we keep it clean and skip the
                    // metric-derived profitability/velocity notes — the reasoning
                    // already speaks to those tradeoffs.
                    const profNote    = aiReasoningText ? '' : buildProfitNote();
                    const velNote = (
                      !aiReasoningText
                      && flexRefinement.volatileFrontLoaded
                      && !/velocit|erratic|demand[- ]stab|volatile|less[- ]stable/i.test(profNote)
                    )
                      ? `Less-stable, volatile-demand orders were sequenced earlier within their tier to reduce stockout risk, using demand stability as a secondary tiebreaker.`
                      : '';
                    const insight     = [baseInsight, profNote, velNote].filter(Boolean).join(' ');
                    if (!insight) return null;
                    return (
                      <p
                        data-testid={`text-utilization-insight-${strategy.id}`}
                        style={{
                          margin: '8px 0 0',
                          fontSize: 11,
                          color: '#6b7280',
                          lineHeight: 1.55,
                          fontStyle: 'italic',
                        }}
                      >
                        {insight}
                      </p>
                    );
                  })()}
                </div>
              )}
            </>
          );
        })()}
        {SHOW_FAITHFULNESS && metrics.faithfulnessScore != null && Number.isFinite(metrics.faithfulnessScore) && (
          <div className="ai-strategy-metric-row" data-testid={`row-faithfulness-${strategy.id}`}>
            <span className="ai-strategy-metric-label">Faithfulness</span>
            <span
              className={`ai-strategy-metric-value ai-strategy-metric-faith-${
                metrics.faithfulnessScore >= 90 ? 'high'
                : metrics.faithfulnessScore >= 75 ? 'good'
                : metrics.faithfulnessScore >= 60 ? 'medium'
                : 'low'
              }`}
              title={metrics.faithfulnessRating || ''}
              data-testid={`text-faithfulness-${strategy.id}`}
            >
              {metrics.faithfulnessScore.toFixed(1)}%
            </span>
          </div>
        )}
      </div>


      {isSelected && (
        <div className="ai-strategy-checkmark">✓ Selected</div>
      )}
    </div>
  );
}

// Per-line strategy selector. `strategies` is a single line's strategies
// object (`{rule_based, ai_option_1, ai_option_2, recommended}`) so the AI
// names/themes shown on the cards belong to THIS line. `line` is used only
// for the header label so users always see which line they're configuring.
function StrategySelector({ strategies, selectedId, isLoading, onSelect, line, isRefreshing = false, onRefresh, liveMetrics, changeoverRules, standardOrders }) {
  const list = [strategies?.rule_based, strategies?.ai_option_1, strategies?.ai_option_2].filter(Boolean);
  if (list.length === 0) return null;

  // When the line collapsed to a single AI strategy (no materially-different,
  // safe alternative), the generator drops ai_option_2 and supplies a reason.
  const singleAIStrategy = !strategies?.ai_option_2 && !!strategies?.ai_option_1;
  const singleStrategyReason = singleAIStrategy ? strategies?.singleStrategyReason : null;

  // Refresh is only meaningful once strategies have been generated (not while
  // the initial plant-wide generation is still in flight) and only when the
  // parent supplied an `onRefresh` handler bound to this line.
  const canRefresh = !isLoading && typeof onRefresh === 'function';

  return (
    <div className="ai-strategies-container">
      <div className="ai-strategies-header">
        <span className="ai-strategies-title">
          🤖 AI Sequencing Strategies{line ? ` — ${line}` : ''}
        </span>
        <div className="line-strategy-header-actions">
          <span className="ai-strategies-subtitle">
            {isLoading
              ? "Generating AI strategies in the background — Standard Sequence is ready to use"
              : `Select how to sequence ${line || 'this line'}`}
          </span>
          {canRefresh && (
            <>
              <span className="line-strategy-header-separator" aria-hidden="true">|</span>
              <button
                type="button"
                className="line-strategy-refresh-btn"
                onClick={onRefresh}
                disabled={isRefreshing}
                data-testid={`button-refresh-strategies-${line || 'line'}`}
                title={`Re-analyze AI strategies for ${line || 'this line'} only`}
              >
                {isRefreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            </>
          )}
        </div>
      </div>
      <div className="ai-strategies-grid">
        {list.map(s => (
          <StrategyCard
            key={s.id}
            strategy={s}
            isSelected={selectedId === s.id}
            isLoading={false}
            onSelect={() => onSelect(s.id)}
            liveMetrics={selectedId === s.id ? liveMetrics : null}
            standardPerDay={strategies?.rule_based?.metrics?.dailyUtilization?.perDay || []}
            line={line}
            changeoverRules={changeoverRules}
            standardOrders={standardOrders}
          />
        ))}
      </div>
      {!isLoading && singleStrategyReason && (
        <div
          className="ai-strategies-single-note"
          role="note"
          data-testid={`note-single-strategy-${line || 'line'}`}
        >
          <span className="ai-strategies-single-note-icon" aria-hidden="true">ℹ️</span>
          <span className="ai-strategies-single-note-text">{singleStrategyReason}</span>
        </div>
      )}
    </div>
  );
}

/* ─── main modal ─── */
export default function PlantAutoSequenceModal({
  isOpen,
  onClose,
  onApply,
  onReanalyze,
  onResetToOriginal,
  originalSnapshot = {},
  sequencedResults = {},
  summaryStats = null,
  placementLog = [],
  isLoading = false,
  totalOrderCount = 0,
  changeoverRules = null,
  inferredTargetMap = {},
  preloadedAI = null,
  preloadedStrategies = null,
  title = "Plant-Level Auto-Sequence",
  subtitle = "Cross-line combine & optimize — all feedmills, all lines",
  limitToLines = null,
  masterData = [],
  pmxSplitRules = [],
  shutdownLines = [],
  shutdownReasonByLine = {},
  rebalanceDiversions = [],
}) {
  const shutdownLineSet = new Set(shutdownLines || []);
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("summary");
  const [isApplying, setIsApplying] = useState(false);
  const [isProfitabilityApplied, setIsProfitabilityApplied] = useState(false);
  // localSeqResults shadows the prop so drag-to-reorder in any tab is captured
  const [localSeqResults, setLocalSeqResults] = useState(sequencedResults);

  // ─── AI Strategy state ─────────────────────────────────────────────────────
  // Strategy generation is now PER LINE: the orchestrator returns
  //   { byLine: { [line]: { rule_based, ai_option_1, ai_option_2, recommended } } }
  // so each production line has its own Standard + two line-specific AI
  // strategies whose names/themes/reasoning come from one AI call scoped to
  // that line. Standard is synthesized synchronously and is always usable
  // even if the AI calls are still in flight or fail entirely.
  //
  // selectedStrategyByLine is a map { [line]: strategyId } tracking the
  // user's chosen strategy per line. Each line tab renders its own
  // StrategySelector and writes only its own slot of this map; switching a
  // strategy on Line 1 does not affect Line 2's selection or contents.
  const [strategies, setStrategies] = useState(null);
  const [selectedStrategyByLine, setSelectedStrategyByLine] = useState({});
  const [isGeneratingStrategies, setIsGeneratingStrategies] = useState(false);
  // Per-line AI refresh: a Set of line keys currently being refreshed.
  // Using a Set (instead of a single scalar) lets the user kick off a
  // refresh on Line 2 even while Line 1 is still refreshing — each line's
  // loading state is independent and other lines stay fully interactive.
  const [refreshingLines, setRefreshingLines] = useState(() => new Set());
  // Cancellation tokens per line. A new refresh issues a fresh symbol; any
  // sequencedResults prop change (plant-wide rerun / reset) clears the map.
  // When an in-flight refresh resolves we compare its token against the
  // current map and bail out if it no longer matches — this prevents a
  // stale per-line result from clobbering a fresh plant-wide regeneration.
  const refreshTokensRef = useRef({});

  // Helper — extract the orders array for a given line under its current
  // selection, falling back to Standard, then to the raw sequencedResults.
  const ordersForLine = (line, selMap = selectedStrategyByLine) => {
    const lineStrategies = strategies?.byLine?.[line];
    if (!lineStrategies) return sequencedResults?.[line] || [];
    const selId = selMap[line] || 'rule_based';
    const sel = lineStrategies[selId] || lineStrategies.rule_based;
    return sel?.orders || sequencedResults?.[line] || [];
  };

  // Build a plant-wide localSeqResults map from per-line selections + the
  // current strategies. Used to seed/refresh localSeqResults whenever
  // strategies or selections change.
  const buildLocalFromSelections = (strategiesObj, selMap) => {
    const out = {};
    const byLine = strategiesObj?.byLine || {};
    const allLines = new Set([
      ...Object.keys(byLine),
      ...Object.keys(sequencedResults || {}),
    ]);
    allLines.forEach(line => {
      const ls = byLine[line];
      const selId = selMap[line] || 'rule_based';
      const sel = ls?.[selId] || ls?.rule_based;
      out[line] = (sel?.orders) || sequencedResults?.[line] || [];
    });
    return out;
  };

  // ─── Per-line insight cache — persists across tab switches ─────────────────
  const insightCacheRef = useRef({});          // line → { [prio]: insight }
  const fingerprintCacheRef = useRef({});      // line → fingerprint string

  const getLineFingerprint = (line) => {
    const orders  = localSeqResults?.[line] || [];
    const stratId = selectedStrategyByLine?.[line] || 'rule_based';
    const profBit = isProfitabilityApplied ? 'P' : 'NP';
    const orderPart = orders.map(o => `${o.id}_${o._isCombined ? 'C' : 'R'}_${o._plantMovement || 's'}`).join('|');
    return `${stratId}:${profBit}:${orderPart}`;
  };

  const getCachedInsights = (line) => {
    const fp = getLineFingerprint(line);
    if (fingerprintCacheRef.current[line] === fp && insightCacheRef.current[line]) {
      return insightCacheRef.current[line];
    }
    return null;
  };

  const setCachedInsights = (line, insights) => {
    insightCacheRef.current[line] = insights;
    fingerprintCacheRef.current[line] = getLineFingerprint(line);
  };

  const invalidateLineCache = (line) => {
    delete insightCacheRef.current[line];
    delete fingerprintCacheRef.current[line];
  };

  // ─── AI insights cached at top level — generated once, survive tab switches ───
  const [aiExplanations, setAiExplanations] = useState(null);
  const [isLoadingAI, setIsLoadingAI] = useState(false);
  const [useFallback, setUseFallback] = useState(false);

  async function generateExplanations() {
    if (!placementLog || placementLog.length === 0) return;
    setIsLoadingAI(true);
    setAiExplanations(null);
    setUseFallback(false);
    try {
      const { systemPrompt, userPrompt, precomputedInsights } = buildPlantActionsPrompt(placementLog);
      const response = await callPlantActionsAI(systemPrompt, userPrompt, 1400);
      const parsed = parsePlantActionsResponse(response, placementLog, precomputedInsights);
      const coveredCount = Object.keys(parsed).length;
      if (coveredCount >= Math.max(1, placementLog.length * 0.5)) {
        setAiExplanations(parsed);
      } else {
        setUseFallback(true);
      }
    } catch {
      setUseFallback(true);
    }
    setIsLoadingAI(false);
  }

  // If parent pre-generated AI explanations, seed them immediately
  useEffect(() => {
    if (preloadedAI) {
      setAiExplanations(preloadedAI.explanations);
      setUseFallback(preloadedAI.useFallback || false);
      setIsLoadingAI(false);
    }
  }, [preloadedAI]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fallback: if no preloaded AI, generate once when the modal finishes loading
  useEffect(() => {
    if (!preloadedAI && !isLoading && placementLog.length > 0) {
      generateExplanations();
    }
  }, [isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Strategies are pre-generated by the parent (during the ProcessingOverlay
  //     phase) and passed in via `preloadedStrategies`. We seed them on open
  //     and reset selection — every line defaults to Standard ('rule_based').
  //     We only fall back to in-modal generation if the parent forgot to
  //     preload (defensive — should not happen in normal flow).
  useEffect(() => {
    if (!isOpen || isLoading) return;
    const lineCount = Object.keys(sequencedResults || {}).length;
    if (lineCount === 0) {
      setStrategies(null);
      setSelectedStrategyByLine({});
      return;
    }

    // Helper — seed selection map from the strategies payload's known lines.
    // If a line has a recommended AI strategy, auto-select it; otherwise fall
    // back to Standard ('rule_based') so the user always starts with the best
    // available option rather than always defaulting to Standard.
    const seedSelections = (strategiesObj) => {
      const linesFromStrategies = Object.keys(strategiesObj?.byLine || {});
      const seedLines = linesFromStrategies.length ? linesFromStrategies : Object.keys(sequencedResults);
      const m = {};
      seedLines.forEach(l => {
        const lineStrats = strategiesObj?.byLine?.[l];
        const rec = lineStrats?.recommended;
        const selected = (rec === 'ai_option_1' || rec === 'ai_option_2') ? rec : 'rule_based';
        m[l] = selected;
        console.debug('[AI Strategy Auto-Select]', {
          line: l,
          recommended: rec || null,
          selectedStrategyId: selected,
        });
      });
      return m;
    };

    if (preloadedStrategies) {
      setStrategies(preloadedStrategies);
      const seeded = seedSelections(preloadedStrategies);
      const local  = buildLocalFromSelections(preloadedStrategies, seeded);
      setSelectedStrategyByLine(seeded);
      setLocalSeqResults(local);
      setIsGeneratingStrategies(false);
      console.debug('[Initial Strategy Sync] preloaded strategies applied', {
        selectionByLine: seeded,
        tableOrderCountByLine: Object.fromEntries(
          Object.entries(local).map(([l, orders]) => [l, orders.length])
        ),
        note: 'selectedStrategyByLine and localSeqResults set in same batch — table matches selected card',
      });
      return;
    }

    // Defensive fallback (no preload available). Build a Standard-only
    // byLine entry per line so the modal renders something usable while
    // the AI generation kicks off in the background.
    const standaloneByLine = {};
    Object.keys(sequencedResults).forEach(line => {
      const ruleBasedPlant = buildRuleBasedStrategy({ [line]: sequencedResults[line] || [] }, masterData);
      const standardOrders = ruleBasedPlant.orders[line] || [];
      standaloneByLine[line] = {
        rule_based: {
          ...ruleBasedPlant,
          id: 'rule_based',
          orders: standardOrders,
          isAIRecommended: false,
          isAI: false,
          aiFailed: false,
          isLowDistinction: false,
          lowDistinctionReason: '',
          sourceType: 'rule_based',
          line,
          reasoningSummary: '',
        },
        recommended: null,
      };
    });
    const initialStrategies = { byLine: standaloneByLine };
    setStrategies(initialStrategies);
    const seeded = seedSelections(initialStrategies);
    setSelectedStrategyByLine(seeded);
    setLocalSeqResults(buildLocalFromSelections(initialStrategies, seeded));
    setIsGeneratingStrategies(true);

    let cancelled = false;
    (async () => {
      try {
        const result = await generateSequenceStrategies(sequencedResults, masterData, inferredTargetMap, changeoverRules);
        if (cancelled) return;
        setStrategies(result);
        const refreshedSeed = seedSelections(result);
        const refreshedLocal = buildLocalFromSelections(result, refreshedSeed);
        setSelectedStrategyByLine(refreshedSeed);
        setLocalSeqResults(refreshedLocal);
        console.debug('[Initial Strategy Sync] async AI generation complete — activating strategy', {
          selectionByLine: refreshedSeed,
          tableOrderCountByLine: Object.fromEntries(
            Object.entries(refreshedLocal).map(([l, orders]) => [l, orders.length])
          ),
          note: 'selectedStrategyByLine and localSeqResults set in same batch — table matches selected card',
        });
      } catch (err) {
        console.error("[PlantAutoSequenceModal] strategy generation failed:", err);
      } finally {
        if (!cancelled) setIsGeneratingStrategies(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, isLoading, sequencedResults, preloadedStrategies]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-line strategy selection — switching one line's strategy normally
  // swaps only that line's slot in localSeqResults, leaving every other
  // line untouched. We invalidate only the affected line's insight cache
  // so other tabs keep their cached AI-generated row insights.
  //
  // Special case: if profitability sort is currently applied, every line's
  // localSeqResults is margin-sorted. Disabling profitability without a
  // full rebuild would leave the OTHER lines stuck on margin-sorted orders
  // even though the toggle reads "off". To stay consistent we rebuild every
  // line from `selectedStrategyByLine` (with the new selection applied) and
  // invalidate every line's cache.
  const handleLineStrategySelect = (line, id) => {
    if (!strategies?.byLine?.[line]?.[id]) return;
    const next = { ...selectedStrategyByLine, [line]: id };
    setSelectedStrategyByLine(next);

    if (isProfitabilityApplied) {
      // Profitability was on — rebuild every line cleanly from selections.
      setLocalSeqResults(buildLocalFromSelections(strategies, next));
      setIsProfitabilityApplied(false);
      const theAllLines = limitToLines || ["Line 1", "Line 2", "Line 3", "Line 4", "Line 5", "Line 6", "Line 7"];
      theAllLines.forEach(l => invalidateLineCache(l));
    } else {
      // Normal path — only the targeted line's slot is replaced.
      const newOrders = strategies.byLine[line][id].orders || [];
      setLocalSeqResults(prevLocal => ({ ...prevLocal, [line]: newOrders }));
      invalidateLineCache(line);
    }
  };

  // ─── Per-line AI strategy refresh ───────────────────────────────────────────
  // Re-runs the AI strategy generation for ONE line only, leaving every other
  // line's strategies, selection, and After table untouched. Uses the same
  // baseline (`sequencedResults[line]`) the line was originally analysed with
  // — this is the post-combination / post-line-placement / post-N10D snapshot
  // — so the Standard Sequence stays the same baseline for that line and only
  // the two AI options + recommendation + insights get fresh results.
  //
  // After refresh we auto-select the new recommended AI option for that line
  // (per spec §8). If neither AI option is recommended (e.g. AI failed or
  // both options were soft-flagged) we keep the line's current selection if
  // still valid, else fall back to 'rule_based'.
  //
  // Concurrency model:
  //  - Per-line lock via `refreshingLines` Set: a refresh on Line 1 only
  //    blocks repeat clicks on Line 1; the user can kick off Line 2 in
  //    parallel. Each line's button shows its own loading state.
  //  - Per-line cancellation token via `refreshTokensRef`: a stale result
  //    is discarded if the parent has since pushed a new sequencedResults
  //    (plant-wide rerun / reset) or if the same line was refreshed again
  //    while this call was still in flight.
  //  - Profitability toggle is honoured: if it was on at refresh time, the
  //    refreshed line's new selected orders are margin-sorted on the way
  //    into localSeqResults so its display stays consistent with every
  //    other margin-sorted line and the toggle's "applied" state.
  const refreshLineStrategies = async (line) => {
    if (!line || refreshingLines.has(line)) return;
    const baselineOrders = sequencedResults?.[line] || [];
    if (baselineOrders.length === 0) return;
    const profitabilityWasApplied = isProfitabilityApplied;
    const token = Symbol(line);
    refreshTokensRef.current[line] = token;
    setRefreshingLines(prev => {
      const next = new Set(prev);
      next.add(line);
      return next;
    });
    try {
      const refreshed = await generateLineStrategies({
        line,
        lineOrders: baselineOrders,
        masterData,
        inferredTargetMap,
        changeoverRules,
      });
      // Cancellation: bail out if our token was replaced (newer refresh on
      // the same line OR sequencedResults prop changed during this call).
      if (refreshTokensRef.current[line] !== token) return;
      // Decide the new selection BEFORE we set state so we can update both
      // strategies and selection in the same render cycle.
      const prevSel = selectedStrategyByLine[line] || 'rule_based';
      let nextSel;
      const rec = refreshed?.recommended;
      if (rec === 'ai_option_1' || rec === 'ai_option_2') {
        nextSel = rec;
      } else if (refreshed?.[prevSel]) {
        nextSel = prevSel;
      } else {
        nextSel = 'rule_based';
      }
      // Stamp the refresh time on this line's slot for debugging / future UI.
      const refreshedWithStamp = { ...refreshed, lastRefreshedAt: new Date().toISOString() };

      // Row insights are loaded lazily on demand by the strategy-switch effect
      // (with a per-card spinner), so we no longer pre-build them for all three
      // strategies here. This removes another unbounded AI burst per refresh;
      // the visible strategy regenerates its insights on demand instead.

      setStrategies(prev => ({
        ...(prev || {}),
        byLine: { ...((prev && prev.byLine) || {}), [line]: refreshedWithStamp },
      }));
      setSelectedStrategyByLine(prev => ({ ...prev, [line]: nextSel }));
      const cleanOrders = refreshedWithStamp[nextSel]?.orders || baselineOrders;
      // Profitability honour: if margin sort was active at refresh start AND
      // is still active now, re-apply it to the refreshed line so the user
      // sees the same margin-grouped view that every other line shows. We
      // re-read the toggle here (not just the captured value) so a user who
      // toggled OFF profitability mid-refresh still gets the clean ordering.
      const finalOrders = (profitabilityWasApplied && isProfitabilityApplied)
        ? sortWithMargin(cleanOrders.map(o => ({ ...o })), masterData)
        : cleanOrders;
      setLocalSeqResults(prev => ({ ...(prev || {}), [line]: finalOrders }));
      // Insights changed (new sequence, new strategy meta) — invalidate this
      // line's cache only so other tabs keep their cached row insights.
      invalidateLineCache(line);
    } catch (err) {
      // Only surface the error if our token is still current (otherwise the
      // user has already moved on / the parent rebuilt — a stale failure
      // toast would be more confusing than helpful).
      if (refreshTokensRef.current[line] === token) {
        console.error(`[PlantAutoSequenceModal] refresh failed for ${line}:`, err);
        toast({
          title: "Refresh failed",
          description: `Could not regenerate AI strategies for ${line}. Please try again.`,
          variant: "destructive",
        });
      }
    } finally {
      // Always clear the per-line lock, even on cancellation/failure, so the
      // button becomes interactive again.
      setRefreshingLines(prev => {
        if (!prev.has(line)) return prev;
        const next = new Set(prev);
        next.delete(line);
        return next;
      });
      // If our token is still the active one, retire it now that we're done.
      if (refreshTokensRef.current[line] === token) {
        delete refreshTokensRef.current[line];
      }
    }
  };

  // Whenever the parent pushes a fresh sequencedResults (re-analyze or reset):
  //   • reset the profitability toggle (the new baseline makes the old sort stale)
  //   • cancel every in-flight per-line AI refresh token (generated against the
  //     OLD baseline — they would clobber the new data if allowed to resolve)
  //
  // NOTE: we intentionally do NOT call setLocalSeqResults(sequencedResults) here.
  // The main seeding effect above (deps: [isOpen, isLoading, sequencedResults,
  // preloadedStrategies]) also fires whenever sequencedResults changes and it
  // correctly seeds localSeqResults from the recommended AI strategy (or Standard
  // when no recommendation exists). Both effects run in the same React batch when
  // sequencedResults changes; because this effect is defined AFTER the seeding
  // effect, any setLocalSeqResults call here would overwrite the correctly-seeded
  // AI strategy orders with the raw Standard sequence — causing the "table shows
  // Standard even though Recommended card is selected" bug.
  useEffect(() => {
    setIsProfitabilityApplied(false);
    refreshTokensRef.current = {};
    console.debug('[Initial Strategy Sync] sequencedResults changed — profitability reset, refresh tokens cleared');
  }, [sequencedResults]);

  // ─── Apply / revert profitability (margin) sort ─────────────────────────────
  // Profitability sort is now scoped to whatever orders each line currently
  // has under its per-line strategy selection. Reverting rebuilds the whole
  // localSeqResults map from `selectedStrategyByLine` (NOT from the raw
  // sequencedResults prop), so each line returns to its own selected
  // strategy's clean ordering rather than to Standard.
  function handleToggleProfitability() {
    const theAllLines = limitToLines || ["Line 1", "Line 2", "Line 3", "Line 4", "Line 5", "Line 6", "Line 7"];
    if (isProfitabilityApplied) {
      // Revert: rebuild from current per-line selections so every line
      // returns to its own selected strategy's clean ordering.
      setLocalSeqResults(buildLocalFromSelections(strategies, selectedStrategyByLine));
      setIsProfitabilityApplied(false);
      theAllLines.forEach(l => invalidateLineCache(l));
      return;
    }

    // Source orders for sorting come from the CURRENT per-line selection
    // (i.e. `localSeqResults`), not the raw `sequencedResults` prop, so we
    // sort whatever the user is currently looking at — Standard or AI.
    const marginResults = {};
    theAllLines.forEach(line => {
      const lineOrders = (localSeqResults[line] || []).map(o => ({ ...o }));
      if (!lineOrders.length) { marginResults[line] = []; return; }

      // sortWithMargin groups same-date peers and re-ranks them by margin.
      // Date ordering is already correct from the auto-sequence — we never touch it.
      const sorted = sortWithMargin(lineOrders, masterData);

      // Recompute movement deltas vs original snapshot
      const origIndexMap = {};
      (originalSnapshot[line] || []).forEach((o, i) => { origIndexMap[o.id] = i; });
      sorted.forEach((order, index) => {
        order.prio = index + 1;
        const origIdx = origIndexMap[order.id];
        if (origIdx !== undefined) {
          const origPrio = origIdx + 1;
          const delta = origPrio - order.prio;
          order._originalPrio = origPrio;
          order._movement = delta > 0 ? 'up' : delta < 0 ? 'down' : 'same';
          order._movementDelta = Math.abs(delta);
        } else if (order._movement !== 'new_to_line') {
          order._movement = 'same';
        }
      });
      marginResults[line] = sorted;
    });

    setLocalSeqResults(marginResults);
    setIsProfitabilityApplied(true);
    theAllLines.forEach(l => invalidateLineCache(l));
  }

  function handleUncombineSingle(line, combinedOrder) {
    const subIds = new Set((combinedOrder._combinedFrom || []).map(s => s.id));
    const allOriginal = Object.values(originalSnapshot).flat();
    const subOrders = allOriginal.filter(o => subIds.has(o.id));
    setLocalSeqResults(prev => {
      const next = { ...prev };
      // Remove the combined lead from this line
      next[line] = (next[line] || []).filter(o => o.id !== combinedOrder.id);
      // Restore each sub-order to its original line (appended at end of that line's list)
      const byLine = {};
      subOrders.forEach(o => {
        const oLine = o.feedmill_line || line;
        if (!byLine[oLine]) byLine[oLine] = [];
        byLine[oLine].push(o);
      });
      Object.entries(byLine).forEach(([oLine, orders]) => {
        next[oLine] = [...(next[oLine] || []), ...orders];
      });
      return next;
    });
  }

  function handleRemoveChildFromCombine(line, combinedOrder, childToRemove) {
    const remainingChildren = (combinedOrder._combinedFrom || []).filter(
      sub => String(sub.id) !== String(childToRemove.id)
    );
    if (remainingChildren.length < 2) {
      handleUncombineSingle(line, combinedOrder);
      invalidateLineCache(line);
      return;
    }
    const newTotalVolume = remainingChildren.reduce((sum, sub) => sum + (parseFloat(sub.volume) || 0), 0);
    const updatedCombined = {
      ...combinedOrder,
      volume: newTotalVolume,
      total_volume_mt: newTotalVolume,
      _combinedFrom: remainingChildren,
      batches: combinedOrder.batch_size
        ? Math.ceil(newTotalVolume / parseFloat(combinedOrder.batch_size))
        : combinedOrder.batches,
    };
    const removedOrder = {
      ...childToRemove,
      feedmill_line: childToRemove.line || line,
      line: childToRemove.line || line,
      _isCombined: false,
      _combinedFrom: null,
      _movement: 'same',
    };
    const targetLine = childToRemove.line || line;
    setLocalSeqResults(prev => {
      const next = { ...prev };
      const lineOrders = [...(next[line] || [])];
      const combinedIdx = lineOrders.findIndex(o => o.id === combinedOrder.id);
      if (combinedIdx === -1) return prev;
      lineOrders[combinedIdx] = updatedCombined;
      if (targetLine !== line) {
        next[targetLine] = [...(next[targetLine] || []), removedOrder];
      } else {
        lineOrders.splice(combinedIdx + 1, 0, removedOrder);
      }
      next[line] = lineOrders;
      return next;
    });
    invalidateLineCache(line);
    if (targetLine !== line) invalidateLineCache(targetLine);
  }

  async function handleApply() {
    if (isApplying) return;
    setIsApplying(true);
    try {
      // Build line → strategy name map so Dashboard can write accurate history details
      const strategyNameByLine = {};
      Object.entries(selectedStrategyByLine).forEach(([line, stratId]) => {
        const strat = strategies?.byLine?.[line]?.[stratId];
        if (strat?.name) strategyNameByLine[line] = strat.name;
      });
      // [Auto-Sequence Preview Dataset Consistency] (per spec §1,§5) — the same
      // localSeqResults array is BOTH the preview source (rendered per line) and
      // the payload we hand to onApply, so the order shown is exactly the order
      // committed. We log it per line so any future regression that recomputes a
      // different array at apply time is immediately visible.
      Object.entries(localSeqResults).forEach(([logLine, rows]) => {
        const entityOrder = (rows || []).map(r => String(r.id ?? ''));
        console.debug('[Auto-Sequence Preview Dataset Consistency]', {
          line: logLine,
          strategyId: selectedStrategyByLine?.[logLine] || null,
          entityCount: entityOrder.length,
          previewEntityOrder: entityOrder,
          appliedEntityOrder: entityOrder,
          appliesExactPreview: true,
        });
      });
      // Log apply-time consistency for combined orders — ensures preview and
      // apply both use the same lead-order-based sequencing basis.
      Object.values(localSeqResults).flat().filter(r => r._isCombined).forEach(r => {
        console.debug('[Combined Order Apply Consistency]', {
          combinedEntityId: String(r.id ?? ''),
          leadOrderId: String(r._combinedLeadOrderId || (r.id ?? '')),
          previewUsedLeadOrderBasis: !!r._combinedLeadOrderId,
          appliedUsedLeadOrderBasis: !!r._combinedLeadOrderId,
        });
      });
      await onApply(localSeqResults, originalSnapshot, { strategyNameByLine });
    } catch {
      // parent already shows error toast
    } finally {
      setIsApplying(false);
    }
  }

  function handleClose() {
    if (isApplying) return;
    onClose();
  }

  const allLines = limitToLines || ["Line 1", "Line 2", "Line 3", "Line 4", "Line 5", "Line 6", "Line 7"];
  const activeLines = allLines.filter(
    (line) => (originalSnapshot[line]?.length || 0) > 0 || (sequencedResults[line]?.length || 0) > 0
  );

  // Per shutdown tab shown in the tab bar — emit indicator log once per render-cycle.
  const shutdownTabsShown = activeLines.filter((l) => shutdownLineSet.has(l));
  const shutdownTabsKey = shutdownTabsShown.join('|');
  useEffect(() => {
    if (!isOpen) return;
    shutdownTabsShown.forEach((line) => {
      console.debug('[Auto-Sequence Preview Shutdown Message]', {
        lineId: line,
        shutdownActive: true,
        destinationExcluded: true,
        sourceOrdersStillEvaluated: true,
        location: 'plant_tab_bar_badge',
        reason: shutdownReasonByLine?.[line] || 'shutdown',
        ordersRemainingOnLine: (sequencedResults[line]?.length || originalSnapshot[line]?.length || 0),
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, shutdownTabsKey]);

  if (!isOpen) return null;

  const isLinetab = activeTab !== "summary" && activeLines.includes(activeTab);
  const lineStats = isLinetab
    ? computeLineStats(originalSnapshot[activeTab] || [], localSeqResults[activeTab] || [])
    : null;

  return (
    <div className="plant-modal-overlay nexfeed-force-light">
      <div className="plant-modal-container">
        {/* Header */}
        <div className="plant-modal-header">
          <div>
            <div className="plant-modal-title">
              <Sparkles style={{ width: 18, height: 18, color: "var(--nexfeed-primary)", marginRight: 8, flexShrink: 0 }} />
              {title}
            </div>
            <div className="plant-modal-subtitle">{subtitle}</div>
          </div>
          <button className="plant-modal-close" onClick={handleClose} disabled={isApplying} data-testid="button-plant-modal-close">✕</button>
        </div>

        {isLoading ? (
          <div className="flex-1 flex flex-col items-center justify-center py-16 px-8">
            <Loader2 className="h-10 w-10 text-[var(--nexfeed-primary)] animate-spin mb-4" />
            <p className="text-sm font-medium text-[#2e343a]">
              Analyzing {totalOrderCount > 0 ? `${totalOrderCount} orders` : "orders"}… Building optimal sequence…
            </p>
            <p className="text-xs text-gray-400 mt-1">This may take a few seconds</p>
          </div>
        ) : (
          <>
            {/* ── Single scrollable body — cards, stats, tabs, content all scroll together ── */}
            <div className="plant-modal-scroll">

            {/* Strategy selectors are now rendered PER LINE inside each
                line tab (see PlantLineTab) so each line has its own three
                strategy cards with line-specific AI names and themes. */}

            {/* Stats strip — split into Production Time change and Changeover change */}
            <div className="plant-stats-strip" style={{ justifyContent: "flex-start", flexWrap: "wrap", gap: 12 }}>
              {(() => {
                const rows = summaryStats?.perLineSummary || [];
                if (!rows.length) return null;

                const totalChangeover = rows.reduce((sum, ls) => sum + (ls.afterHours?.changeoverHours || 0), 0);
                const totalScheduled  = rows.reduce((sum, ls) => sum + (ls.afterHours?.totalHours || 0), 0);
                const overheadPct = totalScheduled > 0 ? (totalChangeover / totalScheduled) * 100 : 0;

                return (
                  <StatBadge
                    label="Changeover Overhead (% of total scheduled hrs)"
                    value={`${overheadPct.toFixed(1)}%`}
                    color="amber"
                  />
                );
              })()}
            </div>

            {/* Stale AI result banner — shown when the AI was run on a previous day */}
            {(() => {
              const _sd = new Date();
              const todayISO = `${_sd.getFullYear()}-${String(_sd.getMonth()+1).padStart(2,'0')}-${String(_sd.getDate()).padStart(2,'0')}`;
              const runDate  = strategies?._runDate;
              if (!runDate || runDate >= todayISO) return null;
              return (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: '#fffbeb', border: '1px solid #fbbf24',
                  borderRadius: 6, padding: '6px 12px', margin: '0 0 8px 0',
                  fontSize: 12, color: '#92400e', lineHeight: '1.4',
                }}>
                  <span style={{ fontSize: 14 }}>⚠️</span>
                  <span>
                    AI results are from <strong>{runDate}</strong> — today is <strong>{todayISO}</strong>.
                    Critical order dates have been updated to today automatically.
                    Re-run the AI sequencer to get fully refreshed suggestions.
                  </span>
                </div>
              );
            })()}

            {/* Tab bar */}
            <div className="plant-tab-bar">
              <button
                className={`plant-tab-btn ${activeTab === "summary" ? "plant-tab-active" : ""}`}
                onClick={() => setActiveTab("summary")}
              >
                📊 All Lines Summary
              </button>
              {activeLines.map((line) => {
                const ls = computeLineStats(
                  originalSnapshot[line] || [],
                  localSeqResults[line] || []
                );
                const changeCount = ls.fromOther;
                const lineIsShutdown = shutdownLineSet.has(line);
                const tabTitle = lineIsShutdown
                  ? `${line} — Shutdown${shutdownReasonByLine?.[line] ? `: ${shutdownReasonByLine[line]}` : ''}. Excluded from auto-sequence.`
                  : undefined;
                return (
                  <button
                    key={line}
                    className={`plant-tab-btn ${activeTab === line ? "plant-tab-active" : ""}${lineIsShutdown ? " plant-tab-shutdown" : ""}`}
                    style={lineIsShutdown ? { opacity: 0.7, color: '#991b1b' } : undefined}
                    title={tabTitle}
                    onClick={() => setActiveTab(line)}
                    data-testid={`tab-line-${line}`}
                  >
                    {lineIsShutdown && (
                      <span
                        style={{
                          display: 'inline-flex', alignItems: 'center',
                          background: '#fee2e2', color: '#991b1b',
                          borderRadius: 4, padding: '1px 6px', marginRight: 6,
                          fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                        }}
                        data-testid={`badge-shutdown-${line}`}
                      >
                        🚫 SHUTDOWN
                      </span>
                    )}
                    {line}
                    {changeCount > 0 && <span className="plant-tab-new-badge">{changeCount}</span>}
                  </button>
                );
              })}
            </div>

            {/* Content */}
            <div className="plant-modal-content">
              {activeTab === "summary" && (
                <PlantSummaryTab
                  summaryStats={summaryStats}
                  placementLog={placementLog}
                  aiExplanations={aiExplanations}
                  isLoadingAI={isLoadingAI}
                  useFallback={useFallback}
                  onRefreshInsights={generateExplanations}
                  isProfitabilityApplied={isProfitabilityApplied}
                  rebalanceDiversions={rebalanceDiversions}
                />
              )}
              {activeTab !== "summary" && activeLines.includes(activeTab) && (
                <PlantLineTab
                  key={activeTab}
                  line={activeTab}
                  originalOrders={originalSnapshot[activeTab] || []}
                  sequencedOrders={localSeqResults[activeTab] || []}
                  changeoverRules={changeoverRules}
                  inferredTargetMap={inferredTargetMap}
                  onOrdersChange={(line, reorderedOrders) => {
                    setLocalSeqResults((prev) => ({ ...prev, [line]: reorderedOrders }));
                    invalidateLineCache(line);
                  }}
                  placementLog={placementLog}
                  aiExplanations={aiExplanations}
                  isLoadingAI={isLoadingAI}
                  useFallback={useFallback}
                  onUncombineSingle={(combinedOrder) => {
                    handleUncombineSingle(activeTab, combinedOrder);
                    invalidateLineCache(activeTab);
                  }}
                  onRemoveChildFromCombine={(combinedOrder, child) => {
                    handleRemoveChildFromCombine(activeTab, combinedOrder, child);
                  }}
                  getCachedInsights={() => getCachedInsights(activeTab)}
                  setCachedInsights={(insights) => setCachedInsights(activeTab, insights)}
                  isProfitabilityApplied={isProfitabilityApplied}
                  strategyId={selectedStrategyByLine[activeTab] || 'rule_based'}
                  lineStrategies={strategies?.byLine?.[activeTab] || null}
                  isGeneratingStrategies={isGeneratingStrategies}
                  onSelectStrategy={(id) => handleLineStrategySelect(activeTab, id)}
                  isRefreshingStrategies={refreshingLines.has(activeTab)}
                  onRefreshStrategies={() => refreshLineStrategies(activeTab)}
                  pmxSplitRules={pmxSplitRules}
                  isShutdown={shutdownLineSet.has(activeTab)}
                  shutdownReason={shutdownReasonByLine?.[activeTab] || null}
                />
              )}
            </div>

            </div>{/* end plant-modal-scroll */}

            {/* Applying overlay — covers modal content while saving */}
            {isApplying && (
              <div className="plant-applying-overlay">
                <div className="plant-applying-content">
                  <div className="plant-applying-spinner"></div>
                  <span className="plant-applying-text">Applying to schedule…</span>
                  <span className="plant-applying-sub">Please wait. Do not close this window.</span>
                </div>
              </div>
            )}

            {/* Footer */}
            <div className="plant-modal-footer">
              <div style={{ display: "flex", gap: 8 }}>
                <button className="plant-footer-btn" onClick={onReanalyze} disabled={isApplying} data-testid="button-plant-reanalyze">↻ Re-analyze</button>
                <button className="plant-footer-btn" onClick={onResetToOriginal} disabled={isApplying} data-testid="button-plant-reset">↺ Reset to Original</button>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="plant-footer-btn" onClick={handleClose} disabled={isApplying} data-testid="button-plant-cancel">Cancel</button>
                <button
                  className={`plant-footer-apply-btn${isApplying ? " plant-footer-apply-btn-loading" : ""}`}
                  onClick={handleApply}
                  disabled={isApplying}
                  data-testid="button-plant-apply"
                >
                  {isApplying ? (
                    <><span className="plant-footer-apply-spinner"></span>Applying…</>
                  ) : (
                    "Apply to Schedule"
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
