import { useState, useEffect, useRef } from "react";
import {
  ProductTooltipPanel,
  getTooltipPosition,
} from "@/utils/productTooltip";
import {
  X,
  AlertOctagon,
  Loader2,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  GripVertical,
  RefreshCw,
} from "lucide-react";
import { preSortOrders, generateSequenceInsights, generatePerRowSequenceInsights } from "@/services/azureAI";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fmtVolume, formatTime12 } from "../utils/formatters";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

function Spinner({ size = 13, color = "currentColor" }) {
  return (
    <svg className="loading-spinner" width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" stroke={color} strokeWidth="2" strokeLinecap="round" opacity="0.3" />
      <path d="M12.5 7a5.5 5.5 0 01-5.5 5.5" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const BORDER_COLORS = {
  green: "border-l-[#43a047]",
  yellow: "border-l-[#f9a825]",
  red: "border-l-[#e53935]",
  grey: "border-l-[#a1a8b3]",
  blue: "border-l-[#3b82f6]",
  amber: "border-l-[#f59e0b]",
  lightgrey: "border-l-[#d1d5db]",
};

function calcSimCompletion(
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

function fmtDateShort(d) {
  if (!d) return "-";
  try {
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

function fmtCompletionDate(d) {
  if (!d) return "-";
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const yr = d.getFullYear();
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${mo}/${day}/${yr} - ${h}:${m.padStart(2, "0")} ${ampm}`;
}

function fmtDateIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtTime24(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function isAvailDateValid(d) {
  return d && !isNaN(Date.parse(d)) && /^\d{4}-\d{2}-\d{2}/.test(d);
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Returns true if the order has a HARD user/customer deadline (Cat A).
// Cat D (Sufficient) orders can have N10D-derived actual dates — these are NOT hard deadlines.
function isHardDeadline(o, inf) {
  if (!isAvailDateValid(o.target_avail_date)) return false;
  if (o.avail_date_source === 'auto_sequence' && inf?.status === 'Sufficient') return false;
  return true;
}

// Compute 4-level status from auto-sequence inferred data
function computeAutoSeqStatus(inf, category) {
  if (!inf) return "Sufficient";
  // Use pre-computed status first — this is always correct (computed from raw DFL vs Inv)
  if (inf.status) return inf.status;
  // Fallback: derive from DFL vs Inventory directly
  const dfl = Number(inf.dueForLoading) || 0;
  const inv = Number(inf.inventory) || 0;
  // DFL >= Inv → demand exceeds supply → Critical
  if (dfl >= inv) return "Critical";
  if (category === "D") return "Sufficient";
  if (inf.targetDate) {
    const breach = new Date(inf.targetDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daysUntil = Math.ceil((breach - today) / (1000 * 60 * 60 * 24));
    if (daysUntil <= 0) return "Critical";
    if (daysUntil <= 3) return "Urgent";
    if (daysUntil <= 10) return "Monitor";
  }
  return "Sufficient";
}

// Format a date string as "Apr 7"
function fmtShortDate(d) {
  if (!d) return null;
  try {
    const date = new Date(d);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return null;
  }
}

// Mirrors OrderTable's getEffectiveVolume: volume_override if set, else round up to batch multiple
function getEffectiveVol(row) {
  if (row.volume_override != null && row.volume_override !== "") {
    return parseFloat(row.volume_override);
  }
  const orig = parseFloat(row.total_volume_mt) || 0;
  const bs = parseFloat(row.batch_size) || 4;
  if (bs <= 0) return orig;
  return Math.ceil(orig / bs) * bs;
}

function getProdMs(row) {
  const ph =
    row.production_hours != null ? parseFloat(row.production_hours) : 0;
  const co =
    row._effectiveChangeover != null
      ? row._effectiveChangeover
      : row.changeover_time != null
        ? parseFloat(row.changeover_time)
        : 0.17;
  return (ph + co) * 3600000;
}

// Returns the effective deadline for a row: { date, type: 'actual'|'inferred' } or null
function getRowDeadline(row) {
  // Only treat as hard deadline if it's NOT a Sufficient N10D-derived date
  if (isHardDeadline(row, row._inferredData))
    return { date: new Date(row.target_avail_date), type: "actual" };
  if (row._inferredTargetDate)
    return { date: new Date(row._inferredTargetDate), type: "inferred" };
  return null;
}

// Build simRows using actual start dates from orders (or user-local edits).
// Completion cascades from actual start dates — no auto-generated anchors.
// localEdits: { [orderId]: { startDate?, startTime?, completionOverride?: Date, availDate?: string } }
function buildSimRows(rows, localEdits = {}) {
  let prevCompletion = null;

  return rows.map((row, i) => {
    const effectiveChangeover = parseFloat(row.changeover_time ?? 0.17) || 0.17;

    const edits = localEdits[row.id] || {};
    const startDate =
      edits.startDate !== undefined ? edits.startDate : row.start_date || null;
    const startTime =
      edits.startTime !== undefined ? edits.startTime : row.start_time || null;

    // Completion override: a Date object stored by the user in preview
    const completionOverride = edits.completionOverride || null;

    // Apply fallback rules for date/time
    let effectiveStartDate = startDate;
    let effectiveStartTime = startTime;
    if (effectiveStartDate && !effectiveStartTime) {
      // Date only → default to 8:00 AM
      effectiveStartTime = "08:00";
    } else if (!effectiveStartDate && effectiveStartTime && prevCompletion) {
      // Time only → use previous completion's date
      effectiveStartDate = fmtDateIso(prevCompletion);
    }

    let completion = null;
    if (completionOverride) {
      // Override: skip recalculation, cascade from override
      completion = completionOverride;
    } else if (effectiveStartDate && effectiveStartTime) {
      // Has effective start → compute completion from it
      completion = calcSimCompletion(
        effectiveStartDate,
        effectiveStartTime,
        row.production_hours,
        effectiveChangeover,
      );
    } else if (prevCompletion) {
      // No start info at all — cascade from previous completion
      completion = calcSimCompletion(
        fmtDateIso(prevCompletion),
        fmtTime24(prevCompletion),
        row.production_hours,
        effectiveChangeover,
      );
    }
    prevCompletion = completion || prevCompletion;

    // Determine status
    let status = row._category === "D" ? "lightgrey" : "grey";
    const dl = getRowDeadline(row);
    if (dl && completion) {
      const deadlineEnd = new Date(dl.date);
      deadlineEnd.setHours(23, 59, 59, 999);
      const missed = completion.getTime() > deadlineEnd.getTime();
      status =
        dl.type === "actual"
          ? missed
            ? "red"
            : "green"
          : missed
            ? "amber"
            : "blue";
    } else if (dl && !completion) {
      status = dl.type === "actual" ? "green" : "blue";
    }

    const wasMoved =
      row._originalPrio !== undefined && row._originalPrio !== i + 1;

    // Avail date: use preview override if set, else original
    const _previewAvailDate =
      edits.availDate !== undefined ? edits.availDate : row.target_avail_date;

    return {
      ...row,
      _effectiveChangeover: effectiveChangeover,
      _simStartDate: startDate,
      _simStartTime: startTime,
      _simCompletion: completion,
      _simCompletionStr: completion ? fmtCompletionDate(completion) : null,
      _simStatus: status,
      _simMoved: wasMoved,
      _simPrio: i + 1,
      _hasCompletionOverride: !!completionOverride,
      _previewAvailDate,
    };
  });
}

// Returns true when the pointer is directly over selectable text —
// used to allow text selection while dragging from empty row space.
function isOverText(e) {
  const target = e.target;
  if (target.closest?.(".sim-drag-handle")) return false;
  const tag = target.tagName?.toUpperCase();
  if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(tag)) return true;
  if (target.getAttribute?.("role") === "combobox" || target.getAttribute?.("role") === "listbox") return true;
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
            if (
              e.clientX >= rects[i].left && e.clientX <= rects[i].right &&
              e.clientY >= rects[i].top && e.clientY <= rects[i].bottom
            ) return true;
          }
        }
      }
    }
  } catch (_) {}
  return false;
}

export default function AutoSequenceModal({
  isOpen,
  onClose,
  onApply,
  currentOrders,
  result,
  loading,
  feedmillName,
  lineName,
  inferredTargetMap = {},
}) {
  const [simRows, setSimRows] = useState([]);
  const [originalAiRows, setOriginalAiRows] = useState([]);
  const [localEdits, setLocalEdits] = useState({}); // { [id]: { startDate?, startTime? } }
  const [editingCell, setEditingCell] = useState(null); // { id, field: 'date'|'time' }
  const [insightsOpen, setInsightsOpen] = useState(true);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [liveInsights, setLiveInsights] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [stockTooltipData, setStockTooltipData] = useState(null);
  const [stockTooltipPos, setStockTooltipPos] = useState({ x: 0, y: 0 });
  const stockTooltipTimerRef = useRef(null);
  const [reanalyzeNote, setReanalyzeNote] = useState(null);
  const [isReanalyzing, setIsReanalyzing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  // Pending drag dialog: { type: 'movingPlanned'|'abovePlanned', fromIndex, toIndex, reordered }
  const [dragWarnDialog, setDragWarnDialog] = useState(null);
  // Inline edit state for Start Date / Start Time cells
  const [editDateVal, setEditDateVal] = useState("");
  const [editTimeH, setEditTimeH] = useState("12");
  const [editTimeM, setEditTimeM] = useState("00");
  const [editTimeAP, setEditTimeAP] = useState("AM");

  // Per-row Sequence Insight column
  const [sequenceInsights, setSequenceInsights] = useState({});
  const [isGeneratingRowInsights, setIsGeneratingRowInsights] = useState(false);
  const rowInsightsTriggerRef = useRef(false);

  // Avail date editing in preview
  const [editAvailDateId, setEditAvailDateId] = useState(null);
  const [editAvailDateVal, setEditAvailDateVal] = useState("");

  // Completion date editing in preview
  const [editCompletionId, setEditCompletionId] = useState(null);
  const [editCompletionDate, setEditCompletionDate] = useState("");
  const [editCompletionTimeH, setEditCompletionTimeH] = useState("12");
  const [editCompletionTimeM, setEditCompletionTimeM] = useState("00");
  const [editCompletionTimeAP, setEditCompletionTimeAP] = useState("AM");

  // Completion override confirmation dialog: { rowId, pendingDate: Date }
  const [completionOverrideDialog, setCompletionOverrideDialog] = useState(null);

  const orderMapRef = useRef({});

  // Excluded-status set matches getAutoSequenceOrders filter in Dashboard
  const EXCLUDED_STATUSES_SET = new Set([
    "completed", "cancel_po", "in_production",
    "ongoing_batching", "ongoing_pelleting", "ongoing_bagging",
  ]);

  // Available slots = prio numbers (1-based) of non-excluded orders in currentOrders
  const availableSlots = (currentOrders || [])
    .map((o, i) => ({ prio: i + 1, excluded: EXCLUDED_STATUSES_SET.has(o.status) }))
    .filter((x) => !x.excluded)
    .map((x) => x.prio);

  // Re-assign _simPrio to match the real order-table slot numbers
  const assignSlots = (rows) =>
    rows.map((row, i) => ({
      ...row,
      _simPrio: availableSlots[i] ?? i + 1,
    }));

  const buildRows = (orderedOrders, edits = {}) => {
    return orderedOrders.map((o, i) => {
      const inf = inferredTargetMap[o.material_code];
      const _todayStr = new Date().toISOString().slice(0, 10);
      const cat =
        o._category ||
        (isHardDeadline(o, inf)
          ? "A"
          : inf?.status === "Sufficient"
            ? "D"
            : inf?.status === "Critical" ||
                inf?.status === "Urgent" ||
                inf?.status === "Monitor"
              ? "B"
              : "C");
      return {
        ...o,
        _category: cat,
        _inferredTargetDate:
          cat === "B"
            ? inf?.targetDate ||
              (inf?.status === "Critical" ? _todayStr : null)
            : cat === "D"
              ? inf?.targetDate || null
              : null,
        _inferredData: inf || null,
        _originalPrio: o._originalPrio ?? i + 1,
      };
    });
  };

  useEffect(() => {
    if (!result?.proposedSequence || !currentOrders?.length) return;
    const oMap = {};
    for (const o of currentOrders) oMap[o.id] = o;
    orderMapRef.current = oMap;

    const sorted = [...result.proposedSequence].sort(
      (a, b) => a.proposedPrio - b.proposedPrio,
    );
    // Record each order's original position in the user's current list so we can
    // highlight rows that the AI moved to a different position.
    const originalPosMap = {};
    currentOrders.forEach((o, i) => {
      originalPosMap[o.id] = i + 1;
    });

    let rows = sorted
      .map((p) => {
        const o = oMap[p.id];
        if (!o) return null;
        return {
          ...o,
          _originalPrio: originalPosMap[p.id] ?? p.proposedPrio,
          _aiStatus: p.status,
        };
      })
      .filter(Boolean);

    // Compact combined groups: ensure each lead is immediately followed by its children.
    // Children in the AI sequence may be scattered — bring them right after their lead.
    const leadToChildren = {};
    const childSet = new Set();
    rows.forEach((r) => {
      if (r.parent_id) {
        if (!leadToChildren[r.parent_id]) leadToChildren[r.parent_id] = [];
        leadToChildren[r.parent_id].push(r);
        childSet.add(r.id);
      }
    });
    if (Object.keys(leadToChildren).length > 0) {
      const compacted = [];
      rows.forEach((r) => {
        if (childSet.has(r.id)) return; // skip children — added with their lead
        compacted.push(r);
        const children = leadToChildren[r.id];
        if (children) children.forEach((c) => compacted.push(c));
      });
      rows = compacted;
    }

    const withCats = buildRows(rows);
    const edits = {};
    const built = buildSimRows(withCats, edits);
    setLocalEdits(edits);
    setSimRows(assignSlots(built));
    setOriginalAiRows(built);
    setReanalyzeNote(null);
    setLiveInsights(null);
  }, [result, currentOrders, inferredTargetMap]);

  const handleRefreshInsights = async () => {
    if (insightsLoading || simRows.length === 0) return;
    setInsightsLoading(true);
    setInsightsOpen(true);
    try {
      const simRowIds = new Set(simRows.map((r) => r.id));
      const excludedOrders = (currentOrders || [])
        .map((o, i) => ({ ...o, _realPrio: i + 1 }))
        .filter((o) => !simRowIds.has(o.id));
      const fresh = await generateSequenceInsights(
        simRows,
        feedmillName,
        lineName,
        excludedOrders,
      );
      if (fresh && fresh.length > 0) setLiveInsights(fresh);
    } catch {
      // keep existing insights on error
    } finally {
      setInsightsLoading(false);
    }
  };

  // ── Per-row Sequence Insight ─────────────────────────────────────────────
  const generateRowInsights = async (rows) => {
    const targetRows = rows || simRows;
    if (!targetRows || targetRows.length === 0) return;
    setIsGeneratingRowInsights(true);
    try {
      const simRowIds = new Set(targetRows.map((r) => r.id));
      const excluded = (currentOrders || [])
        .map((o, i) => ({ ...o, _realPrio: i + 1 }))
        .filter((o) => !simRowIds.has(o.id));
      const insights = await generatePerRowSequenceInsights(targetRows, excluded);
      setSequenceInsights(insights);
    } catch {
      // keep existing on error
    } finally {
      setIsGeneratingRowInsights(false);
    }
  };

  const handleRefreshRowInsights = () => {
    generateRowInsights();
  };

  // Auto-generate insights when simRows first populate.
  // IMPORTANT: this useEffect must stay BEFORE `if (!isOpen) return null`
  // so it is called unconditionally (React Rules of Hooks).
  useEffect(() => {
    if (simRows.length > 0 && !rowInsightsTriggerRef.current) {
      rowInsightsTriggerRef.current = true;
      generateRowInsights(simRows);
    }
    if (simRows.length === 0) {
      rowInsightsTriggerRef.current = false;
      setSequenceInsights({});
    }
  }, [simRows]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOpen) return null;

  const summary = result?.summary || {};
  const insights = result?.insights || [];

  const conflictCount = simRows.filter((r) => r._simStatus === "red").length;
  const tradeoffCount = simRows.filter(
    (r) => r._simStatus === "yellow" || r._simStatus === "amber",
  ).length;
  const stockTargetedCount =
    summary.stockTargeted ?? simRows.filter((r) => r._category === "B").length;
  const stockSufficientCount =
    summary.stockSufficient ??
    simRows.filter((r) => r._category === "D").length;
  const datedCount =
    summary.datedOrders ?? simRows.filter((r) => r._category === "A").length;
  const gapFillerCount =
    summary.gapFillersPlaced ??
    simRows.filter((r) => r._category === "C").length;
  const plannedCount = simRows.filter((r) => r.status === "planned").length;

  // Pure helper: compute the reordered array for a drag without applying state.
  // Handles combined-group logic (lead + children move together).
  const computeReorderedRows = (fromIndex, toIndex, src) => {
    const leadToChildIndices = {};
    const childLeadIndex = {};
    src.forEach((row, i) => {
      if (row.parent_id) {
        const leadIdx = src.findIndex((r) => r.id === row.parent_id);
        if (leadIdx >= 0) {
          if (!leadToChildIndices[leadIdx]) leadToChildIndices[leadIdx] = [];
          leadToChildIndices[leadIdx].push(i);
          childLeadIndex[i] = leadIdx;
        }
      }
    });

    const isLead = leadToChildIndices[fromIndex] !== undefined;
    const isChild = childLeadIndex[fromIndex] !== undefined;

    let reordered;
    if (isChild) {
      const leadIdx = childLeadIndex[fromIndex];
      const groupIndices = new Set([leadIdx, ...(leadToChildIndices[leadIdx] || [])]);
      const group = src.filter((_, i) => groupIndices.has(i));
      const rest = src.filter((_, i) => !groupIndices.has(i));
      const destInRest = Math.min(toIndex, rest.length);
      rest.splice(destInRest, 0, ...group);
      reordered = rest;
    } else if (isLead) {
      const groupIndices = new Set([fromIndex, ...(leadToChildIndices[fromIndex] || [])]);
      const group = src.filter((_, i) => groupIndices.has(i));
      const rest = src.filter((_, i) => !groupIndices.has(i));
      const destRow = src[toIndex];
      let insertIdx = destRow ? rest.findIndex((r) => r.id === destRow.id) : rest.length;
      if (insertIdx < 0) insertIdx = Math.min(toIndex, rest.length);
      if (toIndex > fromIndex) insertIdx = Math.min(insertIdx + 1, rest.length);
      rest.splice(insertIdx, 0, ...group);
      reordered = rest;
    } else {
      reordered = [...src];
      const [moved] = reordered.splice(fromIndex, 1);
      reordered.splice(toIndex, 0, moved);
    }
    return reordered;
  };

  // Core reorder executor — call after any warnings are accepted
  const executePreviewDrag = (fromIndex, toIndex, rows) => {
    const src = rows || simRows;
    const movedRow = src[fromIndex];
    if (!movedRow) return;
    const reordered = computeReorderedRows(fromIndex, toIndex, src);
    const rebuilt = buildSimRows(reordered, localEdits);
    setSimRows(assignSlots(rebuilt));
  };

  const handleDragEnd = (dragResult) => {
    if (
      !dragResult.destination ||
      dragResult.destination.index === dragResult.source.index
    )
      return;

    const fromIndex = dragResult.source.index;
    const toIndex = dragResult.destination.index;
    if (!simRows[fromIndex]) return;

    // Step 1: compute the reordered array without applying it
    const reordered = computeReorderedRows(fromIndex, toIndex, simRows);

    // Step 2: record each Planned order's position BEFORE the move
    const plannedBefore = {};
    simRows.forEach((row, i) => {
      if (row.status === "planned") plannedBefore[row.id] = i + 1;
    });

    // Step 3: find all Planned orders whose position changed AFTER the move
    const affectedPlannedOrders = [];
    reordered.forEach((row, i) => {
      if (row.status === "planned") {
        const oldPrio = plannedBefore[row.id];
        const newPrio = i + 1;
        if (oldPrio !== undefined && oldPrio !== newPrio) {
          affectedPlannedOrders.push({
            name: row.item_description || row.fpr || "Unknown",
            fromPrio: oldPrio,
            toPrio: newPrio,
            direction: newPrio > oldPrio ? "down" : "up",
          });
        }
      }
    });

    // Step 4: show warning if any Planned order is affected; otherwise apply immediately
    if (affectedPlannedOrders.length > 0) {
      setDragWarnDialog({ fromIndex, toIndex, affectedPlannedOrders });
      return;
    }

    executePreviewDrag(fromIndex, toIndex);
  };

  const handleReset = () => {
    setLocalEdits({});
    setSimRows(
      assignSlots(
        buildSimRows(
          originalAiRows.map((r) => ({ ...r })),
          {},
        ),
      ),
    );
    setReanalyzeNote(null);
  };

  const handleReanalyze = async () => {
    if (isReanalyzing) return;
    setIsReanalyzing(true);
    setReanalyzeNote(null);
    // Yield to the browser so the spinner renders before the heavy computation
    await new Promise((r) => setTimeout(r, 30));
    try {
      // Re-sort non-dated orders only, keep dated orders in current positions
      const baseOrders = simRows.map((r) => ({
        ...r,
        start_date:
          localEdits[r.id]?.startDate !== undefined
            ? localEdits[r.id].startDate
            : r.start_date,
        start_time:
          localEdits[r.id]?.startTime !== undefined
            ? localEdits[r.id].startTime
            : r.start_time,
      }));
      const resorted = preSortOrders(baseOrders, inferredTargetMap);

      // Compact combined groups after re-sort
      const lcMap = {};
      const cSet = new Set();
      resorted.forEach((r) => {
        if (r.parent_id) {
          if (!lcMap[r.parent_id]) lcMap[r.parent_id] = [];
          lcMap[r.parent_id].push(r);
          cSet.add(r.id);
        }
      });
      let compactedResort = resorted;
      if (Object.keys(lcMap).length > 0) {
        compactedResort = [];
        resorted.forEach((r) => {
          if (cSet.has(r.id)) return;
          compactedResort.push(r);
          (lcMap[r.id] || []).forEach((c) => compactedResort.push(c));
        });
      }

      const withCats = buildRows(compactedResort);
      const built = buildSimRows(withCats, localEdits);
      const moved = built.filter((r) => r._simMoved).length;
      setSimRows(assignSlots(built));
      setReanalyzeNote(
        `Re-analyzed: ${moved} order${moved !== 1 ? "s" : ""} repositioned.`,
      );
    } finally {
      setIsReanalyzing(false);
    }
  };

  const handleSaveEdit = (id, field, value) => {
    const newEdits = {
      ...localEdits,
      [id]: { ...(localEdits[id] || {}), [field]: value },
    };
    setLocalEdits(newEdits);
    setSimRows((prev) =>
      assignSlots(
        buildSimRows(
          prev.map((r) =>
            r.id === id
              ? {
                  ...r,
                  [`_sim${field === "startDate" ? "StartDate" : "StartTime"}`]:
                    value,
                }
              : r,
          ),
          newEdits,
        ),
      ),
    );
    setEditingCell(null);
  };

  const handleSaveAvailDate = (id, value) => {
    const newEdits = {
      ...localEdits,
      [id]: { ...(localEdits[id] || {}), availDate: value },
    };
    setLocalEdits(newEdits);
    setSimRows((prev) => assignSlots(buildSimRows(prev.map((r) => r), newEdits)));
    setEditAvailDateId(null);
  };

  const handleRequestCompletionOverride = (rowId) => {
    // Parse the current completion edit values into a Date
    let h = parseInt(editCompletionTimeH, 10) || 12;
    const m = parseInt(editCompletionTimeM, 10) || 0;
    if (editCompletionTimeAP === "PM" && h !== 12) h += 12;
    if (editCompletionTimeAP === "AM" && h === 12) h = 0;
    if (!editCompletionDate) return;
    const d = new Date(editCompletionDate);
    if (isNaN(d.getTime())) return;
    d.setHours(h, m, 0, 0);
    setCompletionOverrideDialog({ rowId, pendingDate: d });
  };

  const handleConfirmCompletionOverride = () => {
    if (!completionOverrideDialog) return;
    const { rowId, pendingDate } = completionOverrideDialog;
    const newEdits = {
      ...localEdits,
      [rowId]: { ...(localEdits[rowId] || {}), completionOverride: pendingDate },
    };
    setLocalEdits(newEdits);
    setSimRows((prev) => assignSlots(buildSimRows(prev.map((r) => r), newEdits)));
    setCompletionOverrideDialog(null);
    setEditCompletionId(null);
  };

  const handleRemoveCompletionOverride = (id) => {
    const updated = { ...(localEdits[id] || {}) };
    delete updated.completionOverride;
    const newEdits = { ...localEdits, [id]: updated };
    setLocalEdits(newEdits);
    setSimRows((prev) => assignSlots(buildSimRows(prev.map((r) => r), newEdits)));
  };

  const handleApplyClick = () => {
    setConfirmOpen(true);
  };

  const handleConfirmApply = async () => {
    if (isApplying) return;
    setIsApplying(true);
    const sequence = simRows.map((row, i) => ({
      id: row.id,
      proposedPrio: i + 1,
      startDate: row._simStartDate,
      startTime: row._simStartTime,
      estimatedCompletion: row._simCompletionStr,
      status: row._simStatus,
      moved: row._simMoved,
      category: row._category,
      targetDate: row._inferredTargetDate || null,
      availDate: row._previewAvailDate !== undefined ? row._previewAvailDate : row.target_avail_date,
    }));
    try {
      await onApply(sequence);
    } catch (err) {
      console.error("Apply sequence failed:", err);
    } finally {
      setIsApplying(false);
    }
    setConfirmOpen(false);
    onClose();
  };

  const numBatches = (row) => {
    const vol = getEffectiveVol(row);
    const bs = parseFloat(row.batch_size);
    if (!bs || bs <= 0) return "-";
    return Math.ceil(vol / bs);
  };

  // Parse "HH:MM" (24h) → { h: "12", m: "00", ap: "AM" } for 12h editor
  const parse12FromTime24 = (t) => {
    if (!t) return { h: "12", m: "00", ap: "AM" };
    const [hStr, mStr] = t.split(":");
    let h = parseInt(hStr, 10) || 0;
    const m = mStr || "00";
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return { h: String(h).padStart(2, "0"), m: m.padStart(2, "0"), ap };
  };

  // Convert 12h components back to "HH:MM" (24h)
  const to24h = (h, m, ap) => {
    let hNum = parseInt(h, 10) || 12;
    if (ap === "PM" && hNum !== 12) hNum += 12;
    if (ap === "AM" && hNum === 12) hNum = 0;
    return `${String(hNum).padStart(2, "0")}:${String(m || "00").padStart(2, "0")}`;
  };

  const formatProductionHours = (hours) => {
    if (!hours || isNaN(parseFloat(hours))) return "0.00";
    return parseFloat(hours).toFixed(2);
  };

  const formatChangeover = (hours) => {
    const val = parseFloat(hours);
    if (!hours || isNaN(val) || val === 0) return "0:00";
    const totalMinutes = Math.round(val * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${h}:${String(m).padStart(2, "0")}`;
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        onClick={onClose}
      >
        <div
          className="bg-white rounded-xl shadow-2xl w-[98vw] max-w-[1400px] h-[92vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-6 pt-5 pb-4 border-b border-gray-200 shrink-0">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h2
                  className="flex items-center gap-1.5 text-[18px] font-bold text-[#1a1a1a] leading-tight"
                  data-testid="text-modal-title"
                >
                  <span style={{ color: "#fd5108" }}>✨</span> Auto-Sequence
                  Preview
                </h2>
                <p className="text-[13px] text-[#6b7280] mt-0.5">
                  {feedmillName} — {lineName}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 mt-0.5"
                onClick={onClose}
                data-testid="button-close-autosequence"
              >
                <X className="h-4 w-4 text-gray-500" />
              </Button>
            </div>
          </div>

          {loading ? (
            <div className="flex-1 flex flex-col items-center justify-center py-16 px-8">
              <Loader2 className="h-10 w-10 text-[#fd5108] animate-spin mb-4" />
              <p
                className="text-sm font-medium text-[#2e343a]"
                data-testid="text-loading"
              >
                Analyzing {currentOrders.length} orders... Building optimal
                sequence...
              </p>
              <p className="text-xs text-gray-400 mt-1">
                This may take a few seconds
              </p>
            </div>
          ) : result?.error ? (
            <div className="flex-1 flex flex-col items-center justify-center py-16 px-8">
              <AlertOctagon className="h-10 w-10 text-red-400 mb-4" />
              <p className="text-sm text-red-600" data-testid="text-error">
                {result.error}
              </p>
            </div>
          ) : (
            <>
              {/* Metric cards */}
              <div
                className="px-6 py-3 border-b border-gray-100 flex items-center gap-3 flex-wrap shrink-0"
                data-testid="section-summary"
              >
                {[
                  {
                    value: summary.totalOrders || simRows.length,
                    label: "Orders",
                    color: "#1a1a1a",
                  },
                  {
                    value: datedCount + stockTargetedCount,
                    label: "With Deadline",
                    color: "#3b82f6",
                  },
                  {
                    value: gapFillerCount,
                    label: "No Deadline",
                    color: "#9ca3af",
                  },
                  {
                    value: stockSufficientCount,
                    label: "Stock Sufficient",
                    color: "#43a047",
                  },
                  {
                    value: conflictCount,
                    label: "Conflicts",
                    color: conflictCount > 0 ? "#e53935" : "#9ca3af",
                  },
                  ...(plannedCount > 0 ? [{
                    value: plannedCount,
                    label: "Planned",
                    color: "#2563eb",
                  }] : []),
                ].map(({ value, label, color }) => (
                  <div
                    key={label}
                    style={{
                      border: "1px solid #e5e7eb",
                      borderRadius: 8,
                      padding: "8px 16px",
                      background: "white",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 18,
                        fontWeight: 700,
                        color,
                        lineHeight: 1.2,
                      }}
                    >
                      {value}
                    </div>
                    <div
                      style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}
                    >
                      {label}
                    </div>
                  </div>
                ))}
                {tradeoffCount > 0 && (
                  <div
                    style={{
                      border: "1px solid #e5e7eb",
                      borderRadius: 8,
                      padding: "8px 16px",
                      background: "white",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 18,
                        fontWeight: 700,
                        color: "#f59e0b",
                        lineHeight: 1.2,
                      }}
                    >
                      {tradeoffCount}
                    </div>
                    <div
                      style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}
                    >
                      Warnings
                    </div>
                  </div>
                )}
              </div>

              {/* AI Insights panel */}
              {(insights.length > 0 || liveInsights) && (
                <div className="px-6 py-3 border-b border-gray-100 shrink-0">
                  <div
                    style={{
                      border: "1px solid #e5e7eb",
                      borderRadius: 8,
                      background: "#ffffff",
                      overflow: "hidden",
                    }}
                  >
                    <div className="flex items-center justify-between px-4 py-2.5">
                      <span
                        style={{
                          fontSize: 14,
                          fontWeight: 600,
                          color: "#1a1a1a",
                        }}
                      >
                        🤖 Sequence Analysis
                      </span>
                      <div className="flex items-center gap-3">
                        <button
                          onClick={handleRefreshInsights}
                          disabled={insightsLoading}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            fontSize: 11,
                            color: insightsLoading ? "#9ca3af" : "#fd5108",
                            background: "none",
                            border: "none",
                            padding: 0,
                            cursor: insightsLoading ? "default" : "pointer",
                          }}
                          data-testid="button-refresh-insights"
                        >
                          <RefreshCw
                            className={insightsLoading ? "animate-spin" : ""}
                            style={{ width: 11, height: 11 }}
                          />
                          {insightsLoading ? "Analyzing..." : "Refresh"}
                        </button>
                        <button
                          onClick={() => setInsightsOpen(!insightsOpen)}
                          style={{
                            fontSize: 11,
                            color: "#9ca3af",
                            cursor: "pointer",
                            background: "none",
                            border: "none",
                            padding: 0,
                          }}
                          data-testid="button-toggle-insights"
                        >
                          {insightsOpen ? "▲ Collapse" : "▼ Expand"}
                        </button>
                      </div>
                    </div>
                    {insightsOpen && (
                      <div
                        className="px-4 pb-3 max-h-[220px] overflow-y-auto"
                        data-testid="section-insights"
                        style={{ borderTop: "1px solid #e5e7eb" }}
                      >
                        {insightsLoading ? (
                          <p
                            style={{
                              fontSize: 11,
                              color: "#9ca3af",
                              fontStyle: "italic",
                              paddingTop: 10,
                            }}
                          >
                            Analyzing sequence...
                          </p>
                        ) : (
                          <div
                            className="pt-2"
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: 12,
                            }}
                          >
                            {(liveInsights || insights).map((insight, i) => {
                              const isHeading = /^[📋⚡⏱📅⚠💡]/.test(
                                insight.trimStart(),
                              );
                              if (isHeading) {
                                const newline = insight.indexOf("\n");
                                const heading =
                                  newline > -1
                                    ? insight.slice(0, newline).trim()
                                    : insight.trim();
                                const body =
                                  newline > -1
                                    ? insight.slice(newline + 1).trim()
                                    : "";
                                return (
                                  <div key={i}>
                                    {i > 0 && (
                                      <div
                                        style={{
                                          borderTop: "1px dashed #e5e7eb",
                                          marginBottom: 12,
                                        }}
                                      />
                                    )}
                                    <p
                                      style={{
                                        fontSize: 12,
                                        fontWeight: 600,
                                        color: "#1a1a1a",
                                        marginBottom: 4,
                                      }}
                                    >
                                      {heading}
                                    </p>
                                    {body && (
                                      <p
                                        style={{
                                          fontSize: 11,
                                          color: "#4b5563",
                                          lineHeight: 1.6,
                                          whiteSpace: "pre-wrap",
                                        }}
                                      >
                                        {body}
                                      </p>
                                    )}
                                  </div>
                                );
                              }
                              return (
                                <p
                                  key={i}
                                  style={{
                                    fontSize: 11,
                                    color: "#4b5563",
                                    lineHeight: 1.6,
                                  }}
                                >
                                  {insight}
                                </p>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="flex-1 overflow-auto px-6 py-3">
                {/* Excluded count note */}
                {availableSlots.length < (currentOrders || []).length && (
                  <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 8 }}>
                    {(currentOrders || []).length - availableSlots.length} order(s) excluded (Done, In Production, On-going, Cancelled)
                  </div>
                )}
                <div
                  style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: 8,
                  }}
                >
                  <DragDropContext onDragEnd={handleDragEnd}>
                    <table
                      className="preview-table"
                      style={{
                        minWidth: 1980,
                        width: "100%",
                        borderCollapse: "separate",
                        borderSpacing: 0,
                        fontSize: 12,
                      }}
                    >
                      <thead className="asm-thead">
                        {(() => {
                          const TH = ({ style, children }) => (
                            <th style={{
                              position: "sticky",
                              top: 0,
                              zIndex: 20,
                              background: "#f9fafb",
                              fontSize: 10,
                              fontWeight: 400,
                              color: "#6b7280",
                              padding: "8px 6px",
                              boxShadow: "0 1px 0 #e5e7eb",
                              ...style,
                            }}>{children}</th>
                          );
                          return (
                            <tr>
                              <TH style={{ width: 32, padding: "8px 4px" }}></TH>
                              <TH style={{ width: 50, textAlign: "center" }}>Prio</TH>
                              <TH style={{ width: 80, textAlign: "left" }}>FPR</TH>
                              <TH style={{ width: 120, textAlign: "left" }}>Planned Order</TH>
                              <TH style={{ width: 140, textAlign: "left" }}>Material Code (FG)</TH>
                              <TH style={{ width: 280, textAlign: "left" }}>Item Description</TH>
                              <TH style={{ width: 70, textAlign: "center" }}>Form</TH>
                              <TH style={{ width: 80, textAlign: "center" }}>Volume (MT)</TH>
                              <TH style={{ width: 80, textAlign: "center" }}>Batch Size</TH>
                              <TH style={{ width: 70, textAlign: "center" }}>Batches</TH>
                              <TH style={{ width: 130, textAlign: "left" }}>Production Time</TH>
                              <TH style={{ width: 140, textAlign: "center" }}>Start Date</TH>
                              <TH style={{ width: 140, textAlign: "center" }}>Start Time</TH>
                              <TH style={{ width: 140, textAlign: "left" }}>Avail Date</TH>
                              <TH style={{ width: 175, textAlign: "left" }}>Completion Date</TH>
                              <TH style={{ minWidth: 280, width: 300, whiteSpace: "nowrap" }}>
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                                  <span style={{ fontSize: 11, fontWeight: 600, color: "#6b7280" }}>✨ Sequence Insight</span>
                                  <button
                                    onClick={handleRefreshRowInsights}
                                    disabled={isGeneratingRowInsights}
                                    style={{
                                      background: "none",
                                      border: "none",
                                      cursor: isGeneratingRowInsights ? "not-allowed" : "pointer",
                                      fontSize: 10,
                                      fontWeight: 500,
                                      color: isGeneratingRowInsights ? "#9ca3af" : "#fd5108",
                                      padding: 0,
                                      opacity: isGeneratingRowInsights ? 0.6 : 1,
                                      flexShrink: 0,
                                    }}
                                  >
                                    {isGeneratingRowInsights ? "Refreshing..." : "Refresh"}
                                  </button>
                                </div>
                              </TH>
                            </tr>
                          );
                        })()}
                      </thead>
                      <Droppable droppableId="sim-table">
                        {(droppableProvided) => (
                          <tbody
                            ref={droppableProvided.innerRef}
                            {...droppableProvided.droppableProps}
                          >
                            {simRows.map((row, index) => {
                              const borderColor =
                                BORDER_COLORS[row._simStatus] ||
                                BORDER_COLORS.grey;
                              // Cat D = Sufficient regardless of avail_date string
                              const isStockSufficient =
                                row._category === "D" ||
                                row.target_avail_date === "stock_sufficient";
                              // Cat B rows show inferred date; C rows show raw label
                              const isNonDate =
                                !isStockSufficient &&
                                row.target_avail_date &&
                                !isAvailDateValid(row.target_avail_date) &&
                                row._category !== "B";
                              const _infStatus = row._inferredData?.status;
                              const vol = getEffectiveVol(row);
                              const isLeadRow =
                                !row.parent_id &&
                                !!row.original_order_ids?.length;
                              const isChildRow = !!row.parent_id;

                              const isPlanned = row.status === "planned";
                              return (
                                <Draggable
                                  key={row.id}
                                  draggableId={String(row.id)}
                                  index={index}
                                  isDragDisabled={false}
                                >
                                  {(draggableProvided, snapshot) => (
                                    <tr
                                      ref={draggableProvided.innerRef}
                                      {...draggableProvided.draggableProps}
                                      onMouseDown={(e) => {
                                        if (e.target.closest?.(".sim-drag-handle")) return;
                                        if (isOverText(e)) return;
                                        const gripEl = e.currentTarget.querySelector(".sim-drag-handle");
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
                                        if (e.target.closest?.(".sim-drag-handle")) return;
                                        const gripEl = e.currentTarget.querySelector(".sim-drag-handle");
                                        if (gripEl) {
                                          e.preventDefault();
                                          gripEl.dispatchEvent(new TouchEvent("touchstart", {
                                            bubbles: true, cancelable: true, touches: e.touches,
                                          }));
                                        }
                                      }}
                                      className={cn(
                                        "border-l-4 transition-all",
                                        isPlanned
                                          ? "border-l-[#2563eb]"
                                          : isLeadRow
                                            ? "border-l-[#1565c0]"
                                            : isChildRow
                                              ? "border-l-[#1976d2]"
                                              : borderColor,
                                        isPlanned
                                          ? "bg-[#eff6ff]"
                                          : isLeadRow
                                            ? "bg-[#d0e8fc]"
                                            : isChildRow
                                              ? "bg-[#e3f2fd]"
                                              : row._simMoved
                                                ? "bg-[#fffbeb]"
                                                : "bg-white",
                                        snapshot.isDragging &&
                                          "shadow-xl bg-white ring-2 ring-[#fd5108]/20 opacity-95",
                                      )}
                                      style={{
                                        ...draggableProvided.draggableProps
                                          .style,
                                        borderBottom: "1px solid #f3f4f6",
                                        minHeight: 44,
                                        ...(snapshot.isDragging
                                          ? {
                                              boxShadow:
                                                "0 8px 32px rgba(0,0,0,0.15)",
                                            }
                                          : {}),
                                      }}
                                      data-testid={`row-sim-order-${row.id}`}
                                    >
                                      {/* Drag handle */}
                                      <td
                                        className="sim-drag-handle"
                                        style={{
                                          width: 32,
                                          padding: "10px 4px",
                                          textAlign: "center",
                                          cursor: "grab",
                                        }}
                                        {...draggableProvided.dragHandleProps}
                                      >
                                        <GripVertical
                                          style={{
                                            width: 14,
                                            height: 14,
                                            color: "#d1d5db",
                                            display: "block",
                                            margin: "0 auto",
                                          }}
                                        />
                                      </td>

                                      {/* Prio */}
                                      <td
                                        style={{
                                          width: 50,
                                          padding: "10px 6px",
                                          textAlign: "center",
                                        }}
                                        data-testid={`text-sim-prio-${row.id}`}
                                      >
                                        {(() => {
                                          const statusColors = {
                                            green: {
                                              bg: "#dcfce7",
                                              text: "#166534",
                                            },
                                            blue: {
                                              bg: "#dbeafe",
                                              text: "#1d4ed8",
                                            },
                                            amber: {
                                              bg: "#fef3c7",
                                              text: "#92400e",
                                            },
                                            red: {
                                              bg: "#fee2e2",
                                              text: "#991b1b",
                                            },
                                            grey: {
                                              bg: "#f3f4f6",
                                              text: "#4b5563",
                                            },
                                            lightgrey: {
                                              bg: "#f3f4f6",
                                              text: "#9ca3af",
                                            },
                                            yellow: {
                                              bg: "#fef9c3",
                                              text: "#854d0e",
                                            },
                                          };
                                          const { bg, text } =
                                            statusColors[row._simStatus] ||
                                            statusColors.grey;
                                          return (
                                            <span
                                              style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                width: 24,
                                                height: 24,
                                                borderRadius: "50%",
                                                background: bg,
                                                color: text,
                                                fontSize: 11,
                                                fontWeight: 700,
                                              }}
                                            >
                                              {row._simPrio}
                                            </span>
                                          );
                                        })()}
                                      </td>

                                      {/* FPR */}
                                      <td
                                        style={{
                                          width: 80,
                                          padding: "10px 6px",
                                          textAlign: "left",
                                          color: "#2e343a",
                                          whiteSpace: "nowrap",
                                        }}
                                      >
                                        {row.fpr || "-"}
                                      </td>

                                      {/* Planned Order */}
                                      <td
                                        style={{
                                          width: 120,
                                          padding: "10px 6px",
                                          textAlign: "left",
                                        }}
                                      >
                                        <div
                                          style={{
                                            color: "#2e343a",
                                            whiteSpace: "nowrap",
                                          }}
                                        >
                                          {row.fg || "—"}
                                        </div>
                                        <div
                                          style={{
                                            color: "#6b7280",
                                            whiteSpace: "nowrap",
                                          }}
                                        >
                                          {row.sfg || "—"}
                                        </div>
                                        {isPlanned && (
                                          <div style={{ fontSize: 10, color: "#2563eb", fontWeight: 500, marginTop: 2, display: "flex", alignItems: "center", gap: 3 }}>
                                            🔒 Planned — locked
                                          </div>
                                        )}
                                      </td>

                                      {/* Material Code */}
                                      <td
                                        style={{
                                          width: 140,
                                          padding: "10px 6px",
                                          textAlign: "left",
                                          maxWidth: 140,
                                          overflow: "hidden",
                                        }}
                                      >
                                        <span
                                          title={row.material_code || ""}
                                          style={{
                                            display: "block",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                            color: "#2e343a",
                                          }}
                                        >
                                          {row.material_code || "-"}
                                        </span>
                                      </td>

                                      {/* Item Description */}
                                      <td
                                        style={{
                                          width: 280,
                                          padding: "10px 6px",
                                          textAlign: "left",
                                        }}
                                      >
                                        <div
                                          style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 4,
                                            marginBottom: 1,
                                          }}
                                        >
                                          {isLeadRow && (
                                            <span
                                              style={{
                                                fontSize: 10,
                                                fontWeight: 700,
                                                background: "#dbeafe",
                                                color: "#1d4ed8",
                                                borderRadius: 4,
                                                padding: "1px 4px",
                                                whiteSpace: "nowrap",
                                                flexShrink: 0,
                                              }}
                                            >
                                              Lead
                                            </span>
                                          )}
                                          {isChildRow && (
                                            <span
                                              style={{
                                                fontSize: 10,
                                                fontWeight: 700,
                                                background: "#dbeafe",
                                                color: "#1d4ed8",
                                                borderRadius: 4,
                                                padding: "1px 4px",
                                                whiteSpace: "nowrap",
                                                flexShrink: 0,
                                              }}
                                            >
                                              Child
                                            </span>
                                          )}
                                          <span
                                            title={row.item_description || ""}
                                            style={{
                                              display: "-webkit-box",
                                              WebkitLineClamp: 2,
                                              WebkitBoxOrient: "vertical",
                                              overflow: "hidden",
                                              color: "#2e343a",
                                              lineHeight: 1.4,
                                            }}
                                          >
                                            {row.item_description || "-"}
                                          </span>
                                        </div>
                                        {row.category && (
                                          <div
                                            style={{
                                              fontSize: 10,
                                              color: "#6b7280",
                                              whiteSpace: "nowrap",
                                              overflow: "hidden",
                                              textOverflow: "ellipsis",
                                            }}
                                          >
                                            {row.category}
                                          </div>
                                        )}
                                      </td>

                                      {/* Form */}
                                      <td
                                        style={{
                                          width: 70,
                                          padding: "10px 6px",
                                          textAlign: "center",
                                          color: "#2e343a",
                                          whiteSpace: "nowrap",
                                        }}
                                      >
                                        {row.form || "-"}
                                      </td>

                                      {/* Volume */}
                                      <td
                                        style={{
                                          width: 80,
                                          padding: "10px 6px",
                                          textAlign: "center",
                                          whiteSpace: "nowrap",
                                        }}
                                      >
                                        <span style={{ fontWeight: 700, color: "#2e343a" }}>
                                          {fmtVolume(vol)}
                                        </span>
                                        <span style={{ color: "#6b7280", marginLeft: 2 }}>MT</span>
                                      </td>

                                      {/* Batch Size */}
                                      <td
                                        style={{
                                          width: 80,
                                          padding: "10px 6px",
                                          textAlign: "center",
                                          color: "#2e343a",
                                          whiteSpace: "nowrap",
                                        }}
                                      >
                                        {row.batch_size
                                          ? parseFloat(row.batch_size).toFixed(
                                              2,
                                            )
                                          : "-"}
                                      </td>

                                      {/* Batches */}
                                      <td
                                        style={{
                                          width: 70,
                                          padding: "10px 6px",
                                          textAlign: "center",
                                          color: "#2e343a",
                                          whiteSpace: "nowrap",
                                        }}
                                      >
                                        {numBatches(row)}
                                      </td>

                                      {/* Production Time */}
                                      <td
                                        style={{
                                          width: 130,
                                          padding: "10px 6px",
                                          textAlign: "left",
                                        }}
                                      >
                                        <div style={{ fontSize: 12, fontWeight: 600, color: "#1a1a1a" }}>
                                          {formatProductionHours(row.production_hours)} hours
                                        </div>
                                        <div style={{ fontSize: 10, fontWeight: 400, color: "#9ca3af", marginTop: 2 }}>
                                          CO: {formatChangeover(row._effectiveChangeover ?? 0.17)}
                                        </div>
                                      </td>

                                      {/* Start Date */}
                                      <td
                                        style={{
                                          width: 140,
                                          padding: "6px",
                                          textAlign: "center",
                                          cursor: editingCell?.id === row.id && editingCell?.field === "startDate" ? "default" : "pointer",
                                        }}
                                        onClick={() => {
                                          if (editingCell?.id === row.id && editingCell?.field === "startDate") return;
                                          setEditDateVal(row._simStartDate || "");
                                          setEditingCell({ id: row.id, field: "startDate" });
                                        }}
                                        data-testid={`text-sim-start-${row.id}`}
                                      >
                                        {editingCell?.id === row.id && editingCell?.field === "startDate" ? (
                                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                                            <input
                                              type="date"
                                              style={{
                                                fontSize: 12,
                                                border: "1px solid #fd5108",
                                                borderRadius: 4,
                                                padding: "2px 4px",
                                                width: 118,
                                                outline: "none",
                                              }}
                                              value={editDateVal}
                                              autoFocus
                                              onChange={(e) => setEditDateVal(e.target.value)}
                                              onKeyDown={(e) => {
                                                if (e.key === "Enter") handleSaveEdit(row.id, "startDate", editDateVal || null);
                                                if (e.key === "Escape") setEditingCell(null);
                                              }}
                                            />
                                            <div style={{ display: "flex", gap: 3 }}>
                                              <button
                                                onMouseDown={(e) => e.preventDefault()}
                                                onClick={() => handleSaveEdit(row.id, "startDate", editDateVal || null)}
                                                style={{ padding: "2px 7px", borderRadius: 4, border: "none", background: "#fd5108", color: "white", fontSize: 10, cursor: "pointer", fontWeight: 600 }}
                                              >Save</button>
                                              <button
                                                onMouseDown={(e) => e.preventDefault()}
                                                onClick={() => handleSaveEdit(row.id, "startDate", null)}
                                                style={{ padding: "2px 7px", borderRadius: 4, border: "1px solid #d1d5db", background: "white", color: "#374151", fontSize: 10, cursor: "pointer" }}
                                              >Clear</button>
                                              <button
                                                onMouseDown={(e) => e.preventDefault()}
                                                onClick={() => setEditingCell(null)}
                                                style={{ padding: "2px 7px", borderRadius: 4, border: "1px solid #d1d5db", background: "white", color: "#6b7280", fontSize: 10, cursor: "pointer" }}
                                              >Cancel</button>
                                            </div>
                                          </div>
                                        ) : row._simStartDate ? (
                                          <span style={{ color: "#2e343a", whiteSpace: "nowrap" }}>
                                            {fmtDateShort(row._simStartDate)}
                                          </span>
                                        ) : (
                                          <span style={{ color: "#d1d5db", fontStyle: "italic", fontSize: 10, whiteSpace: "nowrap" }}>
                                            Set start date
                                          </span>
                                        )}
                                      </td>

                                      {/* Start Time */}
                                      <td
                                        style={{
                                          width: 140,
                                          padding: "6px",
                                          textAlign: "center",
                                          cursor: editingCell?.id === row.id && editingCell?.field === "startTime" ? "default" : "pointer",
                                        }}
                                        onClick={() => {
                                          if (editingCell?.id === row.id && editingCell?.field === "startTime") return;
                                          const parsed = parse12FromTime24(row._simStartTime);
                                          setEditTimeH(parsed.h);
                                          setEditTimeM(parsed.m);
                                          setEditTimeAP(parsed.ap);
                                          setEditingCell({ id: row.id, field: "startTime" });
                                        }}
                                      >
                                        {editingCell?.id === row.id && editingCell?.field === "startTime" ? (
                                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                                            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                                              <input
                                                type="text"
                                                maxLength={2}
                                                value={editTimeH}
                                                autoFocus
                                                onChange={(e) => setEditTimeH(e.target.value.replace(/\D/g, ""))}
                                                style={{ width: 28, fontSize: 12, border: "1px solid #fd5108", borderRadius: 4, padding: "2px 3px", textAlign: "center", outline: "none" }}
                                              />
                                              <span style={{ fontWeight: 700, fontSize: 12 }}>:</span>
                                              <input
                                                type="text"
                                                maxLength={2}
                                                value={editTimeM}
                                                onChange={(e) => setEditTimeM(e.target.value.replace(/\D/g, ""))}
                                                style={{ width: 28, fontSize: 12, border: "1px solid #fd5108", borderRadius: 4, padding: "2px 3px", textAlign: "center", outline: "none" }}
                                              />
                                              <button
                                                onMouseDown={(e) => e.preventDefault()}
                                                onClick={() => setEditTimeAP((ap) => ap === "AM" ? "PM" : "AM")}
                                                style={{ padding: "2px 5px", borderRadius: 4, border: "1px solid #fd5108", background: "#fff7f5", color: "#fd5108", fontSize: 10, cursor: "pointer", fontWeight: 700 }}
                                              >{editTimeAP}</button>
                                            </div>
                                            <div style={{ display: "flex", gap: 3 }}>
                                              <button
                                                onMouseDown={(e) => e.preventDefault()}
                                                onClick={() => handleSaveEdit(row.id, "startTime", to24h(editTimeH, editTimeM, editTimeAP))}
                                                style={{ padding: "2px 7px", borderRadius: 4, border: "none", background: "#fd5108", color: "white", fontSize: 10, cursor: "pointer", fontWeight: 600 }}
                                              >Save</button>
                                              <button
                                                onMouseDown={(e) => e.preventDefault()}
                                                onClick={() => handleSaveEdit(row.id, "startTime", null)}
                                                style={{ padding: "2px 7px", borderRadius: 4, border: "1px solid #d1d5db", background: "white", color: "#374151", fontSize: 10, cursor: "pointer" }}
                                              >Clear</button>
                                              <button
                                                onMouseDown={(e) => e.preventDefault()}
                                                onClick={() => setEditingCell(null)}
                                                style={{ padding: "2px 7px", borderRadius: 4, border: "1px solid #d1d5db", background: "white", color: "#6b7280", fontSize: 10, cursor: "pointer" }}
                                              >Cancel</button>
                                            </div>
                                          </div>
                                        ) : row._simStartTime ? (
                                          <span style={{ color: "#2e343a", whiteSpace: "nowrap" }}>
                                            {formatTime12(row._simStartTime)}
                                          </span>
                                        ) : (
                                          <span style={{ color: "#d1d5db", fontStyle: "italic", fontSize: 10, whiteSpace: "nowrap" }}>
                                            Set time
                                          </span>
                                        )}
                                      </td>

                                      {/* Avail Date */}
                                      <td
                                        style={{
                                          width: 140,
                                          padding: editAvailDateId === row.id ? "6px" : "10px 6px",
                                          textAlign: "left",
                                          cursor: isAvailDateValid(row.target_avail_date) && row._category === "A" && editAvailDateId !== row.id ? "pointer" : "default",
                                        }}
                                        onClick={() => {
                                          if (isAvailDateValid(row.target_avail_date) && row._category === "A" && editAvailDateId !== row.id) {
                                            setEditAvailDateVal(row._previewAvailDate || row.target_avail_date || "");
                                            setEditAvailDateId(row.id);
                                          }
                                        }}
                                      >
                                        {editAvailDateId === row.id ? (
                                          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
                                            <input
                                              type="date"
                                              autoFocus
                                              min={todayIso()}
                                              value={editAvailDateVal}
                                              onChange={(e) => setEditAvailDateVal(e.target.value)}
                                              onKeyDown={(e) => {
                                                if (e.key === "Enter") handleSaveAvailDate(row.id, editAvailDateVal || null);
                                                if (e.key === "Escape") setEditAvailDateId(null);
                                              }}
                                              style={{ fontSize: 11, border: "1px solid #fd5108", borderRadius: 4, padding: "2px 4px", width: 118, outline: "none" }}
                                            />
                                            <div style={{ display: "flex", gap: 3 }}>
                                              <button onMouseDown={(e) => e.preventDefault()} onClick={() => handleSaveAvailDate(row.id, editAvailDateVal || null)}
                                                style={{ padding: "2px 7px", borderRadius: 4, border: "none", background: "#fd5108", color: "white", fontSize: 10, cursor: "pointer", fontWeight: 600 }}>Save</button>
                                              <button onMouseDown={(e) => e.preventDefault()} onClick={() => handleSaveAvailDate(row.id, null)}
                                                style={{ padding: "2px 7px", borderRadius: 4, border: "1px solid #d1d5db", background: "white", color: "#374151", fontSize: 10, cursor: "pointer" }}>Clear</button>
                                              <button onMouseDown={(e) => e.preventDefault()} onClick={() => setEditAvailDateId(null)}
                                                style={{ padding: "2px 7px", borderRadius: 4, border: "1px solid #d1d5db", background: "white", color: "#6b7280", fontSize: 10, cursor: "pointer" }}>Cancel</button>
                                            </div>
                                          </div>
                                        ) : (<>
                                        <div
                                          style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 4,
                                          }}
                                        >
                                          <span
                                            style={{
                                              color: isStockSufficient
                                                ? "#43a047"
                                                : row._category === "B" &&
                                                    _infStatus
                                                  ? _infStatus === "Critical"
                                                    ? "#dc2626"
                                                    : _infStatus === "Urgent"
                                                      ? "#ea580c"
                                                      : _infStatus === "Monitor"
                                                        ? "#ca8a04"
                                                        : "#1d4ed8"
                                                  : isNonDate
                                                    ? "#fd5108"
                                                    : "#2e343a",
                                              fontWeight:
                                                isStockSufficient ||
                                                row._category === "B"
                                                  ? 500
                                                  : 400,
                                            }}
                                          >
                                            {row._category === "D" &&
                                            row._inferredTargetDate
                                              ? fmtDateShort(
                                                  row._inferredTargetDate,
                                                )
                                              : isStockSufficient
                                                ? "Stock sufficient"
                                                : row._category === "B" &&
                                                    row._inferredTargetDate
                                                  ? fmtDateShort(
                                                      row._inferredTargetDate,
                                                    )
                                                  : row._previewAvailDate
                                                    ? isNonDate
                                                      ? row._previewAvailDate
                                                      : fmtDateShort(
                                                          row._previewAvailDate,
                                                        )
                                                    : "-"}
                                          </span>
                                          {(row._category === "B" ||
                                            row._category === "D") &&
                                            row._inferredData && (
                                              <div
                                                style={{
                                                  position: "relative",
                                                  display: "inline-block",
                                                }}
                                              >
                                                <button
                                                  style={{
                                                    color: "#3b82f6",
                                                    fontSize: 11,
                                                    lineHeight: 1,
                                                    background: "none",
                                                    border: "none",
                                                    padding: 0,
                                                    cursor: "pointer",
                                                  }}
                                                  onMouseEnter={(e) => {
                                                    clearTimeout(
                                                      stockTooltipTimerRef.current,
                                                    );
                                                    const btn = e.currentTarget;
                                                    const inf =
                                                      row._inferredData;
                                                    const dfl =
                                                      inf?.dueForLoading != null
                                                        ? Number(
                                                            inf.dueForLoading,
                                                          )
                                                        : 0;
                                                    const inv =
                                                      inf?.inventory != null
                                                        ? Number(inf.inventory)
                                                        : 0;
                                                    const status =
                                                      computeAutoSeqStatus(
                                                        inf,
                                                        row._category,
                                                      );
                                                    const ratio =
                                                      inv > 0
                                                        ? (dfl / inv).toFixed(2)
                                                        : "∞";
                                                    const buffer =
                                                      inv > 0
                                                        ? (
                                                            ((inv - dfl) /
                                                              inv) *
                                                            100
                                                          ).toFixed(1)
                                                        : "-100.0";
                                                    const availDate =
                                                      fmtShortDate(
                                                        inf?.targetDate,
                                                      );
                                                    const completionDate =
                                                      inf?.targetDate
                                                        ? fmtShortDate(
                                                            new Date(
                                                              new Date(
                                                                inf.targetDate,
                                                              ).getTime() -
                                                                86400000,
                                                            ),
                                                          )
                                                        : null;
                                                    const td = {
                                                      name:
                                                        row.item_description ||
                                                        "—",
                                                      materialCode:
                                                        row.material_code || "",
                                                      dfl,
                                                      inv,
                                                      ratio,
                                                      buffer,
                                                      status,
                                                      completionDate,
                                                      availDate,
                                                      balToProd: null,
                                                    };
                                                    stockTooltipTimerRef.current =
                                                      setTimeout(() => {
                                                        if (btn) {
                                                          const bRect =
                                                            btn.getBoundingClientRect();
                                                          const trEl =
                                                            btn.closest("tr");
                                                          const trRect = trEl
                                                            ? trEl.getBoundingClientRect()
                                                            : bRect;
                                                          const TW = 480,
                                                            TH = 200,
                                                            pad = 16;
                                                          const vw =
                                                              window.innerWidth,
                                                            vh =
                                                              window.innerHeight;
                                                          // x: center on button, clamped
                                                          let x =
                                                            bRect.left +
                                                            bRect.width / 2 -
                                                            TW / 2;
                                                          if (x < pad) x = pad;
                                                          if (x + TW + pad > vw)
                                                            x = vw - TW - pad;
                                                          // y: above/below the full row — so the icon is never covered
                                                          let y =
                                                            trRect.top - TH - 8;
                                                          if (y < pad)
                                                            y =
                                                              trRect.bottom + 8;
                                                          if (y + TH + pad > vh)
                                                            y = vh - TH - pad;
                                                          setStockTooltipPos({
                                                            x,
                                                            y,
                                                          });
                                                        }
                                                        setStockTooltipData(td);
                                                      }, 300);
                                                  }}
                                                  onMouseLeave={() => {
                                                    clearTimeout(
                                                      stockTooltipTimerRef.current,
                                                    );
                                                    setStockTooltipData(null);
                                                  }}
                                                  data-testid={`button-stock-info-${row.id}`}
                                                >
                                                  📊
                                                </button>
                                              </div>
                                            )}
                                        </div>
                                        {row._category === "D" &&
                                          row._inferredTargetDate && (
                                            <div
                                              style={{
                                                fontSize: 10,
                                                color: "#43a047",
                                                marginTop: 2,
                                                fontWeight: 400,
                                              }}
                                            >
                                              Sufficient ✓
                                            </div>
                                          )}
                                        </>)}
                                      </td>

                                      {/* Completion Date */}
                                      <td
                                        style={{
                                          width: 175,
                                          padding: editCompletionId === row.id ? "6px" : "10px 6px",
                                          textAlign: "left",
                                          background: row._hasCompletionOverride ? "#fff7ed" : "transparent",
                                          cursor: editCompletionId !== row.id ? "pointer" : "default",
                                        }}
                                        onClick={() => {
                                          if (editCompletionId === row.id) return;
                                          // Pre-fill with current completion if available
                                          if (row._simCompletion) {
                                            const cd = row._simCompletion;
                                            setEditCompletionDate(fmtDateIso(cd));
                                            const parsed = parse12FromTime24(fmtTime24(cd));
                                            setEditCompletionTimeH(parsed.h);
                                            setEditCompletionTimeM(parsed.m);
                                            setEditCompletionTimeAP(parsed.ap);
                                          } else {
                                            setEditCompletionDate("");
                                            setEditCompletionTimeH("12");
                                            setEditCompletionTimeM("00");
                                            setEditCompletionTimeAP("AM");
                                          }
                                          setEditCompletionId(row.id);
                                        }}
                                        data-testid={`text-sim-completion-${row.id}`}
                                      >
                                        {editCompletionId === row.id ? (
                                          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
                                            <input
                                              type="date"
                                              autoFocus
                                              value={editCompletionDate}
                                              onChange={(e) => setEditCompletionDate(e.target.value)}
                                              style={{ fontSize: 11, border: "1px solid #fd5108", borderRadius: 4, padding: "2px 4px", width: 118, outline: "none" }}
                                            />
                                            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                                              <input
                                                type="text"
                                                maxLength={2}
                                                value={editCompletionTimeH}
                                                onChange={(e) => setEditCompletionTimeH(e.target.value.replace(/\D/g, ""))}
                                                style={{ width: 26, fontSize: 11, border: "1px solid #fd5108", borderRadius: 4, padding: "2px 3px", textAlign: "center", outline: "none" }}
                                              />
                                              <span style={{ fontWeight: 700, fontSize: 11 }}>:</span>
                                              <input
                                                type="text"
                                                maxLength={2}
                                                value={editCompletionTimeM}
                                                onChange={(e) => setEditCompletionTimeM(e.target.value.replace(/\D/g, ""))}
                                                style={{ width: 26, fontSize: 11, border: "1px solid #fd5108", borderRadius: 4, padding: "2px 3px", textAlign: "center", outline: "none" }}
                                              />
                                              <button
                                                onMouseDown={(e) => e.preventDefault()}
                                                onClick={() => setEditCompletionTimeAP((ap) => ap === "AM" ? "PM" : "AM")}
                                                style={{ padding: "1px 4px", borderRadius: 4, border: "1px solid #fd5108", background: "#fff7f5", color: "#fd5108", fontSize: 10, cursor: "pointer", fontWeight: 700 }}
                                              >{editCompletionTimeAP}</button>
                                            </div>
                                            <div style={{ display: "flex", gap: 3 }}>
                                              <button
                                                onMouseDown={(e) => e.preventDefault()}
                                                onClick={() => handleRequestCompletionOverride(row.id)}
                                                style={{ padding: "2px 7px", borderRadius: 4, border: "none", background: "#fd5108", color: "white", fontSize: 10, cursor: "pointer", fontWeight: 600 }}
                                              >Set Override</button>
                                              <button
                                                onMouseDown={(e) => e.preventDefault()}
                                                onClick={() => setEditCompletionId(null)}
                                                style={{ padding: "2px 7px", borderRadius: 4, border: "1px solid #d1d5db", background: "white", color: "#6b7280", fontSize: 10, cursor: "pointer" }}
                                              >Cancel</button>
                                            </div>
                                          </div>
                                        ) : row._hasCompletionOverride ? (
                                          <div>
                                            <div style={{ fontWeight: 500, color: "#ea580c", whiteSpace: "nowrap", fontSize: 12 }}>
                                              {row._simCompletionStr}
                                            </div>
                                            <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
                                              <span style={{ fontSize: 10, color: "#ea580c", fontWeight: 500 }}>Overridden ✏</span>
                                              <button
                                                onMouseDown={(e) => e.preventDefault()}
                                                onClick={(e) => { e.stopPropagation(); handleRemoveCompletionOverride(row.id); }}
                                                title="Remove override — return to auto-calculated"
                                                style={{ background: "none", border: "none", color: "#dc2626", fontSize: 10, cursor: "pointer", padding: "0 2px", lineHeight: 1 }}
                                              >✕ Remove</button>
                                            </div>
                                          </div>
                                        ) : row._simCompletionStr ? (
                                          <span style={{
                                            whiteSpace: "nowrap",
                                            fontWeight: 500,
                                            color: row._simStatus === "red" ? "#dc2626" : row._simStatus === "amber" ? "#d97706" : "#2e343a",
                                            fontSize: 12,
                                          }}>
                                            {row._simCompletionStr}
                                          </span>
                                        ) : (
                                          <span style={{ color: "#d1d5db", fontStyle: "italic", fontSize: 10, fontWeight: 400, whiteSpace: "nowrap" }}>
                                            Set completion
                                          </span>
                                        )}
                                      </td>

                                      {/* Sequence Insight */}
                                      <td
                                        style={{
                                          minWidth: 280,
                                          width: 300,
                                          verticalAlign: "top",
                                          padding: "10px 12px",
                                          background: isPlanned ? "#eff6ff" : undefined,
                                        }}
                                      >
                                        {isGeneratingRowInsights && !sequenceInsights[row._simPrio] && (
                                          <div style={{ fontSize: 11, color: "#9ca3af", fontStyle: "italic", display: "flex", alignItems: "center", gap: 4 }}>
                                            <span style={{ display: "inline-block", animation: "spin 1s linear infinite", fontSize: 10 }}>✨</span>
                                            Generating...
                                          </div>
                                        )}
                                        {isGeneratingRowInsights && sequenceInsights[row._simPrio] && (
                                          <div style={{ fontSize: 11, color: "#374151", lineHeight: 1.6, whiteSpace: "normal", wordWrap: "break-word", opacity: 0.5 }}>
                                            {sequenceInsights[row._simPrio]}
                                          </div>
                                        )}
                                        {!isGeneratingRowInsights && sequenceInsights[row._simPrio] && (
                                          <div style={{ fontSize: 11, color: "#374151", lineHeight: 1.6, whiteSpace: "normal", wordWrap: "break-word" }}>
                                            {sequenceInsights[row._simPrio]}
                                          </div>
                                        )}
                                        {!isGeneratingRowInsights && !sequenceInsights[row._simPrio] && (
                                          <span style={{ fontSize: 11, color: "#d1d5db" }}>—</span>
                                        )}
                                      </td>
                                    </tr>
                                  )}
                                </Draggable>
                              );
                            })}
                            {droppableProvided.placeholder}
                          </tbody>
                        )}
                      </Droppable>
                    </table>
                  </DragDropContext>
                </div>
              </div>

              <div className="flex items-center justify-between px-6 py-3 border-t border-gray-200 bg-white shrink-0">
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleReanalyze}
                    disabled={isReanalyzing}
                    className={isReanalyzing ? "action-btn-loading" : ""}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 12,
                      color: isReanalyzing ? "white" : "#fd5108",
                      border: "1px solid #fd5108",
                      borderRadius: 6,
                      padding: "6px 12px",
                      background: isReanalyzing ? "#fd5108" : "white",
                      cursor: isReanalyzing ? "not-allowed" : "pointer",
                      fontWeight: 500,
                      opacity: isReanalyzing ? 0.85 : 1,
                    }}
                    onMouseEnter={(e) => {
                      if (!isReanalyzing) { e.currentTarget.style.background = "#fd5108"; e.currentTarget.style.color = "white"; }
                    }}
                    onMouseLeave={(e) => {
                      if (!isReanalyzing) { e.currentTarget.style.background = "white"; e.currentTarget.style.color = "#fd5108"; }
                    }}
                    data-testid="button-reanalyze-sequence"
                  >
                    {isReanalyzing ? <Spinner size={13} color="white" /> : <RefreshCw style={{ width: 13, height: 13 }} />}
                    {isReanalyzing ? "Re-analyzing…" : "Re-analyze"}
                  </button>
                  <button
                    onClick={handleReset}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 12,
                      color: "#6b7280",
                      border: "1px solid #d1d5db",
                      borderRadius: 6,
                      padding: "6px 12px",
                      background: "white",
                      cursor: "pointer",
                      fontWeight: 500,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = "#9ca3af";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "#d1d5db";
                    }}
                    data-testid="button-reset-sequence"
                  >
                    <RotateCcw style={{ width: 13, height: 13 }} />
                    Reset to Original
                  </button>
                  {reanalyzeNote && (
                    <span className="text-xs text-[#43a047] font-medium">
                      {reanalyzeNote}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={onClose}
                    style={{
                      fontSize: 12,
                      color: "#6b7280",
                      border: "1px solid #d1d5db",
                      borderRadius: 6,
                      padding: "6px 12px",
                      background: "white",
                      cursor: "pointer",
                      fontWeight: 500,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = "#9ca3af";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "#d1d5db";
                    }}
                    data-testid="button-cancel-autosequence"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleApplyClick}
                    disabled={simRows.length === 0}
                    style={{
                      fontSize: 12,
                      color: "white",
                      background: simRows.length === 0 ? "#fca48a" : "#fd5108",
                      border: "none",
                      borderRadius: 6,
                      padding: "6px 14px",
                      cursor: simRows.length === 0 ? "not-allowed" : "pointer",
                      fontWeight: 600,
                    }}
                    onMouseEnter={(e) => {
                      if (simRows.length > 0)
                        e.currentTarget.style.background = "#c44107";
                    }}
                    onMouseLeave={(e) => {
                      if (simRows.length > 0)
                        e.currentTarget.style.background = "#fd5108";
                    }}
                    data-testid="button-apply-sequence"
                  >
                    Apply to Schedule
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Drag warning dialog — shown when any Planned order's position would change */}
      {dragWarnDialog && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60000,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "inherit",
          }}
          onClick={() => setDragWarnDialog(null)}
        >
          <div
            style={{
              background: "white",
              borderRadius: 10,
              padding: "26px 28px",
              maxWidth: 460,
              width: "90%",
              boxShadow: "0 8px 40px rgba(0,0,0,0.22)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 10 }}>
              ⚠ Planned Order Will Be Affected
            </div>
            <p style={{ fontSize: 13, color: "#374151", lineHeight: 1.6, marginBottom: 10, margin: "0 0 10px" }}>
              This action will change the position of the following planned order{dragWarnDialog.affectedPlannedOrders?.length > 1 ? "s" : ""}:
            </p>
            <div style={{
              margin: "0 0 14px",
              padding: "10px 14px",
              background: "#eff6ff",
              borderRadius: 6,
              borderLeft: "3px solid #2563eb",
            }}>
              {(dragWarnDialog.affectedPlannedOrders || []).map((affected, idx) => (
                <div key={idx} style={{
                  fontSize: 12,
                  color: "#1e40af",
                  padding: "4px 0",
                  lineHeight: 1.6,
                  borderTop: idx > 0 ? "1px solid #bfdbfe" : "none",
                }}>
                  <strong>{affected.name}</strong>
                  <br />
                  Priority {affected.fromPrio} → Priority {affected.toPrio}{" "}
                  <span style={{ color: "#60a5fa" }}>
                    ({affected.direction === "down" ? "pushed down" : "pushed up"})
                  </span>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.6, margin: "0 0 18px" }}>
              Consider adjusting the planned order first, or proceed if this change is intentional.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setDragWarnDialog(null)}
                style={{
                  padding: "8px 18px", borderRadius: 6, border: "1px solid #d1d5db",
                  background: "white", color: "#374151", fontSize: 13, cursor: "pointer", fontWeight: 500,
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const { fromIndex, toIndex } = dragWarnDialog;
                  setDragWarnDialog(null);
                  executePreviewDrag(fromIndex, toIndex);
                }}
                style={{
                  padding: "8px 18px", borderRadius: 6, border: "none",
                  background: "#fd5108", color: "white", fontSize: 13, cursor: "pointer", fontWeight: 600,
                }}
              >
                Proceed Anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Completion override confirmation dialog */}
      {completionOverrideDialog && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 60000,
            background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "inherit",
          }}
          onClick={() => setCompletionOverrideDialog(null)}
        >
          <div
            style={{
              background: "white", borderRadius: 10, padding: "26px 28px",
              maxWidth: 480, width: "90%",
              boxShadow: "0 8px 40px rgba(0,0,0,0.22)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 12 }}>
              Override Completion Date
            </div>
            <p style={{ fontSize: 12, color: "#374151", lineHeight: 1.6, marginBottom: 8 }}>
              You are about to override the calculated Completion Date. Please be aware:
            </p>
            <ul style={{ fontSize: 12, color: "#374151", lineHeight: 1.7, paddingLeft: 20, marginBottom: 20, listStyleType: "disc" }}>
              <li style={{ marginBottom: 6 }}>
                The Completion Date will no longer auto-calculate based on Start Date, Production Hours, and Changeover Time.
              </li>
              <li style={{ marginBottom: 6 }}>
                All downstream orders in this line will have their Completion Date recalculated based on your new date.
              </li>
              <li>
                If you later edit Start Date, Start Time, or Volume, the Completion Date will <strong>NOT</strong> auto-recalculate — it will retain your overridden value until you remove the override.
              </li>
            </ul>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setCompletionOverrideDialog(null)}
                style={{ padding: "8px 20px", borderRadius: 6, border: "1px solid #d1d5db", background: "white", color: "#374151", fontSize: 13, cursor: "pointer", fontWeight: 500 }}
              >Cancel</button>
              <button
                onClick={handleConfirmCompletionOverride}
                style={{ padding: "8px 20px", borderRadius: 6, border: "none", background: "#fd5108", color: "white", fontSize: 13, cursor: "pointer", fontWeight: 600 }}
              >Proceed</button>
            </div>
          </div>
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="max-w-[480px]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[18px] font-bold">
              Apply this sequence?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[14px] leading-relaxed">
              Apply this sequence to your current schedule? This will reorder
              all {simRows.length} orders in {lineName} and recalculate all
              scheduling dates.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className="text-[14px] font-semibold h-10 px-5"
              data-testid="button-confirm-goback"
            >
              Go Back
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-[#fd5108] hover:bg-[#c44107] text-white text-[14px] font-semibold h-10 px-5"
              onClick={(e) => { e.preventDefault(); handleConfirmApply(); }}
              disabled={isApplying}
              style={{ display:"inline-flex", alignItems:"center", gap:6, opacity: isApplying ? 0.85 : 1, cursor: isApplying ? "not-allowed" : "pointer" }}
              data-testid="button-confirm-apply"
            >
              {isApplying && <Spinner size={14} color="white" />}
              {isApplying ? "Applying…" : "Confirm Apply"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Stock info portal tooltip — portal-rendered via ProductTooltipPanel */}
      {stockTooltipData && (
        <ProductTooltipPanel
          data={stockTooltipData}
          position={stockTooltipPos}
        />
      )}
    </>
  );
}
