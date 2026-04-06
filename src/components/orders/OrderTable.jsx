import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  getInsight,
  getInsightParts,
  useInsightCacheUpdates,
  isInsightLoading as _isInsightLoading,
  isInsightError as _isInsightError,
  updateAIInsights,
  setInsightLoading,
  setInsightError,
} from "@/utils/insightCache";
import { generateProductAIInsights, generateVolumeImpactAnalysis } from "@/services/azureAI";
function _insightStatus() {
  return {
    isInsightLoading: _isInsightLoading(),
    isInsightError: _isInsightError(),
  };
}
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  History,
  GripVertical,
  Lock,
  Unlock,
  Calendar,
  Clock,
  Sparkles,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import RemarksCell from "./RemarksCell";
import {
  FilterIcon,
  FilterDropdown,
  ColumnContextMenu,
  GroupContextMenu,
  COLUMN_FILTER_CONFIG,
  applyColumnFilters,
} from "./OrderTableFilters";
import StatusDropdown, {
  StatusBadge,
  isLockedStatus,
  isCustomStatus,
  HARD_LOCKED_STATUSES,
} from "./StatusDropdown";
import OrderHistoryModal from "./OrderHistoryModal";
import OrderContextMenu from "./OrderContextMenu";
import CellCommentPopover from "./CellCommentPopover";
import {
  fmtVolume,
  fmtBatches,
  fmtBags,
  fmtBatchSize,
  fmtHours,
  fmtChangeover,
  fmtRunRate,
  formatTime12,
} from "../utils/formatters";

const haFormOptions = [
  "",
  "On Going",
  "Done",
  "Issued 3F",
  "Issued 2F",
  "Need to Elevate",
  "Sacks to Elevate",
];

const EDITABLE_START = ["plotted", "planned", "cut", "combined", "hold", "normal"];
const EDITABLE_HA_NOTES = [
  "plotted",
  "planned",
  "cut",
  "combined",
  "hold",
  "in_production",
  "ongoing_batching",
  "ongoing_pelleting",
  "ongoing_bagging",
  "normal",
];
const EDITABLE_VOLUME = ["plotted", "planned", "cut", "combined", "hold", "normal"];
const EDITABLE_COMPLETION = ["plotted", "planned", "cut", "combined", "hold", "normal"];

const editableInputClass =
  "border-0 border-b border-transparent group-hover:border-gray-300 focus:border-[#fd5108] bg-transparent shadow-none rounded-none px-0 h-7 text-[13px] md:text-[13px] focus-visible:ring-0 focus-visible:ring-offset-0 transition-colors";
const editableSelectTriggerClass =
  "border-0 border-b border-transparent hover:border-gray-300 focus:border-[#fd5108] bg-transparent shadow-none rounded-none h-7 text-[13px] md:text-[13px] focus:ring-0 transition-colors px-0";
const line2InputClass =
  "border-0 border-b border-transparent group-hover:border-gray-200 focus:border-[#fd5108] bg-transparent shadow-none rounded-none px-0 h-5 text-[10px] text-[#6b7280] focus-visible:ring-0 focus-visible:ring-offset-0 transition-colors placeholder:text-[#cbd1d6]";

function toTitleCase(str) {
  if (!str) return "";
  return str.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function getSuggestedVolume(order) {
  const orig = parseFloat(order.total_volume_mt) || 0;
  const bs = parseFloat(order.batch_size) || 4;
  if (bs <= 0) return orig;
  return Math.ceil(orig / bs) * bs;
}

function getEffectiveVolume(order) {
  if (order.volume_override != null && order.volume_override !== "") {
    return parseFloat(order.volume_override);
  }
  return getSuggestedVolume(order);
}

function isValid10Digit(value) {
  if (!value) return false;
  return /^\d{10}$/.test(String(value).trim());
}

function getReadinessTier(order) {
  const sugVol = getEffectiveVolume(order);
  const batchSize = parseFloat(order.batch_size) || 0;
  const numBatches = batchSize > 0 ? Math.ceil(sugVol / batchSize) : 0;

  const criticalOK = !!(
    order.fpr &&
    order.item_description &&
    order.material_code &&
    sugVol > 0 &&
    batchSize > 0 &&
    order.production_hours > 0 &&
    order.changeover_time !== null &&
    order.changeover_time !== undefined &&
    order.changeover_time !== "" &&
    order.run_rate > 0 &&
    order.target_completion_date
  );

  if (!criticalOK) return 1;

  const prodOrderOK = !!(
    isValid10Digit(order.fg1) &&
    isValid10Digit(order.sfg1) &&
    (order.feedmill_line !== "Line 5" || isValid10Digit(order.sfgpmx))
  );
  const haOK = !!(
    prodOrderOK &&
    numBatches > 0 &&
    order.formula_version &&
    order.prod_version &&
    order.ha_prep_form_issuance === "Done"
  );

  return haOK ? 3 : 2;
}

function getMissingFields(order) {
  const sugVol = getEffectiveVolume(order);
  const batchSize = parseFloat(order.batch_size) || 0;
  const numBatches = batchSize > 0 ? Math.ceil(sugVol / batchSize) : 0;
  const missing = [];

  if (!order.fpr) missing.push("FPR is blank");
  if (!order.item_description) missing.push("Item Description is blank");
  if (!order.material_code) missing.push("Material Code is blank");
  if (!sugVol || sugVol <= 0) missing.push("Suggested Volume is 0 or blank");
  if (!batchSize || batchSize <= 0) missing.push("Batch Size is 0 or blank");
  if (!order.production_hours || order.production_hours <= 0)
    missing.push("Production Hours is blank");
  if (
    order.changeover_time === null ||
    order.changeover_time === undefined ||
    order.changeover_time === ""
  )
    missing.push("Changeover Time is blank");
  if (!order.run_rate || order.run_rate <= 0) missing.push("Run Rate is blank");
  if (!order.target_completion_date) missing.push("Completion Date is blank");

  return missing;
}

function getHAMissing(order) {
  const missing = [];

  if (!order.formula_version) missing.push("SCADA is blank");
  if (!order.prod_version) missing.push("PV is blank");
  if (order.ha_prep_form_issuance !== "Done")
    missing.push("HA Prep is not set to Done");
  if (!isValid10Digit(order.fg1)) {
    missing.push(
      order.fg1
        ? "Production Order FG1 — invalid format (must be 10 digits)"
        : "Production Order FG1 is blank",
    );
  }
  if (!isValid10Digit(order.sfg1)) {
    missing.push(
      order.sfg1
        ? "Production Order SFG1 — invalid format (must be 10 digits)"
        : "Production Order SFG1 is blank",
    );
  }
  if (order.feedmill_line === "Line 5" && !isValid10Digit(order.sfgpmx)) {
    missing.push(
      order.sfgpmx
        ? "Production Order SFGPMX — invalid format (must be 10 digits)"
        : "Production Order SFGPMX is blank",
    );
  }

  return missing;
}

function getReadinessWarningItems(order) {
  const sugVol = getEffectiveVolume(order);
  const batchSize = parseFloat(order.batch_size) || 0;
  const items = [];

  if (!isValid10Digit(order.fg1)) {
    items.push(
      order.fg1
        ? "Production Order FG1 — invalid format (must be 10 digits)"
        : "Production Order FG1 — not set",
    );
  }
  if (!isValid10Digit(order.sfg1)) {
    items.push(
      order.sfg1
        ? "Production Order SFG1 — invalid format (must be 10 digits)"
        : "Production Order SFG1 — not set",
    );
  }
  if (order.feedmill_line === "Line 5" && !isValid10Digit(order.sfgpmx)) {
    items.push(
      order.sfgpmx
        ? "Production Order SFGPMX — invalid format (must be 10 digits)"
        : "Production Order SFGPMX — not set",
    );
  }
  if (order.ha_prep_form_issuance !== "Done")
    items.push("HA Prep — not confirmed");
  if (!order.formula_version) items.push("SCADA — not set");
  if (!order.prod_version) items.push("PV — not set");
  if (!order.target_completion_date) items.push("Completion Date — not set");
  if (!order.material_code) items.push("Material Code (FG) — not set");
  if (!batchSize || batchSize <= 0) items.push("Batch Size — not set");

  return items;
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

function parseCompletionStr(str) {
  if (!str) return null;
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d+):(\d+)\s*(AM|PM)/i);
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

// --- Date-sequence validation helpers ---

const isValidAvailDate = (v) =>
  !!(v && !isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}/.test(v));

const fmtViolationDate = (d) =>
  new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

/**
 * Simulates moving allOrders[fromIndex] to toIndex and checks that all dated
 * active orders (excluding completed / cancel_po) remain in non-decreasing
 * chronological order. Returns { valid, earlier, later } where earlier/later
 * are the first pair that would be out of order.
 */
const validateDropPosition = (
  fromIndex,
  toIndex,
  allOrders,
  inferredTargetMap = {},
) => {
  const dragged = allOrders[fromIndex];
  if (!dragged) return { valid: true };

  const getDragDate = (o) => {
    if (isValidAvailDate(o.target_avail_date)) return o.target_avail_date;
    return null;
  };

  const draggedDate = getDragDate(dragged);
  if (!draggedDate) return { valid: true };

  const reordered = [...allOrders];
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, moved);

  const activeDated = reordered.filter(
    (o) =>
      !!getDragDate(o) && o.status !== "completed" && o.status !== "cancel_po",
  );

  for (let i = 0; i < activeDated.length - 1; i++) {
    const d1 = new Date(getDragDate(activeDated[i]));
    const d2 = new Date(getDragDate(activeDated[i + 1]));
    if (d1 > d2) {
      return {
        valid: false,
        earlier: activeDated[i + 1],
        later: activeDated[i],
        inferredTargetMap,
      };
    }
  }
  return { valid: true };
};

const FEEDMILL_SHUTDOWN_LINES = {
  FM1: ["Line 1", "Line 2"],
  FM2: ["Line 3", "Line 4"],
  FM3: ["Line 6", "Line 7"],
  PMX: ["Line 5"],
};

const LINE_RATE_KEYS = {
  "Line 1": "line_1_run_rate",
  "Line 2": "line_2_run_rate",
  "Line 3": "line_3_run_rate",
  "Line 4": "line_4_run_rate",
  "Line 5": "line_5_run_rate",
  "Line 6": "line_6_run_rate",
  "Line 7": "line_7_run_rate",
};

function hasAlternativeLines(order, shutdownLines, kbRecords) {
  const matCode = String(
    order.material_code_fg || order.material_code || "",
  ).trim();
  const product = (kbRecords || []).find((p) => {
    const kbCode = String(
      p.fg_material_code || p.material_code_fg || p["FG Material Code"] || "",
    ).trim();
    return (
      kbCode &&
      matCode &&
      (kbCode === matCode ||
        kbCode.replace(/^0+/, "") === matCode.replace(/^0+/, ""))
    );
  });
  if (!product) {
    console.log("[Divert] No KB match for:", matCode, order.item_description);
    return false;
  }
  const altLines = Object.entries(LINE_RATE_KEYS).filter(([line, key]) => {
    if (shutdownLines.includes(line)) return false;
    return parseFloat(product[key] || 0) > 0;
  });
  console.log(
    "[Divert]",
    order.item_description,
    "| mat:",
    matCode,
    "| KB found | alt lines:",
    altLines.map(([l]) => l).join(", ") || "NONE",
  );
  return altLines.length > 0;
}

