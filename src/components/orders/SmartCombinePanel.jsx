import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  X,
  RefreshCw,
  Merge,
  AlertTriangle,
  Plus,
  CheckCircle2,
  ClipboardList,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { fmtVolume, fmtHours } from "../utils/formatters";
import { generateCombineSchedulingImpact } from "@/services/azureAI";

const FEEDMILL_LABELS = {
  FM1: "Feedmill 1",
  FM2: "Feedmill 2",
  FM3: "Feedmill 3",
  PMX: "Powermix",
};

const LINE_MAP = {
  FM1: ["Line 1", "Line 2"],
  FM2: ["Line 3", "Line 4"],
  FM3: ["Line 6", "Line 7"],
  PMX: ["Line 5"],
};

function getEffVolume(order) {
  if (order.volume_override != null && order.volume_override !== "") {
    const ov = parseFloat(order.volume_override);
    if (!isNaN(ov)) return ov;
  }
  const orig = parseFloat(order.total_volume_mt) || 0;
  const bs = parseFloat(order.batch_size) || 4;
  if (bs <= 0) return orig;
  return Math.ceil(orig / bs) * bs;
}

// Combination basis volume per order — user override wins; for all other cases
// return raw so batch ceiling is applied only to the FINAL combined sum.
function getCombineBasisVolume(order) {
  if (order.volume_override != null && order.volume_override !== "") {
    const ov = parseFloat(order.volume_override);
    if (!isNaN(ov) && ov > 0) return ov;
  }
  return parseFloat(order.total_volume_mt) || 0;
}

function calcProductionHoursLocal(volume, runRate) {
  if (!runRate || runRate <= 0 || !volume || volume <= 0) return null;
  return parseFloat((volume / runRate).toFixed(2));
}

function calcCompletionDateLocal(
  startDate,
  startTime,
  productionHours,
  changeoverTime,
) {
  if (!startDate) return null;
  try {
    const d = new Date(startDate);
    if (isNaN(d.getTime())) return null;
    let hours = 0,
      minutes = 0;
    const tp = String(startTime || "00:00").match(/(\d+):(\d+)\s*(am|pm)?/i);
    if (tp) {
      hours = parseInt(tp[1]);
      minutes = parseInt(tp[2]);
      if (tp[3]?.toLowerCase() === "pm" && hours < 12) hours += 12;
      if (tp[3]?.toLowerCase() === "am" && hours === 12) hours = 0;
    }
    d.setHours(hours, minutes, 0, 0);
    const ph = productionHours != null ? parseFloat(productionHours) : 0;
    const co = changeoverTime != null ? parseFloat(changeoverTime) : 0.17;
    d.setTime(d.getTime() + (ph + co) * 3600000);
    return d;
  } catch {
    return null;
  }
}

function formatCompletionDateLocal(d) {
  if (!d || isNaN(d.getTime())) return "";
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dy = String(d.getDate()).padStart(2, "0");
  const yr = d.getFullYear();
  let h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${mo}/${dy}/${yr} - ${String(h).padStart(2, "0")}:${min} ${ampm}`;
}

function formatProdHours(ph) {
  const hours = parseFloat(ph);
  if (!hours || isNaN(hours)) return "-";
  if (hours < 1) {
    const mins = Math.round(hours * 60);
    return `${mins} min`;
  }
  const wholeHours = Math.floor(hours);
  const mins = Math.round((hours - wholeHours) * 60);
  if (mins === 0) return `${wholeHours} ${wholeHours === 1 ? "hr" : "hrs"}`;
  return `${wholeHours} ${wholeHours === 1 ? "hr" : "hrs"} ${mins} min`;
}

function formatTimeShift(hours) {
  const absHours = Math.abs(hours);
  if (absHours < 0.01) return '0 min';
  if (absHours >= 24) {
    const days = Math.floor(absHours / 24);
    const remainingHours = Math.floor(absHours % 24);
    const remainingMins = Math.round((absHours % 1) * 60);
    if (remainingHours > 0 && remainingMins > 0) return `${days} day${days > 1 ? 's' : ''} ${remainingHours} hr${remainingHours > 1 ? 's' : ''} ${remainingMins} min`;
    if (remainingHours > 0) return `${days} day${days > 1 ? 's' : ''} ${remainingHours} hr${remainingHours > 1 ? 's' : ''}`;
    if (remainingMins > 0) return `${days} day${days > 1 ? 's' : ''} ${remainingMins} min`;
    return `${days} day${days > 1 ? 's' : ''}`;
  }
  const wholeHours = Math.floor(absHours);
  const mins = Math.round((absHours - wholeHours) * 60);
  if (wholeHours === 0) return `${mins} min`;
  if (mins === 0) return `${wholeHours} hr${wholeHours > 1 ? 's' : ''}`;
  return `${wholeHours} hr${wholeHours > 1 ? 's' : ''} ${mins} min`;
}

function parseCompletionStr(str) {
  if (!str) return null;
  const m = String(str).match(
    /^(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i,
  );
  if (!m) return null;
  let h = parseInt(m[4]);
  if (m[6].toUpperCase() === "PM" && h < 12) h += 12;
  if (m[6].toUpperCase() === "AM" && h === 12) h = 0;
  return new Date(
    parseInt(m[3]),
    parseInt(m[1]) - 1,
    parseInt(m[2]),
    h,
    parseInt(m[5]),
    0,
    0,
  );
}

function formatCompletionDateOnly(d) {
  if (!d) return "-";
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatCompletionTimeOnly(d) {
  if (!d) return "";
  let h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${String(h).padStart(2, "0")}:${min} ${ampm}`;
}

function formatLongDate(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return format(d, "MMMM dd, yyyy");
  } catch {
    return dateStr;
  }
}

