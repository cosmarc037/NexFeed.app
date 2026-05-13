import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { PlantSummaryTab, PlantLineTab, applyPreviewChangeovers } from "./PlantAutoSequenceModal";
import {
  callPlantActionsAI,
  buildPlantActionsPrompt,
  parsePlantActionsResponse,
} from "@/services/azureAI";

/* ─── constants ─── */
const PLANT_ALL_LINES = ["Line 1", "Line 2", "Line 3", "Line 4", "Line 5", "Line 6", "Line 7"];
const PLANT_LINE_TO_FM_LABEL = {
  "Line 1": "Feedmill 1", "Line 2": "Feedmill 1",
  "Line 3": "Feedmill 2", "Line 4": "Feedmill 2",
  "Line 5": "Powermix",
  "Line 6": "Feedmill 3", "Line 7": "Feedmill 3",
};
const PLANT_RUN_RATE_COL = {
  "Line 1": "line_1_run_rate", "Line 2": "line_2_run_rate",
  "Line 3": "line_3_run_rate", "Line 4": "line_4_run_rate",
  "Line 5": "line_5_run_rate",
  "Line 6": "line_6_run_rate", "Line 7": "line_7_run_rate",
};
const LINE_RUN_RATES = {
  "Line 1": 20, "Line 2": 20,
  "Line 3": 10, "Line 4": 10,
  "Line 5": 10,
  "Line 6": 10, "Line 7": 10,
};
const MAX_COMBINE_MT = 180;

const UPLOAD_EXCLUDED = new Set([
  "completed", "cancel_po",
  "in_production", "ongoing_batching", "ongoing_pelleting", "ongoing_bagging",
]);

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

function getLineRunRate(line) {
  return LINE_RUN_RATES[normalizeLine(line)] || 10;
}

// Sum actual row-level hours (production + changeover) — mirrors Dashboard.jsx helper
function calculateLineHoursBreakdown(orders) {
  const prod = Number(((orders || []).reduce((s, o) => s + (parseFloat(o.production_hours) || 0), 0)).toFixed(2));
  const co   = Number(((orders || []).reduce((s, o) => s + (parseFloat(o._changeoverTotal ?? o.changeover_time ?? 0) || 0), 0)).toFixed(2));
  return { productionHours: prod, changeoverHours: co, totalHours: Number((prod + co).toFixed(2)) };
}

// Mirror getEffectiveVolume() from OrderTable exactly so summary matches table display:
// volume_override → ceil(total_volume_mt / batch_size) * batch_size → raw
function getEffectiveDisplayVolumeMT(order) {
  if (order.volume_override != null && order.volume_override !== "") {
    const ov = parseFloat(order.volume_override);
    if (!Number.isNaN(ov)) return Number(ov.toFixed(2));
  }
  const rawVol = parseFloat(order.total_volume_mt ?? 0) || 0;
  const batchSize = parseFloat(order.batch_size ?? 0) || 0;
  if (batchSize > 0) return Number((Math.ceil(rawVol / batchSize) * batchSize).toFixed(2));
  return Number(rawVol.toFixed(2));
}

function calculateEffectiveLineTotalMT(orders) {
  return Number(((orders || []).reduce((sum, o) => sum + getEffectiveDisplayVolumeMT(o), 0)).toFixed(2));
}

function canProduceOnLine(order, line, kbList) {
  const normalized = normalizeLine(line);
  const rrKey = PLANT_RUN_RATE_COL[normalized];
  if (!rrKey) return false;
  const materialCode = String(order.material_code || "").trim();
  if (!materialCode) return false;
  const entry = (kbList || []).find(
    (r) => String(r.fg_material_code || "").trim() === materialCode
  );
  return !!(entry && parseFloat(entry[rrKey] || 0) > 0);
}

function isISODate(v) {
  return v && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v));
}

/* ─── per-line sequencing ─── */
function runLocalSequence(lineOrders) {
  const dated = lineOrders
    .filter((o) => isISODate(o.target_avail_date))
    .sort((a, b) => new Date(a.target_avail_date) - new Date(b.target_avail_date));
  const nonDated = lineOrders.filter((o) => !isISODate(o.target_avail_date));
  const catOrder = { A: 0, B: 1, C: 2, D: 3 };
  nonDated.sort((a, b) => {
    const cA = catOrder[a.category] ?? 2;
    const cB = catOrder[b.category] ?? 2;
    if (cA !== cB) return cA - cB;
    const colA = (a.color || "").toLowerCase();
    const colB = (b.color || "").toLowerCase();
    if (colA !== colB) return colA.localeCompare(colB);
    return (parseFloat(a.diameter) || 0) - (parseFloat(b.diameter) || 0);
  });
  return [...dated, ...nonDated];
}

