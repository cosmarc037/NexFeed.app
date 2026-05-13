import React, { useState, useEffect, useMemo, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import * as XLSX from "xlsx";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/notifications";

import { LINE_TO_FM, calculateAdditionalChangeover } from "@/utils/changeoverCalc";
import Header from "../components/layout/Header";
import Sidebar, { FEEDMILL_LINES } from "../components/layout/Sidebar";
import TourGuide from "../components/tour/TourGuide";
import SearchFilter from "../components/orders/SearchFilter";
import KeyMetrics from "../components/orders/KeyMetrics";
import UploadModal from "../components/orders/UploadModal";
import CutCombineModal from "../components/orders/CutCombineModal";
import OverviewDashboard from "../components/overview/OverviewDashboard";
import AnalyticsDashboard from "../components/analytics/AnalyticsDashboard";
import AIChatbot from "../components/chat/AIChatbot";
import SmartCombinePanel from "../components/orders/SmartCombinePanel";
import ExportButton from "../components/orders/ExportButton";
import ConfirmDialog from "../components/orders/ConfirmDialog";
import ReasonDialog from "../components/orders/ReasonDialog";
import ProduceAsIndependentDialog from "../components/orders/ProduceAsIndependentDialog";
import MinVolumeCheckDialog from "../components/orders/MinVolumeCheckDialog";
import PendingRevertDialog from "../components/orders/PendingRevertDialog";
import PlannedOrdersContent from "../components/orders/PlannedOrdersContent";
import { DivertOrderDialog, RevertOrderDialog } from "../components/orders/DivertOrderDialog";
import OrderTable from "../components/orders/OrderTable";
import UncombineOrderDialog from "../components/orders/UncombineOrderDialog";
import AutoSequenceModal from "../components/orders/AutoSequenceModal";
import PlantAutoSequenceModal, { applyPreviewChangeovers } from "../components/orders/PlantAutoSequenceModal";
import LineAutoSequenceModal from "../components/orders/LineAutoSequenceModal";
import FeedmillAutoSequenceModal from "../components/orders/FeedmillAutoSequenceModal";
import KnowledgeBaseManager from "../components/orders/KnowledgeBaseManager";
import Next10DaysManager from "../components/orders/Next10DaysManager";
import ChangeoverRulesPage, { getDefaultChangeoverRules } from "./ChangeoverRulesPage";
import CancelOrderDialog from "../components/orders/CancelOrderDialog";
import AddOrderDialog from "../components/orders/AddOrderDialog";
import RestoreOrderDialog from "../components/orders/RestoreOrderDialog";
import CutOrderDialog from "../components/orders/CutOrderDialog";
import MergeBackDialog from "../components/orders/MergeBackDialog";
import {
  StatusBadge,
  getStatusLabel,
} from "../components/orders/StatusDropdown";
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
import { getMinMT } from "@/components/utils/orderUtils";
import { autoSequenceOrders, preSortOrders, buildInsightTemplates, callPlantActionsAI, buildPlantActionsPrompt, parsePlantActionsResponse, enrichStrategiesWithRowInsights } from "@/services/azureAI";
import { generateSequenceStrategies } from "@/services/aiSequenceStrategies";
import { setTemplateInsights, hasInsights, getInsight } from "@/utils/insightCache";
import { getProductStatus } from "@/utils/statusUtils";

// ─── Feature flags — set to true to re-enable ───────────────────────────────
const SHOW_SMART_COMBINE_PANEL = false;
// ────────────────────────────────────────────────────────────────────────────

// Utility functions inlined to avoid module resolution issues
const parseTargetDate = (remarks, fpr) => {
  if (!remarks) return null;
  const datePattern = /(?:TLD\s*\|\s*)?([A-Za-z]+)\s+(\d{1,2})/i;
  const match = remarks.match(datePattern);
  if (match) {
    const monthStr = match[1];
    const day = parseInt(match[2]);
    const months = {
      january: 0, february: 1, march: 2, april: 3,
      may: 4, june: 5, july: 6, august: 7,
      september: 8, october: 9, november: 10, december: 11,
      jan: 0, feb: 1, mar: 2, apr: 3,
      jun: 5, jul: 6, aug: 7,
      sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const targetMonth = months[monthStr.toLowerCase()];
    if (targetMonth === undefined) return remarks;

    let fprYear = new Date().getFullYear();
    let fprMonth = new Date().getMonth();
    let fprDate = new Date();
    const fprStr = String(fpr || "").trim();
    if (fprStr.length >= 6) {
      const yy = parseInt(fprStr.substring(0, 2));
      const mm = parseInt(fprStr.substring(2, 4));
      const dd = parseInt(fprStr.substring(4, 6));
      if (!isNaN(yy) && !isNaN(mm) && mm >= 1 && mm <= 12 && !isNaN(dd)) {
        fprYear = 2000 + yy;
        fprMonth = mm - 1;
        fprDate = new Date(fprYear, fprMonth, dd);
      }
    }

    let year;
    if (targetMonth >= fprMonth) {
      year = fprYear;
    } else {
      year = fprYear + 1;
    }

    const mm = String(targetMonth + 1).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    return `${year}-${mm}-${dd}`;
  }
  return remarks;
};

const filterByFeedmillTab = (orders, tab) => {
  if (tab === "all" || tab === "ALL_FM") return orders;
  const lineMap = {
    FM1: ["Line 1", "Line 2"],
    FM2: ["Line 3", "Line 4"],
    FM3: ["Line 6", "Line 7"],
    PMX: ["Line 5"],
  };
  const validLines = lineMap[tab] || [];
  return orders.filter((order) => validLines.includes(order.feedmill_line));
};

const parseSAPOrder = (row) => {
  const fpr = String(row.FPR || row.fpr || "");
  const targetDate = parseTargetDate(row.Remarks || row.remarks, fpr);
  return {
    fpr,
    material_code: String(row["Material Code"] || row.material_code || ""),
    item_description: row["Item Description"] || row.item_description || "",
    category: row.Category || row.category || "",
    feedmill_line: row["Feedmill Line"] || row.feedmill_line || "",
    total_volume_mt: parseFloat(
      row["Metric Ton"] || row.metric_ton || row.total_volume_mt || 0,
    ),
    form: "",
    batch_size: 4,
    target_avail_date: targetDate,
    original_avail_date: targetDate,
    start_date: null,
    start_time: null,
    production_hours: null,
    changeover_time: 0.17,
    run_rate: null,
    ha_available: null,
    formula_version: "",
    prod_version: "",
    fg: String(row.FG || row.fg || ""),
    sfg: String(row.SFG || row.sfg || ""),
    sfg1: "",
    sap_sfg1: String(row.SFG1 || row.sfg1 || ""),
    pmx: "",
    sfgpmx: "",
    ha_prep_form_issuance: "",
    remarks: row.Remarks || row.remarks || "",
    prod_remarks: "",
    priority_seq: row["Prio. Seq."] || row["Seq."] || row.priority_seq || null,
    po_status: row["PO STATUS"] || row["PO Status"] || row["po status"] || "",
    status: "normal",
  };
};

// --- Scheduling helpers ---

/**
 * Auto-calculate production hours from volume / run_rate.
 * Returns null if Form === 'M', no run_rate, or no volume.
 */
const getEffVolume = (order) => {
  if (order.volume_override != null && order.volume_override !== "") {
    return parseFloat(order.volume_override);
  }
  const orig = parseFloat(order.total_volume_mt) || 0;
  const bs = parseFloat(order.batch_size) || 4;
  if (bs <= 0) return orig;
  return Math.ceil(orig / bs) * bs;
};

const calcProductionHours = (order) => {
  if (!order || order.form === "M") return null;
  const rr = parseFloat(order.run_rate);
  const vol = getEffVolume(order);
  if (!rr || rr <= 0 || !vol || vol <= 0) return null;
  return parseFloat((vol / rr).toFixed(2));
};

/**
 * Calculate target completion as a Date object.
 * If production_hours is null/blank, only adds changeover_time.
 */
const calcCompletionDate = (
  startDate,
  startTime,
  productionHours,
  changeoverTime,
) => {
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
};

const formatCompletionDate = (d) => {
  if (!d || isNaN(d.getTime())) return "";
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dy = String(d.getDate()).padStart(2, "0");
  const yr = d.getFullYear();
  let h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${mo}/${dy}/${yr} - ${String(h).padStart(2, "0")}:${min} ${ampm}`;
};

/**
 * Given an updated order (with new fields applied), compute production_hours + target_completion_date.
 * Respects manual overrides for both fields.
 */
const computeScheduleFields = (order) => {
  // Production hours — only auto-calc if not manually set
  let ph = order.production_hours;
  if (!order.production_hours_manual) {
    ph = calcProductionHours(order);
  }
  // Target completion — only auto-calc if not manually overridden
  let tcd = order.target_completion_date;
  let tcdManual = order.target_completion_manual;
  if (!tcdManual) {
    const d = calcCompletionDate(
      order.start_date,
      order.start_time,
      ph,
      order.changeover_time ?? 0.17,
    );
    tcd = d ? formatCompletionDate(d) : "";
  }
  return {
    production_hours: ph,
    target_completion_date: tcd,
    target_completion_manual: tcdManual,
  };
};

/** Parse "MM/DD/YYYY - HH:MM AM/PM" back to a Date */
const parseCompletionDateStr = (str) => {
  if (!str) return null;
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[4]);
  const min = parseInt(m[5]);
  if (m[6].toUpperCase() === "PM" && h < 12) h += 12;
  if (m[6].toUpperCase() === "AM" && h === 12) h = 0;
  return new Date(
    parseInt(m[3]),
    parseInt(m[1]) - 1,
    parseInt(m[2]),
    h,
    min,
    0,
    0,
  );
};

const { Order, KnowledgeBase: KBEntity } = base44.entities;

// ── Changeover calculation utilities ──────────────────────────────────────
// LINE_TO_FM and calculateAdditionalChangeover live in @/utils/changeoverCalc
// (imported at top of file) so the AI sequencing engine can share them.

function applyChangeoverEnrichment(orders, rules) {
  if (!orders || !orders.length) return orders;

  // Group by line, sort by priority_seq within each line
  const byLine = {};
  for (const o of orders) {
    const line = o.feedmill_line || "unknown";
    if (!byLine[line]) byLine[line] = [];
    byLine[line].push(o);
  }
  for (const line in byLine) {
    byLine[line].sort((a, b) => (a.priority_seq ?? 9999) - (b.priority_seq ?? 9999));
  }

  const enriched = [];
  for (const o of orders) {
    const st = (o.status || '').toLowerCase();

    // Done/Cancel orders: use frozen value if properly captured, otherwise compute from line context
    if (st === 'completed' || st === 'cancel_po') {
      const isFrozen = o.frozen_changeover != null;
      if (isFrozen) {
        // Properly frozen: use stored total + restore breakdown for tooltip
        const frozen = parseFloat(o.frozen_changeover);
        const base = parseFloat(o.changeover_time ?? 0.17);
        let storedBreakdown = [];
        try { storedBreakdown = JSON.parse(o.frozen_changeover_breakdown || '[]'); } catch (_) {}
        // If breakdown wasn't stored (order predates this feature) but frozen total > base,
        // try to compute breakdown dynamically from the next order on the same line
        if (storedBreakdown.length === 0 && frozen > base + 0.001) {
          const lineGroup2 = byLine[o.feedmill_line || 'unknown'] || [];
          const idx2 = lineGroup2.findIndex((x) => x.id === o.id);
          const nextAny = idx2 >= 0 ? (lineGroup2[idx2 + 1] || null) : null;
          if (nextAny) {
            const dynamicInfo = calculateAdditionalChangeover(o, nextAny, rules);
            storedBreakdown = dynamicInfo.breakdown;
          }
        }
        enriched.push({
          ...o,
          _changeoverBase: base,
          _changeoverAdditional: parseFloat((frozen - base).toFixed(3)),
          _changeoverTotal: frozen,
          _isLastOnLine: false,
          _changeoverBreakdown: storedBreakdown,
          _changeoverCalculated: true,
          _isFrozen: true,
        });
      } else {
        // No frozen value (pre-dates this feature): compute from next order on same line
        const lineGroup2 = byLine[o.feedmill_line || 'unknown'] || [];
        const idx2 = lineGroup2.findIndex((x) => x.id === o.id);
        const nextAny = idx2 >= 0 ? (lineGroup2[idx2 + 1] || null) : null;
        let addInfo = { total: 0, breakdown: [] };
        if (nextAny) addInfo = calculateAdditionalChangeover(o, nextAny, rules);
        const base = parseFloat(o.changeover_time ?? 0.17);
        const total = nextAny ? parseFloat((base + addInfo.total).toFixed(3)) : 0;
        enriched.push({
          ...o,
          _changeoverBase: base,
          _changeoverAdditional: addInfo.total,
          _changeoverTotal: total,
          _isLastOnLine: !nextAny,
          _changeoverBreakdown: addInfo.breakdown,
          _changeoverCalculated: true,
          _isFrozen: false,
        });
      }
      continue;
    }

    const line = o.feedmill_line || "unknown";
    const lineGroup = byLine[line] || [];
    const idx = lineGroup.findIndex((x) => x.id === o.id);
    // Skip completed/cancelled when finding the next order — same logic as preview changeovers.
    // This ensures the last *active* order gets zero changeover even if done orders follow it.
    const next = idx >= 0 ? (() => {
      for (let j = idx + 1; j < lineGroup.length; j++) {
        const s = (lineGroup[j].status || '').toLowerCase();
        if (s !== 'completed' && s !== 'cancel_po') return lineGroup[j];
      }
      return null;
    })() : null;

    let additionalInfo = { total: 0, breakdown: [] };
    if (next) {
      additionalInfo = calculateAdditionalChangeover(o, next, rules);
    }

    const baseChangeover = parseFloat(o.changeover_time ?? 0.17);
    // Last active order (no following active order): zero changeover — there is no next order to transition into.
    // Non-last order: base + additional rules derived from the following order.
    const changeoverTotal = next
      ? parseFloat((baseChangeover + additionalInfo.total).toFixed(3))
      : 0;

    enriched.push({
      ...o,
      _changeoverBase: baseChangeover,
      _changeoverAdditional: additionalInfo.total,
      _changeoverTotal: changeoverTotal,
      _isLastOnLine: !next,
      _changeoverBreakdown: additionalInfo.breakdown,
      _changeoverCalculated: true,
    });
  }
  // Debug: verify last-row CO is zero for the final order per line
  const enrichedById = Object.fromEntries(enriched.map(e => [String(e.id), e]));
  Object.entries(byLine).forEach(([line, lineOrders]) => {
    console.debug('[Last Row Changeover]', {
      line,
      rows: (lineOrders || []).map((order, index, arr) => ({
        orderId: order.id,
        index,
        isLast: index === arr.length - 1,
        nextOrderId: arr[index + 1]?.id ?? null,
        displayedCO: parseFloat(enrichedById[String(order.id)]?._changeoverTotal ?? 0),
      })),
    });
  });

  return enriched;
}
// ──────────────────────────────────────────────────────────────────────────
// Display-only cascade: applies correct formula after changeover enrichment.
// Formula: OrderN.start = OrderN-1.completion + OrderN-1._changeoverTotal
//          OrderN.completion = OrderN.start + (volume / run_rate)
// This runs AFTER applyChangeoverEnrichment so _changeoverTotal is available.
function applyDisplayCascade(orders) {
  if (!orders || !orders.length) return orders;

  const byLine = {};
  for (const o of orders) {
    const line = o.feedmill_line || "unknown";
    if (!byLine[line]) byLine[line] = [];
    byLine[line].push(o);
  }
  for (const line in byLine) {
    byLine[line].sort((a, b) => (a.priority_seq ?? 9999) - (b.priority_seq ?? 9999));
  }

  const computedMap = {}; // orderId → { target_completion_date, _computedStartDate?, _computedStartTime? }

  for (const line in byLine) {
    const lineOrders = byLine[line];
    let prevCompletion = null;   // Date object
    let prevChangeover = 0;      // hours (PREVIOUS order's _changeoverTotal)

    for (let i = 0; i < lineOrders.length; i++) {
      const o = lineOrders[i];

      if (o.status === "completed" || o.status === "cancel_po") {
        if (o.target_completion_date) {
          const d = parseCompletionDateStr(o.target_completion_date);
          if (d) prevCompletion = d;
        }
        prevChangeover = parseFloat(o._changeoverTotal ?? o.changeover_time ?? 0.17);
        continue;
      }

      if (o.target_completion_manual && o.target_completion_date) {
        const d = parseCompletionDateStr(o.target_completion_date);
        if (d) prevCompletion = d;
        prevChangeover = parseFloat(o._changeoverTotal ?? o.changeover_time ?? 0.17);
        continue;
      }

      // Determine this order's start
      let startDate;
      let isInferred = false;

      if (o.start_date) {
        // Manually set start date — parse it directly
        const t = o.start_time || "08:00";
        const [hh, mm] = t.split(":").map(Number);
        const d = new Date(o.start_date + "T00:00:00");
        d.setHours(hh, mm, 0, 0);
        startDate = d;
      } else if (prevCompletion) {
        // Auto-cascade: start = prevCompletion + prevChangeover (gap between orders)
        startDate = new Date(prevCompletion.getTime() + prevChangeover * 3600000);
        isInferred = true;
      } else {
        // No anchor — cannot compute
        prevChangeover = parseFloat(o._changeoverTotal ?? o.changeover_time ?? 0.17);
        continue;
      }

      // Production hours = volume / run_rate ONLY (no changeover).
      // Use shared calcProductionHours which handles volume_override / total_volume_mt.
      const ph = calcProductionHours(o) ?? 0;

      // Completion = start + production hours
      const completionDate = new Date(startDate.getTime() + ph * 3600000);

      // Always compute cascade date (stored value may be stale from old formula).
      // Only exception: target_completion_manual = true (user has locked it explicitly).
      const completionStr = formatCompletionDate(completionDate);
      computedMap[o.id] = { target_completion_date: completionStr };
      if (isInferred) {
        const yyyy = startDate.getFullYear();
        const mo = String(startDate.getMonth() + 1).padStart(2, "0");
        const dy = String(startDate.getDate()).padStart(2, "0");
        const hStr = String(startDate.getHours()).padStart(2, "0");
        const minStr = String(startDate.getMinutes()).padStart(2, "0");
        computedMap[o.id]._inferredStartDate = `${yyyy}-${mo}-${dy}`;
        computedMap[o.id]._inferredStartTime = `${hStr}:${minStr}`;
      }

      // Always use the freshly-computed completion as anchor for the NEXT order.
      // Never use the stale stored value here — that's what caused wrong cascades.
      prevCompletion = completionDate;
      prevChangeover = parseFloat(o._changeoverTotal ?? o.changeover_time ?? 0.17);
    }
  }

  return orders.map((o) => {
    const computed = computedMap[o.id];
    if (!computed) return o;
    return { ...o, ...computed };
  });
}
// ──────────────────────────────────────────────────────────────────────────
const FEEDMILL_STATUS_DEFAULTS = {
  FM1: { isShutdown: false, shutdownDate: null, reason: '', notes: '', affectedLines: [] },
  FM2: { isShutdown: false, shutdownDate: null, reason: '', notes: '', affectedLines: [] },
  FM3: { isShutdown: false, shutdownDate: null, reason: '', notes: '', affectedLines: [] },
  PMX: { isShutdown: false, shutdownDate: null, reason: '', notes: '', affectedLines: [] },
};

const AS_PHASES = [
  { key: 'scanning',    label: 'Scanning orders across all lines',         icon: '🔍' },
  { key: 'combining',   label: 'Finding and combining matching orders',     icon: '🔗' },
  { key: 'calculating', label: 'Calculating queue times per line',          icon: '⏱️' },
  { key: 'placing',     label: 'Placing orders on optimal lines',           icon: '📍' },
  { key: 'n10d',        label: 'Applying Future Dispatches target dates',  icon: '📅' },
  { key: 'sequencing',  label: 'Sequencing orders per line',                icon: '📊' },
  { key: 'changeovers', label: 'Calculating changeovers',                   icon: '⚙️' },
  { key: 'strategies',  label: 'Generating strategy options per line (AI-powered)', icon: '🤖' },
  { key: 'done',        label: 'Complete',                                  icon: '✅' },
];

function AutoSequenceProcessingOverlay({ currentPhase, processedCount, totalCount, combinedCount, movedCount, label, onCancel }) {
  const currentPhaseIndex = AS_PHASES.findIndex(p => p.key === currentPhase);
  const isDone = currentPhase === 'done';
  const progress = Math.round(((currentPhaseIndex + 1) / AS_PHASES.length) * 100);

  return (
    <div className="as-processing-overlay">
      <div className="as-processing-card">
        <div className="as-processing-header">
          <h2 className="as-processing-title">{label || 'Plant-Level Auto-Sequence'}</h2>
          <p className="as-processing-subtitle">Analyzing and optimizing orders</p>
        </div>

        <div className="as-processing-progress-bar">
          <div className="as-processing-progress-fill" style={{ width: `${progress}%` }} />
        </div>

        <div className="as-processing-phases">
          {AS_PHASES.map((phase, index) => {
            const isComplete = index < currentPhaseIndex;
            const isCurrent  = index === currentPhaseIndex;
            const isPending  = index > currentPhaseIndex;
            return (
              <div
                key={phase.key}
                className={`as-processing-phase${isComplete ? ' complete' : ''}${isCurrent ? ' current' : ''}${isPending ? ' pending' : ''}`}
              >
                <span className="as-processing-phase-icon">
                  {isComplete ? '✅' : isCurrent ? phase.icon : '○'}
                </span>
                <span className="as-processing-phase-label">{phase.label}</span>
                {isCurrent && <span className="as-processing-phase-spinner" />}
              </div>
            );
          })}
        </div>

        <div className="as-processing-stats">
          {totalCount > 0 && (
            <div className="as-processing-stat">
              <span className="as-processing-stat-value">{processedCount > 0 ? processedCount : totalCount}</span>
              <span className="as-processing-stat-label">{processedCount > 0 ? `of ${totalCount} orders` : 'orders'}</span>
            </div>
          )}
          {combinedCount > 0 && (
            <div className="as-processing-stat">
              <span className="as-processing-stat-value">{combinedCount}</span>
              <span className="as-processing-stat-label">combined groups</span>
            </div>
          )}
          {movedCount > 0 && (
            <div className="as-processing-stat">
              <span className="as-processing-stat-value">{movedCount}</span>
              <span className="as-processing-stat-label">orders moved</span>
            </div>
          )}
        </div>

        {onCancel && !isDone && (
          <div className="as-processing-cancel-text-wrap">
            <span
              className="as-processing-cancel-text"
              onClick={onCancel}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && onCancel()}
            >
              Cancel auto-sequence
            </span>
          </div>
        )}
      </div>
    </div>
  );
}


export default function Dashboard() {
  const queryClient = useQueryClient();

  // UI State
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeSection, setActiveSection] = useState("orders");
  const [activeSubSection, setActiveSubSection] = useState("all");
  const [activeFeedmill, setActiveFeedmill] = useState("ALL_FM");
  const [changeoverRules, setChangeoverRules] = useState(() => getDefaultChangeoverRules());
  const [tourMenuOpen, setTourMenuOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [filters, setFilters] = useState({
    form: "all",
    status: "all",
    readiness: "all",
  });
  const [selectedOrders, setSelectedOrders] = useState([]);
  const [bulkMode, setBulkMode] = useState(false);
  const [sortConfig, setSortConfig] = useState({ key: null, dir: "asc" });
  const [historyLineFilter, setHistoryLineFilter] = useState("All");
  const [newFprValues, setNewFprValues] = useState(new Set());
  const [autoSeqOpen, setAutoSeqOpen] = useState(false);
  const [autoSeqLoading, setAutoSeqLoading] = useState(false);
  const [autoSeqResult, setAutoSeqResult] = useState(null);
  const [plantSeqOpen, setPlantSeqOpen] = useState(false);
  const [plantSeqLoading, setPlantSeqLoading] = useState(false);
  const [showLineAutoSequencePreview, setShowLineAutoSequencePreview] = useState(false);
  const [lineAutoSequenceData, setLineAutoSequenceData] = useState(null);
  const [lineSeqLoading, setLineSeqLoading] = useState(false);
  const [plantSeqPreloadedAI, setPlantSeqPreloadedAI] = useState(null);
  const [plantSeqPreloadedStrategies, setPlantSeqPreloadedStrategies] = useState(null);
  const [plantSeqOrderCount, setPlantSeqOrderCount] = useState(0);
  const [plantSeqResults, setPlantSeqResults] = useState({});
  const [plantSeqSummary, setPlantSeqSummary] = useState(null);
  const [plantSeqLog, setPlantSeqLog] = useState([]);
  const [plantSeqSnapshot, setPlantSeqSnapshot] = useState({});
  const [showProcessingOverlay, setShowProcessingOverlay] = useState(false);
  const [processingPhase, setProcessingPhase] = useState(null);
  const [processingStats, setProcessingStats] = useState({ processed: 0, total: 0, combined: 0, moved: 0 });
  const [processingLabel, setProcessingLabel] = useState('');
  const plantSeqCancelledRef = useRef(false);
  const plantSeqAbortRef = useRef(null);
  const plantSeqRunIdRef = useRef(0);
  // Feedmill-level auto-sequence state
  const [showFeedmillSeqPreview, setShowFeedmillSeqPreview] = useState(false);
  const [feedmillSeqData, setFeedmillSeqData] = useState(null);
  const [addOrderOpen, setAddOrderOpen] = useState(false);
  const [addOrderLine, setAddOrderLine] = useState(null);
  const [addOrderPrefill, setAddOrderPrefill] = useState(null);

  // Mark as Done validation state
  const [markDoneBlocking, setMarkDoneBlocking] = useState(null); // order with missing end date
  const [markDoneSoftConfirm, setMarkDoneSoftConfirm] = useState(null); // { order, missingFields }

  // Modal State
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [cutCombineOrder, setCutCombineOrder] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);
  // New dialog states
  const [reasonDialog, setReasonDialog] = useState(null); // { action, order }
  const [produceIndependentOrder, setProduceIndependentOrder] = useState(null);
  const [cancelDialogOrder, setCancelDialogOrder] = useState(null);
  const [restoreDialogOrder, setRestoreDialogOrder] = useState(null);
  const [restoreNewStatus, setRestoreNewStatus] = useState(null);
  const [historyTab, setHistoryTab] = useState("completed");
  const [minVolumeCheck, setMinVolumeCheck] = useState(null); // { order, onProceed }
  const [pendingRevertDialog, setPendingRevertDialog] = useState(null); // { order, parentOrder }
  const [uncombineDialogOrder, setUncombineDialogOrder] = useState(null);
  const [dragWarning, setDragWarning] = useState(null); // { reordered, affectedOrders }
  const [cutDialogOrder, setCutDialogOrder] = useState(null);
  const [mergeBackDialog, setMergeBackDialog] = useState(null); // { portion1, portion2 }

  // Feedmill shutdown / order diversion state — persisted to localStorage
  const [feedmillStatus, setFeedmillStatus] = useState(() => {
    try {
      const saved = localStorage.getItem('nexfeed_feedmill_status');
      return saved ? { ...FEEDMILL_STATUS_DEFAULTS, ...JSON.parse(saved) } : FEEDMILL_STATUS_DEFAULTS;
    } catch { return FEEDMILL_STATUS_DEFAULTS; }
  });
  // Per-line shutdown state: { 'Line 1': { isShutdown, reason, notes, since, feedmill } }
  const [lineShutdowns, setLineShutdowns] = useState(() => {
    try {
      const saved = localStorage.getItem('nexfeed_line_shutdowns');
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });

  useEffect(() => {
    try { localStorage.setItem('nexfeed_line_shutdowns', JSON.stringify(lineShutdowns)); } catch { /* ignore */ }
  }, [lineShutdowns]);

  useEffect(() => {
    try { localStorage.setItem('nexfeed_feedmill_status', JSON.stringify(feedmillStatus)); } catch { /* ignore */ }
  }, [feedmillStatus]);

  const FEEDMILL_LINE_MAP = {
    FM1: ['Line 1', 'Line 2'],
    FM2: ['Line 3', 'Line 4'],
    FM3: ['Line 6', 'Line 7'],
    PMX: ['Line 5'],
  };
  const [divertDialog, setDivertDialog] = useState(null); // { order }
  const [revertDialog, setRevertDialog] = useState(null); // { order }
  const [inProdConflictDialog, setInProdConflictDialog] = useState(null); // { order, newStatus, existing }
  const [inProdOrderingDialog, setInProdOrderingDialog] = useState(null); // { order, newStatus, blocker, blockerPrio }

  // Fetch orders
  const { data: orders = [], isLoading } = useQuery({
    queryKey: ["orders"],
    queryFn: () => Order.list("-created_date"),
  });

  // Fetch active KB records for live lookup — ALL feedmill tabs (req 130).
  // IMPORTANT: queryKey ['kb'] MUST match what KnowledgeBaseManager invalidates after upload.
  const { data: allKBRecords = [] } = useQuery({
    queryKey: ["kb"],
    queryFn: () => KBEntity.list("-created_date", 2000),
    staleTime: 0, // Always re-fetch on window focus / invalidation
  });
  const { data: kbUploads = [] } = useQuery({
    queryKey: ["kb_uploads"],
    queryFn: () => base44.entities.KnowledgeBaseUpload.list("-created_date", 1),
    staleTime: 0,
  });

  // Scope KB records to the active upload session; fall back to all records if no session
  const kbRecords = useMemo(() => {
    const sessionId = kbUploads[0]?.upload_session_id;
    if (!sessionId) return allKBRecords;
    return allKBRecords.filter((r) => r.upload_session_id === sessionId);
  }, [allKBRecords, kbUploads]);

  const lastUploadDate = useMemo(() => {
    let latest = null;
    for (const o of orders) {
      const s = String(o.fpr || "").trim();
      if (s.length >= 6) {
        const yy = parseInt(s.substring(0, 2));
        const mm = parseInt(s.substring(2, 4));
        const dd = parseInt(s.substring(4, 6));
        if (
          !isNaN(yy) &&
          !isNaN(mm) &&
          mm >= 1 &&
          mm <= 12 &&
          !isNaN(dd) &&
          dd >= 1 &&
          dd <= 31
        ) {
          const d = new Date(2000 + yy, mm - 1, dd);
          if (!latest || d > latest) latest = d;
        }
      }
    }
    return latest ? latest.toISOString() : null;
  }, [orders]);

  // Next 10 Days stock level data
  const { data: n10dUploads = [] } = useQuery({
    queryKey: ["n10d_uploads"],
    queryFn: () => base44.entities.Next10DaysUpload.list("-created_date", 1),
    staleTime: 0,
  });
  const { data: allN10DRecords = [] } = useQuery({
    queryKey: ["n10d_records"],
    queryFn: () => base44.entities.Next10DaysRecord.list("-created_date", 2000),
    staleTime: 0,
  });

  const lastN10DUploadDate = n10dUploads[0]?.created_date || null;

  const activeN10DRecords = useMemo(() => {
    const sessionId = n10dUploads[0]?.upload_session_id;
    if (!sessionId) return allN10DRecords;
    return allN10DRecords.filter((r) => r.upload_session_id === sessionId);
  }, [allN10DRecords, n10dUploads]);

  // inferredTargetMap: { [material_code]: { targetDate, needsProduction, dueForLoading, inventory, note, status } }
  const inferredTargetMap = useMemo(() => {
    const map = {};
    for (const rec of activeN10DRecords) {
      if (rec.material_code) {
        const dfl = parseFloat(rec.due_for_loading ?? 0);
        const inv = parseFloat(rec.inventory ?? 0);
        const status = getProductStatus(dfl, inv, rec.daily_values);
        map[rec.material_code] = {
          targetDate: rec.target_date || null,
          needsProduction: rec.needs_production !== false,
          dueForLoading: rec.due_for_loading ?? null,
          inventory: rec.inventory ?? null,
          note: rec.note || null,
          status,
        };
      }
    }
    return map;
  }, [activeN10DRecords]);

  const anyModalOpen = !!(
    autoSeqOpen ||
    addOrderOpen ||
    isUploadModalOpen ||
    showLineAutoSequencePreview ||
    showBulkConfirm ||
    reasonDialog ||
    cancelDialogOrder ||
    restoreDialogOrder ||
    pendingRevertDialog ||
    uncombineDialogOrder ||
    cutDialogOrder ||
    mergeBackDialog ||
    cutCombineOrder
  );

  // Mutations
  const createOrderMutation = useMutation({
    mutationFn: (data) => Order.create(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["orders"] }),
  });

  const updateOrderMutation = useMutation({
    mutationFn: ({ id, data }) => Order.update(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["orders"] }),
  });

  const bulkCreateMutation = useMutation({
    mutationFn: (data) => Order.bulkCreate(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["orders"] }),
  });


  // KB lookup: map feedmill_line → KB batch_size column and run_rate column
  // This covers ALL feedmill tabs (FM1, FM2, FM3, PMX) — req 130
  const BATCH_SIZE_COL = {
    "Line 1": "batch_size_fm1",
    "Line 2": "batch_size_fm1",
    "Line 3": "batch_size_fm2",
    "Line 4": "batch_size_fm2",
    "Line 5": "batch_size_pmx",
    "Line 6": "batch_size_fm3",
    "Line 7": "batch_size_fm3",
  };
  const RUN_RATE_COL = {
    "Line 1": "line_1_run_rate",
    "Line 2": "line_2_run_rate",
    "Line 3": "line_3_run_rate",
    "Line 4": "line_4_run_rate",
    "Line 5": "line_5_run_rate",
    "Line 6": "line_6_run_rate",
    "Line 7": "line_7_run_rate",
  };

  // Enrich ALL orders (every tab) with live KB lookup.
  // Runs on: page load, KB change, order change (reqs 127/128/129/130).
  const isAvailDateValidMemo = (d) =>
    d && !isNaN(Date.parse(d)) && /^\d{4}-\d{2}-\d{2}/.test(d);

  const enrichedOrders = useMemo(() => {
    let result = orders;
    if (kbRecords.length) {
      const kbMap = {};
      for (const r of kbRecords) {
        if (r.fg_material_code) kbMap[String(r.fg_material_code).trim()] = r;
      }
      result = orders.map((order) => {
        const entry = kbMap[String(order.material_code || "").trim()];
        if (!entry) return order;
        const bsKey = BATCH_SIZE_COL[order.feedmill_line];
        const rrKey = RUN_RATE_COL[order.feedmill_line];
        const l1 = entry.label_1 || "";
        const l2 = entry.label_2 || "";
        const markings = l1 && l2 ? `${l1} | ${l2}` : l1 || l2 || "";
        return {
          ...order,
          form: entry.form || "",
          kb_sfg_material_code: entry.sfg1_material_code
            ? String(entry.sfg1_material_code)
            : "",
          batch_size:
            bsKey && entry[bsKey] != null && entry[bsKey] !== ""
              ? entry[bsKey]
              : order.batch_size,
          run_rate:
            rrKey && entry[rrKey] != null && entry[rrKey] !== ""
              ? entry[rrKey]
              : order.run_rate,
          threads: entry.thread || order.threads || "",
          sacks: entry.sacks_item_description || order.sacks || "",
          tags: entry.tags_item_description || order.tags || "",
          markings: markings || order.markings || "",
          category: order.category || entry.category || "",
          color: order.color || entry.color || "",
          diameter: order.diameter || entry.diameter || null,
        };
      });
    }

    const lineGroups = {};
    for (const o of result) {
      if (!o.feedmill_line) continue;
      if (!lineGroups[o.feedmill_line]) lineGroups[o.feedmill_line] = [];
      lineGroups[o.feedmill_line].push(o);
    }

    // Build today string once
    const _todayD = new Date();
    const _todayStr = `${_todayD.getFullYear()}-${String(_todayD.getMonth() + 1).padStart(2, "0")}-${String(_todayD.getDate()).padStart(2, "0")}`;

    // Identify first active order per line for default start values
    const firstInLineStartDefaults = {};
    for (const line in lineGroups) {
      const sorted = [...lineGroups[line]].sort(
        (a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity),
      );
      const firstActive = sorted.find(
        (o) => o.status !== "completed" && o.status !== "cancel_po",
      );
      if (firstActive && !firstActive.start_date) {
        firstInLineStartDefaults[firstActive.id] = {
          start_date: _todayStr,
          start_time: "08:00",
        };
      }
    }

    const conflictMap = {};
    const overflowMap = {};
    for (const line in lineGroups) {
      const sorted = lineGroups[line].sort(
        (a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity),
      );
      for (let i = 0; i < sorted.length; i++) {
        const o = sorted[i];
        if (o.status === "completed" || o.status === "cancel_po") continue;
        const completion = parseCompletionDateStr(o.target_completion_date);
        if (!completion) continue;

        if (isAvailDateValidMemo(o.target_avail_date)) {
          const availDate = new Date(o.target_avail_date);
          availDate.setHours(23, 59, 59, 999);
          if (completion.getTime() > availDate.getTime()) {
            conflictMap[o.id] = true;
          }
        }

        if (!isAvailDateValidMemo(o.target_avail_date)) {
          const nextDated = sorted
            .slice(i + 1)
            .find(
              (x) =>
                isAvailDateValidMemo(x.target_avail_date) &&
                x.status !== "completed" &&
                x.status !== "cancel_po",
            );
          if (nextDated) {
            const nextAvail = new Date(nextDated.target_avail_date);
            nextAvail.setHours(18, 0, 0, 0);
            const nextPh =
              nextDated.production_hours != null
                ? parseFloat(nextDated.production_hours)
                : 0;
            const nextCo =
              nextDated.changeover_time != null
                ? parseFloat(nextDated.changeover_time)
                : 0.17;
            const nextReqStart = new Date(
              nextAvail.getTime() - (nextPh + nextCo) * 3600000,
            );
            if (completion.getTime() > nextReqStart.getTime()) {
              overflowMap[o.id] = true;
            }
          }
        }
      }
    }

    return result.map((o) => {
      const startDefaults = firstInLineStartDefaults[o.id];
      return {
        ...o,
        ...(startDefaults || {}),
        scheduling_conflict: !!conflictMap[o.id],
        gap_overflow: !!overflowMap[o.id],
      };
    });
  }, [orders, kbRecords]);

  const changeoverEnrichedOrders = useMemo(
    () => applyChangeoverEnrichment(enrichedOrders, changeoverRules),
    [enrichedOrders, changeoverRules]
  );

  // Final scheduled orders: apply display cascade with correct formula
  // (OrderN.start = OrderN-1.completion + OrderN-1.changeover_total)
  const scheduledOrders = useMemo(
    () => applyDisplayCascade(changeoverEnrichedOrders),
    [changeoverEnrichedOrders]
  );

  // Fingerprint of each order's scheduled dates — changes whenever any avail/completion
  // date changes, even when the order count stays the same (e.g. after auto-sequence).
  const insightDateFingerprint = useMemo(
    () =>
      enrichedOrders
        .map((o) => `${o.id}:${o.target_avail_date || ""}:${o.target_completion_date || ""}:${o.end_date || ""}`)
        .join("|"),
    [enrichedOrders],
  );

  // Auto-populate template insights whenever N10D records or orders change —
  // no need to visit the N10D tab first.
  // Uses insightDateFingerprint so stale insights are rebuilt after rescheduling.
  useEffect(() => {
    if (activeN10DRecords.length === 0 || enrichedOrders.length === 0) return;
    const templateMap = buildInsightTemplates(activeN10DRecords, enrichedOrders);
    setTemplateInsights(templateMap);
  }, [activeN10DRecords.length, insightDateFingerprint]);

  // filteredOrders is only used for the Production section now
  // Planned section handles its own filtering via PlannedOrdersContent
  const filteredOrders = useMemo(() => {
    if (activeSection !== "production") return [];
    let result = [...enrichedOrders].filter(
      (o) => o.status === activeSubSection,
    );
    result = filterByFeedmillTab(result, activeFeedmill);

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(
        (o) =>
          (o.item_description || "").toLowerCase().includes(term) ||
          (o.material_code || "").toLowerCase().includes(term) ||
          (o.fpr || "").toLowerCase().includes(term) ||
          (o.fg || "").toLowerCase().includes(term) ||
          (o.sfg || "").toLowerCase().includes(term) ||
          (o.pmx || "").toLowerCase().includes(term) ||
          (o.fg1 || "").toLowerCase().includes(term) ||
          (o.sfg1 || "").toLowerCase().includes(term) ||
          (o.sfgpmx || "").toLowerCase().includes(term),
      );
    }
    if (filters.form && filters.form !== "all")
      result = result.filter((o) => o.form === filters.form);
    if (filters.haPrep && filters.haPrep !== "all")
      result = result.filter((o) => o.ha_prep_form_issuance === filters.haPrep);

    result.sort(
      (a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity),
    );
    return result;
  }, [
    orders,
    activeSection,
    activeSubSection,
    activeFeedmill,
    searchTerm,
    filters,
  ]);

  const handleSort = (key) => {
    setSortConfig((prev) => ({
      key,
      dir: prev.key === key && prev.dir === "asc" ? "desc" : "asc",
    }));
  };

  // Active statuses = not done, not cancelled
  const isActiveStatus = (s) => s !== "completed" && s !== "cancel_po";

  // Order counts for sidebar badges
  const orderCounts = useMemo(() => {
    const FM_LINE_MAP = {
      FM1: ["Line 1", "Line 2"],
      FM2: ["Line 3", "Line 4"],
      FM3: ["Line 6", "Line 7"],
      PMX: ["Line 5"],
    };
    const counts = {};
    FEEDMILL_LINES.forEach((fm) => {
      const lines = FM_LINE_MAP[fm.id] || [];
      const inFm = orders.filter((o) => lines.includes(o.feedmill_line));
      counts[`fm_active_${fm.id}`] = inFm.filter((o) =>
        isActiveStatus(o.status),
      ).length;
    });
    counts["fm_active_ALL_FM"] = orders.filter((o) =>
      isActiveStatus(o.status),
    ).length;
    return counts;
  }, [orders]);

  // Handle status change from Status dropdown
  const handleStatusChange = async (order, newStatus) => {
    const ts = formatTimestamp();
    const oldStatus = order.status || "plotted";

    const extraData = {};

    // Ordering check: On-going* can only be set when all orders above on the
    // same line are Done / On-going / Cancelled. Plotted/Planned/Hold/Cut
    // (not-yet-started) above this order block the change — earlier orders
    // must move into production first.
    const ONGOING_STATUSES = ["ongoing_batching", "ongoing_pelleting", "ongoing_bagging"];
    if (ONGOING_STATUSES.includes(newStatus)) {
      const ALLOWED_ABOVE = [
        "completed",
        "ongoing_batching", "ongoing_pelleting", "ongoing_bagging",
        "cancel_po",
        // legacy data may still carry "in_production" — treat as on-going
        "in_production",
      ];
      const lineOrders = orders
        .filter((o) => o.feedmill_line === order.feedmill_line)
        .sort((a, b) => (a.priority_seq ?? 0) - (b.priority_seq ?? 0));
      const orderIdx = lineOrders.findIndex((o) => o.id === order.id);
      const blockers = [];
      for (let i = 0; i < orderIdx; i++) {
        const aboveOrder = lineOrders[i];
        if (!ALLOWED_ABOVE.includes(aboveOrder.status || "plotted")) {
          blockers.push({ order: aboveOrder, prio: aboveOrder.priority_seq ?? i + 1 });
        }
      }
      if (blockers.length > 0) {
        console.debug('[Status Flow Check]', {
          targetOrderId: order.id,
          targetStatus: newStatus,
          blocked: true,
          reason: 'prior_order_not_started',
          blockerCount: blockers.length,
        });
        setInProdOrderingDialog({ order, newStatus, blockers });
        return;
      }
    }

    // In Production conflict check: only 1 per line at a time
    if (newStatus === "in_production") {
      const existingInProd = orders.find(
        (o) =>
          o.feedmill_line === order.feedmill_line &&
          o.status === "in_production" &&
          o.id !== order.id,
      );
      if (existingInProd) {
        setInProdConflictDialog({ order, newStatus, existing: existingInProd });
        return;
      }
    }

    // Setting to Done: store previous prio + precise timestamp + freeze current changeover
    if (newStatus === "completed") {
      const now = new Date();
      extraData.end_date = now.toISOString().split("T")[0];
      extraData.end_time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      extraData.previous_prio = order.priority_seq ?? null;
      extraData.done_timestamp = now.toISOString();
      // Freeze the current computed changeover so it's preserved regardless of future reorders
      const currentCO = order._changeoverTotal ?? order.changeover_time ?? 0.17;
      extraData.frozen_changeover = parseFloat(currentCO) || 0.17;
      extraData.changeover_frozen_at = now.toISOString();
      // Also freeze the breakdown for tooltip display in history
      extraData.frozen_changeover_breakdown = JSON.stringify(order._changeoverBreakdown || []);
    }

    // Reverting from Done to active: restore previous prio position + unfreeze changeover
    if (oldStatus === "completed" && newStatus !== "completed") {
      extraData.end_date = null;
      extraData.end_time = null;
      extraData.previous_prio = null;
      extraData.done_timestamp = null;
      extraData.frozen_changeover = null;
      extraData.changeover_frozen_at = null;
      extraData.frozen_changeover_breakdown = null;

      const prevPrio = order.previous_prio;
      const lineActiveOrders = orders
        .filter(
          (o) =>
            o.feedmill_line === order.feedmill_line &&
            o.id !== order.id &&
            o.status !== "completed" &&
            o.status !== "cancel_po",
        )
        .sort((a, b) => (a.priority_seq ?? 0) - (b.priority_seq ?? 0));

      const maxActive = lineActiveOrders.length;
      const targetPos =
        prevPrio && prevPrio >= 1 && prevPrio <= maxActive + 1
          ? Math.round(prevPrio)
          : maxActive + 1;
      extraData.priority_seq = targetPos;

      const historyEntry = {
        timestamp: ts,
        action: `Status changed: ${oldStatus} → ${newStatus}`,
        details: `Restored to position ${targetPos}`,
      };
      const newHistory = [...(order.history || []), historyEntry];

      await updateOrderMutation.mutateAsync({
        id: order.id,
        data: { status: newStatus, history: newHistory, ...extraData },
      });

      // Renumber all active orders around the restored order
      const resequenced = [
        ...lineActiveOrders.slice(0, targetPos - 1),
        { id: order.id, priority_seq: targetPos },
        ...lineActiveOrders.slice(targetPos - 1),
      ];
      for (let i = 0; i < resequenced.length; i++) {
        const newSeq = i + 1;
        if (
          resequenced[i].id !== order.id &&
          (resequenced[i].priority_seq ?? 0) !== newSeq
        ) {
          await updateOrderMutation.mutateAsync({
            id: resequenced[i].id,
            data: { priority_seq: newSeq },
          });
        }
      }

      const allLineOrders = [
        ...orders.filter(
          (o) =>
            o.feedmill_line === order.feedmill_line &&
            o.id !== order.id &&
            o.status !== "cancel_po",
        ),
        { ...order, status: newStatus, priority_seq: targetPos },
      ].sort(
        (a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity),
      );
      if (allLineOrders.length > 0) await cascadeSchedule(allLineOrders, 0);
      return;
    }

    // Standard status change
    const historyEntry = {
      timestamp: ts,
      action: `Status changed: ${oldStatus} → ${newStatus}`,
      details:
        newStatus === "completed" ? `End Date auto-set: ${ts}` : undefined,
    };
    const newHistory = [...(order.history || []), historyEntry];

    await updateOrderMutation.mutateAsync({
      id: order.id,
      data: { status: newStatus, history: newHistory, ...extraData },
    });

    const isLeadCombined =
      !order.parent_id && !!order.original_order_ids?.length;

    if (isLeadCombined) {
      const childOrders = orders.filter((o) => o.parent_id === order.id);

      for (const child of childOrders) {
        const cHistory = [
          ...(child.history || []),
          { timestamp: ts, action: `Status synced from lead: ${newStatus}` },
        ];
        const childExtra = {};
        if (newStatus === "completed") {
          const now = new Date();
          childExtra.end_date = now.toISOString().split("T")[0];
          childExtra.end_time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
          childExtra.previous_prio = child.priority_seq ?? null;
          childExtra.done_timestamp = now.toISOString();
        }
        if (oldStatus === "completed" && newStatus !== "completed") {
          childExtra.end_date = null;
          childExtra.end_time = null;
          childExtra.previous_prio = null;
          childExtra.done_timestamp = null;
        }
        await updateOrderMutation.mutateAsync({
          id: child.id,
          data: { status: newStatus, history: cHistory, ...childExtra },
        });
      }
    }
  };

  const handleCancelRequest = (order) => {
    setCancelDialogOrder(order);
  };

  const handleCancelConfirm = async ({ reason, notes }) => {
    const order = cancelDialogOrder;
    if (!order) return;
    setCancelDialogOrder(null);

    const now = new Date();
    const ts = formatTimestamp();
    const cancelDate = now.toISOString().split("T")[0];
    const cancelTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    const dateStr = now.toLocaleString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    let cancelNoteText = `Cancelled: ${reason} — ${dateStr}`;
    if (notes) cancelNoteText += `. ${notes}`;

    const historyEntry = {
      timestamp: ts,
      action: `Status changed: ${order.status || "plotted"} → cancel_po`,
      details: `Reason: ${reason}${notes ? `. ${notes}` : ""}`,
    };
    const newHistory = [...(order.history || []), historyEntry];

    await updateOrderMutation.mutateAsync({
      id: order.id,
      data: {
        status: "cancel_po",
        cancel_note: cancelNoteText,
        history: newHistory,
        cancelled_at: now.toISOString(),
        cancelled_date: cancelDate,
        cancelled_time: cancelTime,
        cancel_reason: reason,
        cancel_notes: notes || null,
        cancelled_by: "User",
      },
    });

    const lineOrders = orders
      .filter(
        (o) => o.feedmill_line === order.feedmill_line && o.id !== order.id,
      )
      .sort(
        (a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity),
      );
    if (lineOrders.length > 0) {
      await cascadeSchedule(lineOrders, 0);
    }

    toast.success("Order cancelled successfully");
  };

  const handleRestoreRequest = (order, newStatus) => {
    setRestoreDialogOrder(order);
    setRestoreNewStatus(newStatus);
  };

  const handleRestoreConfirm = async () => {
    const order = restoreDialogOrder;
    const newStatus = restoreNewStatus;
    if (!order || !newStatus) return;
    setRestoreDialogOrder(null);
    setRestoreNewStatus(null);

    const now = new Date();
    const ts = formatTimestamp();
    const dateStr = now.toLocaleString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });

    const historyEntry = {
      timestamp: ts,
      action: `Status changed: cancel_po → ${newStatus}`,
      details: `Order restored to active`,
    };
    const newHistory = [...(order.history || []), historyEntry];

    const lineOrders = orders
      .filter(
        (o) =>
          o.feedmill_line === order.feedmill_line &&
          o.status !== "cancel_po" &&
          o.status !== "completed" &&
          o.id !== order.id,
      )
      .sort((a, b) => (a.priority_seq ?? 0) - (b.priority_seq ?? 0));
    const maxPrio =
      lineOrders.length > 0
        ? Math.max(...lineOrders.map((o) => o.priority_seq ?? 0))
        : 0;

    await updateOrderMutation.mutateAsync({
      id: order.id,
      data: {
        status: newStatus,
        cancel_note: null,
        history: newHistory,
        cancelled_at: null,
        cancelled_date: null,
        cancelled_time: null,
        cancel_reason: null,
        cancel_notes: null,
        cancelled_by: null,
        parent_id: null,
        priority_seq: maxPrio + 1,
        end_date: null,
        end_time: null,
      },
    });

    const restoredOrder = {
      ...order,
      status: newStatus,
      priority_seq: maxPrio + 1,
      parent_id: null,
      end_date: null,
      end_time: null,
    };
    const allLineOrders = [
      ...orders.filter(
        (o) => o.feedmill_line === order.feedmill_line && o.id !== order.id,
      ),
      restoredOrder,
    ].sort(
      (a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity),
    );
    if (allLineOrders.length > 0) {
      await cascadeSchedule(allLineOrders, 0);
    }

    toast.success("Order restored successfully");
  };

  const handleUncombineRequest = (order) => {
    setUncombineDialogOrder(order);
  };

  const handleUncombineConfirm = async () => {
    const order = uncombineDialogOrder;
    if (!order) return;
    setUncombineDialogOrder(null);

    const ts = formatTimestamp();
    const childOrders = orders.filter((o) => o.parent_id === order.id);

    // Reset all children: clear parent_id, set plotted, clear combined fields
    for (const child of childOrders) {
      const cHistory = [
        ...(child.history || []),
        {
          timestamp: ts,
          action: `Un-combined from lead order FPR: ${order.fpr}. Group dissolved by user.`,
        },
      ];
      await updateOrderMutation.mutateAsync({
        id: child.id,
        data: {
          status: "plotted",
          parent_id: null,
          history: cHistory,
        },
      });
    }

    // Smart Combine leads have children (parent_id pointing to lead) — delete the auto-generated lead
    // Manual Combine leads have original_orders_snapshot but NO children — reset to plotted (keep the order)
    const isSmartCombineLead = childOrders.length > 0;

    if (isSmartCombineLead) {
      await Order.delete(order.id);
    } else {
      const leadHistory = [
        ...(order.history || []),
        {
          timestamp: ts,
          action: `Uncombined group lead. Orders returned to standalone Plotted status.`,
        },
      ];
      await updateOrderMutation.mutateAsync({
        id: order.id,
        data: {
          status: "plotted",
          original_order_ids: null,
          original_orders_snapshot: null,
          history: leadHistory,
        },
      });
    }

    // Re-sequence the line (excluding the deleted lead if smart combine)
    // T005: restore children to date-based chronological positions
    const childIds = new Set(childOrders.map((c) => c.id));
    const baseLineOrders = orders
      .filter(
        (o) =>
          o.feedmill_line === order.feedmill_line &&
          o.status !== "cancel_po" &&
          o.status !== "completed" &&
          (isSmartCombineLead ? o.id !== order.id : true) &&
          !childIds.has(o.id),
      )
      .sort(
        (a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity),
      );

    // Sort children by avail date; undated children go at the end
    const parseAvail = (d) =>
      d && !isNaN(Date.parse(d)) ? new Date(d) : null;
    const sortedChildren = [...childOrders].sort((a, b) => {
      const da = parseAvail(a.target_avail_date);
      const db = parseAvail(b.target_avail_date);
      if (da && db) return da - db;
      if (da) return -1;
      if (db) return 1;
      return 0;
    });

    // Insert each child at the correct position among base line orders
    let insertList = [...baseLineOrders];
    for (const child of sortedChildren) {
      const childAvail = parseAvail(child.target_avail_date);
      let insertIdx = insertList.length; // default: append
      if (childAvail) {
        for (let i = 0; i < insertList.length; i++) {
          const oAvail = parseAvail(insertList[i].target_avail_date);
          if (oAvail && oAvail > childAvail) {
            insertIdx = i;
            break;
          }
        }
      }
      insertList.splice(insertIdx, 0, child);
    }

    const updatedLineOrders = insertList;

    for (let i = 0; i < updatedLineOrders.length; i++) {
      const o = updatedLineOrders[i];
      const newSeq = i + 1;
      if (o.priority_seq !== newSeq) {
        await updateOrderMutation.mutateAsync({
          id: o.id,
          data: { priority_seq: newSeq },
        });
      }
    }

    if (updatedLineOrders.length > 0) {
      await cascadeSchedule(updatedLineOrders, 0);
    }

    queryClient.invalidateQueries({ queryKey: ["orders"] });
    toast.success("Order uncombined. All orders reset to Plotted.");
  };

  const handleCutRequest = (order) => {
    setCutDialogOrder(order);
  };

  const handleCutConfirm = async ({ portion1, portion2 }) => {
    const order = cutDialogOrder;
    if (!order) return;
    setCutDialogOrder(null);

    const ts = formatTimestamp();
    const effVol = parseFloat(
      order.volume_override ?? order.total_volume_mt ?? 0,
    );

    const hist1 = [
      ...(order.history || []),
      {
        timestamp: ts,
        action: `Cut Order: Portion 1 of 2 — volume reduced to ${portion1} MT (was ${effVol} MT).`,
      },
    ];

    const hist2 = [
      {
        timestamp: ts,
        action: `Cut Order: Portion 2 of 2 — ${portion2} MT split from FPR ${order.fpr} (original volume ${effVol} MT).`,
      },
    ];

    const cutRemark = `Original volume: ${effVol} MT (cut to ${portion1} MT + ${portion2} MT)`;

    // Update original order to become Portion 1
    await updateOrderMutation.mutateAsync({
      id: order.id,
      data: {
        volume_override: portion1,
        is_cut: true,
        cut_original_volume: effVol,
        status: "cut",
        cut_note: `Cut: Portion 1 of 2 — ${portion1} MT (was ${effVol} MT)`,
        prod_remarks: appendRemark(order.prod_remarks, cutRemark),
        history: hist1,
      },
    });

    // Create Portion 2 as a new order right after the original
    const tempPrio = (order.priority_seq ?? 0) + 0.5;
    const newOrder = await createOrderMutation.mutateAsync({
      fpr: order.fpr,
      material_code: order.material_code,
      item_description: order.item_description,
      category: order.category,
      color: order.color,
      feedmill_line: order.feedmill_line,
      total_volume_mt: portion2,
      volume_override: null,
      is_cut: true,
      cut_original_volume: effVol,
      cut_note: `Cut: Portion 2 of 2 — ${portion2} MT (split from FPR ${order.fpr})`,
      prod_remarks: cutRemark,
      status: "cut",
      form: order.form,
      diameter: order.diameter,
      batch_size: order.batch_size,
      run_rate: order.run_rate,
      changeover_time: order.changeover_time,
      production_hours: null,
      production_hours_manual: false,
      target_avail_date: order.target_avail_date,
      fg: order.fg,
      sfg: order.sfg,
      pmx: order.pmx,
      fg1: order.fg1,
      sfg1: order.sfg1,
      sfgpmx: order.sfgpmx,
      kb_sfg_material_code: order.kb_sfg_material_code,
      threads: order.threads,
      sacks: order.sacks,
      markings: order.markings,
      tags: order.tags,
      po_status: order.po_status,
      priority_seq: tempPrio,
      parent_id: null,
      original_order_ids: null,
      history: hist2,
    });

    // Re-sequence all active orders on this line, placing Portion 2 right after Portion 1
    const lineOrders = orders
      .filter(
        (o) =>
          o.feedmill_line === order.feedmill_line &&
          o.status !== "cancel_po" &&
          o.status !== "completed",
      )
      .sort(
        (a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity),
      );

    const newList = [];
    let inserted = false;
    for (const o of lineOrders) {
      if (o.id === order.id) {
        newList.push({ ...o, volume_override: portion1, is_cut: true });
        newList.push({
          ...(newOrder || {}),
          feedmill_line: order.feedmill_line,
          priority_seq: tempPrio,
        });
        inserted = true;
      } else if (o.id !== newOrder?.id) {
        newList.push(o);
      }
    }
    if (!inserted) {
      newList.push({
        ...(newOrder || {}),
        feedmill_line: order.feedmill_line,
        priority_seq: tempPrio,
      });
    }

    for (let i = 0; i < newList.length; i++) {
      const o = newList[i];
      const newPrioSeq = i + 1;
      if (o.priority_seq !== newPrioSeq && o.id) {
        await updateOrderMutation.mutateAsync({
          id: o.id,
          data: { priority_seq: newPrioSeq },
        });
      }
    }

    const originalIdx = newList.findIndex((o) => o.id === order.id);
    await cascadeSchedule(newList, Math.max(0, originalIdx));

    queryClient.invalidateQueries({ queryKey: ["orders"] });
    toast.success(`Order cut into ${portion1} MT and ${portion2} MT portions.`);
  };

  const handleMergeBackRequest = (order) => {
    // Find both cut portions (this order + its sibling by FPR)
    const allCutPortions = orders.filter(
      (o) => o.is_cut && o.fpr === order.fpr,
    );
    if (allCutPortions.length < 2) {
      toast.error("Could not find both cut portions to merge.");
      return;
    }
    const sorted = [...allCutPortions].sort(
      (a, b) => (a.priority_seq ?? 999) - (b.priority_seq ?? 999),
    );
    setMergeBackDialog({ portion1: sorted[0], portion2: sorted[1] });
  };

  const handleMergeBackConfirm = async () => {
    const { portion1, portion2 } = mergeBackDialog;
    setMergeBackDialog(null);

    const ts = formatTimestamp();
    const p1Vol = parseFloat(
      portion1.volume_override ?? portion1.total_volume_mt ?? 0,
    );
    const p2Vol = parseFloat(
      portion2.volume_override ?? portion2.total_volume_mt ?? 0,
    );
    const mergedVol = p1Vol + p2Vol;

    const hist = [
      ...(portion1.history || []),
      {
        timestamp: ts,
        action: `Merge Back: Portion 2 (${p2Vol} MT) absorbed. Merged volume: ${mergedVol} MT. Status reset to Plotted.`,
      },
    ];

    // Remove cut-related remarks from prod_remarks (e.g. "Original volume: X MT (cut to ...)")
    const cleanedRemarks =
      (portion1.prod_remarks || "")
        .split("\n")
        .filter((line) => !line.startsWith("Original volume:"))
        .join("\n")
        .trim() || null;

    // Update portion1: absorb portion2's volume, clear cut fields, reset status
    await updateOrderMutation.mutateAsync({
      id: portion1.id,
      data: {
        total_volume_mt: mergedVol,
        volume_override: null,
        is_cut: false,
        cut_original_volume: null,
        cut_note: null,
        status: "plotted",
        prod_remarks: cleanedRemarks,
        history: hist,
      },
    });

    // Delete portion2
    await Order.delete(portion2.id);

    // Re-sequence the line without portion2
    const lineOrders = orders
      .filter(
        (o) =>
          o.feedmill_line === portion1.feedmill_line &&
          o.status !== "cancel_po" &&
          o.status !== "completed" &&
          o.id !== portion2.id,
      )
      .sort(
        (a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity),
      );

    for (let i = 0; i < lineOrders.length; i++) {
      const o = lineOrders[i];
      const newPrioSeq = i + 1;
      if (o.priority_seq !== newPrioSeq) {
        await updateOrderMutation.mutateAsync({
          id: o.id,
          data: { priority_seq: newPrioSeq },
        });
      }
    }

    const mergedIdx = lineOrders.findIndex((o) => o.id === portion1.id);
    const listForCascade = lineOrders.map((o) =>
      o.id === portion1.id
        ? {
            ...o,
            total_volume_mt: mergedVol,
            volume_override: null,
            is_cut: false,
          }
        : o,
    );
    await cascadeSchedule(listForCascade, Math.max(0, mergedIdx));

    queryClient.invalidateQueries({ queryKey: ["orders"] });
    toast.success(`Orders merged back into ${mergedVol} MT.`);
  };

  // Build a fast KB map and apply to an order — shared helper used in upload + reapply
  const buildLocalKBMap = (kbList) => {
    const m = {};
    for (const r of kbList || [])
      if (r.fg_material_code) m[String(r.fg_material_code).trim()] = r;
    return m;
  };

  const applyKBFields = (order, entry) => {
    if (!entry) return {};
    const updates = {};
    // Category
    if (entry.category) updates.category = entry.category;
    // Color
    if (entry.color) updates.color = entry.color;
    // Form — preserve exact value, normalize lowercase
    if (entry.form)
      updates.form =
        String(entry.form).toUpperCase() === entry.form
          ? entry.form
          : entry.form.charAt(0).toUpperCase() + entry.form.slice(1);
    // Diameter
    if (entry.diameter != null && entry.diameter !== "") updates.diameter = parseFloat(entry.diameter);
    // Changeover time from KB (falls back to 0.17 when null)
    const co = parseFloat(entry.changeover);
    updates.changeover_time = isNaN(co) ? 0.17 : co;
    // SFG Material Code from KB Column C
    if (entry.sfg1_material_code)
      updates.kb_sfg_material_code = String(entry.sfg1_material_code);
    // Batch size — feedmill-specific column
    const bsKey = BATCH_SIZE_COL[order.feedmill_line];
    if (bsKey && entry[bsKey] != null && entry[bsKey] !== "")
      updates.batch_size = entry[bsKey];
    // Run rate — line-specific column
    const rrKey = RUN_RATE_COL[order.feedmill_line];
    if (rrKey && entry[rrKey] != null && entry[rrKey] !== "")
      updates.run_rate = entry[rrKey];
    // Thread
    if (entry.thread) updates.threads = entry.thread;
    // Sacks — description only (Column N)
    if (entry.sacks_item_description)
      updates.sacks = entry.sacks_item_description;
    // Tags — description only (Column P)
    if (entry.tags_item_description) updates.tags = entry.tags_item_description;
    // Markings — Label 1 + Label 2 (Columns Q + R)
    const l1 = entry.label_1 || "";
    const l2 = entry.label_2 || "";
    const markings = l1 && l2 ? `${l1} | ${l2}` : l1 || l2 || "";
    if (markings) updates.markings = markings;
    return updates;
  };

  // Reapply KB to ALL existing orders across ALL feedmill tabs
  const NON_UPDATABLE_STATUSES = new Set([
    "completed", "cancel_po", "in_production",
    "ongoing_batching", "ongoing_pelleting", "ongoing_bagging",
  ]);

  const handleReapplyKB = async (activeKBRecords) => {
    const kbMap = buildLocalKBMap(activeKBRecords);
    const toUpdate = orders.filter((o) => !NON_UPDATABLE_STATUSES.has(o.status));
    const skipped = orders.filter((o) => NON_UPDATABLE_STATUSES.has(o.status));
    await Promise.all(
      toUpdate.map((order) => {
        const entry = kbMap[String(order.material_code || "").trim()];
        const updates = applyKBFields(order, entry);
        if (!Object.keys(updates).length) return Promise.resolve();
        return updateOrderMutation.mutateAsync({ id: order.id, data: updates });
      }),
    );
    const doneCount = skipped.filter((o) => o.status === "completed").length;
    const cancelCount = skipped.filter((o) => o.status === "cancel_po").length;
    const inProgressCount = skipped.filter(
      (o) => o.status === "in_production" || o.status.startsWith("ongoing"),
    ).length;
    const parts = [];
    if (doneCount > 0) parts.push(`${doneCount} completed`);
    if (cancelCount > 0) parts.push(`${cancelCount} cancelled`);
    if (inProgressCount > 0) parts.push(`${inProgressCount} in-progress`);
    const skipNote = parts.length > 0 ? ` ${parts.join(", ")} order(s) were not updated.` : "";
    toast.success(`Master data applied to ${toUpdate.length} active order(s).${skipNote}`);
  };

  const FEEDMILL_LABELS = {
    FM1: "Feedmill 1",
    FM2: "Feedmill 2",
    FM3: "Feedmill 3",
    PMX: "Powermix",
  };

  const getAutoSequenceOrders = () => {
    const EXCLUDED_FROM_AUTOSEQ = new Set([
      "completed", "cancel_po",
      "in_production", "ongoing_batching", "ongoing_pelleting", "ongoing_bagging",
    ]);
    let result = enrichedOrders.filter((o) => !EXCLUDED_FROM_AUTOSEQ.has(o.status));
    result = filterByFeedmillTab(result, activeFeedmill);
    if (activeSubSection && activeSubSection !== "all") {
      result = result.filter((o) => o.feedmill_line === activeSubSection);
    }
    result.sort(
      (a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity),
    );
    return result;
  };

  const handleAutoSequence = async () => {
    const lineOrders = getAutoSequenceOrders();
    if (lineOrders.length < 2) {
      toast.error("At least 2 active orders are needed for auto-sequencing.");
      return;
    }
    setAutoSeqOpen(true);
    setAutoSeqLoading(true);
    setAutoSeqResult(null);
    try {
      const fmLabel = FEEDMILL_LABELS[activeFeedmill] || activeFeedmill;
      const lineName =
        activeSubSection === "all" ? "All Lines" : activeSubSection;
      const result = await autoSequenceOrders(
        lineOrders,
        fmLabel,
        lineName,
        inferredTargetMap,
      );
      setAutoSeqResult(result);
    } catch (err) {
      setAutoSeqResult({ error: err.message || "Auto-sequence failed." });
    } finally {
      setAutoSeqLoading(false);
    }
  };

  const handleOpenAddOrder = (line) => {
    setAddOrderPrefill(null);
    setAddOrderLine(line);
    setAddOrderOpen(true);
  };

  // Map feedmill tab → available lines for AddOrderDialog
  const FM_LINE_MAP_LOCAL = {
    FM1: ["Line 1", "Line 2"],
    FM2: ["Line 3", "Line 4"],
    FM3: ["Line 6", "Line 7"],
    PMX: ["Line 5"],
  };

  // Short names and lines used by feedmill auto-sequence
  const FM_SHORT_NAMES = { FM1: "FM1", FM2: "FM2", FM3: "FM3", PMX: "PMX" };
  const FM_FULL_NAMES = { FM1: "Feedmill 1", FM2: "Feedmill 2", FM3: "Feedmill 3", PMX: "Powermix" };
  const getFMFullName = (key) => FM_FULL_NAMES[key] || key;
  const FEEDMILL_SEQ_LINES = FM_LINE_MAP_LOCAL; // same structure

  // Reverse map: line name → feedmill key
  const LINE_TO_FM_KEY = {
    'Line 1': 'FM1', 'Line 2': 'FM1',
    'Line 3': 'FM2', 'Line 4': 'FM2',
    'Line 5': 'PMX',
    'Line 6': 'FM3', 'Line 7': 'FM3',
  };

  // ─── Plant-Level Auto-Sequence Constants & Helpers ─────────────────────────
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
  const PLANT_MAX_COMBINE_MT = 180;

  const LINE_RUN_RATES = {
    "Line 1": 20, "Line 2": 20,
    "Line 3": 10, "Line 4": 10,
    "Line 5": 10,
    "Line 6": 10, "Line 7": 10,
  };
  const getLineRunRate = (line) => LINE_RUN_RATES[line] || 10;

  const normalizeLine = (line) => {
    if (!line) return "";
    const s = String(line).trim();
    const lineMatch = s.match(/^line\s*(\d+)$/i);
    if (lineMatch) return `Line ${lineMatch[1]}`;
    const shortMatch = s.match(/^l(\d+)$/i);
    if (shortMatch) return `Line ${shortMatch[1]}`;
    return s;
  };

  const plantCanProduceOnLine = (order, line, kbList) => {
    const normalizedLine = normalizeLine(line);
    const rrKey = PLANT_RUN_RATE_COL[normalizedLine];
    if (!rrKey) return false;
    const materialCode = String(order.material_code || "").trim();
    if (!materialCode) return false;
    const entry = kbList.find(
      (r) => String(r.fg_material_code || "").trim() === materialCode
    );
    if (!entry) {
      console.log(`plantCanProduceOnLine: No KB entry for material_code="${materialCode}" on line "${normalizedLine}"`);
    }
    return !!(entry && parseFloat(entry[rrKey] || 0) > 0);
  };

  const getOrderVolumeMT = (order) => {
    const candidates = [
      order.volume_override,
      order.volume,
      order.total_volume_mt,
      order.volume_mt,
    ];
    for (const val of candidates) {
      const parsed = parseFloat(val);
      if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    }
    return 0;
  };

  const calculateLineTotalMT = (lineOrders) =>
    Number(
      ((lineOrders || []).reduce((sum, o) => sum + getOrderVolumeMT(o), 0)).toFixed(2)
    );

  // Mirror getEffectiveVolume() from OrderTable exactly so summary matches table display:
  // volume_override → ceil(total_volume_mt / batch_size) * batch_size → raw
  const getEffectiveDisplayVolumeMT = (order) => {
    if (order.volume_override != null && order.volume_override !== "") {
      const ov = parseFloat(order.volume_override);
      if (!Number.isNaN(ov)) return Number(ov.toFixed(2));
    }
    const rawVol = parseFloat(order.total_volume_mt ?? 0) || 0;
    const batchSize = parseFloat(order.batch_size ?? 0) || 0;
    if (batchSize > 0) return Number((Math.ceil(rawVol / batchSize) * batchSize).toFixed(2));
    return Number(rawVol.toFixed(2));
  };

  const calculateEffectiveLineTotalMT = (lineOrders) =>
    Number(((lineOrders || []).reduce((sum, o) => sum + getEffectiveDisplayVolumeMT(o), 0)).toFixed(2));

  // Sum actual row-level hours (production + changeover) — same fields shown in the order rows
  const calculateLineHoursBreakdown = (orders) => {
    const prod = Number(((orders || []).reduce((s, o) => s + (parseFloat(o.production_hours) || 0), 0)).toFixed(2));
    const co   = Number(((orders || []).reduce((s, o) => s + (parseFloat(o._changeoverTotal ?? o.changeover_time ?? 0) || 0), 0)).toFixed(2));
    return { productionHours: prod, changeoverHours: co, totalHours: Number((prod + co).toFixed(2)) };
  };

  const calculateQueueTimeHours = (totalMT, runRate) => {
    const mt = parseFloat(totalMT) || 0;
    const rr = parseFloat(runRate) || 0;
    if (rr <= 0) return 0;
    return Number((mt / rr).toFixed(2));
  };

  const plantCalcQueueHrs = (lineOrders, line) => {
    const totalMT = calculateEffectiveLineTotalMT(lineOrders);
    const runRate = getLineRunRate(line);
    return runRate > 0 ? totalMT / runRate : Infinity;
  };

  // Returns the correct MT basis for one order before combining:
  //   • user override  → use the override value
  //   • raw not divisible by batch size (app-adjusted) → use raw so the ceiling
  //     is applied only to the final combined sum, not per-order
  //   • already divisible or no batch size → use raw
  const getCombinationBasisVolume = (order) => {
    const rawVolume = parseFloat(order.total_volume_mt ?? order.volume ?? 0) || 0;
    const batchSize = parseFloat(order.batch_size ?? 0) || 0;
    const overrideVolume = parseFloat(order.volume_override);
    if (!Number.isNaN(overrideVolume) && overrideVolume > 0) {
      return { basisVolume: overrideVolume, basisType: 'user_override', rawVolume, batchSize };
    }
    if (batchSize > 0) {
      const isDivisible = Math.abs(rawVolume % batchSize) < 0.001;
      if (!isDivisible) {
        return { basisVolume: rawVolume, basisType: 'app_adjusted_use_raw', rawVolume, batchSize };
      }
    }
    return { basisVolume: rawVolume, basisType: 'raw_divisible', rawVolume, batchSize };
  };

  // Round a combined basis sum up to the nearest batch multiple
  const adjustVolumeToBatchCeiling = (volume, batchSize) => {
    const v = parseFloat(volume || 0) || 0;
    const b = parseFloat(batchSize || 0) || 0;
    if (b <= 0) return Number(v.toFixed(2));
    return Number((Math.ceil(v / b) * b).toFixed(2));
  };

  const plantLocalSequence = (lineOrders) => {
    // ALL orders (including Planned) sort chronologically — no planned-first pinning.
    // Tiers: 0=Critical-no-date, 1=any-effective-date (merged), 2=no-date.
    // Dates from hard avail and N10D inferred are treated equally (same tier).
    const _isRealISO = (v) => !!v && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v));
    const enriched = lineOrders.map(o => {
      const inf = inferredTargetMap?.[o.material_code] || inferredTargetMap?.[o.material_code_fg];
      // Dates from auto-sequence or N10D are never hard deadlines — they must be
      // recalculated from the latest N10D data on each auto-sequence run.
      const _plIsN10DSourced = o.avail_date_source === 'auto_sequence' || o.date_source === 'n10d';
      const isHardDeadline = _isRealISO(o.target_avail_date) && !_plIsN10DSourced;
      let sortTier = 2;
      let effectiveDate = null;
      let dflToInvRatio = 0;
      if (inf?.status === 'Critical' && !isHardDeadline) {
        sortTier = 0;
        const dfl = parseFloat(inf.dueForLoading) || 0;
        const inv = parseFloat(inf.inventory) || 0;
        dflToInvRatio = inv > 0 ? dfl / inv : Infinity;
      } else {
        if (isHardDeadline) effectiveDate = new Date(o.target_avail_date);
        else if (inf?.targetDate && _isRealISO(inf.targetDate)) effectiveDate = new Date(inf.targetDate);
        sortTier = effectiveDate ? 1 : 2;
      }
      return { ...o, _sortTier: sortTier, _effectiveDate: effectiveDate, _dflToInvRatio: dflToInvRatio };
    });
    enriched.sort((a, b) => {
      if (a._sortTier !== b._sortTier) return a._sortTier - b._sortTier;
      if (a._sortTier === 0) return (b._dflToInvRatio ?? 0) - (a._dflToInvRatio ?? 0);
      if (a._effectiveDate && b._effectiveDate) return a._effectiveDate - b._effectiveDate;
      if (a._effectiveDate) return -1;
      if (b._effectiveDate) return 1;
      return 0;
    });
    return enriched;
  };

  const plantLevelCombineAndPlace = (activeOrders, kbList, coRules) => {
    // ─── helpers ───────────────────────────────────────────────────────────────
    const EXCLUDED_STATUSES = new Set([
      "Done", "Cancel PO", "In Production", "On-going",
      "completed", "cancel_po",
      "in_production", "ongoing_batching", "ongoing_pelleting", "ongoing_bagging",
    ]);

    const canProduceOnLine = (order, line) => plantCanProduceOnLine(order, line, kbList);

    const getProductRunRateOnLine = (order, line) => {
      const materialCode = String(order.material_code_fg || order.material_code || "").trim();
      const rrKey = PLANT_RUN_RATE_COL[line];
      if (!rrKey || !materialCode) return 0;
      const entry = kbList.find(r => String(r.fg_material_code || "").trim() === materialCode);
      return parseFloat(entry?.[rrKey] || 0) || 0;
    };

    // ─── sort result within each line — reuse the same preSortOrders from azureAI ──
    // This gives us identical N10D categorization + Critical-first logic as per-line
    // auto-sequence, and enriches each order with _effectiveDate / _n10dStatus metadata.

    // ─── build eligible + originalByLine snapshot ──────────────────────────────
    const eligible = activeOrders
      .filter(o => !EXCLUDED_STATUSES.has(o.status) && o.feedmill_line)
      .map(o => ({ ...o, feedmill_line: normalizeLine(o.feedmill_line) }));

    const originalByLine = {};
    PLANT_ALL_LINES.forEach(line => {
      originalByLine[line] = eligible
        .filter(o => o.feedmill_line === line)
        .filter(o => !o.parent_id) // top-level only: leads + standalones (same scope as After table)
        .sort((a, b) => (a.priority_seq || 9999) - (b.priority_seq || 9999));
    });

    // ─── working state ─────────────────────────────────────────────────────────
    const lineOrdersMap = {};
    PLANT_ALL_LINES.forEach(line => {
      lineOrdersMap[line] = eligible
        .filter(o => o.feedmill_line === line)
        .sort((a, b) => (a.priority_seq || 9999) - (b.priority_seq || 9999))
        .map(o => ({
          ...o,
          _originalLine: o.feedmill_line,
          _isPlanned: o.status === "Planned" || o.status === "planned",
          _processed: false,
        }));
    });

    const lineTotalMT = {};
    PLANT_ALL_LINES.forEach(line => {
      lineTotalMT[line] = calculateEffectiveLineTotalMT(lineOrdersMap[line]);
    });

    console.log("=== PLANT AUTO-SEQUENCE (ORDER-BY-ORDER) ===");
    PLANT_ALL_LINES.forEach(line => {
      const rr = getLineRunRate(line);
      console.log(`  ${line}: ${lineTotalMT[line].toFixed(1)} MT ÷ ${rr} MT/hr = ${rr > 0 ? (lineTotalMT[line] / rr).toFixed(2) : "∞"} hrs`);
    });

    const placementLog = [];
    const processedIds = new Set();
    const baseChangeover = 0.17;

    // ═══════════════════════════════════════════════════════════════════════════
    // MAIN LOOP — Line 1 Prio 1 → Line 7 last prio, order by order
    // ═══════════════════════════════════════════════════════════════════════════
    for (const line of PLANT_ALL_LINES) {
      const lineOrders = [...(lineOrdersMap[line] || [])]; // snapshot before mutations

      for (const order of lineOrders) {
        if (order._processed || processedIds.has(order.id)) continue;
        if (order.parent_id) continue; // skip children of existing combined orders — handled via their lead

        // Detect if the base order is itself an existing combined lead
        const baseIsExistingLead = Array.isArray(order.original_order_ids) && order.original_order_ids.length > 0;
        const baseChildren = baseIsExistingLead
          ? eligible.filter(c => String(c.parent_id) === String(order.id))
          : [];
        const orderVolume = baseIsExistingLead && baseChildren.length > 0
          ? baseChildren.reduce((s, c) => s + getOrderVolumeMT(c), 0)
          : getOrderVolumeMT(order);
        const orderMaterialCode = String(order.material_code_fg || order.material_code || "").trim();
        const orderFormulaVersion = String(order.formula_version || "").trim();

        if (!orderMaterialCode) {
          order._processed = true;
          processedIds.add(order.id);
          continue;
        }

        // ── PHASE 1: Find matchable orders across ALL lines ──────────────────
        const matches = [];
        for (const scanLine of PLANT_ALL_LINES) {
          for (const candidate of (lineOrdersMap[scanLine] || [])) {
            if (candidate.id === order.id) continue;
            if (candidate._processed || processedIds.has(candidate.id)) continue;
            if (EXCLUDED_STATUSES.has(candidate.status)) continue;
            if (candidate.parent_id) continue; // skip children — only match leads or single orders
            const cMat = String(candidate.material_code_fg || candidate.material_code || "").trim();
            const cFv = String(candidate.formula_version || "").trim();
            if (cMat !== orderMaterialCode) continue;
            if (cFv !== orderFormulaVersion) continue;
            const cLine = normalizeLine(candidate.feedmill_line || candidate._originalLine);
            // Detect existing combined lead — use real children's volume sum
            const cIsExistingLead = Array.isArray(candidate.original_order_ids) && candidate.original_order_ids.length > 0;
            let cVol;
            if (cIsExistingLead) {
              const cChildren = eligible.filter(c => String(c.parent_id) === String(candidate.id));
              cVol = cChildren.length > 0
                ? cChildren.reduce((s, c) => s + getOrderVolumeMT(c), 0)
                : getOrderVolumeMT(candidate);
            } else {
              cVol = getOrderVolumeMT(candidate);
            }
            matches.push({
              order: candidate,
              volume: cVol,
              line: cLine,
              isPlanned: candidate._isPlanned,
              runRate: getProductRunRateOnLine(candidate, cLine),
              isExistingLead: cIsExistingLead,
            });
          }
        }
        // Sort: lower MT first; same MT → higher run rate wins
        matches.sort((a, b) => {
          const vd = a.volume - b.volume;
          if (Math.abs(vd) > 0.01) return vd;
          return (b.runRate || 0) - (a.runRate || 0);
        });

        // ── PHASE 2: Greedy combine up to 180 MT cap ────────────────────────
        const combinedMatches = [];
        let totalVolume = orderVolume;
        for (const m of matches) {
          if (totalVolume + m.volume <= PLANT_MAX_COMBINE_MT) {
            combinedMatches.push(m);
            totalVolume += m.volume;
          }
        }

        if (combinedMatches.length > 0) {
          // ── PHASE 3: Place combined order ──────────────────────────────────
          // Expand any existing combined leads (base or matched) to their real children
          const oldLeadIdsToDelete = [];

          const _expandToRealSubs = (matchEntry, isBase) => {
            const src = isBase ? order : matchEntry.order;
            const srcVol = isBase ? orderVolume : matchEntry.volume;
            const srcLine = isBase
              ? normalizeLine(order.feedmill_line || order._originalLine)
              : matchEntry.line;
            const isLead = isBase ? baseIsExistingLead : matchEntry.isExistingLead;
            if (isLead) {
              oldLeadIdsToDelete.push(src.id);
              const kids = eligible.filter(c => String(c.parent_id) === String(src.id));
              if (kids.length > 0) {
                return kids.map(k => ({
                  order: k,
                  volume: getOrderVolumeMT(k), // consistent with lineTotalMT init
                  line: normalizeLine(k.feedmill_line || k._originalLine || srcLine),
                }));
              }
              // No children found — fall back to treating the lead as a single order
              return [{ order: src, volume: srcVol, line: srcLine }];
            }
            return [{ order: src, volume: srcVol, line: srcLine }];
          };

          const allSubOrders = [
            ..._expandToRealSubs(null, true),
            ...combinedMatches.flatMap(m => _expandToRealSubs(m, false)),
          ];
          // Compute combination basis: override for user-adjusted, raw for all others.
          // Batch ceiling is applied only ONCE to the final combined sum.
          const batchSzCombine = parseFloat(order.batch_size) || 1;
          const combinedBasisVolume = Number(
            allSubOrders.reduce((sum, sub) => {
              const { basisVolume } = getCombinationBasisVolume(sub.order);
              return sum + basisVolume;
            }, 0).toFixed(2)
          );
          const finalCombinedVolume = adjustVolumeToBatchCeiling(combinedBasisVolume, batchSzCombine);

          // Remove old leads from lineOrdersMap so they don't get processed as regular orders
          for (const oldLeadId of oldLeadIdsToDelete) {
            for (const sl of PLANT_ALL_LINES) {
              lineOrdersMap[sl] = (lineOrdersMap[sl] || []).filter(o => o.id !== oldLeadId);
            }
            processedIds.add(oldLeadId);
          }

          // Lock to Planned order's line if any sub-order is Planned
          const plannedSub = allSubOrders.find(s => s.order._isPlanned);
          let destinationLine = plannedSub ? plannedSub.line : null;
          const wasLockedByPlanned = !!plannedSub;

          // Snapshot the true pre-combine MT for all lines BEFORE removing sub-orders.
          // lineScores (used for destination selection) will be computed from the
          // post-removal state, which is correct for choosing the best destination.
          // But the AI prompt needs the pre-removal state to accurately describe
          // what was on each line before the combination happened.
          const preCombineMTSnapshot = {};
          for (const sl of PLANT_ALL_LINES) {
            preCombineMTSnapshot[sl] = lineTotalMT[sl] || 0;
          }

          // Remove ALL sub-orders from their lines
          allSubOrders.forEach(sub => {
            lineTotalMT[sub.line] = (lineTotalMT[sub.line] || 0) - sub.volume;
            lineOrdersMap[sub.line] = (lineOrdersMap[sub.line] || []).filter(o => o.id !== sub.order.id);
            sub.order._processed = true;
            processedIds.add(sub.order.id);
          });

          // Queue-time placement if not locked
          let lineScores = [];
          if (!wasLockedByPlanned) {
            const eligibleLines = PLANT_ALL_LINES.filter(l => canProduceOnLine(order, l));
            if (eligibleLines.length === 0) {
              destinationLine = normalizeLine(order.feedmill_line || order._originalLine);
            } else {
              lineScores = eligibleLines.map(l => {
                const curMT = lineTotalMT[l] || 0;
                const rr = getLineRunRate(l);
                const ln = parseInt(l.match(/\d+/)?.[0] || "99");
                return {
                  line: l,
                  feedmill: PLANT_LINE_TO_FM_LABEL[l] || l,
                  runRate: rr,
                  totalMTBefore: parseFloat(curMT.toFixed(1)),
                  queueTimeBefore: rr > 0 ? curMT / rr : Infinity,
                  lineNumber: ln,
                };
              });
              lineScores.sort((a, b) => {
                const d = a.queueTimeBefore - b.queueTimeBefore;
                if (Math.abs(d) > 0.001) return d;
                return a.lineNumber - b.lineNumber;
              });
              destinationLine = lineScores[0].line;
            }
          }

          // Build combined order object
          const baseOrder = { ...JSON.parse(JSON.stringify(order)) };
          const combinedRunRate = getLineRunRate(destinationLine);
          baseOrder.volume_override = null; // never inherit stale per-order override
          baseOrder.total_volume_mt = combinedBasisVolume.toFixed(1);
          baseOrder.volume = finalCombinedVolume;
          baseOrder.production_hours = combinedRunRate > 0
            ? (finalCombinedVolume / combinedRunRate).toFixed(2)
            : '0.00';
          baseOrder.feedmill_line = destinationLine;
          baseOrder.line = destinationLine;
          baseOrder._isCombined = true;
          baseOrder._oldLeadIdsToDelete = oldLeadIdsToDelete;
          baseOrder._combined_basis_volume = combinedBasisVolume;
          baseOrder._combined_effective_volume = finalCombinedVolume;
          baseOrder._combine_basis_breakdown = allSubOrders.map(sub => {
            const result = getCombinationBasisVolume(sub.order);
            return {
              order_id: sub.order.id,
              basisType: result.basisType,
              rawVolume: result.rawVolume,
              batchSize: result.batchSize,
              usedVolume: result.basisVolume,
            };
          });
          baseOrder._combinedFrom = allSubOrders.map(s => ({
            id: s.order.id,
            line: s.line,
            fpr: s.order.fpr,
            volume: s.volume,
            total_volume_mt: s.volume,
            volume_override: s.order.volume_override ?? null,
            item_description: s.order.item_description,
            form: s.order.form,
            material_code_fg: s.order.material_code_fg || s.order.material_code,
            material_code: s.order.material_code || s.order.material_code_fg,
            fg: s.order.fg,
            sfg: s.order.sfg,
            batch_size: s.order.batch_size,
            batches: s.order.batch_size && parseFloat(s.order.batch_size) > 0
              ? Math.ceil(s.volume / parseFloat(s.order.batch_size))
              : null,
            production_time: s.order.production_hours,
            target_avail_date: s.order.target_avail_date,
            category: s.order.category,
          }));
          baseOrder._combinedFromLines = [...new Set(allSubOrders.map(s => s.line))];
          baseOrder._originalLine = normalizeLine(order.feedmill_line || order._originalLine);
          baseOrder._plantMovement = baseOrder._originalLine === destinationLine ? "same" : "new_to_line";
          baseOrder._movedFromLine = baseOrder._originalLine !== destinationLine ? baseOrder._originalLine : null;
          baseOrder.batches = batchSzCombine > 0 ? Math.ceil(finalCombinedVolume / batchSzCombine) : 0;

          console.debug('[Combine Basis]', {
            combineOrderIds: allSubOrders.map(o => o.order.id),
            breakdown: baseOrder._combine_basis_breakdown,
            combinedBasisVolume,
            batchSize: batchSzCombine,
            finalCombinedVolume,
          });

          // Place on destination line
          lineTotalMT[destinationLine] = (lineTotalMT[destinationLine] || 0) + finalCombinedVolume;
          if (!lineOrdersMap[destinationLine]) lineOrdersMap[destinationLine] = [];
          lineOrdersMap[destinationLine].push(baseOrder);

          // Enrich scores with after-placement values
          const enrichedScores = lineScores.map(ls => ({
            ...ls,
            totalMTAfter: parseFloat((lineTotalMT[ls.line] || 0).toFixed(1)),
            queueTimeAfter: parseFloat((ls.runRate > 0 ? (lineTotalMT[ls.line] || 0) / ls.runRate : 0).toFixed(2)),
          }));
          const bestScore = enrichedScores.find(ls => ls.line === destinationLine) || enrichedScores[0];
          const changeoversSaved = allSubOrders.length - 1;
          const fromLines = [...new Set(allSubOrders.map(s => s.line))];

          console.log(`  [Combined] ${order.item_description} (${allSubOrders.length} orders, basis ${combinedBasisVolume.toFixed(1)} MT → effective ${finalCombinedVolume.toFixed(1)} MT) → ${destinationLine}${wasLockedByPlanned ? " [Planned lock]" : ""}`);

          // Compute eligibility for the combined product (use the lead order's master-data eligibility).
          // When wasLockedByPlanned is true, destination was forced by a Planned order, NOT chosen
          // for master-data eligibility — so suppress onlyTargetEligible to avoid misleading insights.
          const combinedEligibleLines = PLANT_ALL_LINES.filter(l => canProduceOnLine(order, l));
          const combinedOnlyTargetEligible =
            !wasLockedByPlanned &&
            combinedEligibleLines.length === 1 &&
            combinedEligibleLines[0] === destinationLine;

          placementLog.push({
            type: "combined",
            eligibleLines: combinedEligibleLines,
            onlyTargetEligible: combinedOnlyTargetEligible,
            product: order.item_description || order.material_code,
            materialCode: order.material_code_fg || order.material_code,
            ordersCount: allSubOrders.length,
            fromLines,
            toLine: destinationLine,
            totalVolume: finalCombinedVolume,
            wasLockedByPlanned,
            individualVolumes: allSubOrders.map(s => ({
              id: s.order.id,
              name: s.order.item_description,
              volume: s.volume,
              fromLine: s.line,
              fpr: s.order.fpr,
            })),
            lineScores: enrichedScores,
            bestLineReason: bestScore ? {
              line: destinationLine,
              feedmill: PLANT_LINE_TO_FM_LABEL[destinationLine] || destinationLine,
              runRate: bestScore.runRate || 0,
              queueTime: parseFloat((bestScore.queueTimeBefore || 0).toFixed(2)),
              totalMTBefore: bestScore.totalMTBefore || 0,
              totalMTAfter: bestScore.totalMTAfter || 0,
              queueTimeAfter: parseFloat((bestScore.queueTimeAfter || 0).toFixed(2)),
            } : {
              line: destinationLine,
              feedmill: PLANT_LINE_TO_FM_LABEL[destinationLine] || destinationLine,
              runRate: getLineRunRate(destinationLine),
              queueTime: 0,
              totalMTBefore: 0,
              totalMTAfter: totalVolume,
              queueTimeAfter: parseFloat((totalVolume / getLineRunRate(destinationLine)).toFixed(2)),
            },
            changeoversSaved,
            baseChangeover,
            timeSaved: parseFloat((changeoversSaved * baseChangeover).toFixed(2)),
            // True pre-combine line loads — used by the AI prompt for accurate "before" reporting.
            // lineScores.totalMTBefore is computed post-removal (needed for destination selection)
            // so it shows 0 for combine-in-place. preCombineMTByLine holds the real pre-action state.
            preCombineMTByLine: preCombineMTSnapshot,
          });

          continue; // next order
        }

        // ── No match — evaluate single order placement ──────────────────────

        // If the base order is an existing combined lead with no new combine partners,
        // remove its children from lineOrdersMap so they don't appear as standalone rows.
        // Restore _isCombined/_combinedFrom so the After table renders it as a combined group.
        if (baseIsExistingLead && baseChildren.length > 0) {
          for (const child of baseChildren) {
            const childLine = normalizeLine(child.feedmill_line || line);
            lineOrdersMap[childLine] = (lineOrdersMap[childLine] || []).filter(o => o.id !== child.id);
            processedIds.add(child.id);
          }
          order._isCombined = true;
          order._combinedFrom = baseChildren.map(c => ({
            id: c.id,
            fpr: c.fpr,
            volume: getOrderVolumeMT(c),
            total_volume_mt: getOrderVolumeMT(c),
            volume_override: c.volume_override ?? null,
            line: normalizeLine(c.feedmill_line || line),
            item_description: c.item_description,
            material_code_fg: c.material_code_fg,
            material_code: c.material_code,
            form: c.form,
            category: c.category,
            fg: c.fg,
            sfg: c.sfg,
            production_time: c.production_hours,
            batch_size: c.batch_size,
            batches: c.batches,
            status: c.status,
            target_avail_date: c.target_avail_date,
          }));
        }

        // Planned orders stay on their line — never move them solo
        if (order._isPlanned) {
          order._processed = true;
          processedIds.add(order.id);
          continue;
        }

        const currentLine = normalizeLine(order.feedmill_line || order._originalLine);
        const eligibleLines = PLANT_ALL_LINES.filter(l => canProduceOnLine(order, l));

        if (eligibleLines.length === 0) {
          order._processed = true;
          processedIds.add(order.id);
          continue;
        }

        // Capture source line state BEFORE removing the order — this is the true "before move" load
        const sourceRunRate = getLineRunRate(currentLine);
        const sourceBeforeMT = parseFloat(((lineTotalMT[currentLine] || 0)).toFixed(2));
        const sourceAfterMT = parseFloat((Math.max(0, sourceBeforeMT - orderVolume)).toFixed(2));
        const sourceBeforeQueue = calculateQueueTimeHours(sourceBeforeMT, sourceRunRate);
        const sourceAfterQueue = calculateQueueTimeHours(sourceAfterMT, sourceRunRate);

        // Remove from current line
        lineTotalMT[currentLine] = (lineTotalMT[currentLine] || 0) - orderVolume;
        lineOrdersMap[currentLine] = (lineOrdersMap[currentLine] || []).filter(o => o.id !== order.id);

        // Build candidate scores from the post-removal state of each line
        // (correct for all destination lines; source line not included as its own destination)
        const singleScores = eligibleLines.map(l => {
          const curMT = lineTotalMT[l] || 0;
          const rr = getLineRunRate(l);
          const ln = parseInt(l.match(/\d+/)?.[0] || "99");
          return {
            line: l,
            feedmill: PLANT_LINE_TO_FM_LABEL[l] || l,
            runRate: rr,
            totalMTBefore: parseFloat(curMT.toFixed(1)),
            queueTimeBefore: rr > 0 ? curMT / rr : Infinity,
            lineNumber: ln,
          };
        });
        singleScores.sort((a, b) => {
          const d = a.queueTimeBefore - b.queueTimeBefore;
          if (Math.abs(d) > 0.001) return d;
          return a.lineNumber - b.lineNumber;
        });
        const bestLine = singleScores[0].line;

        order.feedmill_line = bestLine;
        order.line = bestLine;
        order._plantMovement = currentLine === bestLine ? "same" : "new_to_line";
        order._movedFromLine = currentLine !== bestLine ? currentLine : null;
        order._processed = true;
        processedIds.add(order.id);

        lineTotalMT[bestLine] = (lineTotalMT[bestLine] || 0) + orderVolume;
        if (!lineOrdersMap[bestLine]) lineOrdersMap[bestLine] = [];
        lineOrdersMap[bestLine].push(order);

        if (bestLine !== currentLine) {
          const enrichedSingle = singleScores.map(ls => ({
            ...ls,
            totalMTAfter: parseFloat((lineTotalMT[ls.line] || 0).toFixed(1)),
            queueTimeAfter: parseFloat((ls.runRate > 0 ? (lineTotalMT[ls.line] || 0) / ls.runRate : 0).toFixed(2)),
          }));
          const movedBest = enrichedSingle.find(ls => ls.line === bestLine) || enrichedSingle[0];

          console.log(`  [Moved] ${order.item_description} (${orderVolume} MT) ${currentLine} → ${bestLine}`);

          console.debug('[Queue Time Calculation]', {
            sourceLine: currentLine,
            destinationLine: bestLine,
            movedOrderId: order.id,
            movedMT: orderVolume,
            sourceBeforeMT,
            sourceAfterMT,
            destinationBeforeMT: movedBest?.totalMTBefore || 0,
            destinationAfterMT: movedBest?.totalMTAfter || 0,
            sourceRunRate,
            destinationRunRate: getLineRunRate(bestLine),
            sourceBeforeQueue,
            sourceAfterQueue,
            destinationBeforeQueue: parseFloat((movedBest?.queueTimeBefore || 0).toFixed(2)),
            destinationAfterQueue: parseFloat((movedBest?.queueTimeAfter || 0).toFixed(2)),
            sourceOrderCount: (lineOrdersMap[currentLine] || []).length,
            destinationOrderCount: (lineOrdersMap[bestLine] || []).length,
          });

          const onlyTargetEligible =
            eligibleLines.length === 1 && eligibleLines[0] === bestLine;
          const sourceEligible = eligibleLines.includes(currentLine);

          placementLog.push({
            type: "moved",
            order: order.item_description || order.material_code,
            product: order.item_description || order.material_code,
            volume: orderVolume,
            fromLine: currentLine,
            toLine: bestLine,
            fpr: order.fpr,
            lineScores: enrichedSingle,
            eligibleLines,
            onlyTargetEligible,
            sourceEligible,
            bestLineReason: {
              line: bestLine,
              feedmill: PLANT_LINE_TO_FM_LABEL[bestLine] || bestLine,
              runRate: movedBest?.runRate || 0,
              queueTime: parseFloat((movedBest?.queueTimeBefore || 0).toFixed(2)),
              totalMTBefore: movedBest?.totalMTBefore || 0,
              totalMTAfter: movedBest?.totalMTAfter || 0,
              queueTimeAfter: parseFloat((movedBest?.queueTimeAfter || 0).toFixed(2)),
            },
            fromLineReason: {
              line: currentLine,
              runRate: sourceRunRate,
              totalMTBefore: sourceBeforeMT,
              totalMTAfter: sourceAfterMT,
              queueTime: sourceBeforeQueue,
              queueTimeAfter: sourceAfterQueue,
            },
          });
        }
      }
    }

    // ── Sort each line's final orders chronologically — ALL orders, no planned-lock ──
    // Planned orders participate in the same date-based sort; they are NOT pinned to top.
    // Sort tiers:
    //   0 — Critical (no avail date, N10D=Critical) — top, by DFL/Inv ratio desc
    //   1 — Any order with an effective date (hard avail OR inferred) — sorted by date asc
    //   2 — No date signal at all — bottom
    // Dates from any source (target_avail_date or N10D inferred) are treated equally —
    // Apr 19 from N10D always sorts before Apr 20 from hard avail date.
    const _pcIsRealISO = (v) => !!v && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v));
    const plantChronologicalSort = (lineOrders) => {
      const enriched = lineOrders.map(o => {
        const inf = inferredTargetMap?.[o.material_code] || inferredTargetMap?.[o.material_code_fg];
        // Dates from auto-sequence or N10D are re-evaluated from latest N10D data — not hard deadlines
        const _pcIsN10DSourced = o.avail_date_source === 'auto_sequence' || o.date_source === 'n10d';
        const isHardDeadline = _pcIsRealISO(o.target_avail_date) && !_pcIsN10DSourced;
        let sortTier = 2; // no date
        let effectiveDate = null;
        let dflToInvRatio = 0;
        let n10dStatus = inf?.status || null;

        if (inf?.status === 'Critical' && !isHardDeadline) {
          // Critical with no hard avail date → absolute top
          sortTier = 0;
          effectiveDate = null;
          const dfl = parseFloat(inf.dueForLoading) || 0;
          const inv = parseFloat(inf.inventory) || 0;
          dflToInvRatio = inv > 0 ? dfl / inv : Infinity;
        } else {
          // All other orders: prefer fresh N10D date; fall back to hard avail date
          if (inf?.targetDate && _pcIsRealISO(inf.targetDate)) {
            effectiveDate = new Date(inf.targetDate);
          } else if (isHardDeadline) {
            effectiveDate = new Date(o.target_avail_date);
          }
          sortTier = effectiveDate ? 1 : 2;
        }

        return { ...o, _sortTier: sortTier, _effectiveDate: effectiveDate, _n10dStatus: n10dStatus, _dflToInvRatio: dflToInvRatio };
      });

      enriched.sort((a, b) => {
        if (a._sortTier !== b._sortTier) return a._sortTier - b._sortTier;
        // Tier 0 — Critical: highest DFL/Inv ratio first
        if (a._sortTier === 0) return (b._dflToInvRatio ?? 0) - (a._dflToInvRatio ?? 0);
        // Tier 1 — all dated orders: strictly chronological regardless of date source
        if (a._effectiveDate && b._effectiveDate) return a._effectiveDate - b._effectiveDate;
        if (a._effectiveDate) return -1;
        if (b._effectiveDate) return 1;
        return 0;
      });

      enriched.forEach((o, i) => {
        o.prio = i + 1;
        o.priority_seq = i + 1;
      });
      return enriched;
    };

    const sequencedByLine = {};
    PLANT_ALL_LINES.forEach(line => {
      sequencedByLine[line] = plantChronologicalSort(lineOrdersMap[line] || []);
    });

    // ── Greedy conflict resolver + annotation ─────────────────────────────────
    // 1. Runs cascade simulation on each line's sorted sequence.
    // 2. When a deadline conflict is found, moves the "blocking" order (no
    //    deadline or later deadline than the conflicting order) to after the
    //    conflicting order, then re-simulates — up to 30 passes.
    // 3. Annotates the final sequence with _simEstCompletion / _scheduleConflict
    //    so the After table can still warn about genuinely unsolvable conflicts.
    const _simIsRealISO = (v) => !!v && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v));
    // PHT = UTC+8: midnight UTC of a date = 8 AM PHT of that date.
    const _PHT_MS = 8 * 3600_000;
    const _toPHTDateStr = (d) => new Date(d.getTime() + _PHT_MS).toISOString().substring(0, 10);
    const _parseSimDate = (dateStr, timeStr) => {
      if (!dateStr) return null;
      const dateOnly = String(dateStr).substring(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return null;
      const tp = String(timeStr || '08:00').match(/(\d+):(\d+)\s*(am|pm)?/i);
      if (!tp) return null;
      let h = parseInt(tp[1]), m = parseInt(tp[2]);
      if (tp[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
      if (tp[3]?.toLowerCase() === 'am' && h === 12) h = 0;
      // PHT 8 AM = UTC midnight; PHT h:m = UTC midnight + (h-8)h + m min
      const base = new Date(`${dateOnly}T00:00:00.000Z`);
      return new Date(base.getTime() + (h - 8) * 3600_000 + m * 60_000);
    };

    // PHT 8:00 AM today
    const _todayPHT = _toPHTDateStr(new Date());
    const todaySimStart = new Date(`${_todayPHT}T00:00:00.000Z`);

    // Runs a forward simulation on a sequence; returns annotated copy of results.
    const runLineSim = (seq) => {
      let rolling = null;
      return seq.map(order => {
        if (order.status === 'In Production' || order.status === 'On-going') {
          if (order.target_completion_date) {
            const parts = order.target_completion_date.split(' ');
            const ex = _parseSimDate(parts[0], parts[1]);
            if (ex) rolling = ex;
          }
          return { order, simEnd: rolling, conflict: false };
        }
        const ph = calcProductionHours(order) ?? 0;
        const co = parseFloat(order._changeoverTotal ?? order.changeover_time ?? 0.17);
        let simStart;
        if (order.start_date && order.start_time) {
          simStart = _parseSimDate(order.start_date, order.start_time);
        } else if (rolling) {
          simStart = new Date(rolling.getTime() + co * 3600000);
        } else {
          simStart = new Date(todaySimStart);
        }
        const simEnd = simStart ? new Date(simStart.getTime() + ph * 3600000) : null;
        let conflict = false;
        if (simEnd && _simIsRealISO(order.target_avail_date)) {
          // PHT 23:59:59 = UTC 15:59:59 of the same date (UTC+8 − 8h = UTC, 23:59−8h = 15:59)
          const dl = new Date(`${String(order.target_avail_date).substring(0, 10)}T15:59:59.999Z`);
          conflict = simEnd > dl;
        }
        if (simEnd) rolling = simEnd;
        return { order, simEnd, conflict };
      });
    };

    // Greedy optimizer: tries to move blocking orders after conflicting ones.
    const resolveLineConflicts = (lineSeq) => {
      const isLocked = (o) => o.status === 'In Production' || o.status === 'On-going';
      const locked = lineSeq.filter(isLocked);
      let mutable = lineSeq.filter(o => !isLocked(o));
      const MAX_PASSES = 30;

      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const simResults = runLineSim([...locked, ...mutable]);
        // First conflict in the full sequence
        const firstConflictIdx = simResults.findIndex(r => r.conflict);
        if (firstConflictIdx === -1) break; // All clear

        const conflictOrder = simResults[firstConflictIdx].order;
        const conflictDL = new Date(conflictOrder.target_avail_date);
        conflictDL.setHours(23, 59, 59, 999);

        // Find the conflicting order's position inside mutable
        const mutIdx = mutable.indexOf(conflictOrder);
        if (mutIdx <= 0) break; // Nothing before it that we can move

        // Find the closest moveable order before it:
        // moveable = no deadline OR deadline strictly later than the conflicting order's deadline
        let moveIdx = -1;
        for (let j = mutIdx - 1; j >= 0; j--) {
          const o = mutable[j];
          if (isLocked(o)) continue;
          const hasDeadline = _simIsRealISO(o.target_avail_date);
          if (!hasDeadline) { moveIdx = j; break; }
          const oDL = new Date(o.target_avail_date);
          if (oDL > conflictDL) { moveIdx = j; break; }
        }
        if (moveIdx === -1) break; // Nothing moveable — genuine capacity issue

        // Move mutable[moveIdx] to just after mutIdx
        // After splice(moveIdx,1) the array shrinks by 1, so mutIdx becomes mutIdx-1,
        // and inserting at mutIdx places the element directly after the conflict order.
        const [moved] = mutable.splice(moveIdx, 1);
        mutable.splice(mutIdx, 0, moved);
      }

      return [...locked, ...mutable];
    };

    // Apply optimizer then annotate the final sequence
    PLANT_ALL_LINES.forEach(line => {
      const optimized = resolveLineConflicts(sequencedByLine[line] || []);
      sequencedByLine[line] = optimized;

      // Annotation pass: mark remaining conflicts (genuinely unsolvable by re-order)
      const simResults = runLineSim(optimized);
      simResults.forEach(({ order, simEnd, conflict }) => {
        order._simEstCompletion = simEnd;
        order._scheduleConflict = conflict;
      });
    });

    // ── Apply preview-style changeovers to both before/after arrays ───────────
    // originalByLine orders come from enrichedOrders (KB-enriched only, no
    // _changeoverTotal). sequencedByLine orders also carry no correct sequence-
    // aware changeover. applyPreviewChangeovers sets _changeoverTotal on each
    // row based on the actual next-order in that line's sorted list — exactly
    // matching what PlantLineTab shows in its table rows.
    PLANT_ALL_LINES.forEach(line => {
      const before = originalByLine[line];
      const after = sequencedByLine[line];
      if (before?.length) applyPreviewChangeovers(before, coRules);
      if (after?.length)  applyPreviewChangeovers(after, coRules);
      console.debug('[Preview Changeover Check]', {
        line,
        before: (before || []).map(o => ({ orderId: o.id, displayedChangeover: parseFloat(o._changeoverTotal ?? 0) })),
        beforeTotalChangeover: parseFloat(((before || []).reduce((s, o) => s + (parseFloat(o._changeoverTotal ?? 0) || 0), 0)).toFixed(2)),
        after: (after || []).map(o => ({ orderId: o.id, displayedChangeover: parseFloat(o._changeoverTotal ?? 0) })),
        afterTotalChangeover: parseFloat(((after || []).reduce((s, o) => s + (parseFloat(o._changeoverTotal ?? 0) || 0), 0)).toFixed(2)),
      });
    });

    // ── Summary stats ──────────────────────────────────────────────────────────
    const perLineSummary = PLANT_ALL_LINES.map(line => {
      const before = originalByLine[line] || [];
      const after = sequencedByLine[line] || [];
      const beforeMT = calculateEffectiveLineTotalMT(before);
      const afterMT = calculateEffectiveLineTotalMT(after);
      const runRate = getLineRunRate(line);
      const beforeHours = calculateLineHoursBreakdown(before);
      const afterHours = calculateLineHoursBreakdown(after);
      const newOrders = after.filter(o => o._plantMovement === "new_to_line").length;
      const removedOrders = before.filter(o =>
        !after.some(a => a.id === o.id && !a._isCombined) &&
        !after.some(a => a._isCombined && a._combinedFrom?.some(c => c.id === o.id))
      ).length;
      return {
        line,
        feedmill: PLANT_LINE_TO_FM_LABEL[line] || line,
        runRate,
        beforeCount: before.length,
        afterCount: after.length,
        beforeMT: beforeMT.toFixed(1),
        afterMT: afterMT.toFixed(1),
        beforeHours,
        afterHours,
        hoursDiff: Number((afterHours.totalHours - beforeHours.totalHours).toFixed(2)),
        newOrders,
        removedOrders,
      };
    });

    const totalOrdersBefore = PLANT_ALL_LINES.reduce((s, l) => s + (originalByLine[l] || []).length, 0);
    const totalOrdersAfter = PLANT_ALL_LINES.reduce((s, l) => s + (sequencedByLine[l] || []).length, 0);
    const ordersCombined = PLANT_ALL_LINES.reduce((s, l) => s + (sequencedByLine[l] || []).filter(o => o._isCombined).length, 0);
    const ordersMovedBetweenLines = PLANT_ALL_LINES.reduce(
      (s, l) => s + (sequencedByLine[l] || []).filter(o => o._plantMovement === "new_to_line").length, 0
    );

    const linesAffectedSet = new Set();
    placementLog.forEach(entry => {
      const isCrossLine = entry.type === "combined"
        ? (entry.fromLines || []).some(l => l !== entry.toLine)
        : entry.fromLine && entry.fromLine !== entry.toLine;
      if (isCrossLine) {
        if (entry.type === "combined") {
          (entry.fromLines || []).forEach(l => linesAffectedSet.add(l));
        } else {
          linesAffectedSet.add(entry.fromLine);
        }
        linesAffectedSet.add(entry.toLine);
      }
    });

    return {
      originalByLine,
      sequencedByLine,
      placementLog,
      summaryStats: {
        totalOrdersBefore,
        totalOrdersAfter,
        ordersCombined,
        ordersMovedBetweenLines,
        linesAffected: linesAffectedSet.size,
        perLineSummary,
      },
    };
  };

  // ── Plant Auto-Sequence completion sound ─────────────────────────────────
  // Uses Web Audio API to synthesize a soft two-tone chime (C5 → E5).
  // No binary asset required. Fails silently if audio context is unavailable
  // or if the browser blocks autoplay.
  const playAutoSequenceCompleteSound = () => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const notes = [523.25, 659.25]; // C5 → E5
      const now = ctx.currentTime;
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.value = freq;
        const startAt = now + i * 0.2;
        const duration = 0.5;
        gain.gain.setValueAtTime(0, startAt);
        gain.gain.linearRampToValueAtTime(0.22, startAt + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
        osc.start(startAt);
        osc.stop(startAt + duration);
      });
      setTimeout(() => ctx.close().catch(() => {}), 1500);
    } catch {
      // fail silently — never break the auto-sequence flow
    }
  };

  // Shared helper — same chime used for auto-sequence-complete AND apply-to-schedule success.
  // Call this at every confirmed-success exit point so the user gets consistent audio feedback.
  const playSuccessNotificationSound = () => {
    playAutoSequenceCompleteSound();
    console.debug('[Apply To Schedule Success Sound]', { applied: true, soundPlayed: true });
  };

  const handleCancelPlantSeq = () => {
    plantSeqCancelledRef.current = true;
    plantSeqAbortRef.current?.abort();
    setShowProcessingOverlay(false);
    toast('Auto-sequence cancelled.', { icon: 'ℹ️' });
  };

  const handlePlantLevelAutoSequence = async () => {
    const PLANT_EXCLUDED = new Set([
      "completed", "cancel_po",
      "in_production", "ongoing_batching", "ongoing_pelleting", "ongoing_bagging",
    ]);
    const allActive = enrichedOrders.filter((o) => !PLANT_EXCLUDED.has(o.status) && o.feedmill_line);
    if (allActive.length < 2) {
      toast.error("At least 2 active orders across all lines are needed for plant-level auto-sequencing.");
      return;
    }

    // Reset cancellation state and assign a unique run ID for this run.
    // The run ID lets us detect and discard stale async results from a
    // previously-cancelled run that may still be settling.
    plantSeqCancelledRef.current = false;
    plantSeqRunIdRef.current += 1;
    const runId = plantSeqRunIdRef.current;
    const abortCtrl = new AbortController();
    plantSeqAbortRef.current = abortCtrl;

    console.debug('[AutoSequence Run State]', {
      runId,
      cancelled: false,
      abortSignalAborted: abortCtrl.signal.aborted,
    });

    // Show processing overlay — close modal first if re-analyzing
    setPlantSeqLoading(false);
    setPlantSeqOrderCount(allActive.length);
    setPlantSeqPreloadedAI(null);
    setPlantSeqPreloadedStrategies(null);
    setProcessingStats({ processed: 0, total: allActive.length, combined: 0, moved: 0 });
    setProcessingLabel('Plant-Level Auto-Sequence');
    setProcessingPhase('scanning');
    setShowProcessingOverlay(true);

    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const checkCancelled = () => {
      if (plantSeqCancelledRef.current) throw new Error('AUTO_SEQUENCE_CANCELLED');
    };

    try {
      await delay(80); // let overlay mount + paint
      checkCancelled();

      // ── Phase: scanning ──────────────────────────────────────────────────
      setProcessingPhase('scanning');
      await delay(320);
      checkCancelled();

      // ── Phase: combining ─────────────────────────────────────────────────
      setProcessingPhase('combining');
      await delay(180);
      checkCancelled();

      // ── Phase: calculating ───────────────────────────────────────────────
      setProcessingPhase('calculating');
      await delay(120);
      checkCancelled();

      // ── Phase: placing — run the synchronous algorithm ───────────────────
      setProcessingPhase('placing');
      await delay(60);
      checkCancelled();

      const result = plantLevelCombineAndPlace(enrichedOrders, kbRecords, changeoverRules);

      // ── Enrich After-table with fresh N10D dates ──────────────────────────
      // plantLevelCombineAndPlace sorts by _effectiveDate (from inferredTargetMap),
      // but the orders still carry their stale DB target_avail_date strings.
      // Overwrite target_avail_date / inferred fields so the preview shows the
      // date the user will actually see written to the DB on approval.
      const _freshISO = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const _todayFreshISO = () => _freshISO(new Date());
      for (const [line, lineOrders] of Object.entries(result.sequencedByLine || {})) {
        result.sequencedByLine[line] = lineOrders.map(order => {
          const inf = inferredTargetMap?.[order.material_code] || inferredTargetMap?.[order.material_code_fg];
          const isN10DSourced = order.avail_date_source === 'auto_sequence' || order.date_source === 'n10d';
          if (!inf || !isN10DSourced) return order;
          if (inf.targetDate && /^\d{4}-\d{2}-\d{2}/.test(inf.targetDate)) {
            return { ...order, target_avail_date: inf.targetDate, inferred_target_date: inf.targetDate, inferred_target_label: inf.status || null };
          }
          if (inf.status === 'Critical') {
            return { ...order, target_avail_date: _todayFreshISO(), inferred_target_label: 'Critical' };
          }
          if (inf.status === 'Sufficient') {
            return { ...order, target_avail_date: 'stock_sufficient', inferred_target_label: 'Sufficient' };
          }
          return order;
        });
      }

      // Update live stats from algorithm output
      const combinedCount = result.summaryStats?.ordersCombined || 0;
      const movedCount    = result.summaryStats?.ordersMovedBetweenLines || 0;
      setProcessingStats({ processed: allActive.length, total: allActive.length, combined: combinedCount, moved: movedCount });

      // ── Phase: n10d ──────────────────────────────────────────────────────
      setProcessingPhase('n10d');
      await delay(220);
      checkCancelled();

      // ── Phase: sequencing ────────────────────────────────────────────────
      setProcessingPhase('sequencing');
      await delay(220);
      checkCancelled();

      // ── Phase: changeovers ───────────────────────────────────────────────
      setProcessingPhase('changeovers');
      await delay(220);
      checkCancelled();

      // ── Phase: AI strategy options — insights + strategies run in parallel ─
      setProcessingPhase('strategies');
      let explanations = null;
      let useFallback  = false;
      let strategies   = null;
      console.debug('[AI Strategy Generation]', { runId, status: 'starting' });
      await Promise.allSettled([
        (async () => {
          try {
            const { systemPrompt, userPrompt, precomputedInsights } = buildPlantActionsPrompt(result.placementLog);
            const response = await callPlantActionsAI(systemPrompt, userPrompt, 1400, abortCtrl.signal);
            // Discard if this run was cancelled or superseded
            if (plantSeqCancelledRef.current || runId !== plantSeqRunIdRef.current) return;
            const parsed   = parsePlantActionsResponse(response, result.placementLog, precomputedInsights);
            if (Object.keys(parsed).length >= Math.max(1, result.placementLog.length * 0.5)) {
              explanations = parsed;
            } else {
              useFallback = true;
            }
          } catch {
            useFallback = true;
          }
        })(),
        (async () => {
          try {
            const strats = await generateSequenceStrategies(result.sequencedByLine, kbRecords, inferredTargetMap, changeoverRules, abortCtrl.signal);
            console.debug('[AI Strategy Result]', { runId, currentRunId: plantSeqRunIdRef.current, stale: runId !== plantSeqRunIdRef.current });
            // Discard if this run was cancelled or superseded by a newer run
            if (!plantSeqCancelledRef.current && runId === plantSeqRunIdRef.current) strategies = strats;
          } catch (stratErr) {
            if (stratErr?.name !== 'AbortError') {
              console.error("[Dashboard] strategy generation failed:", stratErr);
            }
          }
        })(),
      ]);

      // Final guard: discard everything if cancelled or a newer run has started
      if (plantSeqCancelledRef.current || runId !== plantSeqRunIdRef.current) return;

      // ── Pre-build per-row insights (part of the strategies phase, not a separate UI step) ──
      // Runs in parallel for all lines × strategies so the modal opens with
      // insights already attached.  Uses best-effort (Promise.allSettled inside)
      // so a single AI failure never prevents the preview from opening.
      // The progress overlay stays on 'strategies' so the user sees one unified AI step.
      if (strategies) {
        await enrichStrategiesWithRowInsights(strategies);
        // Guard again — user may have cancelled during insight generation.
        if (plantSeqCancelledRef.current || runId !== plantSeqRunIdRef.current) return;
      }

      // ── Phase: done ──────────────────────────────────────────────────────
      setProcessingPhase('done');
      await delay(500);

      // Commit results only if still not cancelled
      setPlantSeqSnapshot(result.originalByLine);
      setPlantSeqResults(result.sequencedByLine);
      setPlantSeqSummary(result.summaryStats);
      setPlantSeqLog(result.placementLog);
      setPlantSeqPreloadedAI({ explanations, useFallback });
      setPlantSeqPreloadedStrategies(strategies);

      // Close overlay → open modal (or leave modal open if re-analyzing)
      setShowProcessingOverlay(false);
      setPlantSeqOpen(true);

      // 🔔 Notify user: auto-sequence completed and preview is ready
      console.debug('[AutoSequence Completion Sound]', {
        completed: true,
        cancelled: plantSeqCancelledRef.current,
        previewReady: true,
      });
      playAutoSequenceCompleteSound();
      toast.success('Plant-Level Auto-Sequence complete. Preview is ready.');

    } catch (err) {
      // If the user cancelled (overlay already closed + toast already shown), silently exit
      if (
        plantSeqCancelledRef.current ||
        err?.name === 'AbortError' ||
        err?.message === 'AUTO_SEQUENCE_CANCELLED'
      ) {
        setShowProcessingOverlay(false);
        return;
      }
      console.error("Plant-level auto-sequence error:", err);
      setShowProcessingOverlay(false);
      toast.error("Failed to run plant-level auto-sequence. Please try again.");
    }
  };

  // ── Shared: apply sequenced results to DB for all three Auto-Sequence flows ──
  const applySequencedResultsToDB = async (sequencedResults, options = {}) => {
    const { label = 'Auto-Sequence', inferredTargetMap: itm = {}, strategyNameByLine = {} } = options;
    const _isOptimizeFlow = /optimization/i.test(label);
    const _historyEventLabel = _isOptimizeFlow ? 'Optimize order' : 'Auto-sequence';
    const _historyTs = formatTimestamp();

    const _isRealISO = (v) => !!v && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v));
    const _todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
    const _resolveAvail = (order) => {
      // AI strategy has explicitly suggested a date for this order.
      // This is what the preview shows — applying must write the same date.
      // Checked first, before any hard-date guard, so the AI sequence is honored.
      if (_isRealISO(order._aiSuggestedDate)) {
        return String(order._aiSuggestedDate).substring(0, 10);
      }
      // For orders whose date was written by a previous auto-sequence run, allow
      // overwriting with the fresh N10D date from the latest upload.
      // SAP/manual hard dates are kept intact.
      const _rvN10DSourced = order.avail_date_source === 'auto_sequence' || order.date_source === 'n10d';
      if (_isRealISO(order.target_avail_date) && !_rvN10DSourced) return null;
      if (order._effectiveDate instanceof Date && !isNaN(order._effectiveDate)) {
        const _ed = order._effectiveDate;
        return `${_ed.getFullYear()}-${String(_ed.getMonth()+1).padStart(2,'0')}-${String(_ed.getDate()).padStart(2,'0')}`;
      }
      const inf = itm?.[order.material_code] || itm?.[order.material_code_fg];
      if (inf?.targetDate && _isRealISO(inf.targetDate)) return inf.targetDate;
      if (inf?.status === 'Critical') return _todayISO();
      return null;
    };

    // ── Snapshot current DB state ONCE ─────────────────────────────────────────
    const currentDbOrders = queryClient.getQueryData(['orders']) || [];
    const dbOrderIds = new Set(currentDbOrders.map(o => String(o.id)));

    console.log(`=== ${label} ===`);
    console.log(`  DB has ${currentDbOrders.length} orders`);

    const combinedLeadMap = {};   // previewLeadId → real new lead ID
    const oldLeadsToDelete = new Set(); // lead IDs to delete after all operations
    const pendingIdMap = {};      // tempId → real DB id (for pending orders)

    // ── Pass 1: Separate regular vs combined orders; assign priority counters ─
    const regularUpdates = [];   // { id, data } — batched in parallel below
    const pendingCreates = [];   // { order, data } — created sequentially
    const combinedGroups = [];   // processed sequentially (create lead → update children)

    for (const [line, lineOrders] of Object.entries(sequencedResults)) {
      if (!lineOrders || lineOrders.length === 0) continue;

      const inProdCount = currentDbOrders.filter(o =>
        normalizeLine(o.feedmill_line) === line &&
        (o.status === 'In Production' || o.status === 'On-going')
      ).length;
      let prioCounter = inProdCount + 1;

      for (const order of lineOrders) {
        if (order.status === 'In Production' || order.status === 'On-going' || order.status === 'completed' || order.status === 'cancel_po') continue;
        const orderIdStr = String(order.id);

        if (order._isCombined && order._combinedFrom && order._combinedFrom.length > 1) {
          // Track old lead IDs declared by the preview model
          if (order._oldLeadIdsToDelete) {
            order._oldLeadIdsToDelete.forEach(id => oldLeadsToDelete.add(String(id)));
          }
          combinedGroups.push({ order, orderIdStr, line, prio: prioCounter });
          prioCounter++;
        } else {
          if (oldLeadsToDelete.has(orderIdStr)) { continue; }
          if (orderIdStr.startsWith('__combined_')) { continue; }

          if (order._isPending === true) {
            pendingCreates.push({ order, line, prio: prioCounter });
          } else if (dbOrderIds.has(orderIdStr)) {
            const resolvedAvail = _resolveAvail(order);
            const inf = itm?.[order.material_code] || itm?.[order.material_code_fg];
            const n10dDateSource = order._isHardDeadline ? 'hard_date' : inf ? 'n10d' : (order.date_source || 'none');
            const n10dInferredDate = inf?.targetDate || null;
            const n10dInferredLabel = inf?.status || order._n10dStatus || null;

            // Compute effective (batch-ceiling) volume — mirrors the orange preview display.
            // volume_override is being cleared, so the ceiling is applied to total_volume_mt.
            const _rawVol  = parseFloat(order.total_volume_mt ?? 0) || 0;
            const _batchSz = parseFloat(order.batch_size ?? 0) || 0;
            const _effVol  = _batchSz > 0 ? Math.ceil(_rawVol / _batchSz) * _batchSz : _rawVol;
            const _volChanged = Math.abs(_effVol - _rawVol) > 0.001;

            // Recalculate production_hours from effective volume (unless manually pinned).
            const _ph = (!order.production_hours_manual && order.form !== 'M')
              ? calcProductionHours({ ...order, volume_override: null, total_volume_mt: _effVol })
              : null;

            console.debug('[Apply To Schedule Volume Check]', {
              orderId: order.id,
              item: order.item_description,
              originalVolume: _rawVol,
              previewDisplayedVolume: _effVol,
              batchSize: _batchSz,
              batches: _batchSz > 0 ? Math.ceil(_effVol / _batchSz) : null,
              productionHours: _ph,
            });

            // Build history entry for Auto-sequence / Optimize order
            // Use ONLY the persisted DB snapshot for old-state — never preview metadata —
            // so the history line reflects the real committed transition.
            const _dbOrder = currentDbOrders.find(o => String(o.id) === orderIdStr);
            const _oldLine = _dbOrder?.feedmill_line || null;
            const _oldPrio = _dbOrder?.priority_seq ?? null;
            const _newLine = line;
            const _newPrio = prioCounter;
            const _lineChanged = !!_oldLine && _oldLine !== _newLine;
            const _prioChanged = _oldPrio != null && _oldPrio !== _newPrio;
            let _histAction = null;
            let _histDetails = null;
            if (_dbOrder && _lineChanged) {
              // Cross-line: action = "Event: Line X → Line Y", details carry prio + strategy name
              _histAction = `${_historyEventLabel}: ${_oldLine} → ${_newLine}`;
              if (_isOptimizeFlow) {
                _histDetails = `Moved from Prio ${_oldPrio ?? '?'} → ${_newPrio}`;
              } else {
                const _stratName = strategyNameByLine[_newLine] || strategyNameByLine[_oldLine] || null;
                _histDetails = _stratName
                  ? `${_stratName}. Moved from Prio ${_oldPrio ?? '?'} → ${_newPrio}`
                  : `Moved from Prio ${_oldPrio ?? '?'} → ${_newPrio}`;
              }
            } else if (_dbOrder && !_isOptimizeFlow && _prioChanged) {
              // Same-line prio change: only for Auto-sequence (Optimize is cross-line only per spec)
              _histAction = `${_historyEventLabel}: Prio ${_oldPrio} → ${_newPrio}`;
              const _stratName = strategyNameByLine[_newLine] || null;
              if (_stratName) _histDetails = _stratName;
            }
            let _historyPatch = {};
            if (_histAction) {
              const _existingHist = _dbOrder?.history || [];
              const _entry = { timestamp: _historyTs, action: _histAction };
              if (_histDetails) _entry.details = _histDetails;
              const _newHist = [..._existingHist, _entry];
              _historyPatch = { history: _newHist };
              console.debug('[Order History Write]', {
                orderId: order.id,
                timestamp: _historyTs,
                action: _histAction,
                details: _histDetails,
                eventType: _historyEventLabel,
              });
            }

            console.debug('[Apply AI Suggested Dates]', {
              orderId: order.id,
              item: order.item_description,
              originalFutureDispatchDate: order.target_avail_date || null,
              previewSuggestedDate: order._aiSuggestedDate || null,
              appliedScheduleDate: resolvedAvail || order.target_avail_date || null,
            });

            regularUpdates.push({
              id: order.id,
              data: {
                feedmill_line: line,
                priority_seq: prioCounter,
                parent_id: null,
                volume_override: null,
                original_order_ids: null,
                status: 'planned',
                ...(_ph != null ? { production_hours: _ph } : {}),
                ...(resolvedAvail ? { target_avail_date: resolvedAvail, avail_date_source: 'auto_sequence' } : {}),
                date_source: n10dDateSource,
                inferred_target_date: n10dInferredDate,
                inferred_target_label: n10dInferredLabel,
                last_n10d_update: inf ? new Date().toISOString() : (order.last_n10d_update || null),
                has_manual_override: false,
                manual_edit_date: null,
                ..._historyPatch,
              },
            });
          } else {
            console.warn(`    [Skip] ${orderIdStr} not in DB`);
          }
          prioCounter++;
        }
      }
    }

    console.log(`  Regular updates: ${regularUpdates.length}, Pending creates: ${pendingCreates.length}, Combined groups: ${combinedGroups.length}`);

    // ── Pass 2: Batch-update all regular orders in parallel (chunks of 15) ──
    const BATCH = 15;
    for (let i = 0; i < regularUpdates.length; i += BATCH) {
      const chunk = regularUpdates.slice(i, i + BATCH);
      await Promise.all(chunk.map(u =>
        updateOrderMutation.mutateAsync(u).catch(err =>
          console.error(`    [Error] Update ${u.id}:`, err?.message || err)
        )
      ));
    }

    // ── Pass 3: Create pending orders ───────────────────────────────────────
    for (const { order, line, prio } of pendingCreates) {
      const orderIdStr = String(order.id);
      const cleanOrder = _cleanPendingForDB({
        ...order,
        feedmill_line: line,
        priority_seq: prio,
        parent_id: null,
        volume_override: null,
        original_order_ids: null,
        status: 'planned',
      });
      try {
        const created = await createOrderMutation.mutateAsync(cleanOrder);
        pendingIdMap[orderIdStr] = created.id;
        console.log(`    [Create pending] ${orderIdStr} → ${created.id}`);
      } catch (err) {
        console.error(`    [Error] Create pending ${orderIdStr}:`, err?.message || err);
      }
    }

    // ── Pass 4: Process combined groups sequentially ─────────────────────────
    for (const { order, orderIdStr, line, prio } of combinedGroups) {
      // Validate + resolve every child entry against the DB
      const validChildren = [];

      for (const sub of order._combinedFrom) {
        const subIdStr = String(sub.id);

        // Pending sub — use already-created real ID if available
        if (sub._isPending === true) {
          const realId = pendingIdMap[subIdStr];
          if (realId) {
            validChildren.push({ ...sub, id: realId });
          } else {
            const cleanSub = _cleanPendingForDB({ ...sub, feedmill_line: line, priority_seq: null });
            try {
              const created = await createOrderMutation.mutateAsync(cleanSub);
              pendingIdMap[subIdStr] = created.id;
              validChildren.push({ ...sub, id: created.id });
              console.log(`    [Create pending sub] ${subIdStr} → ${created.id}`);
            } catch (err) {
              console.error(`    [Skip pending sub] ${subIdStr}:`, err?.message || err);
            }
          }
          continue;
        }

        // Not in DB — skip
        if (!dbOrderIds.has(subIdStr)) {
          console.warn(`    [Invalid child] ${subIdStr} NOT in DB — skipping`);
          continue;
        }

        const dbOrder = currentDbOrders.find(o => String(o.id) === subIdStr);

        // Child is itself a generated lead → resolve to its real children
        if (dbOrder && Array.isArray(dbOrder.original_order_ids) && dbOrder.original_order_ids.length > 0 && !dbOrder.parent_id) {
          console.warn(`    [Lead detected] ${subIdStr} is a lead — resolving to its children`);
          const leadChildren = currentDbOrders.filter(o => String(o.parent_id) === subIdStr);
          if (leadChildren.length > 0) {
            leadChildren.forEach(child => validChildren.push({
              id: child.id,
              fpr: child.fpr,
              volume: parseFloat(child.volume) || parseFloat(child.total_volume_mt) || 0,
              total_volume_mt: child.total_volume_mt,
              item_description: child.item_description,
              form: child.form,
              material_code: child.material_code,
              material_code_fg: child.material_code_fg,
              material_code_sfg: child.material_code_sfg,
              batch_size: child.batch_size,
              target_avail_date: child.target_avail_date,
              category: child.category,
              status: child.status,
              feedmill_line: child.feedmill_line,
              priority_seq: child.priority_seq,
            }));
            oldLeadsToDelete.add(subIdStr);
          } else {
            console.warn(`    [Lead no children] ${subIdStr} — treating as regular`);
            validChildren.push(sub);
          }
          continue;
        }

        // Regular valid child
        validChildren.push(sub);
      }

      console.log(`    [Combined] Valid: ${validChildren.length} / ${order._combinedFrom.length}`);

      // Not enough valid children → place individually as Planned
      if (validChildren.length < 2) {
        console.warn(`    [Skip combine] Only ${validChildren.length} valid — placing individually`);
        for (const child of validChildren) {
          if (!dbOrderIds.has(String(child.id))) continue;
          try {
            await updateOrderMutation.mutateAsync({
              id: child.id,
              data: { feedmill_line: line, priority_seq: prio, parent_id: null, volume_override: null, original_order_ids: null, status: 'planned' },
            });
          } catch (err) {
            console.error(`    [Error] Standalone ${child.id}:`, err?.message || err);
          }
        }
        continue;
      }

      // Earliest avail date from valid children — AI-suggested dates take priority,
      // then fresh N10D dates, then stored dates.
      const _leadAiDate = _isRealISO(order._aiSuggestedDate) ? String(order._aiSuggestedDate).substring(0, 10) : null;
      const childDates = validChildren.map(s => {
        // AI suggested date wins over everything else
        if (_isRealISO(s._aiSuggestedDate)) return String(s._aiSuggestedDate).substring(0, 10);
        const _cIsN10D = s.avail_date_source === 'auto_sequence' || s.date_source === 'n10d';
        if (_isRealISO(s.target_avail_date) && !_cIsN10D) return s.target_avail_date;
        const inf = itm?.[s.material_code] || itm?.[s.material_code_fg];
        if (inf?.targetDate && _isRealISO(inf.targetDate)) return inf.targetDate;
        // Fallback: use stored date even if N10D-sourced (no fresh N10D data available)
        if (_isRealISO(s.target_avail_date)) return s.target_avail_date;
        return null;
      }).filter(Boolean).sort();
      const earliestDate = _leadAiDate || childDates[0] || (() => {
        const leadInf = itm?.[order.material_code] || itm?.[order.material_code_fg];
        return leadInf?.targetDate && _isRealISO(leadInf.targetDate) ? leadInf.targetDate : null;
      })() || null;

      // Combined volume from valid children
      const combinedVolume = validChildren.reduce(
        (sum, s) => sum + (parseFloat(s.volume) || parseFloat(s.total_volume_mt) || 0), 0
      );

      // Mark overlapping old leads for deletion
      const validChildIdSet = new Set(validChildren.map(s => String(s.id)));
      currentDbOrders
        .filter(o => !o.parent_id && Array.isArray(o.original_order_ids) && o.original_order_ids.length > 0 &&
          o.original_order_ids.some(id => validChildIdSet.has(String(id))))
        .forEach(o => oldLeadsToDelete.add(String(o.id)));

      // Create new lead
      const firstChildDb = currentDbOrders.find(o => String(o.id) === String(validChildren[0].id)) || validChildren[0];

      // Apply batch ceiling so the lead's volume_override matches what the preview showed (orange).
      // Without this the OrderTable reads volume_override directly (no ceiling) and shows the raw sum.
      const _combBatchSz = parseFloat(firstChildDb?.batch_size ?? 0) || 0;
      const adjustedCombinedVolume = (_combBatchSz > 0 && combinedVolume > 0)
        ? Math.ceil(combinedVolume / _combBatchSz) * _combBatchSz
        : combinedVolume;
      const volumeOverride = adjustedCombinedVolume > 0 ? adjustedCombinedVolume : null;

      // Pre-compute production_hours for the lead from the adjusted volume.
      const _combPh = (firstChildDb?.form !== 'M' && firstChildDb?.run_rate && adjustedCombinedVolume > 0)
        ? parseFloat((adjustedCombinedVolume / parseFloat(firstChildDb.run_rate)).toFixed(2))
        : null;

      console.debug('[Apply To Schedule Combined Volume Check]', {
        childCount: validChildren.length,
        rawCombinedVolume: combinedVolume,
        adjustedCombinedVolume,
        batchSize: _combBatchSz,
        batches: _combBatchSz > 0 ? Math.ceil(adjustedCombinedVolume / _combBatchSz) : null,
        productionHours: _combPh,
      });
      const validChildIds = validChildren.map(s => s.id);

      let newLeadId;
      try {
        const newLead = await createOrderMutation.mutateAsync({
          fpr: firstChildDb.fpr,
          feedmill_line: line,
          priority_seq: prio,
          material_code: firstChildDb.material_code || firstChildDb.material_code_fg,
          material_code_fg: firstChildDb.material_code_fg || firstChildDb.material_code,
          material_code_sfg: firstChildDb.material_code_sfg,
          fg: firstChildDb.fg,
          sfg: firstChildDb.sfg,
          item_description: firstChildDb.item_description,
          form: firstChildDb.form,
          batch_size: firstChildDb.batch_size,
          run_rate: firstChildDb.run_rate,
          category: firstChildDb.category,
          color: firstChildDb.color,
          diameter: firstChildDb.diameter,
          changeover_time: firstChildDb.changeover_time,
          target_avail_date: earliestDate,
          status: 'planned',
          volume_override: null,
          total_volume_mt: combinedVolume > 0 ? combinedVolume : null,
          original_order_ids: validChildIds,
          parent_id: null,
          ...(_combPh != null ? { production_hours: _combPh } : {}),
        });
        newLeadId = newLead.id;
        combinedLeadMap[orderIdStr] = newLeadId;
        console.log(`    [New lead] ${newLeadId} (${validChildIds.length} children, ${adjustedCombinedVolume} MT, raw ${combinedVolume} MT)`);
      } catch (err) {
        console.error(`    [Error] Create lead:`, err?.message || err);
        // Fallback: place children as individual Planned orders
        for (const child of validChildren) {
          try {
            await updateOrderMutation.mutateAsync({
              id: child.id,
              data: { feedmill_line: line, priority_seq: prio, parent_id: null, status: 'planned' },
            });
          } catch (innerErr) {
            console.error(`      [Fallback] ${child.id}:`, innerErr?.message || innerErr);
          }
        }
        continue;
      }

      // Update all valid children in parallel
      const freshDb = queryClient.getQueryData(['orders']) || currentDbOrders;
      await Promise.all(validChildren.map(child => {
        const childDb = freshDb.find(o => String(o.id) === String(child.id));
        const preCombineStatus = childDb?.status || child.status || 'Plotted';
        const preCombineLine = childDb?.feedmill_line || child.feedmill_line || line;
        const preCombinePrio = childDb?.priority_seq ?? null;
        const preCombineOrigVol = parseFloat(childDb?.total_volume_mt || child.volume || 0) || null;
        const subResolvedAvail = _resolveAvail(child);
        return updateOrderMutation.mutateAsync({
          id: child.id,
          data: {
            parent_id: newLeadId,
            feedmill_line: line,
            priority_seq: null,
            volume_override: null,
            original_order_ids: null,
            status: 'Combined with other PO',
            pre_combine_status: preCombineStatus,
            pre_combine_line: preCombineLine,
            pre_combine_prio: preCombinePrio,
            pre_combine_partner_id: null,
            pre_combine_original_volume: preCombineOrigVol,
            ...(subResolvedAvail ? { target_avail_date: subResolvedAvail, avail_date_source: 'auto_sequence' } : {}),
          },
        }).then(() => console.log(`      [Child] ${child.id} → parent ${newLeadId}`))
          .catch(err => console.error(`      [Error] Child ${child.id}:`, err?.message || err));
      }));
    }

    // ── Delete old leads (after all creates/updates) ────────────────────────
    console.log(`  [Deleting] ${oldLeadsToDelete.size} old leads`);
    for (const oldLeadId of oldLeadsToDelete) {
      try {
        await Order.delete(oldLeadId);
        console.log(`    [Deleted] ${oldLeadId}`);
      } catch (err) {
        console.warn(`    [Warn] Delete ${oldLeadId}:`, err?.message || err);
      }
    }

    // ── Refetch before cascade ──────────────────────────────────────────────
    await queryClient.invalidateQueries({ queryKey: ['orders'] });
    await new Promise((resolve) => setTimeout(resolve, 500));

    // ── Cascade schedule ────────────────────────────────────────────────────
    for (const [line, lineOrders] of Object.entries(sequencedResults)) {
      if (!lineOrders || lineOrders.length === 0) continue;
      const topLevel = lineOrders
        .filter(o => {
          if (o.status === 'In Production' || o.status === 'On-going') return false;
          if (oldLeadsToDelete.has(String(o.id))) return false;
          if (String(o.id).startsWith('__combined_')) return !!combinedLeadMap[String(o.id)];
          return true;
        })
        .map((o, i) => {
          const realId = combinedLeadMap[String(o.id)] ||
            (o._isPending === true ? (pendingIdMap[String(o.id)] || o.id) : o.id);
          return { ...o, id: realId, priority_seq: i + 1, feedmill_line: line };
        });
      console.log(`  [Cascade] ${line}: ${topLevel.length} orders`);
      try {
        await cascadeSchedule(topLevel, 0);
      } catch (stepErr) {
        console.error(`  [Cascade ERROR] ${line}:`, stepErr);
      }
    }

    // ── Final refetch ───────────────────────────────────────────────────────
    await queryClient.invalidateQueries({ queryKey: ['orders'] });

    const totalOrders = Object.values(sequencedResults).reduce((s, lo) => s + lo.length, 0);
    const combinedCount = Object.keys(combinedLeadMap).length;
    const linesUsed = Object.keys(sequencedResults).filter(
      (l) => (sequencedResults[l] || []).length > 0
    ).length;
    return { totalOrders, combinedCount, linesUsed };
  };

  const handlePlantApply = async (sequencedResults, _originalSnapshot, { strategyNameByLine = {} } = {}) => {
    // Collect lines that lose orders due to cross-line moves
    const movedAwayFromLines = new Set();
    for (const [line, lineOrders] of Object.entries(sequencedResults)) {
      for (const order of lineOrders || []) {
        if (order._isCombined && order._combinedFrom) {
          order._combinedFrom
            .filter((s) => s.id !== order.id && s.line && normalizeLine(s.line) !== line)
            .forEach((s) => movedAwayFromLines.add(normalizeLine(s.line)));
        }
        if (order._movedFromLine && normalizeLine(order._movedFromLine) !== line) {
          movedAwayFromLines.add(normalizeLine(order._movedFromLine));
        }
      }
    }

    try {
      const stats = await applySequencedResultsToDB(sequencedResults, { label: 'Plant-Level Auto-Sequence', inferredTargetMap, strategyNameByLine });

      // Cascade source lines that lost orders — use fresh DB data post-apply
      const freshOrdersForCascade = queryClient.getQueryData(['orders']) || [];
      const freshOrderIds = new Set(freshOrdersForCascade.map(o => String(o.id)));
      for (const srcLine of movedAwayFromLines) {
        const srcOrders = freshOrdersForCascade
          .filter((o) => normalizeLine(o.feedmill_line) === srcLine &&
            freshOrderIds.has(String(o.id)) &&
            !['completed','cancel_po','in_production','ongoing_batching','ongoing_pelleting','ongoing_bagging'].includes(o.status))
          .sort((a, b) => (a.priority_seq || 0) - (b.priority_seq || 0));
        if (srcOrders.length > 0) {
          try { await cascadeSchedule(srcOrders, 0); }
          catch (cascErr) { console.warn(`  [Cascade warn] ${srcLine}:`, cascErr?.message || cascErr); }
        }
      }

      setPlantSeqOpen(false);
      setPlantSeqResults({});
      setPlantSeqSummary(null);
      setPlantSeqLog([]);
      setPlantSeqSnapshot({});

      toast.success(
        `Plant-level sequence applied: ${stats.totalOrders} order groups across ${stats.linesUsed} line${stats.linesUsed !== 1 ? 's' : ''}.` +
        (stats.combinedCount > 0 ? ` ${stats.combinedCount} combined group${stats.combinedCount !== 1 ? 's' : ''} created.` : '')
      );
      playSuccessNotificationSound();
    } catch (err) {
      console.error('Plant apply error:', err);
      toast.error(`Apply failed: ${err.message || 'Unknown error'}`, { duration: 8000 });
    }
  };
  // ─── End Plant-Level Auto-Sequence ─────────────────────────────────────────

  // ─── Feedmill-Level Auto-Sequence ───────────────────────────────────────────
  const handleFeedmillAutoSequence = async (feedmillKey) => {
    const fmLines = FEEDMILL_SEQ_LINES[feedmillKey] || [];
    if (fmLines.length === 0) {
      toast.error(`No lines configured for ${feedmillKey}.`);
      return;
    }
    const shortName = FM_SHORT_NAMES[feedmillKey] || feedmillKey;

    const EXCLUDED = new Set(["completed", "cancel_po"]);
    const allActiveOrders = enrichedOrders.filter((o) => !EXCLUDED.has(o.status));

    // Snapshot ALL lines (same as per-line handler)
    const originalSnapshot = {};
    PLANT_ALL_LINES.forEach((line) => {
      originalSnapshot[line] = allActiveOrders
        .filter((o) => normalizeLine(o.feedmill_line) === line && !o.parent_id)
        .sort((a, b) => (a.priority_seq || 0) - (b.priority_seq || 0))
        .map((o) => ({ ...o }));
    });

    // Build MT totals per line
    const lineTotalMT = {};
    PLANT_ALL_LINES.forEach((line) => {
      lineTotalMT[line] = (originalSnapshot[line] || []).reduce(
        (s, o) => s + getEffectiveDisplayVolumeMT(o), 0
      );
    });

    const normalizedFMLines = fmLines.map((l) => normalizeLine(l));

    // For each feedmill line, find candidates from OTHER (non-feedmill) lines
    // Mirror of per-line logic but for each target line in the feedmill
    const allCandidates = [];
    const seenOrderIds = new Set(); // each order is a candidate for at most one feedmill line

    for (const fmLine of normalizedFMLines) {
      const fmRR = getLineRunRate(fmLine);
      const runningFMLineMT = { ...lineTotalMT }; // greedy running totals

      // Gather orders from non-feedmill lines that can produce on this feedmill line
      const potentials = [];
      PLANT_ALL_LINES.forEach((srcLine) => {
        if (normalizedFMLines.includes(srcLine)) return; // skip same feedmill
        (originalSnapshot[srcLine] || []).forEach((order) => {
          if (seenOrderIds.has(order.id)) return; // already assigned to another FM line
          if (!plantCanProduceOnLine(order, fmLine, kbRecords)) return;
          const orderVolume = getEffectiveDisplayVolumeMT(order);
          const srcRR = getLineRunRate(srcLine);
          const srcQueueBefore = srcRR > 0 ? (runningFMLineMT[srcLine] || 0) / srcRR : Infinity;
          const fmQueueAfter  = fmRR > 0 ? ((runningFMLineMT[fmLine] || 0) + orderVolume) / fmRR : Infinity;
          const isWorthMoving = fmQueueAfter < srcQueueBefore;
          potentials.push({
            ...order,
            _targetLine: fmLine,
            _sourceLineNormalized: srcLine,
            _sourceLine: srcLine,
            _sourceRunRate: srcRR,
            _targetRunRate: fmRR,
            _sourceMTBefore: runningFMLineMT[srcLine] || 0,
            _sourceMTAfter: Math.max(0, (runningFMLineMT[srcLine] || 0) - orderVolume),
            _sourceQueueBefore: srcQueueBefore,
            _sourceQueueAfter: srcRR > 0 ? Math.max(0, (runningFMLineMT[srcLine] || 0) - orderVolume) / srcRR : 0,
            _targetMTBefore: runningFMLineMT[fmLine] || 0,
            _targetMTAfter: (runningFMLineMT[fmLine] || 0) + orderVolume,
            _targetQueueBefore: fmRR > 0 ? (runningFMLineMT[fmLine] || 0) / fmRR : 0,
            _targetQueueAfter: fmQueueAfter,
            _queueImprovement: srcQueueBefore - fmQueueAfter,
            _isWorthMoving: isWorthMoving,
          });
        });
      });

      // Greedy: add worth-moving, best improvement first, updating running totals
      const worthMoving = potentials
        .filter((c) => c._isWorthMoving)
        .sort((a, b) => b._queueImprovement - a._queueImprovement);

      worthMoving.forEach((candidate) => {
        if (seenOrderIds.has(candidate.id)) return;
        const orderVolume = parseFloat(candidate.total_volume_mt) || 0;
        const srcLine = candidate._sourceLineNormalized;
        const srcQB = getLineRunRate(srcLine) > 0 ? (runningFMLineMT[srcLine] || 0) / getLineRunRate(srcLine) : Infinity;
        const fmQA = fmRR > 0 ? ((runningFMLineMT[fmLine] || 0) + orderVolume) / fmRR : Infinity;
        if (fmQA < srcQB) {
          seenOrderIds.add(candidate.id);
          allCandidates.push({
            ...candidate,
            _sourceMTBefore: runningFMLineMT[srcLine] || 0,
            _sourceMTAfter: Math.max(0, (runningFMLineMT[srcLine] || 0) - orderVolume),
            _sourceQueueBefore: srcQB,
            _sourceQueueAfter: getLineRunRate(srcLine) > 0 ? Math.max(0, (runningFMLineMT[srcLine] || 0) - orderVolume) / getLineRunRate(srcLine) : 0,
            _targetMTBefore: runningFMLineMT[fmLine] || 0,
            _targetMTAfter: (runningFMLineMT[fmLine] || 0) + orderVolume,
            _targetQueueBefore: fmRR > 0 ? (runningFMLineMT[fmLine] || 0) / fmRR : 0,
            _targetQueueAfter: fmQA,
            _queueImprovement: srcQB - fmQA,
          });
          runningFMLineMT[fmLine] = (runningFMLineMT[fmLine] || 0) + orderVolume;
          runningFMLineMT[srcLine] = Math.max(0, (runningFMLineMT[srcLine] || 0) - orderVolume);
        }
      });
    }

    // Sort all candidates by improvement
    allCandidates.sort((a, b) => b._queueImprovement - a._queueImprovement);

    // Open preview modal — no processing overlay needed (same as per-line)
    setFeedmillSeqData({
      feedmillKey,
      feedmillShortName: shortName,
      feedmillLines: normalizedFMLines,
      originalSnapshot,
      selectedToMove: allCandidates,
      lineTotalMT,
    });
    setShowFeedmillSeqPreview(true);
  };

  const handleFeedmillApply = async ({ feedmillLines, sequencedByLine, affectedSourceLines }) => {
    try {
      const label = `${FM_SHORT_NAMES[feedmillSeqData?.feedmillKey] || feedmillSeqData?.feedmillKey || 'Feedmill'} Optimization`;
      const stats = await applySequencedResultsToDB(sequencedByLine, { label, inferredTargetMap });

      // Cascade source lines that lost orders
      for (const srcLine of (affectedSourceLines || [])) {
        const srcOrders = enrichedOrders
          .filter((o) => normalizeLine(o.feedmill_line) === srcLine &&
            o.status !== 'completed' && o.status !== 'cancel_po')
          .sort((a, b) => (a.priority_seq || 0) - (b.priority_seq || 0));
        if (srcOrders.length > 0) await cascadeSchedule(srcOrders, 0);
      }

      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      setShowFeedmillSeqPreview(false);
      setFeedmillSeqData(null);

      const linesLabel = (feedmillLines || []).map(l => { const m = l.match(/\d+/); return m ? `L${m[0]}` : l; }).join(' & ');
      const srcCount = (affectedSourceLines || []).length;
      toast.success(
        `${getFMFullName(feedmillSeqData?.feedmillKey)} optimization applied: ${stats.totalOrders} order${stats.totalOrders !== 1 ? 's' : ''}.` +
        (stats.combinedCount > 0 ? ` ${stats.combinedCount} combined.` : '') +
        (srcCount > 0 ? ` ${srcCount} source line${srcCount !== 1 ? 's' : ''} updated.` : '')
      );
      playSuccessNotificationSound();
    } catch (err) {
      console.error('Feedmill apply error:', err);
      toast.error(`Failed to apply: ${err.message || 'Please try again.'}`);
    }
  };
  // ─── End Feedmill-Level Auto-Sequence ───────────────────────────────────────

  // ─── Per-Line Auto-Sequence (cross-line candidate scan) ─────────────────────
  const handleLineAutoSequence = async () => {
    const targetLine = normalizeLine(activeSubSection);
    if (!targetLine || targetLine === "all") {
      toast.error("Select a specific line tab first.");
      return;
    }

    const EXCLUDED = new Set(["completed", "cancel_po"]);
    const allActiveOrders = enrichedOrders.filter((o) => !EXCLUDED.has(o.status));

    // Open modal immediately in loading state
    setLineSeqLoading(true);
    setLineAutoSequenceData(null);
    setShowLineAutoSequencePreview(true);

    try {
      await new Promise((r) => setTimeout(r, 40));

      // Snapshot all lines
      const originalSnapshot = {};
      PLANT_ALL_LINES.forEach((line) => {
        originalSnapshot[line] = allActiveOrders
          .filter((o) => normalizeLine(o.feedmill_line) === line)
          .filter((o) => !o.parent_id) // top-level only: leads + standalones (same scope as After table)
          .sort((a, b) => (a.priority_seq || 0) - (b.priority_seq || 0))
          .map((o) => ({ ...o }));
      });

      const targetLineOrders = originalSnapshot[targetLine] || [];

      // Build running MT totals per line
      const lineTotalMT = {};
      PLANT_ALL_LINES.forEach((line) => {
        lineTotalMT[line] = (originalSnapshot[line] || []).reduce(
          (s, o) => s + getEffectiveDisplayVolumeMT(o), 0
        );
      });

      const targetRR = getLineRunRate(targetLine);

      // Find all orders from OTHER lines that CAN run on target line
      const candidates = [];
      PLANT_ALL_LINES.forEach((line) => {
        if (line === targetLine) return;
        const lineOrders = originalSnapshot[line] || [];
        lineOrders.forEach((order) => {
          if (!plantCanProduceOnLine(order, targetLine, kbRecords)) return;
          const orderVolume = getEffectiveDisplayVolumeMT(order);
          const sourceMTBefore = lineTotalMT[line] || 0;
          const sourceMTAfter = sourceMTBefore - orderVolume;
          const sourceRR = getLineRunRate(line);
          const sourceQueueBefore = sourceRR > 0 ? sourceMTBefore / sourceRR : Infinity;
          const sourceQueueAfter = sourceRR > 0 ? sourceMTAfter / sourceRR : Infinity;
          const targetMTBefore = lineTotalMT[targetLine] || 0;
          const targetMTAfter = targetMTBefore + orderVolume;
          const targetQueueBefore = targetRR > 0 ? targetMTBefore / targetRR : Infinity;
          const targetQueueAfter = targetRR > 0 ? targetMTAfter / targetRR : Infinity;

          const isWorthMoving = targetQueueAfter < sourceQueueBefore;
          candidates.push({
            ...order,
            _sourceLineNormalized: line,
            _sourceLine: line,
            _sourceRunRate: sourceRR,
            _targetRunRate: targetRR,
            _sourceMTBefore: sourceMTBefore,
            _sourceMTAfter: sourceMTAfter,
            _sourceQueueBefore: sourceQueueBefore,
            _sourceQueueAfter: sourceQueueAfter,
            _targetMTBefore: targetMTBefore,
            _targetMTAfter: targetMTAfter,
            _targetQueueBefore: targetQueueBefore,
            _targetQueueAfter: targetQueueAfter,
            _queueImprovement: sourceQueueBefore - targetQueueAfter,
            _isWorthMoving: isWorthMoving,
          });
        });
      });

      // Greedy: select worth-moving, best improvement first
      const worthMoving = candidates
        .filter((o) => o._isWorthMoving)
        .sort((a, b) => b._queueImprovement - a._queueImprovement);

      const selectedToMove = [];
      let runningTargetMT = lineTotalMT[targetLine] || 0;
      const runningSourceMT = { ...lineTotalMT };

      worthMoving.forEach((candidate) => {
        const orderVolume = parseFloat(candidate.total_volume_mt) || 0;
        const sourceLine = candidate._sourceLineNormalized;
        const sourceQueueBefore = (runningSourceMT[sourceLine] || 0) / getLineRunRate(sourceLine);
        const targetQueueAfter = (runningTargetMT + orderVolume) / targetRR;

        if (targetQueueAfter < sourceQueueBefore) {
          selectedToMove.push({
            ...candidate,
            _sourceMTBefore: runningSourceMT[sourceLine] || 0,
            _sourceMTAfter: (runningSourceMT[sourceLine] || 0) - orderVolume,
            _sourceQueueBefore: sourceQueueBefore,
            _sourceQueueAfter: ((runningSourceMT[sourceLine] || 0) - orderVolume) / getLineRunRate(sourceLine),
            _targetMTBefore: runningTargetMT,
            _targetMTAfter: runningTargetMT + orderVolume,
            _targetQueueBefore: runningTargetMT / targetRR,
            _targetQueueAfter: targetQueueAfter,
          });
          runningTargetMT += orderVolume;
          runningSourceMT[sourceLine] = (runningSourceMT[sourceLine] || 0) - orderVolume;
        }
      });

      // Build the placement log for AI
      const placementLog = selectedToMove.map((order) => ({
        type: "moved",
        product: order.item_description,
        materialCode: order.material_code_fg || order.material_code,
        fromLine: order._sourceLineNormalized,
        toLine: targetLine,
        volume: getEffectiveDisplayVolumeMT(order),
        fpr: order.fpr,
        lineScores: [
          { line: order._sourceLineNormalized, runRate: order._sourceRunRate || 10, totalMTBefore: order._sourceMTBefore || 0, queueTimeBefore: order._sourceQueueBefore || 0, totalMTAfter: order._sourceMTAfter || 0, queueTimeAfter: order._sourceQueueAfter || 0 },
          { line: targetLine, runRate: order._targetRunRate || 10, totalMTBefore: order._targetMTBefore || 0, queueTimeBefore: order._targetQueueBefore || 0, totalMTAfter: order._targetMTAfter || 0, queueTimeAfter: order._targetQueueAfter || 0 },
        ],
        bestLineReason: { line: targetLine, runRate: order._targetRunRate || 10, queueTime: order._targetQueueBefore || 0, totalMTBefore: order._targetMTBefore || 0, totalMTAfter: order._targetMTAfter || 0, queueTimeAfter: order._targetQueueAfter || 0 },
        fromLineReason: { line: order._sourceLineNormalized, queueTime: order._sourceQueueBefore || 0, runRate: order._sourceRunRate || 10 },
      }));

      // Pre-load AI
      let preloadedAI = null;
      if (placementLog.length > 0) {
        try {
          const { systemPrompt, userPrompt, precomputedInsights } = buildPlantActionsPrompt(placementLog);
          const response = await callPlantActionsAI(systemPrompt, userPrompt, 1400);
          const parsed = parsePlantActionsResponse(response, placementLog, precomputedInsights);
          if (Object.keys(parsed).length >= Math.max(1, placementLog.length * 0.5)) {
            preloadedAI = { explanations: parsed, useFallback: false };
          } else {
            preloadedAI = { explanations: null, useFallback: true };
          }
        } catch {
          preloadedAI = { explanations: null, useFallback: true };
        }
      }

      setLineAutoSequenceData({
        targetLine,
        targetLineLabel: targetLine,
        originalSnapshot,
        targetLineOrders,
        selectedToMove,
        lineTotalMT: { ...lineTotalMT },
        placementLog,
        preloadedAI,
      });
    } catch (err) {
      console.error("Line auto-sequence error:", err);
      toast.error("Failed to run optimization. Please try again.");
      setShowLineAutoSequencePreview(false);
    } finally {
      setLineSeqLoading(false);
    }
  };

  const handleLineApply = async ({ targetLine, sequencedOrders, affectedSourceLines }) => {
    try {
      const stats = await applySequencedResultsToDB(
        { [targetLine]: sequencedOrders },
        { label: `Line Optimization (${targetLine})`, inferredTargetMap }
      );

      // Cascade source lines that lost orders to this line
      for (const srcLine of (affectedSourceLines || [])) {
        const srcOrders = enrichedOrders
          .filter((o) => normalizeLine(o.feedmill_line) === srcLine &&
            o.status !== 'completed' && o.status !== 'cancel_po')
          .sort((a, b) => (a.priority_seq || 0) - (b.priority_seq || 0));
        if (srcOrders.length > 0) await cascadeSchedule(srcOrders, 0);
      }

      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      setShowLineAutoSequencePreview(false);
      setLineAutoSequenceData(null);

      const srcCount = (affectedSourceLines || []).length;
      toast.success(
        `${targetLine} optimization applied: ${stats.totalOrders} order${stats.totalOrders !== 1 ? 's' : ''}.` +
        (stats.combinedCount > 0 ? ` ${stats.combinedCount} combined.` : '') +
        (srcCount > 0 ? ` ${srcCount} source line${srcCount !== 1 ? 's' : ''} updated.` : '')
      );
      playSuccessNotificationSound();
    } catch (err) {
      console.error('Line auto-sequence apply error:', err);
      toast.error(`Failed to apply: ${err.message || 'Please try again.'}`);
    }
  };
  // ─── End Per-Line Auto-Sequence ──────────────────────────────────────────────

  // ─── Upload commit helpers ───────────────────────────────────────────────────
  // Strip preview-only fields from a pending order before saving to DB
  const _cleanPendingForDB = (order) => {
    const clean = { ...order };
    [
      "id", "_isPending", "_isNew", "_isNewUpload", "_isCombined", "_combinedFrom", "_combinedFromLines",
      "_plantMovement", "_movement", "_movementDelta", "_movedFromLine", "_originalLine",
      "_tmpKey", "_isNewNonDated", "prio",
    ].forEach((f) => delete clean[f]);
    return clean;
  };

  // ─── End Per-Line Auto-Sequence helpers ──────────────────────────────────────

  const handleSwitchLine = (targetLine, prefilledData) => {
    setAddOrderOpen(false);
    const targetFm = LINE_TO_FM_KEY[targetLine] || 'FM1';
    setActiveFeedmill(targetFm);
    setActiveSubSection(targetLine);
    setAddOrderLine(targetLine);
    setAddOrderPrefill(prefilledData || null);
    setTimeout(() => setAddOrderOpen(true), 80);
  };

  const handleAddOrder = async (orderData) => {
    const isDateOrder =
      orderData.target_avail_date &&
      !isNaN(Date.parse(orderData.target_avail_date)) &&
      /^\d{4}-\d{2}-\d{2}/.test(orderData.target_avail_date);

    // Get active orders for this line sorted by priority_seq
    const lineOrders = enrichedOrders
      .filter(
        (o) =>
          o.feedmill_line === orderData.feedmill_line &&
          o.status !== "completed" &&
          o.status !== "cancel_po",
      )
      .sort((a, b) => (a.priority_seq ?? 999) - (b.priority_seq ?? 999));

    // ── Calculate insertion priority (mirrors _calcInsertionPosition in azureAI.js) ──
    // Rules:
    //  - Dated new order: scan lineOrders; stop at the FIRST non-dated order OR the
    //    first dated order whose date is strictly later → insert before that order.
    //    Dated orders always come before non-dated ones.
    //  - Non-dated new order: append after all existing orders.
    function isValidDate(v) {
      return v && !isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}/.test(v);
    }

    let insertionPrio;
    if (isDateOrder) {
      const newDate = new Date(orderData.target_avail_date);
      let foundPrio = null;
      for (const o of lineOrders) {
        if (!isValidDate(o.target_avail_date)) {
          // First non-dated order → insert the new dated order before it
          foundPrio = o.priority_seq;
          break;
        }
        if (new Date(o.target_avail_date) > newDate) {
          // First dated order strictly later → insert before it
          foundPrio = o.priority_seq;
          break;
        }
      }
      insertionPrio = foundPrio ?? lineOrders.length + 1;
    } else {
      insertionPrio = lineOrders.length + 1;
    }

    // Shift orders at or below insertion point down by 1
    const ordersToShift = lineOrders.filter(
      (o) => (o.priority_seq ?? 999) >= insertionPrio,
    );

    try {
      const createdOrder = await createOrderMutation.mutateAsync({
        ...orderData,
        priority_seq: insertionPrio,
        status: "plotted",
      });

      // Renumber downstream orders
      if (ordersToShift.length > 0) {
        await Promise.all(
          ordersToShift.map((o) =>
            updateOrderMutation.mutateAsync({
              id: o.id,
              data: { priority_seq: (o.priority_seq ?? insertionPrio) + 1 },
            }),
          ),
        );
      }

      // Cascade completion dates for the entire line so the new order (and all
      // orders downstream of it) get correct cascaded completion dates immediately.
      try {
        const newOrderForCascade = {
          ...orderData,
          ...(createdOrder || {}),
          priority_seq: insertionPrio,
          status: "plotted",
          production_hours: null,
          production_hours_manual: false,
          target_completion_date: null,
          target_completion_manual: false,
        };
        // Take existing line orders from the current state, adjusting priority_seqs
        // for the ones that were shifted, then add the newly created order.
        const existingLineOrders = orders
          .filter((o) => o.feedmill_line === orderData.feedmill_line)
          .map((o) => {
            const wasShifted = ordersToShift.some((s) => s.id === o.id);
            return wasShifted
              ? { ...o, priority_seq: (o.priority_seq ?? insertionPrio) + 1 }
              : o;
          });
        const allLineOrders = [...existingLineOrders, newOrderForCascade].sort(
          (a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity),
        );
        await cascadeSchedule(allLineOrders, 0);
      } catch (cascadeErr) {
        console.warn("Cascade after add order failed:", cascadeErr);
      }

      setAddOrderOpen(false);
      toast.success("Order Added", {
        description: `${orderData.item_description} (${orderData.total_volume_mt} MT) has been added to ${orderData.feedmill_line} at Prio ${insertionPrio}.`,
      });
    } catch (err) {
      toast.error("Failed to add order", {
        description: err.message || "Please try again.",
      });
    }
  };

  const handleN10DApplied = async (records) => {
    // Build a fresh inferredTargetMap from the just-uploaded records
    const freshMap = {};
    for (const rec of records) {
      if (rec.material_code) {
        const _dfl = parseFloat(rec.due_for_loading ?? 0);
        const _inv = parseFloat(rec.inventory ?? 0);
        const _status = getProductStatus(_dfl, _inv, rec.daily_values);
        freshMap[rec.material_code] = {
          targetDate: rec.target_date || null,
          needsProduction: _dfl >= _inv,
          dueForLoading: rec.due_for_loading ?? null,
          inventory: rec.inventory ?? null,
          note: rec.note || null,
          status: _status,
        };
      }
    }
    if (Object.keys(freshMap).length === 0) return;

    // Get all active orders with auto-sequence source — check for changed target dates
    const activeOrders = orders.filter(
      (o) => o.status !== "completed" && o.status !== "cancel_po",
    );
    if (activeOrders.length === 0) return;

    const changedOrders = [];
    for (const o of activeOrders) {
      if (!o.material_code) continue;
      const inf = freshMap[o.material_code];
      if (!inf) continue;
      const _todayN = new Date();
      const _todayNStr = `${_todayN.getFullYear()}-${String(_todayN.getMonth()+1).padStart(2,'0')}-${String(_todayN.getDate()).padStart(2,'0')}`;
      // For Sufficient orders: compare against actual N10D window-end date.
      // Fall back to 'stock_sufficient' sentinel if no N10D date available.
      const newTarget = inf.status === 'Sufficient'
        ? (inf.targetDate || 'stock_sufficient')
        : (inf.status === 'Critical' ? _todayNStr : inf.targetDate || null);
      const lastTarget = o.last_target_date || null;
      // Backward compat: old last_target_date='stock_sufficient' → unchanged for Sufficient orders
      const targetUnchangedN10D = newTarget === lastTarget
        || (!newTarget && !lastTarget)
        || (inf.status === 'Sufficient' && lastTarget === 'stock_sufficient');
      if (o.avail_date_source === 'auto_sequence' && !targetUnchangedN10D) {
        const fmtDate = (d) => {
          if (!d || d === 'stock_sufficient') return d === 'stock_sufficient' ? 'Stock sufficient' : 'None';
          try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch { return d; }
        };
        changedOrders.push({
          fpr: o.fpr,
          desc: o.item_description,
          from: fmtDate(lastTarget),
          to: fmtDate(newTarget),
        });
      }
    }

    if (changedOrders.length > 0) {
      const bulletLines = changedOrders.slice(0, 5).map(c =>
        `• ${c.fpr ? c.fpr + ' — ' : ''}${c.desc || 'Order'}: ${c.from} → ${c.to}`
      ).join('\n');
      const moreText = changedOrders.length > 5 ? `\n• …and ${changedOrders.length - 5} more` : '';
      toast.warning(
        `${changedOrders.length} order${changedOrders.length !== 1 ? 's' : ''} have updated target dates`,
        {
          description: bulletLines + moreText + '\n\nRun Optimize to apply updated positions.',
          duration: 60000,
        }
      );
    }

    // N10D data saved — inferredTargetMap will update reactively.
    // Avail dates are intentionally NOT updated here; they only change when the
    // user runs Auto-Sequence and approves the result.
  };

  const handleApplySequence = async (proposedSequence) => {
    // Sort by proposed priority first
    const sorted = [...proposedSequence].sort(
      (a, b) => a.proposedPrio - b.proposedPrio,
    );

    // Compact combined groups: ensure lead is followed immediately by all its children
    const leadToChildIds = {};
    const childLeadIdMap = {};
    orders.forEach((o) => {
      if (o.parent_id) {
        if (!leadToChildIds[o.parent_id]) leadToChildIds[o.parent_id] = [];
        leadToChildIds[o.parent_id].push(o.id);
        childLeadIdMap[o.id] = o.parent_id;
      }
    });

    const rowById = {};
    sorted.forEach((row) => {
      rowById[row.id] = row;
    });

    const compacted = [];
    const addedIds = new Set();
    sorted.forEach((row) => {
      if (addedIds.has(row.id)) return;
      if (childLeadIdMap[row.id]) {
        // This child appears before its lead — skip, it will be added with the lead
        return;
      }
      compacted.push(row);
      addedIds.add(row.id);
      // If this is a lead, add all its children immediately after
      if (leadToChildIds[row.id]) {
        const children = leadToChildIds[row.id]
          .map((cId) => rowById[cId])
          .filter(Boolean)
          .sort((a, b) => a.proposedPrio - b.proposedPrio);
        children.forEach((child) => {
          if (!addedIds.has(child.id)) {
            compacted.push(child);
            addedIds.add(child.id);
          }
        });
      }
    });
    // Any orphan children not yet added (their lead wasn't in the sequence)
    sorted.forEach((row) => {
      if (!addedIds.has(row.id)) {
        compacted.push(row);
        addedIds.add(row.id);
      }
    });

    // Re-assign proposedPrio based on compacted order
    compacted.forEach((row, i) => {
      row.proposedPrio = i + 1;
    });

    // Step 1: Apply new priority_seq + start dates + avail date updates for non-dated orders.
    // Category B = has N10D target date, Category D = stock sufficient
    await Promise.all(
      compacted.map((p) => {
        const updateData = { priority_seq: p.proposedPrio };
        if (p.startDate) updateData.start_date = p.startDate;
        if (p.startTime) updateData.start_time = p.startTime;

        // For non-dated orders (B = targeted, D = stock sufficient), update avail date
        if (p.category === 'B' || p.category === 'D') {
          const original = orders.find((o) => o.id === p.id);
          // Preserve the original avail date before overwriting (only on first auto-sequence)
          if (original && original.avail_date_source !== 'auto_sequence') {
            updateData.original_avail_date = original.target_avail_date || null;
          }
          updateData.avail_date_source = 'auto_sequence';
          if (p.category === 'D') {
            // Write actual N10D window-end date; fall back to sentinel only if no date
            updateData.target_avail_date = p.targetDate || 'stock_sufficient';
            updateData.last_target_date = p.targetDate || 'stock_sufficient';
          } else if (p.targetDate) {
            updateData.target_avail_date = p.targetDate;
            updateData.last_target_date = p.targetDate;
          }
        }

        return updateOrderMutation.mutateAsync({ id: p.id, data: updateData });
      }),
    );

    // Step 2: Build the reordered list with the freshest start-date values so
    // cascadeSchedule can compute correct completion dates for the NEW sequence.
    const orderedForCascade = compacted.map((p) => {
      const original = orders.find((o) => o.id === p.id) || {};
      return {
        ...original,
        priority_seq: p.proposedPrio,
        start_date: p.startDate || original.start_date || null,
        start_time: p.startTime || original.start_time || null,
      };
    });

    // Step 3: Recalculate ALL completion dates from the beginning of the new sequence.
    // This clears stale cascaded dates and replaces them with correct values.
    await cascadeSchedule(orderedForCascade, 0);

    toast.success("Auto-sequence applied successfully.");
    playSuccessNotificationSound();
  };

  // Handle navigation — now also accepts feedmill
  const handleNavigate = (section, subSection, feedmill) => {
    setActiveSection(section);
    setActiveSubSection(subSection || "all");
    if (feedmill) setActiveFeedmill(feedmill);
    setSelectedOrders([]);
    setBulkMode(false);
  };

  // Handle file upload
  const handleUpload = async (file) => {
    const _UPLOAD_EXCLUDED_STATUSES = new Set([
      "completed", "cancel_po",
      "in_production", "ongoing_batching", "ongoing_pelleting", "ongoing_bagging",
    ]);
    const _activeBeforeUpload = (enrichedOrders || []).filter(
      (o) => !_UPLOAD_EXCLUDED_STATUSES.has(o.status) && o.feedmill_line
    );
    const _allLinesWereBlank = _activeBeforeUpload.length === 0;
    const _hasN10D = (activeN10DRecords || []).length > 0;

    setIsUploading(true);
    try {
      console.log(
        "[Upload] Step 1: Reading file...",
        file.name,
        file.size,
        "bytes",
      );
      const data = await file.arrayBuffer();
      console.log("[Upload] Step 2: Parsing Excel...");
      const workbook = XLSX.read(data, { type: "array" });
      const sheetName = workbook.SheetNames[0];
      console.log("[Upload] Sheet:", sheetName);
      const worksheet = workbook.Sheets[sheetName];
      const rawRows = XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        defval: "",
      });
      console.log("[Upload] Raw rows:", rawRows.length);

      let headerRowIdx = rawRows.findIndex((row) =>
        row.some(
          (cell) => String(cell).trim().toLowerCase() === "material code",
        ),
      );
      if (headerRowIdx < 0) headerRowIdx = 0;
      console.log("[Upload] Header row index:", headerRowIdx);

      const headers = rawRows[headerRowIdx].map((h) => String(h).trim());
      console.log(
        "[Upload] Headers found:",
        headers.filter((h) => h),
      );

      const COLUMN_MAP = {
        fpr: "FPR",
        "material code": "Material Code",
        "item description": "Item Description",
        category: "Category",
        "feedmill line": "Feedmill Line",
        "metric ton": "Metric Ton",
        "seq.": "Seq.",
        "prio. seq.": "Seq.",
        remarks: "Remarks",
        remark: "Remarks",
        "remarks ": "Remarks",
        // common typos / corruption patterns (e.g. "ReAprks" when "Apr" gets embedded)
        reaprks: "Remarks",
        remaprks: "Remarks",
        remapks: "Remarks",
        fg: "FG",
        sfg: "SFG",
        sfg1: "SFG1",
        "po status": "PO STATUS",
        "prod remarks": "Prod Remarks",
      };

      const colIndex = {};
      headers.forEach((h, i) => {
        const key = h.toLowerCase().trim();
        if (COLUMN_MAP[key]) {
          colIndex[COLUMN_MAP[key]] = i;
        }
      });

      // Fuzzy fallback: if Remarks column not found, check for headers that:
      // 1. contain "remark" anywhere, OR
      // 2. look phonetically similar (starts with 're' and ends with 'rk' or 'rks')
      if (!colIndex['Remarks']) {
        headers.forEach((h, i) => {
          if (colIndex['Remarks']) return;
          const k = h.toLowerCase().trim();
          if (k.includes('remark') || (k.startsWith('re') && k.endsWith('rks'))) {
            console.log(`[Upload] Fuzzy-matched Remarks column: "${h}" at index ${i}`);
            colIndex['Remarks'] = i;
          }
        });
      }

      // Content-based fallback: scan first data rows for a column containing "TLD |"
      if (!colIndex['Remarks']) {
        const sampleRows = rawRows.slice(headerRowIdx + 1, headerRowIdx + 6);
        for (let i = 0; i < headers.length; i++) {
          if (sampleRows.some(r => String(r[i] || '').includes('TLD'))) {
            console.log(`[Upload] Content-matched Remarks column: "${headers[i]}" at index ${i}`);
            colIndex['Remarks'] = i;
            break;
          }
        }
      }

      console.log("[Upload] Mapped columns:", Object.keys(colIndex));

      const dataRows = rawRows
        .slice(headerRowIdx + 1)
        .filter((row) =>
          row.some(
            (cell) => cell !== "" && cell !== null && cell !== undefined,
          ),
        );
      console.log("[Upload] Data rows (non-empty):", dataRows.length);

      const excelRows = dataRows
        .map((row) => {
          const obj = {};
          for (const [field, idx] of Object.entries(colIndex)) {
            let val = row[idx];
            if (val !== null && val !== undefined) val = String(val).trim();
            obj[field] = val || "";
          }
          return obj;
        })
        .filter((row) => row["Material Code"]);
      console.log("[Upload] Step 3: Parsed", excelRows.length, "valid rows");
      if (excelRows.length > 0)
        console.log("[Upload] Sample row:", JSON.stringify(excelRows[0]));

      {
        const parsedOrders = excelRows.map((row, index) =>
          parseSAPOrder(row, index),
        );
        console.log("[Upload] Step 4: Mapped", parsedOrders.length, "orders");
        const existingFprs = new Set(orders.map((o) => o.fpr).filter(Boolean));
        const uploadedFprs = new Set(
          parsedOrders.map((o) => o.fpr).filter(Boolean),
        );
        const newFprs = new Set(
          [...uploadedFprs].filter((f) => !existingFprs.has(f)),
        );
        setNewFprValues(newFprs);

        const isValidDate = (d) =>
          d && !isNaN(Date.parse(d)) && /^\d{4}-\d{2}-\d{2}/.test(d);

        // For subsequent uploads: append below existing — offset priority_seq
        const existingOrders = orders; // snapshot from closure
        const maxSeq =
          existingOrders.length > 0
            ? Math.max(...existingOrders.map((o) => o.priority_seq ?? 0))
            : -1;
        parsedOrders.forEach((o, i) => {
          o.priority_seq = maxSeq + 1 + i;
        });

        // Apply Knowledge Base auto-population for ALL feedmill tabs
        let uploadKBRecords = [];
        try {
          uploadKBRecords = await KBEntity.list("-created_date", 2000);
          const { KnowledgeBaseUpload: KBUpload } = base44.entities;
          const uploads = await KBUpload.list("-created_date", 1);
          if (uploads[0]) {
            uploadKBRecords = uploadKBRecords.filter(
              (r) => r.upload_session_id === uploads[0].upload_session_id,
            );
          }
        } catch {
          uploadKBRecords = [];
        }
        const uploadKBMap = buildLocalKBMap(uploadKBRecords);

        const parsedWithKB = parsedOrders.map((order) => {
          const entry = uploadKBMap[String(order.material_code || "").trim()];
          const updates = applyKBFields(order, entry);
          const merged = { ...order, ...updates };
          // Auto-calc production hours using suggested volume
          const sugVol =
            merged.batch_size > 0
              ? Math.ceil((merged.total_volume_mt || 0) / merged.batch_size) *
                merged.batch_size
              : merged.total_volume_mt || 0;
          const rr = parseFloat(merged.run_rate);
          merged.production_hours =
            !rr || rr <= 0 || merged.form === "M"
              ? null
              : parseFloat((sugVol / rr).toFixed(2));
          merged.production_hours_manual = false;
          // Add initial history entry
          merged.history = [
            {
              timestamp: new Date().toLocaleString("en-US", {
                month: "2-digit",
                day: "2-digit",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                hour12: true,
              }),
              action: "Uploaded",
              details: `Imported from SAP file. Assigned to ${merged.feedmill_line || "unknown line"}.`,
            },
          ];
          const poStatus = (merged.po_status || "").trim().toLowerCase();
          if (poStatus === "cancelled") {
            merged.status = "cancel_po";
            const uploadDateStr = new Date().toLocaleString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              hour12: true,
            });
            merged.cancel_note = `Cancelled: Cancelled from SAP Planned Order — ${uploadDateStr}`;
            merged.cancelled_at = new Date().toISOString();
            merged.cancelled_date = new Date().toISOString().split("T")[0];
            merged.cancelled_time = `${String(new Date().getHours()).padStart(2, "0")}:${String(new Date().getMinutes()).padStart(2, "0")}`;
            merged.cancel_reason = "SAP Planned Order Cancelled";
            merged.cancelled_by = "SAP Import";
            merged.history.push({
              timestamp:
                merged.history[0]?.timestamp || new Date().toLocaleString(),
              action: "Cancel PO set from SAP upload",
              details: "PO Status column = Cancelled",
            });
          } else {
            merged.status = "plotted";
          }
          if (merged.feedmill_line === "Line 5") {
            merged.pmx = merged.sap_sfg1 || "";
            merged.sap_sfg1 = "";
          }
          return merged;
        });

        const byLine = {};
        parsedWithKB.forEach((o) => {
          const line = o.feedmill_line || "__none__";
          if (!byLine[line]) byLine[line] = [];
          byLine[line].push(o);
        });

        const _isUploadDate = (d) =>
          !!(d && !isNaN(Date.parse(d)) && /^\d{4}-\d{2}-\d{2}/.test(d));

        // Collects existing orders whose priority_seq must change after interleaving
        const existingReseqUpdates = [];
        // Per-line upload stats for the summary notification
        const lineUploadStats = {};
        // FPRs of newly appended non-dated orders, used for the "NEW" badge
        const newNonDatedBadgeFprs = [];

        Object.entries(byLine).forEach(([lineName, lineOrders]) => {
          const existingLineOrders = existingOrders.filter(
            (o) => o.feedmill_line === lineName,
          );
          const activeExisting = existingLineOrders.filter(
            (o) => o.status !== "completed" && o.status !== "cancel_po",
          );
          const isFirstUploadForLine = activeExisting.length === 0;

          lineOrders.forEach((o) => {
            o.start_date = null;
            o.start_time = null;
            o.target_completion_date = null;
            o.user_set_start = false;
          });

          if (isFirstUploadForLine) {
            // First upload for this line — date-aware sort among new orders only
            const _datedNew = lineOrders
              .filter((o) => _isUploadDate(o.target_avail_date))
              .sort((a, b) => {
                const diff =
                  new Date(a.target_avail_date) - new Date(b.target_avail_date);
                return diff !== 0
                  ? diff
                  : (a.priority_seq ?? 0) - (b.priority_seq ?? 0);
              });
            const _nonDatedNew = lineOrders
              .filter((o) => !_isUploadDate(o.target_avail_date))
              .sort((a, b) => (a.priority_seq ?? 0) - (b.priority_seq ?? 0));
            lineOrders.splice(
              0,
              lineOrders.length,
              ..._datedNew,
              ..._nonDatedNew,
            );
            lineOrders.forEach((o, i) => {
              o.priority_seq = i + 1;
            });
            lineUploadStats[lineName] = {
              newDated: _datedNew.length,
              newNonDated: _nonDatedNew.length,
            };
          } else {
            // ── SMART MERGE ────────────────────────────────────────────────────
            // New DATED orders  → insert at correct chronological position.
            // New NON-DATED orders → append to bottom.
            // EXISTING orders   → NEVER repositioned.
            // ───────────────────────────────────────────────────────────────────

            // Identify new orders: FPR not present anywhere in the DB (including cancelled)
            const allExistingFprs = new Set(
              existingOrders.map((o) => o.fpr).filter(Boolean),
            );
            const newOrders = lineOrders.filter(
              (o) => !allExistingFprs.has(o.fpr),
            );

            const newDated = newOrders
              .filter((o) => _isUploadDate(o.target_avail_date))
              .sort((a, b) => {
                const diff =
                  new Date(a.target_avail_date) - new Date(b.target_avail_date);
                return diff !== 0
                  ? diff
                  : (a.priority_seq ?? 0) - (b.priority_seq ?? 0);
              });
            const newNonDated = newOrders.filter(
              (o) => !_isUploadDate(o.target_avail_date),
            );

            // Working list: existing active orders in their current priority order
            const workingList = activeExisting
              .slice()
              .sort((a, b) => (a.priority_seq ?? 0) - (b.priority_seq ?? 0));

            // Insert each new dated order at the correct chronological position
            for (const ndOrder of newDated) {
              const ndDate = new Date(ndOrder.target_avail_date);

              // Snapshot indices from current working list
              const existingDatedWithIdx = workingList
                .map((o, idx) => ({ ...o, _wi: idx }))
                .filter((o) => _isUploadDate(o.target_avail_date));

              const lastEarlierOrEqual = [...existingDatedWithIdx]
                .filter((o) => new Date(o.target_avail_date) <= ndDate)
                .pop();
              const firstLater = existingDatedWithIdx.find(
                (o) => new Date(o.target_avail_date) > ndDate,
              );

              let insertAt;
              if (!lastEarlierOrEqual && !firstLater) {
                insertAt = workingList.length;
              } else if (!lastEarlierOrEqual) {
                insertAt = firstLater._wi;
              } else if (!firstLater) {
                insertAt = lastEarlierOrEqual._wi + 1;
              } else {
                // Walk forward past any non-dated orders that sit between the two dated orders,
                // so the new dated order lands just before the next dated order
                insertAt = lastEarlierOrEqual._wi + 1;
                while (
                  insertAt < firstLater._wi &&
                  !_isUploadDate(workingList[insertAt].target_avail_date)
                ) {
                  insertAt++;
                }
              }

              // Combined-group safety: never split a group — skip past its last child
              if (
                insertAt < workingList.length &&
                workingList[insertAt]?.parent_order_id
              ) {
                const parentId = workingList[insertAt].parent_order_id;
                let lastChildIdx = insertAt;
                for (let j = insertAt + 1; j < workingList.length; j++) {
                  if (workingList[j].parent_order_id === parentId)
                    lastChildIdx = j;
                  else break;
                }
                insertAt = lastChildIdx + 1;
              }

              workingList.splice(insertAt, 0, { ...ndOrder, _isNew: true });
            }

            // Append new non-dated orders to the bottom
            workingList.push(
              ...newNonDated.map((o) => ({
                ...o,
                _isNew: true,
                _isNewNonDated: true,
              })),
            );

            // Re-sequence all priority_seqs; queue updates for existing orders that changed
            workingList.forEach((o, i) => {
              const newSeq = i + 1;
              if (o._isNew) {
                o.priority_seq = newSeq;
              } else {
                if ((o.priority_seq ?? 0) !== newSeq) {
                  existingReseqUpdates.push({ id: o.id, priority_seq: newSeq });
                }
              }
            });

            // Only the new orders go to bulkCreate
            const newOrdersForDB = workingList.filter((o) => o._isNew);
            lineOrders.splice(0, lineOrders.length, ...newOrdersForDB);

            // Stats & badge tracking
            lineUploadStats[lineName] = {
              newDated: newDated.length,
              newNonDated: newNonDated.length,
            };
            if (newNonDated.length > 0) {
              newNonDatedBadgeFprs.push(
                ...newNonDated.map((o) => o.fpr).filter(Boolean),
              );
            }
          }
        });

        // Save all new orders in a single bulk request
        const ordersToCreate = Object.values(byLine).flat();
        console.log(`[Upload] Step 5: Bulk-saving ${ordersToCreate.length} new orders to DB...`);
        if (ordersToCreate.length > 0) {
          await bulkCreateMutation.mutateAsync(ordersToCreate);
        }
        await queryClient.invalidateQueries({ queryKey: ["orders"] });

        // Show success toast
        if (newNonDatedBadgeFprs.length > 0) {
          const existing = JSON.parse(localStorage.getItem("nexfeed_new_non_dated_fprs") || "[]");
          const updated = [
            ...existing.filter((b) => Date.now() - b.ts < 24 * 60 * 60 * 1000),
            ...newNonDatedBadgeFprs.map((fpr) => ({ fpr, ts: Date.now() })),
          ];
          localStorage.setItem("nexfeed_new_non_dated_fprs", JSON.stringify(updated));
        }
        const statsLines = Object.entries(lineUploadStats);
        if (statsLines.length > 0) {
          const bulletLines = statsLines.map(([line, s]) => {
            const parts = [];
            if (s.newDated > 0) parts.push(`${s.newDated} dated order${s.newDated !== 1 ? "s" : ""} merged`);
            if (s.newNonDated > 0) parts.push(`${s.newNonDated} non-dated order${s.newNonDated !== 1 ? "s" : ""} added to bottom`);
            if (parts.length === 0) parts.push("no new orders added");
            return { line, text: parts.join(", ") };
          });
          toast.success("✅ SAP Upload Complete", {
            description: (
              <div style={{ color: "#374151", fontSize: 13, lineHeight: 1.6 }}>
                {bulletLines.map(({ line, text }) => (
                  <div key={line}>• {line}: {text}</div>
                ))}
                {newNonDatedBadgeFprs.length > 0 && (
                  <div style={{ marginTop: 6, color: "#6b7280", fontStyle: "italic" }}>
                    Non-dated orders are at the bottom — review and position as needed.
                  </div>
                )}
              </div>
            ),
          });
        } else {
          toast.success(`Successfully imported ${ordersToCreate.length} order${ordersToCreate.length !== 1 ? "s" : ""}`);
        }
      }
    } catch (error) {
      console.error("Upload error:", error);
      console.error("Upload error message:", error?.message);
      console.error("Upload error stack:", error?.stack);
      const errMsg = error?.message || "Unknown error";
      toast.error(`Failed to import orders: ${errMsg}`);
    }
    setIsUploading(false);
    setIsUploadModalOpen(false);
  };

  // Format timestamp helper
  const formatTimestamp = () => {
    const now = new Date();
    const date = now.toLocaleDateString("en-US", {
      month: "2-digit",
      day: "2-digit",
      year: "numeric",
    });
    const time = now
      .toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })
      .replace("AM", "AM")
      .replace("PM", "PM");
    return `${date} ${time}`;
  };

  const appendRemark = (existing, newRemark) => {
    const bullet = `• ${newRemark}`;
    if (!existing) return bullet;
    return `${existing} ${bullet}`;
  };

  // Handle order actions with confirmation
  const handleAction = (action, order) => {
    if (action === "cut_combine") {
      setCutCombineOrder(order);
      return;
    }

    // Cancel — needs reason
    if (action === "cancel") {
      setReasonDialog({ action: "cancel", order });
      return;
    }

    // Revert cancelled — needs reason
    if (action === "revert" && order.status === "cancel_po") {
      setReasonDialog({ action: "revert_cancelled", order });
      return;
    }

    // Revert in_production back to planned — simple confirm
    if (action === "revert" && order.status === "in_production") {
      setConfirmAction({
        action: "revert",
        order,
        config: {
          title: "Revert to Planned",
          description: "Move this order back to Normal Orders?",
          confirmText: "Revert",
        },
      });
      return;
    }

    // Revert pending order (cut) — smart logic
    if (action === "revert" && order.status === "cut") {
      const parent = orders.find((o) => o.id === order.parent_order_id);
      setPendingRevertDialog({ order, parentOrder: parent || null });
      return;
    }

    // Produce as Independent (Pending only)
    if (action === "produce_as_independent") {
      setProduceIndependentOrder(order);
      return;
    }

    // Produce — minimum MT check per feedmill line
    if (action === "produce") {
      const mt = order.total_volume_mt || 0;
      const minMT = getMinMT(order.feedmill_line);
      if (minMT > 0 && mt < minMT) {
        const sources = orders.filter(
          (o) =>
            o.id !== order.id &&
            o.material_code === order.material_code &&
            (o.status === "normal" || o.status === "cut"),
        );
        setMinVolumeCheck({
          order,
          sources,
          onProceed: () => {
            setMinVolumeCheck(null);
            setConfirmAction({
              action: "produce",
              order,
              config: {
                title: "Move to Production",
                description: `Move "${order.item_description}" (${mt} MT) to production?`,
                confirmText: "Move to Production",
              },
            });
          },
        });
        return;
      }
    }

    // Mark as Done — validation flow
    if (action === "complete") {
      if (!order.end_date || !order.end_time) {
        setMarkDoneBlocking(order);
        return;
      }
      const softFields = ["threads", "sacks", "markings", "tags"];
      const missing = softFields.filter((f) => !order[f]);
      if (missing.length > 0) {
        setMarkDoneSoftConfirm({ order, missingFields: missing });
        return;
      }
      setConfirmAction({
        action: "complete",
        order,
        config: {
          title: "Mark as Done",
          description: "You are about to mark this order as done. Confirm?",
          confirmText: "Confirm",
        },
      });
      return;
    }

    const actionConfig = {
      produce: {
        title: "Move to Production",
        description: `Move this order to production?`,
        confirmText: "Move to Production",
      },
      revert: {
        title: "Revert Order",
        description: "Are you sure you want to revert this order?",
        confirmText: "Revert",
      },
      complete: {
        title: "Mark as Done",
        description: "You are about to mark this order as done. Confirm?",
        confirmText: "Confirm",
      },
      revert_to_production: {
        title: "Revert to Production",
        description:
          "Are you sure you want to move this order back to production?",
        confirmText: "Revert",
      },
    };

    setConfirmAction({ action, order, config: actionConfig[action] });
  };

  const executeAction = async () => {
    if (!confirmAction) return;
    const { action, order } = confirmAction;
    try {
      // Custom direct action (e.g. produce as independent after min MT check)
      if (confirmAction._doAction) {
        await confirmAction._doAction();
        setConfirmAction(null);
        return;
      }
      switch (action) {
        case "produce": {
          const prodUpdates = {
            status: "in_production",
            ...applyKBFields(
              order,
              kbRecords.find
                ? kbRecords.find(
                    (r) =>
                      String(r.fg_material_code).trim() ===
                      String(order.material_code || "").trim(),
                  )
                : null,
            ),
          };
          await updateOrderMutation.mutateAsync({
            id: order.id,
            data: prodUpdates,
          });
          toast.success("Order moved to production");
          break;
        }
        case "revert":
          if (order.original_orders_snapshot?.length > 0) {
            for (const snap of order.original_orders_snapshot) {
              const { id: _id, ...snapData } = snap;
              await createOrderMutation.mutateAsync({
                ...snapData,
                status: snap.status || "normal",
              });
            }
            await Order.delete(order.id);
            queryClient.invalidateQueries({ queryKey: ["orders"] });
            toast.success(
              `Combined order separated into ${order.original_orders_snapshot.length} original orders`,
            );
          } else {
            await updateOrderMutation.mutateAsync({
              id: order.id,
              data: { status: "normal" },
            });
            toast.success("Order reverted");
          }
          break;
        case "complete": {
          const now = new Date();
          const endDate = now.toISOString().split("T")[0];
          const endTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
          const ts2 = formatTimestamp();
          const completeHistory = [
            ...(order.history || []),
            {
              timestamp: ts2,
              action: `Status changed: ${order.status || "plotted"} → completed`,
              details: `End Date auto-set: ${ts2}`,
            },
          ];
          await updateOrderMutation.mutateAsync({
            id: order.id,
            data: {
              status: "completed",
              end_date: endDate,
              end_time: endTime,
              history: completeHistory,
            },
          });
          toast.success("Order marked as completed");
          break;
        }
        case "revert_to_production":
          await updateOrderMutation.mutateAsync({
            id: order.id,
            data: { status: "in_production" },
          });
          toast.success("Order moved back to production");
          break;
      }
    } catch (error) {
      toast.error("Failed to perform action");
    }
    setConfirmAction(null);
  };

  // Cancel with reason
  const handleCancelWithReason = async (reason) => {
    const { order } = reasonDialog;
    const ts = formatTimestamp();
    const dateStr = new Date().toLocaleString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    const cancelNoteText = `Cancelled: ${reason} — ${dateStr}`;
    await updateOrderMutation.mutateAsync({
      id: order.id,
      data: { status: "cancel_po", cancel_note: cancelNoteText },
    });
    toast.success("Order cancelled");
    setReasonDialog(null);
  };

  // Revert cancelled with reason
  const handleRevertCancelledWithReason = async (reason) => {
    const { order } = reasonDialog;
    await updateOrderMutation.mutateAsync({
      id: order.id,
      data: { status: "normal", cancel_note: null },
    });
    toast.success("Order reverted");
    setReasonDialog(null);
  };

  // Produce as Independent
  const handleProduceAsIndependent = async (order, newFPR) => {
    const now = new Date();
    const ts = now
      .toLocaleString("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })
      .replace(",", "");
    const newRemark = `Converted as independent order [${ts}] — Original FPR: ${order.fpr || "—"}`;
    const mt = order.total_volume_mt || 0;

    const doProduceIndependent = async () => {
      await updateOrderMutation.mutateAsync({
        id: order.id,
        data: {
          fpr: newFPR,
          parent_order_id: null,
          status: "in_production",
          prod_remarks: appendRemark(order.prod_remarks, newRemark),
        },
      });
      toast.success("Order converted to independent and moved to production");
    };

    const showConfirmThenProduce = () => {
      setConfirmAction({
        action: "_produce_independent_direct",
        order,
        _doAction: doProduceIndependent,
        config: {
          title: "Move to Production",
          description: `Move "${order.item_description}" (${mt} MT) to production as independent order?`,
          confirmText: "Move to Production",
        },
      });
    };

    const minMT = getMinMT(order.feedmill_line);
    if (minMT > 0 && mt < minMT) {
      const sources = orders.filter(
        (o) =>
          o.id !== order.id &&
          o.material_code === order.material_code &&
          (o.status === "normal" || o.status === "cut"),
      );
      setMinVolumeCheck({ order, sources, onProceed: showConfirmThenProduce });
    } else {
      showConfirmThenProduce();
    }
    setProduceIndependentOrder(null);
  };

  // Pending revert — merge back to parent
  const handlePendingRevertToParent = async () => {
    const { order, parentOrder } = pendingRevertDialog;
    const newVolume =
      (parentOrder.total_volume_mt || 0) + (order.total_volume_mt || 0);
    await updateOrderMutation.mutateAsync({
      id: parentOrder.id,
      data: { total_volume_mt: newVolume },
    });
    await Order.delete(order.id);
    queryClient.invalidateQueries({ queryKey: ["orders"] });
    toast.success("Pending order merged back into parent");
    setPendingRevertDialog(null);
  };

  // Pending revert — make standalone Normal
  const handlePendingRevertStandalone = async () => {
    const { order, parentOrder } = pendingRevertDialog;
    const ts = formatTimestamp();
    const parentStatus =
      parentOrder?.status === "in_production" ? "produced" : "cancelled";
    const newRemark = `Reverted as standalone — original order (FPR: ${parentOrder?.fpr || "—"}) was ${parentStatus} [${ts}]`;
    await updateOrderMutation.mutateAsync({
      id: order.id,
      data: {
        status: "normal",
        parent_order_id: null,
        prod_remarks: appendRemark(order.prod_remarks, newRemark),
      },
    });
    toast.success("Pending order moved to Normal Orders as standalone");
    setPendingRevertDialog(null);
  };

  // Split & Merge then Produce — after merge, show Step 4 confirmation
  const handleSplitAndMerge = async (order, sourceOrder, splitAmt) => {
    const newSourceVol = (sourceOrder.total_volume_mt || 0) - splitAmt;
    const newOrderVol = (order.total_volume_mt || 0) + splitAmt;
    await updateOrderMutation.mutateAsync({
      id: sourceOrder.id,
      data: { total_volume_mt: newSourceVol },
    });
    // Update order volume but don't produce yet — let Step 4 confirm
    await updateOrderMutation.mutateAsync({
      id: order.id,
      data: { total_volume_mt: newOrderVol },
    });
    toast.success(`Merged ${splitAmt} MT from source order`);
    setMinVolumeCheck(null);
    // Step 4: Show production confirmation with updated volume
    const updatedOrder = { ...order, total_volume_mt: newOrderVol };
    setConfirmAction({
      action: "produce",
      order: updatedOrder,
      config: {
        title: "Move to Production",
        description: `Move "${order.item_description}" (${newOrderVol} MT) to production?`,
        confirmText: "Move to Production",
      },
    });
  };

  const isAvailDateValid = (d) =>
    d && !isNaN(Date.parse(d)) && /^\d{4}-\d{2}-\d{2}/.test(d);

  // Ensures combined-group children always sit immediately after their lead.
  // Whenever a lead is encountered, its children are inserted right below it.
  const compactCombinedGroups = (lineOrders) => {
    const leadToChildren = {};
    const childLeadMap = {};
    lineOrders.forEach((o) => {
      if (o.parent_id) {
        if (!leadToChildren[o.parent_id]) leadToChildren[o.parent_id] = [];
        leadToChildren[o.parent_id].push(o);
        childLeadMap[o.id] = o.parent_id;
      }
    });
    if (Object.keys(leadToChildren).length === 0) return lineOrders;

    const result = [];
    const processed = new Set();
    lineOrders.forEach((o) => {
      if (processed.has(o.id)) return;
      if (childLeadMap[o.id]) {
        // Child encountered out of position — skip unless its lead is absent
        if (!lineOrders.find((lo) => lo.id === childLeadMap[o.id])) {
          result.push(o);
          processed.add(o.id);
        }
        return;
      }
      result.push(o);
      processed.add(o.id);
      if (leadToChildren[o.id]) {
        // Immediately place all children of this lead in priority_seq order
        const children = [...leadToChildren[o.id]].sort(
          (a, b) => (a.priority_seq ?? 0) - (b.priority_seq ?? 0),
        );
        children.forEach((child) => {
          result.push(child);
          processed.add(child.id);
        });
      }
    });
    return result;
  };

  const cascadeSchedule = async (orderedList, startFromIndex = 0) => {
    const updates = [];
    let prevCompletion = null;
    let prevChangeover = 0; // PREVIOUS order's changeover (used as gap to next order's start)

    for (let i = 0; i < orderedList.length; i++) {
      const order = orderedList[i];

      if (order.status === "completed" || order.status === "cancel_po") {
        const d = parseCompletionDateStr(order.target_completion_date);
        if (d) prevCompletion = d;
        prevChangeover = parseFloat(order.changeover_time ?? 0.17);
        continue;
      }

      if (i < startFromIndex) {
        const stored = parseCompletionDateStr(order.target_completion_date);
        if (stored) prevCompletion = stored;
        else prevCompletion = null;
        prevChangeover = parseFloat(order.changeover_time ?? 0.17);
        continue;
      }

      let updatedOrder = { ...order };

      if (!updatedOrder.production_hours_manual) {
        updatedOrder.production_hours = calcProductionHours(updatedOrder);
      }

      if (updatedOrder.target_completion_manual) {
        prevCompletion = parseCompletionDateStr(
          updatedOrder.target_completion_date,
        );
        prevChangeover = parseFloat(updatedOrder.changeover_time ?? 0.17);
        const changed =
          updatedOrder.production_hours !== order.production_hours;
        if (changed) {
          updates.push({
            id: order.id,
            data: { production_hours: updatedOrder.production_hours },
          });
        }
        continue;
      }

      let newCompletion = null;

      // Effective start:
      // – First order with manual start_date → use it
      // – First order with no start_date → today + 08:00 AM
      // – Subsequent orders → prevCompletion + prevChangeover (previous order's CO)
      let effectiveStartDate = updatedOrder.start_date;
      let effectiveStartTime = updatedOrder.start_time;

      if (effectiveStartDate && !effectiveStartTime) {
        effectiveStartTime = "08:00";
      }

      if (effectiveStartDate && effectiveStartTime) {
        // Manual start: completion = start + production hours (no CO in completion)
        const ph = updatedOrder.production_hours != null
          ? parseFloat(updatedOrder.production_hours) : 0;
        newCompletion = calcCompletionDate(effectiveStartDate, effectiveStartTime, ph, 0);
      } else if (prevCompletion) {
        // Auto-cascade: start = prevCompletion + PREVIOUS order's changeover
        const ph = updatedOrder.production_hours != null
          ? parseFloat(updatedOrder.production_hours) : 0;
        const startMs = prevCompletion.getTime() + prevChangeover * 3600000;
        newCompletion = new Date(startMs + ph * 3600000);
      } else if (i === 0) {
        // First order, no start_date set → anchor to today 08:00
        const t = new Date();
        const todayStr = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
        const ph = updatedOrder.production_hours != null
          ? parseFloat(updatedOrder.production_hours) : 0;
        newCompletion = calcCompletionDate(todayStr, "08:00", ph, 0);
      }

      const newCompletionStr = newCompletion
        ? formatCompletionDate(newCompletion)
        : null;
      prevCompletion = newCompletion;
      prevChangeover = parseFloat(updatedOrder.changeover_time ?? 0.17);

      const changed =
        updatedOrder.production_hours !== order.production_hours ||
        (newCompletionStr || "") !== (order.target_completion_date || "");
      if (changed) {
        updates.push({
          id: order.id,
          data: {
            production_hours: updatedOrder.production_hours,
            target_completion_date: newCompletionStr,
          },
        });
      }
    }

    await Promise.all(updates.map((u) => updateOrderMutation.mutateAsync(u)));
  };

  // Auto-trigger cascade for lines where the first active order has an avail_date-derived
  // start but no completion date yet. Runs whenever orders load; stops once dates are saved.
  useEffect(() => {
    if (!orders || orders.length === 0) return;

    const lineGroups = {};
    for (const o of orders) {
      if (!o.feedmill_line) continue;
      if (!lineGroups[o.feedmill_line]) lineGroups[o.feedmill_line] = [];
      lineGroups[o.feedmill_line].push(o);
    }

    const linesToCascade = [];
    for (const line in lineGroups) {
      const sorted = [...lineGroups[line]].sort(
        (a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity),
      );
      const firstActive = sorted.find(
        (o) => o.status !== "completed" && o.status !== "cancel_po",
      );
      if (firstActive && !firstActive.target_completion_date) {
        linesToCascade.push(sorted);
      }
    }

    if (linesToCascade.length > 0) {
      Promise.all(linesToCascade.map((sorted) => cascadeSchedule(sorted, 0)));
    }
  }, [orders]); // eslint-disable-line react-hooks/exhaustive-deps

  // Get orders in feedmill line sorted by priority_seq
  const getLineOrders = (feedmillLine, statusFilter = null) => {
    let lineOrders = orders.filter((o) => o.feedmill_line === feedmillLine);
    if (statusFilter)
      lineOrders = lineOrders.filter((o) => statusFilter.includes(o.status));
    return lineOrders.sort(
      (a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity),
    );
  };

  // Handle drag-and-drop reorder — update priority_seq + cascade scheduling
  const executeReorder = async (reordered) => {
    try {
      localStorage.setItem(
        "nexfeed_order_seq",
        JSON.stringify(reordered.map((o, i) => ({ id: o.id, seq: i }))),
      );
    } catch {}
    const _reorderTs = formatTimestamp();
    await Promise.all(
      reordered.map((o, i) => {
        if (!o || o.priority_seq === i) return Promise.resolve();
        const oldPrio = o.priority_seq;
        const newPrio = i;
        const action = `Manually reordered: Prio ${oldPrio ?? '?'} → ${newPrio}`;
        const newHistory = [...(o.history || []), { timestamp: _reorderTs, action }];
        console.debug('[Order History Write]', {
          orderId: o.id,
          timestamp: _reorderTs,
          action,
        });
        return updateOrderMutation.mutateAsync({
          id: o.id,
          data: { priority_seq: newPrio, history: newHistory },
        });
      }),
    );
    if (reordered[0]) {
      await cascadeSchedule(reordered, 0);
    }
  };

  const handleReorder = async (fromIndex, toIndex, ordersToReorder) => {
    // ordersToReorder is visibleOrders (may exclude hidden children).
    // We need to reorder it and then expand back to include all hidden children.
    const source = ordersToReorder || filteredOrders;
    if (!source || source.length === 0) return;
    const movedOrder = source[fromIndex];
    if (!movedOrder) return;

    // Build a map of hidden children from the full orders array
    // (keyed by parent_id — these are children not present in visibleOrders)
    const hiddenChildrenMap = {};
    orders.forEach((o) => {
      if (o.parent_id) {
        const inSource = source.find((s) => s.id === o.id);
        if (!inSource) {
          if (!hiddenChildrenMap[o.parent_id]) hiddenChildrenMap[o.parent_id] = [];
          hiddenChildrenMap[o.parent_id].push(o);
        }
      }
    });

    let reordered = [...source];

    if (!movedOrder.parent_id && movedOrder.original_order_ids?.length) {
      // Lead: move lead + all its children together as a block
      // Children may be hidden (not in source), so look in full orders array
      const leadId = movedOrder.id;
      const groupIds = new Set([leadId]);
      // Visible children (in source)
      reordered.forEach((o) => {
        if (o.parent_id === leadId) groupIds.add(o.id);
      });
      // Hidden children (not in source)
      (hiddenChildrenMap[leadId] || []).forEach((o) => groupIds.add(o.id));
      const allChildren = orders.filter(
        (o) => o.parent_id === leadId,
      ).sort((a, b) => (a.priority_seq ?? 0) - (b.priority_seq ?? 0));
      const group = [movedOrder, ...allChildren];
      const rest = reordered.filter((o) => !groupIds.has(o.id));
      const destOrder = source[toIndex];
      let insertIdx = destOrder
        ? rest.findIndex((o) => o.id === destOrder.id)
        : rest.length;
      if (insertIdx < 0) insertIdx = Math.min(toIndex, rest.length);
      if (toIndex > fromIndex) insertIdx = Math.min(insertIdx + 1, rest.length);
      rest.splice(insertIdx, 0, ...group);
      reordered = rest;
    } else {
      const [moved] = reordered.splice(fromIndex, 1);
      reordered.splice(toIndex, 0, moved);
      // Expand hidden children back into their positions after their leads
      const expanded = [];
      reordered.forEach((o) => {
        expanded.push(o);
        if (hiddenChildrenMap[o.id]) {
          hiddenChildrenMap[o.id]
            .sort((a, b) => (a.priority_seq ?? 0) - (b.priority_seq ?? 0))
            .forEach((child) => expanded.push(child));
        }
      });
      reordered = expanded;
    }

    // Validation pass: ensure combined groups are still contiguous after reorder
    reordered = compactCombinedGroups(reordered);

    // Simulate cascade on the new order, skip children (they're accounted for by their lead)
    // Only flag NEWLY introduced conflicts (compare against pre-reorder completion dates)
    const preCompletionMap = {};
    orders.forEach((o) => {
      if (o.target_completion_date) preCompletionMap[o.id] = parseCompletionDateStr(o.target_completion_date);
    });

    const affectedOrders = [];
    let prevCompletion = null;
    for (let i = 0; i < reordered.length; i++) {
      const o = reordered[i];
      if (!o || o.parent_id) continue; // skip children
      let sd = o.start_date, st = o.start_time;
      if (i > 0 && prevCompletion && !sd) {
        sd = `${prevCompletion.getFullYear()}-${String(prevCompletion.getMonth()+1).padStart(2,'0')}-${String(prevCompletion.getDate()).padStart(2,'0')}`;
        st = `${String(prevCompletion.getHours()).padStart(2,'0')}:${String(prevCompletion.getMinutes()).padStart(2,'0')}`;
      }
      const ph = parseFloat(o.production_hours) || 0;
      const cd = sd && st ? calcCompletionDate(sd, st, ph, 0) : null;
      if (cd) prevCompletion = cd;
      if (cd && o.target_avail_date && !isNaN(Date.parse(o.target_avail_date))) {
        const avail = new Date(o.target_avail_date);
        avail.setHours(23, 59, 59, 999);
        if (cd > avail) {
          // Only flag if this is a NEW conflict (completion got worse than before)
          const prevCd = preCompletionMap[o.id];
          const wasAlreadyLate = prevCd && prevCd > avail;
          if (!wasAlreadyLate) {
            const diffHrs = Math.round((cd.getTime() - avail.getTime()) / 3600000);
            affectedOrders.push({
              fpr: o.fpr,
              item: o.item_description,
              availDate: o.target_avail_date,
              completionDate: cd,
              delayHrs: diffHrs,
            });
          }
        }
      }
    }

    if (affectedOrders.length > 0) {
      setDragWarning({ reordered, affectedOrders });
      return;
    }

    await executeReorder(reordered);
  };

  // ── Feedmill shutdown / order diversion handlers ────────────────────────────
  const handleFeedmillStatusChange = (fm, updates) => {
    setFeedmillStatus(prev => ({ ...prev, [fm]: { ...prev[fm], ...updates } }));
  };

  // Per-line shutdown handlers
  const handleShutdownLine = (line, fm, shutdownData) => {
    const since = shutdownData.timestamp || new Date().toISOString();
    setLineShutdowns(prev => ({
      ...prev,
      [line]: { isShutdown: true, reason: shutdownData.reason, notes: shutdownData.notes || '', since, feedmill: fm },
    }));
    toast.success(`${line} has been shut down. Reason: ${shutdownData.reason}.`);
  };

  const handleResumeLine = (line, fm) => {
    setLineShutdowns(prev => {
      const updated = { ...prev };
      delete updated[line];
      // If all lines of this feedmill are now active, also clear feedmill-level status
      if (fm) {
        const fmLines = FEEDMILL_LINE_MAP[fm] || [];
        const stillShutdown = fmLines.filter(l => l !== line && updated[l]?.isShutdown);
        if (stillShutdown.length === 0) {
          setFeedmillStatus(fp => ({
            ...fp,
            [fm]: { isShutdown: false, shutdownDate: null, reason: '', notes: '', affectedLines: [] },
          }));
        }
      }
      return updated;
    });
    toast.success(`${line} has been resumed.`);
  };

  const handleResumeFeedmill = (fm) => {
    const fmLines = FEEDMILL_LINE_MAP[fm] || [];
    setLineShutdowns(prev => {
      const updated = { ...prev };
      fmLines.forEach(l => delete updated[l]);
      return updated;
    });
    setFeedmillStatus(prev => ({
      ...prev,
      [fm]: { isShutdown: false, shutdownDate: null, reason: '', notes: '', affectedLines: [] },
    }));
    const fmName = { FM1: 'Feedmill 1', FM2: 'Feedmill 2', FM3: 'Feedmill 3', PMX: 'Powermix' }[fm] || fm;
    toast.success(`${fmName} has been resumed.`);
  };

  const handleShutdownFeedmill = (fm, lines, shutdownData) => {
    const since = shutdownData.timestamp || new Date().toISOString();
    const fmLines = lines || FEEDMILL_LINE_MAP[fm] || [];
    setLineShutdowns(prev => {
      const updated = { ...prev };
      fmLines.forEach(line => {
        updated[line] = { isShutdown: true, reason: shutdownData.reason, notes: shutdownData.notes || '', since, feedmill: fm, isFeedmillShutdown: true };
      });
      return updated;
    });
    setFeedmillStatus(prev => ({
      ...prev,
      [fm]: { isShutdown: true, shutdownDate: since.slice(0, 10), reason: shutdownData.reason, notes: shutdownData.notes || '', affectedLines: fmLines },
    }));
    const fmName = { FM1: 'Feedmill 1', FM2: 'Feedmill 2', FM3: 'Feedmill 3', PMX: 'Powermix' }[fm] || fm;
    toast.success(`${fmName} has been shut down. All lines marked as shutdown.`);
  };

  const handleDivertOrderConfirm = async (order, selectedLine, calcs, aiText) => {
    const diversionData = {
      originalLine: order.feedmill_line || order.line || '',
      originalPrio: order.priority_seq ?? null,
      originalFeedmill: Object.entries(feedmillStatus).find(([, s]) => s.isShutdown) ? Object.entries(feedmillStatus).filter(([, s]) => s.isShutdown).map(([fm]) => fm).join(', ') : '',
      currentLine: selectedLine.line,
      divertedAt: new Date().toISOString(),
      shutdownReason: Object.entries(feedmillStatus).filter(([, s]) => s.isShutdown).map(([fm]) => feedmillStatus[fm].reason || fm).join(', ') || 'Shutdown',
      aiAnalysis: aiText,
      calculatedProductionTime: calcs?.newProductionTime,
    };

    // ── History: Line shutdown vs Feedmill shutdown divert ────────────────────
    const oldLine = order.feedmill_line || order.line || '';
    const oldPrio = order.priority_seq ?? null;
    const newLine = selectedLine.line;
    // Compute new prio: append to bottom of target line's active queue
    const targetActiveCount = orders.filter(
      (o) =>
        o.feedmill_line === newLine &&
        o.id !== order.id &&
        o.status !== 'completed' &&
        o.status !== 'cancel_po',
    ).length;
    const newPrio = targetActiveCount + 1;
    const isFeedmillShutdown = !!diversionData.originalFeedmill;
    const eventLabel = isFeedmillShutdown ? 'Feedmill shutdown' : 'Line shutdown';
    const histAction = `${eventLabel}: ${oldLine} → ${newLine}`;
    // Pull the actual selected shutdown reason from state
    const _shutdownReason = isFeedmillShutdown
      ? (Object.entries(feedmillStatus)
          .filter(([, s]) => s.isShutdown)
          .map(([, s]) => s.reason)
          .find(Boolean) || 'Shutdown')
      : (lineShutdowns[oldLine]?.reason || 'Shutdown');
    const histDetails = `${_shutdownReason}. Moved from Prio ${oldPrio ?? '?'} → ${newPrio}`;
    const histTs = formatTimestamp();
    const newHistory = [...(order.history || []), { timestamp: histTs, action: histAction, details: histDetails }];
    console.debug('[Order History Write]', {
      orderId: order.id,
      timestamp: histTs,
      action: histAction,
      details: histDetails,
      eventType: eventLabel,
    });

    await handleUpdateOrder(order.id, {
      feedmill_line: selectedLine.line,
      priority_seq: newPrio,
      diversion_data: diversionData,
      history: newHistory,
    });
    setDivertDialog(null);
  };

  const handleRevertOrderConfirm = async (order) => {
    const dd = order.diversion_data || {};
    const originalLine = dd.originalLine;
    if (!originalLine) {
      setRevertDialog(null);
      return;
    }
    // ── Eligibility guard: block revert if original line/feedmill still shutdown ──
    const _revertCurrentLine = order.feedmill_line || dd.currentLine || '';
    const _revertOriginalLine = originalLine;
    const _revertIsFeedmill = !!dd.originalFeedmill;
    const _origLineStillDown = !!(lineShutdowns[_revertOriginalLine]?.isShutdown);
    const _origFMKey = _revertIsFeedmill
      ? (dd.originalFeedmill?.split(',')?.[0]?.trim() || null)
      : null;
    const _origFMStillDown = _origFMKey ? !!(feedmillStatus[_origFMKey]?.isShutdown) : false;
    const _revertBlocked = _origLineStillDown || _origFMStillDown;
    const _revertCurrentPrio = order.priority_seq ?? null;
    const _revertOriginalPrio = dd.originalPrio ?? null;
    const _revertEventLabel = _revertIsFeedmill ? 'Feedmill shutdown' : 'Line shutdown';

    console.debug('[Shutdown Revert Check]', {
      orderId: order.id,
      eventType: _revertEventLabel,
      originalLine: _revertOriginalLine,
      currentLine: _revertCurrentLine,
      originalPriority: _revertOriginalPrio,
      currentPriority: _revertCurrentPrio,
      originalSourceActive: !_revertBlocked,
      revertAllowed: !_revertBlocked,
    });

    if (_revertBlocked) {
      const _blockMsg = _revertIsFeedmill
        ? 'Cannot revert order until the feedmill is back in operation.'
        : 'Cannot revert order while the original line is still in shutdown.';
      toast.error(_blockMsg);
      setRevertDialog(null);
      return;
    }

    // ── History: revert line/feedmill shutdown ────────────────────────────────
    const _revertAction = `${_revertEventLabel}: ${_revertCurrentLine} → ${_revertOriginalLine}`;
    const _revertDetails = `Reverted. Moved from Prio ${_revertCurrentPrio ?? '?'} → ${_revertOriginalPrio ?? '?'}`;
    const _revertTs = formatTimestamp();
    const _revertHistory = [...(order.history || []), { timestamp: _revertTs, action: _revertAction, details: _revertDetails }];
    console.debug('[Order History Write]', {
      orderId: order.id,
      timestamp: _revertTs,
      action: _revertAction,
      details: _revertDetails,
      eventType: _revertEventLabel,
      isRevert: true,
    });
    await handleUpdateOrder(order.id, {
      feedmill_line: originalLine,
      diversion_data: null,
      history: _revertHistory,
    });
    setRevertDialog(null);
  };
  // ── END diversion handlers ────────────────────────────────────────────────

  const handleUpdateOrder = async (id, data) => {
    const order = orders.find((o) => o.id === id);
    if (!order) {
      await updateOrderMutation.mutateAsync({ id, data });
      return;
    }

    const cascadeFields = [
      "start_date",
      "start_time",
      "production_hours",
      "total_volume_mt",
      "run_rate",
      "form",
      "changeover_time",
      "volume_override",
    ];
    const triggersCascade = cascadeFields.some((f) => f in data);

    if ("production_hours" in data) {
      data.production_hours_manual =
        data.production_hours != null && data.production_hours !== "";
    }

    const merged = { ...order, ...data };

    if (
      !merged.production_hours_manual &&
      ("total_volume_mt" in data ||
        "run_rate" in data ||
        "form" in data ||
        "volume_override" in data)
    ) {
      merged.production_hours = calcProductionHours(merged);
      data.production_hours = merged.production_hours;
      data.production_hours_manual = false;
    }

    const completionReverted =
      "target_completion_manual" in data && !data.target_completion_manual;
    // Also cascade when user manually sets a completion override (so downstream orders update)
    const completionOverrideSet =
      "target_completion_manual" in data && !!data.target_completion_manual;

    await updateOrderMutation.mutateAsync({ id, data });

    // ── Auto-sort when availability date is set or changed ──────────────────
    // Scenarios 1 & 2: non-dated→dated or dated→different date.
    // Scenario 3 (dated→non-dated): no re-sort needed — order stays in place.
    if ("target_avail_date" in data && order.feedmill_line) {
      const newDate = data.target_avail_date;

      if (isAvailDateValid(newDate) && newDate !== order.target_avail_date) {
        // Build the current active order list with the new date already applied
        const activeLineOrders = orders
          .filter(
            (o) =>
              o.feedmill_line === order.feedmill_line &&
              o.status !== "completed" &&
              o.status !== "cancel_po",
          )
          .sort((a, b) => (a.priority_seq ?? 0) - (b.priority_seq ?? 0))
          .map((o) => (o.id === id ? { ...o, target_avail_date: newDate } : o));

        const currentIdx = activeLineOrders.findIndex((o) => o.id === id);
        const oldPrio = currentIdx + 1;

        // Remove the updated order; scan remaining dated orders to find insert point
        const withoutOrder = activeLineOrders.filter((o) => o.id !== id);
        let insertAfterIdx = -1; // −1 means insert before everything
        withoutOrder.forEach((o, i) => {
          if (
            isAvailDateValid(o.target_avail_date) &&
            new Date(o.target_avail_date) <= new Date(newDate)
          ) {
            insertAfterIdx = i;
          }
        });

        const insertPos = insertAfterIdx + 1;
        const newPrio = insertPos + 1;

        if (newPrio !== oldPrio) {
          // Rebuild list with the order at its new chronological position
          const sortedList = [...withoutOrder];
          sortedList.splice(insertPos, 0, activeLineOrders[currentIdx]);

          // Persist only the priority_seqs that actually changed
          const seqUpdates = sortedList
            .map((o, i) => ({
              id: o.id,
              oldSeq: o.priority_seq ?? 0,
              newSeq: i + 1,
            }))
            .filter((u) => u.newSeq !== u.oldSeq);
          await Promise.all(
            seqUpdates.map((u) =>
              updateOrderMutation.mutateAsync({
                id: u.id,
                data: { priority_seq: u.newSeq },
              }),
            ),
          );

          const dateLabel = new Date(newDate).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          });
          toast.info(`↕ Order re-sorted`, {
            description: `FPR ${order.fpr} moved from Prio ${oldPrio} to Prio ${newPrio} to maintain date sequence (${dateLabel}).`,
          });

          // Cascade completion dates from the beginning of the re-sorted line
          const listForCascade = sortedList.map((o, i) => ({
            ...o,
            priority_seq: i + 1,
          }));
          await cascadeSchedule(listForCascade, 0);
          return; // Skip the regular cascade below — we already ran it
        }
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    if ((triggersCascade || completionReverted || completionOverrideSet) && order.feedmill_line) {
      const lineOrders = getLineOrders(order.feedmill_line);
      const updatedIdx = lineOrders.findIndex((o) => o.id === id);
      if (updatedIdx >= 0) {
        const listWithUpdate = lineOrders.map((o) =>
          o.id === id ? { ...o, ...data } : o,
        );
        await cascadeSchedule(listWithUpdate, updatedIdx);
      }
    }
  };

  // Handle cut
  const handleCut = async (order, keepAmount) => {
    try {
      const cutAmount = order.total_volume_mt - keepAmount;

      // Update original order with reduced volume
      await updateOrderMutation.mutateAsync({
        id: order.id,
        data: { total_volume_mt: keepAmount },
      });

      // Create new cut order
      await createOrderMutation.mutateAsync({
        ...order,
        id: undefined,
        total_volume_mt: cutAmount,
        status: "cut",
        parent_order_id: order.id,
      });

      toast.success("Order split successfully");
    } catch (error) {
      console.error("Cut error:", error);
      toast.error("Failed to cut order");
    }
  };

  // Handle combine
  const handleCombine = async (mainOrder, selectedIds) => {
    try {
      const ordersToCombine = orders.filter((o) => selectedIds.includes(o.id));
      const totalVolume =
        mainOrder.total_volume_mt +
        ordersToCombine.reduce((s, o) => s + (o.total_volume_mt || 0), 0);

      // Find earliest target date
      const allDates = [mainOrder, ...ordersToCombine]
        .map((o) => o.target_avail_date)
        .filter((d) => d && !isNaN(Date.parse(d)))
        .sort((a, b) => new Date(a) - new Date(b));

      // Store full snapshots of originals for revert
      const snapshot = [mainOrder, ...ordersToCombine].map((o) => ({ ...o }));

      // Create combined order
      await createOrderMutation.mutateAsync({
        ...mainOrder,
        id: undefined,
        total_volume_mt: totalVolume,
        fg: "",
        sfg: "",
        sfg1: "",
        target_avail_date: allDates[0] || mainOrder.target_avail_date,
        status: "combined",
        original_order_ids: [mainOrder.id, ...selectedIds],
        original_orders_snapshot: snapshot,
      });

      // Delete original orders
      for (const id of [mainOrder.id, ...selectedIds]) {
        await Order.delete(id);
      }

      queryClient.invalidateQueries({ queryKey: ["orders"] });
      toast.success("Orders combined successfully");
    } catch (error) {
      console.error("Combine error:", error);
      toast.error("Failed to combine orders");
    }
  };

  const handleSmartCombine = async (leadOrder, childUpdates, originalGroup) => {
    try {
      // Snapshot the current line orders BEFORE any mutations
      const feedmillLine = leadOrder.feedmill_line;
      const preMutationLineOrders = orders
        .filter((o) => o.feedmill_line === feedmillLine)
        .sort(
          (a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity),
        );

      // 1. Create the lead order
      const createdLead = await createOrderMutation.mutateAsync(leadOrder);
      const leadId = createdLead?.id || leadOrder.id;

      // 2. Set parent_id (and status/other fields) on all children — no priority_seq yet
      for (let i = 0; i < childUpdates.length; i++) {
        const cu = childUpdates[i];
        const { priority_seq: _ignore, ...childData } = cu.data || {};
        await updateOrderMutation.mutateAsync({
          id: cu.id,
          data: { ...childData, parent_id: leadId },
        });
      }

      // 3. Build the definitive ordering using the pre-mutation snapshot
      const originalGroupIds = new Set(originalGroup.map((o) => o.id));
      const allNonGroup = preMutationLineOrders.filter(
        (o) => !originalGroupIds.has(o.id),
      );

      // Split non-group orders into top-level orders (leads + regular) and
      // children of OTHER existing combined groups.  Children must always stay
      // at the bottom, so only top-level orders participate in insertion logic.
      const isValidISODate = (v) =>
        v && !isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}/.test(v);

      const nonGroupTopLevel = allNonGroup.filter((o) => !o.parent_id);
      const otherGroupChildren = allNonGroup.filter((o) => !!o.parent_id);

      // Children from the NEW group, sorted by their original priority_seq
      const sortedChildren = [...originalGroup].sort(
        (a, b) => (a.priority_seq ?? 0) - (b.priority_seq ?? 0),
      );

      // Determine where the lead lands among top-level orders.
      // Insertion rules (mirrors what the AI is told):
      //   - Dated lead  → insert before the first non-dated order OR the first
      //                    order whose avail date is strictly later.
      //   - Non-dated   → insert at the slot of the lowest-priority_seq order in the group
      //                    (i.e. before the first nonGroupTopLevel order that had a higher
      //                    priority_seq than the earliest group member).
      let insertIdx;
      if (isValidISODate(leadOrder.target_avail_date)) {
        const leadDate = new Date(leadOrder.target_avail_date);
        insertIdx = nonGroupTopLevel.length; // default: end of top-level
        for (let j = 0; j < nonGroupTopLevel.length; j++) {
          const o = nonGroupTopLevel[j];
          if (!isValidISODate(o.target_avail_date)) {
            insertIdx = j; // first undated order → lead goes before it
            break;
          }
          if (new Date(o.target_avail_date) > leadDate) {
            insertIdx = j; // first strictly-later dated order → lead goes before it
            break;
          }
        }
      } else {
        // Non-dated: combined order takes the slot of the lowest priority_seq group member.
        const lowestGroupSeq = Math.min(...originalGroup.map((o) => o.priority_seq ?? Infinity));
        insertIdx = nonGroupTopLevel.length; // default: very end
        for (let j = 0; j < nonGroupTopLevel.length; j++) {
          if ((nonGroupTopLevel[j].priority_seq ?? Infinity) > lowestGroupSeq) {
            insertIdx = j;
            break;
          }
        }
        console.log(`[SmartCombine] Non-dated — lowestGroupSeq=${lowestGroupSeq} → insertIdx ${insertIdx} of ${nonGroupTopLevel.length}`);
      }

      // Build lead→children map for OTHER existing groups
      const otherLeadChildMap = {};
      for (const child of otherGroupChildren) {
        if (!otherLeadChildMap[child.parent_id])
          otherLeadChildMap[child.parent_id] = [];
        otherLeadChildMap[child.parent_id].push(child);
      }

      // Interleave: new lead + new children at insertIdx, other leads' children right after their lead
      const topLevelWithLead = [
        ...nonGroupTopLevel.slice(0, insertIdx),
        { id: leadId },
        ...nonGroupTopLevel.slice(insertIdx),
      ];
      const fullOrder = [];
      for (const o of topLevelWithLead) {
        fullOrder.push(o);
        if (o.id === leadId) {
          fullOrder.push(...sortedChildren);
        } else if (otherLeadChildMap[o.id]) {
          const ch = [...otherLeadChildMap[o.id]].sort(
            (a, b) => (a.priority_seq ?? 0) - (b.priority_seq ?? 0),
          );
          fullOrder.push(...ch);
        }
      }

      // 4. Atomically assign priority_seqs for ALL orders on this line
      await Promise.all(
        fullOrder.map((o, i) =>
          updateOrderMutation.mutateAsync({
            id: o.id,
            data: { priority_seq: i },
          }),
        ),
      );

      // 5. Run cascadeSchedule on the full ordered line so completion dates are
      //    computed and saved for the lead and all subsequent orders.
      //    Build the ordered list with complete order data (using pre-mutation snapshot
      //    for existing orders and the full leadOrder object for the new lead).
      const preMutationMap = {};
      for (const o of preMutationLineOrders) preMutationMap[o.id] = o;

      const orderedListForCascade = fullOrder.map((o) => {
        if (o.id === leadId) {
          return { ...leadOrder, id: leadId, priority_seq: fullOrder.findIndex((x) => x.id === leadId) };
        }
        return preMutationMap[o.id] || o;
      });

      await cascadeSchedule(orderedListForCascade, 0);

      queryClient.invalidateQueries({ queryKey: ["orders"] });
      toast.success("Orders combined successfully");
    } catch (error) {
      console.error("Smart combine error:", error);
      toast.error("Failed to combine orders");
      throw error;
    }
  };

  // Handle bulk send to production
  const handleBulkProduce = () => {
    if (selectedOrders.length === 0) return;
    setShowBulkConfirm(true);
  };

  const executeBulkProduce = async () => {
    try {
      await Promise.all(
        selectedOrders.map((id) =>
          updateOrderMutation.mutateAsync({
            id,
            data: { status: "in_production" },
          }),
        ),
      );
      setSelectedOrders([]);
      setBulkMode(false);
      setShowBulkConfirm(false);
      toast.success(`${selectedOrders.length} orders moved to production`);
    } catch (error) {
      toast.error("Failed to move orders to production");
    }
  };

  // Handle clear all orders
  const handleClearAll = async () => {
    try {
      await Promise.all(orders.map((o) => Order.delete(o.id)));
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      setActiveSection("orders");
      setActiveSubSection("all");
      toast.success("All orders cleared");
    } catch (error) {
      toast.error("Failed to clear orders");
    }
  };

  // Get eligible orders for combining — same material code, from Normal or Pending, no volume limit
  const eligibleCombineOrders = useMemo(() => {
    if (!cutCombineOrder) return [];
    return orders.filter((o) => {
      if (o.id === cutCombineOrder.id) return false;
      if (o.material_code !== cutCombineOrder.material_code) return false;
      return o.status === "normal" || o.status === "cut";
    });
  }, [cutCombineOrder, orders]);

  // Render content based on active section
  const renderContent = () => {
    if (activeSection === "overview") {
      return (
        <OverviewDashboard
          orders={enrichedOrders}
          onReapplyKB={handleReapplyKB}
          feedmillStatus={feedmillStatus}
          onFeedmillStatusChange={handleFeedmillStatusChange}
          lineShutdowns={lineShutdowns}
          onShutdownLine={handleShutdownLine}
          onResumeLine={handleResumeLine}
          onResumeFeedmill={handleResumeFeedmill}
          onShutdownFeedmill={handleShutdownFeedmill}
          kbRecords={kbRecords}
          inferredTargetMap={inferredTargetMap}
        />
      );
    }

    if (activeSection === "analytics") {
      return <AnalyticsDashboard orders={enrichedOrders} />;
    }

    if (activeSection === "orders") {
      if (isLoading)
        return (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-[var(--nexfeed-primary)]" />
          </div>
        );
      return (
        <PlannedOrdersContent
          orders={scheduledOrders}
          activeFeedmill={activeFeedmill}
          activeSubSection={activeSubSection}
          onSubSectionChange={(sub) => {
            setActiveSubSection(sub);
          }}
          onStatusChange={handleStatusChange}
          onCancelRequest={handleCancelRequest}
          onRestoreRequest={handleRestoreRequest}
          onUncombineRequest={handleUncombineRequest}
          onCutRequest={handleCutRequest}
          onMergeBackRequest={handleMergeBackRequest}
          onUpdateOrder={handleUpdateOrder}
          onReorder={handleReorder}
          onUpload={() => setIsUploadModalOpen(true)}
          isUploading={isUploading}
          sortConfig={sortConfig}
          onSort={handleSort}
          onAutoSequence={handleLineAutoSequence}
          onPlantAutoSequence={handlePlantLevelAutoSequence}
          onFeedmillAutoSequence={handleFeedmillAutoSequence}
          lastUploadDate={lastUploadDate}
          inferredTargetMap={inferredTargetMap}
          lastN10DUploadDate={lastN10DUploadDate}
          onNavigateToN10D={() => {
            setActiveSection("configurations");
            setActiveSubSection("next_10_days");
          }}
          onAddOrder={handleOpenAddOrder}
          feedmillStatus={feedmillStatus}
          lineShutdowns={lineShutdowns}
          kbRecords={kbRecords}
          n10dRecords={activeN10DRecords}
          onDivertOrder={(order) => setDivertDialog({ order })}
          onRevertOrder={(order) => setRevertDialog({ order })}
        />
      );
    }
    if (activeSection === "planned") {
      if (isLoading)
        return (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-[var(--nexfeed-primary)]" />
          </div>
        );
      return (
        <PlannedOrdersContent
          orders={scheduledOrders}
          activeFeedmill={activeFeedmill}
          activeSubSection={activeSubSection}
          onSubSectionChange={(sub) => {
            setActiveSubSection(sub);
          }}
          onStatusChange={handleStatusChange}
          onCancelRequest={handleCancelRequest}
          onRestoreRequest={handleRestoreRequest}
          onUncombineRequest={handleUncombineRequest}
          onCutRequest={handleCutRequest}
          onMergeBackRequest={handleMergeBackRequest}
          onUpdateOrder={handleUpdateOrder}
          onReorder={handleReorder}
          onUpload={() => setIsUploadModalOpen(true)}
          isUploading={isUploading}
          sortConfig={sortConfig}
          onSort={handleSort}
          onAutoSequence={handleLineAutoSequence}
          onPlantAutoSequence={handlePlantLevelAutoSequence}
          onFeedmillAutoSequence={handleFeedmillAutoSequence}
          lastUploadDate={lastUploadDate}
          inferredTargetMap={inferredTargetMap}
          lastN10DUploadDate={lastN10DUploadDate}
          onNavigateToN10D={() => {
            setActiveSection("configurations");
            setActiveSubSection("next_10_days");
          }}
          onAddOrder={handleOpenAddOrder}
          feedmillStatus={feedmillStatus}
          lineShutdowns={lineShutdowns}
          kbRecords={kbRecords}
          n10dRecords={activeN10DRecords}
          onDivertOrder={(order) => setDivertDialog({ order })}
          onRevertOrder={(order) => setRevertDialog({ order })}
        />
      );
    }

    // Configurations section
    if (activeSection === "configurations") {
      if (activeSubSection === "knowledge_base") {
        return (
          <KnowledgeBaseManager
            orders={enrichedOrders}
            onReapply={handleReapplyKB}
          />
        );
      }
      if (activeSubSection === "next_10_days") {
        return (
          <Next10DaysManager
            onApplied={handleN10DApplied}
            sapOrders={enrichedOrders}
            onUpdateOrder={(id, data) => updateOrderMutation.mutateAsync({ id, data })}
          />
        );
      }
      if (activeSubSection === "changeover_rules") {
        return (
          <ChangeoverRulesPage
            key="changeover-rules"
            onSave={(savedRules) => setChangeoverRules(savedRules)}
          />
        );
      }
      // Order History (default) — use changeover-enriched orders so CO values are correct
      const completedOrders = changeoverEnrichedOrders
        .filter((o) => o.status === "completed")
        .sort((a, b) => {
          const aDate = a.changeover_frozen_at || a.end_date || a.updated_date || "";
          const bDate = b.changeover_frozen_at || b.end_date || b.updated_date || "";
          return bDate > aDate ? 1 : bDate < aDate ? -1 : 0;
        });
      const cancelledOrders = changeoverEnrichedOrders
        .filter((o) => o.status === "cancel_po")
        .sort((a, b) => {
          const aDate = a.cancelled_date || a.updated_date || "";
          const bDate = b.cancelled_date || b.updated_date || "";
          return bDate > aDate ? 1 : bDate < aDate ? -1 : 0;
        });
      const historyLines = [
        "All",
        "Line 1",
        "Line 2",
        "Line 3",
        "Line 4",
        "Line 5",
        "Line 6",
        "Line 7",
      ];
      const currentPool =
        historyTab === "completed" ? completedOrders : cancelledOrders;
      const filteredHistory =
        historyLineFilter === "All"
          ? currentPool
          : currentPool.filter((o) => o.feedmill_line === historyLineFilter);
      return (
        <div>
          <div className="flex items-center gap-4 mb-4 border-b border-gray-200">
            <button
              onClick={() => setHistoryTab("completed")}
              className={`pb-2 px-1 text-[12px] font-medium transition-colors ${
                historyTab === "completed"
                  ? "text-[var(--nexfeed-primary)] border-b-2 border-[var(--nexfeed-primary)]"
                  : "text-gray-500 hover:text-gray-700"
              }`}
              data-testid="tab-history-completed"
              data-tour="history-completed-tab"
            >
              Completed Orders{" "}
              <span className="ml-1 text-[12px]">
                ({completedOrders.length})
              </span>
            </button>
            <button
              onClick={() => setHistoryTab("cancelled")}
              className={`pb-2 px-1 text-[12px] font-medium transition-colors ${
                historyTab === "cancelled"
                  ? "text-[var(--nexfeed-primary)] border-b-2 border-[var(--nexfeed-primary)]"
                  : "text-gray-500 hover:text-gray-700"
              }`}
              data-testid="tab-history-cancelled"
              data-tour="history-cancelled-tab"
            >
              Cancelled Orders{" "}
              <span className="ml-1 text-[12px]">
                ({cancelledOrders.length})
              </span>
            </button>
          </div>
          <p className="text-[12px] text-gray-500 mb-4">
            {historyTab === "completed"
              ? "All completed orders are stored here."
              : "All cancelled orders are stored here."}
          </p>
          <div className="flex items-center gap-1 mb-4 flex-wrap" data-tour="history-line-tabs">
            {historyLines.map((line) => {
              const count =
                line === "All"
                  ? currentPool.length
                  : currentPool.filter((o) => o.feedmill_line === line).length;
              const isActive = historyLineFilter === line;
              return (
                <button
                  key={line}
                  onClick={() => setHistoryLineFilter(line)}
                  className={`px-3 py-1.5 rounded-full text-[11px] font-medium transition-colors ${
                    isActive
                      ? "bg-[var(--nexfeed-primary)] text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                  data-testid={`button-history-filter-${line.replace(/\s/g, "-").toLowerCase()}`}
                >
                  {line}{" "}
                  <span
                    className={`ml-1 ${isActive ? "text-white/80" : "text-gray-400"}`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          <div data-tour="history-table">
            <OrderTable
              orders={filteredHistory}
              allOrders={enrichedOrders}
              onUpdateOrder={handleUpdateOrder}
              onStatusChange={handleStatusChange}
              readOnly={true}
              isCancelledHistory={historyTab === "cancelled"}
              emptyMessage={
                historyTab === "completed"
                  ? "No completed orders yet."
                  : "No cancelled orders yet."
              }
              suppressCombinedTint={true}
            />
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <div className="min-h-screen bg-[#f5f7f8]">
      <Header
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        onStartTour={() => setTourMenuOpen(true)}
      />

      <Sidebar
        isOpen={sidebarOpen}
        activeSection={activeSection}
        activeSubSection={activeSubSection}
        activeFeedmill={activeFeedmill}
        onNavigate={handleNavigate}
        orderCounts={orderCounts}
        onClearAll={handleClearAll}
      />

      <main
        className={`pt-16 transition-all duration-300 ${
          sidebarOpen ? "ml-[200px]" : "ml-0"
        }`}
      >
        <div className="p-6">
          {/* Page Title */}
          {(activeSection === "overview" ||
            activeSection === "analytics" ||
            activeSection === "configurations") && (
            <div className="mb-6">
              <h1 className="text-2xl font-bold text-gray-900">
                {activeSection === "overview" && "Dashboard Overview"}
                {activeSection === "analytics" && "Analytics & Insights"}
                {activeSection === "configurations" && "Configurations"}
              </h1>
              <p className="text-gray-500 text-[12px] mt-1">
                {activeSection === "overview" &&
                  "Monitor production status and line capacity"}
                {activeSection === "analytics" &&
                  "Charts, insights, and AI-powered recommendations"}
                {activeSection === "configurations" &&
                  "Production Order Management"}
              </p>
            </div>
          )}

          {renderContent()}
        </div>
      </main>

      {/* Modals */}
      <UploadModal
        isOpen={isUploadModalOpen}
        onClose={() => setIsUploadModalOpen(false)}
        onUpload={handleUpload}
        isUploading={isUploading}
      />

      <CutCombineModal
        isOpen={!!cutCombineOrder}
        onClose={() => setCutCombineOrder(null)}
        order={cutCombineOrder}
        eligibleOrders={eligibleCombineOrders}
        onCut={handleCut}
        onCombine={handleCombine}
      />

      {/* Confirm Dialog */}
      {confirmAction && (
        <ConfirmDialog
          isOpen={!!confirmAction}
          onClose={() => setConfirmAction(null)}
          onConfirm={executeAction}
          title={confirmAction.config.title}
          description={confirmAction.config.description}
          confirmText={confirmAction.config.confirmText}
          variant={confirmAction.config.variant}
        />
      )}

      {/* Bulk Produce Confirmation Dialog */}
      <AlertDialog open={showBulkConfirm} onOpenChange={setShowBulkConfirm}>
        <AlertDialogContent className="max-w-[480px]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[18px] font-bold">Confirm Bulk Production</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p className="mb-3 text-[14px] leading-relaxed">
                  You are about to send{" "}
                  <strong>{selectedOrders.length} order(s)</strong> to
                  production.
                </p>
                <div className="bg-gray-50 rounded-lg p-3 max-h-40 overflow-y-auto space-y-1">
                  {orders
                    .filter((o) => selectedOrders.includes(o.id))
                    .map((o) => (
                      <div
                        key={o.id}
                        className="text-[13px] text-gray-700 flex justify-between"
                      >
                        <span className="font-medium truncate mr-2">
                          {o.item_description || o.material_code}
                        </span>
                        <span className="text-gray-500 shrink-0">
                          {o.total_volume_mt} MT
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-[14px] font-semibold h-10 px-5">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-green-600 hover:bg-green-700 text-white text-[14px] font-semibold h-10 px-5"
              onClick={executeBulkProduce}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reason Dialog — Cancel / Revert Cancelled */}
      <CancelOrderDialog
        order={cancelDialogOrder}
        open={!!cancelDialogOrder}
        onClose={() => setCancelDialogOrder(null)}
        onConfirm={handleCancelConfirm}
      />

      <RestoreOrderDialog
        order={restoreDialogOrder}
        open={!!restoreDialogOrder}
        onClose={() => {
          setRestoreDialogOrder(null);
          setRestoreNewStatus(null);
        }}
        onConfirm={handleRestoreConfirm}
        newStatus={restoreNewStatus}
      />

      <UncombineOrderDialog
        open={!!uncombineDialogOrder}
        onClose={() => setUncombineDialogOrder(null)}
        onConfirm={handleUncombineConfirm}
        leadOrder={uncombineDialogOrder}
        childOrders={
          uncombineDialogOrder
            ? orders.filter((o) => o.parent_id === uncombineDialogOrder.id)
            : []
        }
      />

      {/* Drag warning dialog */}
      {dragWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDragWarning(null)} />
          <div className="relative rounded-xl shadow-2xl w-full max-w-md mx-4 p-5 space-y-4" style={{ background: 'var(--color-bg-secondary)' }}>
            <div className="flex items-start gap-3">
              <div className="shrink-0 w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center">
                <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
              </div>
              <div>
                <h3 className="text-[14px] font-bold text-[#1a1a1a] mb-0.5">Schedule conflict detected</h3>
                <p className="text-[12px] text-gray-500">Moving this order will push the following orders past their Avail Date:</p>
              </div>
            </div>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {dragWarning.affectedOrders.map((ao, i) => {
                const delayLabel = ao.delayHrs >= 24
                  ? `${Math.floor(ao.delayHrs / 24)} days ${ao.delayHrs % 24} hrs`
                  : `${ao.delayHrs} hours`;
                const availFmt = ao.availDate && !isNaN(Date.parse(ao.availDate))
                  ? new Date(ao.availDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                  : ao.availDate;
                return (
                  <div key={i} className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 flex items-start justify-between gap-2">
                    <div>
                      <p className="text-[12px] font-semibold text-[#1a1a1a]">FPR {ao.fpr} — {ao.item}</p>
                      <p className="text-[11px] text-gray-500">Avail: {availFmt}</p>
                    </div>
                    <span className="text-[11px] font-semibold text-amber-700 shrink-0">+{delayLabel}</span>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2 justify-end">
              <button
                className="px-4 py-2 rounded-lg text-[13px] font-semibold border border-gray-200 hover:bg-gray-50 text-gray-700"
                onClick={() => setDragWarning(null)}
              >
                Cancel move
              </button>
              <button
                className="px-4 py-2 rounded-lg text-[13px] font-semibold bg-amber-500 hover:bg-amber-600 text-white"
                onClick={async () => {
                  const reordered = dragWarning.reordered;
                  setDragWarning(null);
                  await executeReorder(reordered);
                }}
              >
                Move anyway
              </button>
            </div>
          </div>
        </div>
      )}

      <CutOrderDialog
        open={!!cutDialogOrder}
        onClose={() => setCutDialogOrder(null)}
        onConfirm={handleCutConfirm}
        order={cutDialogOrder}
        allOrders={orders}
      />

      <MergeBackDialog
        open={!!mergeBackDialog}
        onClose={() => setMergeBackDialog(null)}
        onConfirm={handleMergeBackConfirm}
        portion1={mergeBackDialog?.portion1}
        portion2={mergeBackDialog?.portion2}
      />

      {divertDialog && (
        <DivertOrderDialog
          order={divertDialog.order}
          allOrders={enrichedOrders}
          kbRecords={kbRecords}
          feedmillStatus={feedmillStatus}
          lineShutdowns={lineShutdowns}
          onConfirm={handleDivertOrderConfirm}
          onClose={() => setDivertDialog(null)}
        />
      )}

      {revertDialog && (
        <RevertOrderDialog
          order={revertDialog.order}
          feedmillStatus={feedmillStatus}
          lineShutdowns={lineShutdowns}
          onConfirm={handleRevertOrderConfirm}
          onClose={() => setRevertDialog(null)}
        />
      )}

      {reasonDialog && (
        <ReasonDialog
          isOpen={!!reasonDialog}
          onClose={() => setReasonDialog(null)}
          title={
            reasonDialog.action === "cancel"
              ? "Cancel Order"
              : "Revert Cancelled Order"
          }
          description={
            reasonDialog.action === "cancel"
              ? "Provide a reason for cancellation."
              : "Provide a reason for reverting this order."
          }
          confirmText={
            reasonDialog.action === "cancel" ? "Cancel Order" : "Revert Order"
          }
          variant={reasonDialog.action === "cancel" ? "destructive" : "default"}
          onConfirm={
            reasonDialog.action === "cancel"
              ? handleCancelWithReason
              : handleRevertCancelledWithReason
          }
        />
      )}

      {/* Produce as Independent Dialog */}
      <ProduceAsIndependentDialog
        isOpen={!!produceIndependentOrder}
        onClose={() => setProduceIndependentOrder(null)}
        order={produceIndependentOrder}
        onConfirm={handleProduceAsIndependent}
      />

      {/* 40 MT Minimum Volume Check Dialog */}
      {minVolumeCheck && (
        <MinVolumeCheckDialog
          isOpen={!!minVolumeCheck}
          onClose={() => setMinVolumeCheck(null)}
          order={minVolumeCheck.order}
          eligibleSources={minVolumeCheck.sources}
          onProceed={minVolumeCheck.onProceed}
          onSplitAndMerge={handleSplitAndMerge}
        />
      )}

      {/* Pending Revert Dialog */}
      {pendingRevertDialog && (
        <PendingRevertDialog
          isOpen={!!pendingRevertDialog}
          onClose={() => setPendingRevertDialog(null)}
          order={pendingRevertDialog.order}
          parentOrder={pendingRevertDialog.parentOrder}
          onRevertToParent={handlePendingRevertToParent}
          onMakeStandalone={handlePendingRevertStandalone}
        />
      )}

      {/* In Production / On-going Ordering Check — orders above must be Done/Planned/InProd/OnGoing */}
      <AlertDialog
        open={!!inProdOrderingDialog}
        onOpenChange={(o) => { if (!o) setInProdOrderingDialog(null); }}
      >
        <AlertDialogContent className="max-w-[460px]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[16px] font-bold">
              Cannot Set On-going
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-[13px] leading-relaxed text-gray-700">
                <p>
                  A prior order is not yet being produced. Consider processing
                  the earlier order first before marking this order as on-going.
                </p>
                {inProdOrderingDialog?.blockers?.length > 0 && (
                  <div className="mt-3">
                    <p className="text-[11px] text-gray-500 font-semibold mb-1">
                      Orders ahead that need attention:
                    </p>
                    <ul className="list-none p-0 m-0 space-y-0.5">
                      {inProdOrderingDialog.blockers.map(({ order: b, prio }) => (
                        <li key={b.id} className="text-[12px] text-gray-700">
                          • Priority {prio}:{" "}
                          <strong>{b.fpr || b.item_description}</strong> —{" "}
                          <em>{(b.status || "plotted").replace(/_/g, " ")}</em>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              style={{ background: "var(--nexfeed-primary)", color: "#ffffff", border: "none" }}
              className="text-[13px] font-semibold h-9 px-5 hover:opacity-90"
              onClick={() => setInProdOrderingDialog(null)}
            >
              OK
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* In Production Conflict — only 1 per line */}
      <AlertDialog
        open={!!inProdConflictDialog}
        onOpenChange={(o) => { if (!o) setInProdConflictDialog(null); }}
      >
        <AlertDialogContent className="max-w-[480px]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[18px] font-bold">Already In Production</AlertDialogTitle>
            <AlertDialogDescription className="text-[14px] leading-relaxed">
              <strong>{inProdConflictDialog?.existing?.fpr || inProdConflictDialog?.existing?.item_description}</strong> is
              already <em>In Production</em> on {inProdConflictDialog?.existing?.feedmill_line}.
              Only one order can be In Production per line at a time.
              <br /><br />
              Please mark the current In Production order as On-going or Done before setting a new one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              className="text-[14px] font-semibold h-10 px-5"
              onClick={() => setInProdConflictDialog(null)}
            >
              OK
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Mark as Done — Blocking (missing End Date/Time) */}
      <AlertDialog
        open={!!markDoneBlocking}
        onOpenChange={() => setMarkDoneBlocking(null)}
      >
        <AlertDialogContent className="max-w-[480px]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[18px] font-bold">Cannot Mark as Done</AlertDialogTitle>
            <AlertDialogDescription className="text-[14px] leading-relaxed">
              The End Date / Time field is required before marking this order as
              done. Please fill in the End Date and Time first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction className="text-[14px] font-semibold h-10 px-5" onClick={() => setMarkDoneBlocking(null)}>
              OK
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Mark as Done — Soft Confirmation (missing Threads/Sacks/Markings/Tags) */}
      <AlertDialog
        open={!!markDoneSoftConfirm}
        onOpenChange={() => setMarkDoneSoftConfirm(null)}
      >
        <AlertDialogContent className="max-w-[480px]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[18px] font-bold">Missing Production Details</AlertDialogTitle>
            <AlertDialogDescription className="text-[14px] leading-relaxed">
              The following fields are empty:{" "}
              <strong>{markDoneSoftConfirm?.missingFields?.join(", ")}</strong>.
              Do you want to mark this order as done anyway?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-[14px] font-semibold h-10 px-5" onClick={() => setMarkDoneSoftConfirm(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-green-600 hover:bg-green-700 text-white text-[14px] font-semibold h-10 px-5"
              onClick={async () => {
                const { order } = markDoneSoftConfirm;
                setMarkDoneSoftConfirm(null);
                const now = new Date();
                const endDate = now.toISOString().split("T")[0];
                const endTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
                const ts = formatTimestamp();
                const doneHistory = [
                  ...(order.history || []),
                  {
                    timestamp: ts,
                    action: `Status changed: ${order.status || "plotted"} → completed`,
                    details: `End Date auto-set: ${ts}`,
                  },
                ];
                await updateOrderMutation.mutateAsync({
                  id: order.id,
                  data: {
                    status: "completed",
                    end_date: endDate,
                    end_time: endTime,
                    history: doneHistory,
                  },
                });
                toast.success("Order marked as completed");
              }}
            >
              Mark as Done
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AutoSequenceModal
        isOpen={autoSeqOpen}
        onClose={() => {
          setAutoSeqOpen(false);
          setAutoSeqResult(null);
        }}
        onApply={handleApplySequence}
        currentOrders={getAutoSequenceOrders()}
        result={autoSeqResult}
        loading={autoSeqLoading}
        feedmillName={FEEDMILL_LABELS[activeFeedmill] || activeFeedmill}
        lineName={activeSubSection === "all" ? "All Lines" : activeSubSection}
        inferredTargetMap={inferredTargetMap}
        changeoverRules={changeoverRules}
      />

      {showProcessingOverlay && (
        <AutoSequenceProcessingOverlay
          currentPhase={processingPhase}
          processedCount={processingStats.processed}
          totalCount={processingStats.total}
          combinedCount={processingStats.combined}
          movedCount={processingStats.moved}
          label={processingLabel}
          onCancel={handleCancelPlantSeq}
        />
      )}

      <PlantAutoSequenceModal
        isOpen={plantSeqOpen}
        onClose={() => {
          setPlantSeqOpen(false);
          setPlantSeqResults({});
          setPlantSeqSummary(null);
          setPlantSeqLog([]);
          setPlantSeqSnapshot({});
        }}
        onApply={handlePlantApply}
        onReanalyze={handlePlantLevelAutoSequence}
        onResetToOriginal={() => {
          setPlantSeqResults({ ...plantSeqSnapshot });
          setPlantSeqSummary(null);
          setPlantSeqLog([]);
        }}
        originalSnapshot={plantSeqSnapshot}
        sequencedResults={plantSeqResults}
        summaryStats={plantSeqSummary}
        placementLog={plantSeqLog}
        isLoading={plantSeqLoading}
        totalOrderCount={plantSeqOrderCount}
        preloadedAI={plantSeqPreloadedAI}
        preloadedStrategies={plantSeqPreloadedStrategies}
        changeoverRules={changeoverRules}
        inferredTargetMap={inferredTargetMap}
        masterData={kbRecords}
      />

      {/* Feedmill-level auto-sequence modal */}
      {showFeedmillSeqPreview && feedmillSeqData && (
        <FeedmillAutoSequenceModal
          data={feedmillSeqData}
          isLoading={false}
          changeoverRules={changeoverRules}
          onApply={handleFeedmillApply}
          onCancel={() => {
            setShowFeedmillSeqPreview(false);
            setFeedmillSeqData(null);
          }}
        />
      )}

      {showLineAutoSequencePreview && (
        <LineAutoSequenceModal
          data={lineAutoSequenceData}
          isLoading={lineSeqLoading}
          inferredTargetMap={inferredTargetMap}
          changeoverRules={changeoverRules}
          onApply={async (args) => {
            await handleLineApply(args);
          }}
          onCancel={() => {
            setShowLineAutoSequencePreview(false);
            setLineAutoSequenceData(null);
            setLineSeqLoading(false);
          }}
        />
      )}


      <AddOrderDialog
        isOpen={addOrderOpen}
        onClose={() => { setAddOrderOpen(false); setAddOrderPrefill(null); }}
        onAdd={handleAddOrder}
        kbRecords={kbRecords}
        currentOrders={enrichedOrders}
        defaultLine={addOrderLine}
        availableLines={FM_LINE_MAP_LOCAL[activeFeedmill] || ["Line 1", "Line 2", "Line 3", "Line 4", "Line 5", "Line 6", "Line 7"]}
        onSwitchLine={handleSwitchLine}
        prefillData={addOrderPrefill}
      />

      {SHOW_SMART_COMBINE_PANEL && (activeSection === "orders" || activeSection === "planned") && (
        <SmartCombinePanel
          orders={enrichedOrders}
          allOrders={enrichedOrders}
          activeFeedmill={activeFeedmill}
          activeSubSection={activeSubSection}
          kbRecords={kbRecords}
          onCombine={handleSmartCombine}
          newFprValues={newFprValues}
          inferredTargetMap={inferredTargetMap}
        />
      )}

      {/* AI Chatbot */}
      <AIChatbot orders={enrichedOrders} n10dRecords={activeN10DRecords} kbRecords={kbRecords} hidden={anyModalOpen} />

      {/* Guided Tour */}
      <TourGuide
        isMenuOpen={tourMenuOpen}
        onMenuClose={() => setTourMenuOpen(false)}
        currentPage={
          activeSection === "configurations"
            ? activeSubSection === "order_history"
              ? "orderHistory"
              : activeSubSection === "knowledge_base"
              ? "knowledgeBase"
              : activeSubSection === "next_10_days"
              ? "n10d"
              : "configurations"
            : activeSection
        }
        onNavigate={handleNavigate}
      />
    </div>
  );
}