export default function OrderTable({
  orders,
  allOrders = [],
  onUpdateOrder,
  onStatusChange,
  onCancelRequest,
  onRestoreRequest,
  onUncombineRequest,
  onCutRequest,
  onMergeBackRequest,
  onReorder,
  sortConfig,
  onSort,
  readOnly = false,
  activeFeedmill = "",
  emptyMessage = "No orders found",
  cancelledCount = 0,
  isCancelledHistory = false,
  suppressCombinedTint = false,
  inferredTargetMap = {},
  feedmillStatus = {},
  kbRecords = [],
  n10dRecords = [],
  onDivertOrder,
  onRevertOrder,
}) {
  const isPMX = activeFeedmill === "PMX";
  const [historyOrder, setHistoryOrder] = useState(null);
  const [dateViolationToast, setDateViolationToast] = useState(null);
  const [violationHovered, setViolationHovered] = useState(false);
  const [lockedStatusWarn, setLockedStatusWarn] = useState(null);
  const [plannedAffectedDialog, setPlannedAffectedDialog] = useState(null); // { from, to, dragged, planned }
  const [movingPlannedDialog, setMovingPlannedDialog] = useState(null); // { from, to, dragged }
  const [readinessWarnDialog, setReadinessWarnDialog] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [commentPopover, setCommentPopover] = useState(null);
  const [rowHighlights, setRowHighlights] = useState({});
  // Set of lead IDs whose children are currently visible (collapsed by default)
  const [expandedLeads, setExpandedLeads] = useState(new Set());
  const [commentPresence, setCommentPresence] = useState(new Set());

  // Debounce timers for inline text inputs — keyed by "orderId-field"
  const debounceTimers = React.useRef({});
  const debouncedUpdate = (orderId, field, value, delay = 500) => {
    const key = `${orderId}-${field}`;
    clearTimeout(debounceTimers.current[key]);
    debounceTimers.current[key] = setTimeout(() => {
      onUpdateOrder && onUpdateOrder(orderId, { [field]: value });
    }, delay);
  };
  React.useEffect(() => {
    const timers = debounceTimers.current;
    return () => {
      Object.values(timers).forEach(clearTimeout);
    };
  }, []);

  const HIGHLIGHT_BORDER = {
    violet: "#7c3aed",
    green: "#16a34a",
    orange: "#ea580c",
  };
  const HIGHLIGHT_BG = {
    violet: "rgba(124, 58, 237, 0.06)",
    green: "rgba(22, 163, 74, 0.06)",
    orange: "rgba(234, 88, 12, 0.06)",
  };

  React.useEffect(() => {
    if (!orders?.length) return;
    const ids = orders.map((o) => o.id).filter(Boolean);
    if (!ids.length) return;
    const idsStr = ids.join(",");
    fetch(`/api/row-highlights?orderIds=${idsStr}`)
      .then((r) => r.json())
      .then((data) => {
        const map = {};
        data.forEach((r) => {
          map[r.order_id] = r.color;
        });
        setRowHighlights(map);
      })
      .catch(() => {});
    fetch(`/api/cell-comments/presence?orderIds=${idsStr}`)
      .then((r) => r.json())
      .then((data) => {
        setCommentPresence(
          new Set(data.map((r) => `${r.order_id}:${r.column_name}`)),
        );
      })
      .catch(() => {});
  }, [orders]);

  const handleHighlight = async (orderId, color) => {
    setRowHighlights((prev) => {
      const next = { ...prev };
      if (color) next[orderId] = color;
      else delete next[orderId];
      return next;
    });
    try {
      await fetch("/api/row-highlights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: orderId, color }),
      });
    } catch {}
  };

  const handleContextMenu = (e, order) => {
    e.preventDefault();
    const td = e.target.closest("[data-col-key]");
    const colKey = td?.dataset.colKey || "row";
    const colLabel = td?.dataset.colLabel || null;
    setContextMenu({ x: e.clientX, y: e.clientY, order, colKey, colLabel });
  };

  const isDraggable = !readOnly && !sortConfig?.key;

  // dragState tracks live drag for visual hints: { fromIndex, toIndex, valid }
  const [dragState, setDragState] = useState(null);

  // ── Column filters ─────────────────────────────────────────────────────────
  const [columnFilters, setColumnFilters] = useState({});
  const [openFilterKey, setOpenFilterKey] = useState(null);
  const [filterDropdownPos, setFilterDropdownPos] = useState({ x: 0, y: 0 });
  const [colContextMenu, setColContextMenu] = useState(null);
  const [groupContextMenu, setGroupContextMenu] = useState(null);

  const GROUP_LABELS = {
    order_details: "Order Details",
    production_parameters: "Production Parameters",
    mixer_details: "Mixer Details",
    operator: "Operator",
    scheduling: "Scheduling",
    ai: "Product Insights",
    notes: "Notes",
    bagger_details: "Bagger Details",
    completion_tracking: "Tracking",
  };

  const openFilterFor = (colKey, e) => {
    e.stopPropagation();
    if (openFilterKey === colKey) {
      setOpenFilterKey(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    setFilterDropdownPos({ x: rect.left, y: rect.bottom + 4 });
    setOpenFilterKey(colKey);
  };

  const isFilterEmpty = (data) => {
    if (!data) return true;
    if (data.values !== undefined) return !data.values || data.values.length === 0;
    if (data.text !== undefined) return !data.text || data.text.trim() === "";
    if (data.items !== undefined || data.categories !== undefined)
      return (!data.items || data.items.length === 0) && (!data.categories || data.categories.length === 0);
    if (data.min !== undefined || data.max !== undefined)
      return data.min == null && data.max == null;
    if (data.from !== undefined || data.to !== undefined)
      return (!data.from || data.from === "") && (!data.to || data.to === "") &&
             (!data.fromTime || data.fromTime === "") && (!data.toTime || data.toTime === "");
    if (data.subTexts !== undefined)
      return (!data.from || data.from === "") && (!data.to || data.to === "") && (!data.subTexts || data.subTexts.length === 0);
    if (data.scada !== undefined || data.pv !== undefined)
      return (!data.rangeMin && !data.rangeMax) && (!data.scada || data.scada.trim() === "") && (!data.pv || data.pv.trim() === "");
    if (data.ranges !== undefined) return !data.ranges || data.ranges.length === 0;
    if (data.value !== undefined) return data.value == null || data.value === "";
    return false;
  };

  const applyFilter = (colKey, filterData) => {
    if (isFilterEmpty(filterData)) {
      setColumnFilters((prev) => {
        const next = { ...prev };
        delete next[colKey];
        return next;
      });
    } else {
      setColumnFilters((prev) => ({ ...prev, [colKey]: filterData }));
    }
    setOpenFilterKey(null);
  };

  const clearFilter = (colKey) => {
    setColumnFilters((prev) => {
      const next = { ...prev };
      delete next[colKey];
      return next;
    });
    setOpenFilterKey(null);
  };

  const clearAllFilters = () => {
    setColumnFilters({});
    setOpenFilterKey(null);
  };

  const hasActiveFilters = Object.keys(columnFilters).length > 0;

  const handleHeaderContextMenu = (e) => {
    e.preventDefault();
    const th = e.target.closest("[data-col-key]");
    if (th) {
      setColContextMenu({ colKey: th.dataset.colKey, x: e.clientX, y: e.clientY });
      return;
    }
    const gth = e.target.closest("[data-group-key]");
    if (gth) {
      const groupKey = gth.dataset.groupKey;
      setGroupContextMenu({ groupKey, label: GROUP_LABELS[groupKey] || groupKey, x: e.clientX, y: e.clientY });
    }
  };

  const FBtn = ({ col }) => {
    if (!COLUMN_FILTER_CONFIG[col]) return null;
    const isActive = !!columnFilters[col];
    return (
      <button
        className={`filter-icon-btn${isActive ? " active" : ""}`}
        style={{ marginLeft: "auto" }}
        onClick={(e) => openFilterFor(col, e)}
        title={`Filter ${COLUMN_FILTER_CONFIG[col]?.label || col}`}
        data-no-drag="true"
      >
        <FilterIcon />
      </button>
    );
  };

  // ── Per-column visibility ──────────────────────────────────────────────────
  // Each hideable column has its own identifier (stored in localStorage)
  const COL_META = {
    readiness: { label: "Readiness", width: 36 },
    prio: { label: "Prio", width: 44 },
    fpr: { label: "FPR", width: 88 },
    planned_order: { label: "Planned Order", width: 120 },
    prod_order: { label: "Production Order", width: 120 },
    mat_code_sfg: { label: "Material Code (SFG)", width: 124 },
    mat_code_fg: { label: "Material Code (FG)", width: 124 },
    item_desc: { label: "Item Description", width: 300 },
    form: { label: "Form", width: 80 },
    volume: { label: "Volume (MT)", width: 134 },
    batch_size: { label: "Batch Size", width: 88 },
    num_batches: { label: "Batches", width: 88 },
    num_bags: { label: "Bags", width: 88 },
    prod_time: { label: "Prod. Time", width: 160 },
    ha_info: { label: "HA Info", width: 180 },
    ha_prep: { label: "HA Prep", width: 140 },
    status: { label: "Status", width: 200 },
    start_date: { label: "Start Date", width: 160 },
    start_time: { label: "Start Time", width: 150 },
    avail_date: { label: "Avail Date", width: 160 },
    completion_date: { label: "Estimated Completion Date", width: 200 },
    smart_insight: { label: "Summary", width: 500 },
    fpr_notes: { label: "FPR Notes", width: 300 },
    special_remarks: { label: "Special Remarks", width: 300 },
    threads: { label: "Threads", width: 104 },
    sacks: { label: "Sacks", width: 200 },
    markings: { label: "Markings", width: 104 },
    tags: { label: "Tags", width: 200 },
    end_date: { label: "End Date", width: 160 },
    history: { label: "History", width: 64 },
  };
  const IND_W = 6;
  const [hiddenCols, setHiddenCols] = useState(() => {
    try {
      const stored = JSON.parse(
        localStorage.getItem("nexfeed_hidden_columns") || "[]",
      );
      return new Set(stored);
    } catch {
      return new Set();
    }
  });
  const [colSafetyToast, setColSafetyToast] = useState(false);
  const colSafetyTimerRef = React.useRef(null);
  const hideCol = (id) => {
    const totalCols = Object.keys(COL_META).length;
    const hiddenCount = hiddenCols.size;
    if (hiddenCount >= totalCols - 1) {
      setColSafetyToast(true);
      clearTimeout(colSafetyTimerRef.current);
      colSafetyTimerRef.current = setTimeout(
        () => setColSafetyToast(false),
        60000,
      );
      return;
    }
    setHiddenCols((prev) => {
      const next = new Set(prev);
      next.add(id);
      localStorage.setItem("nexfeed_hidden_columns", JSON.stringify([...next]));
      return next;
    });
  };
  const showCol = (id) =>
    setHiddenCols((prev) => {
      const next = new Set(prev);
      next.delete(id);
      localStorage.setItem("nexfeed_hidden_columns", JSON.stringify([...next]));
      return next;
    });
  const isHidden = (id) => hiddenCols.has(id);

  const GROUP_COLS = {
    order_details: [
      "planned_order",
      "prod_order",
      "mat_code_sfg",
      "mat_code_fg",
      "item_desc",
    ],
    production_parameters: [
      "form",
      "volume",
      "batch_size",
      "num_batches",
      "num_bags",
      "prod_time",
    ],
    mixer_details: ["ha_info", "ha_prep"],
    scheduling: ["start_date", "start_time", "avail_date", "completion_date", "end_date"],
    ai: ["smart_insight"],
    notes: ["fpr_notes", "special_remarks"],
    bagger_details: ["threads", "sacks", "markings", "tags"],
    completion_tracking: ["history"],
  };
  const [hiddenGroups, setHiddenGroups] = useState(() => {
    try {
      const stored = JSON.parse(
        localStorage.getItem("nexfeed_hidden_column_groups") || "[]",
      );
      return new Set(stored);
    } catch {
      return new Set();
    }
  });
  const hideGroup = (id) =>
    setHiddenGroups((prev) => {
      const next = new Set(prev);
      next.add(id);
      localStorage.setItem(
        "nexfeed_hidden_column_groups",
        JSON.stringify([...next]),
      );
      return next;
    });
  const showGroup = (id) =>
    setHiddenGroups((prev) => {
      const next = new Set(prev);
      next.delete(id);
      localStorage.setItem(
        "nexfeed_hidden_column_groups",
        JSON.stringify([...next]),
      );
      return next;
    });
  const isGroupHidden = (id) => hiddenGroups.has(id);

  // Style for a hidden column's indicator cell (th or td)
  const indStyle = {
    width: IND_W,
    minWidth: IND_W,
    maxWidth: IND_W,
    padding: 0,
    cursor: "col-resize",
    background: "transparent",
    borderLeft: "2px solid #e5e7eb",
    borderRight: "2px solid #e5e7eb",
  };
  // <col> element for any column (full or indicator width)
  const colEl = (id) => (
    <col
      key={id}
      style={{ width: isHidden(id) ? IND_W : COL_META[id].width }}
    />
  );
  // ─────────────────────────────────────────────────────────────────────────

  // NEW badge: FPRs of recently uploaded non-dated orders (from localStorage, expire after 24h)
  const [newBadgeFprs, setNewBadgeFprs] = useState(() => {
    try {
      const stored = JSON.parse(
        localStorage.getItem("nexfeed_new_non_dated_fprs") || "[]",
      );
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      return new Set(stored.filter((b) => b.ts > cutoff).map((b) => b.fpr));
    } catch {
      return new Set();
    }
  });

  const [isEnhancing, setIsEnhancing] = useState(false);
  const handleEnhanceWithAI = async () => {
    if (isEnhancing || !n10dRecords.length) return;
    setIsEnhancing(true);
    setInsightLoading(true);
    try {
      const aiMap = await generateProductAIInsights(n10dRecords, allOrders);
      updateAIInsights(aiMap);
      setInsightLoading(false);
    } catch (err) {
      console.error("[Insights] AI generation failed:", err);
      setInsightError(true);
    } finally {
      setIsEnhancing(false);
    }
  };

  const clearNewBadge = (fpr) => {
    if (!fpr || !newBadgeFprs.has(fpr)) return;
    try {
      const stored = JSON.parse(
        localStorage.getItem("nexfeed_new_non_dated_fprs") || "[]",
      );
      localStorage.setItem(
        "nexfeed_new_non_dated_fprs",
        JSON.stringify(stored.filter((b) => b.fpr !== fpr)),
      );
    } catch {}
    setNewBadgeFprs((prev) => {
      const s = new Set(prev);
      s.delete(fpr);
      return s;
    });
  };

  const violationTimerRef = React.useRef(null);
  useEffect(() => {
    if (!dateViolationToast) return;
    violationTimerRef.current = setTimeout(
      () => setDateViolationToast(null),
      12000,
    );
    return () => clearTimeout(violationTimerRef.current);
  }, [dateViolationToast]);

  const handleDragStart = (start) => {
    setDragState({ fromIndex: start.source.index, toIndex: null, valid: true });
  };

  const handleDragUpdate = (update) => {
    if (!update.destination) {
      setDragState((prev) =>
        prev ? { ...prev, toIndex: null, valid: true } : null,
      );
      return;
    }
    const from = update.source.index;
    const to = update.destination.index;
    if (from === to) {
      setDragState((prev) =>
        prev ? { ...prev, toIndex: to, valid: true } : null,
      );
      return;
    }
    // Use visibleOrders so indices match the Draggable index props
    const check = validateDropPosition(
      from,
      to,
      visibleOrders,
      inferredTargetMap,
    );
    setDragState({ fromIndex: from, toIndex: to, valid: check.valid });
  };

  const handleDragEnd = (result) => {
    setDragState(null);
    if (!result.destination || result.destination.index === result.source.index)
      return;
    const from = result.source.index;
    const to = result.destination.index;

    // ── Locked status check ────────────────────────────────────────────────
    // Only applies to upward moves (to < from).
    // Hard-locked (InProd, OnGoing): block entirely with red toast.
    // Planned: soft-warn dialog with Cancel / Proceed Anyway options.
    const draggedOrder = visibleOrders[from];

    // When dragging a Planned order itself — show a warning dialog
    if (draggedOrder?.status === "planned") {
      setMovingPlannedDialog({ from, to, dragged: draggedOrder });
      return;
    }

    if (to < from && draggedOrder && !isLockedStatus(draggedOrder.status)) {
      let hardBlocker = null;
      let plannedBlocker = null;
      for (let i = to; i < from; i++) {
        const o = visibleOrders[i];
        if (!o || o.status === 'cancel_po') continue;
        if (HARD_LOCKED_STATUSES.includes(o.status)) {
          hardBlocker = o;
          break;
        }
        if (o.status === 'planned' && !plannedBlocker) {
          plannedBlocker = o;
        }
      }
      if (hardBlocker) {
        setLockedStatusWarn({ dragged: draggedOrder, blocker: hardBlocker });
        return;
      }
      if (plannedBlocker) {
        setPlannedAffectedDialog({ from, to, dragged: draggedOrder, planned: plannedBlocker });
        return;
      }
    }

    // Use visibleOrders — Draggable indices are positions within visibleOrders, not the full orders prop
    const check = validateDropPosition(
      from,
      to,
      visibleOrders,
      inferredTargetMap,
    );
    if (!check.valid) {
      const dragged = visibleOrders[from];
      const isInferredTarget = !!(
        inferredTargetMap[dragged?.id] &&
        !isValidAvailDate(dragged?.target_avail_date)
      );
      setDateViolationToast({
        dragged: {
          fpr: dragged?.fpr,
          date: fmtViolationDate(dragged?.target_avail_date),
        },
        earlier: {
          fpr: check.earlier?.fpr,
          date: fmtViolationDate(check.earlier?.target_avail_date),
        },
        later: {
          fpr: check.later?.fpr,
          date: fmtViolationDate(check.later?.target_avail_date),
        },
        isInferredTarget,
        sequenceDates: [
          check.earlier
            ? fmtViolationDate(check.earlier.target_avail_date)
            : null,
          fmtViolationDate(dragged?.target_avail_date),
          check.later ? fmtViolationDate(check.later.target_avail_date) : null,
        ].filter(Boolean),
      });
      return;
    }
    // Clear NEW badge for the dragged order once user positions it
    clearNewBadge(visibleOrders[from]?.fpr);
    // Pass visibleOrders so fromIndex/toIndex are correct in handleReorder
    onReorder && onReorder(from, to, visibleOrders);
  };

  const isEditable = (order, fieldGroup) => {
    if (readOnly) return false;
    const s = order.status || "plotted";
    // Custom free-text statuses get same editable access as Plotted
    if (isCustomStatus(s)) return fieldGroup !== "end";
    if (fieldGroup === "start") return EDITABLE_START.includes(s);
    if (fieldGroup === "ha_notes") return EDITABLE_HA_NOTES.includes(s);
    if (fieldGroup === "end") return s === "completed";
    if (fieldGroup === "volume") return EDITABLE_VOLUME.includes(s);
    if (fieldGroup === "completion") return EDITABLE_COMPLETION.includes(s);
    if (fieldGroup === "status") return true;
    return false;
  };

  const GH =
    "text-center text-[11px] font-bold text-[#a1a8b3] uppercase tracking-wider py-1 px-2 border-b border-gray-200";
  const CH =
    "px-2 py-1.5 text-left text-[11px] font-normal text-[#6b7280] border-b border-gray-200 whitespace-nowrap";

  // Returns true if the mouse is over actual rendered text (→ allow text selection, cancel drag).
  // Returns false if the mouse is over empty space / padding (→ allow drag).
  const isOverText = (e) => {
    const target = e.target;

    // Drag handle cell — always allow drag
    if (target.closest?.(".drag-handle-cell")) return false;

    // Interactive controls — always cancel drag
    const tag = target.tagName?.toUpperCase();
    if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(tag)) return true;
    if (
      target.getAttribute?.("role") === "combobox" ||
      target.getAttribute?.("role") === "listbox"
    ) return true;
    if (target.dataset?.noDrag === "true") return true;
    if (
      target.classList?.contains("select-trigger") ||
      target.closest?.("[data-radix-popper-content-wrapper]")
    ) return true;

    // Precise text detection via caretRangeFromPoint (Chrome/Safari/Edge)
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
        return false;
      }
      // Firefox
      if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
        if (pos?.offsetNode?.nodeType === Node.TEXT_NODE) {
          if (pos.offsetNode.textContent.trim().length > 0) return true;
        }
        return false;
      }
    } catch (_) {}

    // Fallback — cancel drag over any non-empty inline text element
    if (["P", "SPAN", "LABEL"].includes(tag) && target.textContent?.trim().length > 0) return true;
    return false;
  };

  // Compute active order rank (blank for done/cancelled/children, 1-N for active non-children)
  const activeRankMap = new Map();
  let _activeRank = 0;
  for (const o of orders) {
    if (o.status !== "completed" && o.status !== "cancel_po" && !o.parent_id) {
      _activeRank++;
      activeRankMap.set(o.id, _activeRank);
    }
  }

  // Build visible orders: hide children whose parent lead is collapsed, then apply column filters
  const _expandedOrders = orders.filter(
    (o) => !o.parent_id || expandedLeads.has(o.parent_id),
  );
  const visibleOrders = applyColumnFilters(_expandedOrders, columnFilters);

  return (
    <TooltipProvider delayDuration={200}>
      <OrderHistoryModal
        isOpen={!!historyOrder}
        onClose={() => setHistoryOrder(null)}
        order={historyOrder}
      />
      <DragDropContext
        onDragStart={handleDragStart}
        onDragUpdate={handleDragUpdate}
        onDragEnd={handleDragEnd}
      >
        <style>{`
      .order-table-scroll::-webkit-scrollbar { width: 7px; height: 7px; }
      .order-table-scroll::-webkit-scrollbar-track { background: #f0f0f0; border-radius: 4px; }
      .order-table-scroll::-webkit-scrollbar-thumb { background: #c0c0c0; border-radius: 4px; }
      .order-table-scroll::-webkit-scrollbar-thumb:hover { background: #888; }
      .order-table-scroll::-webkit-scrollbar-corner { background: #f0f0f0; }
      tr[data-rfd-draggable-id] { cursor: grab; }
      tr[data-rfd-draggable-id]:active { cursor: grabbing; }
      tr[data-rfd-draggable-id].drag-disabled { cursor: default !important; }
      tr[data-rfd-draggable-id].drag-disabled:active { cursor: default !important; }
      tr[data-rfd-draggable-id] td { cursor: grab; user-select: text; }
      tr[data-rfd-draggable-id].drag-disabled td { cursor: default; }
      tr[data-rfd-draggable-id] td span,
      tr[data-rfd-draggable-id] td p,
      tr[data-rfd-draggable-id] td label { cursor: text; user-select: text; }
      tr[data-rfd-draggable-id] td input,
      tr[data-rfd-draggable-id] td select,
      tr[data-rfd-draggable-id] td textarea { cursor: text; user-select: text; }
      tr[data-rfd-draggable-id] td button,
      tr[data-rfd-draggable-id] td [role="combobox"],
      tr[data-rfd-draggable-id] td a,
      tr[data-rfd-draggable-id] td [data-no-drag="true"] { cursor: pointer; user-select: none; }
      tr[data-rfd-draggable-id] td.drag-handle-cell,
      tr[data-rfd-draggable-id] td.drag-handle-cell svg { cursor: grab; user-select: none; }
      tr[data-rfd-draggable-id] td.drag-handle-cell:active { cursor: grabbing; }
      .drag-invalid-mode tr[data-rfd-draggable-id]:not(.drag-disabled) { cursor: no-drop !important; }
      .drag-invalid-mode tr[data-rfd-draggable-id]:not(.drag-disabled) td { cursor: no-drop !important; }
      .drag-invalid-mode tr[data-rfd-draggable-id]:not(.drag-disabled) td.drag-handle-cell,
      .drag-invalid-mode tr[data-rfd-draggable-id]:not(.drag-disabled) td.drag-handle-cell svg { cursor: no-drop !important; }
      .col-hide-indicator:hover { background: #eff6ff !important; border-left-color: #3b82f6 !important; border-right-color: #3b82f6 !important; }
      tr[data-hold="standalone"] td { color: #c0c7d0 !important; }
      tr[data-hold="standalone"] { opacity: 0.7; }
      tr[data-hold="combined"] td { color: #c0c7d0 !important; }
      .hideable-col-header { position: relative; display: flex; align-items: center; gap: 4px; }
      .hideable-col-header .col-hide-btn { display: none !important; }
      th[data-group-key] .hideable-col-header { justify-content: center; }
      th[data-group-key] .col-hide-btn { position: absolute !important; right: 6px; }
      .filter-icon-btn { background: none; border: none; cursor: pointer; padding: 2px; border-radius: 3px; display: inline-flex; align-items: center; justify-content: center; color: #9ca3af; transition: color 0.15s, background 0.15s; flex-shrink: 0; opacity: 0; }
      th:hover .filter-icon-btn, .filter-icon-btn.active { opacity: 1; }
      .filter-icon-btn:hover { background: rgba(0,0,0,0.06); color: #6b7280; }
      .filter-icon-btn.active { color: #fd5108; }
      .filter-icon-btn.active:hover { color: #e8490b; background: rgba(253,81,8,0.08); }
      .sparkle-btn { background: #fef3c7; border: none; cursor: pointer; font-size: 11px; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; border-radius: 5px; transition: background 0.15s ease; vertical-align: middle; }
      .sparkle-btn:hover:not(:disabled) { background: #fde68a; }
      .sparkle-btn:active:not(:disabled) { background: #fcd34d; }
      .sparkle-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .sparkle-btn.generating { animation: sparkle-pulse 1s ease infinite; }
      @keyframes sparkle-pulse { 0% { background: #fef3c7; } 50% { background: #fde68a; } 100% { background: #fef3c7; } }
    `}</style>

        {openFilterKey && (
          <FilterDropdown
            colKey={openFilterKey}
            orders={orders}
            activeFilter={columnFilters[openFilterKey]}
            position={filterDropdownPos}
            onApply={(data) => applyFilter(openFilterKey, data)}
            onClear={() => clearFilter(openFilterKey)}
            onClose={() => setOpenFilterKey(null)}
          />
        )}
        {colContextMenu && (
          <ColumnContextMenu
            position={{ x: colContextMenu.x, y: colContextMenu.y }}
            onHide={() => {
              hideCol(colContextMenu.colKey);
            }}
            onClose={() => setColContextMenu(null)}
          />
        )}
        {groupContextMenu && (
          <GroupContextMenu
            position={{ x: groupContextMenu.x, y: groupContextMenu.y }}
            label={groupContextMenu.label}
            onHide={() => {
              if (groupContextMenu.groupKey === "operator") {
                hideCol("status");
              } else {
                hideGroup(groupContextMenu.groupKey);
              }
            }}
            onClose={() => setGroupContextMenu(null)}
          />
        )}
        <div
          className={cn(
            "bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden",
            dragState &&
              !dragState.valid &&
              dragState.toIndex !== null &&
              "drag-invalid-mode",
          )}
        >
          {hasActiveFilters && (
            <div
              style={{
                padding: "6px 12px",
                borderBottom: "1px solid #f3f4f6",
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: "#fffbf9",
              }}
            >
              <span style={{ fontSize: 11, color: "#6b7280" }}>
                {Object.keys(columnFilters).length} filter
                {Object.keys(columnFilters).length !== 1 ? "s" : ""} active
              </span>
              <button
                className="clear-col-filters-btn"
                onClick={clearAllFilters}
              >
                Clear filters
              </button>
            </div>
          )}
          <div
            className="order-table-scroll overflow-auto"
            style={{ maxHeight: "calc(100vh - 320px)", minHeight: "300px" }}
          >
            <table
              style={{
                tableLayout: "fixed",
                borderCollapse: "collapse",
                width: "max-content",
                minWidth: "100%",
              }}
            >
              <colgroup>
                {isDraggable && <col style={{ width: 28 }} />}
                {colEl("readiness")}
                {colEl("prio")}
                {colEl("fpr")}
                {isGroupHidden("order_details") ? (
                  <col
                    key="grp-od"
                    style={{ width: IND_W, minWidth: IND_W, maxWidth: IND_W }}
                  />
                ) : (
                  GROUP_COLS.order_details.map((id) => colEl(id))
                )}
                {isGroupHidden("production_parameters") ? (
                  <col
                    key="grp-pp"
                    style={{ width: IND_W, minWidth: IND_W, maxWidth: IND_W }}
                  />
                ) : (
                  GROUP_COLS.production_parameters.map((id) => colEl(id))
                )}
                {isGroupHidden("mixer_details") ? (
                  <col
                    key="grp-md"
                    style={{ width: IND_W, minWidth: IND_W, maxWidth: IND_W }}
                  />
                ) : (
                  GROUP_COLS.mixer_details.map((id) => colEl(id))
                )}
                {colEl("status")}
                {isGroupHidden("scheduling") ? (
                  <col
                    key="grp-sch"
                    style={{ width: IND_W, minWidth: IND_W, maxWidth: IND_W }}
                  />
                ) : (
                  GROUP_COLS.scheduling.map((id) => colEl(id))
                )}
                {isGroupHidden("ai") ? (
                  <col
                    key="grp-ai"
                    style={{ width: IND_W, minWidth: IND_W, maxWidth: IND_W }}
                  />
                ) : (
                  GROUP_COLS.ai.map((id) => colEl(id))
                )}
                {isGroupHidden("notes") ? (
                  <col
                    key="grp-notes"
                    style={{ width: IND_W, minWidth: IND_W, maxWidth: IND_W }}
                  />
                ) : (
                  GROUP_COLS.notes.map((id) => colEl(id))
                )}
                {isGroupHidden("bagger_details") ? (
                  <col
                    key="grp-bd"
                    style={{ width: IND_W, minWidth: IND_W, maxWidth: IND_W }}
                  />
                ) : (
                  GROUP_COLS.bagger_details.map((id) => colEl(id))
                )}
                {isGroupHidden("completion_tracking") ? (
                  <col
                    key="grp-ct"
                    style={{ width: IND_W, minWidth: IND_W, maxWidth: IND_W }}
                  />
                ) : (
                  GROUP_COLS.completion_tracking.map((id) => colEl(id))
                )}
              </colgroup>
              <thead style={{ position: "sticky", top: 0, zIndex: 20 }} onContextMenu={handleHeaderContextMenu}>
                <tr>
                  {isDraggable && (
                    <th
                      style={{
                        background: "#f9fafb",
                        borderBottom: "1px solid #e5e7eb",
                      }}
                    />
                  )}
                  {/* Readiness, Prio, FPR — standalone, no group */}
                  <th
                    style={{
                      background: "#f5f7f8",
                      borderBottom: "1px solid #e5e7eb",
                    }}
                  />
                  <th
                    style={{
                      background: "#f5f7f8",
                      borderBottom: "1px solid #e5e7eb",
                    }}
                  />
                  <th
                    style={{
                      background: "#f5f7f8",
                      borderBottom: "1px solid #e5e7eb",
                    }}
                  />
                  {/* ORDER DETAILS — hideable group */}
                  {isGroupHidden("order_details") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onDoubleClick={() => showGroup("order_details")}
                      title={`Double-click to show Order Details (${GROUP_COLS.order_details.length} columns)`}
                    />
                  ) : (
                    <th
                      colSpan={GROUP_COLS.order_details.length}
                      className={`order-table-header-order-details ${GH}`}
                      style={{ background: "#f5f7f8" }}
                      data-group-key="order_details"
                      data-tour="orders-header-details"
                    >
                      <div className="hideable-col-header">
                        Order Details
                        <span
                          className="col-hide-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            hideGroup("order_details");
                          }}
                        >
                          ◂
                        </span>
                      </div>
                    </th>
                  )}
                  {/* PRODUCTION PARAMETERS — hideable group */}
                  {isGroupHidden("production_parameters") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onDoubleClick={() => showGroup("production_parameters")}
                      title={`Double-click to show Production Parameters (${GROUP_COLS.production_parameters.length} columns)`}
                    />
                  ) : (
                    <th
                      colSpan={GROUP_COLS.production_parameters.length}
                      className={`order-table-header-production-params ${GH}`}
                      style={{ background: "#ffffff" }}
                      data-group-key="production_parameters"
                      data-tour="orders-header-production"
                    >
                      <div className="hideable-col-header">
                        Production Parameters
                        <span
                          className="col-hide-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            hideGroup("production_parameters");
                          }}
                        >
                          ◂
                        </span>
                      </div>
                    </th>
                  )}
                  {/* MIXER DETAILS — hideable group */}
                  {isGroupHidden("mixer_details") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onDoubleClick={() => showGroup("mixer_details")}
                      title={`Double-click to show Mixer Details (${GROUP_COLS.mixer_details.length} columns)`}
                    />
                  ) : (
                    <th
                      colSpan={GROUP_COLS.mixer_details.length}
                      className={GH}
                      style={{ background: "#f8f0fb" }}
                      data-group-key="mixer_details"
                    >
                      <div className="hideable-col-header">
                        Mixer Details
                        <span
                          className="col-hide-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            hideGroup("mixer_details");
                          }}
                        >
                          ◂
                        </span>
                      </div>
                    </th>
                  )}
                  {/* OPERATOR — status column */}
                  {isHidden("status") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onClick={() => showCol("status")}
                      title="Unhide Operator Status"
                    />
                  ) : (
                    <th
                      colSpan={1}
                      className={`order-table-header-operator ${GH}`}
                      style={{ background: "#ffe8d4" }}
                      data-group-key="operator"
                      data-tour="orders-header-operator"
                    >
                      <div className="hideable-col-header">
                        Operator
                        <span
                          className="col-hide-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            hideCol("status");
                          }}
                        >
                          ◂
                        </span>
                      </div>
                    </th>
                  )}
                  {/* SCHEDULING — hideable group */}
                  {isGroupHidden("scheduling") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onDoubleClick={() => showGroup("scheduling")}
                      title={`Double-click to show Scheduling (${GROUP_COLS.scheduling.length} columns)`}
                    />
                  ) : (
                    <th
                      colSpan={GROUP_COLS.scheduling.length}
                      className={`order-table-header-scheduling ${GH}`}
                      style={{ background: "#f5f7f8" }}
                      data-group-key="scheduling"
                      data-tour="orders-header-scheduling"
                    >
                      <div className="hideable-col-header">
                        Scheduling
                        <span
                          className="col-hide-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            hideGroup("scheduling");
                          }}
                        >
                          ◂
                        </span>
                      </div>
                    </th>
                  )}
                  {/* AI — independent group, yellow */}
                  {isGroupHidden("ai") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onDoubleClick={() => showGroup("ai")}
                      title="Double-click to show Product Insights (Summary)"
                    />
                  ) : (
                    <th
                      colSpan={GROUP_COLS.ai.length}
                      className={`order-table-header-product-insights ${GH}`}
                      style={{ background: "#fef9e7" }}
                      data-group-key="ai"
                      data-tour="orders-header-product-insights"
                    >
                      <div className="hideable-col-header">
                        PRODUCT INSIGHTS
                        <span
                          className="col-hide-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            hideGroup("ai");
                          }}
                        >
                          ◂
                        </span>
                      </div>
                    </th>
                  )}
                  {/* NOTES — hideable group */}
                  {isGroupHidden("notes") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onDoubleClick={() => showGroup("notes")}
                      title={`Double-click to show Notes (${GROUP_COLS.notes.length} columns)`}
                    />
                  ) : (
                    <th
                      colSpan={GROUP_COLS.notes.length}
                      className={GH}
                      style={{ background: "#ffffff" }}
                      data-group-key="notes"
                    >
                      <div className="hideable-col-header">
                        Notes
                        <span
                          className="col-hide-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            hideGroup("notes");
                          }}
                        >
                          ◂
                        </span>
                      </div>
                    </th>
                  )}
                  {/* BAGGER DETAILS — hideable group */}
                  {isGroupHidden("bagger_details") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onDoubleClick={() => showGroup("bagger_details")}
                      title={`Double-click to show Bagger Details (${GROUP_COLS.bagger_details.length} columns)`}
                    />
                  ) : (
                    <th
                      colSpan={GROUP_COLS.bagger_details.length}
                      className={GH}
                      style={{ background: "#e8f5e9" }}
                      data-group-key="bagger_details"
                    >
                      <div className="hideable-col-header">
                        Bagger Details
                        <span
                          className="col-hide-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            hideGroup("bagger_details");
                          }}
                        >
                          ◂
                        </span>
                      </div>
                    </th>
                  )}
                  {/* COMPLETION & TRACKING — hideable group */}
                  {isGroupHidden("completion_tracking") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onDoubleClick={() => showGroup("completion_tracking")}
                      title={`Double-click to show Tracking (${GROUP_COLS.completion_tracking.length} columns)`}
                    />
                  ) : (
                    <th
                      colSpan={GROUP_COLS.completion_tracking.length}
                      className={GH}
                      style={{ background: "#ffffff" }}
                      data-group-key="completion_tracking"
                    >
                      <div className="hideable-col-header">
                        Tracking
                        <span
                          className="col-hide-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            hideGroup("completion_tracking");
                          }}
                        >
                          ◂
                        </span>
                      </div>
                    </th>
                  )}
                </tr>

                <tr style={{ background: "#f9fafb" }}>
                  {isDraggable && (
                    <th style={{ background: "#ffffff" }} className={CH} />
                  )}
                  {isHidden("readiness") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onClick={() => showCol("readiness")}
                      title="Unhide Readiness"
                    />
                  ) : (
                    <th style={{ background: "#f5f7f8" }} className={CH} data-col-key="readiness">
                      <div className="hideable-col-header">
                        <span
                          style={{ color: "transparent", userSelect: "none" }}
                        >
                          •
                        </span>
                        <FBtn col="readiness" />
                        <span
                          className="col-hide-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            hideCol("readiness");
                          }}
                        >
                          ◂
                        </span>
                      </div>
                    </th>
                  )}
                  {isHidden("prio") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onClick={() => showCol("prio")}
                      title="Unhide Prio"
                    />
                  ) : (
                    <th
                      style={{ background: "#f5f7f8" }}
                      className={`${CH} text-center`}
                      data-col-key="prio"
                    >
                      <div className="hideable-col-header">
                        Prio
                        <FBtn col="prio" />
                        <span
                          className="col-hide-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            hideCol("prio");
                          }}
                        >
                          ◂
                        </span>
                      </div>
                    </th>
                  )}
                  {isHidden("fpr") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onClick={() => showCol("fpr")}
                      title="Unhide FPR"
                    />
                  ) : (
                    <th style={{ background: "#f5f7f8" }} className={CH} data-col-key="fpr">
                      <div className="hideable-col-header">
                        FPR
                        <FBtn col="fpr" />
                        <span
                          className="col-hide-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            hideCol("fpr");
                          }}
                        >
                          ◂
                        </span>
                      </div>
                    </th>
                  )}
                  {/* ORDER DETAILS — 5 columns */}
                  {isGroupHidden("order_details") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onDoubleClick={() => showGroup("order_details")}
                    />
                  ) : (
                    <>
                      {isHidden("planned_order") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("planned_order")}
                          title="Unhide Planned Order"
                        />
                      ) : (
                        <th style={{ background: "#f5f7f8" }} className={CH} data-col-key="planned_order">
                          <div className="hideable-col-header">
                            <div>Planned Order</div>
                            <div className="text-[10px] font-normal text-gray-400">
                              {isPMX ? "FG | SFG | PMX" : "FG | SFG"}
                            </div>
                            <FBtn col="planned_order" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("planned_order");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                      {isHidden("prod_order") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("prod_order")}
                          title="Unhide Production Order"
                        />
                      ) : (
                        <th style={{ background: "#f5f7f8" }} className={CH} data-col-key="prod_order">
                          <div className="hideable-col-header">
                            <div>Production Order</div>
                            <div className="text-[10px] font-normal text-gray-400">
                              {isPMX ? "FG1 | SFG1 | SFGPMX" : "FG1 | SFG1"}
                            </div>
                            <FBtn col="prod_order" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("prod_order");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                      {isHidden("mat_code_sfg") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("mat_code_sfg")}
                          title="Unhide Material Code (SFG)"
                        />
                      ) : (
                        <th style={{ background: "#f5f7f8" }} className={CH} data-col-key="mat_code_sfg">
                          <div className="hideable-col-header">
                            Material Code (SFG)
                            <FBtn col="mat_code_sfg" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("mat_code_sfg");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                      {isHidden("mat_code_fg") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("mat_code_fg")}
                          title="Unhide Material Code (FG)"
                        />
                      ) : (
                        <th style={{ background: "#f5f7f8" }} className={CH} data-col-key="mat_code_fg">
                          <div className="hideable-col-header">
                            Material Code (FG)
                            <FBtn col="mat_code_fg" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("mat_code_fg");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                      {isHidden("item_desc") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("item_desc")}
                          title="Unhide Item Description"
                        />
                      ) : (
                        <th style={{ background: "#f5f7f8" }} className={CH} data-col-key="item_desc">
                          <div className="hideable-col-header">
                            Item Description
                            <FBtn col="item_desc" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("item_desc");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                    </>
                  )}
                  {/* PRODUCTION PARAMETERS — 6 columns */}
                  {isGroupHidden("production_parameters") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onDoubleClick={() => showGroup("production_parameters")}
                    />
                  ) : (
                    <>
                      {isHidden("form") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("form")}
                          title="Unhide Form"
                        />
                      ) : (
                        <th style={{ background: "#ffffff" }} className={CH} data-col-key="form">
                          <div className="hideable-col-header">
                            Form
                            <FBtn col="form" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("form");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                      {isHidden("volume") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("volume")}
                          title="Unhide Volume (MT)"
                        />
                      ) : (
                        <th style={{ background: "#ffffff" }} className={CH} data-col-key="volume">
                          <div className="hideable-col-header">
                            Volume (MT)
                            <FBtn col="volume" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("volume");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                      {isHidden("batch_size") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("batch_size")}
                          title="Unhide Batch Size"
                        />
                      ) : (
                        <th
                          style={{ background: "#ffffff" }}
                          className={`${CH} text-center`}
                          data-col-key="batch_size"
                        >
                          <div className="hideable-col-header">
                            <span style={{ flex: 1, textAlign: "center" }}>Batch Size</span>
                            <FBtn col="batch_size" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("batch_size");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                      {isHidden("num_batches") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("num_batches")}
                          title="Unhide Batches"
                        />
                      ) : (
                        <th
                          style={{ background: "#ffffff" }}
                          className={`${CH} text-center`}
                          data-col-key="num_batches"
                        >
                          <div className="hideable-col-header">
                            <span style={{ flex: 1, textAlign: "center" }}>Batches</span>
                            <FBtn col="num_batches" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("num_batches");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                      {isHidden("num_bags") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("num_bags")}
                          title="Unhide Bags"
                        />
                      ) : (
                        <th
                          style={{ background: "#ffffff" }}
                          className={`${CH} text-center`}
                          data-col-key="num_bags"
                        >
                          <div className="hideable-col-header">
                            <span style={{ flex: 1, textAlign: "center" }}>Bags</span>
                            <FBtn col="num_bags" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("num_bags");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                      {isHidden("prod_time") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("prod_time")}
                          title="Unhide Production Time"
                        />
                      ) : (
                        <th style={{ background: "#ffffff" }} className={CH} data-col-key="prod_time">
                          <div className="hideable-col-header">
                            Production Time
                            <FBtn col="prod_time" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("prod_time");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                    </>
                  )}
                  {/* MIXER DETAILS — 2 columns */}
                  {isGroupHidden("mixer_details") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onDoubleClick={() => showGroup("mixer_details")}
                    />
                  ) : (
                    <>
                      {isHidden("ha_info") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("ha_info")}
                          title="Unhide HA Info"
                        />
                      ) : (
                        <th style={{ background: "#f8f0fb" }} className={CH} data-col-key="ha_info">
                          <div className="hideable-col-header">
                            HA Info
                            <FBtn col="ha_info" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("ha_info");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                      {isHidden("ha_prep") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("ha_prep")}
                          title="Unhide HA Prep"
                        />
                      ) : (
                        <th style={{ background: "#f8f0fb" }} className={CH} data-col-key="ha_prep">
                          <div className="hideable-col-header">
                            HA Prep
                            <FBtn col="ha_prep" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("ha_prep");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                    </>
                  )}
                  {/* OPERATOR — status column */}
                  {isHidden("status") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onClick={() => showCol("status")}
                      title="Unhide Status"
                    />
                  ) : (
                    <th style={{ background: "#ffe8d4" }} className={CH} data-col-key="status">
                      <div className="hideable-col-header">
                        Status
                        <FBtn col="status" />
                        <span
                          className="col-hide-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            hideCol("status");
                          }}
                        >
                          ◂
                        </span>
                      </div>
                    </th>
                  )}
                  {/* SCHEDULING — 3 columns */}
                  {isGroupHidden("scheduling") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onDoubleClick={() => showGroup("scheduling")}
                    />
                  ) : (
                    <>
                      {isHidden("start_date") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("start_date")}
                          title="Unhide Start Date"
                        />
                      ) : (
                        <th style={{ background: "#f5f7f8" }} className={CH} data-col-key="start_date">
                          <div className="hideable-col-header">
                            Start Date
                            <FBtn col="start_date" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("start_date");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                      {isHidden("start_time") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("start_time")}
                          title="Unhide Start Time"
                        />
                      ) : (
                        <th style={{ background: "#f5f7f8" }} className={CH} data-col-key="start_time">
                          <div className="hideable-col-header">
                            Start Time
                            <FBtn col="start_time" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("start_time");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                      {isHidden("avail_date") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("avail_date")}
                          title="Unhide Avail Date"
                        />
                      ) : (
                        <th style={{ background: "#f5f7f8" }} className={CH} data-col-key="avail_date">
                          <div className="hideable-col-header">
                            Avail Date
                            <FBtn col="avail_date" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("avail_date");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                      {isHidden("completion_date") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("completion_date")}
                          title="Unhide Estimated Completion Date"
                        />
                      ) : (
                        <th style={{ background: "#f5f7f8" }} className={CH} data-col-key="completion_date">
                          <div className="hideable-col-header">
                            Estimated Completion Date
                            <FBtn col="completion_date" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("completion_date");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                      {isHidden("end_date") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("end_date")}
                          title="Unhide End Date"
                        />
                      ) : (
                        <th style={{ background: "#f5f7f8" }} className={CH} data-col-key="end_date">
                          <div className="hideable-col-header">
                            End Date
                            <FBtn col="end_date" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("end_date");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                    </>
                  )}
                  {/* AI — 1 column, light yellow sub-header */}
                  {isGroupHidden("ai") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onDoubleClick={() => showGroup("ai")}
                    />
                  ) : (
                    <>
                      {isHidden("smart_insight") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("smart_insight")}
                          title="Unhide Summary"
                        />
                      ) : (
                        <th
                          style={{ background: "#fef9e7" }}
                          className={CH}
                          data-col-key="smart_insight"
                        >
                          <div className="hideable-col-header">
                            <span
                              style={{ display: "flex", alignItems: "center", gap: "5px" }}
                            >
                              <button
                                className={`sparkle-btn${isEnhancing ? " generating" : ""}`}
                                title={
                                  isEnhancing
                                    ? "Generating…"
                                    : n10dRecords.length === 0
                                      ? "Upload N10D data to enable AI insights"
                                      : "Enhance with AI"
                                }
                                disabled={
                                  isEnhancing || n10dRecords.length === 0
                                }
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleEnhanceWithAI();
                                }}
                              >
                                <Sparkles size={11} color="#d97706" strokeWidth={2} />
                              </button>
                              Summary
                            </span>
                            <FBtn col="smart_insight" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("smart_insight");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                    </>
                  )}
                  {/* NOTES — 3 columns */}
                  {isGroupHidden("notes") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onDoubleClick={() => showGroup("notes")}
                    />
                  ) : (
                    <>
                      {isHidden("fpr_notes") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("fpr_notes")}
                          title="Unhide FPR Notes"
                        />
                      ) : (
                        <th style={{ background: "#fff" }} className={CH} data-col-key="fpr_notes">
                          <div className="hideable-col-header">
                            FPR Notes
                            <FBtn col="fpr_notes" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("fpr_notes");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                      {isHidden("special_remarks") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("special_remarks")}
                          title="Unhide Special Remarks"
                        />
                      ) : (
                        <th style={{ background: "#fff" }} className={CH} data-col-key="special_remarks">
                          <div className="hideable-col-header">
                            Special Remarks
                            <FBtn col="special_remarks" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("special_remarks");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                    </>
                  )}
                  {/* BAGGER DETAILS — 4 columns */}
                  {isGroupHidden("bagger_details") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onDoubleClick={() => showGroup("bagger_details")}
                    />
                  ) : (
                    <>
                      {isHidden("threads") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("threads")}
                          title="Unhide Threads"
                        />
                      ) : (
                        <th style={{ background: "#f1f9f2" }} className={CH} data-col-key="threads">
                          <div className="hideable-col-header">
                            Threads
                            <FBtn col="threads" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("threads");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                      {isHidden("sacks") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("sacks")}
                          title="Unhide Sacks"
                        />
                      ) : (
                        <th style={{ background: "#f1f9f2" }} className={CH} data-col-key="sacks">
                          <div className="hideable-col-header">
                            Sacks
                            <FBtn col="sacks" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("sacks");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                      {isHidden("markings") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("markings")}
                          title="Unhide Markings"
                        />
                      ) : (
                        <th style={{ background: "#f1f9f2" }} className={CH} data-col-key="markings">
                          <div className="hideable-col-header">
                            Markings
                            <FBtn col="markings" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("markings");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                      {isHidden("tags") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("tags")}
                          title="Unhide Tags"
                        />
                      ) : (
                        <th style={{ background: "#f1f9f2" }} className={CH} data-col-key="tags">
                          <div className="hideable-col-header">
                            Tags
                            <FBtn col="tags" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("tags");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                    </>
                  )}
                  {/* COMPLETION & TRACKING — 1 column */}
                  {isGroupHidden("completion_tracking") ? (
                    <th
                      className="col-hide-indicator"
                      style={indStyle}
                      onDoubleClick={() => showGroup("completion_tracking")}
                    />
                  ) : (
                    <>
                      {isHidden("history") ? (
                        <th
                          className="col-hide-indicator"
                          style={indStyle}
                          onClick={() => showCol("history")}
                          title="Unhide History"
                        />
                      ) : (
                        <th
                          style={{ background: "#ffffff" }}
                          className={cn(CH, "text-center")}
                          data-col-key="history"
                        >
                          <div className="hideable-col-header">
                            History
                            <FBtn col="history" />
                            <span
                              className="col-hide-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                hideCol("history");
                              }}
                            >
                              ◂
                            </span>
                          </div>
                        </th>
                      )}
                    </>
                  )}
                </tr>
              </thead>

              <Droppable
                droppableId="orders-table"
                isDropDisabled={!isDraggable}
              >
                {(droppableProvided) => (
                  <tbody
                    ref={droppableProvided.innerRef}
                    {...droppableProvided.droppableProps}
                  >
                    {orders.length === 0 ? (
                      <tr>
                        <td
                          colSpan={30}
                          className="h-32 text-center text-gray-400 py-8 text-sm"
                        >
                          {emptyMessage}
                        </td>
                      </tr>
                    ) : (
                      visibleOrders.map((order, index) => {
                        const tier = getReadinessTier(order);
                        const effVol = getEffectiveVolume(order);
                        const sugVol = getSuggestedVolume(order);
                        const batchSize = parseFloat(order.batch_size) || 4;
                        const batches =
                          batchSize > 0 ? Math.ceil(effVol / batchSize) : 0;
                        const bags = Math.round((effVol / 50) * 1000);
                        const isCompleted = order.status === "completed";
                        const isCancelled = order.status === "cancel_po";
                        const isCancelPO = order.status === "cancel_po";
                        const isChild = !!order.parent_id;
                        const isLead =
                          !order.parent_id &&
                          !!order.original_order_ids?.length;
                        const isOnHold = order.status === "hold";
                        // Merge Back eligibility: find the other cut portion by matching FPR + is_cut
                        const otherCutPortion = order.is_cut
                          ? allOrders.find(
                              (o) =>
                                o.is_cut &&
                                o.fpr === order.fpr &&
                                o.id !== order.id,
                            )
                          : null;
                        const canMergeBack = !!(
                          otherCutPortion &&
                          order.status !== "completed" &&
                          order.status !== "cancel_po" &&
                          otherCutPortion.status !== "completed" &&
                          otherCutPortion.status !== "cancel_po" &&
                          !order.parent_id &&
                          !otherCutPortion.parent_id
                        );
                        let mergeBackDisabledReason = "";
                        if (order.is_cut && otherCutPortion && !canMergeBack) {
                          if (otherCutPortion.status === "cancel_po") {
                            mergeBackDisabledReason =
                              "Related order is cancelled — restore it first to merge back";
                          } else if (otherCutPortion.status === "completed") {
                            mergeBackDisabledReason =
                              "Related order is done — restore it first to merge back";
                          } else if (otherCutPortion.parent_id) {
                            mergeBackDisabledReason =
                              "Related order is combined — uncombine first to merge back";
                          }
                        }
                        const canEditStart = isCancelled
                          ? false
                          : isChild
                            ? false
                            : isEditable(order, "start");
                        const canEditHaNotes = isCancelled
                          ? false
                          : isChild
                            ? false
                            : isEditable(order, "ha_notes");
                        const canEditEnd = isCancelled
                          ? false
                          : isChild
                            ? false
                            : isEditable(order, "end");
                        const canEditVolume = isCancelled
                          ? false
                          : isChild
                            ? false
                            : isEditable(order, "volume");
                        const canEditCompletion = isCancelled
                          ? false
                          : isChild
                            ? false
                            : isEditable(order, "completion");
                        const hasVolumeOverride =
                          order.volume_override != null &&
                          order.volume_override !== "";
                        const isVolNotMultiple =
                          hasVolumeOverride &&
                          batchSize > 0 &&
                          effVol % batchSize !== 0;

                        const nextOrder = visibleOrders[index + 1];
                        const isLastChild =
                          isChild &&
                          (!nextOrder ||
                            nextOrder.parent_id !== order.parent_id);

                        // Diversion state
                        const orderLine =
                          order.feedmill_line || order.line || "";
                        const shutdownLines = Object.entries(
                          feedmillStatus || {},
                        )
                          .filter(([, s]) => s && s.isShutdown)
                          .flatMap(([fm]) => FEEDMILL_SHUTDOWN_LINES[fm] || []);
                        const isOnShutdownLine =
                          shutdownLines.includes(orderLine);
                        const isDiverted = !!(
                          order.diversion_data &&
                          order.diversion_data.originalLine
                        );
                        const statusLower = (order.status || "").toLowerCase();
                        const isActiveOnShutdown =
                          isOnShutdownLine &&
                          !isDiverted &&
                          ![
                            "done",
                            "completed",
                            "cancel_po",
                            "cancelled",
                          ].includes(statusLower);
                        const isEligibleForDivert =
                          isActiveOnShutdown &&
                          hasAlternativeLines(order, shutdownLines, kbRecords);

                        let rowBg =
                          index % 2 === 0 ? "bg-white" : "bg-gray-50/50";
                        if (isCancelled && !isCancelledHistory)
                          rowBg = "bg-[#f5f5f5]";
                        else if (!suppressCombinedTint && isLead)
                          rowBg = "bg-[#d0e8fc]";
                        else if (isChild) rowBg = "bg-[#f0f4fa]";
                        if (isOnHold && !isLead && !isChild && !isCancelled)
                          rowBg = "bg-[#f5f5f5]";
                        if (
                          !isCancelled &&
                          !isLead &&
                          !isChild &&
                          !isOnHold &&
                          order.gap_overflow
                        )
                          rowBg = "bg-[#fff9c4]";
                        if (
                          !isCancelled &&
                          !isLead &&
                          !isChild &&
                          !isOnHold &&
                          order.scheduling_conflict
                        )
                          rowBg = "bg-[#ffebee]";
                        const holdAttr = isOnHold
                          ? isLead || isChild
                            ? "combined"
                            : "standalone"
                          : undefined;

                        const cellBase = `px-[10px] py-[8px] text-[13px] align-top border-b border-gray-100 text-left`;

                        const cellTriangle = (colKey, colLabel) => {
                          if (!commentPresence.has(`${order.id}:${colKey}`))
                            return null;
                          return (
                            <div
                              className="cell-comment-indicator"
                              title="Has comments — click to view"
                              onClick={(e) => {
                                e.stopPropagation();
                                setCommentPopover({
                                  x: e.clientX,
                                  y: e.clientY,
                                  order,
                                  colKey,
                                  colLabel: colLabel || colKey,
                                });
                              }}
                            />
                          );
                        };

                        return (
                          <Draggable
                            key={order.id}
                            draggableId={order.id}
                            index={index}
                            isDragDisabled={
                              !isDraggable ||
                              HARD_LOCKED_STATUSES.includes(order.status) ||
                              isChild
                            }
                          >
                            {(draggableProvided, snapshot) => (
                              <tr
                                ref={draggableProvided.innerRef}
                                {...draggableProvided.draggableProps}
                                data-order-id={order.id}
                                data-hold={holdAttr}
                                onMouseDown={(e) => {
                                  // If click originated from the grip cell, let it handle natively (avoid loop)
                                  if (e.target.closest?.(".drag-handle-cell")) return;
                                  const canDragRow = isDraggable && !isCompleted && !isCancelled && !isChild;
                                  if (!canDragRow) return;
                                  if (isOverText(e)) return;
                                  // Over empty area — dispatch a real mousedown on the grip cell so
                                  // the library's global capture listener picks it up correctly
                                  const gripEl = e.currentTarget.querySelector(".drag-handle-cell");
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
                                  if (e.target.closest?.(".drag-handle-cell")) return;
                                  const canDragRow = isDraggable && !isCompleted && !isCancelled && !isChild;
                                  if (!canDragRow) return;
                                  const gripEl = e.currentTarget.querySelector(".drag-handle-cell");
                                  if (gripEl) {
                                    e.preventDefault();
                                    gripEl.dispatchEvent(new TouchEvent("touchstart", {
                                      bubbles: true, cancelable: true, touches: e.touches,
                                    }));
                                  }
                                }}
                                onContextMenu={(e) =>
                                  handleContextMenu(e, order)
                                }
                                className={cn(
                                  "transition-colors",
                                  rowBg,
                                  isChild && "text-[#8094b4]",
                                  snapshot.isDragging &&
                                    "shadow-xl bg-white ring-2 ring-[#fd5108]/20",
                                  !snapshot.isDragging &&
                                    !isCompleted &&
                                    !isCancelled &&
                                    isDraggable &&
                                    "opacity-100",
                                  (isChild ||
                                    isCompleted ||
                                    isCancelled ||
                                    !isDraggable) &&
                                    "drag-disabled",
                                  isCancelled &&
                                    !isCancelledHistory &&
                                    "opacity-70",
                                )}
                                style={(() => {
                                  const isDropTarget =
                                    isDraggable &&
                                    dragState &&
                                    dragState.toIndex !== null &&
                                    dragState.toIndex === index &&
                                    !snapshot.isDragging;
                                  const indicatorColor = dragState?.valid
                                    ? "#43a047"
                                    : "#e53935";
                                  const hl = rowHighlights[order.id];
                                  return {
                                    ...draggableProvided.draggableProps.style,
                                    ...(snapshot.isDragging
                                      ? {
                                          opacity: 0.92,
                                          boxShadow:
                                            "0 8px 32px rgba(0,0,0,0.15)",
                                        }
                                      : isDropTarget
                                        ? {
                                            boxShadow: `inset 0 3px 0 ${indicatorColor}`,
                                            position: "relative",
                                            zIndex: 1,
                                          }
                                        : {}),
                                    ...(isChild && !hl
                                      ? { borderLeft: "3px solid #b8cce4" }
                                      : {}),
                                    ...(hl && !snapshot.isDragging
                                      ? {
                                          borderLeft: `3px solid ${HIGHLIGHT_BORDER[hl]}`,
                                          background: HIGHLIGHT_BG[hl],
                                        }
                                      : {}),
                                    ...(!hl &&
                                    isEligibleForDivert &&
                                    !snapshot.isDragging
                                      ? {
                                          borderLeft: "4px solid #eab308",
                                          background: "rgba(251,191,36,0.04)",
                                        }
                                      : {}),
                                    ...(!hl &&
                                    isDiverted &&
                                    !snapshot.isDragging
                                      ? {
                                          borderLeft: "3px solid #10b981",
                                          background: "rgba(16,185,129,0.04)",
                                        }
                                      : {}),
                                  };
                                })()}
                              >
                                {isDraggable && (() => {
                                  const canDragRow = !isCompleted && !isCancelled && !isChild;
                                  return (
                                    <td
                                      className={`${cellBase} px-1 drag-handle-cell`}
                                      {...(canDragRow ? draggableProvided.dragHandleProps : {})}
                                    >
                                      {canDragRow && (
                                        <GripVertical className="h-3 w-3 text-gray-300 hover:text-gray-500" />
                                      )}
                                      {isChild && (
                                        <div className="flex justify-center h-full">
                                          <div
                                            className={cn(
                                              "w-px bg-blue-300",
                                              isLastChild ? "h-3" : "h-full",
                                            )}
                                          />
                                        </div>
                                      )}
                                    </td>
                                  );
                                })()}

                                {/* Readiness — hideable */}
                                {isHidden("readiness") ? (
                                  <td
                                    className="col-hide-indicator"
                                    style={indStyle}
                                    onClick={() => showCol("readiness")}
                                    title="Unhide Readiness"
                                  />
                                ) : (
                                  <td
                                    className={cn(cellBase, "text-center px-1")}
                                    data-col-key="readiness"
                                    data-col-label="Readiness"
                                    style={{
                                      position: "relative",
                                      overflow: "visible",
                                    }}
                                  >
                                    {cellTriangle("readiness", "Readiness")}
                                    <ReadinessIcon tier={tier} order={order} />
                                  </td>
                                )}

                                {/* Prio — hideable */}
                                {isHidden("prio") ? (
                                  <td
                                    className="col-hide-indicator"
                                    style={indStyle}
                                    onClick={() => showCol("prio")}
                                    title="Unhide Prio"
                                  />
                                ) : (
                                  <td
                                    className={cn(
                                      cellBase,
                                      "text-gray-400 text-center",
                                    )}
                                    data-col-key="prio"
                                    data-col-label="Prio"
                                    style={{
                                      position: "relative",
                                      overflow: "visible",
                                    }}
                                  >
                                    {cellTriangle("prio", "Prio")}
                                    {isCompleted || isCancelled
                                      ? ""
                                      : activeRankMap.get(order.id) || ""}
                                  </td>
                                )}

                                {/* FPR — hideable */}
                                {isHidden("fpr") ? (
                                  <td
                                    className="col-hide-indicator"
                                    style={indStyle}
                                    onClick={() => showCol("fpr")}
                                    title="Unhide FPR"
                                  />
                                ) : (
                                  <td
                                    className={`${cellBase} font-semibold text-gray-900`}
                                    data-col-key="fpr"
                                    data-col-label="FPR"
                                    style={{
                                      position: "relative",
                                      overflow: "visible",
                                    }}
                                  >
                                    {cellTriangle("fpr", "FPR")}
                                    <div className="flex flex-wrap items-center gap-1">
                                      {order.fpr || "-"}
                                      {isLead && (
                                        <span className="text-[10px] bg-blue-200 text-blue-800 px-1 rounded">
                                          Lead
                                        </span>
                                      )}
                                      {isChild && (
                                        <span className="text-[10px] bg-blue-100 text-blue-600 px-1 rounded">
                                          {readOnly ? "Sub" : "Child"}
                                        </span>
                                      )}
                                      {order.is_cut && (
                                        <span className="text-[10px] bg-[#fef2f2] text-[#e53935] border border-[#fecaca] px-1 rounded font-medium">
                                          Cut
                                        </span>
                                      )}
                                      {newBadgeFprs.has(order.fpr) && (
                                        <span
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            clearNewBadge(order.fpr);
                                          }}
                                          className="text-[10px] bg-[#dcfce7] text-[#166534] px-[6px] py-[2px] rounded cursor-pointer select-none"
                                          title="New upload — click to dismiss"
                                        >
                                          NEW
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                )}

                                {/* ORDER DETAILS — 5 columns */}
                                {isGroupHidden("order_details") ? (
                                  <td
                                    className="col-hide-indicator"
                                    style={indStyle}
                                    onDoubleClick={() =>
                                      showGroup("order_details")
                                    }
                                    title="Double-click to show Order Details"
                                  />
                                ) : (
                                  <>
                                    {/* Planned Order */}
                                    {isHidden("planned_order") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("planned_order")}
                                        title="Unhide Planned Order"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="planned_order"
                                        data-col-label="Planned Order"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle(
                                          "planned_order",
                                          "Planned Order",
                                        )}
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <div>
                                              <p className="text-[13px] text-gray-900">
                                                {order.fg || "-"}
                                              </p>
                                              <p className="text-[13px] text-gray-900 mt-0.5">
                                                {order.sfg || "-"}
                                              </p>
                                              {isPMX && (
                                                <p className="text-[13px] text-gray-900 mt-0.5">
                                                  {order.pmx || "-"}
                                                </p>
                                              )}
                                            </div>
                                          </TooltipTrigger>
                                          <TooltipContent
                                            side="top"
                                            className="text-xs"
                                          >
                                            <p>FG: {order.fg || "-"}</p>
                                            <p>SFG: {order.sfg || "-"}</p>
                                            {isPMX && (
                                              <p>PMX: {order.pmx || "-"}</p>
                                            )}
                                          </TooltipContent>
                                        </Tooltip>
                                      </td>
                                    )}

                                    {/* Production Order */}
                                    {isHidden("prod_order") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("prod_order")}
                                        title="Unhide Production Order"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="prod_order"
                                        data-col-label="Production Order"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle(
                                          "prod_order",
                                          "Production Order",
                                        )}
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <div>
                                              {canEditHaNotes ? (
                                                <div className="space-y-0.5">
                                                  <div className="group">
                                                    <Input
                                                      type="text"
                                                      defaultValue={
                                                        order.fg1 || ""
                                                      }
                                                      onChange={(e) =>
                                                        debouncedUpdate(
                                                          order.id,
                                                          "fg1",
                                                          e.target.value,
                                                        )
                                                      }
                                                      onBlur={(e) => {
                                                        clearTimeout(
                                                          debounceTimers
                                                            .current[
                                                            `${order.id}-fg1`
                                                          ],
                                                        );
                                                        onUpdateOrder(
                                                          order.id,
                                                          {
                                                            fg1: e.target.value,
                                                          },
                                                        );
                                                      }}
                                                      placeholder="Enter FG1"
                                                      className={cn(
                                                        editableInputClass,
                                                        "w-24 text-[13px] text-gray-900 placeholder:text-gray-300",
                                                      )}
                                                      data-testid={`input-fg1-${order.id}`}
                                                    />
                                                  </div>
                                                  <div className="group">
                                                    <Input
                                                      type="text"
                                                      defaultValue={
                                                        order.sfg1 || ""
                                                      }
                                                      onChange={(e) =>
                                                        debouncedUpdate(
                                                          order.id,
                                                          "sfg1",
                                                          e.target.value,
                                                        )
                                                      }
                                                      onBlur={(e) => {
                                                        clearTimeout(
                                                          debounceTimers
                                                            .current[
                                                            `${order.id}-sfg1`
                                                          ],
                                                        );
                                                        onUpdateOrder(
                                                          order.id,
                                                          {
                                                            sfg1: e.target
                                                              .value,
                                                          },
                                                        );
                                                      }}
                                                      placeholder="Enter SFG1"
                                                      className={cn(
                                                        editableInputClass,
                                                        "w-24 text-[13px] text-gray-900 placeholder:text-gray-300",
                                                      )}
                                                      data-testid={`input-sfg1-${order.id}`}
                                                    />
                                                  </div>
                                                  {isPMX && (
                                                    <div className="group">
                                                      <Input
                                                        type="text"
                                                        defaultValue={
                                                          order.sfgpmx || ""
                                                        }
                                                        onChange={(e) =>
                                                          debouncedUpdate(
                                                            order.id,
                                                            "sfgpmx",
                                                            e.target.value,
                                                          )
                                                        }
                                                        onBlur={(e) => {
                                                          clearTimeout(
                                                            debounceTimers
                                                              .current[
                                                              `${order.id}-sfgpmx`
                                                            ],
                                                          );
                                                          onUpdateOrder(
                                                            order.id,
                                                            {
                                                              sfgpmx:
                                                                e.target.value,
                                                            },
                                                          );
                                                        }}
                                                        placeholder="Enter SFGPMX"
                                                        className={cn(
                                                          editableInputClass,
                                                          "w-24 text-[13px] text-gray-900 placeholder:text-gray-300",
                                                        )}
                                                        data-testid={`input-sfgpmx-${order.id}`}
                                                      />
                                                    </div>
                                                  )}
                                                </div>
                                              ) : (
                                                <div>
                                                  <p className="text-[13px] text-gray-900">
                                                    {order.fg1 || "-"}
                                                  </p>
                                                  <p className="text-[13px] text-gray-900 mt-0.5">
                                                    {order.sfg1 || "-"}
                                                  </p>
                                                  {isPMX && (
                                                    <p className="text-[13px] text-gray-900 mt-0.5">
                                                      {order.sfgpmx || "-"}
                                                    </p>
                                                  )}
                                                </div>
                                              )}
                                            </div>
                                          </TooltipTrigger>
                                          <TooltipContent
                                            side="top"
                                            className="text-xs"
                                          >
                                            <p>FG1: {order.fg1 || "-"}</p>
                                            <p>SFG1: {order.sfg1 || "-"}</p>
                                            {isPMX && (
                                              <p>
                                                SFGPMX: {order.sfgpmx || "-"}
                                              </p>
                                            )}
                                          </TooltipContent>
                                        </Tooltip>
                                      </td>
                                    )}

                                    {/* Material Code (SFG) */}
                                    {isHidden("mat_code_sfg") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("mat_code_sfg")}
                                        title="Unhide Material Code (SFG)"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="mat_code_sfg"
                                        data-col-label="Material Code (SFG)"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle(
                                          "mat_code_sfg",
                                          "Material Code (SFG)",
                                        )}
                                        <span className="text-[13px] text-gray-600">
                                          {order.kb_sfg_material_code || "—"}
                                        </span>
                                      </td>
                                    )}

                                    {/* Material Code (FG) */}
                                    {isHidden("mat_code_fg") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("mat_code_fg")}
                                        title="Unhide Material Code (FG)"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="mat_code_fg"
                                        data-col-label="Material Code (FG)"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle(
                                          "mat_code_fg",
                                          "Material Code (FG)",
                                        )}
                                        <span className="text-[13px] text-gray-700 font-medium">
                                          {order.material_code || "-"}
                                        </span>
                                      </td>
                                    )}

                                    {/* Item Description */}
                                    {isHidden("item_desc") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("item_desc")}
                                        title="Unhide Item Description"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="item_desc"
                                        data-col-label="Item Description"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle(
                                          "item_desc",
                                          "Item Description",
                                        )}
                                        <p
                                          className={cn(
                                            "font-medium text-[13px] line-clamp-2 leading-tight",
                                            isCancelled && !isCancelledHistory
                                              ? "text-[#c0c7d0]"
                                              : isChild
                                                ? "text-[#6b83a8]"
                                                : "text-gray-900",
                                          )}
                                        >
                                          <span>{order.item_description}</span>
                                          {isLead && (
                                            <button
                                              className="combine-toggle-arrow inline-flex items-center ml-2 align-middle"
                                              style={{
                                                fontSize: 10,
                                                color: "#6b7280",
                                                cursor: "pointer",
                                                userSelect: "none",
                                                background: "none",
                                                border: "none",
                                                padding: 0,
                                                lineHeight: 1,
                                              }}
                                              onMouseEnter={(e) =>
                                                (e.currentTarget.style.color =
                                                  "#1a1a1a")
                                              }
                                              onMouseLeave={(e) =>
                                                (e.currentTarget.style.color =
                                                  "#6b7280")
                                              }
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setExpandedLeads((prev) => {
                                                  const next = new Set(prev);
                                                  if (next.has(order.id))
                                                    next.delete(order.id);
                                                  else next.add(order.id);
                                                  return next;
                                                });
                                              }}
                                              title={
                                                expandedLeads.has(order.id)
                                                  ? "Collapse children"
                                                  : "Expand children"
                                              }
                                            >
                                              {expandedLeads.has(order.id)
                                                ? "▼"
                                                : "▶"}
                                            </button>
                                          )}
                                        </p>
                                        <p
                                          className={cn(
                                            "text-[12px] mt-0.5",
                                            isCancelled && !isCancelledHistory
                                              ? "text-[#c0c7d0]"
                                              : isChild
                                                ? "text-[#9fb3cc]"
                                                : "text-[#6b7280]",
                                          )}
                                        >
                                          {toTitleCase(order.category)}
                                        </p>
                                        {isDiverted && order.diversion_data && (
                                          <p
                                            style={{
                                              fontSize: "10px",
                                              color: "#059669",
                                              marginTop: "3px",
                                              fontWeight: 500,
                                            }}
                                          >
                                            ↗ Diverted:{" "}
                                            {order.diversion_data.originalLine}{" "}
                                            →{" "}
                                            {order.diversion_data.currentLine ||
                                              orderLine}
                                          </p>
                                        )}
                                        {isEligibleForDivert && (
                                          <p
                                            style={{
                                              fontSize: "10px",
                                              color: "#b45309",
                                              marginTop: "2px",
                                              fontWeight: 400,
                                            }}
                                          >
                                            ⚠ Line shutdown — right-click to
                                            divert
                                          </p>
                                        )}
                                      </td>
                                    )}
                                  </>
                                )}

                                {/* PRODUCTION PARAMETERS — 6 columns */}
                                {isGroupHidden("production_parameters") ? (
                                  <td
                                    className="col-hide-indicator"
                                    style={indStyle}
                                    onDoubleClick={() =>
                                      showGroup("production_parameters")
                                    }
                                    title="Double-click to show Production Parameters"
                                  />
                                ) : (
                                  <>
                                    {/* Form */}
                                    {isHidden("form") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("form")}
                                        title="Unhide Form"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="form"
                                        data-col-label="Form"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle("form", "Form")}
                                        <span className="text-[13px] text-gray-700 font-medium">
                                          {order.form || "—"}
                                        </span>
                                      </td>
                                    )}

                                    {/* Volume */}
                                    {isHidden("volume") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("volume")}
                                        title="Unhide Volume (MT)"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="volume"
                                        data-col-label="Volume (MT)"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle("volume", "Volume (MT)")}
                                        <VolumeCell
                                          order={order}
                                          sugVol={sugVol}
                                          effVol={effVol}
                                          batchSize={batchSize}
                                          hasOverride={hasVolumeOverride}
                                          isNotMultiple={isVolNotMultiple}
                                          canEdit={canEditVolume}
                                          onUpdate={onUpdateOrder}
                                          allOrders={allOrders}
                                        />
                                      </td>
                                    )}

                                    {/* Batch Size */}
                                    {isHidden("batch_size") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("batch_size")}
                                        title="Unhide Batch Size"
                                      />
                                    ) : (
                                      <td
                                        className={cn(cellBase, "text-center")}
                                        data-col-key="batch_size"
                                        data-col-label="Batch Size"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                          textAlign: "center",
                                        }}
                                      >
                                        {cellTriangle(
                                          "batch_size",
                                          "Batch Size",
                                        )}
                                        <span className="text-[13px] text-gray-700">
                                          {order.batch_size
                                            ? fmtBatchSize(order.batch_size)
                                            : "—"}
                                        </span>
                                      </td>
                                    )}

                                    {/* Batches */}
                                    {isHidden("num_batches") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("num_batches")}
                                        title="Unhide Batches"
                                      />
                                    ) : (
                                      <td
                                        className={cn(cellBase, "text-center")}
                                        data-col-key="num_batches"
                                        data-col-label="Batches"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                          textAlign: "center",
                                        }}
                                      >
                                        {cellTriangle("num_batches", "Batches")}
                                        <span className="text-[13px] text-gray-700">
                                          {fmtBatches(batches)}
                                        </span>
                                      </td>
                                    )}

                                    {/* Bags */}
                                    {isHidden("num_bags") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("num_bags")}
                                        title="Unhide Bags"
                                      />
                                    ) : (
                                      <td
                                        className={cn(cellBase, "text-center")}
                                        data-col-key="num_bags"
                                        data-col-label="Bags"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                          textAlign: "center",
                                        }}
                                      >
                                        {cellTriangle("num_bags", "Bags")}
                                        <span className="text-[13px] text-gray-700">
                                          {fmtBags(bags).toLocaleString()}
                                        </span>
                                      </td>
                                    )}

                                    {/* Prod Time */}
                                    {isHidden("prod_time") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("prod_time")}
                                        title="Unhide Prod. Time"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="prod_time"
                                        data-col-label="Production Time"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle(
                                          "prod_time",
                                          "Production Time",
                                        )}
                                        <p className="text-[13px] font-bold text-gray-900">
                                          {order.production_hours != null
                                            ? `${fmtHours(order.production_hours)} hrs`
                                            : order.form === "M"
                                              ? "—"
                                              : "-"}
                                        </p>
                                        <p className="text-[12px] text-[#6b7280]">
                                          CO:{" "}
                                          {fmtChangeover(order.changeover_time)}{" "}
                                          | Rate:{" "}
                                          {order.run_rate != null
                                            ? fmtRunRate(order.run_rate)
                                            : "-"}
                                        </p>
                                      </td>
                                    )}
                                  </>
                                )}

                                {/* MIXER DETAILS — 2 columns */}
                                {isGroupHidden("mixer_details") ? (
                                  <td
                                    className="col-hide-indicator"
                                    style={indStyle}
                                    onDoubleClick={() =>
                                      showGroup("mixer_details")
                                    }
                                    title="Double-click to show Mixer Details"
                                  />
                                ) : (
                                  <>
                                    {/* HA Info — hideable */}
                                    {isHidden("ha_info") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("ha_info")}
                                        title="Unhide HA Info"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="ha_info"
                                        data-col-label="HA Info"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle("ha_info", "HA Info")}
                                        {canEditHaNotes ? (
                                          <div className="space-y-1">
                                            <div className="flex items-center gap-1">
                                              <span className="text-[13px] text-gray-400 shrink-0">
                                                HA:
                                              </span>
                                              <Tooltip>
                                                <TooltipTrigger asChild>
                                                  <span
                                                    className="text-[13px] text-gray-700 font-bold cursor-default"
                                                    data-testid={`display-ha-${order.id}`}
                                                  >
                                                    {batches > 0
                                                      ? batches
                                                      : "—"}
                                                  </span>
                                                </TooltipTrigger>
                                                <TooltipContent
                                                  side="top"
                                                  className="text-xs"
                                                >
                                                  Auto-calculated from Number of
                                                  Batches
                                                </TooltipContent>
                                              </Tooltip>
                                            </div>
                                            <div className="group flex items-center gap-1">
                                              <span className="text-[12px] text-[#6b7280] shrink-0">
                                                SCADA:
                                              </span>
                                              <Input
                                                type="text"
                                                defaultValue={
                                                  order.formula_version || ""
                                                }
                                                onChange={(e) =>
                                                  debouncedUpdate(
                                                    order.id,
                                                    "formula_version",
                                                    e.target.value,
                                                  )
                                                }
                                                onBlur={(e) => {
                                                  clearTimeout(
                                                    debounceTimers.current[
                                                      `${order.id}-formula_version`
                                                    ],
                                                  );
                                                  onUpdateOrder(order.id, {
                                                    formula_version:
                                                      e.target.value,
                                                  });
                                                }}
                                                placeholder="-"
                                                className={cn(
                                                  line2InputClass,
                                                  "w-14 text-gray-700",
                                                )}
                                                data-testid={`input-scada-${order.id}`}
                                              />
                                              <span className="text-[12px] text-[#6b7280] shrink-0">
                                                PV:
                                              </span>
                                              <Input
                                                type="text"
                                                defaultValue={
                                                  order.prod_version || ""
                                                }
                                                onChange={(e) =>
                                                  debouncedUpdate(
                                                    order.id,
                                                    "prod_version",
                                                    e.target.value,
                                                  )
                                                }
                                                onBlur={(e) => {
                                                  clearTimeout(
                                                    debounceTimers.current[
                                                      `${order.id}-prod_version`
                                                    ],
                                                  );
                                                  onUpdateOrder(order.id, {
                                                    prod_version:
                                                      e.target.value,
                                                  });
                                                }}
                                                placeholder="-"
                                                className={cn(
                                                  line2InputClass,
                                                  "w-12 text-gray-700",
                                                )}
                                                data-testid={`input-pv-${order.id}`}
                                              />
                                            </div>
                                          </div>
                                        ) : (
                                          <div>
                                            <div className="flex items-center gap-1">
                                              <span className="text-[13px] text-gray-400 shrink-0">
                                                HA:
                                              </span>
                                              <Tooltip>
                                                <TooltipTrigger asChild>
                                                  <span
                                                    className="text-[13px] text-gray-700 font-bold cursor-default"
                                                    data-testid={`display-ha-readonly-${order.id}`}
                                                  >
                                                    {batches > 0
                                                      ? batches
                                                      : "—"}
                                                  </span>
                                                </TooltipTrigger>
                                                <TooltipContent
                                                  side="top"
                                                  className="text-xs"
                                                >
                                                  Auto-calculated from Number of
                                                  Batches
                                                </TooltipContent>
                                              </Tooltip>
                                            </div>
                                            <p className="text-[12px] text-[#6b7280]">
                                              SCADA:{" "}
                                              {order.formula_version || "-"} |
                                              PV: {order.prod_version || "-"}
                                            </p>
                                          </div>
                                        )}
                                      </td>
                                    )}

                                    {/* HA Prep — hideable */}
                                    {isHidden("ha_prep") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("ha_prep")}
                                        title="Unhide HA Prep"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="ha_prep"
                                        data-col-label="HA Prep"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle("ha_prep", "HA Prep")}
                                        {canEditHaNotes ? (
                                          <select
                                            value={
                                              order.ha_prep_form_issuance || ""
                                            }
                                            onChange={(e) =>
                                              onUpdateOrder(order.id, {
                                                ha_prep_form_issuance:
                                                  e.target.value,
                                              })
                                            }
                                            className="text-[13px] bg-transparent border-0 border-b border-transparent hover:border-gray-300 focus:border-[#fd5108] outline-none p-0 h-6 w-full transition-colors"
                                            data-testid={`select-ha-prep-${order.id}`}
                                          >
                                            {haFormOptions.map((opt) => (
                                              <option
                                                key={opt || "empty"}
                                                value={opt}
                                              >
                                                {opt || "-"}
                                              </option>
                                            ))}
                                          </select>
                                        ) : (
                                          <span className="text-[13px] text-gray-700">
                                            {order.ha_prep_form_issuance || "-"}
                                          </span>
                                        )}
                                      </td>
                                    )}
                                  </>
                                )}

                                {/* Status — hideable */}
                                {isHidden("status") ? (
                                  <td
                                    className="col-hide-indicator"
                                    style={indStyle}
                                    onClick={() => showCol("status")}
                                    title="Unhide Status"
                                  />
                                ) : (
                                  <td
                                    className={cellBase}
                                    data-col-key="status"
                                    data-col-label="Status"
                                    style={{
                                      position: "relative",
                                      overflow: "visible",
                                    }}
                                  >
                                    {cellTriangle("status", "Status")}
                                    {isChild ? (
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <div className="inline-flex items-center gap-1 opacity-80 cursor-default">
                                            <StatusBadge
                                              status={order.status || "plotted"}
                                            />
                                            <Lock className="h-2.5 w-2.5 text-blue-400 shrink-0" />
                                          </div>
                                        </TooltipTrigger>
                                        <TooltipContent
                                          side="top"
                                          className="text-xs max-w-xs"
                                        >
                                          Status controlled by lead order (FPR:{" "}
                                          {allOrders.find(
                                            (o) => o.id === order.parent_id,
                                          )?.fpr ||
                                            order.parent_id?.slice(0, 8) ||
                                            "—"}
                                          )
                                        </TooltipContent>
                                      </Tooltip>
                                    ) : (
                                      <StatusDropdown
                                        value={order.status || "plotted"}
                                        onChange={(newStatus) => {
                                          const PROD_STATUSES = [
                                            "in_production",
                                            "ongoing_batching",
                                            "ongoing_pelleting",
                                            "ongoing_bagging",
                                          ];
                                          if (
                                            PROD_STATUSES.includes(newStatus) &&
                                            tier < 3
                                          ) {
                                            setReadinessWarnDialog({
                                              order,
                                              newStatus,
                                            });
                                            return;
                                          }
                                          onStatusChange &&
                                            onStatusChange(order, newStatus);
                                        }}
                                        disabled={readOnly}
                                        onCancelRequest={() =>
                                          onCancelRequest &&
                                          onCancelRequest(order)
                                        }
                                        onRestoreRequest={(newStatus) =>
                                          onRestoreRequest &&
                                          onRestoreRequest(order, newStatus)
                                        }
                                        isLeadCombined={isLead}
                                        onUncombineRequest={() =>
                                          onUncombineRequest &&
                                          onUncombineRequest(order)
                                        }
                                        isCutOrder={!!order.is_cut}
                                        onCutRequest={() =>
                                          onCutRequest && onCutRequest(order)
                                        }
                                        canMergeBack={canMergeBack}
                                        mergeBackDisabledReason={
                                          mergeBackDisabledReason
                                        }
                                        onMergeBackRequest={() =>
                                          onMergeBackRequest &&
                                          onMergeBackRequest(order)
                                        }
                                      />
                                    )}
                                  </td>
                                )}

                                {/* SCHEDULING — 3 columns */}
                                {isGroupHidden("scheduling") ? (
                                  <td
                                    className="col-hide-indicator"
                                    style={indStyle}
                                    onDoubleClick={() =>
                                      showGroup("scheduling")
                                    }
                                    title="Double-click to show Scheduling"
                                  />
                                ) : (
                                  <>
                                    {/* Start Date — hideable */}
                                    {isHidden("start_date") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("start_date")}
                                        title="Unhide Start Date"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="start_date"
                                        data-col-label="Start Date"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle(
                                          "start_date",
                                          "Start Date",
                                        )}
                                        {canEditStart ? (
                                          <StartDateCell
                                            order={order}
                                            onUpdate={onUpdateOrder}
                                          />
                                        ) : (
                                          <span className="text-[13px] text-gray-700">
                                            {formatLongDate(order.start_date) ||
                                              "-"}
                                          </span>
                                        )}
                                      </td>
                                    )}

                                    {/* Start Time — hideable */}
                                    {isHidden("start_time") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("start_time")}
                                        title="Unhide Start Time"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="start_time"
                                        data-col-label="Start Time"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle(
                                          "start_time",
                                          "Start Time",
                                        )}
                                        {canEditStart ? (
                                          <StartTimeEditor
                                            order={order}
                                            onUpdate={onUpdateOrder}
                                          />
                                        ) : (
                                          <span className="text-[13px] text-gray-700">
                                            {formatTime12(order.start_time) ||
                                              "-"}
                                          </span>
                                        )}
                                      </td>
                                    )}

                                    {/* Avail Date — hideable */}
                                    {isHidden("avail_date") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("avail_date")}
                                        title="Unhide Avail Date"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="avail_date"
                                        data-col-label="Avail Date"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle(
                                          "avail_date",
                                          "Avail Date",
                                        )}
                                        <AvailDateCell
                                          order={order}
                                          canEdit={canEditStart}
                                          onUpdate={onUpdateOrder}
                                          inferredInfo={
                                            inferredTargetMap[
                                              order.material_code
                                            ] || null
                                          }
                                        />
                                      </td>
                                    )}

                                    {/* Completion Date — hideable */}
                                    {isHidden("completion_date") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() =>
                                          showCol("completion_date")
                                        }
                                        title="Unhide Estimated Completion Date"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="completion_date"
                                        data-col-label="Estimated Completion Date"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle(
                                          "completion_date",
                                          "Estimated Completion Date",
                                        )}
                                        <div className="flex items-start gap-1">
                                          <div className="flex-1">
                                            <CompletionDateCell
                                              order={order}
                                              canEdit={canEditCompletion}
                                              onUpdate={onUpdateOrder}
                                            />
                                          </div>
                                          {order.scheduling_conflict && (
                                            <Tooltip>
                                              <TooltipTrigger asChild>
                                                <span className="text-red-500 shrink-0 mt-0.5 cursor-help">
                                                  ⚠
                                                </span>
                                              </TooltipTrigger>
                                              <TooltipContent
                                                side="top"
                                                className="text-xs max-w-xs bg-[#2e343a] text-white border-[#2e343a]"
                                              >
                                                Completion exceeds Avail Date.
                                                Resolve by reordering, using
                                                Auto-Sequence, or removing gap
                                                fillers.
                                              </TooltipContent>
                                            </Tooltip>
                                          )}
                                          {!order.scheduling_conflict &&
                                            order.gap_overflow && (
                                              <Tooltip>
                                                <TooltipTrigger asChild>
                                                  <span className="text-yellow-600 shrink-0 mt-0.5 cursor-help">
                                                    ⚠
                                                  </span>
                                                </TooltipTrigger>
                                                <TooltipContent
                                                  side="top"
                                                  className="text-xs max-w-xs bg-[#2e343a] text-white border-[#2e343a]"
                                                >
                                                  This order may not fit in the
                                                  available gap. Completion
                                                  overlaps with the next dated
                                                  order's required start time.
                                                </TooltipContent>
                                              </Tooltip>
                                            )}
                                        </div>
                                      </td>
                                    )}

                                    {/* End Date — hideable */}
                                    {isHidden("end_date") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("end_date")}
                                        title="Unhide End Date"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="end_date"
                                        data-col-label="End Date"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle("end_date", "End Date")}
                                        <EndDateCell
                                          order={order}
                                          canEditDirect={canEditEnd}
                                          onUpdate={onUpdateOrder}
                                        />
                                      </td>
                                    )}
                                  </>
                                )}

                                {/* PRODUCT INSIGHTS — 1 column (Summary) */}
                                {isGroupHidden("ai") ? (
                                  <td
                                    className="col-hide-indicator"
                                    style={indStyle}
                                    onDoubleClick={() => showGroup("ai")}
                                    title="Double-click to show Product Insights"
                                  />
                                ) : (
                                  <>
                                    {isHidden("smart_insight") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("smart_insight")}
                                        title="Unhide Summary"
                                      />
                                    ) : (
                                      <SmartInsightCell order={order} />
                                    )}
                                  </>
                                )}

                                {/* NOTES — 2 columns */}
                                {isGroupHidden("notes") ? (
                                  <td
                                    className="col-hide-indicator"
                                    style={indStyle}
                                    onDoubleClick={() => showGroup("notes")}
                                    title="Double-click to show Notes"
                                  />
                                ) : (
                                  <>
                                    {/* FPR Notes — hideable */}
                                    {isHidden("fpr_notes") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("fpr_notes")}
                                        title="Unhide FPR Notes"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="fpr_notes"
                                        data-col-label="FPR Notes"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle("fpr_notes", "FPR Notes")}
                                        <RemarksCell
                                          value={order.prod_remarks}
                                          readOnly={
                                            !(canEditHaNotes || isChild)
                                          }
                                          onSave={(val) =>
                                            onUpdateOrder(order.id, {
                                              prod_remarks: val,
                                            })
                                          }
                                          placeholder="Add note..."
                                          cancelNote={order.cancel_note}
                                        />
                                      </td>
                                    )}

                                    {/* Special Remarks — hideable */}
                                    {isHidden("special_remarks") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() =>
                                          showCol("special_remarks")
                                        }
                                        title="Unhide Special Remarks"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="special_remarks"
                                        data-col-label="Special Remarks"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle(
                                          "special_remarks",
                                          "Special Remarks",
                                        )}
                                        <RemarksCell
                                          value={order.special_remarks}
                                          readOnly={!canEditHaNotes}
                                          onSave={(val) =>
                                            onUpdateOrder(order.id, {
                                              special_remarks: val,
                                            })
                                          }
                                          placeholder="Add remark..."
                                        />
                                      </td>
                                    )}
                                  </>
                                )}

                                {/* BAGGER DETAILS — 4 columns */}
                                {isGroupHidden("bagger_details") ? (
                                  <td
                                    className="col-hide-indicator"
                                    style={indStyle}
                                    onDoubleClick={() =>
                                      showGroup("bagger_details")
                                    }
                                    title="Double-click to show Bagger Details"
                                  />
                                ) : (
                                  <>
                                    {/* Threads — hideable */}
                                    {isHidden("threads") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("threads")}
                                        title="Unhide Threads"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="threads"
                                        data-col-label="Threads"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle("threads", "Threads")}
                                        <span className="text-[13px] text-gray-700">
                                          {order.threads || "-"}
                                        </span>
                                      </td>
                                    )}

                                    {/* Sacks — hideable */}
                                    {isHidden("sacks") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("sacks")}
                                        title="Unhide Sacks"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="sacks"
                                        data-col-label="Sacks"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle("sacks", "Sacks")}
                                        <RemarksCell
                                          value={order.sacks || ""}
                                          readOnly={true}
                                          placeholder="-"
                                        />
                                      </td>
                                    )}

                                    {/* Markings — hideable */}
                                    {isHidden("markings") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("markings")}
                                        title="Unhide Markings"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="markings"
                                        data-col-label="Markings"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle("markings", "Markings")}
                                        <span className="text-[13px] text-gray-700">
                                          {order.markings || "-"}
                                        </span>
                                      </td>
                                    )}

                                    {/* Tags — hideable */}
                                    {isHidden("tags") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("tags")}
                                        title="Unhide Tags"
                                      />
                                    ) : (
                                      <td
                                        className={cellBase}
                                        data-col-key="tags"
                                        data-col-label="Tags"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle("tags", "Tags")}
                                        <RemarksCell
                                          value={order.tags || ""}
                                          readOnly={true}
                                          placeholder="-"
                                        />
                                      </td>
                                    )}
                                  </>
                                )}

                                {/* COMPLETION & TRACKING — 1 column */}
                                {isGroupHidden("completion_tracking") ? (
                                  <td
                                    className="col-hide-indicator"
                                    style={indStyle}
                                    onDoubleClick={() =>
                                      showGroup("completion_tracking")
                                    }
                                    title="Double-click to show Tracking"
                                  />
                                ) : (
                                  <>
                                    {/* History — hideable */}
                                    {isHidden("history") ? (
                                      <td
                                        className="col-hide-indicator"
                                        style={indStyle}
                                        onClick={() => showCol("history")}
                                        title="Unhide History"
                                      />
                                    ) : (
                                      <td
                                        className={cn(cellBase, "text-center")}
                                        data-col-key="history"
                                        data-col-label="History"
                                        style={{
                                          position: "relative",
                                          overflow: "visible",
                                        }}
                                      >
                                        {cellTriangle("history", "History")}
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="h-7 w-7 mx-auto"
                                          onClick={() => setHistoryOrder(order)}
                                          title="View Order History"
                                          data-testid={`button-history-${order.id}`}
                                        >
                                          <History className="h-4 w-4 text-gray-500" />
                                        </Button>
                                      </td>
                                    )}
                                  </>
                                )}
                              </tr>
                            )}
                          </Draggable>
                        );
                      })
                    )}
                    {droppableProvided.placeholder}
                  </tbody>
                )}
              </Droppable>
            </table>
          </div>
        </div>
      </DragDropContext>

      {/* Right-click context menu */}
      {contextMenu &&
        (() => {
          const cmOrder = contextMenu.order;
          const cmLine = cmOrder.feedmill_line || cmOrder.line || "";
          const cmShutdownLines = Object.entries(feedmillStatus || {})
            .filter(([, s]) => s && s.isShutdown)
            .flatMap(([fm]) => FEEDMILL_SHUTDOWN_LINES[fm] || []);
          const cmIsShutdown = cmShutdownLines.includes(cmLine);
          const cmIsDiverted = !!(
            cmOrder.diversion_data && cmOrder.diversion_data.originalLine
          );
          const cmStatus = (cmOrder.status || "").toLowerCase();
          const cmActiveOnShutdown =
            cmIsShutdown &&
            !cmIsDiverted &&
            !["done", "completed", "cancel_po", "cancelled"].includes(cmStatus);
          const cmEligibleDivert =
            cmActiveOnShutdown &&
            hasAlternativeLines(cmOrder, cmShutdownLines, kbRecords);
          return (
            <OrderContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              order={cmOrder}
              columnLabel={contextMenu.colLabel}
              currentHighlight={rowHighlights[cmOrder.id] ?? null}
              onHighlight={(color) => handleHighlight(cmOrder.id, color)}
              onComment={() =>
                setCommentPopover({
                  x: contextMenu.x,
                  y: contextMenu.y + 10,
                  order: cmOrder,
                  colKey: contextMenu.colKey,
                  colLabel: contextMenu.colLabel,
                })
              }
              onViewHistory={() => setHistoryOrder(cmOrder)}
              isDivertable={cmEligibleDivert}
              isReverted={cmIsDiverted}
              onDivert={() => onDivertOrder && onDivertOrder(cmOrder)}
              onRevert={() => onRevertOrder && onRevertOrder(cmOrder)}
              onClose={() => setContextMenu(null)}
            />
          );
        })()}

      {/* Cell comment popover */}
      {commentPopover && (
        <CellCommentPopover
          x={commentPopover.x}
          y={commentPopover.y}
          order={commentPopover.order}
          columnName={commentPopover.colKey}
          columnLabel={commentPopover.colLabel}
          onClose={() => setCommentPopover(null)}
          onPresenceChange={(orderId, colKey, hasComments) => {
            setCommentPresence((prev) => {
              const next = new Set(prev);
              const key = `${orderId}:${colKey}`;
              if (hasComments) next.add(key);
              else next.delete(key);
              return next;
            });
          }}
        />
      )}

      {/* Readiness Warning Dialog */}
      {readinessWarnDialog && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <ReadinessWarningDialog
            order={readinessWarnDialog.order}
            newStatus={readinessWarnDialog.newStatus}
            onCancel={() => setReadinessWarnDialog(null)}
            onProceed={() => {
              const { order: o, newStatus } = readinessWarnDialog;
              setReadinessWarnDialog(null);
              onStatusChange && onStatusChange(o, newStatus);
            }}
          />
        </div>
      )}

      {/* Date-sequence violation toast */}
      {dateViolationToast && (
        <div
          onMouseEnter={() => {
            setViolationHovered(true);
            clearTimeout(violationTimerRef.current);
          }}
          onMouseLeave={() => {
            setViolationHovered(false);
            violationTimerRef.current = setTimeout(
              () => setDateViolationToast(null),
              5000,
            );
          }}
          style={{
            position: "fixed",
            top: 20,
            right: 20,
            zIndex: 9999,
            maxWidth: 420,
            background: "#fffbeb",
            border: "1px solid #fde68a",
            borderLeft: "4px solid #f59e0b",
            borderRadius: 8,
            overflow: "hidden",
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            animation: "slideInRight 0.2s ease",
            fontFamily: "inherit",
          }}
        >
          <style>{`
          @keyframes slideInRight {
            from { opacity: 0; transform: translateX(24px); }
            to   { opacity: 1; transform: translateX(0); }
          }
          @keyframes violationProgress {
            from { width: 100%; }
            to   { width: 0%; }
          }
        `}</style>
          <div style={{ padding: "16px", display: "flex", alignItems: "flex-start", gap: 10 }}>
            <span style={{ fontSize: 16, lineHeight: 1.3, flexShrink: 0 }}>
              ⚠
            </span>
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontWeight: 700,
                  fontSize: 14,
                  color: "#111827",
                  marginBottom: 6,
                }}
              >
                Order requires date adjustment
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "#374151",
                  lineHeight: 1.6,
                  marginBottom: 6,
                }}
              >
                {dateViolationToast.isInferredTarget ? (
                  <>
                    To move{" "}
                    <strong style={{ color: "#111827" }}>
                      {dateViolationToast.dragged.fpr}
                    </strong>{" "}
                    (Target: {dateViolationToast.dragged.date}) to this
                    position, you'll need to update its stock target date or
                    availability date first. Orders with deadlines must remain
                    in chronological order.
                  </>
                ) : (
                  <>
                    To move{" "}
                    <strong style={{ color: "#111827" }}>
                      {dateViolationToast.dragged.fpr}
                    </strong>{" "}
                    ({dateViolationToast.dragged.date}) to this position, you'll
                    need to update its availability date first. Orders with
                    availability dates must remain in chronological order.
                  </>
                )}
              </div>
              {dateViolationToast.sequenceDates?.length > 0 && (
                <div
                  style={{
                    fontSize: 12,
                    color: "#6b7280",
                    fontStyle: "italic",
                    marginBottom: 8,
                  }}
                >
                  Current sequence:{" "}
                  {dateViolationToast.sequenceDates.join(" → ")}
                </div>
              )}
              <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.5 }}>
                💡{" "}
                {dateViolationToast.isInferredTarget
                  ? "Edit the availability date in the Avail Date column, or update the Next 10 Days stock data to change the target date."
                  : "Edit the availability date of this order to a date that fits the desired position, then drag it again."}
              </div>
            </div>
            <button
              onClick={() => setDateViolationToast(null)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "#9ca3af",
                fontSize: 16,
                lineHeight: 1,
                padding: "0 2px",
                flexShrink: 0,
              }}
            >
              ×
            </button>
          </div>
          {/* Progress bar */}
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              height: 3,
              background: "#d97706",
              opacity: 0.55,
              animation: "violationProgress 12s linear forwards",
              animationPlayState: violationHovered ? "paused" : "running",
            }}
          />
        </div>
      )}

      {plannedAffectedDialog && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10000,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "inherit",
          }}
          onClick={() => setPlannedAffectedDialog(null)}
        >
          <div
            style={{
              background: "white",
              borderRadius: 10,
              padding: "24px",
              maxWidth: 420,
              width: "90%",
              boxShadow: "0 8px 40px rgba(0,0,0,0.2)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 10 }}>
              ⚠ Planned Order Will Be Affected
            </div>
            <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.6, marginBottom: 16 }}>
              Inserting this order here will push{" "}
              <strong>{plannedAffectedDialog.planned?.fpr || plannedAffectedDialog.planned?.item_description}</strong>{" "}
              (Planned) down to a lower priority.
              <br /><br />
              Consider adjusting the Planned order first, or proceed if this is intentional.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setPlannedAffectedDialog(null)}
                style={{
                  padding: "8px 16px", borderRadius: 6, border: "1px solid #d1d5db",
                  background: "white", color: "#374151", fontSize: 13, cursor: "pointer", fontWeight: 500,
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const { from, to } = plannedAffectedDialog;
                  setPlannedAffectedDialog(null);
                  clearNewBadge(visibleOrders[from]?.fpr);
                  onReorder && onReorder(from, to, visibleOrders);
                }}
                style={{
                  padding: "8px 16px", borderRadius: 6, border: "none",
                  background: "#fd5108", color: "white", fontSize: 13, cursor: "pointer", fontWeight: 600,
                }}
              >
                Proceed Anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {movingPlannedDialog && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10000,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "inherit",
          }}
          onClick={() => setMovingPlannedDialog(null)}
        >
          <div
            style={{
              background: "white",
              borderRadius: 10,
              padding: "24px",
              maxWidth: 440,
              width: "90%",
              boxShadow: "0 8px 40px rgba(0,0,0,0.2)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 10 }}>
              ⚠ Moving Planned Order
            </div>
            <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.6, marginBottom: 16 }}>
              <strong>{movingPlannedDialog.dragged?.item_description || movingPlannedDialog.dragged?.fpr || "This order"}</strong>{" "}
              is currently Planned at Priority {movingPlannedDialog.from + 1}.
              Moving it to Priority {movingPlannedDialog.to + 1} will change its locked position.
              <br /><br />
              Do you want to proceed?
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setMovingPlannedDialog(null)}
                style={{
                  padding: "8px 16px", borderRadius: 6, border: "1px solid #d1d5db",
                  background: "white", color: "#374151", fontSize: 13, cursor: "pointer", fontWeight: 500,
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const { from, to } = movingPlannedDialog;
                  setMovingPlannedDialog(null);
                  clearNewBadge(visibleOrders[from]?.fpr);
                  onReorder && onReorder(from, to, visibleOrders);
                }}
                style={{
                  padding: "8px 16px", borderRadius: 6, border: "none",
                  background: "#fd5108", color: "white", fontSize: 13, cursor: "pointer", fontWeight: 600,
                }}
              >
                Proceed
              </button>
            </div>
          </div>
        </div>
      )}

      {lockedStatusWarn && (
        <div
          style={{
            position: "fixed",
            top: 20,
            right: 20,
            zIndex: 9999,
            maxWidth: 420,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderLeft: "4px solid #ef4444",
            borderRadius: 8,
            padding: "16px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            animation: "slideInRight 0.2s ease",
            fontFamily: "inherit",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <span style={{ fontSize: 16, lineHeight: 1.3, flexShrink: 0 }}>🔒</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: "#111827", marginBottom: 6 }}>
                Cannot Move Order
              </div>
              <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.6, marginBottom: 6 }}>
                <strong style={{ color: "#111827" }}>{lockedStatusWarn.dragged?.fpr || lockedStatusWarn.dragged?.item_description}</strong>{" "}
                cannot be moved above{" "}
                <strong style={{ color: "#111827" }}>{lockedStatusWarn.blocker?.fpr || lockedStatusWarn.blocker?.item_description}</strong>{" "}
                which is <em>{lockedStatusWarn.blocker?.status?.replace(/_/g, " ")}</em>.
              </div>
              <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.5 }}>
                💡 Orders with locked statuses (In Production, On-going, Planned) cannot be overtaken by movable orders.
              </div>
            </div>
            <button
              onClick={() => setLockedStatusWarn(null)}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 16, lineHeight: 1, padding: "0 2px", flexShrink: 0 }}
            >
              ×
            </button>
          </div>
        </div>
      )}

      {colSafetyToast && (
        <div
          onMouseEnter={() => clearTimeout(colSafetyTimerRef.current)}
          onMouseLeave={() => {
            colSafetyTimerRef.current = setTimeout(
              () => setColSafetyToast(false),
              60000,
            );
          }}
          style={{
            position: "fixed",
            top: 20,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 9999,
            maxWidth: 420,
            background: "#fff7ed",
            border: "1px solid #fed7aa",
            borderLeft: "4px solid #f97316",
            borderRadius: 8,
            padding: "12px 18px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span style={{ fontSize: 18 }}>⚠️</span>
          <span style={{ fontSize: 13, color: "#9a3412", fontWeight: 500 }}>
            At least one data column must be visible. Unhide a column to
            continue.
          </span>
          <button
            onClick={() => setColSafetyToast(false)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "#9a3412",
              fontSize: 18,
              lineHeight: 1,
              padding: "0 2px",
              marginLeft: "auto",
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>
      )}
    </TooltipProvider>
  );
}

function ReadinessWarningDialog({ order, newStatus, onCancel, onProceed }) {
  const items = getReadinessWarningItems(order);
  const effVol = getEffectiveVolume(order);
  const statusLabels = {
    in_production: "In production",
    ongoing_batching: "On-going batching",
    ongoing_pelleting: "On-going pelleting",
    ongoing_bagging: "On-going bagging",
  };
  const lineNum =
    (order.feedmill_line || "").replace(/\D/g, "") || order.feedmill_line;
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 12,
        padding: "28px 28px 24px",
        maxWidth: 480,
        width: "100%",
        boxShadow: "0 8px 40px rgba(0,0,0,0.18)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 18,
        }}
      >
        <AlertTriangle
          style={{ width: 22, height: 22, color: "#fd5108", flexShrink: 0 }}
        />
        <span style={{ fontSize: 16, fontWeight: 600, color: "#1a1a1a" }}>
          Order Not Ready
        </span>
      </div>

      <p
        style={{
          fontSize: 12,
          color: "#6b7280",
          marginBottom: 14,
          lineHeight: 1.6,
        }}
      >
        This order has not passed its readiness check. Some details may be
        missing or incomplete.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "90px 1fr",
          rowGap: 4,
          marginBottom: 14,
        }}
      >
        <span style={{ fontSize: 12, color: "#6b7280" }}>Line:</span>
        <span style={{ fontSize: 12, color: "#1a1a1a", fontWeight: 600 }}>
          {lineNum}
        </span>
        <span style={{ fontSize: 12, color: "#6b7280" }}>FPR:</span>
        <span style={{ fontSize: 12, color: "#1a1a1a", fontWeight: 600 }}>
          {order.fpr || "—"}
        </span>
        <span style={{ fontSize: 12, color: "#6b7280" }}>Item:</span>
        <span style={{ fontSize: 12, color: "#1a1a1a", fontWeight: 600 }}>
          {order.item_description || "—"}
        </span>
        <span style={{ fontSize: 12, color: "#6b7280" }}>Volume:</span>
        <span style={{ fontSize: 12, color: "#1a1a1a", fontWeight: 600 }}>
          {effVol} MT
        </span>
      </div>

      {items.length > 0 && (
        <div
          style={{
            background: "#fff7ed",
            border: "1px solid #fed7aa",
            borderRadius: 6,
            padding: "10px 12px",
            marginBottom: 18,
          }}
        >
          <p
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "#c2410c",
              marginBottom: 6,
            }}
          >
            Missing or incomplete:
          </p>
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: "none",
              display: "flex",
              flexDirection: "column",
              gap: 3,
            }}
          >
            {items.map((item, i) => (
              <li
                key={i}
                style={{
                  fontSize: 11,
                  color: "#c2410c",
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                <span
                  style={{ color: "#fd5108", fontWeight: 700, lineHeight: 1 }}
                >
                  •
                </span>{" "}
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 18 }}>
        Do you want to proceed with{" "}
        <strong style={{ color: "#1a1a1a" }}>
          {statusLabels[newStatus] || newStatus}
        </strong>{" "}
        anyway?
      </p>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
        <button
          onClick={onCancel}
          style={{
            fontSize: 12,
            color: "#374151",
            background: "white",
            border: "1px solid #d1d5db",
            borderRadius: 6,
            padding: "8px 16px",
            cursor: "pointer",
          }}
          data-testid="button-go-back"
        >
          Go Back
        </button>
        <button
          onClick={onProceed}
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "white",
            background: "#fd5108",
            border: "none",
            borderRadius: 6,
            padding: "8px 16px",
            cursor: "pointer",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#e8490b")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "#fd5108")}
          data-testid="button-proceed-anyway"
        >
          Proceed Anyway
        </button>
      </div>
    </div>
  );
}

function ReadinessIcon({ tier, order }) {
  if (tier === 3) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex justify-center">
            <CheckCircle2 className="h-5 w-5 text-green-600" />
          </div>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          className="max-w-[240px] bg-[#2e343a] text-white border-[#2e343a]"
        >
          <p className="font-semibold text-xs mb-1">Ready to Produce</p>
          <p className="text-[11px] text-gray-300">
            All required details are complete.
          </p>
        </TooltipContent>
      </Tooltip>
    );
  }

  if (tier === 2) {
    const haMissing = getHAMissing(order);
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex justify-center">
            <AlertTriangle className="h-5 w-5 text-orange-500" />
          </div>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          className="max-w-[280px] bg-[#2e343a] text-white border-[#2e343a]"
        >
          <p className="font-semibold text-xs mb-1">HA Info Incomplete</p>
          <ul className="text-[11px] text-gray-300 space-y-0.5">
            {haMissing.map((m, i) => (
              <li key={i}>• {m}</li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    );
  }

  const missing = getMissingFields(order);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex justify-center">
          <XCircle className="h-5 w-5 text-red-500" />
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        className="max-w-[280px] bg-[#2e343a] text-white border-[#2e343a]"
      >
        <p className="font-semibold text-xs mb-1">Missing Critical Details</p>
        <ul className="text-[11px] text-gray-300 space-y-0.5">
          {missing.map((m, i) => (
            <li key={i}>• {m}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

// ─── Date Constraint Utilities ───────────────────────────────────────────────

/** Today as YYYY-MM-DD for HTML date input min attribute */
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** Is this avail date value a real calendar date (not "prio replenish", etc.)? */
function isRealAvailDate(val) {
  if (!val) return false;
  const nonDates = ["prio replenish", "safety stocks", "safety stock", "stock sufficient", "for sched"];
  if (nonDates.includes(String(val).toLowerCase().trim())) return false;
  return /^\d{4}-\d{2}-\d{2}/.test(val);
}

/**
 * Convert completion date string "MM/DD/YYYY - HH:MM AM/PM" → "YYYY-MM-DD"
 * so it can be compared with ISO date strings.
 */
function completionToIso(str) {
  const m = str?.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

/**
 * Return per-field conflict level for an order.
 * "conflict" = hard (red), "info" = soft (yellow).
 */
function getDateConflicts(order) {
  const start = order.start_date || null;
  const avail = isRealAvailDate(order.target_avail_date) ? order.target_avail_date : null;
  const compIso = completionToIso(order.target_completion_date);
  const end = order.end_date || null;
  const result = {};

  if (start && avail && start > avail) result.start_date = "conflict";
  if (start && compIso && start > compIso) result.start_date = "conflict";

  if (compIso) {
    // Completion must be strictly before avail (at least 1 day earlier)
    if (avail && compIso >= avail) result.completion_date = "conflict";
    if (start && compIso < start) result.completion_date = "conflict";
  }

  if (end && start && end < start) result.end_date = "conflict";
  else if (end && avail && end < avail) result.end_date = "info";

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────

function StartDateCell({ order, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [dateVal, setDateVal] = useState(order.start_date || "");

  const conflicts = getDateConflicts(order);
  const hasConflict = conflicts.start_date === "conflict";
  const availMax = isRealAvailDate(order.target_avail_date) ? order.target_avail_date : undefined;

  const handleOpen = () => {
    setDateVal(order.start_date || "");
    setEditing(true);
  };

  const handleSave = (val) => {
    if (val) {
      onUpdate(order.id, { start_date: val });
    }
    setEditing(false);
  };

  const handleClear = () => {
    onUpdate(order.id, { start_date: null, start_time: null });
    setEditing(false);
  };

  const [startCellTooltip, setStartCellTooltip] = useState(false);
  const [startCellTipPos, setStartCellTipPos] = useState({ x: 0, y: 0 });
  const startCellTimer = useRef(null);
  function startClamp(x, y, w, h) {
    const vw = window.innerWidth, vh = window.innerHeight, pad = 8;
    if (x + w + pad > vw) x = x - w - 24;
    if (y + h + pad > vh) y = y - h - 24;
    if (x < pad) x = pad; if (y < pad) y = pad;
    return { x, y };
  }
  function handleStartCellEnter(e) {
    if (!hasConflict) return;
    clearTimeout(startCellTimer.current);
    startCellTimer.current = setTimeout(() => {
      setStartCellTipPos(startClamp(e.clientX + 12, e.clientY + 12, 270, 60));
      setStartCellTooltip(true);
    }, 300);
  }
  function handleStartCellMove(e) {
    if (!hasConflict || !startCellTooltip) return;
    setStartCellTipPos(startClamp(e.clientX + 12, e.clientY + 12, 270, 60));
  }
  function handleStartCellLeave() {
    clearTimeout(startCellTimer.current);
    setStartCellTooltip(false);
  }
  const startCellTipEl = startCellTooltip && hasConflict ? createPortal(
    <div style={{ position: "fixed", left: startCellTipPos.x, top: startCellTipPos.y, zIndex: 9999, background: "#1e293b", color: "#f1f5f9", padding: "8px 12px", borderRadius: 8, fontSize: 12, lineHeight: 1.5, maxWidth: 270, boxShadow: "0 4px 20px rgba(0,0,0,0.3)", pointerEvents: "none" }}>
      Start date is after the availability or estimated completion date — update to remove the conflict.
    </div>, document.body,
  ) : null;

  if (editing) {
    return (
      <div className="space-y-1">
        <Input
          type="date"
          value={dateVal}
          min={todayIso()}
          max={availMax}
          onChange={(e) => setDateVal(e.target.value)}
          className="border border-gray-300 focus:border-[#fd5108] bg-transparent shadow-none rounded px-1 h-6 text-xs focus-visible:ring-0 w-32"
          data-testid={`input-start-date-${order.id}`}
          autoFocus
        />
        <div className="flex gap-1">
          <Button
            size="sm"
            className="h-5 text-[10px] bg-[#fd5108] hover:bg-[#fe7c39] px-2"
            onClick={() => handleSave(dateVal)}
            data-testid={`button-save-date-${order.id}`}
          >
            Save
          </Button>
          {order.start_date && (
            <Button
              size="sm"
              variant="outline"
              className="h-5 text-[10px] px-2 text-red-500 border-red-200 hover:bg-red-50"
              onClick={handleClear}
              data-testid={`button-clear-date-${order.id}`}
            >
              Clear
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-5 text-[10px] px-2"
            onClick={() => setEditing(false)}
            data-testid={`button-cancel-date-${order.id}`}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative"
      style={hasConflict ? { background: "#fef2f2", borderRadius: 4, padding: "2px 4px", margin: "-2px -4px" } : undefined}
      onMouseEnter={handleStartCellEnter}
      onMouseMove={handleStartCellMove}
      onMouseLeave={handleStartCellLeave}
    >
      {startCellTipEl}
      <div className="absolute top-0 right-0 mt-0.5 mr-0.5">
        <button
          onClick={handleOpen}
          className="text-[#2e343a] hover:text-[#fd5108] transition-colors"
          title="Edit start date"
          data-no-drag="true"
          data-testid={`button-edit-date-${order.id}`}
        >
          <Calendar className="h-3 w-3" />
        </button>
      </div>
      <div className="pr-5 flex items-center gap-1">
        {order.start_date ? (
          <span className="text-[13px] text-gray-700">
            {formatLongDate(order.start_date)}
          </span>
        ) : (
          <span className="text-[13px] italic" style={{ color: "#d5dbe2" }}>
            Set start date
          </span>
        )}
        {hasConflict && (
          <AlertTriangle style={{ width: 11, height: 11, color: "#dc2626", flexShrink: 0 }} />
        )}
      </div>
    </div>
  );
}

function StartTimeEditor({ order, onUpdate }) {
  const [editing, setEditing] = useState(false);

  const parse12 = (t) => {
    if (!t) return { h: 12, m: 0, ap: "AM" };
    const mx = String(t).match(/(\d+):(\d+)\s*(am|pm)?/i);
    if (!mx) return { h: 12, m: 0, ap: "AM" };
    let h24 = parseInt(mx[1]);
    const min = parseInt(mx[2]);
    if (mx[3]) {
      const ap = mx[3].toUpperCase();
      return {
        h:
          ap === "AM" && h24 === 12
            ? 12
            : (ap === "PM" && h24 < 12 ? h24 + 12 : h24) % 12 || 12,
        m: min,
        ap,
      };
    }
    const ap = h24 >= 12 ? "PM" : "AM";
    const h12 = h24 % 12 || 12;
    return { h: h12, m: min, ap };
  };

  const init = parse12(order.start_time);
  const [hours, setHours] = useState(String(init.h).padStart(2, "0"));
  const [minutes, setMinutes] = useState(String(init.m).padStart(2, "0"));
  const [ampm, setAmpm] = useState(init.ap);

  const handleOpen = () => {
    const cur = parse12(order.start_time);
    setHours(String(cur.h).padStart(2, "0"));
    setMinutes(String(cur.m).padStart(2, "0"));
    setAmpm(cur.ap);
    setEditing(true);
  };

  const handleSave = () => {
    let h = parseInt(hours) || 12;
    if (h === 0) h = 12;
    if (h > 12) h = 12;
    const min = Math.min(59, Math.max(0, parseInt(minutes) || 0));
    let h24 = h;
    if (ampm === "PM" && h < 12) h24 = h + 12;
    if (ampm === "AM" && h === 12) h24 = 0;
    const timeStr = `${String(h24).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    onUpdate(order.id, { start_time: timeStr });
    setEditing(false);
  };

  const handleClearTime = () => {
    onUpdate(order.id, { start_time: null });
    setEditing(false);
  };

  const handleHoursChange = (e) => {
    const v = e.target.value.replace(/\D/g, "").slice(0, 2);
    setHours(v);
  };

  const handleMinutesChange = (e) => {
    const v = e.target.value.replace(/\D/g, "").slice(0, 2);
    setMinutes(v);
  };

  const handleHoursBlur = () => {
    let h = parseInt(hours) || 0;
    if (h === 0) h = 12;
    if (h > 12) h = 12;
    setHours(String(h).padStart(2, "0"));
  };

  const handleMinutesBlur = () => {
    let m = parseInt(minutes) || 0;
    if (m > 59) m = 59;
    setMinutes(String(m).padStart(2, "0"));
  };

  if (editing) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1">
          <Input
            type="text"
            value={hours}
            onChange={handleHoursChange}
            onBlur={handleHoursBlur}
            className="border border-gray-300 focus:border-[#fd5108] bg-transparent shadow-none rounded px-1 h-6 text-xs focus-visible:ring-0 w-8 text-center"
            data-testid={`input-start-time-hours-${order.id}`}
            maxLength={2}
          />
          <span className="text-xs text-gray-500">:</span>
          <Input
            type="text"
            value={minutes}
            onChange={handleMinutesChange}
            onBlur={handleMinutesBlur}
            className="border border-gray-300 focus:border-[#fd5108] bg-transparent shadow-none rounded px-1 h-6 text-xs focus-visible:ring-0 w-8 text-center"
            data-testid={`input-start-time-minutes-${order.id}`}
            maxLength={2}
          />
          <div className="flex ml-1">
            <button
              onClick={() => setAmpm("AM")}
              className={cn(
                "px-1.5 py-0.5 text-[9px] font-semibold rounded-l border transition-colors",
                ampm === "AM"
                  ? "bg-[#fd5108] text-white border-[#fd5108]"
                  : "bg-gray-100 text-gray-500 border-gray-300 hover:bg-gray-200",
              )}
              data-testid={`button-am-${order.id}`}
              data-no-drag="true"
            >
              AM
            </button>
            <button
              onClick={() => setAmpm("PM")}
              className={cn(
                "px-1.5 py-0.5 text-[9px] font-semibold rounded-r border-t border-r border-b transition-colors",
                ampm === "PM"
                  ? "bg-[#fd5108] text-white border-[#fd5108]"
                  : "bg-gray-100 text-gray-500 border-gray-300 hover:bg-gray-200",
              )}
              data-testid={`button-pm-${order.id}`}
              data-no-drag="true"
            >
              PM
            </button>
          </div>
        </div>
        <div className="flex gap-1">
          <Button
            size="sm"
            className="h-5 text-[10px] bg-[#fd5108] hover:bg-[#fe7c39] px-2"
            onClick={handleSave}
            data-testid={`button-save-time-${order.id}`}
          >
            Save
          </Button>
          {order.start_time && (
            <Button
              size="sm"
              variant="outline"
              className="h-5 text-[10px] px-2 text-red-500 border-red-200 hover:bg-red-50"
              onClick={handleClearTime}
              data-testid={`button-clear-time-${order.id}`}
            >
              Clear
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-5 text-[10px] px-2"
            onClick={() => setEditing(false)}
            data-testid={`button-cancel-time-${order.id}`}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="absolute top-0 right-0 mt-0.5 mr-0.5">
        <button
          onClick={handleOpen}
          className="text-[#2e343a] hover:text-[#fd5108] transition-colors"
          title="Edit start time"
          data-no-drag="true"
          data-testid={`button-edit-time-${order.id}`}
        >
          <Clock className="h-3 w-3" />
        </button>
      </div>
      <div className="pr-5">
        {order.start_time ? (
          <span className="text-[13px] text-gray-700">
            {formatTime12(order.start_time)}
          </span>
        ) : (
          <span className="text-[13px] italic" style={{ color: "#d5dbe2" }}>
            Set start time
          </span>
        )}
      </div>
    </div>
  );
}

function VolumeCell({
  order,
  sugVol,
  effVol,
  batchSize,
  hasOverride,
  isNotMultiple,
  canEdit,
  onUpdate,
  allOrders,
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [revertOpen, setRevertOpen] = useState(false);
  const [newVolumeStr, setNewVolumeStr] = useState("");
  const [impactAnalysis, setImpactAnalysis] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const debounceRef = useRef(null);

  const origVol = parseFloat(order.total_volume_mt) || 0;
  const currentVol = effVol;
  const parsedNew = parseFloat(newVolumeStr) || 0;
  const volumeDiff = parsedNew - currentVol;
  const isIncrease = volumeDiff > 0;
  const isChanged = parsedNew > 0 && Math.abs(volumeDiff) > 0.001;

  const prodHours = parseFloat(order.production_hours) || 0;
  const runRate = (prodHours > 0 && currentVol > 0) ? (currentVol / prodHours) : 0;
  const newProdHours = runRate > 0 ? parsedNew / runRate : 0;
  const timeDiffHours = newProdHours - prodHours;

  const bs = parseFloat(batchSize) || 0;
  const isValidMultiple = !isChanged || bs <= 0 || Math.abs(Math.round(parsedNew / bs) * bs - parsedNew) < 0.001;
  const nearestMultiple = bs > 0 && parsedNew > 0 ? Math.round(parsedNew / bs) * bs : null;

  const openDialog = () => {
    setNewVolumeStr(String(fmtVolume(currentVol)));
    setImpactAnalysis(null);
    setIsAnalyzing(false);
    setDialogOpen(true);
  };

  useEffect(() => {
    if (!dialogOpen) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!isChanged) { setImpactAnalysis(null); return; }
    debounceRef.current = setTimeout(async () => {
      setIsAnalyzing(true);
      try {
        const following = (allOrders || [])
          .filter(r =>
            r.feedmill_line === order.feedmill_line &&
            (r.priority_seq ?? 0) > (order.priority_seq ?? 0) &&
            r.status !== "completed" && r.status !== "cancel_po"
          )
          .sort((a, b) => (a.priority_seq ?? 0) - (b.priority_seq ?? 0))
          .slice(0, 8)
          .map(r => ({
            ...r,
            _simPrio: r.priority_seq,
            _simCompletionStr: r.target_completion || null,
            _inferredData: null,
            line: r.feedmill_line,
          }));
        const result = await generateVolumeImpactAnalysis(
          { ...order, _simPrio: order.priority_seq, line: order.feedmill_line },
          parsedNew,
          following
        );
        setImpactAnalysis(result || "No following orders on this line.");
      } catch {
        setImpactAnalysis("Unable to generate impact analysis. You can still proceed.");
      } finally {
        setIsAnalyzing(false);
      }
    }, 600);
    return () => clearTimeout(debounceRef.current);
  }, [newVolumeStr, dialogOpen]);

  const handleApply = () => {
    const val = parseFloat(newVolumeStr);
    if (!isNaN(val) && val > 0) {
      onUpdate(order.id, { volume_override: val });
    }
    setDialogOpen(false);
  };

  return (
    <div className="relative">
      {canEdit && (
        <div className="absolute top-0 right-0 mt-0.5 mr-0.5">
          <button
            onClick={hasOverride ? () => setRevertOpen(true) : () => setConfirmOpen(true)}
            className={hasOverride
              ? "text-[#fd5108] hover:text-[#fe7c39] transition-colors"
              : "text-gray-300 hover:text-[#fd5108] transition-colors"
            }
            title={hasOverride ? "Volume overridden — click to revert" : "Override volume"}
            data-testid={hasOverride ? `button-volume-unlock-${order.id}` : `button-volume-lock-${order.id}`}
            data-no-drag="true"
          >
            {hasOverride ? <Unlock className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
          </button>
        </div>
      )}

      <div className="pr-5">
        <div className="flex items-center gap-1">
          <p className={`text-[13px] font-bold ${hasOverride ? "text-[#fd5108]" : "text-gray-900"}`}>
            {fmtVolume(effVol)} MT
          </p>
          {isNotMultiple && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-amber-500 cursor-help">⚠</span>
              </TooltipTrigger>
              <TooltipContent className="text-xs bg-[#2e343a] text-white border-[#2e343a]">
                This volume is not a multiple of the Batch Size ({batchSize}).
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {!hasOverride && sugVol !== origVol && (
          <p className="text-[13px] text-[#6b7280]">
            Original: {fmtVolume(origVol)} MT
          </p>
        )}
      </div>

      {/* Lock Confirmation Dialog */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/30"
          onClick={() => setConfirmOpen(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl p-6 w-full max-w-[420px] mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[18px] font-bold text-gray-900 mb-2">Override Volume?</p>
            <p className="text-[14px] leading-relaxed text-gray-500 mb-4">
              You are about to manually override the system-calculated volume for this order. This will replace the suggested volume and may affect downstream scheduling.
            </p>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" className="text-[14px] font-semibold h-10 px-5" onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
              <Button
                className="bg-[#fd5108] hover:bg-[#fe7c39] text-[14px] font-semibold h-10 px-5"
                onClick={() => { setConfirmOpen(false); openDialog(); }}
                data-testid={`button-volume-confirm-${order.id}`}
              >
                Confirm
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Revert Override Dialog */}
      {revertOpen && (
        <div
          className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/30"
          onClick={() => setRevertOpen(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl p-6 w-full max-w-[480px] mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[18px] font-bold text-gray-900 mb-2">Remove Volume Override?</p>
            <p className="text-[14px] leading-relaxed text-gray-500 mb-4">
              Revert to the system-calculated Suggested Volume ({fmtVolume(sugVol)} MT)?
            </p>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" className="text-[14px] font-semibold h-10 px-5" onClick={() => setRevertOpen(false)}>
                Cancel
              </Button>
              <Button
                className="bg-[#fd5108] hover:bg-[#fe7c39] text-[14px] font-semibold h-10 px-5"
                onClick={() => { onUpdate(order.id, { volume_override: null }); setRevertOpen(false); }}
              >
                Revert
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* AI-Powered Volume Override Dialog */}
      {dialogOpen && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setDialogOpen(false)}
        >
          <div
            style={{ width: 480, background: "#fff", borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.22)", overflow: "hidden" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid #e5e7eb" }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: "#1a1a1a" }}>📦 Override Volume</span>
              <button onClick={() => setDialogOpen(false)} style={{ background: "none", border: "none", color: "#9ca3af", fontSize: 18, cursor: "pointer", lineHeight: 1 }}>✕</button>
            </div>
            {/* Order info */}
            <div style={{ padding: "12px 20px", background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#1a1a1a" }}>{order.item_description || "—"}</div>
              <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                FPR: {order.fpr || "—"} · Prio {order.priority_seq || "—"} · {order.feedmill_line || "—"}
              </div>
            </div>
            {/* Volume input */}
            <div style={{ padding: "16px 20px", borderBottom: "1px solid #e5e7eb" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 6 }}>Current Volume</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#374151", padding: "8px 0" }}>{currentVol} MT</div>
                  {runRate > 0 && <div style={{ fontSize: 10, color: "#9ca3af" }}>Run rate: {runRate.toFixed(2)} MT/hr</div>}
                </div>
                <div style={{ fontSize: 18, color: "#9ca3af", marginTop: 20 }}>→</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 6 }}>New Volume</div>
                  <div style={{ display: "flex", alignItems: "center", border: "2px solid #fd5108", borderRadius: 8, overflow: "hidden" }}>
                    <input
                      type="number"
                      autoFocus
                      min="0"
                      step="1"
                      value={newVolumeStr}
                      onChange={e => setNewVolumeStr(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && isChanged && parsedNew > 0 && !isAnalyzing && isValidMultiple && handleApply()}
                      style={{ flex: 1, padding: "8px 12px", fontSize: 18, fontWeight: 700, color: "#1a1a1a", border: "none", outline: "none", width: "100%" }}
                      data-testid={`input-volume-dialog-${order.id}`}
                    />
                    <span style={{ padding: "8px 12px", fontSize: 13, fontWeight: 600, color: "#6b7280", background: "#f9fafb", borderLeft: "1px solid #e5e7eb" }}>MT</span>
                  </div>
                  {runRate > 0 && parsedNew > 0 && (
                    <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 3 }}>Prod. time: {newProdHours.toFixed(2)} hrs</div>
                  )}
                </div>
              </div>
              {isChanged && (
                <div style={{
                  marginTop: 10, fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 4, display: "inline-block",
                  background: isIncrease ? "#fef2f2" : "#f0fdf4",
                  color: isIncrease ? "#dc2626" : "#16a34a",
                }}>
                  {isIncrease ? "▲" : "▼"} {Math.abs(volumeDiff).toFixed(1)} MT ({isIncrease ? "+" : ""}{currentVol > 0 ? ((volumeDiff / currentVol) * 100).toFixed(1) : "0"}%)
                  {runRate > 0 && ` · ${isIncrease ? "+" : ""}${timeDiffHours.toFixed(2)} hrs production time`}
                </div>
              )}
              {isChanged && !isValidMultiple && bs > 0 && (
                <div style={{ marginTop: 8, fontSize: 12, color: "#dc2626", display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontWeight: 700 }}>⚠</span>
                  <span>
                    {parsedNew} MT is not a multiple of the batch size ({bs} MT).
                    {nearestMultiple !== null && nearestMultiple !== parsedNew && (
                      <> Try{" "}
                        <button
                          onClick={() => setNewVolumeStr(String(nearestMultiple))}
                          style={{ color: "#fd5108", fontWeight: 700, background: "none", border: "none", padding: 0, cursor: "pointer", textDecoration: "underline" }}
                        >
                          {nearestMultiple} MT
                        </button>
                        {" "}instead.
                      </>
                    )}
                  </span>
                </div>
              )}
            </div>
            {/* Impact Analysis */}
            <div style={{ borderBottom: "1px solid #e5e7eb" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", background: "#fff7ed", borderBottom: "1px solid #fed7aa" }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#92400e" }}>✨ Impact Analysis</span>
                {isAnalyzing && (
                  <span style={{ fontSize: 11, color: "#92400e", display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>🔄</span> Analyzing...
                  </span>
                )}
              </div>
              <div style={{ padding: "14px 20px", minHeight: 60, maxHeight: 160, overflowY: "auto" }}>
                {!isChanged && <div style={{ fontSize: 12, color: "#9ca3af", fontStyle: "italic" }}>Enter a new volume to see the impact analysis.</div>}
                {isChanged && isAnalyzing && !impactAnalysis && <div style={{ fontSize: 12, color: "#92400e", fontStyle: "italic" }}>Calculating impact on following orders...</div>}
                {isChanged && impactAnalysis && (
                  <div style={{ fontSize: 12, color: "#374151", lineHeight: 1.7, whiteSpace: "pre-wrap", opacity: isAnalyzing ? 0.5 : 1 }}>
                    {impactAnalysis}
                  </div>
                )}
              </div>
            </div>
            {/* Footer */}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "14px 20px" }}>
              <button
                onClick={() => setDialogOpen(false)}
                style={{ padding: "8px 20px", fontSize: 13, fontWeight: 500, color: "#6b7280", background: "#fff", border: "1px solid #d1d5db", borderRadius: 6, cursor: "pointer" }}
                onMouseEnter={e => e.currentTarget.style.background = "#f9fafb"}
                onMouseLeave={e => e.currentTarget.style.background = "#fff"}
              >
                Cancel
              </button>
              <button
                onClick={handleApply}
                disabled={!isChanged || parsedNew <= 0 || isAnalyzing || !isValidMultiple}
                style={{
                  padding: "8px 20px", fontSize: 13, fontWeight: 600, color: "#fff",
                  background: (!isChanged || parsedNew <= 0 || isAnalyzing || !isValidMultiple) ? "#fca58a" : "#fd5108",
                  border: "none", borderRadius: 6,
                  cursor: (!isChanged || parsedNew <= 0 || isAnalyzing || !isValidMultiple) ? "not-allowed" : "pointer",
                }}
                data-testid={`button-volume-apply-${order.id}`}
              >
                Apply Change
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function _clampVP(x, y, w, h) {
  const vw = window.innerWidth,
    vh = window.innerHeight,
    p = 8;
  if (x + w + p > vw) x = x - w - 24;
  if (y + h + p > vh) y = y - h - 24;
  if (x < p) x = p;
  if (y < p) y = p;
  return { x, y };
}

function SmartInsightCell({ order }) {
  useInsightCacheUpdates();
  const { isInsightLoading, isInsightError } = _insightStatus();
  const code = order.material_code || order.material_code_fg || "";
  const parts = getInsightParts(code);

  const dotsStyle = `@keyframes si-dots{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}100%{content:''}}.si-dots::after{content:'';animation:si-dots 1.5s steps(4,end) infinite}`;

  return (
    <td
      style={{
        verticalAlign: "top",
        userSelect: "none",
        padding: "8px 10px",
        overflow: "hidden",
      }}
    >
      {parts ? (
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.5,
            whiteSpace: "normal",
            wordWrap: "break-word",
          }}
        >
          {/* Template line — no emoji, no bold */}
          <div
            style={{
              fontSize: 13,
              fontWeight: 400,
              color: "#374151",
              marginBottom: parts.ai ? 6 : 0,
            }}
          >
            {parts.template}
          </div>
          {/* AI advisory — slightly lighter, below template */}
          {parts.ai ? (
            <div
              style={{
                fontSize: 13,
                fontWeight: 400,
                color: "#4b5563",
                lineHeight: 1.5,
              }}
            >
              {parts.ai}
            </div>
          ) : isInsightLoading ? (
            <div
              style={{
                fontSize: 13,
                color: "#9ca3af",
                fontStyle: "italic",
                marginTop: 4,
              }}
            >
              <style>{dotsStyle}</style>
              <span className="si-dots">Generating insight</span>
            </div>
          ) : isInsightError ? (
            <div
              style={{
                fontSize: 13,
                color: "#dc2626",
                fontStyle: "italic",
                marginTop: 4,
              }}
            >
              ⚠ AI insight unavailable. Template data shown only.
            </div>
          ) : null}
        </div>
      ) : isInsightLoading ? (
        <div style={{ fontSize: 13, color: "#9ca3af", fontStyle: "italic" }}>
          <style>{dotsStyle}</style>
          <span className="si-dots">Generating insight</span>
        </div>
      ) : isInsightError ? (
        <div style={{ fontSize: 13, color: "#dc2626", fontStyle: "italic" }}>
          ⚠ Unable to generate insight. Click Re-apply to retry.
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "#d1d5db", fontStyle: "italic" }}>
          No insight available
        </div>
      )}
    </td>
  );
}

function AvailDateCell({ order, canEdit, onUpdate, inferredInfo = null }) {
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [revertOpen, setRevertOpen] = useState(false);
  const [revertToastMsg, setRevertToastMsg] = useState(null);
  const revertTimerRef = React.useRef(null);
  const [cellTooltip, setCellTooltip] = useState(false);
  const [cellTooltipPos, setCellTooltipPos] = useState({ x: 0, y: 0 });
  const cellTooltipTimer = React.useRef(null);

  const val = order.target_avail_date;
  const origVal = order.original_avail_date;

  const valIsDate = isValidAvailDate(val);
  const origIsDate = isValidAvailDate(origVal);
  const isStockSufficient = val === "stock_sufficient";

  const displayDate = isStockSufficient
    ? "Stock sufficient"
    : valIsDate
      ? formatLongDate(val)
      : val;
  const origDisplay = origIsDate ? formatLongDate(origVal) : origVal;

  const isModifiedFromOriginal = !!(origVal && origVal !== val);
  const isAutoSequenced = order.avail_date_source === "auto_sequence";

  let availWarning = null;
  if (valIsDate) {
    const availD = new Date(val);
    const fprStr = String(order.fpr || "").trim();
    if (fprStr.length >= 6) {
      const yy = parseInt(fprStr.substring(0, 2));
      const mm = parseInt(fprStr.substring(2, 4));
      const dd = parseInt(fprStr.substring(4, 6));
      if (!isNaN(yy) && !isNaN(mm) && mm >= 1 && mm <= 12 && !isNaN(dd)) {
        const diffDays =
          (availD - new Date(2000 + yy, mm - 1, dd)) / (1000 * 60 * 60 * 24);
        if (diffDays > 183)
          availWarning =
            "Inferred date is more than 6 months from order date — please verify.";
      }
    }
    if ((new Date() - new Date(val)) / (1000 * 60 * 60 * 24) > 90) {
      availWarning = "Inferred date appears to be in the past — please verify.";
    }
  }

  const handleProceed = () => {
    setEditValue(valIsDate ? val : "");
    setUnlocked(true);
    setOverrideOpen(false);
  };

  const handleDone = () => {
    if (editValue) onUpdate(order.id, { target_avail_date: editValue });
    setUnlocked(false);
    setEditValue("");
  };

  const handleCancel = () => {
    setUnlocked(false);
    setEditValue("");
  };

  const handleEditKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleDone();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  };

  const handleRevertConfirm = () => {
    onUpdate(order.id, { target_avail_date: origVal });
    setRevertOpen(false);
    setUnlocked(false);
    setEditValue("");
    const msg = `↩ Avail Date reverted to original: ${origDisplay || origVal}`;
    setRevertToastMsg(msg);
    clearTimeout(revertTimerRef.current);
    revertTimerRef.current = setTimeout(() => setRevertToastMsg(null), 60000);
  };

  const dateTextColor = isStockSufficient
    ? "text-[#43a047]"
    : valIsDate
      ? "text-gray-700"
      : val
        ? "text-[#c44107]"
        : "text-gray-700";

  const remarksLine =
    valIsDate && order.remarks ? (
      <p className="text-[13px] text-[#6b7280] flex items-center gap-1">
        {availWarning && (
          <span
            title={availWarning}
            className="inline-flex shrink-0 cursor-help"
          >
            <AlertTriangle className="h-3 w-3 text-amber-500" />
          </span>
        )}
        {order.remarks}
      </p>
    ) : null;

  // Show original label (safety stocks / prio replenish) below the date
  // for any auto-sequenced order whose original avail value differs from current
  // — but skip it if remarksLine already shows the same text (avoids duplication)
  const origLineText = origIsDate ? origDisplay : origVal;
  const originalLine =
    isAutoSequenced && origVal && origVal !== val && origLineText !== order.remarks
      ? (
          <p className="text-[12px] text-[#6b7280] mt-0.5">
            {origLineText}
          </p>
        )
      : null;

  // Tooltip data for the entire cell — icon + text extracted together
  const inferredIconData = (() => {
    if (isAutoSequenced && inferredInfo && (valIsDate || isStockSufficient)) {
      const newTarget =
        inferredInfo.status === "Sufficient"
          ? (inferredInfo.targetDate || "stock_sufficient")
          : inferredInfo.status === "Critical"
            ? new Date().toISOString().slice(0, 10)
            : inferredInfo.targetDate || null;
      const lastTarget = order.last_target_date || null;
      const targetChanged = newTarget !== lastTarget
        && !(!newTarget && !lastTarget)
        && !(inferredInfo.status === "Sufficient" && lastTarget === "stock_sufficient");
      if (targetChanged) {
        const fmtShort = (d) => {
          if (!d) return "None";
          if (d === "stock_sufficient") return "Stock sufficient";
          try { return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" }); }
          catch { return d; }
        };
        return {
          icon: <AlertTriangle style={{ width: 10, height: 10, color: "#f59e0b" }} />,
          tipText: `Target date changed: ${fmtShort(lastTarget)} → ${fmtShort(newTarget)}. Run Auto-Sequence to update.`,
        };
      }
      return null;
    }
    if (valIsDate || !inferredInfo) return null;

    const status = inferredInfo.status || "Monitor";
    const dfl = Number(inferredInfo.dueForLoading || 0);
    const inv = Number(inferredInfo.inventory || 0);
    const buffer = inv > 0 ? (((inv - dfl) / inv) * 100).toFixed(1) : "-100.0";
    const statusColor = {
      Critical: "#dc2626", Urgent: "#ea580c", Monitor: "#ca8a04", Sufficient: "#16a34a",
    }[status] || "#6b7280";
    const fmtFull = (d) => {
      try { return format(new Date(d), "MMMM d, yyyy"); } catch { return "—"; }
    };
    const availFull = inferredInfo.targetDate ? fmtFull(inferredInfo.targetDate) : "—";
    const completionFull = inferredInfo.targetDate
      ? fmtFull(new Date(new Date(inferredInfo.targetDate).getTime() - 86400000))
      : "—";
    const tipText = status === "Sufficient"
      ? `Stock level data available.\nStatus: Sufficient\nBuffer: ${buffer}%`
      : `Stock level data available.\nCompletion: ${completionFull}\nAvail: ${availFull}\nStatus: ${status}\nBuffer: ${buffer}%`;
    const icon = status === "Sufficient"
      ? <CheckCircle2 style={{ width: 10, height: 10, color: "#16a34a" }} />
      : <AlertTriangle style={{ width: 10, height: 10, color: statusColor }} />;
    return { icon, tipText };
  })();

  // Icon element — no title attribute; tooltip is handled at cell level
  const inferredIcon = inferredIconData ? (
    <span className="shrink-0 inline-flex items-center">
      {inferredIconData.icon}
    </span>
  ) : null;

  function clampToViewport(x, y, w, h) {
    const vw = window.innerWidth, vh = window.innerHeight, pad = 8;
    if (x + w + pad > vw) x = x - w - 24;
    if (y + h + pad > vh) y = y - h - 24;
    if (x < pad) x = pad;
    if (y < pad) y = pad;
    return { x, y };
  }
  function handleCellMouseEnter(e) {
    if (!inferredIconData) return;
    clearTimeout(cellTooltipTimer.current);
    cellTooltipTimer.current = setTimeout(() => {
      setCellTooltipPos(clampToViewport(e.clientX + 12, e.clientY + 12, 270, 100));
      setCellTooltip(true);
    }, 300);
  }
  function handleCellMouseMove(e) {
    if (!inferredIconData || !cellTooltip) return;
    setCellTooltipPos(clampToViewport(e.clientX + 12, e.clientY + 12, 270, 100));
  }
  function handleCellMouseLeave() {
    clearTimeout(cellTooltipTimer.current);
    setCellTooltip(false);
  }

  const cellTooltipEl = cellTooltip && inferredIconData ? createPortal(
    <div
      style={{
        position: "fixed",
        left: cellTooltipPos.x,
        top: cellTooltipPos.y,
        zIndex: 9999,
        background: "#1e293b",
        color: "#f1f5f9",
        padding: "8px 12px",
        borderRadius: 8,
        fontSize: 12,
        lineHeight: 1.5,
        whiteSpace: "pre-line",
        maxWidth: 270,
        boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
        pointerEvents: "none",
      }}
    >
      {inferredIconData.tipText}
    </div>,
    document.body,
  ) : null;

  if (!canEdit) {
    return (
      <div
        onMouseEnter={handleCellMouseEnter}
        onMouseMove={handleCellMouseMove}
        onMouseLeave={handleCellMouseLeave}
        style={{ cursor: inferredIconData ? "default" : undefined }}
      >
        <div className="flex items-center gap-1">
          <p className={cn("text-[13px]", dateTextColor)}>
            {displayDate || "-"}
          </p>
          {inferredIcon}
        </div>
        {remarksLine}
        {originalLine}
        {cellTooltipEl}
      </div>
    );
  }

  return (
    <div
      className="relative space-y-0.5"
      onMouseEnter={handleCellMouseEnter}
      onMouseMove={handleCellMouseMove}
      onMouseLeave={handleCellMouseLeave}
    >
      {cellTooltipEl}
      {/* Lock icon (top-right, only when not in edit mode) */}
      {!unlocked && (
        <div className="absolute top-0 right-0 mt-0.5 mr-0.5">
          <button
            onClick={() => setOverrideOpen(true)}
            className="text-gray-300 hover:text-[#fd5108] transition-colors"
            title="Override date"
            data-no-drag="true"
            data-testid={`button-avail-lock-${order.id}`}
          >
            <Lock className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className={unlocked ? "" : "pr-5"}>
        {unlocked ? (
          <div>
            <Input
              type="date"
              value={editValue}
              min={todayIso()}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleEditKeyDown}
              autoFocus
              className={cn(
                "border-0 border-b border-[#fd5108] bg-transparent shadow-none rounded-none px-0 h-6 text-xs focus-visible:ring-0 focus-visible:ring-offset-0 w-32",
              )}
              data-testid={`input-avail-date-${order.id}`}
            />
            <div className="flex gap-1 mt-1">
              <Button
                size="sm"
                className="h-5 text-[10px] bg-[#fd5108] hover:bg-[#fe7c39] px-2"
                onClick={handleDone}
                disabled={!editValue}
                data-no-drag="true"
                data-testid={`button-avail-save-${order.id}`}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-5 text-[10px] px-2"
                onClick={handleCancel}
                data-no-drag="true"
                data-testid={`button-avail-cancel-${order.id}`}
              >
                Cancel
              </Button>
              {isModifiedFromOriginal && origVal && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-5 text-[10px] px-2 text-red-500 border-red-200 hover:bg-red-50"
                  onClick={() => setRevertOpen(true)}
                  data-no-drag="true"
                  data-testid={`button-avail-revert-${order.id}`}
                >
                  Revert
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-1">
              <p className={cn("text-[13px]", dateTextColor)}>
                {displayDate || "-"}
              </p>
              {inferredIcon}
            </div>
            {remarksLine}
            {originalLine}
          </div>
        )}
      </div>

      {/* Override confirmation dialog */}
      {overrideOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={() => setOverrideOpen(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl p-6 w-full max-w-[480px] mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[18px] font-bold text-gray-900 mb-2">
              Override Avail Date
            </p>
            <p className="text-[14px] leading-relaxed text-gray-500 mb-4">
              This will allow you to set a new availability date for this order.
            </p>
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                className="text-[14px] font-semibold h-10 px-5"
                onClick={() => setOverrideOpen(false)}
              >
                Cancel
              </Button>
              <Button
                className="bg-[#fd5108] hover:bg-[#fe7c39] text-[14px] font-semibold h-10 px-5"
                onClick={handleProceed}
              >
                Proceed
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Revert confirmation dialog */}
      {revertOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={() => setRevertOpen(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl p-6 w-full max-w-[480px] mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[18px] font-bold text-gray-900 mb-2">
              ↩ Revert Availability Date
            </p>
            <p className="text-[14px] leading-relaxed text-gray-500 mb-4">
              Revert to the original SAP value?
            </p>
            <div className="bg-gray-50 rounded-lg p-3 mb-5 space-y-2 text-[14px]">
              <div className="flex gap-3">
                <span className="text-gray-400 w-20 shrink-0">Current:</span>
                <span className="text-gray-700 font-semibold">
                  {displayDate || "-"}
                </span>
              </div>
              <div className="flex gap-3">
                <span className="text-gray-400 w-20 shrink-0">Original:</span>
                <span className="text-gray-700 font-semibold">
                  {origDisplay || "-"}
                </span>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                className="text-[14px] font-semibold h-10 px-5"
                onClick={() => setRevertOpen(false)}
              >
                Go Back
              </Button>
              <Button
                className="bg-[#fd5108] hover:bg-[#fe7c39] text-[14px] font-semibold h-10 px-5"
                onClick={handleRevertConfirm}
              >
                Confirm Revert
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Revert success toast */}
      {revertToastMsg && (
        <div
          onMouseEnter={() => clearTimeout(revertTimerRef.current)}
          onMouseLeave={() => {
            revertTimerRef.current = setTimeout(
              () => setRevertToastMsg(null),
              60000,
            );
          }}
          style={{
            position: "fixed",
            bottom: 28,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 9999,
            background: "#1f2937",
            color: "white",
            borderRadius: 8,
            padding: "10px 18px",
            fontSize: 13,
            boxShadow: "0 4px 20px rgba(0,0,0,0.2)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            whiteSpace: "nowrap",
          }}
        >
          {revertToastMsg}
          <button
            onClick={() => setRevertToastMsg(null)}
            style={{
              background: "none",
              border: "none",
              color: "rgba(255,255,255,0.6)",
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
              padding: 0,
              marginLeft: 4,
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function CompletionDateCell({ order, canEdit, onUpdate }) {
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [revertOpen, setRevertOpen] = useState(false);
  const [editDate, setEditDate] = useState("");
  const [editTimeH, setEditTimeH] = useState("12");
  const [editTimeM, setEditTimeM] = useState("00");
  const [editTimeAP, setEditTimeAP] = useState("PM");

  const val = order.target_completion_date;
  const isManual = order.target_completion_manual;

  const m = val?.match(
    /(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d+):(\d+)\s*(AM|PM)/i,
  );
  let displayDate = "";
  let displayTime = "";
  if (m) {
    const datePart = `${m[3]}-${m[1]}-${m[2]}`;
    displayDate = formatLongDate(datePart);
    displayTime = `${m[4]}:${m[5]} ${m[6]}`;
  }

  const handleProceed = () => {
    setUnlocked(true);
    setOverrideOpen(false);
    if (m) {
      setEditDate(`${m[3]}-${m[1]}-${m[2]}`);
      const raw4 = parseInt(m[4]);
      const ap = m[6].toUpperCase();
      const h12 = raw4 % 12 || 12;
      setEditTimeH(String(h12).padStart(2, "0"));
      setEditTimeM(m[5]);
      setEditTimeAP(ap);
    } else {
      setEditTimeH("12"); setEditTimeM("00"); setEditTimeAP("PM");
    }
  };

  const handleSaveOverride = () => {
    if (editDate) {
      const d = new Date(editDate);
      if (!isNaN(d.getTime())) {
        const [y, mo, dy] = editDate.split("-");
        let h = parseInt(editTimeH) || 12;
        if (h === 0 || h > 12) h = h % 12 || 12;
        const min = Math.min(59, Math.max(0, parseInt(editTimeM) || 0));
        const timeStr = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")} ${editTimeAP}`;
        const completionStr = `${mo}/${dy}/${y} - ${timeStr}`;
        onUpdate(order.id, {
          target_completion_date: completionStr,
          target_completion_manual: true,
        });
      }
    }
    setUnlocked(false);
  };

  const handleRevert = () => {
    onUpdate(order.id, { target_completion_manual: false });
    setRevertOpen(false);
  };

  const isCompleted = order.status === "completed";
  const conflicts = getDateConflicts(order);
  const hasConflict = conflicts.completion_date === "conflict";
  // Max = avail date minus 1 day (completion must be strictly before avail)
  // Use local date parts to avoid UTC-shift from toISOString()
  const availMax = (() => {
    if (!isRealAvailDate(order.target_avail_date)) return undefined;
    const d = new Date(order.target_avail_date + "T00:00:00");
    d.setDate(d.getDate() - 1);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const dy = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${dy}`;
  })();
  const startMin = order.start_date && order.start_date > todayIso() ? order.start_date : todayIso();

  const [compCellTooltip, setCompCellTooltip] = useState(false);
  const [compCellTipPos, setCompCellTipPos] = useState({ x: 0, y: 0 });
  const compCellTimer = useRef(null);
  function compClamp(x, y, w, h) {
    const vw = window.innerWidth, vh = window.innerHeight, pad = 8;
    if (x + w + pad > vw) x = x - w - 24;
    if (y + h + pad > vh) y = y - h - 24;
    if (x < pad) x = pad; if (y < pad) y = pad;
    return { x, y };
  }
  const compHasTooltip = hasConflict || isManual;
  function handleCompCellEnter(e) {
    if (!compHasTooltip) return;
    clearTimeout(compCellTimer.current);
    compCellTimer.current = setTimeout(() => {
      setCompCellTipPos(compClamp(e.clientX + 12, e.clientY + 12, 270, 60));
      setCompCellTooltip(true);
    }, 300);
  }
  function handleCompCellMove(e) {
    if (!compHasTooltip || !compCellTooltip) return;
    setCompCellTipPos(compClamp(e.clientX + 12, e.clientY + 12, 270, 60));
  }
  function handleCompCellLeave() {
    clearTimeout(compCellTimer.current);
    setCompCellTooltip(false);
  }
  const compTipMsg = hasConflict
    ? "Completion date must be at least 1 day before the availability date (or before the start date)."
    : "Completion date manually overridden";
  const compCellTipEl = compCellTooltip && compHasTooltip ? createPortal(
    <div style={{ position: "fixed", left: compCellTipPos.x, top: compCellTipPos.y, zIndex: 9999, background: "#1e293b", color: "#f1f5f9", padding: "8px 12px", borderRadius: 8, fontSize: 12, lineHeight: 1.5, maxWidth: 270, boxShadow: "0 4px 20px rgba(0,0,0,0.3)", pointerEvents: "none" }}>
      {compTipMsg}
    </div>, document.body,
  ) : null;

  if (!val) {
    return (
      <div className="relative">
        <span className="text-[13px] italic" style={{ color: "#d5dbe2" }}>
          Set completion
        </span>
      </div>
    );
  }

  if (isCompleted) {
    return (
      <div style={{ opacity: 0.6 }}>
        <p className="text-[13px] italic" style={{ color: "#c0c7d0" }}>
          {displayDate || val}
        </p>
        {displayTime && (
          <p className="text-[13px] italic" style={{ color: "#c0c7d0" }}>
            {displayTime}
          </p>
        )}
      </div>
    );
  }

  if (!canEdit) {
    return (
      <div
        style={hasConflict ? { background: "#fef2f2", borderRadius: 4, padding: "2px 4px", margin: "-2px -4px" } : undefined}
        onMouseEnter={handleCompCellEnter}
        onMouseMove={handleCompCellMove}
        onMouseLeave={handleCompCellLeave}
      >
        {compCellTipEl}
        <div className="flex items-center gap-1">
          <p className="text-[13px] text-[#2e343a]">{displayDate || val}</p>
          {hasConflict && <AlertTriangle style={{ width: 11, height: 11, color: "#dc2626", flexShrink: 0 }} />}
        </div>
        {displayTime && (
          <p className="text-[13px] text-[#2e343a]">
            {displayTime}
            {isManual ? " | ✎" : ""}
          </p>
        )}
      </div>
    );
  }

  if (unlocked) {
    return (
      <div className="space-y-1">
        <div className="group">
          <Input
            type="date"
            value={editDate}
            min={startMin}
            max={availMax}
            onChange={(e) => setEditDate(e.target.value)}
            className={cn(
              "border-0 border-b border-[#fd5108] bg-transparent shadow-none rounded-none px-0 h-6 text-xs focus-visible:ring-0 w-32",
            )}
            data-testid={`input-completion-date-${order.id}`}
          />
        </div>
        <div className="flex items-center gap-1 mt-0.5">
          <Input
            type="text"
            value={editTimeH}
            onChange={(e) => setEditTimeH(e.target.value.replace(/\D/g, "").slice(0, 2))}
            onBlur={() => { let h = parseInt(editTimeH) || 12; if (h === 0) h = 12; if (h > 12) h = 12; setEditTimeH(String(h).padStart(2, "0")); }}
            className="border border-gray-300 focus:border-[#fd5108] bg-transparent shadow-none rounded px-1 h-6 text-xs focus-visible:ring-0 w-8 text-center"
            data-testid={`input-completion-time-hours-${order.id}`}
            maxLength={2}
          />
          <span className="text-xs text-gray-400">:</span>
          <Input
            type="text"
            value={editTimeM}
            onChange={(e) => setEditTimeM(e.target.value.replace(/\D/g, "").slice(0, 2))}
            onBlur={() => { let m = parseInt(editTimeM) || 0; if (m > 59) m = 59; setEditTimeM(String(m).padStart(2, "0")); }}
            className="border border-gray-300 focus:border-[#fd5108] bg-transparent shadow-none rounded px-1 h-6 text-xs focus-visible:ring-0 w-8 text-center"
            data-testid={`input-completion-time-minutes-${order.id}`}
            maxLength={2}
          />
          <div className="flex ml-1">
            <button onClick={() => setEditTimeAP("AM")} className={cn("px-1.5 py-0.5 text-[9px] font-semibold rounded-l border transition-colors", editTimeAP === "AM" ? "bg-[#fd5108] text-white border-[#fd5108]" : "bg-gray-100 text-gray-500 border-gray-300 hover:bg-gray-200")} data-no-drag="true">AM</button>
            <button onClick={() => setEditTimeAP("PM")} className={cn("px-1.5 py-0.5 text-[9px] font-semibold rounded-r border-t border-r border-b transition-colors", editTimeAP === "PM" ? "bg-[#fd5108] text-white border-[#fd5108]" : "bg-gray-100 text-gray-500 border-gray-300 hover:bg-gray-200")} data-no-drag="true">PM</button>
          </div>
        </div>
        <div className="flex gap-1 mt-1">
          <Button
            size="sm"
            className="h-5 text-[10px] bg-[#fd5108] hover:bg-[#fe7c39] px-2"
            onClick={handleSaveOverride}
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-5 text-[10px] px-2"
            onClick={() => setUnlocked(false)}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative"
      style={hasConflict ? { background: "#fef2f2", borderRadius: 4, padding: "2px 4px", margin: "-2px -4px" } : undefined}
      onMouseEnter={handleCompCellEnter}
      onMouseMove={handleCompCellMove}
      onMouseLeave={handleCompCellLeave}
    >
      {compCellTipEl}
      <div className="absolute top-0 right-0 mt-0.5 mr-0.5">
        {isManual ? (
          <button
            onClick={() => setRevertOpen(true)}
            className="text-[#fd5108] hover:text-[#fe7c39] transition-colors"
            title="Completion date overridden — click to revert"
            data-no-drag="true"
            data-testid={`button-completion-unlock-${order.id}`}
          >
            <Unlock className="h-3 w-3" />
          </button>
        ) : (
          <button
            onClick={() => setOverrideOpen(true)}
            className="text-gray-300 hover:text-[#fd5108] transition-colors"
            title="Override completion date"
            data-no-drag="true"
            data-testid={`button-completion-lock-${order.id}`}
          >
            <Lock className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="pr-5">
        <div className="flex items-center gap-1">
          <p className="text-[13px] text-[#2e343a]">{displayDate || val}</p>
          {hasConflict && <AlertTriangle style={{ width: 11, height: 11, color: "#dc2626", flexShrink: 0 }} />}
        </div>
        {displayTime && (
          <p className="text-[13px] text-[#2e343a]">
            {displayTime}
            {isManual ? " | ✎" : ""}
          </p>
        )}
      </div>

      {overrideOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={() => setOverrideOpen(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl p-6 w-full max-w-[480px] mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[18px] font-bold text-gray-900 mb-2">
              Override Completion Date
            </p>
            <p className="text-[14px] leading-relaxed text-gray-500 mb-3">
              You are about to override the calculated Completion Date. Please
              be aware of the following:
            </p>
            <ul className="text-[13px] text-gray-500 mb-4 space-y-1.5 list-disc pl-4">
              <li>
                The Completion Date will no longer auto-calculate based on Start
                Date, Production Hours, and Changeover Time.
              </li>
              <li>
                All downstream orders in this feedmill line will have their
                Completion Date recalculated based on your new date.
              </li>
              <li>
                If you later edit Start Date, Start Time, or Volume, the
                Completion Date will NOT auto-recalculate — it will retain your
                overridden value until you remove the override.
              </li>
            </ul>
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                className="text-[14px] font-semibold h-10 px-5"
                onClick={() => setOverrideOpen(false)}
              >
                Cancel
              </Button>
              <Button
                className="bg-[#fd5108] hover:bg-[#fe7c39] text-[14px] font-semibold h-10 px-5"
                onClick={handleProceed}
              >
                Proceed
              </Button>
            </div>
          </div>
        </div>
      )}

      {revertOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={() => setRevertOpen(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl p-6 w-full max-w-[480px] mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[18px] font-bold text-gray-900 mb-2">
              Revert Completion Date
            </p>
            <p className="text-[14px] leading-relaxed text-gray-500 mb-4">
              Revert to auto-calculated Completion Date? This will recalculate
              based on Start Date/Time + Production Hours + Changeover Time.
            </p>
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                className="text-[14px] font-semibold h-10 px-5"
                onClick={() => setRevertOpen(false)}
              >
                Cancel
              </Button>
              <Button
                className="bg-[#fd5108] hover:bg-[#fe7c39] text-[14px] font-semibold h-10 px-5"
                onClick={handleRevert}
              >
                Revert
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EndDateCell({ order, canEditDirect, onUpdate }) {
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [editDate, setEditDate] = useState("");
  const [editTimeH, setEditTimeH] = useState("12");
  const [editTimeM, setEditTimeM] = useState("00");
  const [editTimeAP, setEditTimeAP] = useState("PM");
  const [endWarnOpen, setEndWarnOpen] = useState(false);
  const isCompleted = order.status === "completed";

  const conflicts = getDateConflicts(order);
  const endConflict = conflicts.end_date; // "conflict" | "info" | undefined
  const availForWarn = isRealAvailDate(order.target_avail_date) ? order.target_avail_date : null;
  const startMin = order.start_date || undefined;
  const endHasWarning = endConflict === "conflict" || endConflict === "info";

  const [endCellTooltip, setEndCellTooltip] = useState(false);
  const [endCellTipPos, setEndCellTipPos] = useState({ x: 0, y: 0 });
  const endCellTimer = useRef(null);
  function endClamp(x, y, w, h) {
    const vw = window.innerWidth, vh = window.innerHeight, pad = 8;
    if (x + w + pad > vw) x = x - w - 24;
    if (y + h + pad > vh) y = y - h - 24;
    if (x < pad) x = pad; if (y < pad) y = pad;
    return { x, y };
  }
  function handleEndCellEnter(e) {
    if (!endHasWarning) return;
    clearTimeout(endCellTimer.current);
    endCellTimer.current = setTimeout(() => {
      setEndCellTipPos(endClamp(e.clientX + 12, e.clientY + 12, 280, 60));
      setEndCellTooltip(true);
    }, 300);
  }
  function handleEndCellMove(e) {
    if (!endHasWarning || !endCellTooltip) return;
    setEndCellTipPos(endClamp(e.clientX + 12, e.clientY + 12, 280, 60));
  }
  function handleEndCellLeave() {
    clearTimeout(endCellTimer.current);
    setEndCellTooltip(false);
  }
  const endCellTipMsg = endConflict === "conflict"
    ? "End date is before the start date — this may indicate a data entry error."
    : "End date is before the availability date — production was completed ahead of schedule.";
  const endCellTipEl = endCellTooltip && endHasWarning ? createPortal(
    <div style={{ position: "fixed", left: endCellTipPos.x, top: endCellTipPos.y, zIndex: 9999, background: "#1e293b", color: "#f1f5f9", padding: "8px 12px", borderRadius: 8, fontSize: 12, lineHeight: 1.5, maxWidth: 280, boxShadow: "0 4px 20px rgba(0,0,0,0.3)", pointerEvents: "none" }}>
      {endCellTipMsg}
    </div>, document.body,
  ) : null;

  function parseTime12FromStr(t) {
    if (!t) return { h: "12", m: "00", ap: "PM" };
    const mx = String(t).match(/(\d+):(\d+)\s*(am|pm)?/i);
    if (!mx) return { h: "12", m: "00", ap: "PM" };
    let h24 = parseInt(mx[1]);
    const min = mx[2];
    const ap = h24 >= 12 ? "PM" : "AM";
    const h12 = h24 % 12 || 12;
    return { h: String(h12).padStart(2, "0"), m: min, ap };
  }

  const handleProceed = () => {
    if (confirmText.toLowerCase() !== "confirm") return;
    setEditDate(order.end_date || "");
    const t = parseTime12FromStr(order.end_time);
    setEditTimeH(t.h); setEditTimeM(t.m); setEditTimeAP(t.ap);
    setUnlocked(true);
    setOverrideOpen(false);
    setConfirmText("");
  };

  const doSave = () => {
    let h = parseInt(editTimeH) || 12;
    if (editTimeAP === "PM" && h < 12) h += 12;
    if (editTimeAP === "AM" && h === 12) h = 0;
    const min = Math.min(59, Math.max(0, parseInt(editTimeM) || 0));
    const timeStr = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    onUpdate(order.id, { end_date: editDate, end_time: timeStr || null });
    setUnlocked(false);
    setEditDate(""); setEditTimeH("12"); setEditTimeM("00"); setEditTimeAP("PM");
    setEndWarnOpen(false);
  };

  const handleOk = () => {
    if (!editDate) return;
    if (availForWarn && editDate < availForWarn) {
      setEndWarnOpen(true);
      return;
    }
    doSave();
  };

  const handleCancelEdit = () => {
    setUnlocked(false);
    setEditDate(""); setEditTimeH("12"); setEditTimeM("00"); setEditTimeAP("PM");
    setEndWarnOpen(false);
  };

  if (!order.end_date && !isCompleted && !canEditDirect) {
    if (order.status === "cancel_po") {
      return (
        <span className="text-[11px] text-gray-400 italic">Cancelled</span>
      );
    }
    return <span className="text-xs text-gray-400">-</span>;
  }

  if (canEditDirect) {
    const conflictStyle =
      endConflict === "conflict"
        ? { background: "#fef2f2", borderRadius: 4, padding: "2px 4px", margin: "-2px -4px" }
        : endConflict === "info"
          ? { background: "#fefce8", borderRadius: 4, padding: "2px 4px", margin: "-2px -4px" }
          : undefined;
    return (
      <div
        className="relative space-y-0.5"
        style={unlocked ? undefined : conflictStyle}
        onMouseEnter={unlocked ? undefined : handleEndCellEnter}
        onMouseMove={unlocked ? undefined : handleEndCellMove}
        onMouseLeave={unlocked ? undefined : handleEndCellLeave}
      >
        {!unlocked && endCellTipEl}
        {!unlocked && (
          <div className="absolute top-0 right-0 mt-0.5 mr-0.5">
            <button
              onClick={() => setOverrideOpen(true)}
              className="text-gray-300 hover:text-[#fd5108]"
              title="Override end date"
              data-no-drag="true"
              data-testid={`button-end-lock-${order.id}`}
            >
              <Lock className="h-3 w-3" />
            </button>
          </div>
        )}
        <div className="pr-5">
          {unlocked ? (
            <div className="space-y-1">
              <Input
                type="date"
                value={editDate}
                min={startMin}
                onChange={(e) => setEditDate(e.target.value)}
                autoFocus
                className={cn(
                  "border-0 border-b border-[#fd5108] bg-transparent shadow-none rounded-none px-0 h-6 text-xs focus-visible:ring-0 w-28",
                )}
                data-testid={`input-end-date-${order.id}`}
              />
              <div className="flex items-center gap-1">
                <Input
                  type="text"
                  value={editTimeH}
                  onChange={(e) => setEditTimeH(e.target.value.replace(/\D/g, "").slice(0, 2))}
                  onBlur={() => { let h = parseInt(editTimeH) || 12; if (h === 0) h = 12; if (h > 12) h = 12; setEditTimeH(String(h).padStart(2, "0")); }}
                  className="border border-gray-300 focus:border-[#fd5108] bg-transparent shadow-none rounded px-1 h-6 text-xs focus-visible:ring-0 w-8 text-center"
                  data-testid={`input-end-time-hours-${order.id}`}
                  maxLength={2}
                />
                <span className="text-xs text-gray-400">:</span>
                <Input
                  type="text"
                  value={editTimeM}
                  onChange={(e) => setEditTimeM(e.target.value.replace(/\D/g, "").slice(0, 2))}
                  onBlur={() => { let m = parseInt(editTimeM) || 0; if (m > 59) m = 59; setEditTimeM(String(m).padStart(2, "0")); }}
                  className="border border-gray-300 focus:border-[#fd5108] bg-transparent shadow-none rounded px-1 h-6 text-xs focus-visible:ring-0 w-8 text-center"
                  data-testid={`input-end-time-minutes-${order.id}`}
                  maxLength={2}
                />
                <div className="flex ml-1">
                  <button onClick={() => setEditTimeAP("AM")} className={cn("px-1.5 py-0.5 text-[9px] font-semibold rounded-l border transition-colors", editTimeAP === "AM" ? "bg-[#fd5108] text-white border-[#fd5108]" : "bg-gray-100 text-gray-500 border-gray-300 hover:bg-gray-200")} data-no-drag="true">AM</button>
                  <button onClick={() => setEditTimeAP("PM")} className={cn("px-1.5 py-0.5 text-[9px] font-semibold rounded-r border-t border-r border-b transition-colors", editTimeAP === "PM" ? "bg-[#fd5108] text-white border-[#fd5108]" : "bg-gray-100 text-gray-500 border-gray-300 hover:bg-gray-200")} data-no-drag="true">PM</button>
                </div>
              </div>
              <div className="flex gap-1 mt-1">
                <Button
                  size="sm"
                  className="h-5 text-[10px] bg-[#fd5108] hover:bg-[#fe7c39] px-2"
                  onClick={handleOk}
                  disabled={!editDate}
                  data-no-drag="true"
                  data-testid={`button-end-save-${order.id}`}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-5 text-[10px] px-2"
                  onClick={handleCancelEdit}
                  data-no-drag="true"
                  data-testid={`button-end-cancel-${order.id}`}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <div>
                <p className="text-[13px] text-gray-700">
                  {formatLongDate(order.end_date) || "-"}
                </p>
                {order.end_time && (
                  <p className="text-[13px] text-[#6b7280]">
                    {formatTime12(order.end_time)}
                  </p>
                )}
              </div>
              {endConflict === "conflict" && (
                <AlertTriangle style={{ width: 11, height: 11, color: "#dc2626", flexShrink: 0 }} />
              )}
              {endConflict === "info" && (
                <AlertTriangle style={{ width: 11, height: 11, color: "#ca8a04", flexShrink: 0 }} />
              )}
            </div>
          )}
        </div>

        {/* End Date Before Avail warning dialog */}
        {endWarnOpen && createPortal(
          <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/30" onClick={() => setEndWarnOpen(false)}>
            <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-[440px] mx-4" onClick={(e) => e.stopPropagation()}>
              <p className="text-[17px] font-bold text-gray-900 mb-2">End Date Before Availability Date</p>
              <p className="text-[13px] text-gray-600 leading-relaxed mb-2">
                The selected end date ({formatLongDate(editDate)}) is before the availability date ({formatLongDate(availForWarn)}).
                This means production was completed before the customer's target deadline.
              </p>
              <p className="text-[13px] text-gray-600 leading-relaxed mb-5">Do you want to proceed with this end date?</p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setEndWarnOpen(false)}
                  style={{ height: 38, padding: "0 18px", fontSize: 13, fontWeight: 500, background: "white", border: "1px solid #d1d5db", borderRadius: 6, color: "#374151", cursor: "pointer" }}
                >
                  Cancel
                </button>
                <button
                  onClick={doSave}
                  style={{ height: 38, padding: "0 18px", fontSize: 13, fontWeight: 600, background: "#fd5108", border: "none", borderRadius: 6, color: "white", cursor: "pointer" }}
                >
                  Proceed Anyway
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

        {overrideOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
            onClick={() => setOverrideOpen(false)}
          >
            <div
              className="bg-white rounded-xl shadow-xl p-6 w-full max-w-[480px] mx-4"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="text-[18px] font-bold text-gray-900 mb-2">
                Override End Date
              </p>
              <p className="text-[14px] leading-relaxed text-gray-500 mb-3">
                Type <strong>Confirm</strong> to proceed with overriding the end
                date.
              </p>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder='Type "Confirm"'
                className="mb-4 text-[14px] md:text-[14px]"
                autoFocus
              />
              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  className="text-[14px] font-semibold h-10 px-5"
                  onClick={() => {
                    setOverrideOpen(false);
                    setConfirmText("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  className="bg-[#fd5108] hover:bg-[#fe7c39] text-[14px] font-semibold h-10 px-5"
                  disabled={confirmText.toLowerCase() !== "confirm"}
                  onClick={handleProceed}
                >
                  Proceed
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const roConflictStyle =
    endConflict === "conflict"
      ? { background: "#fef2f2", borderRadius: 4, padding: "2px 4px", margin: "-2px -4px" }
      : endConflict === "info"
        ? { background: "#fefce8", borderRadius: 4, padding: "2px 4px", margin: "-2px -4px" }
        : undefined;
  return (
    <div
      style={roConflictStyle}
      onMouseEnter={handleEndCellEnter}
      onMouseMove={handleEndCellMove}
      onMouseLeave={handleEndCellLeave}
    >
      {endCellTipEl}
      <div className="flex items-center gap-1">
        <p className="text-[13px] text-gray-700">
          {formatLongDate(order.end_date) || "-"}
        </p>
        {endConflict === "conflict" && (
          <AlertTriangle style={{ width: 11, height: 11, color: "#dc2626", flexShrink: 0 }} />
        )}
        {endConflict === "info" && (
          <AlertTriangle style={{ width: 11, height: 11, color: "#ca8a04", flexShrink: 0 }} />
        )}
      </div>
      {order.end_time && (
        <p className="text-[13px] text-[#6b7280]">
          {formatTime12(order.end_time)}
        </p>
      )}
    </div>
  );
}