/* ─── sequence-only algorithm: no combine, just cross-line optimal placement ─── */
function sequenceOnlyAcrossLines(allOrders, kbList) {
  const eligible = allOrders
    .filter((o) => !UPLOAD_EXCLUDED.has(o.status) && o.feedmill_line)
    .map((o) => ({
      ...JSON.parse(JSON.stringify(o)),
      _originalLine: normalizeLine(o.feedmill_line),
      _movedFromLine: null,
    }));

  const lineTotalMT = {};
  PLANT_ALL_LINES.forEach((line) => {
    const lineOrders = eligible.filter((o) => normalizeLine(o.feedmill_line) === line);
    lineTotalMT[line] = lineOrders.reduce((sum, o) => sum + (parseFloat(o.total_volume_mt) || 0), 0);
  });

  const lineOrdersMap = {};
  PLANT_ALL_LINES.forEach((line) => {
    lineOrdersMap[line] = eligible
      .filter((o) => normalizeLine(o.feedmill_line) === line)
      .sort((a, b) => (a.priority_seq || 0) - (b.priority_seq || 0));
  });

  const placementLog = [];

  const datedOrders = eligible
    .filter((o) => isISODate(o.target_avail_date))
    .sort((a, b) => new Date(a.target_avail_date) - new Date(b.target_avail_date));
  const nonDatedOrders = eligible.filter((o) => !isISODate(o.target_avail_date));
  const sortedOrders = [...datedOrders, ...nonDatedOrders];

  sortedOrders.forEach((order) => {
    const eligibleLines = PLANT_ALL_LINES.filter((line) =>
      canProduceOnLine(order, line, kbList)
    );
    if (eligibleLines.length === 0) return;

    const orderVolume = parseFloat(order.total_volume_mt) || 0;
    const origLine = normalizeLine(order.feedmill_line);

    lineTotalMT[origLine] = Math.max(0, (lineTotalMT[origLine] || 0) - orderVolume);
    lineOrdersMap[origLine] = (lineOrdersMap[origLine] || []).filter((o) => o.id !== order.id);

    const lineScores = eligibleLines.map((line) => {
      const currentTotalMT = lineTotalMT[line] || 0;
      const runRate = getLineRunRate(line);
      const queueTime = runRate > 0 ? currentTotalMT / runRate : Infinity;
      const lineNumber = parseInt((line.match(/\d+/) || ["99"])[0]);
      return {
        line,
        runRate,
        totalMTBefore: currentTotalMT,
        queueTimeBefore: queueTime,
        lineNumber,
        feedmill: PLANT_LINE_TO_FM_LABEL[line] || line,
      };
    });
    lineScores.sort((a, b) => {
      const diff = a.queueTimeBefore - b.queueTimeBefore;
      if (Math.abs(diff) > 0.001) return diff;
      return a.lineNumber - b.lineNumber;
    });
    const bestLine = lineScores[0].line;

    if (origLine !== bestLine) {
      order._movedFromLine = origLine;
      order.feedmill_line = bestLine;

      const toScore = lineScores.find((ls) => ls.line === bestLine);
      placementLog.push({
        type: "moved",
        product: order.item_description || order.material_code,
        order: order.item_description || order.material_code,
        materialCode: order.material_code,
        fromLine: origLine,
        toLine: bestLine,
        volume: orderVolume,
        fpr: order.fpr,
        lineScores: lineScores.map((ls) => ({
          line: ls.line,
          runRate: ls.runRate,
          totalMTBefore: ls.totalMTBefore,
          queueTimeBefore: ls.queueTimeBefore,
          totalMTAfter: ls.line === bestLine ? (ls.totalMTBefore + orderVolume) : ls.totalMTBefore,
          queueTimeAfter: ls.line === bestLine
            ? ((ls.totalMTBefore + orderVolume) / (ls.runRate || 1))
            : ls.queueTimeBefore,
        })),
        bestLineReason: {
          line: bestLine,
          runRate: toScore?.runRate || 0,
          queueTime: toScore?.queueTimeBefore || 0,
          totalMTBefore: toScore?.totalMTBefore || 0,
          totalMTAfter: (toScore?.totalMTBefore || 0) + orderVolume,
          queueTimeAfter: ((toScore?.totalMTBefore || 0) + orderVolume) / (toScore?.runRate || 1),
        },
        fromLineReason: {
          line: origLine,
          queueTime: lineScores.find((ls) => ls.line === origLine)?.queueTimeBefore || 0,
          runRate: getLineRunRate(origLine),
        },
      });
    }

    lineTotalMT[bestLine] = (lineTotalMT[bestLine] || 0) + orderVolume;
    if (!lineOrdersMap[bestLine]) lineOrdersMap[bestLine] = [];
    lineOrdersMap[bestLine].push(order);
  });

  return { lineOrdersMap, placementLog };
}