function formatLongDateTime(d) {
  if (!d || isNaN(d.getTime())) return "";
  try {
    let h = d.getHours();
    const min = String(d.getMinutes()).padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${format(d, "MMMM dd, yyyy")} ${String(h).padStart(2, "0")}:${min} ${ampm}`;
  } catch {
    return "";
  }
}

// ─── Pure strategy helpers ────────────────────────────────────────────────────

function simulateConflictsForOrders(group, allLineOrders) {
  if (!group || group.length < 2) return [];
  const sortedLine = [...allLineOrders].sort(
    (a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity),
  );
  const groupIds = new Set(group.map((o) => o.id));
  const combinedBasisVol = group.reduce((s, o) => s + getCombineBasisVolume(o), 0);
  const batchSizeSim = parseFloat(group[0]?.batch_size) || 4;
  const combinedVolume = batchSizeSim > 0 ? Math.ceil(combinedBasisVol / batchSizeSim) * batchSizeSim : Number(combinedBasisVol.toFixed(2));
  const runRate = parseFloat(group[0]?.run_rate) || 0;
  const prodHours = calcProductionHoursLocal(combinedVolume, runRate);

  const earliestIdx = Math.min(
    ...group.map((o) => {
      const idx = sortedLine.findIndex((lo) => lo.id === o.id);
      return idx >= 0 ? idx : Infinity;
    }),
  );
  const insertIdx = earliestIdx < Infinity ? earliestIdx : sortedLine.length;

  const simulatedOrders = sortedLine.filter((o) => !groupIds.has(o.id));
  simulatedOrders.splice(insertIdx, 0, {
    ...group[0],
    total_volume_mt: combinedVolume,
    production_hours: prodHours,
    _isLead: true,
  });

  let prevCompletion = null;
  const conflicts = [];

  for (let i = 0; i < simulatedOrders.length; i++) {
    const o = { ...simulatedOrders[i] };
    if (i > 0 && prevCompletion) {
      o.start_date = `${prevCompletion.getFullYear()}-${String(prevCompletion.getMonth() + 1).padStart(2, "0")}-${String(prevCompletion.getDate()).padStart(2, "0")}`;
      o.start_time = `${String(prevCompletion.getHours()).padStart(2, "0")}:${String(prevCompletion.getMinutes()).padStart(2, "0")}`;
    }
    const ph = o._isLead
      ? prodHours
      : calcProductionHoursLocal(getEffVolume(o), parseFloat(o.run_rate) || 0);
    const co = parseFloat(o.changeover_time) ?? 0.17;
    const completionDate = calcCompletionDateLocal(
      o.start_date,
      o.start_time,
      ph,
      co,
    );
    prevCompletion = completionDate;

    if (!o._isLead && completionDate && !groupIds.has(o.id)) {
      const availStr = o.target_avail_date;
      if (availStr && !isNaN(Date.parse(availStr))) {
        const availDate = new Date(availStr);
        availDate.setHours(23, 59, 59, 999);
        if (completionDate > availDate) {
          conflicts.push({
            order: o,
            exceedHours: Math.round((completionDate - availDate) / 3600000),
          });
        }
      }
    }
  }
  return conflicts;
}

function buildGreedySafe(sortedGroup, allLineOrders) {
  const result = [sortedGroup[0]];
  for (let i = 1; i < sortedGroup.length; i++) {
    const candidate = [...result, sortedGroup[i]];
    if (simulateConflictsForOrders(candidate, allLineOrders).length === 0)
      result.push(sortedGroup[i]);
  }
  return result.length >= 2 ? result.map((o) => o.id) : null;
}

function findBestPair(sortedGroup) {
  if (sortedGroup.length < 2) return null;
  const dated = sortedGroup.filter(
    (o) => o.target_avail_date && !isNaN(Date.parse(o.target_avail_date)),
  );
  const pool = dated.length >= 2 ? dated : sortedGroup;
  let minGap = Infinity,
    bestPair = [pool[0], pool[1]];
  for (let i = 0; i < pool.length - 1; i++) {
    const gap =
      dated.length >= 2
        ? Math.abs(
            new Date(pool[i].target_avail_date) -
              new Date(pool[i + 1].target_avail_date),
          )
        : 0;
    if (gap < minGap) {
      minGap = gap;
      bestPair = [pool[i], pool[i + 1]];
    }
  }
  return bestPair;
}

function scoreStrategy(strategy, allGroupOrders, allLineOrders) {
  const active = allGroupOrders.filter((o) =>
    strategy.activeOrderIds.includes(o.id),
  );
  if (active.length < 2)
    return { stars: 1, hasConflict: false, conflictCount: 0 };
  const conflicts = simulateConflictsForOrders(active, allLineOrders);
  const hasConflict = conflicts.length > 0;
  const dated = active.filter(
    (o) => o.target_avail_date && !isNaN(Date.parse(o.target_avail_date)),
  );
  let varianceDays = 0;
  if (dated.length >= 2) {
    const ts = dated.map((o) => new Date(o.target_avail_date).getTime());
    varianceDays = (Math.max(...ts) - Math.min(...ts)) / (24 * 3600000);
  }
  let stars;
  if (hasConflict) {
    // Conflicting strategies hard-capped at 2 stars — never eligible for BEST
    stars = conflicts.length === 1 ? 2 : 1;
  } else {
    // Conflict-free: 3–4 stars based on consolidation % and date clustering
    const consolidation = active.length / allGroupOrders.length;
    let s = 0;
    s += consolidation >= 1 ? 2 : consolidation >= 0.6 ? 1 : 0;
    s += varianceDays < 1 ? 2 : varianceDays < 4 ? 1 : 0;
    stars = s >= 3 ? 4 : 3;
  }
  return { stars, hasConflict, conflictCount: conflicts.length };
}

function generateStrategies(group, allLineOrders) {
  if (group.length < 2) return [];

  const sorted = [...group].sort((a, b) => {
    const aD =
      a.target_avail_date && !isNaN(Date.parse(a.target_avail_date))
        ? new Date(a.target_avail_date)
        : new Date("9999-12-31");
    const bD =
      b.target_avail_date && !isNaN(Date.parse(b.target_avail_date))
        ? new Date(b.target_avail_date)
        : new Date("9999-12-31");
    return aD - bD;
  });
  const dated = sorted.filter(
    (o) => o.target_avail_date && !isNaN(Date.parse(o.target_avail_date)),
  );

  const strategies = [];

  // A: Max Consolidation
  strategies.push({
    id: "max",
    label: "Max Consolidation",
    description: `Combine all ${group.length} orders → 1 run · Max changeover savings`,
    activeOrderIds: group.map((o) => o.id),
    note: null,
  });

  // B: Urgency Split (avail date spread ≥ 2 days)
  if (dated.length >= 2) {
    const daySpread =
      (new Date(dated[dated.length - 1].target_avail_date) -
        new Date(dated[0].target_avail_date)) /
      (24 * 3600000);
    if (daySpread >= 2) {
      let maxGap = 0,
        splitIdx = 1;
      for (let i = 1; i < dated.length; i++) {
        const gap =
          new Date(dated[i].target_avail_date) -
          new Date(dated[i - 1].target_avail_date);
        if (gap > maxGap) {
          maxGap = gap;
          splitIdx = i;
        }
      }
      const urgentOrders = dated.slice(0, splitIdx);
      const laterOrders = dated.slice(splitIdx);
      const undated = sorted.filter(
        (o) => !o.target_avail_date || isNaN(Date.parse(o.target_avail_date)),
      );
      if (urgentOrders.length >= 2) {
        const remaining = laterOrders.length + undated.length;
        strategies.push({
          id: "urgency",
          label: "Urgency Split",
          description: `${urgentOrders.length} most urgent orders · due ${formatLongDate(urgentOrders[0].target_avail_date)} – ${formatLongDate(urgentOrders[urgentOrders.length - 1].target_avail_date)}`,
          activeOrderIds: urgentOrders.map((o) => o.id),
          note:
            remaining > 0
              ? `${remaining} later order(s) remain separate`
              : null,
        });
      }
    }
  }

  // C: Conflict-Free / Greedy Safe
  const greedyIds = buildGreedySafe(sorted, allLineOrders);
  if (greedyIds && greedyIds.length >= 2 && greedyIds.length < group.length) {
    strategies.push({
      id: "safe",
      label: "Conflict-Free",
      description: `${greedyIds.length} orders with zero scheduling conflicts`,
      activeOrderIds: greedyIds,
      note: `${group.length - greedyIds.length} order(s) excluded to avoid downstream conflicts`,
    });
  }

  // D: Best Pair (3+ orders only)
  if (group.length >= 3) {
    const pair = findBestPair(dated.length >= 2 ? dated : sorted);
    if (pair) {
      strategies.push({
        id: "pair",
        label: "Best Pair",
        description: `FPR ${pair[0].fpr} + FPR ${pair[1].fpr} · Closest avail dates`,
        activeOrderIds: pair.map((o) => o.id),
        note: `${group.length - 2} order(s) remain separate`,
      });
    }
  }

  // Score all strategies
  const scored = strategies.map((s) => {
    const { stars, hasConflict, conflictCount } = scoreStrategy(
      s,
      group,
      allLineOrders,
    );
    return { ...s, stars, hasConflict, conflictCount, recommended: false };
  });

  // BEST tag: only conflict-free strategies are eligible
  const safeStrategies = scored.filter((s) => !s.hasConflict);
  if (safeStrategies.length > 0) {
    const maxSafeStars = Math.max(...safeStrategies.map((s) => s.stars));
    const bestIdx = scored.findIndex(
      (s) => !s.hasConflict && s.stars === maxSafeStars,
    );
    if (bestIdx >= 0) scored[bestIdx].recommended = true;
  }
  // If ALL strategies have conflicts, flag the group as having no safe option
  scored._allUnsafe = safeStrategies.length === 0;

  return scored;
}

// ─────────────────────────────────────────────────────────────────────────────

function cleanInsertionResponse(text) {
  if (!text) return text;
  let cleaned = text.trim()
    .replace(/\*\*/g, '')
    .replace(/#{1,6}\s*/g, '')
    .replace(/^Insertion Position:\s*/i, '');
  // If starts with just a number like "11." or "2.", prepend "Priority"
  if (/^\d+\.\s/.test(cleaned) && !/^priority/i.test(cleaned)) {
    cleaned = 'Priority ' + cleaned;
  }
  // Replace "is correct" phrasing
  cleaned = cleaned
    .replace(/is correct because/gi, 'takes this position because')
    .replace(/is correct since/gi, 'is placed here since')
    .replace(/is correct as/gi, 'is placed here as')
    .replace(/\bcorrect position\b/gi, 'position');
  return cleaned;
}

function cleanSchedulingNote(text) {
  if (!text) return [];
  let cleaned = text.trim()
    .replace(/\*\*/g, '')
    .replace(/#{1,6}\s*/g, '')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1');
  // Strip any section labels the AI might add
  cleaned = cleaned.replace(/^(INTERSPERSED ORDERS|DOWNSTREAM ORDERS|ANALYSIS|SUMMARY|NOTE)[:\s]*/gim, '');
  cleaned = cleaned.replace(/^\d+\.\s*/gm, '');
  // Split by newlines first (AI was told to use one sentence per line)
  let sentences = cleaned.split('\n').map(s => s.trim()).filter(s => s.length > 0);
  // If AI wrote a single dense paragraph, split by sentence endings
  if (sentences.length <= 1 && cleaned.length > 100) {
    sentences = cleaned.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 0);
  }
  return sentences.slice(0, 5);
}

function extractPrioFromText(text) {
  if (!text) return null;
  const patterns = [
    /RECOMMENDED_PRIO:\s*(\d+)/i,
    /^(\d+)\.\s/m,
    /[Pp]riority\s+(\d+)/,
    /[Pp]rio\s+(\d+)/,
    /inserted?\s+at\s+(?:[Pp]riority\s+)?(\d+)/i,
    /position\s+(\d+)/i,
    /(?:recommend|suggest)\w*\s+(?:[Pp]riority\s+)?(\d+)/i,
    /occupy\s+(?:position\s+)?(?:[Pp]riority\s+)?(\d+)/i,
    /placed?\s+at\s+(?:[Pp]riority\s+)?(\d+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > 0 && num <= 100) return num;
    }
  }
  return null;
}

function parseCombineAnalysisResponse(response) {
  if (!response) return null;
  let cleaned = response
    .replace(/#{1,6}\s*/g, '')
    .replace(/\*\*/g, '')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1');
  const result = { insertionPosition: '', recommendedPrio: null, schedulingImpact: '', alerts: '' };
  const insertionMatch = cleaned.match(/Insertion Position:\s*([\s\S]*?)(?=Scheduling Impact:|$)/i);
  const impactMatch = cleaned.match(/Scheduling Impact:\s*([\s\S]*?)(?=Alerts?:|$)/i);
  const alertsMatch = cleaned.match(/Alerts?:\s*([\s\S]*?)$/i);
  if (insertionMatch) {
    let insertionText = insertionMatch[1].trim();
    const prioLineMatch = insertionText.match(/RECOMMENDED_PRIO:\s*(\d+)/i);
    if (prioLineMatch) {
      result.recommendedPrio = parseInt(prioLineMatch[1], 10);
      insertionText = insertionText.replace(/RECOMMENDED_PRIO:\s*\d+\s*/i, '').trim();
    }
    if (result.recommendedPrio === null) {
      result.recommendedPrio = extractPrioFromText(insertionText);
    }
    result.insertionPosition = insertionText;
  }
  if (impactMatch) result.schedulingImpact = impactMatch[1].trim();
  if (alertsMatch) result.alerts = alertsMatch[1].trim();
  if (!result.insertionPosition && !result.schedulingImpact && !result.alerts) {
    result.insertionPosition = cleaned.trim();
    result.schedulingImpact = 'See above.';
    result.alerts = 'Please review manually.';
  }
  return result;
}

function groupOrdersByShift(orders) {
  if (!orders || orders.length === 0) return [];
  const groups = {};
  orders.forEach(order => {
    const key = (order.shiftHrs || 0).toFixed(2);
    if (!groups[key]) groups[key] = { shiftHrs: order.shiftHrs, shiftFormatted: order.shiftFormatted, orders: [] };
    groups[key].orders.push(order);
  });
  return Object.values(groups).map(g => {
    const sorted = g.orders.sort((a, b) => a.prio - b.prio);
    const prios = sorted.map(o => o.prio);
    const prioRange = prios.length === 1 ? String(prios[0]) : `${prios[0]}–${prios[prios.length - 1]}`;
    return { shiftHrs: g.shiftHrs, shiftFormatted: g.shiftFormatted, prioRange, count: sorted.length, orders: sorted };
  }).sort((a, b) => b.shiftHrs - a.shiftHrs);
}

function groupOrdersByDelay(deadlineMisses) {
  if (!deadlineMisses || deadlineMisses.length === 0) return [];
  const groups = {};
  deadlineMisses.forEach(order => {
    const key = order.delayDays;
    if (!groups[key]) groups[key] = { delayDays: order.delayDays, orders: [] };
    groups[key].orders.push(order);
  });
  return Object.values(groups).map(g => {
    const sorted = g.orders.sort((a, b) => a.prio - b.prio);
    const prios = sorted.map(o => o.prio);
    const prioRange = prios.length === 1 ? String(prios[0]) : `${prios[0]}–${prios[prios.length - 1]}`;
    return { delayDays: g.delayDays, prioRange, count: sorted.length, orders: sorted };
  }).sort((a, b) => b.delayDays - a.delayDays);
}

function pickNotableOrders(orders) {
  const critical = orders.filter(o => o.n10dStatus === 'Critical');
  const urgent = orders.filter(o => o.n10dStatus === 'Urgent');
  const monitor = orders.filter(o => o.n10dStatus === 'Monitor');
  const notable = [...critical, ...urgent, ...monitor].slice(0, 3);
  if (notable.length === 0) {
    const unique = [];
    const seen = new Set();
    for (const o of orders) {
      if (!seen.has(o.name)) { seen.add(o.name); unique.push(o); }
      if (unique.length >= 2) break;
    }
    return unique.map(o => `${o.name} (Prio ${o.prio})`).join(', ');
  }
  return notable.map(o => `${o.name} (Prio ${o.prio}) is ${o.n10dStatus}`).join(', ');
}

function validateAndFixGrouping(parsedResponse, calculatedImpact) {
  let result = {
    earlierSection: [...parsedResponse.earlierSection],
    laterSection: [...parsedResponse.laterSection],
    deadlineSection: [...parsedResponse.deadlineSection],
    summary: [...parsedResponse.summary],
  };

  // STEP 1: Remove literal N10D placeholder text the AI occasionally emits
  function cleanN10DPlaceholders(lines) {
    return lines.map(line => {
      let c = line;
      c = c.replace(/\[N10D status\]/gi, '');
      c = c.replace(/\[N10D: —\]/gi, '');
      c = c.replace(/\[N10D: N\/A\]/gi, '');
      c = c.replace(/\[N10D:.*?\]/gi, '');
      c = c.replace(/N10D: —/gi, '');
      c = c.replace(/\.\s*\./g, '.').replace(/\s+/g, ' ').trim();
      return c;
    }).filter(Boolean);
  }
  result.earlierSection = cleanN10DPlaceholders(result.earlierSection);
  result.laterSection = cleanN10DPlaceholders(result.laterSection);
  result.deadlineSection = cleanN10DPlaceholders(result.deadlineSection);
  result.summary = cleanN10DPlaceholders(result.summary);

  // STEP 2: Remove non-dated, non-critical entries the AI incorrectly added to deadline section
  result.deadlineSection = result.deadlineSection.filter(line => {
    const lower = line.toLowerCase();
    if (lower.includes('exceeds avail date') && !lower.includes('no date') && !lower.includes('n/a')) return true;
    if (lower.includes('critical') || lower.includes('urgent')) return true;
    if (lower.includes('stock depletion') || lower.includes('stockout')) return true;
    return false;
  });

  // STEP 3: Force-add deadline section if AI missed it entirely
  if (calculatedImpact.deadlineMisses.length > 0 && result.deadlineSection.length === 0) {
    console.warn('[SmartCombine] AI missed deadline section — force-adding from calculated data.');
    result.deadlineSection = calculatedImpact.deadlineMisses.map(o => {
      if (o.type === 'dated') {
        return `⛔ Prio ${o.prio}: ${o.name} — new completion ${o.newCompletionFull || o.newCompletion} exceeds avail date ${o.availDate} by ~${o.delayFormatted || (o.delayDays + ' days')}.${o.n10dStatus && o.n10dStatus !== 'N/A' ? ' ' + o.n10dStatus + '.' : ''}`;
      }
      if (o.type === 'n10d_risk') {
        return `⛔ Prio ${o.prio}: ${o.name} — ${o.n10dStatus} stock status. Delay of ~${o.delayFormatted} may accelerate stock depletion.`;
      }
      return '';
    }).filter(Boolean);
  }

  // STEP 4: Fix contradicting summary ("safe" when risks exist)
  if (calculatedImpact.deadlineMisses.length > 0 && result.summary.length > 0) {
    const summaryText = result.summary.join(' ').toLowerCase();
    if (summaryText.includes('safe to proceed') || summaryText.includes('no risks') ||
        summaryText.includes('no delays') || summaryText.includes('no orders at risk')) {
      console.warn('[SmartCombine] AI summary contradicts deadline data — replacing.');
      const datedMisses = calculatedImpact.deadlineMisses.filter(d => d.type === 'dated');
      const n10dMisses = calculatedImpact.deadlineMisses.filter(d => d.type === 'n10d_risk');
      const summaryLines = [];
      if (datedMisses.length > 0) {
        const names = datedMisses.slice(0, 2).map(o => `${o.name} (Prio ${o.prio})`).join(' and ');
        summaryLines.push(`The combination will push ${datedMisses.length} order${datedMisses.length > 1 ? 's' : ''} past their avail date, including ${names}.`);
        summaryLines.push(`${datedMisses[0].name} will be delayed by approximately ${datedMisses[0].delayFormatted} past its avail date of ${datedMisses[0].availDate}.`);
      }
      if (n10dMisses.length > 0) {
        const names = n10dMisses.slice(0, 2).map(o => `${o.name} (Prio ${o.prio}, ${o.n10dStatus})`).join(' and ');
        summaryLines.push(`Additionally, ${n10dMisses.length} order${n10dMisses.length > 1 ? 's' : ''} with critical stock levels will be delayed, including ${names}, which may accelerate stock depletion.`);
      }
      summaryLines.push('Proceed with caution — review the at-risk orders before approving this combination.');
      result.summary = summaryLines;
    }
  }

  // STEP 5: Re-group earlier/later if too many bullets (deadline always stays individual)
  const earlierLaterBullets = result.earlierSection.length + result.laterSection.length;
  if (earlierLaterBullets > 6) {
    if (calculatedImpact.earlierOrders.length > 0) {
      const groups = groupOrdersByShift(calculatedImpact.earlierOrders);
      result.earlierSection = groups.map(g => {
        const notables = pickNotableOrders(g.orders);
        if (g.count === 1) return `✅ Prio ${g.prioRange}: ${g.orders[0].name} — starts ${g.shiftFormatted} earlier.${g.orders[0].n10dStatus && g.orders[0].n10dStatus !== 'N/A' ? ' ' + g.orders[0].n10dStatus + '.' : ''}`;
        return `✅ Prio ${g.prioRange} (${g.count} orders) — all start ~${g.shiftFormatted} earlier.${notables ? ' Notable: ' + notables + '.' : ''}`;
      });
    }
    if (calculatedImpact.laterOrders.length > 0) {
      const groups = groupOrdersByShift(calculatedImpact.laterOrders);
      result.laterSection = groups.map(g => {
        const notables = pickNotableOrders(g.orders);
        if (g.count === 1) return `⚠ Prio ${g.prioRange}: ${g.orders[0].name} — starts ${g.shiftFormatted} later.${g.orders[0].n10dStatus && g.orders[0].n10dStatus !== 'N/A' ? ' ' + g.orders[0].n10dStatus + '.' : ''}`;
        return `⚠ Prio ${g.prioRange} (${g.count} orders) — all start ~${g.shiftFormatted} later.${notables ? ' Notable: ' + notables + '.' : ''}`;
      });
    }
  }

  return result;
}

function parseSchedulingImpactResponse(response) {
  if (!response) return null;
  let cleaned = response.trim()
    .replace(/\*\*/g, '')
    .replace(/#{1,6}\s*/g, '')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1');

  const result = { earlierSection: [], laterSection: [], deadlineSection: [], summary: [] };

  // Split on ---SUMMARY--- marker first
  let bulletsPart = cleaned;
  let summaryPart = '';

  const markerIdx = cleaned.indexOf('---SUMMARY---');
  if (markerIdx >= 0) {
    bulletsPart = cleaned.substring(0, markerIdx).trim();
    summaryPart = cleaned.substring(markerIdx + '---SUMMARY---'.length).trim();
  } else {
    // Fallback: try SUMMARY: or === markers in the latter half
    for (const marker of ['SUMMARY:', 'Summary:']) {
      const idx = cleaned.lastIndexOf(marker);
      if (idx >= 0 && idx > cleaned.length * 0.4) {
        bulletsPart = cleaned.substring(0, idx).trim();
        summaryPart = cleaned.substring(idx + marker.length).trim();
        break;
      }
    }
    // Last-resort fallback: non-icon lines after last icon/header
    if (!summaryPart) {
      const allLines = cleaned.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      let lastContentIdx = -1;
      allLines.forEach((l, i) => {
        if (l.startsWith('✅') || l.startsWith('⚠') || l.startsWith('⛔') ||
            l.toLowerCase().startsWith('orders starting') || l.toLowerCase().startsWith('orders at risk')) {
          lastContentIdx = i;
        }
      });
      if (lastContentIdx >= 0 && lastContentIdx < allLines.length - 1) {
        bulletsPart = allLines.slice(0, lastContentIdx + 1).join('\n');
        summaryPart = allLines.slice(lastContentIdx + 1).join('\n');
      }
    }
  }

  // Parse bullets part — line-by-line state machine
  const bulletLines = bulletsPart.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  let currentSection = null;

  bulletLines.forEach(line => {
    const lower = line.toLowerCase();
    if (lower.startsWith('orders starting earlier')) { currentSection = 'earlier'; return; }
    if (lower.startsWith('orders starting later')) { currentSection = 'later'; return; }
    if (lower.startsWith('orders at risk')) { currentSection = 'deadline'; return; }

    if (line.startsWith('✅')) {
      result.earlierSection.push(line);
      if (!currentSection) currentSection = 'earlier';
      return;
    }
    if (line.startsWith('⚠')) {
      if (currentSection === 'earlier') result.earlierSection.push(line);
      else if (currentSection === 'deadline') result.deadlineSection.push(line);
      else result.laterSection.push(line);
      if (!currentSection) currentSection = 'later';
      return;
    }
    if (line.startsWith('⛔')) {
      result.deadlineSection.push(line);
      if (!currentSection) currentSection = 'deadline';
      return;
    }
  });

  // Parse summary
  if (summaryPart) {
    result.summary = summaryPart
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('---') && !l.startsWith('==='))
      .slice(0, 5);
  }

  return result;
}

function SchedulingImpactLine({ line, type }) {
  let text = line.trim();
  let icon = '';
  if (text.startsWith('✅')) { icon = '✅'; text = text.replace(/^✅\s*/, ''); }
  else if (text.startsWith('⚠')) { icon = '⚠'; text = text.replace(/^⚠\s*/, ''); }
  else if (text.startsWith('⛔')) { icon = '⛔'; text = text.replace(/^⛔\s*/, ''); }
  else {
    if (type === 'earlier') icon = '✅';
    else if (type === 'later') icon = '⚠';
    else icon = '⛔';
  }
  const isNoOrders = text.toLowerCase().includes('no orders');
  if (isNoOrders) {
    return <p className="text-[10px] text-gray-400 italic">{text}</p>;
  }
  const iconColor = type === 'earlier' ? 'text-green-600' : type === 'later' ? 'text-amber-500' : 'text-red-500';
  const textColor = type === 'earlier' ? 'text-[#2e343a]' : type === 'later' ? 'text-[#2e343a]' : 'text-[#2e343a]';
  return (
    <div className="flex items-start gap-1.5">
      <span className={`text-[10px] shrink-0 mt-0.5 ${iconColor}`}>{icon}</span>
      <span className={`text-[10px] ${textColor} leading-relaxed`}>{text}</span>
    </div>
  );
}

function SchedulingImpactAIDisplay({ response }) {
  const hasBullets = response.earlierSection.length > 0 || response.laterSection.length > 0 || response.deadlineSection.length > 0;
  return (
    <div className="space-y-2">
      {response.earlierSection.length > 0 && (
        <div>
          <p className="text-[10px] font-bold text-green-700 mb-1">Orders starting earlier:</p>
          <div className="space-y-1">
            {response.earlierSection.map((line, i) => (
              <SchedulingImpactLine key={`earlier-${i}`} line={line} type="earlier" />
            ))}
          </div>
        </div>
      )}
      {response.laterSection.length > 0 && (
        <div>
          <p className="text-[10px] font-bold text-red-600 mb-1">Orders starting later:</p>
          <div className="space-y-1">
            {response.laterSection.map((line, i) => (
              <SchedulingImpactLine key={`later-${i}`} line={line} type="later" />
            ))}
          </div>
        </div>
      )}
      {response.deadlineSection.length > 0 && (
        <div>
          <p className="text-[10px] font-bold text-red-700 mb-1">Orders at risk of missing avail date:</p>
          <div className="space-y-1">
            {response.deadlineSection.map((line, i) => (
              <SchedulingImpactLine key={`deadline-${i}`} line={line} type="deadline" />
            ))}
          </div>
        </div>
      )}
      {response.summary.length > 0 && (
        <div className={`scheduling-impact-ai-note${hasBullets ? ' scheduling-impact-ai-note-separated' : ''}`}>
          {response.summary.map((sentence, i) => (
            <p key={i} className="scheduling-impact-ai-sentence">{sentence}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function SchedulingImpactFallback({ impact }) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] text-gray-400 italic">AI analysis unavailable — showing calculated data.</p>
      {impact.laterOrders.length > 0 && (
        <div>
          <p className="text-[10px] font-bold text-red-600 mb-1">Orders starting later:</p>
          <div className="space-y-1">
            {impact.laterOrders.map((o, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <span className="text-[10px] text-amber-500 shrink-0 mt-0.5">⚠</span>
                <span className="text-[10px] text-[#2e343a] leading-relaxed">
                  Prio {o.prio}: {o.name} — starts <span className="font-semibold text-red-600">{o.shiftFormatted} later</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {impact.earlierOrders.length > 0 && (
        <div>
          <p className="text-[10px] font-bold text-green-700 mb-1">Orders starting earlier:</p>
          <div className="space-y-1">
            {impact.earlierOrders.map((o, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <span className="text-[10px] text-green-600 shrink-0 mt-0.5">✅</span>
                <span className="text-[10px] text-[#2e343a] leading-relaxed">
                  Prio {o.prio}: {o.name} — starts <span className="font-semibold text-green-700">{o.shiftFormatted} earlier</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {impact.deadlineMisses.length > 0 && (
        <div>
          <p className="text-[10px] font-bold text-red-700 mb-1">Orders at risk of missing avail date:</p>
          <div className="space-y-1">
            {impact.deadlineMisses.map((o, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <span className="text-[10px] text-red-500 shrink-0 mt-0.5">⛔</span>
                <span className="text-[10px] text-[#2e343a] leading-relaxed">
                  Prio {o.prio}: {o.name} — new completion{' '}
                  <span className="font-semibold text-red-600">{o.newCompletion}</span>
                  {' '}exceeds avail date{' '}
                  <span className="font-semibold text-red-600">{o.availDate}</span>
                  {' '}(~{o.delayDays} day{o.delayDays !== 1 ? 's' : ''} late)
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CombineAnalysisDisplay({ analysis }) {
  if (!analysis) return null;
  return (
    <div className="combine-analysis-content">
      <div className="combine-analysis-row">
        <div className="combine-analysis-row-label">
          <span className="combine-analysis-row-icon">📍</span>
          Insertion Position
        </div>
        <div className="combine-analysis-row-text">{analysis.insertionPosition || '—'}</div>
      </div>
      <div className="combine-analysis-row">
        <div className="combine-analysis-row-label">
          <span className="combine-analysis-row-icon">📊</span>
          Scheduling Impact
        </div>
        <div className="combine-analysis-row-text">{analysis.schedulingImpact || '—'}</div>
      </div>
      <div className="combine-analysis-row combine-analysis-row-alerts">
        <div className="combine-analysis-row-label">
          <span className="combine-analysis-row-icon">⚠</span>
          Alerts
        </div>
        <div className="combine-analysis-row-text">{analysis.alerts || '—'}</div>
      </div>
    </div>
  );
}

function CombineAlertsDisplay({ alerts, hideNoAlerts = false }) {
  if (!alerts) return hideNoAlerts ? null : <p className="text-[10px] text-green-700 italic">No alerts.</p>;
  const lines = alerts.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return hideNoAlerts ? null : <p className="text-[10px] text-green-700 italic">No alerts — all orders remain on schedule.</p>;
  const isNoAlerts = lines.length === 1 && lines[0].toLowerCase().includes('no alerts');
  if (isNoAlerts) return hideNoAlerts ? null : <p className="text-[10px] text-green-700 italic">{lines[0].replace(/^[⚠\s]+/, '').trim()}</p>;
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => {
        const cleaned = line.replace(/^[⚠•\-\s]+/, '').trim();
        if (!cleaned) return null;
        return (
          <div key={i} className="flex items-start gap-1.5">
            <span className="text-[10px] text-amber-500 shrink-0 mt-0.5">⚠</span>
            <span className="text-[10px] text-[#92400e] leading-relaxed">{cleaned}</span>
          </div>
        );
      })}
    </div>
  );
}

function normalizeVal(v) {
  if (v === null || v === undefined || v === "" || v === "-") return "";
  return String(v).trim().toLowerCase();
}

// Hard guardrail helper: returns true if orderA and orderB are a
// generated-vs-source pair that must never be combined.
function isGeneratedSourcePair(orderA, orderB) {
  const aIsGen = orderA.is_powermix_generated === true || orderA.is_powermix_generated === 'true';
  const bIsGen = orderB.is_powermix_generated === true || orderB.is_powermix_generated === 'true';
  if (aIsGen === bIsGen) return false; // same class — not a blocked pair
  console.debug('[Combine Guardrail - Generated vs Source]', {
    orderAId: orderA.id,
    orderBId: orderB.id,
    orderAType: aIsGen ? 'generated' : 'source',
    orderBType: bIsGen ? 'generated' : 'source',
    isGeneratedSourceMix: true,
    canCombine: false,
    blockedReason: 'generated_and_source_orders_cannot_combine',
  });
  return true;
}

function findCombineGroups(orders) {
  const eligible = orders.filter(
    (o) =>
      o.status === "normal" || o.status === "plotted" || o.status === "cut",
  );

  const groups = {};
  for (const o of eligible) {
    const key = [
      String(o.material_code || "").trim(),
      normalizeVal(o.kb_sfg_material_code),
      String(o.feedmill_line || "").trim(),
      normalizeVal(o.formula_version),
    ].join("|||");
    if (!groups[key]) groups[key] = [];
    groups[key].push(o);
  }

  // Apply generated-vs-source hard guardrail: split any group that mixes
  // generated and source orders into separate same-class sub-groups.
  const rawGroups = Object.values(groups);
  const safGroups = [];
  for (const grp of rawGroups) {
    const genOrders = grp.filter(o => o.is_powermix_generated === true || o.is_powermix_generated === 'true');
    const srcOrders = grp.filter(o => !(o.is_powermix_generated === true || o.is_powermix_generated === 'true'));
    if (genOrders.length > 0 && srcOrders.length > 0) {
      // Mixed group — log the guardrail and split
      for (const gen of genOrders) {
        for (const src of srcOrders) {
          console.debug('[Combine Eligibility Scan]', {
            orderAId: gen.id,
            orderBId: src.id,
            sameLine: gen.feedmill_line === src.feedmill_line,
            sameSequenceArea: true,
            generatedSourceRelationshipDetected: true,
            blockedByGeneratedSourceGuardrail: true,
          });
        }
      }
      if (genOrders.length >= 2) safGroups.push(genOrders);
      if (srcOrders.length >= 2) safGroups.push(srcOrders);
    } else {
      safGroups.push(grp);
    }
  }

  return {
    groups: safGroups.filter((g) => g.length >= 2),
  };
}

function determineLeadItemDescription(groupOrders) {
  const fprs = [...new Set(groupOrders.map((o) => o.fpr))];
  if (fprs.length === 1) {
    const sorted = [...groupOrders].sort(
      (a, b) => getEffVolume(b) - getEffVolume(a),
    );
    return sorted[0].item_description;
  }
  const sorted = [...groupOrders].sort((a, b) => {
    const fprA = parseInt(a.fpr) || 0;
    const fprB = parseInt(b.fpr) || 0;
    return fprB - fprA;
  });
  return sorted[0].item_description;
}

export default function SmartCombinePanel({
  orders,
  allOrders,
  activeFeedmill,
  activeSubSection,
  kbRecords,
  onCombine,
  newFprValues,
  inferredTargetMap = {},
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [dismissed, setDismissed] = useState(new Set());
  const [excluded, setExcluded] = useState({});
  const [selectedStrategies, setSelectedStrategies] = useState({});
  const [refreshKey, setRefreshKey] = useState(0);
  const [confirmGroup, setConfirmGroup] = useState(null);
  const [conflictResult, setConflictResult] = useState(null);
  const [combineError, setCombineError] = useState(null);
  const [isCombining, setIsCombining] = useState(false);
  const panelRef = useRef(null);

  const hasNewFprs = newFprValues && newFprValues.size > 0;
  const [aiScheduleInsights, setAiScheduleInsights] = useState({});
  const [aiScheduleLoading, setAiScheduleLoading] = useState({});
  const [aiSectionLoading, setAiSectionLoading] = useState({});
  const aiTriggeredRef = useRef(new Set());

  // Clear all AI state when the panel closes so stale responses don't bleed
  // into new group compositions when the panel is reopened
  useEffect(() => {
    if (!isOpen) {
      setAiScheduleInsights({});
      setAiScheduleLoading({});
      setAiSectionLoading({});
      aiTriggeredRef.current = new Set();
    }
  }, [isOpen]);

  const getGroupKey = useCallback(
    (group) => {
      const line = group[0]?.feedmill_line || '';
      const mat = String(group[0]?.material_code || group[0]?.material_code_fg || '');
      const fprs = group.map((o) => o.fpr || o.id).sort().join('|');
      return `${line}||${mat}||${fprs}`;
    },
    [],
  );

  const [combineFilter, setCombineFilter] = useState(
    hasNewFprs ? "new_existing" : "all",
  );
  const [lineFilter, setLineFilter] = useState("all");

  useEffect(() => {
    setCombineFilter(hasNewFprs ? "new_existing" : "all");
  }, [hasNewFprs]);

  useEffect(() => {
    setLineFilter("all");
  }, [activeFeedmill, activeSubSection]);

  const validLines = LINE_MAP[activeFeedmill] || [];
  const isAllTab = activeSubSection === "all" && validLines.length > 1;
  const lineLabel =
    activeSubSection && activeSubSection !== "all"
      ? activeSubSection
      : FEEDMILL_LABELS[activeFeedmill] || activeFeedmill;

  const lineOrders = useMemo(() => {
    let filtered = orders.filter((o) => validLines.includes(o.feedmill_line));
    if (activeSubSection && activeSubSection !== "all") {
      filtered = filtered.filter((o) => o.feedmill_line === activeSubSection);
    }
    return filtered;
  }, [orders, validLines, activeSubSection]);

  const { groups } = useMemo(() => {
    return findCombineGroups(lineOrders);
  }, [lineOrders, refreshKey]);

  const visibleGroups = useMemo(() => {
    const result = [];
    groups.forEach((group, i) => {
      if (dismissed.has(i)) return;
      if (combineFilter !== "all" && hasNewFprs) {
        const hasNew = group.some((o) => newFprValues.has(o.fpr));
        const hasExisting = group.some((o) => !newFprValues.has(o.fpr));
        if (combineFilter === "new_existing" && !(hasNew && hasExisting))
          return;
        if (
          combineFilter === "new_only" &&
          !group.every((o) => newFprValues.has(o.fpr))
        )
          return;
      }
      if (isAllTab && lineFilter !== "all") {
        const groupLine = group[0]?.feedmill_line;
        if (groupLine !== lineFilter) return;
      }
      result.push({ group, originalIdx: i });
    });
    return result;
  }, [
    groups,
    dismissed,
    combineFilter,
    hasNewFprs,
    newFprValues,
    isAllTab,
    lineFilter,
  ]);

  const orderFingerprint = useMemo(() => {
    return orders
      .map((o) => `${o.id}|${o.status}|${o.parent_id || ""}`)
      .join(",");
  }, [orders]);

  // Overall safety assessment across all visible groups
  const overallSafety = useMemo(() => {
    if (visibleGroups.length === 0) return null;
    const allGroupLineOrders = (group) =>
      lineOrders.filter((o) => o.feedmill_line === group[0]?.feedmill_line);
    let unsafeCount = 0;
    let safeCount = 0;
    for (const { group, originalIdx } of visibleGroups) {
      const strategies = generateStrategies(group, allGroupLineOrders(group));
      const defaultStratId =
        strategies.find((s) => s.recommended)?.id || strategies[0]?.id;
      const selectedStratId = selectedStrategies[originalIdx] || defaultStratId;
      const selectedStrat = strategies.find((s) => s.id === selectedStratId);
      if (selectedStrat?.hasConflict) unsafeCount++;
      else safeCount++;
    }
    return { unsafeCount, safeCount, total: visibleGroups.length };
  }, [visibleGroups, selectedStrategies, lineOrders]);

  useEffect(() => {
    setDismissed(new Set());
    setExcluded({});
    setSelectedStrategies({});
  }, [orderFingerprint, activeFeedmill, activeSubSection]);

  const handleRefresh = () => {
    setDismissed(new Set());
    setExcluded({});
    setSelectedStrategies({});
    setRefreshKey((k) => k + 1);
  };

  const handleDismiss = (groupIndex) => {
    setDismissed((prev) => new Set([...prev, groupIndex]));
  };

  const handleSelectStrategy = (groupIdx, stratId, group) => {
    setSelectedStrategies((prev) => ({ ...prev, [groupIdx]: stratId }));
    setExcluded((prev) => ({ ...prev, [groupIdx]: new Set() }));
    if (group) {
      const key = getGroupKey(group);
      aiTriggeredRef.current.delete(key);
      setAiScheduleInsights((prev) => { const next = { ...prev }; delete next[key]; return next; });
    }
  };

  const handleExclude = (groupIdx, orderId, group) => {
    setExcluded((prev) => {
      const s = new Set(prev[groupIdx] || []);
      s.add(orderId);
      return { ...prev, [groupIdx]: s };
    });
    if (group) {
      const key = getGroupKey(group);
      aiTriggeredRef.current.delete(key);
      setAiScheduleInsights((prev) => { const next = { ...prev }; delete next[key]; return next; });
    }
  };

  const handleReadd = (groupIdx, orderId, group) => {
    setExcluded((prev) => {
      const s = new Set(prev[groupIdx] || []);
      s.delete(orderId);
      return { ...prev, [groupIdx]: s };
    });
    if (group) {
      const key = getGroupKey(group);
      aiTriggeredRef.current.delete(key);
      setAiScheduleInsights((prev) => { const next = { ...prev }; delete next[key]; return next; });
    }
  };

  // Returns [strategies, selectedStratId, activeOrders, stratExcludedOrders, manualExcludedOrders]
  const resolveGroupStrategy = (group, groupIdx) => {
    const allGroupLineOrders = lineOrders.filter(
      (o) => o.feedmill_line === group[0]?.feedmill_line,
    );
    const strategies = generateStrategies(group, allGroupLineOrders);
    // Default to the BEST (recommended) strategy, falling back to strategies[0]
    const defaultStratId =
      strategies.find((s) => s.recommended)?.id || strategies[0]?.id;
    const selectedStratId = selectedStrategies[groupIdx] || defaultStratId;
    const selectedStrat = strategies.find((s) => s.id === selectedStratId);
    const stratIds = selectedStrat
      ? new Set(selectedStrat.activeOrderIds)
      : new Set(group.map((o) => o.id));
    const manualEx = excluded[groupIdx] || new Set();
    const activeOrders = group.filter(
      (o) => stratIds.has(o.id) && !manualEx.has(o.id),
    );
    const stratExcluded = group.filter((o) => !stratIds.has(o.id));
    const manualExcluded = group.filter(
      (o) => stratIds.has(o.id) && manualEx.has(o.id),
    );
    return {
      strategies,
      selectedStratId,
      activeOrders,
      stratExcluded,
      manualExcluded,
    };
  };

  const validateCombineGroup = (activeOrders) => {
    const errors = [];

    if (activeOrders.length < 2) {
      errors.push(
        "At least 2 orders are required to perform a combine action.",
      );
      return errors;
    }

    const matCodes = new Set(
      activeOrders.map((o) => String(o.material_code || "").trim()),
    );
    if (matCodes.size > 1) {
      errors.push(
        "These orders cannot be combined because they have different Material Codes. All orders must share the same Material Code (FG) to be eligible for combining.",
      );
    }

    const lines = new Set(
      activeOrders.map((o) => String(o.feedmill_line || "").trim()),
    );
    if (lines.size > 1) {
      errors.push(
        "These orders cannot be combined because they are assigned to different feedmill lines. All orders must be on the same line to be eligible for combining.",
      );
    }

    const sfgCodes = new Set(
      activeOrders.map((o) => normalizeVal(o.kb_sfg_material_code)),
    );
    if (sfgCodes.size > 1) {
      const vals = activeOrders.map(
        (o) => normalizeVal(o.kb_sfg_material_code) || "(empty)",
      );
      errors.push(
        `Cannot combine: Orders have different Material Code (SFG) values (${vals.join(" vs ")})`,
      );
    }

    const fvCodes = new Set(
      activeOrders.map((o) => normalizeVal(o.formula_version)),
    );
    if (fvCodes.size > 1) {
      const vals = activeOrders.map(
        (o) => normalizeVal(o.formula_version) || "(empty)",
      );
      errors.push(
        `Cannot combine: Orders have different Formula Version values (${vals.join(" vs ")})`,
      );
    }

    const alreadyCombined = activeOrders.filter(
      (o) => o.status === "combined" || o.parent_id,
    );
    if (alreadyCombined.length > 0) {
      errors.push(
        "One or more selected orders are already part of a combined group. Un-combine them first before creating a new combination.",
      );
    }

    const incompatible = activeOrders.filter(
      (o) => o.status === "completed" || o.status === "cancel_po",
    );
    if (incompatible.length > 0) {
      errors.push(
        "One or more selected orders have a status that prevents combining (e.g., Done, Cancel PO). Only orders with an active status can be combined.",
      );
    }

    return errors;
  };

  const handleApprove = (group, groupIndex) => {
    const { activeOrders } = resolveGroupStrategy(group, groupIndex);

    const validationErrors = validateCombineGroup(activeOrders);
    if (validationErrors.length > 0) {
      setCombineError(validationErrors);
      return;
    }

    const conflicts = detectConflicts(activeOrders);

    if (conflicts.conflicts.length > 0) {
      setCombineError([
        "Combining these orders would cause the following downstream orders to exceed their Avail Date deadlines:",
        ...conflicts.conflicts.map((c) => {
          const exceedLabel =
            c.exceedHours < 24
              ? `${c.exceedHours} hours`
              : `${Math.round(c.exceedHours / 24)} days`;
          return `FPR: ${c.order.fpr} — New Completion: ${formatLongDateTime(c.newCompletion)} exceeds Avail Date: ${formatLongDate(c.order.target_avail_date)} by ${exceedLabel}`;
        }),
        "Resolve scheduling conflicts before combining. Consider reordering orders, adjusting volumes, or changing Start Dates.",
      ]);
      return;
    }

    const ins = generateInsights(activeOrders);
    const overrideAI = !!ins.gapRecommendation;

    setConflictResult({ ...conflicts, overrideAI });
    setConfirmGroup({ group: activeOrders, groupIndex });
  };

  const detectConflicts = (group) => {
    const groupLine = group[0]?.feedmill_line;
    const allLineOrders = lineOrders
      .filter((o) => o.feedmill_line === groupLine)
      .sort(
        (a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity),
      );
    const groupIds = new Set(group.map((o) => o.id));

    const combinedBasisVol = group.reduce((s, o) => s + getCombineBasisVolume(o), 0);
    const runRate = parseFloat(group[0].run_rate) || 0;
    const batchSize = parseFloat(group[0].batch_size) || 4;
    const combinedVolume = batchSize > 0 ? Math.ceil(combinedBasisVol / batchSize) * batchSize : Number(combinedBasisVol.toFixed(2));
    const prodHours = calcProductionHoursLocal(combinedVolume, runRate);
    const changeover = 0.17;

    // For dated orders, use the index of the order with the earliest avail date.
    // For non-dated orders, use the earliest position (lowest priority_seq index).
    const datedGroupOrders = group.filter((o) => {
      const av = (o.target_avail_date || '').toLowerCase();
      return av && !av.includes('prio') && !av.includes('safety') && av !== '—' && !isNaN(Date.parse(o.target_avail_date));
    });
    let anchorOrderId;
    if (datedGroupOrders.length > 0) {
      const earliest = datedGroupOrders.sort((a, b) => new Date(a.target_avail_date) - new Date(b.target_avail_date))[0];
      anchorOrderId = earliest.id;
    }
    const earliestIdx = anchorOrderId
      ? (() => { const i = allLineOrders.findIndex((lo) => lo.id === anchorOrderId); return i >= 0 ? i : Math.min(...group.map((o) => { const idx = allLineOrders.findIndex((lo) => lo.id === o.id); return idx >= 0 ? idx : Infinity; })); })()
      : Math.min(...group.map((o) => { const idx = allLineOrders.findIndex((lo) => lo.id === o.id); return idx >= 0 ? idx : Infinity; }));

    const simulatedOrders = allLineOrders.filter((o) => !groupIds.has(o.id));
    const leadPlaceholder = {
      ...group[0],
      total_volume_mt: combinedVolume,
      production_hours: prodHours,
      changeover_time: changeover,
      run_rate: runRate,
      batch_size: batchSize,
      target_completion_manual: false,
      production_hours_manual: false,
    };
    simulatedOrders.splice(earliestIdx, 0, leadPlaceholder);

    let prevCompletion = null;
    const conflictList = [];

    for (let i = 0; i < simulatedOrders.length; i++) {
      const o = { ...simulatedOrders[i] };
      if (i > 0 && prevCompletion) {
        o.start_date = `${prevCompletion.getFullYear()}-${String(prevCompletion.getMonth() + 1).padStart(2, "0")}-${String(prevCompletion.getDate()).padStart(2, "0")}`;
        o.start_time = `${String(prevCompletion.getHours()).padStart(2, "0")}:${String(prevCompletion.getMinutes()).padStart(2, "0")}`;
      }

      const ph =
        o === leadPlaceholder
          ? prodHours
          : o.production_hours_manual
            ? o.production_hours
            : calcProductionHoursLocal(
                getEffVolume(o),
                parseFloat(o.run_rate) || 0,
              );
      const co = parseFloat(o.changeover_time) ?? 0.17;
      const completionDate = calcCompletionDateLocal(
        o.start_date,
        o.start_time,
        ph,
        co,
      );
      prevCompletion = completionDate;

      if (o !== leadPlaceholder && completionDate && !groupIds.has(o.id)) {
        const availStr = o.target_avail_date;
        if (availStr && !isNaN(Date.parse(availStr))) {
          const availDate = new Date(availStr);
          availDate.setHours(23, 59, 59, 999);
          if (completionDate > availDate) {
            const diffMs = completionDate.getTime() - availDate.getTime();
            const diffHours = Math.round(diffMs / 3600000);
            conflictList.push({
              order: o,
              newCompletion: completionDate,
              availDate: availDate,
              exceedHours: diffHours,
            });
          }
        }
      }

      if (o === leadPlaceholder) {
        simulatedOrders[i] = {
          ...o,
          _completionDate: completionDate,
          _prodHours: prodHours,
        };
      }
    }

    const leadStartDate = simulatedOrders[earliestIdx]?.start_date;
    const leadStartTime = simulatedOrders[earliestIdx]?.start_time;
    const leadCompletion = calcCompletionDateLocal(
      leadStartDate,
      leadStartTime,
      prodHours,
      changeover,
    );

    return {
      combinedVolume,
      prodHours,
      leadCompletion,
      conflicts: conflictList,
    };
  };

  const handleConfirmCombine = async () => {
    if (!confirmGroup || isCombining) return;
    setIsCombining(true);
    const { group } = confirmGroup;
    const { combinedVolume, prodHours, leadCompletion } = conflictResult;

    const now = new Date();
    const fprDate = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;

    const itemDesc = determineLeadItemDescription(group);
    const originalVolume = group.reduce(
      (s, o) => s + (parseFloat(o.total_volume_mt) || 0),
      0,
    );
    const batchSize = parseFloat(group[0].batch_size) || 4;
    const runRate = parseFloat(group[0].run_rate) || 0;

    const kbEntry = kbRecords.find(
      (k) =>
        String(k.fg_material_code).trim() ===
        String(group[0].material_code).trim(),
    );
    const sfgCode =
      kbEntry?.sfg1_material_code || group[0].kb_sfg_material_code || "";
    const threads = kbEntry?.thread || group[0].threads || "";
    const sacksDesc = kbEntry?.sacks_item_description || group[0].sacks || "";
    const tagsDesc = kbEntry?.tags_item_description || group[0].tags || "";
    const markings = kbEntry
      ? [kbEntry.label_1, kbEntry.label_2].filter(Boolean).join(" | ")
      : group[0].markings || "";

    const fprList = group.map((o) => o.fpr).join(", ");
    const timestamp = formatLongDateTime(now);

    // Avail date for the lead: earliest valid ISO date from children.
    // If no child has a valid date, fall back to the first non-empty avail value
    // (e.g. "prio replenish") so the lead inherits the urgency indicator.
    const datedChildren = group.filter(
      (o) => o.target_avail_date && !isNaN(Date.parse(o.target_avail_date)),
    );
    const earliestAvailDate =
      datedChildren.length > 0
        ? datedChildren.reduce((min, o) => {
            const d = new Date(o.target_avail_date);
            return min === null || d < min ? d : min;
          }, null)
        : null;
    const leadAvailDate = earliestAvailDate
      ? earliestAvailDate.toISOString().split("T")[0]
      : group.find((o) => o.target_avail_date)?.target_avail_date || null;

    const leadOrder = {
      fpr: fprDate,
      material_code: group[0].material_code,
      formula_version: group[0].formula_version || "",
      item_description: itemDesc,
      category: group[0].category,
      feedmill_line: group[0].feedmill_line,
      total_volume_mt: combinedVolume,
      form: group[0].form,
      batch_size: batchSize,
      run_rate: runRate,
      changeover_time: 0.17,
      production_hours: prodHours,
      production_hours_manual: false,
      target_completion_manual: false,
      target_avail_date: leadAvailDate,
      original_avail_date: leadAvailDate,
      ha_available: null,
      prod_version: "",
      ha_prep_form_issuance: "",
      fg: "",
      sfg: "",
      sfg1: "",
      kb_sfg_material_code: sfgCode,
      threads,
      sacks: sacksDesc,
      tags: tagsDesc,
      markings,
      status: "combined",
      prod_remarks: conflictResult?.overrideAI
        ? `Combined orders: FPR ${fprList} — Combined despite AI recommendation to keep separate — ${timestamp}`
        : `Combined orders: FPR ${fprList} — ${timestamp}`,
      special_remarks: "",
      original_order_ids: group.map((o) => o.id),
      original_orders_snapshot: group.map((o) => ({ ...o })),
    };

    const childUpdates = group.map((o) => ({
      id: o.id,
      data: {
        status: "combined",
        parent_id: "__LEAD__",
      },
    }));

    try {
      await onCombine(leadOrder, childUpdates, group);
      setConfirmGroup(null);
      setConflictResult(null);
      setIsCombining(false);
      handleRefresh();
    } catch (e) {
      console.error("Combine failed:", e);
      setConfirmGroup(null);
      setConflictResult(null);
      setIsCombining(false);
      setCombineError([
        "An unexpected error occurred while combining orders. Please try again. If the issue persists, contact support.",
      ]);
    }
  };

  const handleClickOutside = useCallback((e) => {
    if (panelRef.current && !panelRef.current.contains(e.target)) {
      const toggleBtn = document.getElementById("smart-combine-toggle");
      if (toggleBtn && toggleBtn.contains(e.target)) return;
      const toggleWrapper = document.querySelector(
        "[data-smart-combine-toggle]",
      );
      if (toggleWrapper && toggleWrapper.contains(e.target)) return;
      setIsOpen(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen, handleClickOutside]);

  const generateInsights = useCallback(
    (activeOrders) => {
      const warnings = [];
      const infos = [];
      let productionSummary = null;
      let schedulingImpact = null;
      let gapRecommendation = null;

      if (activeOrders.length < 2)
        return {
          warnings,
          infos,
          hasBlocker: false,
          productionSummary,
          schedulingImpact,
          gapRecommendation,
        };

      const batchSize = parseFloat(activeOrders[0].batch_size) || 4;
      const combinedBasisVol = activeOrders.reduce((s, o) => s + getCombineBasisVolume(o), 0);
      const combinedVol = batchSize > 0 ? Math.ceil(combinedBasisVol / batchSize) * batchSize : Number(combinedBasisVol.toFixed(2));
      const runRate = parseFloat(activeOrders[0].run_rate) || 0;
      const form = activeOrders[0].form;
      const line = activeOrders[0].feedmill_line;

      const matCodes = new Set(
        activeOrders.map((o) => String(o.material_code || "").trim()),
      );
      if (matCodes.size > 1)
        warnings.push({
          text: "Orders have different Material Codes (FG). All orders must share the same Material Code to combine.",
          blocking: true,
        });
      const lines = new Set(
        activeOrders.map((o) => String(o.feedmill_line || "").trim()),
      );
      if (lines.size > 1)
        warnings.push({
          text: "Orders are assigned to different feedmill lines. All orders must be on the same line to combine.",
          blocking: true,
        });

      const sfgSet = new Set(
        activeOrders.map((o) => normalizeVal(o.kb_sfg_material_code)),
      );
      if (sfgSet.size > 1) {
        const vals = activeOrders.map(
          (o) => normalizeVal(o.kb_sfg_material_code) || "(empty)",
        );
        warnings.push({
          text: `Orders have different Material Code (SFG) values (${vals.join(" vs ")}). All orders must share the same SFG to combine.`,
          blocking: true,
        });
      }
      const fvSet = new Set(
        activeOrders.map((o) => normalizeVal(o.formula_version)),
      );
      if (fvSet.size > 1) {
        const vals = activeOrders.map(
          (o) => normalizeVal(o.formula_version) || "(empty)",
        );
        warnings.push({
          text: `Orders have different Formula Version values (${vals.join(" vs ")}). All orders must share the same Formula Version to combine.`,
          blocking: true,
        });
      }

      const alreadyCombined = activeOrders.filter(
        (o) => o.status === "combined" || o.parent_id,
      );
      for (const o of alreadyCombined)
        warnings.push({
          text: `FPR: ${o.fpr} is already part of another combined group. It must be un-combined first.`,
          blocking: false,
        });
      const incompatible = activeOrders.filter(
        (o) => o.status === "completed" || o.status === "cancel_po",
      );
      for (const o of incompatible)
        warnings.push({
          text: `FPR: ${o.fpr} has status '${o.status === "completed" ? "Done" : "Cancel PO"}' which is not eligible for combining.`,
          blocking: false,
        });

      if (batchSize > 0 && Math.abs(combinedBasisVol % batchSize) > 0.001) {
        const rounded = Math.ceil(combinedBasisVol / batchSize) * batchSize;
        warnings.push({
          text: `Combined volume of ${fmtVolume(combinedBasisVol)} MT is not a multiple of the Batch Size (${fmtVolume(batchSize)}). The system will round up to ${fmtVolume(rounded)} MT.`,
          blocking: false,
        });
      }

      const isMash =
        String(form).toUpperCase() === "M" ||
        String(form).toLowerCase() === "mash";
      const combinedProdHours = calcProductionHoursLocal(combinedVol, runRate);
      const numBatches = batchSize > 0 ? Math.ceil(combinedVol / batchSize) : 0;
      const bagsPerMt = 20;
      const totalBags = Math.round(combinedVol * bagsPerMt);

      if (!isMash && runRate > 0 && combinedProdHours != null) {
        const changeoversEliminated = activeOrders.length - 1;
        const changeoverDurations = activeOrders.map(
          (o) => parseFloat(o.changeover_time) || 0.17,
        );
        const avgChangeoverHrs =
          changeoverDurations.reduce((s, v) => s + v, 0) /
          changeoverDurations.length;
        const totalChangeoverSaved = changeoversEliminated * avgChangeoverHrs;
        const individualProdHours = activeOrders.reduce((s, o) => {
          const ph = calcProductionHoursLocal(
            getEffVolume(o),
            parseFloat(o.run_rate) || runRate,
          );
          return s + (ph || 0);
        }, 0);
        const separateTime = individualProdHours + totalChangeoverSaved;
        const timeSaved = separateTime - combinedProdHours;

        const fmtMins = (hrs) => {
          const totalMin = Math.round(hrs * 60);
          if (totalMin < 60) return `${totalMin} min`;
          const h = Math.floor(totalMin / 60);
          const m = totalMin % 60;
          return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
        };

        productionSummary = {
          combinedVolume: fmtVolume(combinedVol),
          batchSize: fmtVolume(batchSize),
          numBatches,
          totalBags,
          productionTime: formatProdHours(combinedProdHours),
          changeoversEliminated,
          changeoverDuration: fmtMins(avgChangeoverHrs),
          totalChangeoverSaved: fmtMins(totalChangeoverSaved),
          separateTime: formatProdHours(parseFloat(separateTime.toFixed(2))),
          combinedTime: formatProdHours(combinedProdHours),
          timeSaved: fmtMins(timeSaved),
          timeSavedPositive: timeSaved > 0.001,
        };
      }

      const groupLine = activeOrders[0]?.feedmill_line;
      const allLineOrders = lineOrders
        .filter((o) => o.feedmill_line === groupLine)
        .sort(
          (a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity),
        );
      const groupIds = new Set(activeOrders.map((o) => o.id));

      const earliestIdx = Math.min(
        ...activeOrders.map((o) => {
          const idx = allLineOrders.findIndex((lo) => lo.id === o.id);
          return idx >= 0 ? idx : Infinity;
        }),
      );
      const leadOrder =
        earliestIdx < allLineOrders.length
          ? allLineOrders[earliestIdx]
          : activeOrders[0];
      const leadProdHours = calcProductionHoursLocal(
        getEffVolume(leadOrder),
        parseFloat(leadOrder.run_rate) || 0,
      );
      const leadCurrentCompletion = parseCompletionStr(
        leadOrder.target_completion_date,
      );

      const simulatedOrders = allLineOrders.filter((o) => !groupIds.has(o.id));
      const leadPlaceholder = {
        ...leadOrder,
        total_volume_mt: combinedVol,
        production_hours: combinedProdHours,
        _isLead: true,
      };
      simulatedOrders.splice(
        Math.min(earliestIdx, simulatedOrders.length),
        0,
        leadPlaceholder,
      );

      let prevCompletion = null;
      let leadCompletion = null;
      let downstreamImpacts = [];

      for (let i = 0; i < simulatedOrders.length; i++) {
        const o = { ...simulatedOrders[i] };
        if (i > 0 && prevCompletion) {
          o.start_date = `${prevCompletion.getFullYear()}-${String(prevCompletion.getMonth() + 1).padStart(2, "0")}-${String(prevCompletion.getDate()).padStart(2, "0")}`;
          o.start_time = `${String(prevCompletion.getHours()).padStart(2, "0")}:${String(prevCompletion.getMinutes()).padStart(2, "0")}`;
        }
        const ph = o._isLead
          ? combinedProdHours
          : calcProductionHoursLocal(
              getEffVolume(o),
              parseFloat(o.run_rate) || 0,
            );
        const co = parseFloat(o.changeover_time) ?? 0.17;
        const completionDate = calcCompletionDateLocal(
          o.start_date,
          o.start_time,
          ph,
          co,
        );
        prevCompletion = completionDate;

        if (o._isLead) leadCompletion = completionDate;

        if (!o._isLead && completionDate && !groupIds.has(o.id)) {
          const availStr = o.target_avail_date;
          if (availStr && !isNaN(Date.parse(availStr))) {
            const availDate = new Date(availStr);
            availDate.setHours(23, 59, 59, 999);
            if (completionDate > availDate) {
              const diffMs = completionDate.getTime() - availDate.getTime();
              const diffHours = Math.round(diffMs / 3600000);
              const exceedLabel =
                diffHours < 24
                  ? `${diffHours} hours`
                  : `${Math.round(diffHours / 24)} days`;
              warnings.push({
                text: `Combining will push downstream order FPR: ${o.fpr} (${o.item_description}) past its Avail Date by ${exceedLabel}.\nNew Completion: ${formatLongDateTime(completionDate)} → Avail Date: ${formatLongDate(o.target_avail_date)}`,
                blocking: true,
              });
            }
          }
          if (
            completionDate &&
            i === Math.min(earliestIdx, simulatedOrders.length - 1) + 1
          ) {
            const origCompletion = parseCompletionStr(o.target_completion_date);
            if (
              origCompletion &&
              completionDate.getTime() > origCompletion.getTime()
            ) {
              const delayMs =
                completionDate.getTime() - origCompletion.getTime();
              const delayHrs = Math.round(delayMs / 3600000);
              downstreamImpacts.push(
                `Combining will delay the next order (${o.item_description}, Prio ${o.priority_seq != null ? o.priority_seq : "?"}) by ~${delayHrs} hours.`,
              );
            }
          }
        }
      }

      if (runRate > 0 && combinedProdHours != null) {
        // Helper: simulate the cascade at a given insertion index and return the first delayed order
        const baseOrders = allLineOrders.filter((o) => !groupIds.has(o.id));
        const findDelayAtIdx = (insertIdx) => {
          const sim = [...baseOrders];
          const placeholder = {
            ...leadOrder,
            total_volume_mt: combinedVol,
            production_hours: combinedProdHours,
            _isLead: true,
          };
          sim.splice(Math.min(insertIdx, sim.length), 0, placeholder);
          let prev = null;
          for (let i = 0; i < sim.length; i++) {
            const o = { ...sim[i] };
            if (i > 0 && prev) {
              o.start_date = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-${String(prev.getDate()).padStart(2, "0")}`;
              o.start_time = `${String(prev.getHours()).padStart(2, "0")}:${String(prev.getMinutes()).padStart(2, "0")}`;
            }
            const ph = o._isLead
              ? combinedProdHours
              : calcProductionHoursLocal(
                  getEffVolume(o),
                  parseFloat(o.run_rate) || 0,
                );
            const co = parseFloat(o.changeover_time) ?? 0.17;
            const cd = calcCompletionDateLocal(
              o.start_date,
              o.start_time,
              ph,
              co,
            );
            prev = cd;
            if (!o._isLead && cd) {
              const availStr = o.target_avail_date;
              if (availStr && !isNaN(Date.parse(availStr))) {
                const avail = new Date(availStr);
                avail.setHours(23, 59, 59, 999);
                if (cd > avail) {
                  const diffHrs = Math.round(
                    (cd.getTime() - avail.getTime()) / 3600000,
                  );
                  return {
                    order: o,
                    delayHrs: diffHrs,
                    completionDate: cd,
                    availDate: avail,
                  };
                }
              }
            }
          }
          return null;
        };

        const hasStartDates = baseOrders.some((o) => o.start_date);
        const insertionPrio = Math.min(earliestIdx, baseOrders.length) + 1;

        let scenario,
          delayInfo = null,
          alternativePosition = null;

        if (!hasStartDates && !leadOrder.start_date) {
          scenario = "no_dates";
        } else {
          delayInfo = findDelayAtIdx(Math.min(earliestIdx, baseOrders.length));
          if (!delayInfo) {
            scenario = "no_delay";
          } else {
            // Try positions after the original to find a delay-free slot
            for (
              let pos = Math.min(earliestIdx, baseOrders.length) + 1;
              pos <= baseOrders.length;
              pos++
            ) {
              if (!findDelayAtIdx(pos)) {
                alternativePosition = pos + 1; // 1-based prio for display
                break;
              }
            }
            scenario = alternativePosition ? "delay_alt" : "delay_no_alt";
          }
        }

        schedulingImpact = {
          scenario,
          insertionPrio,
          delayInfo,
          alternativePosition,
          newCompletion: leadCompletion
            ? formatLongDateTime(leadCompletion)
            : "-",
          downstreamImpacts,
        };
      }

      const availDatesAll = activeOrders
        .map((o) => ({
          fpr: o.fpr,
          avail: o.target_avail_date,
          completion: parseCompletionStr(o.target_completion_date),
        }))
        .filter((d) => d.avail && !isNaN(Date.parse(d.avail)));
      if (availDatesAll.length >= 2) {
        const sorted = [...availDatesAll].sort(
          (a, b) => new Date(a.avail) - new Date(b.avail),
        );
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const firstAvail = new Date(first.avail);
        const lastAvail = new Date(last.avail);
        const daysDiff = Math.round((lastAvail - firstAvail) / (24 * 3600000));

        if (daysDiff >= 2 && first.completion) {
          const lastStart = new Date(lastAvail);
          lastStart.setHours(18, 0, 0, 0);
          const lastOrder = activeOrders.find((o) => o.fpr === last.fpr);
          if (lastOrder) {
            const lastPh =
              calcProductionHoursLocal(
                getEffVolume(lastOrder),
                parseFloat(lastOrder.run_rate) || 0,
              ) || 0;
            const lastCo = parseFloat(lastOrder.changeover_time) ?? 0.17;
            const reqStart = new Date(
              lastStart.getTime() - (lastPh + lastCo) * 3600000,
            );
            const gapMs = reqStart.getTime() - first.completion.getTime();
            const gapHours = gapMs / 3600000;

            if (gapHours > 1) {
              const nonDatedOrders = lineOrders.filter(
                (o) =>
                  o.feedmill_line === groupLine &&
                  !groupIds.has(o.id) &&
                  o.status !== "completed" &&
                  o.status !== "cancel_po" &&
                  (!o.target_avail_date ||
                    isNaN(Date.parse(o.target_avail_date))),
              );
              const fittingOrders = [];
              let usedHrs = 0;
              for (const nd of nonDatedOrders) {
                const ndPh =
                  (calcProductionHoursLocal(
                    getEffVolume(nd),
                    parseFloat(nd.run_rate) || 0,
                  ) || 0) + (parseFloat(nd.changeover_time) ?? 0.17);
                if (usedHrs + ndPh <= gapHours) {
                  fittingOrders.push({
                    item: nd.item_description || nd.fpr,
                    avail: nd.target_avail_date || "non-dated",
                    hours: formatProdHours(ndPh),
                  });
                  usedHrs += ndPh;
                }
              }
              const fillUtilization = gapHours > 0 ? usedHrs / gapHours : 0;
              // Only recommend keeping separate if non-dated orders meaningfully fill the gap (≥40%)
              if (fittingOrders.length > 0 && fillUtilization >= 0.4) {
                const availDiffMs = lastAvail - firstAvail;
                const availDiffHours = availDiffMs / 3600000;
                const availDateDiffLabel = availDiffHours >= 24
                  ? `${Math.floor(availDiffHours / 24)} day${Math.floor(availDiffHours / 24) !== 1 ? 's' : ''}${Math.round(availDiffHours % 24) > 0 ? ` ${Math.round(availDiffHours % 24)} hrs` : ''}`
                  : `${Math.round(availDiffHours)} hours`;
                const fillPct = Math.round(fillUtilization * 100);
                gapRecommendation = {
                  firstFpr: first.fpr,
                  lastFpr: last.fpr,
                  firstAvailDate: formatLongDate(first.avail),
                  lastAvailDate: formatLongDate(last.avail),
                  availDateDiffLabel,
                  firstCompletion: first.completion
                    ? formatLongDateTime(first.completion)
                    : "-",
                  lastReqStart: formatLongDateTime(reqStart),
                  gapLabel:
                    gapHours >= 24
                      ? `${Math.round(gapHours / 24)} days ${Math.round(gapHours % 24)} hours`
                      : `${Math.round(gapHours)} hours`,
                  fillPct,
                  fittingOrders,
                  totalFillTime: formatProdHours(usedHrs),
                };
              }
            }
          }
        }
      }

      const hasBlocker = warnings.some((w) => w.blocking);
      return {
        warnings,
        infos,
        hasBlocker,
        productionSummary,
        schedulingImpact,
        gapRecommendation,
      };
    },
    [lineOrders, activeFeedmill],
  );

  const triggerAISchedule = useCallback(
    (key, group, originalIdx) => {
      const { activeOrders } = resolveGroupStrategy(group, originalIdx);
      if (activeOrders.length < 2) return;
      setAiScheduleLoading((prev) => ({ ...prev, [key]: true }));

      const line = group[0]?.feedmill_line || '';
      const combinedBasisVolAI = activeOrders.reduce((s, o) => s + getCombineBasisVolume(o), 0);
      const batchSizeAI = parseFloat(activeOrders[0]?.batch_size) || 4;
      const combinedVolume = batchSizeAI > 0 ? Math.ceil(combinedBasisVolAI / batchSizeAI) * batchSizeAI : Number(combinedBasisVolAI.toFixed(2));
      const runRate = parseFloat(activeOrders[0]?.run_rate) || 0;
      const combinedProductionHours = runRate > 0 ? (combinedVolume / runRate).toFixed(2) : '0.00';

      const activeIds = new Set(activeOrders.map((o) => o.id));
      const allGroupLineOrders = lineOrders
        .filter((o) => o.feedmill_line === line && !['done', 'completed', 'cancel_po', 'cancelled'].includes((o.status || '').toLowerCase()))
        .sort((a, b) => (a.priority_seq ?? 999) - (b.priority_seq ?? 999));

      // Build a 1-based display rank map matching activeRankMap in OrderTable:
      // exclude child orders (parent_id set) so ranks match what the user sees in the Prio column
      const displayRankMap = new Map();
      let _displayRank = 0;
      for (const o of allGroupLineOrders) {
        if (!o.parent_id) { _displayRank++; displayRankMap.set(o.id, _displayRank); }
      }

      const isISODate = (d) => !!d && /^\d{4}-\d{2}-\d{2}/.test(d) && !isNaN(Date.parse(d));

      const datedOrders = activeOrders.filter((o) => isISODate(o.target_avail_date));
      let combinedAvailDate = null, availDateType = 'none';
      let expectedInsertionPrio = null;
      let insertionOrderId = null;
      if (datedOrders.length > 0) {
        // Dated: insertion at earliest avail date order's slot
        const earliest = [...datedOrders].sort((a, b) => new Date(a.target_avail_date) - new Date(b.target_avail_date))[0];
        combinedAvailDate = earliest.target_avail_date;
        expectedInsertionPrio = displayRankMap.get(earliest.id) ?? 1;
        insertionOrderId = earliest.id;
        availDateType = 'dated';
      } else {
        // Non-dated: insertion at lowest priority_seq (first in sequence) order's slot
        const lowestSeqOrder = [...activeOrders].sort((a, b) => (a.priority_seq ?? 999) - (b.priority_seq ?? 999))[0];
        combinedAvailDate = lowestSeqOrder?.target_avail_date || null;
        expectedInsertionPrio = displayRankMap.get(lowestSeqOrder?.id) ?? 1;
        insertionOrderId = lowestSeqOrder?.id ?? null;
        availDateType = 'priority_based';
      }

      const sortedActiveByRank = [...activeOrders].sort((a, b) => (displayRankMap.get(a.id) ?? 999) - (displayRankMap.get(b.id) ?? 999));
      // removedPrios = all ranks except the insertion slot
      const removedPrios = sortedActiveByRank
        .filter((o) => o.id !== insertionOrderId)
        .map((o) => displayRankMap.get(o.id) ?? '?');

      // Actual time saving for downstream orders:
      // The removed orders' production is ABSORBED into the combined order — not eliminated.
      // Only the changeover slots between the merged orders are freed.
      const separateProdTotal = activeOrders.reduce((s, o) => {
        const vol = getEffVolume(o);
        const rr = parseFloat(o.run_rate) || 0;
        return s + (rr > 0 ? vol / rr : 0);
      }, 0);
      const savedChangeoverHrs = sortedActiveByRank.slice(1).reduce((s, o) => {
        return s + (parseFloat(o.changeover_time) ?? 0.17);
      }, 0);
      const combinedProdFloat = runRate > 0 ? combinedVolume / runRate : 0;
      const netDownstreamShiftHrs = parseFloat(((separateProdTotal - combinedProdFloat) + savedChangeoverHrs).toFixed(2));

      // Simulate start times before and after combining to find interspersed impact
      const combineDisplayRanks = sortedActiveByRank.map(o => displayRankMap.get(o.id) ?? 999);
      const minCombineRank = Math.min(...combineDisplayRanks);
      const maxCombineRank = Math.max(...combineDisplayRanks);
      const leadOrder = sortedActiveByRank[0];
      const leadOutCo = parseFloat(leadOrder?.changeover_time) ?? 0.17;

      let simTBefore = 0;
      const beforeStart = {};
      for (const o of allGroupLineOrders) {
        const vol = getEffVolume(o); const rr = parseFloat(o.run_rate) || 0;
        beforeStart[o.id] = simTBefore;
        simTBefore += (rr > 0 ? vol / rr : 0) + (parseFloat(o.changeover_time) ?? 0.17);
      }
      let simTAfter = 0;
      const afterStart = {};
      let combinedBlockDone = false;
      for (const o of allGroupLineOrders) {
        if (activeIds.has(o.id)) {
          if (!combinedBlockDone) { simTAfter += combinedProdFloat + leadOutCo; combinedBlockDone = true; }
          continue;
        }
        const vol = getEffVolume(o); const rr = parseFloat(o.run_rate) || 0;
        afterStart[o.id] = simTAfter;
        simTAfter += (rr > 0 ? vol / rr : 0) + (parseFloat(o.changeover_time) ?? 0.17);
      }
      // Expand to ALL non-combine orders after the lead position (not just between members)
      // Include avail date + deadline miss check using lead order's real start date as reference
      const leadStartMs = leadOrder?.start_date ? new Date(leadOrder.start_date).getTime() : Date.now();
      const downstreamImpact = allGroupLineOrders
        .filter(o => { const rank = displayRankMap.get(o.id) ?? 999; return !activeIds.has(o.id) && rank > minCombineRank; })
        .map(o => {
          const shiftHrs = parseFloat(((beforeStart[o.id] ?? 0) - (afterStart[o.id] ?? 0)).toFixed(2));
          const vol = getEffVolume(o); const rr = parseFloat(o.run_rate) || 0; const prodHrs = rr > 0 ? vol / rr : 0;
          const availDate = isISODate(o.target_avail_date) ? o.target_avail_date : null;
          const projCompletionMs = leadStartMs + ((afterStart[o.id] ?? 0) + prodHrs) * 3600000;
          const willMissDeadline = availDate ? projCompletionMs > new Date(availDate).getTime() : false;
          const projCompletionDate = new Date(projCompletionMs);
          const newCompletion = projCompletionDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
          const newCompletionFull = `${newCompletion} ${projCompletionDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
          const delayMs = willMissDeadline && availDate ? projCompletionMs - new Date(availDate).getTime() : 0;
          const delayDays = willMissDeadline && availDate ? Math.ceil(delayMs / 86400000) : 0;
          const delayHrs = delayMs / 3600000;
          const delayFormatted = willMissDeadline ? formatTimeShift(delayHrs) : '';
          const availDateFmt = availDate ? new Date(availDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : null;
          const matCodeO = o.material_code || o.material_code_fg || '';
          const n10dO = inferredTargetMap[matCodeO] || null;
          const n10dStatusO = n10dO?.status || 'N/A';
          return { name: o.item_description || o.fpr || '—', fpr: o.fpr || '—', prio: displayRankMap.get(o.id) ?? '?', shiftHrs, availDate, availDateFmt, willMissDeadline, newCompletion, newCompletionFull, delayHrs, delayDays, delayFormatted, n10dStatus: n10dStatusO, isInterspersed: (displayRankMap.get(o.id) ?? 999) < maxCombineRank };
        });
      const interspersedImpact = downstreamImpact; // keep alias for AI prompt compat

      const matCode = activeOrders[0]?.material_code || activeOrders[0]?.material_code_fg || '';
      const n10dEntry = inferredTargetMap[matCode] || null;

      const lineContext = allGroupLineOrders.map((o, _i) => {
        const vol = getEffVolume(o);
        const rr = parseFloat(o.run_rate) || 0;
        const matC = o.material_code || o.material_code_fg || '';
        const n10dE = inferredTargetMap[matC] || null;
        return {
          prio: displayRankMap.get(o.id) ?? (_i + 1),
          name: o.item_description || '—',
          volume: vol.toFixed(0),
          prodHours: rr > 0 ? (vol / rr).toFixed(2) : '0.00',
          availDate: o.target_avail_date || null,
          completionDate: o.target_completion_date || '—',
          changeover: (parseFloat(o.changeover_time) ?? 0.17).toFixed(2),
          isBeingCombined: activeIds.has(o.id),
          n10dStatus: n10dE?.status || '—',
          color: o.pellet_color || o.color || '—',
          diameter: o.pellet_diameter || o.diameter || '—',
          category: o.category || '—',
        };
      });

      // Use typed deadline misses for alerts — same source as Scheduling Impact
      const calculatedAlerts = [];
      // Will be populated after calcImpact is built below (see after calcImpact definition)

      // Store simulation data immediately so bullet lists show before AI completes
      setAiScheduleInsights((prev) => ({
        ...prev,
        [key]: { ...(prev[key] || {}), downstreamImpact, minCombineRank, maxCombineRank, netDownstreamShiftHrs },
      }));

      const calcImpact = {
        laterOrders: downstreamImpact.filter(o => o.shiftHrs < 0).sort((a, b) => Math.abs(b.shiftHrs) - Math.abs(a.shiftHrs)).map(o => ({ prio: o.prio, name: o.name, shiftHrs: Math.abs(o.shiftHrs), shiftFormatted: formatTimeShift(Math.abs(o.shiftHrs)), n10dStatus: o.n10dStatus || 'N/A' })),
        earlierOrders: downstreamImpact.filter(o => o.shiftHrs > 0.01).sort((a, b) => b.shiftHrs - a.shiftHrs).map(o => ({ prio: o.prio, name: o.name, shiftHrs: o.shiftHrs, shiftFormatted: formatTimeShift(o.shiftHrs), n10dStatus: o.n10dStatus || 'N/A' })),
        deadlineMisses: [
          // TYPE 1: dated orders whose projected completion exceeds avail date
          ...downstreamImpact
            .filter(o => o.willMissDeadline)
            .map(o => ({ type: 'dated', prio: o.prio, name: o.name, fpr: o.fpr || '—', availDate: o.availDateFmt, availDateISO: o.availDate, newCompletion: o.newCompletion, newCompletionFull: o.newCompletionFull, delayHrs: o.delayHrs, delayFormatted: o.delayFormatted, delayDays: o.delayDays, n10dStatus: o.n10dStatus || 'N/A', shiftHrs: Math.abs(o.shiftHrs), shiftFormatted: formatTimeShift(Math.abs(o.shiftHrs)) })),
          // TYPE 2: non-dated Critical/Urgent orders being delayed by the combination
          ...downstreamImpact
            .filter(o => !o.availDate && o.shiftHrs < -0.01 && (o.n10dStatus === 'Critical' || o.n10dStatus === 'Urgent'))
            .map(o => ({ type: 'n10d_risk', prio: o.prio, name: o.name, fpr: o.fpr || '—', availDate: null, availDateISO: null, newCompletion: null, newCompletionFull: null, delayHrs: Math.abs(o.shiftHrs), delayFormatted: formatTimeShift(Math.abs(o.shiftHrs)), delayDays: null, n10dStatus: o.n10dStatus || 'N/A', shiftHrs: Math.abs(o.shiftHrs), shiftFormatted: formatTimeShift(Math.abs(o.shiftHrs)) })),
        ].sort((a, b) => {
          const so = { Critical: 0, Urgent: 1 };
          const aO = so[a.n10dStatus] ?? 2; const bO = so[b.n10dStatus] ?? 2;
          if (aO !== bO) return aO - bO;
          return (b.delayHrs || 0) - (a.delayHrs || 0);
        }),
      };

      // Populate typed alerts from calcImpact.deadlineMisses
      calcImpact.deadlineMisses.forEach(dm => {
        if (dm.type === 'dated') {
          calculatedAlerts.push({ type: 'deadline', orderName: dm.name, fpr: dm.fpr, prio: dm.prio, availDate: dm.availDateISO || '', newCompletionFull: dm.newCompletionFull, completionDate: dm.newCompletion, delayFormatted: dm.delayFormatted, delayDays: dm.delayDays });
        } else if (dm.type === 'n10d_risk') {
          calculatedAlerts.push({ type: 'n10d_risk', orderName: dm.name, fpr: dm.fpr, prio: dm.prio, n10dStatus: dm.n10dStatus, delayFormatted: dm.delayFormatted });
        }
      });
      if (combinedVolume > 200) calculatedAlerts.push({ type: 'volume_ceiling', message: `The combined total of ${combinedVolume.toFixed(0)} MT exceeds the recommended ceiling of 200 MT. Large combined orders may impact scheduling flexibility and downstream production.` });

      generateCombineSchedulingImpact({
        line,
        combiningOrders: activeOrders.map((o) => ({
          prio: displayRankMap.get(o.id) ?? '?',
          name: o.item_description || o.fpr || '—',
          volume: getEffVolume(o).toFixed(0),
          availDate: o.target_avail_date || null,
          form: o.form || '',
        })),
        combinedVolume: combinedVolume.toFixed(0),
        combinedProductionHours,
        combinedAvailDate,
        availDateType,
        expectedInsertionPrio,
        removedPrios,
        savedChangeoverHrs: savedChangeoverHrs.toFixed(2),
        netDownstreamShiftHrs,
        interspersedImpact,
        minCombineRank,
        maxCombineRank,
        n10dStatus: n10dEntry?.status || null,
        n10dDfl: n10dEntry?.dueForLoading ?? null,
        n10dInventory: n10dEntry?.inventory ?? null,
        lineContext,
        totalOrdersOnLine: allGroupLineOrders.length,
        calculatedAlerts,
        calculatedImpact: calcImpact,
      }).then((text) => {
        const parsed = parseCombineAnalysisResponse(text);
        parsed.insertionPosition = cleanInsertionResponse(parsed.insertionPosition);
        const rawParsed = parseSchedulingImpactResponse(parsed.schedulingImpact);
        const schedulingImpactParsed = rawParsed ? validateAndFixGrouping(rawParsed, calcImpact) : null;
        const hasAIParsedContent = schedulingImpactParsed && (
          schedulingImpactParsed.earlierSection.length > 0 ||
          schedulingImpactParsed.laterSection.length > 0 ||
          schedulingImpactParsed.deadlineSection.length > 0 ||
          schedulingImpactParsed.summary.length > 0
        );
        setAiScheduleInsights((prev) => ({
          ...prev,
          [key]: { ...parsed, schedulingImpactParsed: hasAIParsedContent ? schedulingImpactParsed : null, downstreamImpact, minCombineRank, maxCombineRank, netDownstreamShiftHrs },
        }));
        setAiScheduleLoading((prev) => ({ ...prev, [key]: false }));
      });
    },
    [resolveGroupStrategy, lineOrders, inferredTargetMap],
  );

  useEffect(() => {
    if (!isOpen) return;
    visibleGroups.forEach(({ group, originalIdx }) => {
      const key = getGroupKey(group);
      if (aiTriggeredRef.current.has(key)) return;
      const { activeOrders } = resolveGroupStrategy(group, originalIdx);
      if (activeOrders.length < 2) return;
      aiTriggeredRef.current.add(key);
      triggerAISchedule(key, group, originalIdx);
    });
  }, [isOpen, visibleGroups, getGroupKey, resolveGroupStrategy, triggerAISchedule]);

  const handleRefreshAISchedule = useCallback(
    (key, group, originalIdx) => {
      aiTriggeredRef.current.delete(key);
      aiTriggeredRef.current.add(key);
      triggerAISchedule(key, group, originalIdx);
    },
    [triggerAISchedule],
  );

  const handleRefreshSection = useCallback(
    (key, group, originalIdx, section) => {
      const sectionKey = `${key}_${section}`;
      setAiSectionLoading((prev) => ({ ...prev, [sectionKey]: true }));

      const { activeOrders } = resolveGroupStrategy(group, originalIdx);
      if (activeOrders.length < 2) { setAiSectionLoading((prev) => ({ ...prev, [sectionKey]: false })); return; }

      const line = group[0]?.feedmill_line || '';
      const combinedBasisVolAIS = activeOrders.reduce((s, o) => s + getCombineBasisVolume(o), 0);
      const batchSizeAIS = parseFloat(activeOrders[0]?.batch_size) || 4;
      const combinedVolume = batchSizeAIS > 0 ? Math.ceil(combinedBasisVolAIS / batchSizeAIS) * batchSizeAIS : Number(combinedBasisVolAIS.toFixed(2));
      const runRate = parseFloat(activeOrders[0]?.run_rate) || 0;
      const combinedProductionHours = runRate > 0 ? (combinedVolume / runRate).toFixed(2) : '0.00';
      const activeIds = new Set(activeOrders.map((o) => o.id));
      const allGroupLineOrders = lineOrders
        .filter((o) => o.feedmill_line === line && !['done', 'completed', 'cancel_po', 'cancelled'].includes((o.status || '').toLowerCase()))
        .sort((a, b) => (a.priority_seq ?? 999) - (b.priority_seq ?? 999));

      // Build a 1-based display rank map matching activeRankMap in OrderTable:
      // exclude child orders (parent_id set) so ranks match what the user sees in the Prio column
      const displayRankMap = new Map();
      let _displayRank = 0;
      for (const o of allGroupLineOrders) {
        if (!o.parent_id) { _displayRank++; displayRankMap.set(o.id, _displayRank); }
      }

      const isISODateR = (d) => !!d && /^\d{4}-\d{2}-\d{2}/.test(d) && !isNaN(Date.parse(d));

      const datedOrders = activeOrders.filter((o) => isISODateR(o.target_avail_date));
      let combinedAvailDate = null, availDateType = 'none';
      let expectedInsertionPrio = null;
      let insertionOrderId = null;
      if (datedOrders.length > 0) {
        // Dated: insertion at earliest avail date order's slot
        const earliest = [...datedOrders].sort((a, b) => new Date(a.target_avail_date) - new Date(b.target_avail_date))[0];
        combinedAvailDate = earliest.target_avail_date;
        expectedInsertionPrio = displayRankMap.get(earliest.id) ?? 1;
        insertionOrderId = earliest.id;
        availDateType = 'dated';
      } else {
        // Non-dated: insertion at lowest priority_seq (first in sequence) order's slot
        const lowestSeqOrder = [...activeOrders].sort((a, b) => (a.priority_seq ?? 999) - (b.priority_seq ?? 999))[0];
        combinedAvailDate = lowestSeqOrder?.target_avail_date || null;
        expectedInsertionPrio = displayRankMap.get(lowestSeqOrder?.id) ?? 1;
        insertionOrderId = lowestSeqOrder?.id ?? null;
        availDateType = 'priority_based';
      }
      const sortedActiveByRank = [...activeOrders].sort((a, b) => (displayRankMap.get(a.id) ?? 999) - (displayRankMap.get(b.id) ?? 999));
      // removedPrios = all ranks except the insertion slot
      const removedPrios = sortedActiveByRank
        .filter((o) => o.id !== insertionOrderId)
        .map((o) => displayRankMap.get(o.id) ?? '?');
      const separateProdTotal2 = activeOrders.reduce((s, o) => {
        const vol = getEffVolume(o); const rr = parseFloat(o.run_rate) || 0;
        return s + (rr > 0 ? vol / rr : 0);
      }, 0);
      const savedChangeoverHrs2 = sortedActiveByRank.slice(1).reduce((s, o) => s + (parseFloat(o.changeover_time) ?? 0.17), 0);
      const combinedProdFloat2 = runRate > 0 ? combinedVolume / runRate : 0;
      const netDownstreamShiftHrs2 = parseFloat(((separateProdTotal2 - combinedProdFloat2) + savedChangeoverHrs2).toFixed(2));

      const combineDisplayRanks2 = sortedActiveByRank.map(o => displayRankMap.get(o.id) ?? 999);
      const minCombineRank2 = Math.min(...combineDisplayRanks2);
      const maxCombineRank2 = Math.max(...combineDisplayRanks2);
      const leadOrder2 = sortedActiveByRank[0];
      const leadOutCo2 = parseFloat(leadOrder2?.changeover_time) ?? 0.17;
      let simTBefore2 = 0; const beforeStart2 = {};
      for (const o of allGroupLineOrders) { const vol = getEffVolume(o); const rr = parseFloat(o.run_rate) || 0; beforeStart2[o.id] = simTBefore2; simTBefore2 += (rr > 0 ? vol / rr : 0) + (parseFloat(o.changeover_time) ?? 0.17); }
      let simTAfter2 = 0; const afterStart2 = {}; let combinedBlockDone2 = false;
      for (const o of allGroupLineOrders) {
        if (activeIds.has(o.id)) { if (!combinedBlockDone2) { simTAfter2 += combinedProdFloat2 + leadOutCo2; combinedBlockDone2 = true; } continue; }
        const vol = getEffVolume(o); const rr = parseFloat(o.run_rate) || 0;
        afterStart2[o.id] = simTAfter2; simTAfter2 += (rr > 0 ? vol / rr : 0) + (parseFloat(o.changeover_time) ?? 0.17);
      }
      const leadStartMs2 = leadOrder2?.start_date ? new Date(leadOrder2.start_date).getTime() : Date.now();
      const isISODate2 = (d) => !!d && /^\d{4}-\d{2}-\d{2}/.test(d) && !isNaN(Date.parse(d));
      const downstreamImpact2 = allGroupLineOrders
        .filter(o => { const rank = displayRankMap.get(o.id) ?? 999; return !activeIds.has(o.id) && rank > minCombineRank2; })
        .map(o => {
          const shiftHrs = parseFloat(((beforeStart2[o.id] ?? 0) - (afterStart2[o.id] ?? 0)).toFixed(2));
          const vol = getEffVolume(o); const rr = parseFloat(o.run_rate) || 0; const prodHrs = rr > 0 ? vol / rr : 0;
          const availDate = isISODate2(o.target_avail_date) ? o.target_avail_date : null;
          const projCompletionMs = leadStartMs2 + ((afterStart2[o.id] ?? 0) + prodHrs) * 3600000;
          const willMissDeadline = availDate ? projCompletionMs > new Date(availDate).getTime() : false;
          const projCompletionDate = new Date(projCompletionMs);
          const newCompletion = projCompletionDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
          const newCompletionFull = `${newCompletion} ${projCompletionDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
          const delayMs2 = willMissDeadline && availDate ? projCompletionMs - new Date(availDate).getTime() : 0;
          const delayDays = willMissDeadline && availDate ? Math.ceil(delayMs2 / 86400000) : 0;
          const delayHrs2 = delayMs2 / 3600000;
          const delayFormatted = willMissDeadline ? formatTimeShift(delayHrs2) : '';
          const availDateFmt = availDate ? new Date(availDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : null;
          const matCodeO2 = o.material_code || o.material_code_fg || '';
          const n10dO2 = inferredTargetMap[matCodeO2] || null;
          const n10dStatusO2 = n10dO2?.status || 'N/A';
          return { name: o.item_description || o.fpr || '—', fpr: o.fpr || '—', prio: displayRankMap.get(o.id) ?? '?', shiftHrs, availDate, availDateFmt, willMissDeadline, newCompletion, newCompletionFull, delayHrs: delayHrs2, delayDays, delayFormatted, n10dStatus: n10dStatusO2, isInterspersed: (displayRankMap.get(o.id) ?? 999) < maxCombineRank2 };
        });
      const interspersedImpact2 = downstreamImpact2; // keep alias for compat

      const matCode = activeOrders[0]?.material_code || activeOrders[0]?.material_code_fg || '';
      const n10dEntry = inferredTargetMap[matCode] || null;
      const lineContext = allGroupLineOrders.map((o, _i) => {
        const vol = getEffVolume(o); const rr = parseFloat(o.run_rate) || 0;
        const matC = o.material_code || o.material_code_fg || '';
        const n10dE = inferredTargetMap[matC] || null;
        return { prio: displayRankMap.get(o.id) ?? (_i + 1), name: o.item_description || '—', volume: vol.toFixed(0), prodHours: rr > 0 ? (vol / rr).toFixed(2) : '0.00', availDate: o.target_avail_date || null, completionDate: o.target_completion_date || '—', changeover: (parseFloat(o.changeover_time) ?? 0.17).toFixed(2), isBeingCombined: activeIds.has(o.id), n10dStatus: n10dE?.status || '—', color: o.pellet_color || o.color || '—', diameter: o.pellet_diameter || o.diameter || '—', category: o.category || '—' };
      });
      // Store simulation data immediately so bullet lists render before AI completes
      if (section === 'scheduling') {
        setAiScheduleInsights((prev) => ({
          ...prev,
          [key]: { ...(prev[key] || {}), downstreamImpact: downstreamImpact2, minCombineRank: minCombineRank2, maxCombineRank: maxCombineRank2, netDownstreamShiftHrs: netDownstreamShiftHrs2 },
        }));
      }

      const calcImpact2 = {
        laterOrders: downstreamImpact2.filter(o => o.shiftHrs < 0).sort((a, b) => Math.abs(b.shiftHrs) - Math.abs(a.shiftHrs)).map(o => ({ prio: o.prio, name: o.name, shiftHrs: Math.abs(o.shiftHrs), shiftFormatted: formatTimeShift(Math.abs(o.shiftHrs)), n10dStatus: o.n10dStatus || 'N/A' })),
        earlierOrders: downstreamImpact2.filter(o => o.shiftHrs > 0.01).sort((a, b) => b.shiftHrs - a.shiftHrs).map(o => ({ prio: o.prio, name: o.name, shiftHrs: o.shiftHrs, shiftFormatted: formatTimeShift(o.shiftHrs), n10dStatus: o.n10dStatus || 'N/A' })),
        deadlineMisses: [
          ...downstreamImpact2
            .filter(o => o.willMissDeadline)
            .map(o => ({ type: 'dated', prio: o.prio, name: o.name, fpr: o.fpr || '—', availDate: o.availDateFmt, availDateISO: o.availDate, newCompletion: o.newCompletion, newCompletionFull: o.newCompletionFull, delayHrs: o.delayHrs, delayFormatted: o.delayFormatted, delayDays: o.delayDays, n10dStatus: o.n10dStatus || 'N/A', shiftHrs: Math.abs(o.shiftHrs), shiftFormatted: formatTimeShift(Math.abs(o.shiftHrs)) })),
          ...downstreamImpact2
            .filter(o => !o.availDate && o.shiftHrs < -0.01 && (o.n10dStatus === 'Critical' || o.n10dStatus === 'Urgent'))
            .map(o => ({ type: 'n10d_risk', prio: o.prio, name: o.name, fpr: o.fpr || '—', availDate: null, availDateISO: null, newCompletion: null, newCompletionFull: null, delayHrs: Math.abs(o.shiftHrs), delayFormatted: formatTimeShift(Math.abs(o.shiftHrs)), delayDays: null, n10dStatus: o.n10dStatus || 'N/A', shiftHrs: Math.abs(o.shiftHrs), shiftFormatted: formatTimeShift(Math.abs(o.shiftHrs)) })),
        ].sort((a, b) => {
          const so = { Critical: 0, Urgent: 1 };
          const aO = so[a.n10dStatus] ?? 2; const bO = so[b.n10dStatus] ?? 2;
          if (aO !== bO) return aO - bO;
          return (b.delayHrs || 0) - (a.delayHrs || 0);
        }),
      };

      // Populate typed alerts from calcImpact2.deadlineMisses
      const calculatedAlerts = [];
      calcImpact2.deadlineMisses.forEach(dm => {
        if (dm.type === 'dated') {
          calculatedAlerts.push({ type: 'deadline', orderName: dm.name, fpr: dm.fpr, prio: dm.prio, availDate: dm.availDateISO || '', newCompletionFull: dm.newCompletionFull, completionDate: dm.newCompletion, delayFormatted: dm.delayFormatted, delayDays: dm.delayDays });
        } else if (dm.type === 'n10d_risk') {
          calculatedAlerts.push({ type: 'n10d_risk', orderName: dm.name, fpr: dm.fpr, prio: dm.prio, n10dStatus: dm.n10dStatus, delayFormatted: dm.delayFormatted });
        }
      });
      if (combinedVolume > 200) calculatedAlerts.push({ type: 'volume_ceiling', message: `The combined total of ${combinedVolume.toFixed(0)} MT exceeds the recommended ceiling of 200 MT. Large combined orders may impact scheduling flexibility and downstream production.` });

      generateCombineSchedulingImpact({
        line, combiningOrders: activeOrders.map((o) => ({ prio: displayRankMap.get(o.id) ?? '?', name: o.item_description || o.fpr || '—', volume: getEffVolume(o).toFixed(0), availDate: o.target_avail_date || null, form: o.form || '' })),
        combinedVolume: combinedVolume.toFixed(0), combinedProductionHours, combinedAvailDate, availDateType, expectedInsertionPrio, removedPrios,
        savedChangeoverHrs: savedChangeoverHrs2.toFixed(2), netDownstreamShiftHrs: netDownstreamShiftHrs2,
        interspersedImpact: interspersedImpact2, minCombineRank: minCombineRank2, maxCombineRank: maxCombineRank2,
        n10dStatus: n10dEntry?.status || null, n10dDfl: n10dEntry?.dueForLoading ?? null, n10dInventory: n10dEntry?.inventory ?? null,
        lineContext, totalOrdersOnLine: allGroupLineOrders.length, calculatedAlerts,
        calculatedImpact: calcImpact2,
      }).then((text) => {
        const parsed = parseCombineAnalysisResponse(text);
        let schedulingImpactParsed2 = null;
        if (section === 'scheduling') {
          const rawP = parseSchedulingImpactResponse(parsed.schedulingImpact);
          const validated = rawP ? validateAndFixGrouping(rawP, calcImpact2) : null;
          const hasContent = validated && (validated.earlierSection.length > 0 || validated.laterSection.length > 0 || validated.deadlineSection.length > 0 || validated.summary.length > 0);
          schedulingImpactParsed2 = hasContent ? validated : null;
        }
        setAiScheduleInsights((prev) => ({
          ...prev,
          [key]: {
            ...(prev[key] || {}),
            ...(section === 'insertion' ? { insertionPosition: cleanInsertionResponse(parsed.insertionPosition), recommendedPrio: parsed.recommendedPrio } :
               section === 'scheduling' ? { schedulingImpact: parsed.schedulingImpact, schedulingImpactParsed: schedulingImpactParsed2, downstreamImpact: downstreamImpact2, minCombineRank: minCombineRank2, maxCombineRank: maxCombineRank2, netDownstreamShiftHrs: netDownstreamShiftHrs2 } :
               { alerts: parsed.alerts }),
          },
        }));
        setAiSectionLoading((prev) => ({ ...prev, [sectionKey]: false }));
      }).catch(() => {
        setAiSectionLoading((prev) => ({ ...prev, [sectionKey]: false }));
      });
    },
    [resolveGroupStrategy, lineOrders, inferredTargetMap],
  );

  const renderGroupCard = (group, groupIdx, vIdx) => {
    const {
      strategies,
      selectedStratId,
      activeOrders,
      stratExcluded,
      manualExcluded: manualExcludedOrders,
    } = resolveGroupStrategy(group, groupIdx);
    const combinedBasisVolUI = activeOrders.reduce((s, o) => s + getCombineBasisVolume(o), 0);
    const batchSizeUI = parseFloat(activeOrders[0]?.batch_size) || 4;
    const combinedVol = batchSizeUI > 0 ? Math.ceil(combinedBasisVolUI / batchSizeUI) * batchSizeUI : Number(combinedBasisVolUI.toFixed(2));
    const insights = generateInsights(activeOrders);
    const canApprove = activeOrders.length >= 2 && !insights.hasBlocker;
    const groupKey = getGroupKey(group);
    const aiSchedParsed = aiScheduleInsights[groupKey] || null;
    const aiSchedLoading = !!aiScheduleLoading[groupKey];
    const insertionLoading = aiSchedLoading || !!aiSectionLoading[`${groupKey}_insertion`];
    const schedulingLoading = aiSchedLoading || !!aiSectionLoading[`${groupKey}_scheduling`];
    const alertsLoading = aiSchedLoading || !!aiSectionLoading[`${groupKey}_alerts`];
    const approveTooltip =
      activeOrders.length < 2
        ? "At least 2 orders are required to combine."
        : insights.hasBlocker
          ? "Resolve warnings before combining."
          : null;

    const line = group[0]?.feedmill_line || '';
    const allGroupLineOrdersForRank = lineOrders
      .filter((o) => o.feedmill_line === line && !['done', 'completed', 'cancel_po', 'cancelled'].includes((o.status || '').toLowerCase()))
      .sort((a, b) => (a.priority_seq ?? 999) - (b.priority_seq ?? 999));
    const displayRankMap = new Map();
    let _rankIdx = 0;
    for (const o of allGroupLineOrdersForRank) {
      if (!o.parent_id) { _rankIdx++; displayRankMap.set(o.id, _rankIdx); }
    }

    return (
      <div
        key={groupIdx}
        className="bg-white border border-[#e5e7eb] rounded-lg overflow-hidden"
        style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.05)", marginBottom: 0 }}
        data-testid={`card-combine-group-${groupIdx}`}
      >
        <div
          style={{ padding: "12px 16px", borderBottom: "1px solid #f3f4f6" }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 13,
              fontWeight: 600,
              color: "#1a1a1a",
            }}
          >
            {group[0].item_description || "—"}
            <span style={{ color: "#d1d5db" }}> | </span>
            <span style={{ fontSize: 12, fontWeight: 400, color: "#6b7280" }}>
              Combine Group {groupIdx + 1}
            </span>
          </p>
        </div>

        {/* Strategy Picker */}
        {strategies.length > 1 && (
          <div
            style={{
              padding: "10px 16px",
              borderBottom: "1px solid #f3f4f6",
              background: "#fafafa",
            }}
          >
            <p
              style={{
                fontSize: 10,
                color: "#6b7280",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                marginBottom: 6,
              }}
            >
              Combine Strategy
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {strategies.map((s) => {
                const isSelected = selectedStratId === s.id;
                const stars = "★".repeat(s.stars) + "☆".repeat(4 - s.stars);
                return (
                  <button
                    key={s.id}
                    onClick={() => handleSelectStrategy(groupIdx, s.id, group)}
                    data-testid={`button-strategy-${groupIdx}-${s.id}`}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      padding: "7px 10px",
                      borderRadius: 6,
                      textAlign: "left",
                      border: isSelected
                        ? s.hasConflict
                          ? "1.5px solid #e53935"
                          : "1.5px solid var(--nexfeed-primary)"
                        : "1.5px solid #e5e7eb",
                      background: isSelected
                        ? s.hasConflict
                          ? "#fff5f5"
                          : "#fff5ed"
                        : "#fff",
                      cursor: "pointer",
                      transition: "all 0.15s",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                          marginBottom: 1,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: isSelected
                              ? s.hasConflict
                                ? "#e53935"
                                : "var(--nexfeed-primary)"
                              : "#374151",
                          }}
                        >
                          {s.label}
                        </span>
                        {s.recommended && (
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 600,
                              color: "#fff",
                              background: "#43a047",
                              padding: "1px 5px",
                              borderRadius: 3,
                            }}
                          >
                            BEST
                          </span>
                        )}
                        {s.hasConflict ? (
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 600,
                              color: "#e53935",
                              background: "#fef2f2",
                              border: "1px solid #fecaca",
                              padding: "1px 5px",
                              borderRadius: 3,
                            }}
                          >
                            ⚠ CONFLICT
                          </span>
                        ) : (
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 600,
                              color: "#16a34a",
                              background: "#f0fdf4",
                              border: "1px solid #bbf7d0",
                              padding: "1px 5px",
                              borderRadius: 3,
                            }}
                          >
                            ✓ SAFE
                          </span>
                        )}
                      </div>
                      <span
                        style={{
                          fontSize: 10,
                          color: "#6b7280",
                          display: "block",
                          lineHeight: "1.4",
                        }}
                      >
                        {s.description}
                      </span>
                      {s.note && (
                        <span
                          style={{
                            fontSize: 9,
                            color: "#9ca3af",
                            fontStyle: "italic",
                            display: "block",
                            marginTop: 1,
                          }}
                        >
                          {s.note}
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: s.hasConflict
                          ? "#d1d5db"
                          : s.stars >= 4
                            ? "#f59e0b"
                            : "#a3a3a3",
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                        marginTop: 1,
                      }}
                    >
                      {stars}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div
          style={{
            padding: "12px 16px",
            display: "grid",
            gridTemplateColumns: "160px 1fr",
            rowGap: 8,
            columnGap: 16,
            borderBottom: "1px solid #f3f4f6",
          }}
        >
          {[
            ["Material Code (FG)", group[0].material_code || "—"],
            ["Material Code (SFG)", group[0].kb_sfg_material_code || "—"],
            ["Line", group[0].feedmill_line || "—"],
            ["Formula Version", group[0].formula_version || "—"],
          ].map(([label, val]) => (
            <div key={label} style={{ display: "contents" }}>
              <span
                style={{
                  fontSize: 12,
                  color: "#6b7280",
                  fontWeight: 400,
                  whiteSpace: "nowrap",
                }}
              >
                {label}:
              </span>
              <span
                style={{ fontSize: 12, color: "#1a1a1a", fontWeight: 600 }}
                title={String(val)}
              >
                {val}
              </span>
            </div>
          ))}
        </div>
        <div className="px-4 py-2 space-y-0">
          {activeOrders.length === 0 ? (
            <p className="text-xs text-gray-400 py-3 text-center">
              No orders selected. Re-add orders to proceed.
            </p>
          ) : (
            [...activeOrders].sort((a, b) => (displayRankMap.get(a.id) ?? 999) - (displayRankMap.get(b.id) ?? 999)).map((o) => {
              const availDate = o.target_avail_date;
              const isNonDate = availDate && isNaN(Date.parse(availDate));
              const isNewOrder = hasNewFprs && newFprValues.has(o.fpr);
              const completionD = parseCompletionStr(o.target_completion_date);
              return (
                <div
                  key={o.id}
                  className="relative border-b border-gray-200 last:border-0"
                  style={{ padding: "10px 24px 10px 0" }}
                  data-testid={`row-active-order-${o.id}`}
                >
                  {hasNewFprs && (
                    <span
                      className={cn(
                        "inline-block text-[9px] font-semibold px-1.5 py-0.5 rounded text-white mb-1.5",
                        isNewOrder ? "bg-[#43a047]" : "bg-[#a1a8b3]",
                      )}
                      data-testid={`badge-order-${o.id}`}
                    >
                      {isNewOrder ? "NEW ORDER" : "EXISTING ORDER"}
                    </span>
                  )}
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    {/* Prio badge */}
                    <div style={{ flexShrink: 0, paddingTop: 2 }}>
                      <span className="combine-order-prio-badge">
                        {displayRankMap.get(o.id) ?? '?'}
                      </span>
                    </div>
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: "grid",
                      gridTemplateColumns: "120px 1fr auto",
                      gap: 8,
                      alignItems: "start",
                    }}
                  >
                    {/* Left — FPR details (fixed 120px) */}
                    <div className="space-y-[1px] min-w-0 pl-1">
                      <p className="text-[11px] font-semibold text-[#1a1a1a]">
                        FPR: {o.fpr}
                      </p>
                      <p className="text-[9px] text-[#9ca3af]">
                        FG: {o.fg || "—"}
                      </p>
                      <p className="text-[9px] text-[#9ca3af]">
                        SFG: {o.sfg || "—"}
                      </p>
                      {o.pmx && (
                        <p className="text-[9px] text-[#9ca3af]">
                          PMX: {o.pmx}
                        </p>
                      )}
                    </div>
                    {/* Middle — Time details (1fr flexible) */}
                    <div className="space-y-[1px] min-w-0">
                      <p className="text-[11px] font-semibold text-[#1a1a1a]">
                        {formatProdHours(o.production_hours)}
                      </p>
                      <p className="text-[9px] text-[#9ca3af]">
                        CD:{" "}
                        {completionD
                          ? formatCompletionDateOnly(completionD)
                          : "—"}
                      </p>
                      <p className="text-[9px] text-[#9ca3af]">
                        CT:{" "}
                        {completionD
                          ? formatCompletionTimeOnly(completionD)
                          : "—"}
                      </p>
                    </div>
                    {/* Right — Volume and Availability (auto, right-aligned) */}
                    <div className="space-y-[1px] text-right">
                      <p className="text-[11px] font-bold text-[#1a1a1a]">
                        {fmtVolume(getEffVolume(o))} MT
                      </p>
                      <p className="text-[9px] text-[#9ca3af]">Availability</p>
                      <p
                        className={cn(
                          "text-[9px] font-medium",
                          isNonDate ? "text-[#ea580c]" : "text-[#9ca3af]",
                        )}
                      >
                        {availDate
                          ? isNonDate
                            ? availDate
                            : formatLongDate(availDate)
                          : "—"}
                      </p>
                    </div>
                  </div>
                  </div>
                  {/* × button — absolute top-right */}
                  <button
                    onClick={() => handleExclude(groupIdx, o.id, group)}
                    className="absolute top-2.5 right-1.5 p-0.5 rounded hover:bg-red-50 text-[#a1a8b3] hover:text-[#e53935] transition-colors"
                    data-testid={`button-exclude-order-${o.id}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="px-4 py-2.5 bg-[#fff5ed] border-t border-orange-100">
          <p className="text-xs font-bold text-[var(--nexfeed-primary)]">
            Combined Volume: {fmtVolume(combinedVol)} MT
          </p>
        </div>
        {(stratExcluded.length > 0 || manualExcludedOrders.length > 0) && (
          <div className="border-t border-gray-100">
            <div className="px-4 pt-2 pb-1">
              <p className="text-[11px] text-[#a1a8b3] font-medium">
                Not included in this strategy
              </p>
            </div>
            <div className="px-4 pb-2 space-y-1">
              {[...stratExcluded].sort((a, b) => (displayRankMap.get(a.id) ?? 999) - (displayRankMap.get(b.id) ?? 999)).map((o) => (
                <div
                  key={o.id}
                  className="flex items-center gap-2 opacity-40"
                  data-testid={`row-strat-excluded-order-${o.id}`}
                >
                  <span className="combine-order-prio-badge combine-order-prio-badge-excluded shrink-0">
                    {displayRankMap.get(o.id) ?? '?'}
                  </span>
                  <span className="text-[10px] text-gray-400 shrink-0">
                    Strategy
                  </span>
                  <span className="text-[11px] text-gray-400 line-through">
                    FPR: {o.fpr} — {fmtVolume(getEffVolume(o))} MT
                  </span>
                </div>
              ))}
              {[...manualExcludedOrders].sort((a, b) => (displayRankMap.get(a.id) ?? 999) - (displayRankMap.get(b.id) ?? 999)).map((o) => (
                <div
                  key={o.id}
                  className="flex items-center gap-2 opacity-50"
                  data-testid={`row-excluded-order-${o.id}`}
                >
                  <span className="combine-order-prio-badge combine-order-prio-badge-excluded shrink-0">
                    {displayRankMap.get(o.id) ?? '?'}
                  </span>
                  <button
                    onClick={() => handleReadd(groupIdx, o.id, group)}
                    className="flex items-center gap-0.5 text-[11px] text-blue-500 hover:text-blue-700 font-medium shrink-0 transition-colors"
                    data-testid={`button-readd-order-${o.id}`}
                  >
                    <Plus className="h-3 w-3" />
                    Re-add
                  </button>
                  <span className="text-[11px] text-gray-500 line-through">
                    FPR: {o.fpr} — {fmtVolume(getEffVolume(o))} MT
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {activeOrders.length >= 2 && (
          <div className="border-t border-gray-100">
            <div
              className="px-4 pb-2.5 space-y-2 max-h-[400px] overflow-y-auto"
              data-testid={`section-insights-${groupIdx}`}
            >
              {insights.productionSummary && (
                <div className="rounded-md bg-[#f0f4ff] px-3 py-2.5 mt-2">
                  <p className="text-[10px] font-bold text-[#2e343a] mb-1.5">
                    📊 Combined Production Summary
                  </p>
                  <div className="space-y-0.5">
                    {[
                      [
                        "Combined Volume",
                        `${insights.productionSummary.combinedVolume} MT`,
                      ],
                      [
                        "Batch Size",
                        `${insights.productionSummary.batchSize} MT`,
                      ],
                      [
                        "Number of Batches",
                        insights.productionSummary.numBatches,
                      ],
                      ["Total Bags", insights.productionSummary.totalBags],
                    ].map(([label, val]) => (
                      <div key={label} className="flex justify-between">
                        <span className="text-[10px] text-gray-500">
                          {label}
                        </span>
                        <span className="text-[10px] font-semibold text-[#2e343a]">
                          {val}
                        </span>
                      </div>
                    ))}
                    <div className="border-t border-gray-200 my-1" />
                    <div className="flex justify-between">
                      <span className="text-[10px] text-gray-500">
                        Production Time (separate)
                      </span>
                      <span className="text-[10px] font-semibold text-[#2e343a]">
                        {insights.productionSummary.separateTime}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[10px] text-gray-500">
                        Production Time (combined)
                      </span>
                      <span className="text-[10px] font-semibold text-[#2e343a]">
                        {insights.productionSummary.combinedTime}
                      </span>
                    </div>
                  </div>
                  {insights.productionSummary.changeoversEliminated > 0 && (
                    <div className="mt-2 pt-1.5 border-t border-blue-200">
                      <p className="text-[10px] font-bold text-[#2e343a] mb-1">
                        ⏱ Changeover Savings
                      </p>
                      <div className="space-y-0.5">
                        <div className="flex justify-between">
                          <span className="text-[10px] text-gray-500">
                            Changeovers eliminated
                          </span>
                          <span className="text-[10px] font-semibold text-[#2e343a]">
                            {insights.productionSummary.changeoversEliminated} ×{" "}
                            {insights.productionSummary.changeoverDuration} ={" "}
                            {insights.productionSummary.totalChangeoverSaved}
                          </span>
                        </div>
                        {insights.productionSummary.timeSavedPositive && (
                          <div className="flex justify-between items-center">
                            <span className="text-[10px] text-gray-500">
                              Total time saved
                            </span>
                            <span
                              className="text-[10px] font-semibold"
                              style={{ color: "#43a047" }}
                            >
                              ✅ {insights.productionSummary.timeSaved} saved
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {activeOrders.length >= 2 && (
                <>
                  {/* Card: Insertion Position — mint green tint */}
                  <div className="rounded-md bg-[#f0fdf4] px-3 py-2.5">
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="text-[10px] font-bold text-[#2e343a]">📍 Insertion Position</p>
                      <button
                        onClick={() => handleRefreshSection(groupKey, group, groupIdx, 'insertion')}
                        disabled={insertionLoading}
                        data-testid={`button-refresh-insertion-${groupIdx}`}
                        className="text-[10px] text-gray-400 hover:text-[#2e343a] disabled:opacity-40 disabled:cursor-not-allowed transition-colors bg-transparent border-0 cursor-pointer p-0"
                      >↻ Refresh</button>
                    </div>
                    {insertionLoading && !aiSchedParsed?.insertionPosition ? (
                      <p className="text-[10px] text-gray-400 italic">Analyzing optimal position...</p>
                    ) : insertionLoading ? (
                      <p className="text-[10px] text-gray-400 italic">Updating...</p>
                    ) : (
                      <p className="text-[10px] text-[#2e343a] leading-relaxed">
                        {aiSchedParsed?.insertionPosition || 'Click Refresh to generate.'}
                      </p>
                    )}
                  </div>

                  {/* Card: Scheduling Impact — soft lavender tint */}
                  <div className="rounded-md bg-[#f5f3ff] px-3 py-2.5">
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="text-[10px] font-bold text-[#2e343a]">📊 Scheduling Impact</p>
                      <button
                        onClick={() => handleRefreshSection(groupKey, group, groupIdx, 'scheduling')}
                        disabled={schedulingLoading}
                        data-testid={`button-refresh-scheduling-${groupIdx}`}
                        className="text-[10px] text-gray-400 hover:text-[#2e343a] disabled:opacity-40 disabled:cursor-not-allowed transition-colors bg-transparent border-0 cursor-pointer p-0"
                      >↻ Refresh</button>
                    </div>
                    {!aiSchedParsed?.downstreamImpact ? (
                      <p className="text-[10px] text-gray-400 italic">Calculating...</p>
                    ) : (
                      (() => {
                        const di = aiSchedParsed.downstreamImpact || [];
                        const calcLater = di.filter(o => o.shiftHrs < 0).sort((a, b) => Math.abs(b.shiftHrs) - Math.abs(a.shiftHrs)).map(o => ({ prio: o.prio, name: o.name, shiftFormatted: formatTimeShift(Math.abs(o.shiftHrs)) }));
                        const calcEarlier = di.filter(o => o.shiftHrs > 0.01).sort((a, b) => b.shiftHrs - a.shiftHrs).map(o => ({ prio: o.prio, name: o.name, shiftFormatted: formatTimeShift(o.shiftHrs) }));
                        const calcDeadlines = di.filter(o => o.willMissDeadline).sort((a, b) => b.delayDays - a.delayDays).map(o => ({ prio: o.prio, name: o.name, newCompletion: o.newCompletion, availDate: o.availDateFmt, delayDays: o.delayDays }));
                        const calcImpactForDisplay = { laterOrders: calcLater, earlierOrders: calcEarlier, deadlineMisses: calcDeadlines };
                        const hasCalcImpact = calcLater.length > 0 || calcEarlier.length > 0 || calcDeadlines.length > 0;
                        const parsedAI = aiSchedParsed.schedulingImpactParsed;
                        const hasParsedAI = parsedAI && (parsedAI.earlierSection.length > 0 || parsedAI.laterSection.length > 0 || parsedAI.deadlineSection.length > 0 || parsedAI.summary.length > 0);
                        return (
                          <div>
                            {schedulingLoading && (
                              <p className="text-[10px] text-gray-400 italic mb-2">Analyzing impact...</p>
                            )}
                            {!hasCalcImpact && !hasParsedAI && !schedulingLoading && (
                              <p className="text-[10px] text-green-700 italic">No scheduling impact — all orders remain on their current schedule.</p>
                            )}
                            {hasParsedAI ? (
                              <SchedulingImpactAIDisplay response={parsedAI} />
                            ) : hasCalcImpact ? (
                              <SchedulingImpactFallback impact={calcImpactForDisplay} />
                            ) : null}
                          </div>
                        );
                      })()
                    )}
                    {/* Gap recommendation embedded inside Scheduling Impact */}
                    {insights.gapRecommendation && (() => {
                      const gr = insights.gapRecommendation;
                      return (
                        <div className="mt-2.5 pt-2.5 border-t border-[#ddd6fe]">
                          <p className="text-[10px] font-bold text-[#2e343a] mb-1.5">
                            💡 Recommendation: Consider NOT combining
                          </p>
                          <p className="text-[10px] text-[#2e343a] leading-relaxed mb-2">
                            FPR {gr.lastFpr}'s Avail Date ({gr.lastAvailDate}) is after FPR {gr.firstFpr}'s Avail Date ({gr.firstAvailDate}). When combined, the lead order uses the <span className="font-semibold">earliest date ({gr.firstAvailDate})</span> — so FPR {gr.lastFpr} is produced <span className="font-semibold">{gr.availDateDiffLabel} earlier</span> than needed, consuming capacity that could run other orders first.
                          </p>

                          <p className="text-[10px] font-semibold text-[#2e343a] mb-1">If kept separate:</p>
                          <ul className="text-[10px] text-[#2e343a] pl-2 space-y-0.5 mb-2">
                            <li>• FPR {gr.firstFpr} completes by: <span className="font-semibold">{gr.firstCompletion}</span></li>
                            <li>• FPR {gr.lastFpr} must start by: <span className="font-semibold">{gr.lastReqStart}</span></li>
                            <li>• Free production gap: <span className="font-semibold">~{gr.gapLabel}</span></li>
                          </ul>

                          <p className="text-[10px] font-semibold text-[#2e343a] mb-1">
                            Non-dated orders that can fill this gap ({gr.fittingOrders.length}):
                          </p>
                          <ul className="text-[10px] text-[#2e343a] pl-2 space-y-0.5 mb-1.5">
                            {gr.fittingOrders.map((fo, fi) => (
                              <li key={fi}>• {fo.item} ({fo.avail}) — <span className="font-semibold">{fo.hours}</span></li>
                            ))}
                            <li className="font-semibold mt-0.5">Total fill time: {gr.totalFillTime} <span className="font-normal text-gray-500">({gr.fillPct}% of gap)</span></li>
                          </ul>

                          <p className="text-[10px] text-[#2e343a] leading-relaxed">
                            Keeping them separate lets you produce {gr.fittingOrders.length} non-dated order{gr.fittingOrders.length !== 1 ? 's' : ''} in the gap while still meeting both avail dates.
                          </p>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Card: Alerts — warm amber bg; includes calculated warnings + AI alerts */}
                  <div className="rounded-md bg-[#fffbeb] px-3 py-2.5">
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="text-[10px] font-bold text-[#92400e]">⚠ Alerts</p>
                      <button
                        onClick={() => handleRefreshSection(groupKey, group, groupIdx, 'alerts')}
                        disabled={alertsLoading}
                        data-testid={`button-refresh-alerts-${groupIdx}`}
                        className="text-[10px] text-gray-400 hover:text-[#92400e] disabled:opacity-40 disabled:cursor-not-allowed transition-colors bg-transparent border-0 cursor-pointer p-0"
                      >↻ Refresh</button>
                    </div>
                    {/* Calculated blocking warnings from insights engine */}
                    {insights.warnings.length > 0 && (
                      <div className="space-y-1.5 mb-1.5">
                        {insights.warnings.map((w, wi) => (
                          <div key={`cw-${wi}`} className="flex items-start gap-1.5">
                            <span className="text-[10px] text-amber-500 shrink-0 mt-0.5">⚠</span>
                            <span className="text-[10px] text-[#92400e] leading-relaxed whitespace-pre-line">{w.text}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* Calculated deadline + N10D risk alerts — deterministic, not from AI */}
                    {(() => {
                      const di = aiSchedParsed?.downstreamImpact || [];
                      const typedAlerts = [];
                      di.filter(o => o.willMissDeadline).forEach(o => {
                        typedAlerts.push({ type: 'deadline', text: `Combining will push downstream order FPR: ${o.fpr} (${o.name}) past its Avail Date by ${o.delayFormatted}. New Completion: ${o.newCompletionFull} → Avail Date: ${o.availDateFmt || o.availDate}` });
                      });
                      di.filter(o => !o.availDate && o.shiftHrs < -0.01 && (o.n10dStatus === 'Critical' || o.n10dStatus === 'Urgent')).forEach(o => {
                        typedAlerts.push({ type: 'n10d_risk', text: `${o.name} (Prio ${o.prio}) has ${o.n10dStatus} stock status. The ~${formatTimeShift(Math.abs(o.shiftHrs))} delay from combining may accelerate stock depletion.` });
                      });
                      const combinedVolNow = activeOrders.reduce((s, o) => s + (parseFloat(o.volume) || 0), 0);
                      if (combinedVolNow > 200) typedAlerts.push({ type: 'volume_ceiling', text: `The combined total of ${combinedVolNow.toFixed(0)} MT exceeds the recommended ceiling of 200 MT. Large combined orders may impact scheduling flexibility.` });
                      if (typedAlerts.length === 0) return null;
                      return (
                        <div className="space-y-1.5 mb-1.5">
                          {typedAlerts.map((a, ai) => (
                            <div key={`ta-${ai}`} className="flex items-start gap-1.5">
                              <span className="text-[10px] text-amber-500 shrink-0 mt-0.5">⚠</span>
                              <span className="text-[10px] text-[#92400e] leading-relaxed">{a.text}</span>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                    {/* AI-generated alerts */}
                    {alertsLoading && !aiSchedParsed?.alerts ? (
                      <p className="text-[10px] text-gray-400 italic">Checking for alerts...</p>
                    ) : alertsLoading ? (
                      <p className="text-[10px] text-gray-400 italic">Updating...</p>
                    ) : (
                      <CombineAlertsDisplay alerts={aiSchedParsed?.alerts} hideNoAlerts={insights.warnings.length > 0 || (aiSchedParsed?.downstreamImpact || []).some(o => o.willMissDeadline || (!o.availDate && o.shiftHrs < -0.01 && (o.n10dStatus === 'Critical' || o.n10dStatus === 'Urgent')))} />
                    )}
                  </div>
                </>
              )}
              {!insights.productionSummary &&
                !insights.schedulingImpact &&
                insights.warnings.length === 0 && (
                  <div className="flex items-start gap-2 rounded-md bg-green-50 px-2.5 py-2 mt-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-600 mt-0.5 shrink-0" />
                    <p className="text-[11px] text-green-800 leading-relaxed">
                      No issues detected. Ready to combine.
                    </p>
                  </div>
                )}
            </div>
          </div>
        )}
        <div className="px-4 py-3 flex gap-2 border-t border-gray-100">
          <div className="flex-1 relative group/approve">
            <Button
              size="sm"
              className={cn(
                "w-full text-[12px] h-8 disabled:opacity-50 disabled:cursor-not-allowed",
                insights.gapRecommendation
                  ? "bg-white border border-[var(--nexfeed-primary)] text-[var(--nexfeed-primary)] hover:bg-orange-50"
                  : "bg-[var(--nexfeed-primary)] hover:bg-[var(--nexfeed-primary-dark)] text-white",
              )}
              onClick={() => handleApprove(group, groupIdx)}
              disabled={!canApprove}
              data-testid={`button-approve-combine-${groupIdx}`}
            >
              {insights.gapRecommendation ? "Approve Anyway" : "Approve"}
            </Button>
            {approveTooltip && (
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover/approve:block z-10">
                <div className="bg-gray-900 text-white text-[10px] px-2 py-1 rounded whitespace-nowrap">
                  {approveTooltip}
                </div>
              </div>
            )}
          </div>
          <Button
            variant={insights.gapRecommendation ? "default" : "outline"}
            size="sm"
            className={cn(
              "flex-1 text-[12px] h-8",
              insights.gapRecommendation &&
                "bg-[#43a047] hover:bg-[#388e3c] text-white",
            )}
            onClick={() => handleDismiss(groupIdx)}
            data-testid={`button-dismiss-combine-${groupIdx}`}
          >
            {insights.gapRecommendation ? "Dismiss — Keep Separate" : "Dismiss"}
          </Button>
        </div>
      </div>
    );
  };

  return (
    <>
      <div
        className="smart-combine-btn fixed right-0 top-1/2 -translate-y-1/2 z-40"
        data-smart-combine-toggle
        data-tour="orders-smart-combine"
      >
        {groups.length > 0 && (
          <span
            className="absolute -top-8 left-1/2 -translate-x-1/2 flex items-center justify-center min-w-[20px] h-[20px] rounded-full bg-white text-[var(--nexfeed-primary)] border border-[var(--nexfeed-primary)] text-[10px] font-bold shadow-sm px-1 cursor-pointer"
            onClick={() => setIsOpen(!isOpen)}
            data-testid="badge-smart-combine-count"
          >
            {groups.length}
          </span>
        )}
        <button
          id="smart-combine-toggle"
          onClick={() => setIsOpen(!isOpen)}
          className={cn(
            "flex items-center gap-1.5 px-2 py-3",
            "bg-[var(--nexfeed-primary)] hover:bg-[var(--nexfeed-primary-dark)] text-white",
            "rounded-l-lg shadow-lg transition-all",
            "writing-mode-vertical",
          )}
          style={{ writingMode: "vertical-rl", textOrientation: "mixed" }}
          data-testid="button-smart-combine-toggle"
        >
          <Merge className="h-4 w-4 rotate-90" />
          <span className="text-[12px] font-semibold tracking-wide">
            Smart Combine
          </span>
        </button>
      </div>

      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/10"
          onClick={() => setIsOpen(false)}
        />
      )}

      <div
        ref={panelRef}
        className={cn(
          "fixed top-16 right-0 bottom-0 z-40 w-[400px] bg-white shadow-2xl border-l border-gray-200",
          "transform transition-transform duration-300 ease-in-out",
          "flex flex-col",
          isOpen ? "translate-x-0" : "translate-x-full",
        )}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-[#f9fafb]">
          <div>
            <h2 className="text-sm font-bold text-gray-900 flex items-center gap-2">
              <Merge className="h-4 w-4 text-[var(--nexfeed-primary)]" />
              Smart Combine
            </h2>
            <p className="text-[13px] text-gray-500 mt-0.5">
              Recommendations for {lineLabel}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleRefresh}
              data-testid="button-refresh-combine"
            >
              <RefreshCw className="h-3.5 w-3.5 text-gray-500" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setIsOpen(false)}
              data-testid="button-close-combine"
            >
              <X className="h-4 w-4 text-gray-500" />
            </Button>
          </div>
        </div>

        <div className="border-b border-gray-200">
          {isAllTab && (
            <div
              className="flex items-center gap-1.5 px-4 py-2 flex-wrap"
              data-testid="filter-line-tabs"
            >
              <span className="text-[10px] text-gray-400 font-medium mr-1">
                Line:
              </span>
              {[
                { key: "all", label: "All Lines" },
                ...validLines.map((l) => ({ key: l, label: l })),
              ].map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setLineFilter(tab.key)}
                  className={cn(
                    "rounded-full text-[10px] font-medium px-2.5 py-0.5 transition-colors",
                    lineFilter === tab.key
                      ? "bg-[#2e343a] text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200",
                  )}
                  data-testid={`button-line-filter-${tab.key}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
          {hasNewFprs && (
            <div
              className="flex items-center gap-1.5 px-4 py-2 flex-wrap"
              data-testid="filter-combine-tabs"
            >
              {[
                { key: "all", label: "All Recommendations" },
                { key: "new_existing", label: "New + Existing Only" },
                { key: "new_only", label: "New Orders Only" },
              ].map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setCombineFilter(tab.key)}
                  className={cn(
                    "rounded-full text-[13px] font-medium px-3 py-1 transition-colors",
                    combineFilter === tab.key
                      ? "bg-[var(--nexfeed-primary)] text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200",
                  )}
                  data-testid={`button-filter-${tab.key}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Overall Safety Assessment Banner */}
          {overallSafety &&
            (overallSafety.unsafeCount === 0 ? (
              <div
                className="flex items-start gap-2.5 rounded-lg border border-green-200 bg-green-50 px-3 py-2.5"
                data-testid="banner-overall-safe"
              >
                <span style={{ fontSize: 14, lineHeight: 1, marginTop: 1 }}>
                  ✅
                </span>
                <div>
                  <p className="text-[11px] font-bold text-green-800">
                    All selections are conflict-free
                  </p>
                  <p className="text-[10px] text-green-700 leading-relaxed mt-0.5">
                    Approving all {overallSafety.total} suggested combination
                    {overallSafety.total !== 1 ? "s" : ""} will not breach any
                    avail dates. Every order's completion date will remain
                    earlier than its avail date.
                  </p>
                </div>
              </div>
            ) : (
              <div
                className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5"
                data-testid="banner-overall-unsafe"
              >
                <span style={{ fontSize: 14, lineHeight: 1, marginTop: 1 }}>
                  ⚠️
                </span>
                <div>
                  <p className="text-[11px] font-bold text-red-800">
                    {overallSafety.unsafeCount} group
                    {overallSafety.unsafeCount !== 1 ? "s" : ""} with
                    conflicting strategy selected
                  </p>
                  <p className="text-[10px] text-red-700 leading-relaxed mt-0.5">
                    {overallSafety.unsafeCount === overallSafety.total
                      ? "All current selections may breach avail dates. Switch to a ✓ SAFE strategy in each group below."
                      : `${overallSafety.safeCount} of ${overallSafety.total} group${overallSafety.total !== 1 ? "s" : ""} are safe. Switch the highlighted groups to a ✓ SAFE strategy to protect all avail dates.`}
                  </p>
                </div>
              </div>
            ))}

          {visibleGroups.length === 0 ? (
            <div className="text-center py-12 px-6">
              <Merge className="h-10 w-10 text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-500 leading-relaxed">
                {combineFilter === "new_existing"
                  ? "No combine recommendations found for new orders with existing orders."
                  : combineFilter === "new_only"
                    ? "No combine recommendations found for new orders."
                    : "No orders available for combining in this view. Orders must share the same Material Code (FG), Material Code (SFG), Line, and Formula Version (SCADA) to be eligible."}
              </p>
            </div>
          ) : isAllTab && lineFilter === "all" ? (
            (() => {
              const groupsByLine = {};
              visibleGroups.forEach((item) => {
                const ln = item.group[0]?.feedmill_line || "Unknown";
                if (!groupsByLine[ln]) groupsByLine[ln] = [];
                groupsByLine[ln].push(item);
              });
              return validLines.map((ln) => {
                const lineGroups = groupsByLine[ln] || [];
                return (
                  <div key={ln} className="space-y-3">
                    <div className="flex items-center justify-between px-2 py-1.5 bg-gray-200 border border-gray-300 rounded">
                      <div className="flex items-center gap-1.5">
                        <ClipboardList className="h-3.5 w-3.5 text-[#2e343a]" />
                        <span className="text-[14px] font-bold text-[#2e343a]">
                          {ln}
                        </span>
                      </div>
                      <span className="text-[12px] text-[#a1a8b3] font-medium">
                        {lineGroups.length > 0
                          ? `${lineGroups.length} group${lineGroups.length !== 1 ? "s" : ""} found`
                          : "No recommendations"}
                      </span>
                    </div>
                    {lineGroups.length === 0 ? (
                      <p className="text-[13px] text-gray-400 pl-5 pb-2">
                        No combine recommendations for {ln}.
                      </p>
                    ) : (
                      lineGroups.map(({ group, originalIdx }, vIdx) => {
                        const groupIdx = originalIdx;
                        return renderGroupCard(group, groupIdx, vIdx);
                      })
                    )}
                  </div>
                );
              });
            })()
          ) : (
            visibleGroups.map(({ group, originalIdx }, vIdx) =>
              renderGroupCard(group, originalIdx, vIdx),
            )
          )}
        </div>
      </div>

      {combineError && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setCombineError(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-[480px] max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            data-testid="dialog-combine-error"
          >
            <div className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <div className="p-2 bg-red-50 rounded-lg">
                  <AlertTriangle className="h-5 w-5 text-[#e53935]" />
                </div>
                <h3 className="text-base font-bold text-[#e53935]">
                  Unable to Combine Orders
                </h3>
              </div>
              <div className="space-y-2 mb-5">
                {combineError.length === 1 ? (
                  <p className="text-sm text-[#2e343a] leading-relaxed">
                    {combineError[0]}
                  </p>
                ) : (
                  <ul className="list-disc pl-5 space-y-1.5">
                    {combineError.map((err, i) => (
                      <li
                        key={i}
                        className="text-sm text-[#2e343a] leading-relaxed"
                      >
                        {err}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setCombineError(null)}
                  data-testid="button-error-close"
                >
                  OK
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmGroup && conflictResult && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => {
            setConfirmGroup(null);
            setConflictResult(null);
          }}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-[480px] max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {conflictResult.conflicts.length > 0 ? (
              <div className="p-6">
                <div className="flex items-center gap-2 mb-3">
                  <div className="p-2 bg-amber-50 rounded-lg">
                    <AlertTriangle className="h-5 w-5 text-amber-500" />
                  </div>
                  <h3 className="text-base font-bold text-gray-900">
                    Combine Orders — Scheduling Conflict Detected
                  </h3>
                </div>
                <p className="text-xs text-gray-600 mb-4">
                  Combining these orders will cause the following downstream
                  orders to exceed their Avail Date deadline:
                </p>
                <div className="space-y-3 mb-4">
                  {conflictResult.conflicts.map((c, i) => (
                    <div
                      key={i}
                      className="bg-amber-50 border border-amber-200 rounded-lg p-3"
                    >
                      <p className="text-xs font-semibold text-gray-900 flex items-center gap-1">
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                        FPR: {c.order.fpr} — {c.order.item_description}
                      </p>
                      <p className="text-[11px] text-gray-600 mt-1">
                        New Completion Date:{" "}
                        {formatLongDateTime(c.newCompletion)} → Avail Date:{" "}
                        {formatLongDate(c.order.target_avail_date)}
                      </p>
                      <p className="text-[11px] text-amber-700 font-medium mt-0.5">
                        Exceeds deadline by{" "}
                        {c.exceedHours < 24
                          ? `${c.exceedHours} hours`
                          : `${Math.round(c.exceedHours / 24)} days`}
                      </p>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-500 mb-4">
                  This combine action is blocked until the scheduling conflict
                  is resolved. Consider reordering orders, adjusting volumes, or
                  changing Start Dates to free up capacity.
                </p>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setConfirmGroup(null);
                      setConflictResult(null);
                    }}
                    data-testid="button-conflict-go-back"
                  >
                    Go Back
                  </Button>
                </div>
              </div>
            ) : (
              <div className="p-6">
                <h3 className="text-base font-bold text-gray-900 mb-3">
                  Combine Orders
                </h3>
                <p className="text-xs text-gray-600 mb-3">
                  You are about to combine the following orders:
                </p>
                <div className="bg-gray-50 rounded-lg p-3 mb-4 space-y-1.5">
                  {confirmGroup.group.map((o) => (
                    <div
                      key={o.id}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="text-gray-900 font-medium">
                        FPR: {o.fpr} —{" "}
                        <span className="font-normal text-gray-600">
                          {o.item_description}
                        </span>
                      </span>
                      <span className="text-gray-700 font-semibold ml-2 shrink-0">
                        {fmtVolume(getEffVolume(o))} MT
                      </span>
                    </div>
                  ))}
                </div>
                <div className="space-y-1.5 mb-5">
                  <p className="text-xs text-gray-900">
                    <span className="font-semibold">Combined Volume:</span>{" "}
                    {fmtVolume(conflictResult.combinedVolume)} MT
                  </p>
                  <p className="text-xs text-gray-900">
                    <span className="font-semibold">
                      Estimated Production Hours:
                    </span>{" "}
                    {conflictResult.prodHours != null
                      ? `${fmtHours(conflictResult.prodHours)} hrs`
                      : "—"}
                  </p>
                  <p className="text-xs text-gray-900">
                    <span className="font-semibold">
                      Estimated Completion Date:
                    </span>{" "}
                    {conflictResult.leadCompletion
                      ? formatLongDateTime(conflictResult.leadCompletion)
                      : "—"}
                  </p>
                </div>
                <div className="flex gap-2 justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setConfirmGroup(null);
                      setConflictResult(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    className="bg-[var(--nexfeed-primary)] hover:bg-[var(--nexfeed-primary-dark)] text-white disabled:opacity-60 disabled:cursor-not-allowed"
                    onClick={handleConfirmCombine}
                    disabled={isCombining}
                    data-testid="button-confirm-combine"
                  >
                    {isCombining ? "Combining…" : "Confirm Combine"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
