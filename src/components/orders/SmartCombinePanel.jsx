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
  const combinedVolume = group.reduce((s, o) => s + getEffVolume(o), 0);
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

function normalizeVal(v) {
  if (v === null || v === undefined || v === "" || v === "-") return "";
  return String(v).trim().toLowerCase();
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
      String(o.form || "").trim(),
      String(o.batch_size || "").trim(),
      String(o.category || "").trim(),
      normalizeVal(o.formula_version),
    ].join("|||");
    if (!groups[key]) groups[key] = [];
    groups[key].push(o);
  }

  return {
    groups: Object.values(groups).filter((g) => g.length >= 2),
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

  const handleSelectStrategy = (groupIdx, stratId) => {
    setSelectedStrategies((prev) => ({ ...prev, [groupIdx]: stratId }));
    setExcluded((prev) => ({ ...prev, [groupIdx]: new Set() }));
  };

  const handleExclude = (groupIdx, orderId) => {
    setExcluded((prev) => {
      const s = new Set(prev[groupIdx] || []);
      s.add(orderId);
      return { ...prev, [groupIdx]: s };
    });
  };

  const handleReadd = (groupIdx, orderId) => {
    setExcluded((prev) => {
      const s = new Set(prev[groupIdx] || []);
      s.delete(orderId);
      return { ...prev, [groupIdx]: s };
    });
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

    const forms = new Set(activeOrders.map((o) => String(o.form || "").trim()));
    if (forms.size > 1) {
      errors.push(
        "These orders cannot be combined because they have different Form types. All orders must share the same Form to be eligible for combining.",
      );
    }

    const batchSizes = new Set(
      activeOrders.map((o) => String(o.batch_size || "").trim()),
    );
    if (batchSizes.size > 1) {
      errors.push(
        "These orders cannot be combined because they have different Batch Sizes. All orders must share the same Batch Size to be eligible for combining.",
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

    const categories = new Set(
      activeOrders.map((o) => String(o.category || "").trim()),
    );
    if (categories.size > 1) {
      errors.push(
        "These orders cannot be combined because they belong to different Categories. All orders must share the same Category to be eligible for combining.",
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

    const combinedVolume = group.reduce((s, o) => s + getEffVolume(o), 0);
    const runRate = parseFloat(group[0].run_rate) || 0;
    const batchSize = parseFloat(group[0].batch_size) || 4;
    const prodHours = calcProductionHoursLocal(combinedVolume, runRate);
    const changeover = 0.17;

    const earliestIdx = Math.min(
      ...group.map((o) => {
        const idx = allLineOrders.findIndex((lo) => lo.id === o.id);
        return idx >= 0 ? idx : Infinity;
      }),
    );

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

      const combinedVol = activeOrders.reduce((s, o) => s + getEffVolume(o), 0);
      const batchSize = parseFloat(activeOrders[0].batch_size) || 4;
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
      const forms = new Set(
        activeOrders.map((o) => String(o.form || "").trim()),
      );
      if (forms.size > 1)
        warnings.push({
          text: "Orders have different Form types. All orders must share the same Form to combine.",
          blocking: true,
        });
      const batchSizes = new Set(
        activeOrders.map((o) => String(o.batch_size || "").trim()),
      );
      if (batchSizes.size > 1)
        warnings.push({
          text: "Orders have different Batch Sizes. All orders must share the same Batch Size to combine.",
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
      const categories = new Set(
        activeOrders.map((o) => String(o.category || "").trim()),
      );
      if (categories.size > 1)
        warnings.push({
          text: "Orders belong to different Categories. All orders must share the same Category to combine.",
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

      if (batchSize > 0 && combinedVol % batchSize !== 0) {
        const rounded = Math.ceil(combinedVol / batchSize) * batchSize;
        warnings.push({
          text: `Combined volume of ${fmtVolume(combinedVol)} MT is not a multiple of the Batch Size (${fmtVolume(batchSize)}). The system will round up to ${fmtVolume(rounded)} MT.`,
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
              if (fittingOrders.length > 0) {
                gapRecommendation = {
                  firstFpr: first.fpr,
                  lastFpr: last.fpr,
                  firstAvailDate: formatLongDate(first.avail),
                  lastAvailDate: formatLongDate(last.avail),
                  firstCompletion: first.completion
                    ? formatLongDateTime(first.completion)
                    : "-",
                  lastReqStart: formatLongDateTime(reqStart),
                  gapLabel:
                    gapHours >= 24
                      ? `${Math.round(gapHours / 24)} days ${Math.round(gapHours % 24)} hours`
                      : `${Math.round(gapHours)} hours`,
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

  const renderGroupCard = (group, groupIdx, vIdx) => {
    const {
      strategies,
      selectedStratId,
      activeOrders,
      stratExcluded,
      manualExcluded: manualExcludedOrders,
    } = resolveGroupStrategy(group, groupIdx);
    const combinedVol = activeOrders.reduce((s, o) => s + getEffVolume(o), 0);
    const insights = generateInsights(activeOrders);
    const canApprove = activeOrders.length >= 2 && !insights.hasBlocker;
    const approveTooltip =
      activeOrders.length < 2
        ? "At least 2 orders are required to combine."
        : insights.hasBlocker
          ? "Resolve warnings before combining."
          : null;

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
                    onClick={() => handleSelectStrategy(groupIdx, s.id)}
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
                          : "1.5px solid #fd5108"
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
                                : "#fd5108"
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
            [
              "Category",
              group[0].category
                ? group[0].category.charAt(0).toUpperCase() +
                  group[0].category.slice(1).toLowerCase()
                : "—",
            ],
            ["Form", group[0].form || "—"],
            [
              "Batch Size",
              group[0].batch_size
                ? Number(group[0].batch_size).toFixed(2)
                : "—",
            ],
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
            activeOrders.map((o) => {
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
                  <div
                    style={{
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
                  {/* × button — absolute top-right */}
                  <button
                    onClick={() => handleExclude(groupIdx, o.id)}
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
          <p className="text-xs font-bold text-[#fd5108]">
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
              {stratExcluded.map((o) => (
                <div
                  key={o.id}
                  className="flex items-center gap-2 opacity-40"
                  data-testid={`row-strat-excluded-order-${o.id}`}
                >
                  <span className="text-[10px] text-gray-400 shrink-0">
                    Strategy
                  </span>
                  <span className="text-[11px] text-gray-400 line-through">
                    FPR: {o.fpr} — {fmtVolume(getEffVolume(o))} MT
                  </span>
                </div>
              ))}
              {manualExcludedOrders.map((o) => (
                <div
                  key={o.id}
                  className="flex items-center gap-2 opacity-50"
                  data-testid={`row-excluded-order-${o.id}`}
                >
                  <button
                    onClick={() => handleReadd(groupIdx, o.id)}
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
              {combinedVol > 200 && (
                <div
                  className="rounded-md px-3 py-2.5"
                  style={{ background: "#fffbeb", border: "1px solid #fcd34d" }}
                >
                  <p
                    className="text-[10px] font-bold mb-1"
                    style={{ color: "#92400e" }}
                  >
                    ⚠ Volume Ceiling Warning
                  </p>
                  <p
                    className="text-[10px] leading-relaxed"
                    style={{ color: "#92400e" }}
                  >
                    The combined total of {combinedVol.toLocaleString()} MT
                    exceeds the recommended ceiling of 200 MT. Large combined
                    orders may impact scheduling flexibility and downstream
                    production. Are you sure you want to proceed?
                  </p>
                </div>
              )}
              {insights.schedulingImpact &&
                (() => {
                  const si = insights.schedulingImpact;
                  const fmtHr = (h) =>
                    h >= 24
                      ? `${Math.floor(h / 24)} days ${h % 24} hrs`
                      : `${h} hours`;
                  if (si.scenario === "no_dates")
                    return (
                      <div className="rounded-md bg-[#eff6ff] border border-[#bfdbfe] px-3 py-2.5">
                        <p className="text-[10px] font-bold text-[#1e40af] mb-1">
                          📍 Scheduling Impact
                        </p>
                        <p className="text-[10px] text-[#1e40af] leading-relaxed">
                          ℹ No start dates are set — exact completion dates
                          cannot be calculated. The lead order will be placed at
                          Priority {si.insertionPrio} based on the highest
                          priority child order.
                        </p>
                      </div>
                    );
                  if (si.scenario === "no_delay")
                    return (
                      <div className="rounded-md bg-[#f0fdf4] border border-[#bbf7d0] px-3 py-2.5">
                        <p className="text-[10px] font-bold text-[#166534] mb-1">
                          📍 Scheduling Impact
                        </p>
                        <p className="text-[10px] text-[#166534] leading-relaxed">
                          ✅ Lead order can be inserted at Priority{" "}
                          {si.insertionPrio} without causing delays to
                          downstream orders. All subsequent orders remain within
                          their deadline windows.
                        </p>
                      </div>
                    );
                  if (si.scenario === "delay_alt") {
                    const di = si.delayInfo;
                    const delayLabel = fmtHr(di.delayHrs);
                    return (
                      <div className="rounded-md bg-[#fffbeb] border border-[#fcd34d] px-3 py-2.5">
                        <p className="text-[10px] font-bold text-[#92400e] mb-1">
                          📍 Scheduling Impact
                        </p>
                        <p className="text-[10px] text-[#92400e] leading-relaxed mb-1">
                          ⚠ Inserting at Priority {si.insertionPrio} would
                          delay{" "}
                          <strong>
                            {di.order.item_description || di.order.fpr}
                          </strong>
                          {di.order.target_avail_date &&
                          !isNaN(Date.parse(di.order.target_avail_date))
                            ? ` (target: ${formatLongDate(di.order.target_avail_date)})`
                            : ""}{" "}
                          by approximately {delayLabel}.
                        </p>
                        <p className="text-[10px] text-[#92400e] leading-relaxed">
                          💡 Suggested: Insert at Priority{" "}
                          {si.alternativePosition} where the lead order fits
                          without affecting deadlines.
                        </p>
                      </div>
                    );
                  }
                  if (si.scenario === "delay_no_alt") {
                    const di = si.delayInfo;
                    const delayLabel = fmtHr(di.delayHrs);
                    return (
                      <div className="rounded-md bg-[#fffbeb] border border-[#fcd34d] px-3 py-2.5">
                        <p className="text-[10px] font-bold text-[#92400e] mb-1">
                          📍 Scheduling Impact
                        </p>
                        <p className="text-[10px] text-[#92400e] leading-relaxed mb-1">
                          ⚠ Inserting at Priority {si.insertionPrio} would
                          delay{" "}
                          <strong>
                            {di.order.item_description || di.order.fpr}
                          </strong>
                          {di.order.target_avail_date &&
                          !isNaN(Date.parse(di.order.target_avail_date))
                            ? ` (target: ${formatLongDate(di.order.target_avail_date)})`
                            : ""}{" "}
                          by approximately {delayLabel}. No alternative position
                          avoids all delays.
                        </p>
                        <p className="text-[10px] text-[#92400e]">
                          Consider adjusting downstream deadlines or splitting
                          the combine into smaller groups.
                        </p>
                      </div>
                    );
                  }
                  return null;
                })()}
              {insights.gapRecommendation &&
                (() => {
                  const gr = insights.gapRecommendation;
                  return (
                    <div className="rounded-md bg-[#fffde7] border border-amber-200 px-3 py-2.5">
                      <p className="text-[10px] font-bold text-[#2e343a] mb-1.5">
                        💡 Recommendation: Consider NOT combining
                      </p>
                      <p className="text-[10px] text-[#2e343a] leading-relaxed mb-1.5">
                        FPR {gr.lastFpr}'s Avail Date ({gr.lastAvailDate}) is
                        after FPR {gr.firstFpr}'s Avail Date (
                        {gr.firstAvailDate}).
                      </p>
                      <p className="text-[10px] text-gray-600 mb-0.5">
                        If kept separate:
                      </p>
                      <ul className="text-[10px] text-gray-600 pl-3 space-y-0.5 mb-1.5">
                        <li>
                          • FPR {gr.firstFpr} completes: {gr.firstCompletion}
                        </li>
                        <li>
                          • FPR {gr.lastFpr} needs to start by:{" "}
                          {gr.lastReqStart}
                        </li>
                        <li>• Available gap: ~{gr.gapLabel}</li>
                      </ul>
                      <p className="text-[10px] text-gray-600 mb-0.5">
                        Pending non-dated orders that could fill this gap:
                      </p>
                      <ul className="text-[10px] text-gray-600 pl-3 space-y-0.5 mb-1.5">
                        {gr.fittingOrders.map((fo, fi) => (
                          <li key={fi}>
                            • {fo.item} ({fo.avail}) — {fo.hours}
                          </li>
                        ))}
                        <li className="font-semibold">
                          Total: {gr.totalFillTime}
                        </li>
                      </ul>
                      <p className="text-[10px] text-[#2e343a] leading-relaxed">
                        Keeping orders separate allows you to insert these{" "}
                        {gr.fittingOrders.length} non-dated order(s) in the gap,
                        maximizing plant utilization.
                      </p>
                    </div>
                  );
                })()}
              {insights.warnings.length > 0 && (
                <div className="space-y-1.5">
                  {insights.warnings.map((w, wi) => (
                    <div
                      key={`w-${wi}`}
                      className="flex items-start gap-2 rounded-md bg-[#fff9c4] px-2.5 py-2"
                    >
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-600 mt-0.5 shrink-0" />
                      <p className="text-[11px] text-[#2e343a] leading-relaxed whitespace-pre-line">
                        {w.text}
                      </p>
                    </div>
                  ))}
                </div>
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
                  ? "bg-white border border-[#fd5108] text-[#fd5108] hover:bg-orange-50"
                  : "bg-[#fd5108] hover:bg-[#fe7c39] text-white",
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
        className="fixed right-0 top-1/2 -translate-y-1/2 z-40"
        data-smart-combine-toggle
      >
        {groups.length > 0 && (
          <span
            className="absolute -top-8 left-1/2 -translate-x-1/2 flex items-center justify-center min-w-[20px] h-[20px] rounded-full bg-white text-[#fd5108] border border-[#fd5108] text-[10px] font-bold shadow-sm px-1 cursor-pointer"
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
            "bg-[#fd5108] hover:bg-[#fe7c39] text-white",
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
              <Merge className="h-4 w-4 text-[#fd5108]" />
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
                      ? "bg-[#fd5108] text-white"
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
                    : "No orders available for combining in this view. Orders must share the same Material Code, Line, Form, Batch Size, and Category to be eligible."}
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
                    className="bg-[#fd5108] hover:bg-[#fe7c39] text-white disabled:opacity-60 disabled:cursor-not-allowed"
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