/* ─── combine-only algorithm: run on top of sequenced orders ─── */
function plantLevelCombineOnly(allOrders, kbList) {
  const workingOrders = allOrders.map((o) => ({
    ...JSON.parse(JSON.stringify(o)),
    _originalLine: normalizeLine(o.feedmill_line),
    _movedFromLine: null,
  }));

  const lineTotalMT = {};
  PLANT_ALL_LINES.forEach((line) => {
    const lineOrders = workingOrders.filter((o) => normalizeLine(o.feedmill_line) === line);
    lineTotalMT[line] = lineOrders.reduce((sum, o) => sum + (parseFloat(o.total_volume_mt) || 0), 0);
  });

  const lineOrdersMap = {};
  PLANT_ALL_LINES.forEach((line) => {
    lineOrdersMap[line] = workingOrders.filter((o) => normalizeLine(o.feedmill_line) === line);
  });

  const groupKey = (o) =>
    `${String(o.material_code || "").trim()}__${String(o.formula_version || "").trim()}`;
  const matchGroups = {};
  workingOrders.forEach((order) => {
    const key = groupKey(order);
    if (!matchGroups[key]) matchGroups[key] = [];
    matchGroups[key].push(order);
  });

  const combinedOrders = [];
  const placementLog = [];
  const processedIds = new Set();

  Object.values(matchGroups).forEach((orders) => {
    if (orders.length < 2) return;
    const eligibleLines = PLANT_ALL_LINES.filter((line) =>
      canProduceOnLine(orders[0], line, kbList)
    );
    if (eligibleLines.length === 0) return;

    const sorted = [...orders].sort(
      (a, b) => (parseFloat(b.total_volume_mt) || 0) - (parseFloat(a.total_volume_mt) || 0)
    );
    const combineGroups = [];
    const remaining = [...sorted];
    while (remaining.length > 0) {
      const group = [remaining.shift()];
      let vol = parseFloat(group[0].total_volume_mt) || 0;
      for (let i = remaining.length - 1; i >= 0; i--) {
        const cv = parseFloat(remaining[i].total_volume_mt) || 0;
        if (vol + cv <= MAX_COMBINE_MT) {
          vol += cv;
          group.push(remaining.splice(i, 1)[0]);
        }
      }
      if (group.length > 1) {
        combineGroups.push({ orders: group, totalVolume: vol });
      }
    }

    combineGroups.forEach((combineGroup) => {
      combineGroup.orders.forEach((o) => {
        const orig = normalizeLine(o.feedmill_line);
        lineTotalMT[orig] = Math.max(0, (lineTotalMT[orig] || 0) - (parseFloat(o.total_volume_mt) || 0));
        lineOrdersMap[orig] = (lineOrdersMap[orig] || []).filter((lo) => lo.id !== o.id);
        processedIds.add(o.id);
      });

      const lineScores = eligibleLines.map((line) => {
        const mt = lineTotalMT[line] || 0;
        const rate = getLineRunRate(line);
        const lineNumber = parseInt((line.match(/\d+/) || ["99"])[0]);
        return {
          line,
          runRate: rate,
          totalMTBefore: mt,
          queueTimeBefore: rate > 0 ? mt / rate : Infinity,
          lineNumber,
        };
      });
      lineScores.sort((a, b) => {
        const d = a.queueTimeBefore - b.queueTimeBefore;
        if (Math.abs(d) > 0.001) return d;
        return a.lineNumber - b.lineNumber;
      });
      const bestLine = lineScores[0].line;

      const totalMT = combineGroup.totalVolume;
      const totalHrs = combineGroup.orders.reduce(
        (s, o) => s + (parseFloat(o.production_hours) || 0), 0
      );
      const fromLines = [...new Set(combineGroup.orders.map((o) => normalizeLine(o.feedmill_line) || o._originalLine))];

      const baseOrder = { ...combineGroup.orders[0] };
      baseOrder.total_volume_mt = String(totalMT.toFixed(1));
      baseOrder.production_hours = String(totalHrs.toFixed(2));
      baseOrder.feedmill_line = bestLine;
      baseOrder._isCombined = true;
      baseOrder._combinedFrom = combineGroup.orders.map((o) => ({
        id: o.id,
        line: o._originalLine,
        fpr: o.fpr,
        volume: parseFloat(o.total_volume_mt) || 0,
        item_description: o.item_description,
        form: o.form,
        material_code_fg: o.material_code,
        material_code: o.material_code,
        fg: o.fg,
        sfg: o.sfg,
        batch_size: o.batch_size,
        batches: o.batch_size && parseFloat(o.batch_size) > 0
          ? Math.ceil((parseFloat(o.total_volume_mt) || 0) / parseFloat(o.batch_size))
          : null,
        production_time: o.production_hours,
        target_avail_date: o.target_avail_date,
        category: o.category,
      }));
      baseOrder._combinedFromLines = fromLines;
      baseOrder._plantMovement = normalizeLine(combineGroup.orders[0].feedmill_line) === bestLine ? "same" : "new_to_line";
      baseOrder._movedFromLine = normalizeLine(combineGroup.orders[0].feedmill_line) !== bestLine
        ? normalizeLine(combineGroup.orders[0].feedmill_line)
        : null;

      lineTotalMT[bestLine] = (lineTotalMT[bestLine] || 0) + totalMT;
      if (!lineOrdersMap[bestLine]) lineOrdersMap[bestLine] = [];
      lineOrdersMap[bestLine].push(baseOrder);
      combinedOrders.push(baseOrder);

      const afterMT = lineTotalMT[bestLine];
      const changeoversSaved = combineGroup.orders.length - 1;
      const baseCO = 0.17;

      const enrichedLineScores = lineScores.map((ls) => ({
        ...ls,
        totalMTAfter: parseFloat((lineTotalMT[ls.line] || 0).toFixed(1)),
        queueTimeAfter: parseFloat(
          ((lineTotalMT[ls.line] || 0) / (ls.runRate || 1)).toFixed(2)
        ),
      }));

      placementLog.push({
        type: "combined",
        product: baseOrder.item_description || baseOrder.material_code,
        ordersCount: combineGroup.orders.length,
        totalVolume: totalMT,
        fromLines,
        toLine: bestLine,
        individualVolumes: combineGroup.orders.map((o) => ({
          name: o.item_description || o.material_code,
          volume: parseFloat(o.total_volume_mt) || 0,
          fromLine: o._originalLine || normalizeLine(o.feedmill_line),
          fpr: o.fpr,
        })),
        lineScores: enrichedLineScores,
        bestLineReason: {
          line: bestLine,
          runRate: getLineRunRate(bestLine),
          queueTime: lineScores[0].queueTimeBefore,
          totalMTBefore: lineScores[0].totalMTBefore,
          totalMTAfter: afterMT,
          queueTimeAfter: afterMT / (getLineRunRate(bestLine) || 1),
        },
        changeoversSaved,
        baseChangeover: baseCO,
        timeSaved: parseFloat((changeoversSaved * baseCO).toFixed(2)),
      });
    });
  });

  return { lineOrdersMap, combinedOrders, placementLog };
}

/* ─── build summary stats for PlantSummaryTab ─── */
function calculateUploadSummaryStats(originalSnapshot, sequencedResults, combinedOrders, placementLog) {
  const perLineSummary = PLANT_ALL_LINES.map((line) => {
    const before = originalSnapshot[line] || [];
    const after = sequencedResults[line] || [];
    const beforeMT = calculateEffectiveLineTotalMT(before);
    const afterMT = calculateEffectiveLineTotalMT(after);
    const beforeHours = calculateLineHoursBreakdown(before);
    const afterHours = calculateLineHoursBreakdown(after);
    const newOrders = after.filter((o) => o._plantMovement === "new_to_line").length;
    const removedOrders = Math.max(0, before.length - after.length);
    return {
      line,
      feedmill: PLANT_LINE_TO_FM_LABEL[line] || line,
      beforeCount: before.length,
      afterCount: after.length,
      beforeMT,
      afterMT,
      beforeHours,
      afterHours,
      hoursDiff: Number((afterHours.totalHours - beforeHours.totalHours).toFixed(2)),
      newOrders,
      removedOrders,
    };
  });

  const totalOrdersBefore = PLANT_ALL_LINES.reduce(
    (s, l) => s + (originalSnapshot[l]?.length || 0), 0
  );
  const totalOrdersAfter = PLANT_ALL_LINES.reduce(
    (s, l) => s + (sequencedResults[l]?.length || 0), 0
  );
  const ordersCombined = (combinedOrders || []).length;
  const ordersMovedBetweenLines = (placementLog || []).filter((e) => e.type === "moved").length;

  const linesAffectedSet = new Set();
  (placementLog || []).forEach((entry) => {
    const isCrossLine = entry.type === "combined"
      ? (entry.fromLines || []).some((l) => l !== entry.toLine)
      : entry.fromLine && entry.fromLine !== entry.toLine;
    if (isCrossLine) {
      if (entry.type === "combined") {
        (entry.fromLines || []).forEach((l) => linesAffectedSet.add(l));
      } else {
        linesAffectedSet.add(entry.fromLine);
      }
      linesAffectedSet.add(entry.toLine);
    }
  });

  return {
    totalOrdersBefore,
    totalOrdersAfter,
    ordersCombined,
    ordersMovedBetweenLines,
    linesAffected: linesAffectedSet.size,
    perLineSummary,
  };
}

/* ─── stat badge (local copy) ─── */
function StatBadge({ label, value, color = "default" }) {
  const colors = {
    default: { bg: "#f9fafb", border: "#e5e7eb", textColor: "#6b7280", valColor: "#1a1a1a" },
    green: { bg: "#f0fdf4", border: "#bbf7d0", textColor: "#16a34a", valColor: "#15803d" },
    orange: { bg: "#fff7ed", border: "#fed7aa", textColor: "#ea580c", valColor: "#c2410c" },
    blue: { bg: "#eff6ff", border: "#bfdbfe", textColor: "#1d4ed8", valColor: "#1e40af" },
    amber: { bg: "#fffbeb", border: "#fde68a", textColor: "#b45309", valColor: "#92400e" },
  };
  const c = colors[color] || colors.default;
  return (
    <div style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 8, padding: "8px 16px", minWidth: 80, textAlign: "center", flexShrink: 0 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: c.valColor, lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: 10, color: c.textColor, fontWeight: 500, marginTop: 2, whiteSpace: "nowrap" }}>{label}</div>
    </div>
  );
}

/* ─── main component ─── */
export default function UploadAutoSequencePreview({
  uploadContext,
  masterData,
  changeoverRules,
  onApplySequence,
  onUploadOnly,
  onCancel,
}) {
  const [isProcessing, setIsProcessing] = useState(true);
  const [sequencedResults, setSequencedResults] = useState(null);
  const [originalSnapshot, setOriginalSnapshot] = useState(null);
  const [summaryStats, setSummaryStats] = useState(null);
  const [placementLog, setPlacementLog] = useState([]);
  const [combinedOrders, setCombinedOrders] = useState([]);
  const [isCombined, setIsCombined] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [isUploadingOnly, setIsUploadingOnly] = useState(false);
  const [isCombining, setIsCombining] = useState(false);
  const [activeTab, setActiveTab] = useState("summary");
  const [n10dWarningVisible, setN10DWarningVisible] = useState(true);

  const [preCombineSnapshot, setPreCombineSnapshot] = useState(null);
  const [preCombinePlacementLog, setPreCombinePlacementLog] = useState([]);
  const [preCombineStats, setPreCombineStats] = useState(null);
  const [preCombineCombinedOrders, setPreCombineCombinedOrders] = useState([]);

  const [aiExplanations, setAiExplanations] = useState(null);
  const [isLoadingAI, setIsLoadingAI] = useState(false);
  const [useFallback, setUseFallback] = useState(false);

  // Auto-sequence + auto-combine on mount using in-memory orders from uploadContext
  useEffect(() => {
    const timer = setTimeout(() => runAutoSequenceAndCombine(), 100);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function runAutoSequenceAndCombine() {
    setIsProcessing(true);

    // Combine existing active orders + newly uploaded orders (with temp IDs)
    const allOrders = (uploadContext?.allOrders || []);
    const activeOrders = allOrders.filter(
      (o) => !UPLOAD_EXCLUDED.has(o.status) && o.feedmill_line
    );

    // Snapshot: SAP-assigned positions (before any sequencing)
    const snapshot = {};
    PLANT_ALL_LINES.forEach((line) => {
      snapshot[line] = activeOrders
        .filter((o) => normalizeLine(o.feedmill_line) === line)
        .sort((a, b) => (a.priority_seq || 0) - (b.priority_seq || 0))
        .map((o) => ({ ...JSON.parse(JSON.stringify(o)) }));
    });
    setOriginalSnapshot(snapshot);

    // Step 1: Cross-line optimal placement
    const { lineOrdersMap: placedMap, placementLog: placeLog } =
      sequenceOnlyAcrossLines(activeOrders, masterData || []);

    // Step 2: Combine orders with same material code across the placed result
    const allPlaced = Object.values(placedMap).flat();
    const { lineOrdersMap: combinedMap, combinedOrders: combined, placementLog: combineLog } =
      plantLevelCombineOnly(allPlaced, masterData || []);

    const mergedLog = [...placeLog, ...combineLog];
    const lineOrdersMap = combinedMap;

    const results = {};
    PLANT_ALL_LINES.forEach((line) => {
      const lineOrders = lineOrdersMap[line] || [];
      if (lineOrders.length === 0) {
        results[line] = [];
        return;
      }
      const sequenced = runLocalSequence(lineOrders);
      const withChangeovers = sequenced.map((o) => ({ ...o }));
      applyPreviewChangeovers(withChangeovers, changeoverRules);

      const originalLineOrders = snapshot[line] || [];
      results[line] = withChangeovers.map((order, newIndex) => {
        const newPrio = newIndex + 1;
        // Find the order in the before snapshot for this line
        const originalIndex = originalLineOrders.findIndex((o) => o.id === order.id);
        let movement = "same";
        let movementDelta = 0;
        if (originalIndex >= 0) {
          const originalPrio = originalIndex + 1;
          movementDelta = originalPrio - newPrio;
          if (movementDelta > 0) movement = "up";
          else if (movementDelta < 0) movement = "down";
        } else {
          // Not found in this line's before snapshot → moved here from another line
          movement = "new_to_line";
        }
        return {
          ...order,
          prio: newPrio,
          _plantMovement: order._plantMovement || (originalIndex >= 0 ? "same" : "new_to_line"),
          _movement: movement,
          _movementDelta: Math.abs(movementDelta),
        };
      });
    });

    setSequencedResults(results);
    setPlacementLog(mergedLog);
    setCombinedOrders(combined);
    setIsCombined(combined.length > 0);

    const stats = calculateUploadSummaryStats(snapshot, results, combined, mergedLog);
    setSummaryStats(stats);

    // Wait for AI before revealing tables — same pattern as plant-level auto-sequence
    if (mergedLog.length > 0) {
      await generateAIExplanations(mergedLog);
    }
    setIsProcessing(false);
  }

  async function handleCombineOrders() {
    if (isCombining || isCombined || !sequencedResults) return;

    // Save pre-combine state for undo
    setPreCombineSnapshot(JSON.parse(JSON.stringify(sequencedResults)));
    setPreCombinePlacementLog([...placementLog]);
    setPreCombineStats(summaryStats ? { ...summaryStats } : null);
    setPreCombineCombinedOrders([...combinedOrders]);

    setIsCombining(true);
    setIsProcessing(true);

    const allSequencedFlat = [];
    Object.entries(sequencedResults).forEach(([, orders]) => {
      orders.forEach((o) => allSequencedFlat.push({ ...o }));
    });

    const { lineOrdersMap, combinedOrders: combined, placementLog: combinePlacementLog } =
      plantLevelCombineOnly(allSequencedFlat, masterData || []);

    const results = {};
    PLANT_ALL_LINES.forEach((line) => {
      const lineOrders = lineOrdersMap[line] || [];
      if (lineOrders.length === 0) {
        results[line] = [];
        return;
      }
      const sequenced = runLocalSequence(lineOrders);
      const withChangeovers = sequenced.map((o) => ({ ...o }));
      applyPreviewChangeovers(withChangeovers, changeoverRules);

      const originalLineOrders = originalSnapshot?.[line] || [];
      results[line] = withChangeovers.map((order, newIndex) => {
        const newPrio = newIndex + 1;
        const originalIndex = originalLineOrders.findIndex((o) => o.id === order.id);
        let movement = "same";
        let movementDelta = 0;
        if (originalIndex >= 0) {
          const originalPrio = originalIndex + 1;
          movementDelta = originalPrio - newPrio;
          if (movementDelta > 0) movement = "up";
          else if (movementDelta < 0) movement = "down";
        } else {
          movement = "new_to_line";
        }
        return {
          ...order,
          prio: newPrio,
          _plantMovement: order._plantMovement || (originalIndex >= 0 ? "same" : "new_to_line"),
          _movement: movement,
          _movementDelta: Math.abs(movementDelta),
        };
      });
    });

    setSequencedResults(results);
    setCombinedOrders(combined);

    const mergedLog = [...placementLog, ...combinePlacementLog];
    setPlacementLog(mergedLog);

    const stats = calculateUploadSummaryStats(originalSnapshot || {}, results, combined, mergedLog);
    setSummaryStats(stats);

    // Wait for AI before revealing the updated combined tables
    if (combinePlacementLog.length > 0) {
      await generateAIExplanations(mergedLog);
    }
    setIsCombined(true);
    setIsCombining(false);
    setIsProcessing(false);
  }

  function handleUncombineAll() {
    if (!preCombineSnapshot) return;
    setSequencedResults(JSON.parse(JSON.stringify(preCombineSnapshot)));
    setPlacementLog([...preCombinePlacementLog]);
    setSummaryStats(preCombineStats ? { ...preCombineStats } : null);
    setCombinedOrders([...preCombineCombinedOrders]);
    setIsCombined(false);
    setPreCombineSnapshot(null);
    setPreCombinePlacementLog([]);
    setPreCombineStats(null);
    setPreCombineCombinedOrders([]);
    setAiExplanations(null);
    setUseFallback(false);
    if (preCombinePlacementLog.length > 0) {
      generateAIExplanations(preCombinePlacementLog);
    }
  }

  function handleUncombineSingle(line, combinedOrder) {
    if (!combinedOrder._isCombined || !combinedOrder._combinedFrom) return;

    const currentLineOrders = [...(sequencedResults[line] || [])];
    const combinedIndex = currentLineOrders.findIndex((o) => o.id === combinedOrder.id);
    if (combinedIndex === -1) return;

    currentLineOrders.splice(combinedIndex, 1);

    const allOrders = uploadContext?.allOrders || [];
    const individualOrders = combinedOrder._combinedFrom.map((sub) => {
      const fullOrder = allOrders.find((o) => o.id === sub.id) || sub;
      return {
        ...fullOrder,
        id: sub.id,
        feedmill_line: line,
        total_volume_mt: String(sub.volume !== undefined ? sub.volume : fullOrder.total_volume_mt || 0),
        item_description: sub.item_description || fullOrder.item_description,
        material_code: sub.material_code_fg || sub.material_code || fullOrder.material_code,
        form: sub.form || fullOrder.form,
        fpr: sub.fpr || fullOrder.fpr,
        fg: sub.fg || fullOrder.fg,
        sfg: sub.sfg || fullOrder.sfg,
        batch_size: sub.batch_size || fullOrder.batch_size,
        production_hours: sub.production_time || fullOrder.production_hours,
        target_avail_date: sub.target_avail_date || fullOrder.target_avail_date,
        category: sub.category || fullOrder.category,
        _isCombined: false,
        _combinedFrom: null,
        _combinedFromLines: null,
        _movedFromLine: sub.line && sub.line !== line ? sub.line : null,
        _plantMovement: sub.line && sub.line !== line ? "new_to_line" : "same",
        _movement: sub.line && sub.line !== line ? "new_to_line" : "same",
      };
    });

    currentLineOrders.splice(combinedIndex, 0, ...individualOrders);

    const sequenced = runLocalSequence(currentLineOrders);
    const withChangeovers = sequenced.map((o) => ({ ...o }));
    applyPreviewChangeovers(withChangeovers, changeoverRules);

    const originalLineOrders = originalSnapshot?.[line] || [];
    const withMovement = withChangeovers.map((order, index) => {
      const newPrio = index + 1;
      const originalIndex = originalLineOrders.findIndex((o) => o.id === order.id);
      let movement = "same";
      let movementDelta = 0;
      if (originalIndex >= 0) {
        const originalPrio = originalIndex + 1;
        movementDelta = originalPrio - newPrio;
        if (movementDelta > 0) movement = "up";
        else if (movementDelta < 0) movement = "down";
      } else {
        movement = "new_to_line";
      }
      return {
        ...order,
        prio: newPrio,
        _plantMovement: order._plantMovement || (originalIndex >= 0 ? "same" : "new_to_line"),
        _movement: movement,
        _movementDelta: Math.abs(movementDelta),
      };
    });

    const updatedResults = { ...sequencedResults, [line]: withMovement };
    setSequencedResults(updatedResults);

    const updatedLog = placementLog.filter((entry) => {
      if (entry.type !== "combined") return true;
      const volMatch = Math.abs((entry.totalVolume || 0) - parseFloat(combinedOrder.total_volume_mt || 0)) < 0.1;
      if (entry.product === (combinedOrder.item_description || combinedOrder.material_code) &&
          entry.toLine === line && volMatch) {
        return false;
      }
      return true;
    });
    setPlacementLog(updatedLog);

    const allCombinedLeft = [];
    Object.values(updatedResults).forEach((orders) => {
      orders.filter((o) => o._isCombined).forEach((o) => allCombinedLeft.push(o));
    });
    setCombinedOrders(allCombinedLeft);

    const stats = calculateUploadSummaryStats(originalSnapshot || {}, updatedResults, allCombinedLeft, updatedLog);
    setSummaryStats(stats);

    if (!Object.values(updatedResults).some((orders) => orders.some((o) => o._isCombined))) {
      setIsCombined(false);
    }

    setAiExplanations(null);
    setUseFallback(false);
    if (updatedLog.length > 0) {
      generateAIExplanations(updatedLog);
    }
  }

  async function generateAIExplanations(log) {
    if (!log || log.length === 0) return;
    setIsLoadingAI(true);
    setAiExplanations(null);
    setUseFallback(false);
    try {
      const { systemPrompt, userPrompt, precomputedInsights } = buildPlantActionsPrompt(log);
      const response = await callPlantActionsAI(systemPrompt, userPrompt, 1400);
      const parsed = parsePlantActionsResponse(response, log, precomputedInsights);
      if (Object.keys(parsed).length >= Math.max(1, log.length * 0.5)) {
        setAiExplanations(parsed);
      } else {
        setUseFallback(true);
      }
    } catch {
      setUseFallback(true);
    }
    setIsLoadingAI(false);
  }

  async function handleApplySequence() {
    if (isApplying || isUploadingOnly || isProcessing || !sequencedResults) return;
    setIsApplying(true);
    try {
      await onApplySequence(sequencedResults, originalSnapshot);
    } catch {
      /* parent shows error toast */
    } finally {
      setIsApplying(false);
    }
  }

  async function handleUploadOnlyClick() {
    if (isApplying || isUploadingOnly) return;
    setIsUploadingOnly(true);
    try {
      await onUploadOnly();
    } catch {
      /* parent shows error toast */
    } finally {
      setIsUploadingOnly(false);
    }
  }

  const activeLines = PLANT_ALL_LINES.filter(
    (line) =>
      (originalSnapshot?.[line]?.length || 0) > 0 ||
      (sequencedResults?.[line]?.length || 0) > 0
  );

  const hasN10D = uploadContext?.hasN10D ?? true;

  return (
    <div className="plant-modal-overlay" style={{ zIndex: 10000 }}>
      <div className="plant-modal-container" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="plant-modal-header">
          <div>
            <div className="plant-modal-title">
              ✨ Auto-Sequence — Post Upload
            </div>
            <div className="plant-modal-subtitle">
              {uploadContext?.allLinesWereBlank
                ? "All lines were blank — orders auto-assigned to optimal lines"
                : "Orders uploaded — review proposed sequence"}
            </div>
          </div>
          <button
            className="plant-modal-close"
            onClick={onCancel}
            disabled={isApplying}
            data-testid="button-upload-as-close"
          >
            ✕
          </button>
        </div>

        {/* N10D warning banner */}
        {!hasN10D && n10dWarningVisible && (
          <div className="upload-as-warning-banner">
            <span className="upload-as-warning-icon">⚠️</span>
            <div className="upload-as-warning-content">
              <span className="upload-as-warning-title">Future Dispatches not uploaded</span>
              <span className="upload-as-warning-text">
                It&apos;s recommended to upload Future Dispatches first before uploading orders,
                so the app can properly assess demand and stock status for optimal sequencing.
              </span>
            </div>
            <button
              className="upload-as-warning-dismiss"
              onClick={() => setN10DWarningVisible(false)}
              data-testid="button-upload-as-warning-dismiss"
            >
              ✕
            </button>
          </div>
        )}

        {/* Processing state */}
        {isProcessing && (
          <div className="upload-as-processing">
            <Loader2 style={{ width: 32, height: 32, color: "var(--nexfeed-primary)", animation: "spin 1s linear infinite" }} />
            <span>{isLoadingAI ? "Generating AI insights…" : "Analyzing and sequencing orders…"}</span>
          </div>
        )}

        {!isProcessing && sequencedResults && summaryStats && (
          <>
            {/* Stats strip */}
            <div className="plant-stats-strip">
              <StatBadge label="Orders" value={summaryStats.totalOrdersBefore} />
              <StatBadge label="Lines Used" value={activeLines.length} />
              {summaryStats.ordersMovedBetweenLines > 0 && (
                <StatBadge label="Cross-Line Moves" value={summaryStats.ordersMovedBetweenLines} color="orange" />
              )}
              {isCombined && summaryStats.ordersCombined > 0 && (
                <StatBadge label="Combined Groups" value={summaryStats.ordersCombined} color="green" />
              )}
            </div>

            {/* Tab bar */}
            <div className="plant-tab-bar">
              <button
                className={`plant-tab-btn${activeTab === "summary" ? " plant-tab-active" : ""}`}
                onClick={() => setActiveTab("summary")}
              >
                📊 All Lines Summary
              </button>
              {activeLines.map((line) => {
                const newCount = (sequencedResults[line] || []).filter(
                  (o) => o._plantMovement === "new_to_line"
                ).length;
                return (
                  <button
                    key={line}
                    className={`plant-tab-btn${activeTab === line ? " plant-tab-active" : ""}`}
                    onClick={() => setActiveTab(line)}
                  >
                    {line}
                    {newCount > 0 && <span className="plant-tab-new-badge">{newCount}</span>}
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
                  onRefreshInsights={() => generateAIExplanations(placementLog)}
                />
              )}
              {activeTab !== "summary" && activeLines.includes(activeTab) && (
                <PlantLineTab
                  key={activeTab}
                  line={activeTab}
                  originalOrders={originalSnapshot?.[activeTab] || []}
                  sequencedOrders={sequencedResults[activeTab] || []}
                  changeoverRules={changeoverRules}
                  inferredTargetMap={{}}
                  onOrdersChange={(line, reorderedOrders) => {
                    setSequencedResults((prev) => ({ ...prev, [line]: reorderedOrders }));
                  }}
                  placementLog={placementLog}
                  aiExplanations={aiExplanations}
                  isLoadingAI={isLoadingAI}
                  useFallback={useFallback}
                  onUncombineSingle={(combinedOrder) => handleUncombineSingle(activeTab, combinedOrder)}
                />
              )}
            </div>

            {/* Applying overlay */}
            {isApplying && (
              <div className="plant-applying-overlay">
                <div className="plant-applying-content">
                  <div className="plant-applying-spinner"></div>
                  <span className="plant-applying-text">Applying to schedule…</span>
                  <span className="plant-applying-sub">Please wait. Do not close this window.</span>
                </div>
              </div>
            )}
          </>
        )}

        {/* Footer */}
        <div className="plant-modal-footer">
          <div style={{ display: "flex", gap: 8 }}>
            {/* Auto-combined on open — per-order uncombine via × button only */}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn-upload-only"
              onClick={handleUploadOnlyClick}
              disabled={isApplying || isUploadingOnly || isCombining}
              data-testid="button-upload-as-upload-only"
            >
              {isUploadingOnly ? (
                <>
                  <Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite", marginRight: 6 }} />
                  Saving…
                </>
              ) : (
                "Upload Only"
              )}
            </button>
            <button
              className={`btn-apply${isApplying ? " btn-apply-loading" : ""}`}
              onClick={handleApplySequence}
              disabled={isApplying || isUploadingOnly || isProcessing || isCombining}
              data-testid="button-upload-as-apply"
            >
              {isApplying ? (
                <>
                  <span className="plant-applying-spinner" style={{ width: 12, height: 12, borderWidth: 2, marginRight: 6, display: "inline-block" }}></span>
                  Applying…
                </>
              ) : (
                "Apply to Schedule"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
