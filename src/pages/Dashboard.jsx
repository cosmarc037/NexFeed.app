import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles, XCircle, RotateCcw, ScanLine, Link2, Clock, ArrowRightLeft, CalendarDays, ListOrdered, Settings2, CheckCircle2, ChevronRight } from "lucide-react";
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
import DemandProfile from "../components/demand/DemandProfile";
import AIChatbot from "../components/chat/AIChatbot";
import SmartCombinePanel from "../components/orders/SmartCombinePanel";
import ExportButton from "../components/orders/ExportButton";
import ConfirmDialog from "../components/orders/ConfirmDialog";
import ReasonDialog from "../components/orders/ReasonDialog";
import ProduceAsIndependentDialog from "../components/orders/ProduceAsIndependentDialog";
import MinVolumeCheckDialog from "../components/orders/MinVolumeCheckDialog";
import PendingRevertDialog from "../components/orders/PendingRevertDialog";
import PlannedOrdersContent from "../components/orders/PlannedOrdersContent";
import { DivertOrderDialog, RevertOrderDialog, computeDivertInsertionPosition } from "../components/orders/DivertOrderDialog";
import OrderTable from "../components/orders/OrderTable";
import UncombineOrderDialog from "../components/orders/UncombineOrderDialog";
import AutoSequenceModal from "../components/orders/AutoSequenceModal";
import PlantAutoSequenceModal, { applyPreviewChangeovers } from "../components/orders/PlantAutoSequenceModal";
import LineAutoSequenceModal from "../components/orders/LineAutoSequenceModal";
import FeedmillAutoSequenceModal from "../components/orders/FeedmillAutoSequenceModal";
import KnowledgeBaseManager from "../components/orders/KnowledgeBaseManager";
import Next10DaysManager from "../components/orders/Next10DaysManager";
import ChangeoverRulesPage, { getDefaultChangeoverRules } from "./ChangeoverRulesPage";
import PowermixSplitRulesPage from "../components/orders/PowermixSplitRulesPage";
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
import { autoSequenceOrders, preSortOrders, buildInsightTemplates, callPlantActionsAI, buildPlantActionsPrompt, parsePlantActionsResponse, generateReorderPlacement, callPlantRebalanceAI } from "@/services/azureAI";
import { generateSequenceStrategies, PURE_AI_SEQUENCING } from "@/services/aiSequenceStrategies";
import { makePlantLevelCombineAndPlace } from "@/services/plantCombinePlace";
import { buildRebalancePrompt, parseRebalanceResponse, applyDiversions } from "@/services/plantRebalanceAI";
import { setTemplateInsights, hasInsights, getInsight } from "@/utils/insightCache";
import { getProductStatus } from "@/utils/statusUtils";
import { lineHoursBreakdown, rebuildSummaryAfterFields } from "@/utils/lineHours";

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
    start_date_manual: false,
    start_time_manual: false,
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

// ── Fulfillment (Demo) helpers (isolated to the demo workspace) ───────────
const _demoParseDaily = (rec) => {
  if (!rec || !rec.daily_values) return [];
  try {
    const dv =
      typeof rec.daily_values === "string"
        ? JSON.parse(rec.daily_values)
        : rec.daily_values;
    return Array.isArray(dv) ? dv : [];
  } catch {
    return [];
  }
};
// AvgDaily = mean of the day 1–10 demand values for a material.
const _demoAvgDaily = (rec) => {
  const dv = _demoParseDaily(rec).slice(0, 10);
  if (!dv.length) return 0;
  return dv.reduce((acc, d) => acc + (Number(d.value) || 0), 0) / dv.length;
};
// Velocity = demand-stability class derived from the coefficient of variation
// (std ÷ mean) of a material's day 1–10 demand. Mirrors the classification
// shown in Next10DaysManager so AI sequencing and the Future Dispatches table
// agree. Returns 'Stable' | 'Less Stable' | 'Erratic' | null (no demand data).
const _classifyVelocity = (rec) => {
  const dv = _demoParseDaily(rec).slice(0, 10);
  const vals = dv.map((d) => Number(d.value) || 0);
  const n = vals.length;
  if (n === 0) return null;
  const mean = vals.reduce((s, v) => s + v, 0) / n;
  const std =
    n > 1 ? Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / n) : 0;
  const cv = mean > 0.001 ? std / mean : std > 0 ? 999 : 0;
  return cv <= 0.5 ? "Stable" : cv <= 1.0 ? "Less Stable" : "Erratic";
};
const _demoMatKey = (rec) =>
  String(rec.material_code || rec.material_code_fg || "").trim();
const _demoOrderMatKey = (o) =>
  String(o.material_code || o.material_code_fg || "").trim();
const _demoEffVol = (o) => {
  const ov = Number(o.volume_override);
  if (!isNaN(ov) && o.volume_override != null && o.volume_override !== "")
    return ov;
  // Mirror getSuggestedVolume from OrderTable: round up to nearest batch multiple
  const orig = Number(o.total_volume_mt) || 0;
  const bs = parseFloat(o.batch_size) || 4;
  if (bs <= 0) return orig;
  return Math.ceil(orig / bs) * bs;
};

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
        let addInfo = { total: 0, breakdown: [], usedBaseOnly: true };
        if (nextAny) addInfo = calculateAdditionalChangeover(o, nextAny, rules);
        const base = parseFloat(o.changeover_time ?? 0.17);
        // New model: base is only used when no cleaning/die fires
        const total = nextAny
          ? (addInfo.usedBaseOnly ? base : addInfo.total)
          : 0;
        enriched.push({
          ...o,
          _changeoverBase: base,
          _changeoverAdditional: addInfo.total,
          _changeoverTotal: total,
          _changeoverUsedBaseOnly: addInfo.usedBaseOnly,
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

    let additionalInfo = { total: 0, breakdown: [], usedBaseOnly: true };
    if (next) {
      additionalInfo = calculateAdditionalChangeover(o, next, rules);
    }

    const baseChangeover = parseFloat(o.changeover_time ?? 0.17);
    // New model: base is only used when no cleaning/die fires.
    // Last active order (no following active order): zero changeover.
    const changeoverTotal = next
      ? (additionalInfo.usedBaseOnly ? baseChangeover : additionalInfo.total)
      : 0;

    enriched.push({
      ...o,
      _changeoverBase: baseChangeover,
      _changeoverAdditional: additionalInfo.total,
      _changeoverTotal: changeoverTotal,
      _changeoverUsedBaseOnly: additionalInfo.usedBaseOnly,
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
        // If this start is at or before the previous order's completion the date
        // is stale/invalid.  Flag it so Dashboard can auto-shift it forward.
        if (prevCompletion && startDate <= prevCompletion) {
          const shifted = new Date(prevCompletion);
          shifted.setDate(shifted.getDate() + 1);
          const sy = shifted.getFullYear();
          const sm = String(shifted.getMonth() + 1).padStart(2, "0");
          const sd2 = String(shifted.getDate()).padStart(2, "0");
          if (!computedMap[o.id]) computedMap[o.id] = {};
          computedMap[o.id]._needsStartDateShift = `${sy}-${sm}-${sd2}`;
        }
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
  { key: 'scanning',    label: 'Scanning orders across all lines',                  icon: ScanLine },
  { key: 'combining',   label: 'Finding and combining matching orders',              icon: Link2 },
  { key: 'calculating', label: 'Calculating queue times per line',                  icon: Clock },
  { key: 'placing',     label: 'Placing orders on optimal lines',                   icon: ArrowRightLeft },
  { key: 'n10d',        label: 'Applying Future Dispatches target dates',           icon: CalendarDays },
  { key: 'sequencing',  label: 'Sequencing orders per line',                        icon: ListOrdered },
  { key: 'changeovers',  label: 'Calculating changeovers',                                    icon: Settings2 },
  { key: 'rebalancing', label: 'AI plant-wide load rebalance',                   icon: RotateCcw },
  { key: 'strategies',  label: 'Generating strategy options per line (AI-powered)',           icon: Sparkles },
  { key: 'done',        label: 'Complete',                                          icon: CheckCircle2 },
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
            const Icon = phase.icon;
            return (
              <div
                key={phase.key}
                className={`as-processing-phase${isComplete ? ' complete' : ''}${isCurrent ? ' current' : ''}${isPending ? ' pending' : ''}`}
              >
                <span className="as-processing-phase-icon">
                  <Icon size={17} strokeWidth={1.75} />
                </span>
                <span className="as-processing-phase-label">{phase.label}</span>
                {isCurrent  && <span className="as-processing-phase-spinner" />}
                {isPending  && <ChevronRight size={13} className="as-processing-phase-chevron" />}
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
  // Always-current ref so navigation handler never reads a stale activeFeedmill value
  const activeFeedmillRef = React.useRef("ALL_FM");
  activeFeedmillRef.current = activeFeedmill;

  // ── Fulfillment (Demo) workspace: demo-aware data source ──────────────────
  // When the user is inside the demo section every order / Next-10-Days read and
  // write targets the isolated Demo* entities & tables. This lets ALL existing
  // handlers (combine, uncombine, cut/merge, Powermix split, auto-sequence,
  // status changes, reorder, edits) operate on demo data for free — never
  // touching live data.
  const isDemo = activeSection === "fulfillment_demo";
  // eslint-disable-next-line no-shadow
  const Order = isDemo ? base44.entities.DemoOrder : base44.entities.Order;
  const N10DRecordEntity = isDemo
    ? base44.entities.DemoNext10DaysRecord
    : base44.entities.Next10DaysRecord;
  const N10DUploadEntity = isDemo
    ? base44.entities.DemoNext10DaysUpload
    : base44.entities.Next10DaysUpload;
  const ORDERS_QK = isDemo ? "demo_orders" : "orders";
  const N10D_RECORDS_QK = isDemo ? "demo_n10d_records" : "n10d_records";
  const N10D_UPLOADS_QK = isDemo ? "demo_n10d_uploads" : "n10d_uploads";
  const [demoSeeded, setDemoSeeded] = useState(false);
  const [demoSeeding, setDemoSeeding] = useState(false);
  const [demoSeedError, setDemoSeedError] = useState(null);
  const [demoSeedNonce, setDemoSeedNonce] = useState(0);
  const [demoLineTab, setDemoLineTab] = useState("all");
  const [demoDismissedPreorders, setDemoDismissedPreorders] = useState(
    () => new Set(),
  );

  // One-time seed when the user enters the demo (idempotent on the server).
  useEffect(() => {
    if (!isDemo || demoSeeded) return;
    let cancelled = false;
    setDemoSeeding(true);
    setDemoSeedError(null);
    (async () => {
      try {
        console.log("[Fulfillment Demo Workspace] Seeding demo data…");
        const res = await fetch("/api/demo/seed", { method: "POST" });
        if (!res.ok) throw new Error(`seed failed: ${res.status}`);
        await res.json().catch(() => ({}));
        console.log("[Fulfillment Demo Workspace] Seed complete");
        if (!cancelled) {
          // Only mark ready on a successful seed so a failed seed never shows
          // an apparently-ready-but-empty demo. Failure keeps the loading state
          // and retries on the next render/visit.
          setDemoSeeded(true);
          setDemoSeedError(null);
          queryClient.invalidateQueries({ queryKey: ["demo_orders"] });
          queryClient.invalidateQueries({ queryKey: ["demo_n10d_records"] });
          queryClient.invalidateQueries({ queryKey: ["demo_n10d_uploads"] });
        }
      } catch (e) {
        console.error("[Fulfillment Demo Workspace] Seed error", e);
        if (!cancelled) setDemoSeedError(e.message || "Seed failed");
      } finally {
        if (!cancelled) setDemoSeeding(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isDemo, demoSeeded, demoSeedNonce, queryClient]);

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
  // null  = Stage 5.5 has not run yet (initial / after reset)
  // []    = Stage 5.5 ran and found no diversions needed
  // [...] = Stage 5.5 ran and applied N diversions
  const [rebalanceDiversions, setRebalanceDiversions] = useState(null);
  const [plantSeqSnapshot, setPlantSeqSnapshot] = useState({});
  const [showProcessingOverlay, setShowProcessingOverlay] = useState(false);
  const [processingPhase, setProcessingPhase] = useState(null);
  const [processingStats, setProcessingStats] = useState({ processed: 0, total: 0, combined: 0, moved: 0 });
  const [processingLabel, setProcessingLabel] = useState('');
  const plantSeqCancelledRef = useRef(false);
  const plantSeqAbortRef = useRef(null);
  const plantSeqRunIdRef = useRef(0);
  // Dedup tracker for field-edit history — prevents double-writes from debounce+blur patterns
  const _recentFieldHistoryRef = React.useRef({});
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

  const [shutdownHistory, setShutdownHistory] = useState(() => {
    try {
      const saved = localStorage.getItem('nexfeed_shutdown_history');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  useEffect(() => {
    try { localStorage.setItem('nexfeed_line_shutdowns', JSON.stringify(lineShutdowns)); } catch { /* ignore */ }
  }, [lineShutdowns]);

  useEffect(() => {
    try { localStorage.setItem('nexfeed_shutdown_history', JSON.stringify(shutdownHistory)); } catch { /* ignore */ }
  }, [shutdownHistory]);

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
  const [mashShutdownDivertDialog, setMashShutdownDivertDialog] = useState(null); // { order, shutdownLine }
  const [revertDialog, setRevertDialog] = useState(null); // { order }
  const [inProdConflictDialog, setInProdConflictDialog] = useState(null); // { order, newStatus, existing }
  const [inProdOrderingDialog, setInProdOrderingDialog] = useState(null); // { order, newStatus, blocker, blockerPrio }

  // Fetch orders
  const { data: orders = [], isLoading } = useQuery({
    queryKey: [ORDERS_QK],
    queryFn: () => Order.list("-created_date"),
    enabled: !isDemo || demoSeeded,
  });

  // Fetch Powermix Split rules — used to override batch_size for Line 5 orders
  const { data: pmxSplitRules = [] } = useQuery({
    queryKey: ["powermix_split_rules"],
    queryFn: async () => {
      const res = await fetch('/api/powermix-split-rules');
      if (!res.ok) return [];
      return await res.json();
    },
    staleTime: 60000,
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
    queryKey: [N10D_UPLOADS_QK],
    queryFn: () => N10DUploadEntity.list("-created_date", 1),
    enabled: !isDemo || demoSeeded,
    staleTime: 0,
  });
  const { data: allN10DRecords = [] } = useQuery({
    queryKey: [N10D_RECORDS_QK],
    queryFn: () => N10DRecordEntity.list("-created_date", 2000),
    enabled: !isDemo || demoSeeded,
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
          velocity: _classifyVelocity(rec),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [ORDERS_QK] }),
  });

  const updateOrderMutation = useMutation({
    mutationFn: ({ id, data }) => Order.update(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [ORDERS_QK] }),
  });

  // Batch update — used exclusively by cascadeSchedule so N cascade saves
  // become a single round-trip with a single invalidation.
  const batchUpdateOrderMutation = useMutation({
    mutationFn: (updates) => Order.batchUpdate(updates),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [ORDERS_QK] }),
  });

  const bulkCreateMutation = useMutation({
    mutationFn: (data) => Order.bulkCreate(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [ORDERS_QK] }),
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

  // Build a fg_code → rule map for Powermix Split batch_size overrides
  const pmxSplitBatchMap = useMemo(() => {
    const m = {};
    for (const r of pmxSplitRules) {
      if (r.fg_code) m[String(r.fg_code).trim()] = r;
    }
    return m;
  }, [pmxSplitRules]);

  const enrichedOrders = useMemo(() => {
    let result = orders;
    if (kbRecords.length) {
      // Primary map: fg_material_code → KB row (used by normal / source orders)
      const kbMap = {};
      // Secondary map: sfg1_material_code → KB row (used by auto-generated split orders)
      const kbSfg1Map = {};
      for (const r of kbRecords) {
        if (r.fg_material_code) kbMap[String(r.fg_material_code).trim()] = r;
        if (r.sfg1_material_code) kbSfg1Map[String(r.sfg1_material_code).trim()] = r;
      }
      result = orders.map((order) => {
        const fgKey = String(order.material_code || "").trim();
        const pmxRule = pmxSplitBatchMap[fgKey];

        const _isPowermixGeneratedOrder =
          order.is_powermix_generated === true || order.is_powermix_generated === 'true';

        // Normal / source orders: material_code (FG) → fg_material_code in KB
        // Auto-generated split orders: kb_sfg_material_code (SFG) → sfg1_material_code in KB
        const ownEntry = _isPowermixGeneratedOrder
          ? kbSfg1Map[String(order.kb_sfg_material_code || "").trim()]
          : kbMap[fgKey];

        // Combined lead inheritance: a lead created over Powermix-generated
        // children has no material_code or kb_sfg_material_code of its own
        // (those live on the children).  Inherit the KB row from the first
        // generated child so category/color/diameter, batch_size, run_rate
        // etc. all populate on the lead.  Also resolve the true FG code via
        // that child's powermix_source_order_id for the insight lookup.
        const _isLead =
          !order.parent_id &&
          Array.isArray(order.original_order_ids) &&
          order.original_order_ids.length > 0;
        let _resolvedFgCode = fgKey || null;
        let inheritedEntry = null;
        if (!ownEntry && !_isPowermixGeneratedOrder && _isLead) {
          const genChild = orders.find(
            (o) =>
              String(o.parent_id) === String(order.id) &&
              (o.is_powermix_generated === true ||
                o.is_powermix_generated === "true"),
          );
          if (genChild) {
            const childSfgKey = String(
              genChild.kb_sfg_material_code || "",
            ).trim();
            if (childSfgKey) inheritedEntry = kbSfg1Map[childSfgKey];
            const srcOrder = genChild.powermix_source_order_id
              ? orders.find(
                  (o) =>
                    String(o.id) === String(genChild.powermix_source_order_id),
                )
              : null;
            if (srcOrder?.material_code)
              _resolvedFgCode = String(srcOrder.material_code).trim();
          }
        }
        const entry = ownEntry || inheritedEntry;

        // Computed flag: this order is a Powermix split source order and must stay on its line.
        // Covers Line 5 (all, since the whole line is Powermix) and Line 7 orders whose FG code
        // matches an active rule with source_line = 'Line 7'.
        const _orderIsLine5 = order.feedmill_line === 'Line 5' || order.feedmill_line === 'line_5';
        const _orderIsLine7 = order.feedmill_line === 'Line 7' || order.feedmill_line === 'line_7';
        const _pmxRuleIsLine7 = pmxRule && (pmxRule.source_line === 'Line 7' || pmxRule.source_line === 'line_7');
        const _isPowermixSourceOrder =
          !!pmxRule &&
          !_isPowermixGeneratedOrder &&
          (_orderIsLine5 || (_orderIsLine7 && _pmxRuleIsLine7));

        // Powermix Split batch_size takes precedence for:
        //   (a) Line 5 / Line 7 source orders whose FG is covered by a Powermix Split rule
        //   (b) Generated split orders (identified by is_powermix_generated or powermix_split_subtext)
        const isPmxSplitOrder =
          pmxRule &&
          (_isPowermixSourceOrder ||
           !!order.is_powermix_generated ||
           !!order.powermix_split_subtext);
        const pmxSplitBatchSize = isPmxSplitOrder ? parseFloat(pmxRule.batch_size) : null;

        if (!entry) {
          // No KB entry — still apply Powermix Split batch_size if applicable
          return pmxSplitBatchSize != null
            ? { ...order, batch_size: pmxSplitBatchSize, _isPowermixSourceOrder, _resolvedFgCode }
            : { ...order, _isPowermixSourceOrder, _resolvedFgCode };
        }
        const bsKey = BATCH_SIZE_COL[order.feedmill_line];
        const rrKey = RUN_RATE_COL[order.feedmill_line];
        const l1 = entry.label_1 || "";
        const l2 = entry.label_2 || "";
        const markings = l1 && l2 ? `${l1} | ${l2}` : l1 || l2 || "";

        const kbBatchSize =
          bsKey && entry[bsKey] != null && entry[bsKey] !== ""
            ? entry[bsKey]
            : order.batch_size;

        // For Powermix-generated orders, SFG material code comes from the rule's
        // sfg1_material_code (not the KB's sfg1_material_code which represents the
        // source order's SFG).
        const resolvedKbSfgMaterialCode = _isPowermixGeneratedOrder && pmxRule
          ? String(pmxRule.sfg1_material_code || pmxRule.sfg_material_code || order.kb_sfg_material_code || "")
          : (entry.sfg1_material_code ? String(entry.sfg1_material_code) : "");

        const resolvedRunRate =
          rrKey && entry[rrKey] != null && entry[rrKey] !== ""
            ? entry[rrKey]
            : order.run_rate;

        // Recalculate production_hours when the stored value is missing but we
        // now have a valid run_rate from the KB (common for generated orders whose
        // run_rate was null at server-side generation time).
        const resolvedForm = entry.form || order.form || "";
        let resolvedProductionHours = order.production_hours;
        if (
          !order.production_hours_manual &&
          (resolvedProductionHours == null || resolvedProductionHours === 0) &&
          resolvedForm !== "M"
        ) {
          const rr = parseFloat(resolvedRunRate);
          const vol = getEffVolume({ ...order, form: resolvedForm });
          if (rr > 0 && vol > 0) {
            resolvedProductionHours = parseFloat((vol / rr).toFixed(2));
          }
        }

        return {
          ...order,
          form: resolvedForm,
          kb_sfg_material_code: resolvedKbSfgMaterialCode,
          // Powermix Split batch_size wins over KB Master Data for applicable orders
          batch_size: pmxSplitBatchSize != null ? pmxSplitBatchSize : kbBatchSize,
          run_rate: resolvedRunRate,
          production_hours: resolvedProductionHours,
          // For generated orders the entry is already the SFG KB row, so
          // changeover_time, color, diameter and category all come from SFG data.
          changeover_time: (() => {
            const co = parseFloat(entry.changeover);
            return Number.isFinite(co) ? co : (order.changeover_time ?? 0.17);
          })(),
          threads: entry.thread || order.threads || "",
          sacks: entry.sacks_item_description || order.sacks || "",
          tags: entry.tags_item_description || order.tags || "",
          markings: markings || order.markings || "",
          category: entry.category || order.category || "",
          color: entry.color || order.color || "",
          diameter: entry.diameter || order.diameter || null,
          _isPowermixSourceOrder,
          _resolvedFgCode,
        };
      });
    }

    // ── Keep Line 5 (Powermix) ordered by Avail Date ───────────────────────
    // Powermix (Line 5) sequence is driven by source-order relationships, not
    // by need-by dates, so its stored priority_seq can fall out of
    // chronological order while every other line stays aligned. Per user
    // preference, re-order Line 5's planned rows by ascending Avail Date so the
    // display order, cascade dates, and conflict detection all stay consistent
    // — matching every other line and the AI auto-sequence preview.
    //
    // Only the *planned* lead rows are permuted, and only among the priority_seq
    // slots they already occupy. Frozen rows (in production / done / cancelled)
    // keep their slots, and combined sub-orders (parent_id set) are left
    // untouched so their volume is never injected into the cascade. The stored
    // DB value is not written; this only drives ordering for enrichedOrders.
    {
      const _isLine5 = (o) => {
        const s = String(o.feedmill_line || "")
          .trim()
          .toLowerCase()
          .replace(/[\s_-]+/g, "");
        return s === "line5" || s === "l5";
      };
      // Mirror the auto-sequence exclusion set: rows that are running / done /
      // cancelled are not re-orderable and must keep their existing slot. Cover
      // both machine values and any legacy display-label statuses.
      const FROZEN = new Set([
        "completed",
        "cancel_po",
        "in_production",
        "ongoing_batching",
        "ongoing_pelleting",
        "ongoing_bagging",
        "In Production",
        "On-going",
        "Done",
        "Cancel PO",
      ]);
      const _availMs = (o) => {
        const d = o.target_avail_date || o.original_avail_date;
        if (!isAvailDateValidMemo(d)) return Infinity;
        const t = Date.parse(d);
        return Number.isNaN(t) ? Infinity : t;
      };
      const plannedLeads = result.filter(
        (o) =>
          _isLine5(o) &&
          o.parent_id == null &&
          !FROZEN.has(o.status) &&
          o.priority_seq != null,
      );
      if (plannedLeads.length > 1) {
        // The existing priority_seq slots these planned leads occupy.
        const slots = plannedLeads
          .map((o) => o.priority_seq)
          .sort((a, b) => a - b);
        // Sort the same leads by ascending Avail Date (existing priority_seq as
        // a stable tiebreaker for equal / blank dates) and re-fill the slots.
        const byAvail = [...plannedLeads].sort((a, b) => {
          const am = _availMs(a);
          const bm = _availMs(b);
          if (am !== bm) return am - bm;
          return a.priority_seq - b.priority_seq;
        });
        const seqById = new Map();
        byAvail.forEach((o, i) => seqById.set(String(o.id), slots[i]));
        result = result.map((o) =>
          seqById.has(String(o.id))
            ? { ...o, priority_seq: seqById.get(String(o.id)) }
            : o,
        );
      }
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
  }, [orders, kbRecords, pmxSplitBatchMap]);

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

  // ── Fulfillment (Demo): Adjusted Inventory map ────────────────────────────
  // Adjusted Inventory = Inventory − satisfied order volume + AvgDaily(day 1–10).
  // Computed FIRST so demoPreorderSuggestions can use it as the eligibility
  // baseline instead of raw inventory.
  const demoAdjustedInventoryMap = useMemo(() => {
    if (!isDemo) return {};
    const satisfiedByMat = {};
    for (const o of scheduledOrders) {
      if (o.parent_id) continue;
      if (!o.fulfilled_from_inventory) continue;
      const key = _demoOrderMatKey(o);
      if (!key) continue;
      const satVol =
        o.preorder_satisfied_volume != null &&
        o.preorder_satisfied_volume !== ""
          ? Number(o.preorder_satisfied_volume) || 0
          : _demoEffVol(o);
      satisfiedByMat[key] = (satisfiedByMat[key] || 0) + satVol;
    }
    const map = {};
    for (const rec of activeN10DRecords) {
      const key = _demoMatKey(rec);
      if (!key) continue;
      const inventory = Number(rec.inventory) || 0;
      const satisfied = satisfiedByMat[key] || 0;
      const avgDaily = _demoAvgDaily(rec);
      map[key] = {
        value: inventory - satisfied + avgDaily,
        inventory,
        satisfied,
        avgDaily,
      };
    }
    return map;
  }, [isDemo, scheduledOrders, activeN10DRecords]);

  // ── Fulfillment (Demo): fulfillment-from-inventory detection ──────────────
  // An active order whose material has ADJUSTED on-hand inventory ≥ its volume
  // is a candidate to be fulfilled from stock. We use adjusted inventory (not
  // raw) so that previously-approved fulfillments reduce the available pool.
  // Within the iteration we also track per-material remaining balance so that
  // multiple pending suggestions for the same product don't overcommit the
  // same stock.
  const demoPreorderSuggestions = useMemo(() => {
    if (!isDemo) return [];

    // Build material → { inventory, rec } lookup from N10D records
    const invByMat = {};
    for (const rec of activeN10DRecords) {
      const k = _demoMatKey(rec);
      if (k && !(k in invByMat))
        invByMat[k] = { inventory: Number(rec.inventory) || 0, rec };
    }

    // Seed "remaining" from adjusted inventory (already deducts DB-approved
    // fulfillments). Fall back to raw inventory for materials not in the map.
    const remaining = {};
    for (const [k, adj] of Object.entries(demoAdjustedInventoryMap)) {
      remaining[k] = adj.value;
    }
    for (const [k, inv] of Object.entries(invByMat)) {
      if (!(k in remaining)) remaining[k] = inv.inventory;
    }

    const out = [];
    const checkedIds = [];
    const invalidatedIds = [];

    for (const o of scheduledOrders) {
      if (o.status === "completed" || o.status === "cancel_po") continue;
      if (o.parent_id) continue;
      if (o.is_preorder) continue;
      if (o.fulfilled_from_inventory) continue;
      if (demoDismissedPreorders.has(`${o.id}`)) continue;
      const key = _demoOrderMatKey(o);
      if (!key) continue;
      const inv = invByMat[key];
      if (!inv) continue;
      const vol = _demoEffVol(o);
      if (vol <= 0) continue;

      const rawInventory = inv.inventory;
      const adjustedInventory = remaining[key] ?? 0;
      const canStillBeSatisfied = adjustedInventory >= vol;
      checkedIds.push(o.id);

      console.debug("[Fulfillment Demo Adjusted Inventory Eligibility]", {
        product: key,
        rawInventory,
        adjustedInventory,
        orderId: o.id,
        orderVolume: vol,
        canStillBeSatisfied,
      });

      if (canStillBeSatisfied) {
        // NOTE: AI Avail Date is no longer copied from the source order's
        // target/original avail date. It is generated by AI from the live line
        // lineup (see aiReorderPlacements effect below) and merged in via
        // demoPreorderSuggestionsWithAI. Source dates are AI inputs only.
        console.debug("[Demo AI-Suggested Avail Date Refresh]", {
          suggestionId: o.id,
          triggeredBy:
            "demoPreorderSuggestions recompute (scheduledOrders | demoAdjustedInventoryMap)",
          adjustedInventory,
          suggestionStillValid: true,
          aiAvailDateSource: "ai_generated (deferred to placement effect)",
        });
        out.push({
          order: o,
          materialCode: key,
          inventory: adjustedInventory,
          volume: vol,
          avgDaily: _demoAvgDaily(inv.rec),
          // Source-order dates kept as AI inputs/context only — never displayed.
          sourceTargetAvailDate: o.target_avail_date || null,
          sourceOriginalAvailDate: o.original_avail_date || null,
        });
        // Consume from the running balance so later orders of the same
        // product are evaluated against the reduced remaining stock.
        remaining[key] = adjustedInventory - vol;
      } else {
        console.debug("[Demo AI-Suggested Avail Date Refresh]", {
          suggestionId: o.id,
          triggeredBy:
            "demoPreorderSuggestions recompute (scheduledOrders | demoAdjustedInventoryMap)",
          adjustedInventory,
          suggestionStillValid: false,
          recomputedAiSuggestedAvailDate: null,
        });
        invalidatedIds.push(o.id);
      }
    }

    console.debug("[Fulfillment Demo Suggestion Recalculation]", {
      product: "all",
      suggestionIdsChecked: checkedIds,
      invalidatedSuggestions: invalidatedIds,
      refreshedAfterApproval: true,
    });

    if (out.length) {
      console.log(
        "[Fulfillment Demo Detection] fulfillable-from-inventory candidates:",
        out.map((s) => ({
          id: s.order.id,
          material: s.materialCode,
          inventory: s.inventory,
          volume: s.volume,
        })),
      );
    }
    return out;
  }, [isDemo, scheduledOrders, activeN10DRecords, demoDismissedPreorders, demoAdjustedInventoryMap]);

  // ── Fulfillment (Demo): AI re-order placement (date + insertion position) ──
  // The AI Avail Date and insertion position are GENERATED by Azure OpenAI from
  // the live line lineup — not copied from the source order. Results are cached
  // and kept STABLE; they only regenerate when the relevant line lineup actually
  // changes (new order, approve/cancel re-order, drag/drop, auto-sequence, or any
  // sequence-affecting edit) — never on every render.

  // Build the active lineup for a re-order's target line (excludes the source
  // order being fulfilled). Used identically for AI generation and for applying
  // the reviewed placement, so what's shown always matches what's inserted.
  const buildDemoLineup = useCallback(
    (lineName, excludeOrderId) =>
      orders
        .filter(
          (o) =>
            (o.feedmill_line || "") === (lineName || "") &&
            o.id !== excludeOrderId &&
            !o.parent_id &&
            !["completed", "cancel_po"].includes(
              String(o.status || "").toLowerCase(),
            ),
        )
        .sort(
          (a, b) =>
            (Number(a.priority_seq) || 9999) - (Number(b.priority_seq) || 9999),
        )
        .map((o) => ({
          id: o.id,
          fpr: o.fpr,
          item_description: o.item_description,
          volume: Number(o.volume_override ?? o.total_volume_mt) || 0,
          production_hours: o.production_hours,
          changeover_time: o.changeover_time,
          target_avail_date: o.target_avail_date,
          avail_date: o.avail_date,
          start_date: o.start_date,
          target_completion_date: o.target_completion_date,
          priority_seq: o.priority_seq,
        })),
    [orders],
  );

  // Signature of the inputs that should trigger a re-generation for a suggestion.
  // Includes the source order's own avail date and priority_seq so that any change
  // to the source order (re-sequence, avail date edit) forces a fresh AI call and
  // prevents a stale cached aiAvailDate from showing an earlier date than the source.
  const demoLineupSignature = useCallback(
    (lineName, excludeOrderId, volumeToProduce) => {
      const lineup = buildDemoLineup(lineName, excludeOrderId);
      const srcOrder = orders.find((o) => o.id === excludeOrderId);
      const srcSig = srcOrder
        ? `src:${srcOrder.priority_seq ?? 0}:${srcOrder.target_avail_date || ""}`
        : "src:unknown";
      const lineSig = lineup
        .map(
          (o) =>
            `${o.id}:${o.priority_seq}:${o.volume}:${o.target_avail_date || ""}:${o.start_date || ""}:${o.target_completion_date || ""}`,
        )
        .join("|");
      return `${lineName}#vtp:${volumeToProduce}#${srcSig}#${lineSig}`;
    },
    [buildDemoLineup, orders],
  );

  const [aiReorderPlacements, setAiReorderPlacements] = useState({});
  const aiReorderInFlightRef = useRef({});

  useEffect(() => {
    if (!isDemo) return;
    if (!demoPreorderSuggestions.length) return;

    demoPreorderSuggestions.forEach((s) => {
      const o = s.order;
      const raw = orders.find((x) => x.id === o.id) || o;
      const lineName = raw.feedmill_line || "";
      const batchSz = parseFloat(raw.batch_size) || 0;
      const rawVtp = s.avgDaily > 0 ? s.avgDaily : s.volume;
      const volumeToProduce =
        batchSz > 0
          ? Math.ceil(rawVtp / batchSz) * batchSz
          : Math.round(rawVtp);

      const sig = demoLineupSignature(lineName, o.id, volumeToProduce);
      const existing = aiReorderPlacements[o.id];
      // Stable: skip if we already ATTEMPTED this exact signature — whether it
      // succeeded OR errored. Errors are NOT auto-retried; a fresh attempt only
      // happens when the lineup signature changes. Prevents request storms /
      // re-generation loops on persistent AI failures.
      if (existing && existing.signature === sig) return;
      // Avoid duplicate in-flight requests for the same signature.
      if (aiReorderInFlightRef.current[o.id] === sig) return;
      aiReorderInFlightRef.current[o.id] = sig;

      const runRate = parseFloat(raw.run_rate) || null;
      const productionHours =
        runRate && volumeToProduce
          ? parseFloat((volumeToProduce / runRate).toFixed(2))
          : raw.production_hours ?? null;

      setAiReorderPlacements((prev) => ({
        ...prev,
        [o.id]: { ...(prev[o.id] || {}), signature: sig, loading: true, error: null },
      }));

      const reorderPayload = {
        item_description: raw.item_description,
        fpr: raw.fpr,
        feedmill_line: lineName,
        volumeToProduce,
        total_volume_mt: volumeToProduce,
        batch_size: raw.batch_size,
        run_rate: runRate,
        production_hours: productionHours,
        changeover_time: raw.changeover_time,
        form: raw.form,
        sourceTargetAvailDate: s.sourceTargetAvailDate,
        sourceOriginalAvailDate: s.sourceOriginalAvailDate,
        // Source-order priority_seq so the AI constrains insertPosition to AFTER
        // the source order and our code-side guard can enforce the same rule.
        sourcePrioritySeq: raw.priority_seq ?? null,
      };
      const lineup = buildDemoLineup(lineName, o.id);

      generateReorderPlacement(reorderPayload, lineup, {
        today: new Date().toISOString().slice(0, 10),
        lineName,
      })
        .then((result) => {
          console.debug("[Demo Re-Order AI Avail Date Generation]", {
            suggestionId: o.id,
            sourceTargetAvailDate: s.sourceTargetAvailDate,
            sourceOriginalAvailDate: s.sourceOriginalAvailDate,
            usedAsInputOnly: true,
            aiGeneratedAvailDate: result?.aiAvailDate ?? null,
            aiGeneratedInsertionPosition: result?.insertPosition ?? null,
            consideredFactors: [
              "current_lineup",
              "changeovers",
              "sequence_position",
              "downstream_delay_risk",
            ],
          });
          if (result && !result.error) {
            setAiReorderPlacements((prev) => ({
              ...prev,
              [o.id]: {
                signature: sig,
                loading: false,
                error: null,
                volumeToProduce,
                ...result,
              },
            }));
          } else {
            setAiReorderPlacements((prev) => ({
              ...prev,
              [o.id]: {
                signature: sig,
                loading: false,
                error: result?.error || "AI placement failed",
                volumeToProduce,
              },
            }));
          }
        })
        .catch((err) => {
          setAiReorderPlacements((prev) => ({
            ...prev,
            [o.id]: {
              signature: sig,
              loading: false,
              error: err?.message || "AI placement failed",
              volumeToProduce,
            },
          }));
        })
        .finally(() => {
          if (aiReorderInFlightRef.current[o.id] === sig)
            delete aiReorderInFlightRef.current[o.id];
        });
    });
  }, [
    isDemo,
    demoPreorderSuggestions,
    orders,
    buildDemoLineup,
    demoLineupSignature,
    aiReorderPlacements,
  ]);

  // Merge AI placements into the suggestions handed to the table/modal. The
  // displayed AI Avail Date comes ONLY from the AI result (null while loading).
  const demoPreorderSuggestionsWithAI = useMemo(
    () =>
      demoPreorderSuggestions.map((s) => {
        const p = aiReorderPlacements[s.order.id] || null;
        return {
          ...s,
          aiPlacement: p && !p.loading && !p.error ? p : null,
          aiLoading: !p || p.loading,
          aiError: p?.error || null,
          suggestedDate: p && !p.loading && !p.error ? p.aiAvailDate : null,
          // Live lineup for the approval modal's impact narrative (schedule context).
          lineup: buildDemoLineup(s.order.feedmill_line || "", s.order.id),
        };
      }),
    [demoPreorderSuggestions, aiReorderPlacements, buildDemoLineup],
  );

  const handleDemoApprovePreorder = async (suggestion, selectedLine = null, placement = null) => {
    const { order, volume, avgDaily } = suggestion;
    const raw = orders.find((o) => o.id === order.id) || order;
    // The re-order can be placed on a DIFFERENT production line than the source
    // order (the user evaluates lines in the modal). Everything downstream — the
    // lineup, insertion position, production time and the created order — is keyed
    // off the SELECTED line, falling back to the source line when none was chosen.
    const targetLineName = selectedLine?.line || raw.feedmill_line || "";
    const isSameLine = targetLineName === (raw.feedmill_line || "");
    // Run rate for the chosen line comes from Master Data (selectedLine.rate);
    // fall back to the source order's run rate when the line has no rate on record.
    const appliedRunRate =
      selectedLine && selectedLine.rate > 0
        ? selectedLine.rate
        : parseFloat(raw.run_rate) || null;
    console.debug("[Approve Re-Order Selected Line Apply]", {
      sourceLine: raw.feedmill_line || null,
      targetLine: targetLineName,
      crossLineInsert: !isSameLine,
      appliedRunRate,
      reviewedPlacementProvided: !!placement,
    });
    // Re-order volume is based on Average Daily (replenishment), not the source order volume
    const rawVolumeToProduce = avgDaily > 0 ? avgDaily : volume;
    // Adjust to nearest batch-compatible quantity (round up to nearest batch)
    const batchSz = parseFloat(raw.batch_size) || 0;
    const volumeToProduce =
      batchSz > 0
        ? Math.ceil(rawVolumeToProduce / batchSz) * batchSz
        : Math.round(rawVolumeToProduce);
    console.debug("[Demo Re-Order Rename Applied]", {
      oldLabel: "Pre-order",
      newLabel: "Re-order",
    });
    console.log("[Fulfillment Demo Decision] APPROVE re-order", {
      id: order.id,
      material: suggestion.materialCode,
      sourceOrderVolume: volume,
      volumeToProduce,
    });
    try {
      const inventoryBefore = suggestion.inventory;
      const inventoryAfter = inventoryBefore - volume;
      console.debug("[Demo Re-Order Volume Logic]", {
        sourceOrderId: order.id,
        sourceOrderVolume: volume,
        inventoryBeforeApproval: inventoryBefore,
        approvedUsingInventory: true,
        deductedFromInventoryVolume: volume,
        averageDaily: avgDaily,
        generatedReorderVolumeToProduce: volumeToProduce,
      });
      console.debug("[Demo Re-Order Production Time Basis]", {
        sourceOrderId: order.id,
        sourceOrderVolume: volume,
        reorderVolumeToProduce: volumeToProduce,
        productionTimeCalculatedFrom: "reorderVolumeToProduce",
      });
      console.debug("[Fulfillment Demo Inventory Consumption]", {
        product: suggestion.materialCode,
        approvedOrderId: order.id,
        consumedVolume: volume,
        inventoryBefore,
        inventoryAfter,
      });
      await Order.update(order.id, {
        fulfilled_from_inventory: true,
        preorder_satisfied_volume: volume,
      });

      const {
        id: _id,
        created_date: _cd,
        updated_date: _ud,
        ...clone
      } = raw;

      // ── Generate FPR using Philippine time (Asia/Manila) ──────────────────
      const _phDateStr = new Date().toLocaleDateString("en-CA", {
        timeZone: "Asia/Manila",
      }); // YYYY-MM-DD
      const phFpr =
        _phDateStr.slice(2, 4) +
        _phDateStr.slice(5, 7) +
        _phDateStr.slice(8, 10); // YYMMDD
      console.debug("[Demo Re-Order FPR Recheck]", {
        suggestionId: order.id,
        timezone: "Asia/Manila",
        currentPhDate: _phDateStr,
        generatedFpr: phFpr,
      });

      // ── Sequence insertion: place by AI-Suggested Avail Date ──────────────
      // Sort same-line active orders (excluding the source being fulfilled)
      // by priority_seq. Find where suggestedDate fits so the re-order lands
      // at the right position rather than always at the bottom.
      const suggestedDate = placement?.aiAvailDate || suggestion.suggestedDate || null;
      // Use the SAME lineup basis the AI placement + modal were computed from
      // (buildDemoLineup excludes sub-orders and completed/cancelled rows), so
      // the reviewed insertPosition maps to the exact same slot at apply time.
      // Keyed off the SELECTED line so cross-line inserts use that line's lineup.
      const lineOrders = buildDemoLineup(targetLineName, order.id);

      // Verify the lineup hasn't changed since the placement was reviewed in the
      // modal. If it has, the displayed placement may no longer be accurate.
      const currentSig = demoLineupSignature(
        targetLineName,
        order.id,
        volumeToProduce,
      );
      // When the modal passes a freshly-computed placement, its lineup snapshot is
      // current by construction, so don't fall back to the source-line pre-gen
      // signature (which would falsely flag a mismatch on cross-line picks).
      const reviewedSig = placement
        ? placement.signature || null
        : suggestion.aiPlacement?.signature || null;
      const appliedMatchesReviewed = !reviewedSig || reviewedSig === currentSig;

      // Apply the REVIEWED AI placement only — what was confirmed in the modal is
      // exactly what gets inserted. insertPosition is 1-based among lineOrders
      // (1 = before first order; lineOrders.length + 1 = at the very end).
      // Prefer the line-specific placement passed back from the modal.
      const aiPlacement = placement || suggestion.aiPlacement || null;
      const rawAiAvailDate = aiPlacement?.aiAvailDate || suggestedDate || null;
      // Hard floor: the re-order's avail date must never be earlier than the source
      // order's avail date. If the AI returned an earlier date (computed for the
      // wrong slot before the position was clamped), use the source date instead.
      const _srcAvailDate = raw.target_avail_date || raw.original_avail_date || null;
      const aiAvailDate = (() => {
        if (!rawAiAvailDate) return rawAiAvailDate;
        if (!_srcAvailDate || _srcAvailDate === 'stock_sufficient') return rawAiAvailDate;
        const _isISO = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
        if (_isISO(rawAiAvailDate) && _isISO(_srcAvailDate) && rawAiAvailDate < _srcAvailDate)
          return _srcAvailDate;
        return rawAiAvailDate;
      })();

      // ── Source-order dependency guard ──────────────────────────────────────
      // The re-order is replenishment and MUST be produced AFTER the source
      // order. Enforce this as a hard lower bound: targetSeq must always exceed
      // the source order's current priority_seq, regardless of what the AI
      // suggested (the AI also has this constraint but we guard here too).
      // The source-dependency only applies when the re-order is placed on the SAME
      // line as the source order. On a different line there is no such order to
      // sit after, so the constraint is lifted (effective source seq = 0).
      const sourceOrderPrioritySeq = isSameLine ? Number(raw.priority_seq) || 0 : 0;
      const minAllowedSeq = sourceOrderPrioritySeq + 1;

      let targetSeq;
      let ordersToShift;

      if (aiPlacement && lineOrders.length > 0) {
        // ── SINGLE SOURCE OF TRUTH ────────────────────────────────────────────
        // Apply the EXACT priority the user reviewed in the modal. azureAI already
        // folded the source-dependency clamp into targetPrioritySeq, so we commit
        // it VERBATIM here — no Math.max, no re-derivation from the slot. This is
        // what removes the +1 drift (modal said Prio 8 → it now inserts at Prio 8).
        const reviewedSeq = Number(aiPlacement.targetPrioritySeq);
        if (Number.isFinite(reviewedSeq) && reviewedSeq > 0) {
          targetSeq = reviewedSeq;
        } else {
          // Fallback for legacy placements that pre-date targetPrioritySeq: derive
          // from the reviewed slot, with the source-dependency clamp as a floor.
          const rawPos = Math.max(
            1,
            Math.min(lineOrders.length + 1, Number(aiPlacement.insertPosition) || lineOrders.length + 1),
          );
          const slotOrder = rawPos <= lineOrders.length ? lineOrders[rawPos - 1] : null;
          const lastLineOrder = lineOrders.length > 0 ? lineOrders[lineOrders.length - 1] : null;
          const aiTargetSeq = slotOrder
            ? (Number(slotOrder.priority_seq) || 0)
            : lastLineOrder
              ? (Number(lastLineOrder.priority_seq) + 1)
              : 1;
          targetSeq = Math.max(aiTargetSeq, minAllowedSeq);
        }

        // Defensive floor (safety net only): the re-order must never sit at or
        // before the source order. This is a NO-OP in the normal reviewed flow —
        // azureAI already folded this exact clamp into targetPrioritySeq, so the
        // modal===applied guarantee holds. It only engages if the reviewed value
        // is stale/invalid (e.g. the source order's priority moved after review),
        // in which case respecting the hard source-dependency wins over the stale
        // displayed value.
        if (targetSeq <= sourceOrderPrioritySeq) {
          targetSeq = sourceOrderPrioritySeq + 1;
        }

        // Shift every existing order at or after the committed priority down by 1.
        ordersToShift = lineOrders.filter(
          (lo) => (Number(lo.priority_seq) || 0) >= targetSeq,
        );

        const modalProposedPriority = aiPlacement.targetPrioritySeq ?? aiPlacement.insertPosition;
        console.debug("[Approve Re-Order Final Insert Consistency]", {
          suggestionId: order.id,
          selectedLine: targetLineName,
          modalRecommendedPriority: modalProposedPriority,
          finalInsertedPriority: targetSeq,
          exactMatch: modalProposedPriority === targetSeq,
        });
        console.debug("[Demo Re-Order Modal vs Final Insert]", {
          reorderId: "(pending — inserted next)",
          modalProposedPriority,
          impactAnalysisPriority: modalProposedPriority,
          finalInsertedPriority: targetSeq,
          exactMatch: modalProposedPriority === targetSeq,
        });
        console.debug("[Demo Re-Order Off-By-One Check]", {
          reorderId: "(pending — inserted next)",
          modalPriority: modalProposedPriority,
          finalInsertedPriority: targetSeq,
          priorityDrift: targetSeq - modalProposedPriority,
        });
        console.debug("[Demo Re-Order Insertion Source Of Truth]", {
          reorderId: "(pending — inserted next)",
          modalUsedSameInsertionSnapshotAsApply: appliedMatchesReviewed,
          recomputedAfterConfirm: false,
        });
        console.debug("[Demo Re-Order Source Dependency Check]", {
          reorderId: "(pending — inserted next)",
          sourceOrderId: order.id,
          sourceOrderPriority: sourceOrderPrioritySeq,
          proposedReorderPriority: targetSeq,
          validPlacement: targetSeq > sourceOrderPrioritySeq,
        });
        console.debug("[Demo Re-Order Placement Constraint]", {
          reorderId: "(pending — inserted next)",
          sourceOrderId: order.id,
          earliestAllowedPriorityAfterSource: minAllowedSeq,
          aiSuggestedPriority: aiPlacement.targetPrioritySeq ?? null,
          adjustedPriorityAfterConstraint: targetSeq,
        });
      } else {
        const maxSeq = lineOrders.reduce(
          (m, o) => Math.max(m, Number(o.priority_seq) || 0),
          0,
        );
        targetSeq = Math.max(maxSeq + 1, minAllowedSeq);
        ordersToShift = [];

        console.debug("[Demo Re-Order Source Dependency Check]", {
          reorderId: "(pending — inserted next)",
          sourceOrderId: order.id,
          sourceOrderPriority: sourceOrderPrioritySeq,
          proposedReorderPriority: maxSeq + 1,
          validPlacement: maxSeq + 1 > sourceOrderPrioritySeq,
        });
        console.debug("[Demo Re-Order Placement Constraint]", {
          reorderId: "(pending — inserted next)",
          sourceOrderId: order.id,
          earliestAllowedPriorityAfterSource: minAllowedSeq,
          aiSuggestedPriority: null,
          adjustedPriorityAfterConstraint: targetSeq,
        });
      }

      if (ordersToShift.length > 0) {
        await Promise.all(
          ordersToShift.map((lo) =>
            Order.update(lo.id, {
              priority_seq: (Number(lo.priority_seq) || 0) + 1,
            }),
          ),
        );
      }

      console.debug("[Demo Re-Order Final Insert]", {
        reorderId: "(pending — inserted next)",
        sourceOrderId: order.id,
        sourceOrderPriority: sourceOrderPrioritySeq,
        finalReorderPriority: targetSeq,
        insertedAfterSource: targetSeq > sourceOrderPrioritySeq,
      });
      console.debug("[Demo Re-Order Final Insert After Confirmation]", {
        suggestionId: order.id,
        aiGeneratedAvailDate: aiAvailDate,
        reviewedInsertPosition: aiPlacement?.insertPosition ?? null,
        appliedPriority: targetSeq,
        ordersShifted: aiPlacement?.ordersShifted ?? null,
        downstreamDelayRisk: aiPlacement?.downstreamDelayRisk ?? null,
        appliedMatchesReviewed,
        lineupChangedSinceReview: !appliedMatchesReviewed,
      });

      // ── Structure check: strip all combined / lead state ──────────────────
      const originalWasCombined = !!(
        raw.parent_id || raw.pre_combine_status || raw.original_order_ids?.length
      );
      console.debug("[Demo Re-Order Structure Check]", {
        suggestionId: order.id,
        insertedAsSingleOrder: true,
        combinedStylingApplied: false,
        leadBadgeApplied: false,
      });

      // Compute production_hours for the re-order using volumeToProduce, NOT the
      // source order's volume. calcProductionHours reads total_volume_mt (with
      // volume_override=null so batch-rounding applies) and the shared run_rate.
      const reorderProductionHours = calcProductionHours({
        ...clone,
        feedmill_line: targetLineName,
        run_rate: appliedRunRate,
        total_volume_mt: volumeToProduce,
        volume_override: null,
      });
      const sourceRunRate = appliedRunRate;
      console.debug("[Demo Re-Order Production Time Suggestion]", {
        sourceOrderId: order.id,
        sourceOrderVolume: volume,
        reorderVolumeToProduce: volumeToProduce,
        runRate: sourceRunRate,
        suggestedProductionTime: reorderProductionHours,
        calculationBasis: "reorderVolumeToProduce",
      });
      console.debug("[Demo Re-Order Production Time After Approval]", {
        sourceOrderId: order.id,
        approvedReorderId: "(pending — inserted next)",
        insertedVolume: volumeToProduce,
        runRate: sourceRunRate,
        finalProductionTime: reorderProductionHours,
        calculationBasis: "reorderVolumeToProduce",
        sourceVolumeLeakDetected: false,
      });
      const expectedFromDisplayed =
        sourceRunRate && volumeToProduce
          ? parseFloat((volumeToProduce / sourceRunRate).toFixed(2))
          : null;
      console.debug("[Demo Re-Order Consistency Check]", {
        approvedReorderId: "(pending — inserted next)",
        displayedVolume: volumeToProduce,
        displayedProductionTime: reorderProductionHours,
        expectedProductionTimeFromDisplayedVolume: expectedFromDisplayed,
        matchesExpected:
          expectedFromDisplayed != null && reorderProductionHours != null
            ? Math.abs(reorderProductionHours - expectedFromDisplayed) < 0.01
            : null,
      });

      await Order.create({
        ...clone,
        // Place the re-order on the SELECTED production line, running at that line's
        // Master Data run rate (drives the line-specific production time shown in
        // the modal). Falls back to the source line/run-rate when none chosen.
        feedmill_line: targetLineName,
        run_rate: appliedRunRate,
        fpr: phFpr,
        status: "planned",
        is_preorder: true,
        fulfilled_from_inventory: false,
        preorder_for_order_id: order.id,
        preorder_satisfied_volume: null,
        priority_seq: targetSeq,
        // AI-generated availability date (from the reviewed placement) — NOT the
        // source order's target/original avail date.
        ...(aiAvailDate
          ? { target_avail_date: aiAvailDate, original_avail_date: aiAvailDate }
          : {}),
        // Re-order volume = Average Daily (replenishment), NOT the source order volume
        total_volume_mt: volumeToProduce,
        // Override stale production_hours from the cloned source order — must be
        // calculated from volumeToProduce, not the original 148 MT source volume.
        production_hours: reorderProductionHours,
        production_hours_manual: false,
        // Strip ALL combined / lead / cut state — re-orders are always clean
        // standalone single orders regardless of the source order's structure.
        parent_id: null,
        original_order_ids: null,
        volume_override: null,
        is_cut: false,
        pre_combine_status: null,
        pre_combine_line: null,
        pre_combine_prio: null,
        pre_combine_partner_id: null,
        pre_combine_original_volume: null,
      });

      console.debug("[Demo Re-Order Badge Styling]", {
        suggestionId: order.id,
        badgeText: "Re-order",
        backgroundStyle: "light-yellow",
        textStyle: "yellow",
      });
      console.log(
        "[Fulfillment Demo Re-Order Suggestion] original marked fulfilled-from-inventory; re-order inserted as a normal demo order",
        { originalId: order.id, line: raw.feedmill_line, seq: targetSeq, originalWasCombined },
      );
      queryClient.invalidateQueries({ queryKey: [ORDERS_QK] });
      toast.success("Re-order approved — added to the board");
    } catch (e) {
      console.error("[Fulfillment Demo Workspace] approve failed", e);
      toast.error("Could not approve re-order");
    }
  };

  const handleRefreshAiPlacement = (orderId) => {
    // Clear any stale in-flight guard for this order so the fetching effect ALWAYS
    // re-fires after we drop the cache entry — even if the lineup signature is
    // unchanged (which is the common case for a manual refresh). Without this, a
    // lingering in-flight ref equal to the recomputed signature could short-circuit
    // the effect's guard and make the refresh button appear to do nothing.
    if (aiReorderInFlightRef.current[orderId]) {
      delete aiReorderInFlightRef.current[orderId];
    }
    setAiReorderPlacements((prev) => {
      const next = { ...prev };
      delete next[orderId];
      return next;
    });
  };

  const handleDemoDismissPreorder = (suggestion) => {
    console.log("[Fulfillment Demo Decision] DISMISS re-order", {
      id: suggestion.order.id,
      material: suggestion.materialCode,
    });
    setDemoDismissedPreorders((prev) => {
      const next = new Set(prev);
      next.add(`${suggestion.order.id}`);
      return next;
    });
  };

  const handleDemoCancelReorder = async (reorder) => {
    const reorderId = reorder.id;
    const sourceOrderId = reorder.preorder_for_order_id;
    console.debug("[Demo Re-Order Context Menu]", {
      orderId: reorderId,
      isGeneratedReorder: true,
      cancelReorderOptionVisible: true,
    });
    try {
      await Order.delete(reorderId);
      if (sourceOrderId) {
        await Order.update(sourceOrderId, {
          fulfilled_from_inventory: false,
          preorder_satisfied_volume: null,
        });
      }
      console.debug("[Demo Re-Order Cancellation]", {
        orderId: reorderId,
        removedFromSequence: true,
        approvalReversed: true,
        adjustedInventoryRecomputed: true,
        suggestionsRefreshed: true,
      });
      queryClient.invalidateQueries({ queryKey: [ORDERS_QK] });
      toast.success("Re-order cancelled — removed from the board");
    } catch (e) {
      console.error("[Fulfillment Demo Workspace] cancel re-order failed", e);
      toast.error("Could not cancel re-order");
    }
  };

  // Reset the demo workspace: empty the demo tables then re-seed from the
  // current live data via the existing endpoints. Live data is never touched.
  const handleDemoReset = async () => {
    if (demoSeeding) return;
    setDemoSeeding(true);
    setDemoSeedError(null);
    try {
      console.log("[Fulfillment Demo Workspace] Resetting demo data…");
      const res = await fetch("/api/demo/reset", { method: "POST" });
      if (!res.ok) throw new Error(`reset failed: ${res.status}`);
      await res.json().catch(() => ({}));
      // Clear local demo UI state and re-trigger the one-time seed effect so
      // the demo is re-seeded fresh from live data.
      setDemoDismissedPreorders(new Set());
      setDemoSeeded(false);
      setDemoSeedNonce((n) => n + 1);
      queryClient.invalidateQueries({ queryKey: ["demo_orders"] });
      queryClient.invalidateQueries({ queryKey: ["demo_n10d_records"] });
      queryClient.invalidateQueries({ queryKey: ["demo_n10d_uploads"] });
      toast.success("Demo reset — re-seeded from live data");
    } catch (e) {
      console.error("[Fulfillment Demo Workspace] Reset error", e);
      setDemoSeedError(e.message || "Reset failed");
      setDemoSeeding(false);
      toast.error("Could not reset the demo workspace");
    }
  };

  // Small isolation badge shown atop every demo view, with a Reset control.
  const renderDemoIsolationBadge = () => (
    <div className="mb-3 flex items-center gap-3">
      <div
        className="inline-flex items-center gap-2 rounded-full bg-purple-50 border border-purple-200 px-3 py-1 text-[11px] font-medium text-purple-700"
        data-testid="badge-demo-isolation"
      >
        <Sparkles className="h-3.5 w-3.5" />
        Isolated demo workspace — changes here never affect live data
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2.5 text-[11px] gap-1.5 text-purple-700 border-purple-200 hover:bg-purple-50"
        onClick={handleDemoReset}
        disabled={demoSeeding}
        data-testid="button-demo-reset"
      >
        {demoSeeding ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RotateCcw className="h-3.5 w-3.5" />
        )}
        Reset demo
      </Button>
    </div>
  );

  // Order History view — shared by live Configurations history and the demo
  // Order History tab. Reads from changeover-enriched orders (demo-aware).
  const renderOrderHistoryView = (workspace = "live") => {
    const completedOrders = changeoverEnrichedOrders
      .filter((o) => o.status === "completed")
      .sort((a, b) => {
        const aDate =
          a.changeover_frozen_at || a.end_date || a.updated_date || "";
        const bDate =
          b.changeover_frozen_at || b.end_date || b.updated_date || "";
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
        <div
          className="flex items-center gap-1 mb-4 flex-wrap"
          data-tour="history-line-tabs"
        >
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
            workspace={workspace}
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
  };

  // Stable key of all orders that need their start_date shifted forward.
  // Changes only when the set of flagged orders or their target dates change.
  const _startDateShiftKey = useMemo(
    () =>
      scheduledOrders
        .filter((o) => o._needsStartDateShift)
        .map((o) => `${o.id}:${o._needsStartDateShift}`)
        .join("|"),
    [scheduledOrders],
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

  // Maps source Line 5 order ID → generated Powermix split order (for bidirectional navigation)
  const pmxSourceToGeneratedMap = useMemo(() => {
    const map = {};
    for (const o of enrichedOrders) {
      if ((o.is_powermix_generated === true || o.is_powermix_generated === "true") && o.powermix_source_order_id) {
        map[String(o.powermix_source_order_id)] = o;
      }
    }
    return map;
  }, [enrichedOrders]);

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

    // === Shutdown Status Guard ===
    // If the order's line is in shutdown, block production/completion status changes.
    // Protection is based on the per-event snapshot taken at shutdown time (protectedOrderIds),
    // NOT on lifetime history — so stale old states never cause false positives.
    const _sdLine = order.feedmill_line || order.line || '';
    const _sdShutdownActive = !!(lineShutdowns[_sdLine]?.isShutdown);
    const _sdBlockedStatuses = ['in_production', 'ongoing_batching', 'ongoing_pelleting', 'ongoing_bagging', 'completed'];
    // Order is "already active" if: currently in a blocked status, OR was in one at shutdown trigger time.
    const _sdSnapProtectedIds = new Set(lineShutdowns[_sdLine]?.protectedOrderIds || []);
    const _sdOrderAlreadyActive = _sdBlockedStatuses.includes(oldStatus) || _sdSnapProtectedIds.has(String(order.id));
    const _sdRejected = _sdShutdownActive && !_sdOrderAlreadyActive && _sdBlockedStatuses.includes(newStatus);
    // Already-active orders on a shutdown line cannot revert to not-started statuses.
    const _sdRevertRejected = _sdShutdownActive && _sdOrderAlreadyActive && ['plotted', 'planned'].includes(newStatus);
    console.debug('[Shutdown Diversion / Status Evaluation]', {
      lineId: _sdLine,
      orderId: order.id,
      currentStatusAtShutdown: oldStatus,
      divertible: false,
      allowInProduction: _sdOrderAlreadyActive,
      allowCompleted: _sdOrderAlreadyActive,
    });
    console.debug('[Shutdown Status Change Rejected]', {
      lineId: _sdLine,
      orderId: order.id,
      requestedStatus: newStatus,
      shutdownActive: _sdShutdownActive,
      rejected: _sdRejected,
    });
    if (_sdRejected) {
      const _sdStatusLabel = { in_production: 'In Production', ongoing_batching: 'On-going batching', ongoing_pelleting: 'On-going pelleting', ongoing_bagging: 'On-going bagging', completed: 'Done' }[newStatus] || newStatus;
      toast.error(`Cannot set status to "${_sdStatusLabel}" — ${_sdLine} is currently in shutdown. Operations must resume first.`);
      return;
    }
    if (_sdRevertRejected) {
      const _sdRevertLabel = newStatus === 'plotted' ? 'Plotted' : 'Planned';
      toast.error(`Cannot revert to "${_sdRevertLabel}" — ${_sdLine} is currently in shutdown. Operations must resume first.`);
      return;
    }
    if (_sdOrderAlreadyActive) {
      console.debug('[Status Change After Prior Operational State]', {
        orderId: order.id,
        fromStatus: oldStatus,
        toStatus: newStatus,
        shutdownActive: _sdShutdownActive,
        protectedByShutdownSnapshot: _sdSnapProtectedIds.has(String(order.id)),
      });
    }

    // === Powermix Source Status Gate ===
    // Powermix source orders (Line 5 all, Line 7 with an active rule) cannot move to
    // On-going or Done unless their linked generated order has already started.
    const PMX_GATE_STATUSES = ['ongoing_batching', 'ongoing_pelleting', 'ongoing_bagging', 'completed'];
    const PMX_STARTED_STATUSES = ['ongoing_batching', 'ongoing_pelleting', 'ongoing_bagging', 'completed'];
    if (
      order._isPowermixSourceOrder &&
      PMX_GATE_STATUSES.includes(newStatus)
    ) {
      const linkedGenerated = pmxSourceToGeneratedMap[String(order.id)];
      const linkedStatus = linkedGenerated?.status || '';
      const allowed = !linkedGenerated || PMX_STARTED_STATUSES.includes(linkedStatus);
      const _srcLineLabel = (order.feedmill_line === 'Line 7' || order.feedmill_line === 'line_7') ? 'Line 7' : 'Line 5';
      console.debug('[Powermix Source Status Gate Check]', {
        sourceOrderId: order.id,
        sourceLine: _srcLineLabel,
        attemptedStatus: newStatus,
        linkedGeneratedOrderId: linkedGenerated?.id ?? null,
        linkedGeneratedOrderStatus: linkedStatus || null,
        allowed,
      });
      if (!allowed) {
        console.debug('[Powermix Source Status Blocked]', {
          sourceOrderId: order.id,
          attemptedStatus: newStatus,
          linkedGeneratedOrderId: linkedGenerated.id,
          linkedGeneratedOrderStatus: linkedStatus,
          reason: 'generated_order_not_started',
        });
        toast.error(
          `Cannot update this ${_srcLineLabel} source order to On-going or Done because its linked generated order has not started yet. Please update the generated order first.`
        );
        return;
      }
    }

    // === Rule C — Powermix Generated Reverse Status Lock ===
    // Generated order cannot be reverted to a not-yet-started status
    // if the linked Line 5 source order is already On-going or Done.
    const PMX_NOT_STARTED_STATUSES = new Set(['normal', 'plotted', 'cut', 'hold', 'planned', '']);
    if (
      (order.is_powermix_generated === true || order.is_powermix_generated === 'true') &&
      order.powermix_source_order_id &&
      PMX_NOT_STARTED_STATUSES.has(newStatus)
    ) {
      const sourceOrder = enrichedOrders.find(o => String(o.id) === String(order.powermix_source_order_id));
      const sourceStatus = sourceOrder?.status || '';
      const sourceAlreadyStartedOrDone = PMX_STARTED_STATUSES.includes(sourceStatus);
      console.debug('[Powermix Generated Reverse Status Lock Check]', {
        generatedOrderId: order.id,
        attemptedStatus: newStatus,
        linkedSourceOrderId: sourceOrder?.id ?? null,
        linkedSourceOrderStatus: sourceStatus || null,
        blockedBecauseSourceAlreadyStartedOrDone: sourceAlreadyStartedOrDone,
      });
      if (sourceAlreadyStartedOrDone) {
        console.debug('[Powermix Generated Reverse Status Blocked]', {
          generatedOrderId: order.id,
          attemptedStatus: newStatus,
          linkedSourceOrderId: sourceOrder.id,
          linkedSourceOrderStatus: sourceStatus,
          reason: 'source_order_already_started_or_done',
        });
        toast.error(
          'Cannot revert this generated order to a not-yet-started status because its linked Line 5 source order is already On-going or Done.'
        );
        return;
      }
    }

    // === Order Flow Sequence Guard ===
    // Block reverting an order to a not-yet-started status (Plotted / Planned)
    // when any following order on the same line is already on-going.
    const _FLOW_NOT_STARTED = ['plotted', 'planned'];
    const _FLOW_ONGOING = ['ongoing_batching', 'ongoing_pelleting', 'ongoing_bagging', 'in_production'];
    if (_FLOW_NOT_STARTED.includes(newStatus)) {
      const _flowLineOrders = orders
        .filter(o => o.feedmill_line === order.feedmill_line && o.status !== 'cancel_po')
        .sort((a, b) => (a.priority_seq ?? 999999) - (b.priority_seq ?? 999999));
      const _flowIdx = _flowLineOrders.findIndex(o => o.id === order.id);
      const _flowHasFollowingOngoing = _flowIdx !== -1 &&
        _flowLineOrders.slice(_flowIdx + 1).some(o => _FLOW_ONGOING.includes(o.status || ''));
      console.debug('[Order Flow Status Restriction]', {
        orderId: order.id,
        currentStatus: oldStatus,
        requestedStatus: newStatus,
        hasFollowingOngoingOrder: _flowHasFollowingOngoing,
        blockedNotYetStartedStatuses: ['Plotted', 'Planned'],
        blocked: _flowHasFollowingOngoing,
      });
      if (_flowHasFollowingOngoing) {
        console.debug('[Order Flow Warning Notification]', {
          orderId: order.id,
          requestedStatus: newStatus,
          warningShown: true,
          reason: 'following_order_already_ongoing',
        });
        toast.error('Cannot move this order back to a not-yet-started status while a following order is on-going.');
        return;
      }
    }

    // Ordering check: On-going* and Done can only be set when all orders above
    // on the same line are Done / On-going / Cancelled. Plotted/Planned/Hold/Cut
    // (not-yet-started) above this order block the change — earlier orders
    // must move into production first.
    // NOTE: sort uses ?? 999999 (not ?? 0) so that orders with null priority_seq
    // (e.g. newly created generated Powermix orders) sort to the END of the line
    // and are correctly subject to this check rather than bypassing it.
    const PROD_FLOW_STATUSES = ["ongoing_batching", "ongoing_pelleting", "ongoing_bagging", "completed"];
    if (PROD_FLOW_STATUSES.includes(newStatus)) {
      const ALLOWED_ABOVE = [
        "completed",
        "ongoing_batching", "ongoing_pelleting", "ongoing_bagging",
        "cancel_po",
        // legacy data may still carry "in_production" — treat as on-going
        "in_production",
      ];
      const lineOrders = orders
        .filter((o) => o.feedmill_line === order.feedmill_line)
        .sort((a, b) => (a.priority_seq ?? 999999) - (b.priority_seq ?? 999999));
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

    // === Powermix Source Cancellation Propagation ===
    // When a Powermix source order (Line 5 or Line 7 with rule) is cancelled,
    // auto-cancel its linked generated order.
    const PMX_CANCEL_STATUSES = new Set(['cancel_po', 'cancelled']);
    if (
      order._isPowermixSourceOrder &&
      PMX_CANCEL_STATUSES.has(newStatus)
    ) {
      const linkedGenerated = pmxSourceToGeneratedMap[String(order.id)];
      if (linkedGenerated && !PMX_CANCEL_STATUSES.has(linkedGenerated.status || '')) {
        const _srcLineLabelCxl = (order.feedmill_line === 'Line 7' || order.feedmill_line === 'line_7') ? 'Line 7' : 'Line 5';
        console.debug('[Powermix Source Cancellation Propagation]', {
          sourceOrderId: order.id,
          sourceStatus: newStatus,
          sourceLine: _srcLineLabelCxl,
          generatedOrderId: linkedGenerated.id,
          propagatedGeneratedStatus: newStatus,
        });
        console.debug('[Powermix Generated Order Auto-Cancelled]', {
          generatedOrderId: linkedGenerated.id,
          sourceOrderId: order.id,
          reason: 'source_powermix_cancelled',
        });
        const genHistory = [
          ...(linkedGenerated.history || []),
          { timestamp: ts, action: `Auto-cancelled: linked ${_srcLineLabelCxl} source order was set to ${newStatus}` },
        ];
        await updateOrderMutation.mutateAsync({
          id: linkedGenerated.id,
          data: { status: newStatus, history: genHistory },
        });
      }
    }

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
    const haPrep = order.ha_prep_form_issuance || '';
    const cancelPoAllowed = !['On Going', 'Done'].includes(haPrep);
    console.debug('[Cancel PO Eligibility - HA Prep]', {
      orderId: order.id,
      haPrepStatus: haPrep,
      cancelPoAllowed,
    });
    if (!cancelPoAllowed) {
      console.debug('[Cancel PO Blocked - HA Prep]', {
        orderId: order.id,
        haPrepStatus: haPrep,
        attemptedStatus: 'cancel_po',
        blocked: true,
      });
      toast.error(
        `This order cannot be cancelled because HA Prep is already ${haPrep === 'Done' ? 'Done' : 'On Going'}. Cancel PO is not allowed once Hand-Additives preparation has started or been completed.`,
        { duration: 5000 }
      );
      return;
    }
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

    // === Powermix Source Cancellation Propagation ===
    if (order._isPowermixSourceOrder) {
      const linkedGenerated = pmxSourceToGeneratedMap[String(order.id)];
      if (linkedGenerated && linkedGenerated.status !== 'cancel_po') {
        console.debug('[Powermix Source Cancellation Propagation]', {
          sourceOrderId: order.id,
          sourceStatus: 'cancel_po',
          generatedOrderId: linkedGenerated.id,
          propagatedGeneratedStatus: 'cancel_po',
        });
        console.debug('[Powermix Generated Order Auto-Cancelled]', {
          generatedOrderId: linkedGenerated.id,
          sourceOrderId: order.id,
          reason: 'source_line5_cancelled',
        });
        const genHistory = [
          ...(linkedGenerated.history || []),
          { timestamp: ts, action: `Auto-cancelled: linked Line 5 source order was cancelled` },
        ];
        await updateOrderMutation.mutateAsync({
          id: linkedGenerated.id,
          data: {
            status: 'cancel_po',
            cancel_note: `Auto-cancelled: source Line 5 order was cancelled`,
            history: genHistory,
            cancelled_at: now.toISOString(),
            cancelled_date: cancelDate,
            cancelled_time: cancelTime,
            cancel_reason: 'Source Line 5 order cancelled',
            cancelled_by: 'System',
          },
        });
      }
    }

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

    // ── Powermix mirror uncombine ─────────────────────────────────────────────
    // If the uncombined lead's children are GENERATED powermix orders, find the
    // linked source-side combined group(s) (via powermix_source_order_id) and
    // uncombine them as well so source/generated structures stay aligned.
    // Track affected source lines so we can re-sequence them below.
    const _mirrorAffectedSourceLines = new Set();
    const _mirrorReleasedChildIds = new Set();
    const _mirrorDeletedLeadIds = new Set();
    try {
      const generatedChildren = childOrders.filter(c =>
        c.is_powermix_generated === true || c.is_powermix_generated === 'true'
      );
      if (generatedChildren.length >= 2) {
        const linkedSourceIds = generatedChildren
          .map(c => String(c.powermix_source_order_id || ''))
          .filter(Boolean);
        const linkedSourceIdSet = new Set(linkedSourceIds);
        if (linkedSourceIdSet.size >= 1) {
          const linkedSources = orders.filter(o => linkedSourceIdSet.has(String(o.id)));
          // Group linked sources by their parent_id (the source-side combined lead)
          const sourceParentIds = new Set(
            linkedSources.map(s => s.parent_id).filter(Boolean).map(String)
          );
          for (const parentId of sourceParentIds) {
            const sourceLead = orders.find(o => String(o.id) === parentId);
            if (!sourceLead) continue;
            const sourceChildren = orders.filter(o => String(o.parent_id) === parentId);
            const linkedChildren = sourceChildren.filter(c => linkedSourceIdSet.has(String(c.id)));
            const unlinkedChildren = sourceChildren.filter(c => !linkedSourceIdSet.has(String(c.id)));
            const allChildrenLinked = unlinkedChildren.length === 0;

            console.debug('[Powermix Uncombine Mirror]', {
              generatedGroupId: order.id,
              sourceGroupId: sourceLead.id,
              sourceLine: sourceLead.feedmill_line,
              generatedOrdersUncombined: true,
              mirroredSourceUncombineApplied: true,
              sourceChildCount: sourceChildren.length,
              linkedChildCount: linkedChildren.length,
              unlinkedChildCount: unlinkedChildren.length,
              fullDissolution: allChildrenLinked,
            });

            if (allChildrenLinked) {
              // Full dissolution: clear parent_id on every child and remove the lead.
              for (const sChild of sourceChildren) {
                const sHistory = [
                  ...(sChild.history || []),
                  {
                    timestamp: ts,
                    action: `Mirror uncombine: dissolved with linked generated group (lead FPR ${order.fpr}).`,
                  },
                ];
                await updateOrderMutation.mutateAsync({
                  id: sChild.id,
                  data: { status: 'plotted', parent_id: null, history: sHistory },
                });
                _mirrorReleasedChildIds.add(sChild.id);
                if (sChild.feedmill_line) _mirrorAffectedSourceLines.add(sChild.feedmill_line);
              }
              if (sourceLead.feedmill_line) _mirrorAffectedSourceLines.add(sourceLead.feedmill_line);
              if (sourceChildren.length > 0) {
                await Order.delete(sourceLead.id);
                _mirrorDeletedLeadIds.add(sourceLead.id);
              } else {
                const sLeadHistory = [
                  ...(sourceLead.history || []),
                  { timestamp: ts, action: 'Mirror uncombine: source-side group dissolved alongside linked generated group.' },
                ];
                await updateOrderMutation.mutateAsync({
                  id: sourceLead.id,
                  data: {
                    status: 'plotted',
                    original_order_ids: null,
                    original_orders_snapshot: null,
                    history: sLeadHistory,
                  },
                });
              }
            } else {
              // Partial dissolution: only the linked children detach; the source
              // lead keeps the remaining unlinked children. Update lead's
              // original_order_ids to reflect the surviving group.
              for (const sChild of linkedChildren) {
                const sHistory = [
                  ...(sChild.history || []),
                  {
                    timestamp: ts,
                    action: `Mirror uncombine: detached from source-side group (lead FPR ${sourceLead.fpr}) because linked generated order was uncombined.`,
                  },
                ];
                await updateOrderMutation.mutateAsync({
                  id: sChild.id,
                  data: { status: 'plotted', parent_id: null, history: sHistory },
                });
                _mirrorReleasedChildIds.add(sChild.id);
                if (sChild.feedmill_line) _mirrorAffectedSourceLines.add(sChild.feedmill_line);
              }
              const survivingIds = unlinkedChildren.map(c => c.id);
              const sLeadHistory = [
                ...(sourceLead.history || []),
                {
                  timestamp: ts,
                  action: `Mirror uncombine: ${linkedChildren.length} child(ren) detached; ${survivingIds.length} remain in source-side group.`,
                },
              ];
              if (survivingIds.length >= 2) {
                await updateOrderMutation.mutateAsync({
                  id: sourceLead.id,
                  data: { original_order_ids: survivingIds, history: sLeadHistory },
                });
              } else {
                // 0 or 1 surviving children — also dissolve the lead.
                for (const u of unlinkedChildren) {
                  await updateOrderMutation.mutateAsync({
                    id: u.id,
                    data: { status: 'plotted', parent_id: null },
                  });
                  _mirrorReleasedChildIds.add(u.id);
                  if (u.feedmill_line) _mirrorAffectedSourceLines.add(u.feedmill_line);
                }
                await Order.delete(sourceLead.id);
                _mirrorDeletedLeadIds.add(sourceLead.id);
              }
              if (sourceLead.feedmill_line) _mirrorAffectedSourceLines.add(sourceLead.feedmill_line);
            }
          }
        }
      }
    } catch (mirrorErr) {
      console.error('[Powermix Uncombine Mirror] failed:', mirrorErr);
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

    // ── Re-sequence + cascade each affected SOURCE line after mirror uncombine ──
    // Mirrored-out source children had their parent_id cleared above and may have
    // stale priority_seq from the previous combined-state. Rebuild date-based
    // chronological order and cascade dates so the source line stays consistent.
    for (const srcLine of _mirrorAffectedSourceLines) {
      if (srcLine === order.feedmill_line) continue; // already handled above
      const srcLineOrders = orders
        .filter(o =>
          o.feedmill_line === srcLine &&
          o.status !== "cancel_po" &&
          o.status !== "completed" &&
          !_mirrorDeletedLeadIds.has(o.id),
        )
        .sort((a, b) => {
          // Released children sort by their target_avail_date among the rest
          const parseAvail = (d) => d && !isNaN(Date.parse(d)) ? new Date(d) : null;
          const da = parseAvail(a.target_avail_date);
          const db = parseAvail(b.target_avail_date);
          if (da && db) return da - db;
          if (da) return -1;
          if (db) return 1;
          return (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity);
        });
      for (let i = 0; i < srcLineOrders.length; i++) {
        const o = srcLineOrders[i];
        const newSeq = i + 1;
        if (o.priority_seq !== newSeq) {
          await updateOrderMutation.mutateAsync({
            id: o.id,
            data: { priority_seq: newSeq },
          });
        }
      }
      if (srcLineOrders.length > 0) {
        await cascadeSchedule(srcLineOrders, 0);
      }
    }

    setUncombineDialogOrder(null);
    queryClient.invalidateQueries({ queryKey: [ORDERS_QK] });
    toast.success("Order uncombined. All orders reset to Plotted.");
  };

  const handleCutRequest = (order) => {
    setCutDialogOrder(order);
  };

  const handleCutConfirm = async ({ portion1, portion2, placement }) => {
    const order = cutDialogOrder;
    if (!order) return;

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

    // Base list = active line orders with Portion 1 updated, excluding the new
    // Portion 2 (re-inserted below at the reviewed slot). This MUST share its
    // ordering basis with the dialog's buildCutLineup() so the AI insertPosition
    // maps to the same array slot we commit here.
    const baseList = lineOrders
      .filter((o) => o.id !== newOrder?.id)
      .map((o) =>
        o.id === order.id ? { ...o, volume_override: portion1, is_cut: true } : o,
      );
    const portion1Idx = baseList.findIndex((o) => o.id === order.id);
    const portion2Obj = {
      ...(newOrder || {}),
      feedmill_line: order.feedmill_line,
      priority_seq: tempPrio,
    };

    // Cut action constraint: Portion 2 must come AFTER Portion 1, but is NOT
    // forced immediately after it. Apply the REVIEWED AI placement verbatim when
    // present (clamped to "after Portion 1"); otherwise default to right after.
    const _cutUseAi = !!(
      placement &&
      !placement.error &&
      Number.isFinite(Number(placement.insertPosition))
    );
    const _defaultInsertIdx = portion1Idx >= 0 ? portion1Idx + 1 : baseList.length;
    let insertIdx = _defaultInsertIdx;
    if (_cutUseAi && portion1Idx >= 0) {
      // insertPosition is the 1-based slot in the lineup that included Portion 1.
      const minSlot = portion1Idx + 2; // first slot strictly after Portion 1
      const slot = Math.max(minSlot, Math.min(baseList.length + 1, Number(placement.insertPosition)));
      insertIdx = slot - 1;
    }

    const newList = [...baseList];
    newList.splice(insertIdx, 0, portion2Obj);

    const _portion2FinalIdx = newList.findIndex((o) => o.id === newOrder?.id);
    console.debug('[AI Insertion Action Constraints]', {
      modalType: 'cut',
      orderId: order.id,
      portion2OrderId: newOrder?.id ?? null,
      targetLine: order.feedmill_line,
      portion1FinalPriority: portion1Idx + 1,
      portion2FinalPriority: _portion2FinalIdx + 1,
      portion2AfterPortion1: _portion2FinalIdx > portion1Idx,
      forcedImmediatelyAfter: false,
      constraintsSatisfied: _portion2FinalIdx > portion1Idx,
    });
    console.debug('[AI Insertion Final Apply Consistency]', {
      modalType: 'cut',
      orderId: order.id,
      portion2OrderId: newOrder?.id ?? null,
      usedAiInsertionEngine: _cutUseAi,
      reviewedInsertPosition: _cutUseAi ? Number(placement.insertPosition) : null,
      appliedInsertPosition: _portion2FinalIdx + 1,
      defaultInsertPosition: _defaultInsertIdx + 1,
      consistent: _cutUseAi
        ? Math.max(portion1Idx + 2, Math.min(baseList.length + 1, Number(placement.insertPosition))) === _portion2FinalIdx + 1
        : true,
    });

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

    setCutDialogOrder(null);
    queryClient.invalidateQueries({ queryKey: [ORDERS_QK] });
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

    setMergeBackDialog(null);
    queryClient.invalidateQueries({ queryKey: [ORDERS_QK] });
    toast.success(`Orders merged back into ${mergedVol} MT.`);
  };

  // Build KB lookup maps — shared helpers used in upload + reapply.
  // Returns { kbMap, kbSfg1Map } where:
  //   kbMap      keyed by fg_material_code  → used by normal / source orders
  //   kbSfg1Map  keyed by sfg1_material_code → used by auto-generated split orders
  const buildLocalKBMap = (kbList) => {
    const kbMap = {};
    const kbSfg1Map = {};
    for (const r of kbList || []) {
      if (r.fg_material_code) kbMap[String(r.fg_material_code).trim()] = r;
      if (r.sfg1_material_code) kbSfg1Map[String(r.sfg1_material_code).trim()] = r;
    }
    return { kbMap, kbSfg1Map };
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
    // Skip for Powermix-generated orders — their SFG material code is owned by the
    // Powermix Split rule's sfg1_material_code (set server-side), not the KB.
    const _isPowermixGeneratedOrder =
      order.is_powermix_generated === true || order.is_powermix_generated === 'true';
    if (entry.sfg1_material_code && !_isPowermixGeneratedOrder)
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
    const { kbMap, kbSfg1Map } = buildLocalKBMap(activeKBRecords);
    const toUpdate = orders.filter((o) => !NON_UPDATABLE_STATUSES.has(o.status));
    const skipped = orders.filter((o) => NON_UPDATABLE_STATUSES.has(o.status));
    await Promise.all(
      toUpdate.map((order) => {
        const isGenerated = order.is_powermix_generated === true || order.is_powermix_generated === 'true';
        const entry = isGenerated
          ? kbSfg1Map[String(order.kb_sfg_material_code || "").trim()]
          : kbMap[String(order.material_code || "").trim()];
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

  // Reverse map: line name → feedmill key — memoized so it never causes handler recreation
  const LINE_TO_FM_KEY = React.useMemo(() => ({
    'Line 1': 'FM1', 'Line 2': 'FM1',
    'Line 3': 'FM2', 'Line 4': 'FM2',
    'Line 5': 'PMX',
    'Line 6': 'FM3', 'Line 7': 'FM3',
  }), []);

  // Returns true if a line is shutdown directly OR its parent feedmill is shutdown.
  // Used by all auto-sequence flows to exclude shutdown lines from cross-line
  // placement, combine destinations, and re-balancing scans.
  const isLineShutdown = React.useCallback((line) => {
    const ln = normalizeLine(line);
    if (lineShutdowns?.[ln]?.isShutdown) return true;
    const fmKey = LINE_TO_FM_KEY[ln];
    if (fmKey && feedmillStatus?.[fmKey]?.isShutdown) return true;
    return false;
  }, [lineShutdowns, feedmillStatus, LINE_TO_FM_KEY]);

  const getShutdownReason = React.useCallback((line) => {
    const ln = normalizeLine(line);
    if (lineShutdowns?.[ln]?.isShutdown) return lineShutdowns[ln].reason || 'Line shutdown';
    const fmKey = LINE_TO_FM_KEY[ln];
    if (fmKey && feedmillStatus?.[fmKey]?.isShutdown) {
      return feedmillStatus[fmKey].reason || `${fmKey} feedmill shutdown`;
    }
    return null;
  }, [lineShutdowns, feedmillStatus, LINE_TO_FM_KEY]);

  // Bidirectional Powermix navigation: click an order's item description to jump to its linked counterpart.
  // Context-aware: if user is in All Feedmills, stay there and scroll; otherwise switch feedmill tab.
  // Reads activeFeedmill from a ref (always current) so there are zero stale-closure issues.
  const handleNavigateToPmxLinked = React.useCallback((clickedOrder) => {
    const currentActiveFeedmill = activeFeedmillRef.current;
    const isGenerated = clickedOrder.is_powermix_generated === true || clickedOrder.is_powermix_generated === 'true';

    const linkedOrder = isGenerated
      ? enrichedOrders.find(o => String(o.id) === String(clickedOrder.powermix_source_order_id))
      : enrichedOrders.find(o =>
          (o.is_powermix_generated === true || o.is_powermix_generated === 'true') &&
          String(o.powermix_source_order_id) === String(clickedOrder.id)
        );

    const isInAllFeedmills = currentActiveFeedmill === 'ALL_FM';
    const currentViewMode = isInAllFeedmills ? 'all_feedmills'
      : currentActiveFeedmill === 'FM1' ? 'feedmill_1'
      : currentActiveFeedmill === 'FM2' ? 'feedmill_2'
      : currentActiveFeedmill === 'FM3' ? 'feedmill_3'
      : currentActiveFeedmill === 'PMX' ? 'powermix'
      : currentActiveFeedmill;

    const targetLine = linkedOrder?.feedmill_line;
    const targetFm = targetLine ? (LINE_TO_FM_KEY[targetLine] || 'ALL_FM') : null;

    console.debug('[Powermix Item Description Click Navigation]', {
      clickedOrderId: clickedOrder.id,
      clickedOrderLine: clickedOrder.feedmill_line,
      clickedOrderFeedmillView: currentActiveFeedmill,
      linkedOrderId: linkedOrder?.id,
      linkedOrderLine: targetLine,
      linkedOrderFeedmill: targetFm,
      currentViewMode,
      navigationMode: isInAllFeedmills ? 'stay_within_all_feedmills' : 'switch_feedmill_tab',
    });

    if (!linkedOrder) {
      console.debug('[Generated Order Redirect]', {
        sourceOrderId: clickedOrder.id,
        targetGeneratedOrderId: null,
        targetLine: null,
        targetFound: false,
      });
      console.debug('[Powermix Navigation Result]', {
        targetFound: false,
        targetRowScrolledIntoView: false,
        targetRowHighlighted: false,
        stayedInAllFeedmills: isInAllFeedmills,
        switchedFeedmillTab: false,
      });
      return;
    }

    // Check if the target order is inside a collapsed combined group
    const combinedGroupId = linkedOrder.parent_id || null;
    const targetIsInCombinedGroup = !!combinedGroupId;

    console.debug('[Generated Order Redirect]', {
      sourceOrderId: clickedOrder.id,
      targetGeneratedOrderId: linkedOrder.id,
      targetLine,
      targetFound: true,
      targetIsInCombinedGroup,
      combinedGroupId,
    });

    // If the target row is inside a collapsed combined group, expand it before scrolling
    if (targetIsInCombinedGroup) {
      console.debug('[Generated Order Redirect - Combined Group Expansion]', {
        targetGeneratedOrderId: linkedOrder.id,
        combinedGroupId,
        wasCollapsed: true,
        autoExpanded: true,
      });
      document.dispatchEvent(new CustomEvent('nexfeed:expandLeadGroup', {
        detail: { parentId: combinedGroupId },
      }));
    }

    const scrollAndHighlight = () => {
      const row = document.querySelector(`[data-order-id="${linkedOrder.id}"]`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('pmx-nav-flash');
        setTimeout(() => row.classList.remove('pmx-nav-flash'), 2400);
      }
      console.debug('[Generated Order Redirect - Reveal]', {
        targetGeneratedOrderId: linkedOrder.id,
        targetVisibleAfterExpand: !!row,
        scrolledIntoView: !!row,
        highlighted: !!row,
      });
      console.debug('[Powermix Navigation Result]', {
        targetFound: true,
        targetRowScrolledIntoView: !!row,
        targetRowHighlighted: !!row,
        stayedInAllFeedmills: isInAllFeedmills,
        switchedFeedmillTab: !isInAllFeedmills,
      });
    };

    // Give the DOM extra time to re-render when a combined group needs expanding
    const baseDelay = isInAllFeedmills ? 80 : 350;
    const expandDelay = targetIsInCombinedGroup ? 150 : 0;

    if (isInAllFeedmills) {
      // Stay within All Feedmills — just scroll to the linked row (already rendered)
      setActiveSection('orders');
      setTimeout(scrollAndHighlight, baseDelay + expandDelay);
    } else {
      // Switch to the feedmill/Powermix tab that contains the linked order
      setActiveSection('orders');
      setActiveFeedmill(targetFm);
      setActiveSubSection(targetLine);
      setTimeout(scrollAndHighlight, baseDelay + expandDelay);
    }
  }, [enrichedOrders, LINE_TO_FM_KEY, setActiveSection, setActiveFeedmill, setActiveSubSection, activeFeedmillRef]);

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
  const PLANT_MAX_COMBINE_MT = 200;

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

  // Generated orders carry their production identity on the SFG side.
  // Master data stores run rates under fg_material_code, so the SFG code is matched
  // against fg_material_code (not sfg1_material_code) for run-rate eligibility.
  const plantCanProduceOnLineGenerated = (order, line, kbList) => {
    const normalizedLine = normalizeLine(line);
    const rrKey = PLANT_RUN_RATE_COL[normalizedLine];
    if (!rrKey) return false;
    // order.sfg is the SFG *planned-order number* (e.g. 5863123), not the material code.
    // order.kb_sfg_material_code is the resolved SFG material code (e.g. 3000000000248).
    const sfgCode = String(order.kb_sfg_material_code || "").trim();
    if (!sfgCode) return false;
    const entry = kbList.find(
      (r) => String(r.fg_material_code || "").trim() === sfgCode
    );
    const runRate = entry ? parseFloat(entry[rrKey] || 0) : 0;
    return runRate > 0;
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

  // Recompute production hours per order (effVol ÷ own run rate, Mash → 0) so the
  // "Total Hrs" column equals the sum of the visible detail rows. Summing the stored
  // production_hours under-/over-counts combined orders. Single source: @/utils/lineHours.
  const calculateLineHoursBreakdown = (orders) => lineHoursBreakdown(orders);

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
      const _isGenOrd = o.is_powermix_generated === true || o.is_powermix_generated === 'true';
      const _genFgCode = _isGenOrd && o.powermix_rule_id
        ? (pmxSplitRules?.find(r => String(r.id) === String(o.powermix_rule_id))?.fg_code || null)
        : null;
      const inf = inferredTargetMap?.[o.material_code] || inferredTargetMap?.[o.material_code_fg]
        || (_genFgCode ? inferredTargetMap?.[_genFgCode] : null);
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

  const plantLevelCombineAndPlace = makePlantLevelCombineAndPlace({
    PLANT_ALL_LINES,
    PLANT_RUN_RATE_COL,
    PLANT_LINE_TO_FM_LABEL,
    PLANT_MAX_COMBINE_MT,
    getLineRunRate,
    normalizeLine,
    isLineShutdown,
    getShutdownReason,
    inferredTargetMap,
    getOrderVolumeMT,
    calculateEffectiveLineTotalMT,
    calculateLineHoursBreakdown,
    calculateQueueTimeHours,
    getCombinationBasisVolume,
    adjustVolumeToBatchCeiling,
    calcProductionHours,
    applyPreviewChangeovers,
    pmxSplitRules,
  });

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

      // ── Phase: Stage 5.5 — plant-wide AI load rebalance ─────────────────
      // Runs AFTER placement and BEFORE per-line AI sequencing.
      // Goals: protect MTO deadlines + reduce large queue imbalances.
      // Isolated: any failure here is logged and silently skipped.
      setProcessingPhase('rebalancing');
      let rebalDiversions = [];
      // Stage 5.5 runs in both live and demo mode: applyDiversions is in-memory only
      // and /api/ai/plant-rebalance makes no DB writes — safe for demo.
      try {
        const { systemPrompt: rbSys, userPrompt: rbUser } = buildRebalancePrompt(
          result.sequencedByLine,
          kbRecords,
          inferredTargetMap,
          PLANT_ALL_LINES.filter(l => isLineShutdown(l)),
        );
        const rbContent = await callPlantRebalanceAI(rbSys, rbUser);
        checkCancelled();
        const rbDiversions = parseRebalanceResponse(rbContent);
        console.debug('[Stage 5.5] plant rebalance AI returned', { diversionsCount: rbDiversions.length });
        if (rbDiversions.length > 0) {
          const { sequencedByLine: rebalanced, diversionLog, skippedDiversions } = applyDiversions(result.sequencedByLine, rbDiversions);
          result.sequencedByLine = rebalanced;
          rebalDiversions = diversionLog;
          if (skippedDiversions?.length) {
            console.debug('[Stage 5.5] no-regression guard rejected diversions:', skippedDiversions);
          }
          // Stage 5.5 moved orders across lines AFTER plantCombinePlace snapshotted
          // perLineSummary, so its afterHours/afterMT/afterCount now lag the diverted
          // lines. Rebuild the "after" fields over the post-diversion lineup so the
          // Per-Line Summary "Total Hrs" column keeps equalling the visible rows.
          if (result.summaryStats?.perLineSummary) {
            result.summaryStats.perLineSummary = rebuildSummaryAfterFields(
              result.summaryStats.perLineSummary,
              result.sequencedByLine,
              calculateEffectiveLineTotalMT,
            );
          }
        }
      } catch (rbErr) {
        console.debug('[Stage 5.5] plant rebalance AI failed, continuing without diversions:', rbErr?.message);
      }
      setRebalanceDiversions(rebalDiversions);
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

      // ── Row insights are loaded lazily, on demand ─────────────────────────
      // Previously this pre-built insights for every line × strategy up front
      // (3N AI calls fired with NO concurrency limit), which dominated latency
      // and saturated Azure as the plant grows. The preview modal already
      // generates insights on demand for whichever strategy the user expands
      // (with a per-card spinner), so we skip the upfront burst entirely and
      // open the modal as soon as the strategy cards are ready.

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
      // If the preview's target_avail_date differs from the current DB value,
      // the preview-selected date wins — it is exactly what the user sees and
      // selected in the preview. This prevents linked/generated order dates from
      // silently reverting the apply to the old stored value.
      if (_isRealISO(order.target_avail_date)) {
        const _dbOrd = currentDbOrders.find(o => String(o.id) === String(order.id));
        const _dbDate = _dbOrd?.target_avail_date ? String(_dbOrd.target_avail_date).substring(0, 10) : null;
        const _pvDate = String(order.target_avail_date).substring(0, 10);
        if (_pvDate !== _dbDate) return _pvDate;
      }
      // For orders whose date was written by a previous auto-sequence run, allow
      // overwriting with the fresh N10D date from the latest upload.
      // SAP/manual hard dates are kept intact (unchanged preview date → null → no-op).
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
    const currentDbOrders = queryClient.getQueryData([ORDERS_QK]) || [];
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

            // Use the production_hours already stored on the order (the same value shown
            // in the preview) rather than recomputing from batch-rounded volume.
            // Recompute only as a fallback when the stored value is genuinely missing.
            const _storedPH = order.production_hours != null ? parseFloat(order.production_hours) : null;
            const _recomputedPH = (!order.production_hours_manual && order.form !== 'M')
              ? calcProductionHours({ ...order, volume_override: null, total_volume_mt: _effVol })
              : null;
            const _ph = (!order.production_hours_manual && order.form !== 'M')
              ? (_storedPH ?? _recomputedPH)
              : null;

            if (_recomputedPH != null && _storedPH != null &&
                Math.abs(_recomputedPH - _storedPH) > 0.005) {
              console.debug('[Auto-Sequence Value Drift Detection]', {
                orderId: order.id,
                item: order.item_description,
                previewProductionHours: _storedPH,
                wouldHaveRecomputed: _recomputedPH,
                drift: _recomputedPH - _storedPH,
                action: 'preserved preview value (plant/feedmill path)',
              });
            }

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
            const _dbOrdForLog = currentDbOrders.find(o => String(o.id) === orderIdStr);
            const _linkedGenOrder = currentDbOrders.find(o =>
              String(o.powermix_source_order_id) === orderIdStr &&
              (o.is_powermix_generated === true || o.is_powermix_generated === 'true')
            );
            const _linkedSrcOrder = _dbOrdForLog?.powermix_source_order_id
              ? currentDbOrders.find(o => String(o.id) === String(_dbOrdForLog.powermix_source_order_id))
              : null;
            const _linkedExistingAvailDate = (_linkedGenOrder || _linkedSrcOrder)?.target_avail_date || null;
            const _previewAvailDate = order.target_avail_date ? String(order.target_avail_date).substring(0, 10) : null;
            const _finalApplied = resolvedAvail || _previewAvailDate || null;
            console.debug('[Apply Schedule - Preview Date Preservation]', {
              line,
              feedmill: null,
              orderId: order.id,
              previewAvailDate: _previewAvailDate,
              linkedOrderExistingAvailDate: _linkedExistingAvailDate,
              finalAppliedAvailDate: _finalApplied,
              usedPreviewAvailDate: String(_finalApplied) === String(_previewAvailDate),
              wronglyOverriddenByLinkedOrder:
                _linkedExistingAvailDate != null &&
                String(_finalApplied) === String(_linkedExistingAvailDate) &&
                String(_previewAvailDate) !== String(_linkedExistingAvailDate),
            });
            console.debug('[Apply Schedule - Linked Order Override Check]', {
              line,
              feedmill: null,
              orderId: order.id,
              hasGeneratedOrSourceLink: !!(_linkedGenOrder || _linkedSrcOrder),
              previewAvailDate: _previewAvailDate,
              storedUnderlyingAvailDate: _dbOrdForLog?.target_avail_date || null,
              finalAppliedAvailDate: _finalApplied,
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

    // ── Pass 1.5: Powermix avail date sync ───────────────────────────────────
    // For every Powermix source/generated pair where the source order received a
    // new avail date from auto-sequence, ensure both orders end up with the same
    // date. Anchor rule: prefer the generated order's destination-line date (if
    // it was also updated), otherwise use the source order's new date.
    // This mutates regularUpdates entries in-place BEFORE Pass 2 sends them, so
    // no extra round-trip is needed.
    {
      const updatedByIdMap = new Map(regularUpdates.map(u => [String(u.id), u]));
      const pmxPairsLogged = new Set();

      for (const upd of [...regularUpdates]) {
        const dbOrder = currentDbOrders.find(o => String(o.id) === String(upd.id));
        if (!dbOrder) continue;

        // Match any non-generated source order that has a Powermix-generated
        // counterpart — previously limited to Line 5 sources, which missed
        // Line 7 source orders whose generated halves live on Line 5.
        const isPowermixSource =
          !(dbOrder.is_powermix_generated === true || dbOrder.is_powermix_generated === 'true');
        if (!isPowermixSource) continue;

        const genOrder = currentDbOrders.find(o =>
          String(o.powermix_source_order_id) === String(upd.id) &&
          (o.is_powermix_generated === true || o.is_powermix_generated === 'true')
        );
        if (!genOrder) continue;

        const pairKey = `${upd.id}:${genOrder.id}`;
        if (pmxPairsLogged.has(pairKey)) continue;
        pmxPairsLogged.add(pairKey);

        const generatedCurrentAvailDate = genOrder.target_avail_date || null;

        // Source and generated dates are INDEPENDENT — each order keeps its own
        // preview-selected date. The generated order's own preview date takes
        // absolute priority; the source date is a fallback only when the generated
        // order has no preview date of its own.
        const genUpd = updatedByIdMap.get(String(genOrder.id));
        const genUpdDate = genUpd?.data?.target_avail_date || null;
        const sourceNewDate = upd.data.target_avail_date || null;
        // Source order: already has its correct Pass-1-resolved date in upd.data —
        // do NOT override it here. The source keeps its own preview date.
        // Generated order: own preview date first, source date only as fallback.
        const generatedAppliedDate = genUpdDate || sourceNewDate || generatedCurrentAvailDate || null;

        console.debug('[Generated Order Avail Date Preservation]', {
          line: genOrder.feedmill_line || null,
          feedmill: genOrder._feedmill || null,
          generatedOrderId: genOrder.id,
          sourceOrderId: upd.id,
          previewGeneratedAvailDate: genUpdDate,
          sourceOrderAvailDate: sourceNewDate,
          finalAppliedGeneratedAvailDate: generatedAppliedDate,
          preservedPreviewGeneratedDate:
            genUpdDate != null && String(generatedAppliedDate) === String(genUpdDate),
          wronglyCopiedSourceDate:
            String(generatedAppliedDate) === String(sourceNewDate) &&
            genUpdDate != null &&
            String(genUpdDate) !== String(sourceNewDate),
        });
        console.debug('[Generated vs Source Date Independence]', {
          line: genOrder.feedmill_line || null,
          feedmill: genOrder._feedmill || null,
          generatedOrderId: genOrder.id,
          sourceOrderId: upd.id,
          previewGeneratedAvailDate: genUpdDate,
          previewSourceAvailDate: sourceNewDate,
          finalGeneratedAvailDate: generatedAppliedDate,
          finalSourceAvailDate: sourceNewDate,
        });

        // Always promote generated order to 'planned' when its source is being
        // sequenced — regardless of whether there is an avail date to sync.
        const _genNotInFlight = !['In Production', 'On-going', 'completed', 'cancel_po', 'done'].includes(genOrder.status || '');
        if (genUpd) {
          if (_genNotInFlight && !genUpd.data.status) {
            genUpd.data.status = 'planned';
          }
        } else if (_genNotInFlight) {
          regularUpdates.push({
            id: genOrder.id,
            data: { status: 'planned' },
          });
        }

        // Avail-date sync: only apply when there's a date to write to the generated order.
        if (!generatedAppliedDate) continue;

        // Source order: upd.data.target_avail_date is already correct from Pass 1.
        // Do not touch it — the source keeps its own preview date.

        // Generated order: apply its own independent preview date.
        const genUpdForDate = updatedByIdMap.get(String(genOrder.id));
        if (genUpdForDate) {
          genUpdForDate.data.target_avail_date = generatedAppliedDate;
        } else {
          regularUpdates.push({
            id: genOrder.id,
            data: {
              target_avail_date: generatedAppliedDate,
              avail_date_source: 'auto_sequence',
              ...(_genNotInFlight ? { status: 'planned' } : {}),
            },
          });
        }

        console.debug('[Powermix Avail Date Sync Applied]', {
          sourceOrderId: upd.id,
          generatedOrderId: genOrder.id,
          sourceAvailDateAfterSync: sourceNewDate,
          generatedAvailDateAfterSync: generatedAppliedDate,
          datesAreIndependent: generatedAppliedDate !== sourceNewDate,
          generatedUsedOwnPreviewDate: genUpdDate != null && generatedAppliedDate === genUpdDate,
          generatedFellBackToSourceDate: genUpdDate == null && sourceNewDate != null,
        });
      }
    }

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

      // ── Build history entries for this combination ─────────────────────────
      const _combineTs = formatTimestamp();
      const _survivingFPR = firstChildDb.fpr || '';
      const _absorbedFPRs = validChildren.map(c => c.fpr || `ID:${c.id}`).join(', ');
      const _volumeParts  = validChildren
        .map(c => `${parseFloat(c.volume || c.total_volume_mt || 0)} MT`)
        .join(' + ');
      const _leadHistEntry = {
        timestamp: _combineTs,
        action: `Combined group created: absorbed FPR ${_absorbedFPRs}`,
        details: `${_volumeParts} → ${adjustedCombinedVolume} MT total on ${line} after auto-sequencing`,
      };
      console.debug('[Order Combination History]', {
        action: 'combine_orders',
        survivingFPR: _survivingFPR,
        absorbedFPRs: validChildren.map(c => c.fpr),
        line,
        previousVolumes: validChildren.map(c => parseFloat(c.volume || c.total_volume_mt || 0)),
        newTotalVolume: adjustedCombinedVolume,
        triggeredBy: 'auto_sequencing',
      });

      let newLeadId;
      try {
        const newLead = await createOrderMutation.mutateAsync({
          fpr: firstChildDb.fpr,
          feedmill_line: line,
          priority_seq: prio,
          material_code: firstChildDb.material_code || firstChildDb.material_code_fg,
          material_code_fg: firstChildDb.material_code_fg || firstChildDb.material_code,
          material_code_sfg: firstChildDb.material_code_sfg,
          // Leave fg/sfg blank on the lead — children may have different values
          // and there is no single basis to use. The user fills these in manually.
          fg: "",
          sfg: "",
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
          history: [_leadHistEntry],
          ...(_combPh != null ? { production_hours: _combPh } : {}),
        });
        newLeadId = newLead.id;
        combinedLeadMap[orderIdStr] = newLeadId;
        console.log(`    [New lead] ${newLeadId} (${validChildIds.length} children, ${adjustedCombinedVolume} MT, raw ${combinedVolume} MT)`);
        console.debug('[Order Combination History Entry Written]', {
          orderFPR: _survivingFPR,
          entryType: 'lead_created',
          entryMessage: _leadHistEntry.action,
          combinedGroupId: newLeadId,
        });
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

      // Update all valid children in parallel — each gets its own history entry
      const freshDb = queryClient.getQueryData([ORDERS_QK]) || currentDbOrders;
      await Promise.all(validChildren.map(child => {
        const childDb = freshDb.find(o => String(o.id) === String(child.id));
        const preCombineStatus = childDb?.status || child.status || 'Plotted';
        const preCombineLine = childDb?.feedmill_line || child.feedmill_line || line;
        const preCombinePrio = childDb?.priority_seq ?? null;
        const preCombineOrigVol = parseFloat(childDb?.total_volume_mt || child.volume || 0) || null;
        const subResolvedAvail = _resolveAvail(child);

        const _childHistEntry = {
          timestamp: _combineTs,
          action: `Combined after auto-sequencing: merged into FPR ${_survivingFPR} on ${line}`,
          details: `Original volume: ${preCombineOrigVol ?? '?'} MT`,
        };
        const _existingChildHist = childDb?.history || [];
        console.debug('[Order Combination History Entry Written]', {
          orderFPR: child.fpr || `ID:${child.id}`,
          entryType: 'child_absorbed',
          entryMessage: _childHistEntry.action,
          combinedGroupId: newLeadId,
        });

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
            history: [..._existingChildHist, _childHistEntry],
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
    await queryClient.invalidateQueries({ queryKey: [ORDERS_QK] });
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
    await queryClient.invalidateQueries({ queryKey: [ORDERS_QK] });

    const totalOrders = Object.values(sequencedResults).reduce((s, lo) => s + lo.length, 0);
    const combinedCount = Object.keys(combinedLeadMap).length;
    const linesUsed = Object.keys(sequencedResults).filter(
      (l) => (sequencedResults[l] || []).length > 0
    ).length;
    console.debug('[Apply Schedule - Final Date Sort Basis]', {
      line: Object.keys(sequencedResults).join(', '),
      feedmill: null,
      appliedOrderIds: Object.values(sequencedResults).flat().map(o => o.id),
      appliedAvailDates: Object.fromEntries(
        Object.entries(sequencedResults).map(([ln, orders]) => [
          ln,
          orders.map(o => ({ id: o.id, previewAvailDate: o.target_avail_date || null })),
        ])
      ),
      sortingBasedOnPreviewSelectedDates: true,
    });
    console.debug('[Apply Schedule Generated Order Sort Basis]', {
      line: Object.keys(sequencedResults).join(', '),
      feedmill: null,
      appliedOrderIds: Object.values(sequencedResults).flat().map(o => o.id),
      appliedAvailDates: Object.fromEntries(
        Object.entries(sequencedResults).map(([ln, orders]) => [
          ln,
          orders.map(o => ({
            id: o.id,
            isGenerated: !!(o.is_powermix_generated === true || o.is_powermix_generated === 'true'),
            previewAvailDate: o.target_avail_date || null,
          })),
        ])
      ),
      sortingUsesAppliedPreviewDates: true,
    });
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
      const freshOrdersForCascade = queryClient.getQueryData([ORDERS_QK]) || [];
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
      setRebalanceDiversions(null);

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
    const fmLinesRaw = FEEDMILL_SEQ_LINES[feedmillKey] || [];
    if (fmLinesRaw.length === 0) {
      toast.error(`No lines configured for ${feedmillKey}.`);
      return;
    }
    // Exclude shutdown lines from this feedmill — they can't be destinations.
    const fmLines = fmLinesRaw.filter((l) => !isLineShutdown(l));
    const shutdownFMLines = fmLinesRaw.filter((l) => isLineShutdown(l));
    if (shutdownFMLines.length > 0) {
      console.debug('[Auto-Sequence Shutdown Line Block]', {
        feedmillKey,
        phase: 'feedmill_auto_sequence',
        excludedDestinationLines: shutdownFMLines,
        remainingDestinationLines: fmLines,
        reasonByLine: shutdownFMLines.reduce((acc, l) => {
          acc[l] = getShutdownReason(l) || 'shutdown'; return acc;
        }, {}),
      });
    }
    if (fmLines.length === 0) {
      toast.error(`All lines in ${feedmillKey} are currently in shutdown. Resume at least one line to auto-sequence.`);
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
        // Shutdown SOURCE lines are allowed — their eligible orders can be moved
        // onto active destinations. Shutdown DESTINATION lines are filtered out
        // of `fmLines` above so they will never be picked as targets.
        (originalSnapshot[srcLine] || []).forEach((order) => {
          if (seenOrderIds.has(order.id)) return; // already assigned to another FM line
          if (order.is_powermix_generated === true || order.is_powermix_generated === 'true') {
            console.debug('[AutoSequence Powermix Generated Order Move Attempt]', {
              orderId: order.id,
              sourceLine: srcLine,
              attemptedTargetLine: fmLine,
              blocked: true,
              reason: 'powermix_generated_line_locked',
            });
            return;
          }
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

      await queryClient.invalidateQueries({ queryKey: [ORDERS_QK] });
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

    if (isLineShutdown(targetLine)) {
      console.debug('[Auto-Sequence Shutdown Line Block]', {
        line: targetLine,
        phase: 'line_auto_sequence',
        action: 'reject_shutdown_target',
        reason: getShutdownReason(targetLine) || 'shutdown',
      });
      toast.error(`${targetLine} is currently in shutdown. Resume the line to auto-sequence.`);
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

      // Find all orders from OTHER lines that CAN run on target line.
      // Shutdown source lines ARE included — their eligible orders may be
      // pulled onto this (active) target line. The target itself was already
      // checked above and rejected with a toast if it is shutdown.
      const candidates = [];
      PLANT_ALL_LINES.forEach((line) => {
        if (line === targetLine) return;
        const lineOrders = originalSnapshot[line] || [];
        lineOrders.forEach((order) => {
          if (order.is_powermix_generated === true || order.is_powermix_generated === 'true') {
            console.debug('[AutoSequence Powermix Generated Order Move Attempt]', {
              orderId: order.id,
              sourceLine: line,
              attemptedTargetLine: targetLine,
              blocked: true,
              reason: 'powermix_generated_line_locked',
            });
            return;
          }
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

      await queryClient.invalidateQueries({ queryKey: [ORDERS_QK] });
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

  const handleAddOrder = async (orderData, aiPlacement = null) => {
    const isDateOrder =
      orderData.target_avail_date &&
      !isNaN(Date.parse(orderData.target_avail_date)) &&
      /^\d{4}-\d{2}-\d{2}/.test(orderData.target_avail_date);

    // Get active orders for this line sorted by priority_seq. Excludes sub-orders
    // (parent_id) so this apply basis EXACTLY mirrors the dialog's
    // buildInsertionLineup() — keeping the reviewed recommendation context and the
    // committed shift basis strictly consistent.
    const lineOrders = enrichedOrders
      .filter(
        (o) =>
          o.feedmill_line === orderData.feedmill_line &&
          !o.parent_id &&
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

    let ruleInsertionPrio;
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
      ruleInsertionPrio = foundPrio ?? lineOrders.length + 1;
    } else {
      ruleInsertionPrio = lineOrders.length + 1;
    }

    // ── Apply the REVIEWED AI placement verbatim ──────────────────────────────
    // If the confirm modal showed an AI recommendation, the applied priority MUST
    // equal the reviewed targetPrioritySeq. Fall back to the date-based rule only
    // when AI was unavailable. Action constraint for Add: the chosen line must be
    // a valid production line for the order (enforced upstream in the dialog by
    // restricting line options to lines with a run rate > 0).
    const usedAi = !!(aiPlacement && !aiPlacement.error && Number.isFinite(Number(aiPlacement.targetPrioritySeq)));
    const insertionPrio = usedAi ? Number(aiPlacement.targetPrioritySeq) : ruleInsertionPrio;

    console.debug("[AI Insertion Action Constraints]", {
      modalType: "add",
      targetLine: orderData.feedmill_line,
      runRatePresent: orderData.run_rate != null,
      lineValidForOrder: orderData.run_rate != null,
      isDateOrder,
      constraintsSatisfied: true,
    });
    console.debug("[AI Insertion Final Apply Consistency]", {
      modalType: "add",
      usedAiInsertionEngine: usedAi,
      reviewedPriority: usedAi ? Number(aiPlacement.targetPrioritySeq) : null,
      appliedPriority: insertionPrio,
      ruleFallbackPriority: ruleInsertionPrio,
      consistent: usedAi ? Number(aiPlacement.targetPrioritySeq) === insertionPrio : true,
    });

    // Shift orders at or below insertion point down by 1
    const ordersToShift = lineOrders.filter(
      (o) => (o.priority_seq ?? 999) >= insertionPrio,
    );

    try {
      const _addHistTs = formatTimestamp();
      const _addHistEntry = {
        timestamp: _addHistTs,
        action: 'Order Created',
        details: `Added via Add Order on ${orderData.feedmill_line} at Prio ${insertionPrio}.`,
      };
      const createdOrder = await createOrderMutation.mutateAsync({
        ...orderData,
        priority_seq: insertionPrio,
        status: "plotted",
        history: [_addHistEntry],
      });

      console.debug('[Order History Add Order Created]', {
        orderId: String(createdOrder?.id ?? 'unknown'),
        createdVia: 'Add Order',
        timestamp: _addHistTs,
      });
      console.debug('[Order History Event Recorded]', {
        orderId: String(createdOrder?.id ?? 'unknown'),
        eventType: 'Order Created',
        timestamp: _addHistTs,
      });

      console.debug('[Add Order Final Insert Source]', {
        orderId: createdOrder?.id ?? 'unknown',
        sourceOfTruth: 'first_add_order_modal',
        secondConfirmationStepUsed: false,
        appliedPrioritySeq: insertionPrio,
        usedAiInsertionEngine: usedAi,
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

    const _seqIsRealISO = (v) => !!v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) && !isNaN(Date.parse(v));

    // In-flight / frozen statuses (normalized: project uses both Title-Case and
    // lowercase snake_case variants, e.g. 'In Production' / 'in_production',
    // 'On-going' / 'ongoing_batching').
    const _isInFlightStatus = (s) => {
      const v = String(s || '').toLowerCase().replace(/[\s-]+/g, '_');
      return (
        v === 'in_production' ||
        v === 'on_going' ||
        v.startsWith('ongoing') ||
        v === 'completed' ||
        v === 'complete' ||
        v === 'cancel_po' ||
        v === 'cancelled' ||
        v === 'done'
      );
    };

    // Resolve the avail date each row will actually carry AFTER apply. The preview's
    // effective avail date (p.appliedAvailDate) is the single source of truth shared by
    // the display, the persisted write, and this sort key — guaranteeing WYSIWYG:
    //  - Category B/D place the previewed date (real ISO or the 'stock_sufficient' sentinel)
    //  - Category A/C (or B/D with no placed date) keep their existing stored avail date
    // 'stock_sufficient' (or any non-ISO sentinel) resolves to null → sorts last.
    const _resolveAppliedAvailMs = (p) => {
      const original = orders.find((o) => o.id === p.id) || {};
      const _applied = p.appliedAvailDate;
      // Mirror the exact value that will be persisted to target_avail_date:
      //  - B/D place the previewed date (real ISO or 'stock_sufficient')
      //  - everything else keeps the order's existing stored avail date
      const effective =
        (p.category === 'B' || p.category === 'D') &&
        (_seqIsRealISO(_applied) || _applied === 'stock_sufficient')
          ? _applied
          : (original.target_avail_date || null);
      return _seqIsRealISO(effective) ? Date.parse(effective) : null;
    };

    // Chronological sort: once avail dates are placed, the applied rows must appear
    // in ascending avail-date order. Combined groups stay contiguous (ordered by the
    // lead's date), in-flight/frozen orders stay pinned on top, and rows with no real
    // placed date keep their relative order at the end.
    const _groups = [];
    {
      let gi = 0;
      while (gi < compacted.length) {
        const head = compacted[gi];
        const group = [head];
        let gj = gi + 1;
        while (gj < compacted.length && childLeadIdMap[compacted[gj].id] === head.id) {
          group.push(compacted[gj]);
          gj++;
        }
        _groups.push(group);
        gi = gj;
      }
    }
    const _frozenGroups = [];
    const _datedGroups = [];
    const _undatedGroups = [];
    _groups.forEach((group, idx) => {
      const headOrder = orders.find((o) => o.id === group[0].id);
      const ms = _resolveAppliedAvailMs(group[0]);
      const entry = { group, idx, ms };
      if (headOrder && _isInFlightStatus(headOrder.status)) {
        _frozenGroups.push(entry);
      } else if (ms != null) {
        _datedGroups.push(entry);
      } else {
        _undatedGroups.push(entry);
      }
    });
    _frozenGroups.sort((a, b) => a.idx - b.idx);
    _datedGroups.sort((a, b) => (a.ms !== b.ms ? a.ms - b.ms : a.idx - b.idx));
    _undatedGroups.sort((a, b) => a.idx - b.idx);
    const _sortedCompacted = [..._frozenGroups, ..._datedGroups, ..._undatedGroups]
      .flatMap((e) => e.group);
    compacted.length = 0;
    compacted.push(..._sortedCompacted);
    compacted.forEach((row, i) => { row.proposedPrio = i + 1; });

    console.debug('[Applied Schedule Avail Date Sort]', {
      appliedOrderIds: compacted.map((p) => p.id),
      appliedAvailDates: compacted.map((p) => {
        const ms = _resolveAppliedAvailMs(p);
        return ms != null ? new Date(ms).toISOString().slice(0, 10) : null;
      }),
      sortedChronologicallyByAvailDate: true,
    });

    // Step 1: Apply new priority_seq + start dates + avail date updates for non-dated orders.
    // Category B = has N10D target date, Category D = stock sufficient

    console.debug('[Auto-Sequence Apply Source Of Truth]', {
      totalOrders: compacted.length,
      snapshot: compacted.map(p => ({
        id: p.id,
        proposedPrio: p.proposedPrio,
        production_hours: p.production_hours ?? null,
        targetDate: p.targetDate ?? null,
        availDate: p.availDate ?? null,
        category: p.category ?? null,
        startDate: p.startDate ?? null,
        estimatedCompletion: p.estimatedCompletion ?? null,
      })),
    });

    await Promise.all(
      compacted.map((p) => {
        const _existingOrder = orders.find((o) => o.id === p.id);
        const _currentStatus = _existingOrder?.status || '';
        const updateData = {
          priority_seq: p.proposedPrio,
          ...(!_isInFlightStatus(_currentStatus) ? { status: 'planned' } : {}),
        };

        // Write production_hours from the preview snapshot so cascadeSchedule
        // doesn't overwrite with a differently-rounded value (batch-ceiling vs raw volume).
        if (p.production_hours != null && !_existingOrder?.production_hours_manual) {
          updateData.production_hours = p.production_hours;
        }

        // Write start_date/time from the preview result.
        // Manual flag: true only if the user explicitly set it in the preview.
        // For non-first, non-manual orders the preview now sends null, which
        // clears any stale system-carried value from a prior sequence run.
        const _isFirstOrder = p.proposedPrio === 1;
        if (p.startDate) {
          updateData.start_date = p.startDate;
          updateData.start_date_manual = p.isManualStartDate === true;
        } else if (!_isFirstOrder) {
          // Explicitly clear stale non-manual start_date for non-first orders
          updateData.start_date = null;
          updateData.start_date_manual = false;
        }
        if (p.startTime) {
          updateData.start_time = p.startTime;
          updateData.start_time_manual = p.isManualStartTime === true;
        } else if (!_isFirstOrder) {
          updateData.start_time = null;
          updateData.start_time_manual = false;
        }

        // For N10D-driven orders (B = targeted, D = stock sufficient), place the
        // exact avail date the preview displayed (p.appliedAvailDate) so the applied
        // schedule is WYSIWYG. Only mark the order auto-sequence-sourced when a real
        // date (or the 'stock_sufficient' sentinel) is actually placed — otherwise we
        // would corrupt future runs by flagging an order auto_sequence without a date.
        if (p.category === 'B' || p.category === 'D') {
          const original = orders.find((o) => o.id === p.id);
          const _applied = p.appliedAvailDate;
          const _isPlaceable = _seqIsRealISO(_applied) || _applied === 'stock_sufficient';
          if (_isPlaceable) {
            // Preserve the original avail date before overwriting (only on first auto-sequence)
            if (original && original.avail_date_source !== 'auto_sequence') {
              updateData.original_avail_date = original.target_avail_date || null;
            }
            updateData.avail_date_source = 'auto_sequence';
            updateData.target_avail_date = _applied;
            updateData.last_target_date = _applied;
          }
        }

        console.debug('[Auto-Sequence Preview vs Apply]', {
          orderId: p.id,
          previewProductionHours: p.production_hours ?? null,
          dbProductionHours: _existingOrder?.production_hours ?? null,
          willWriteProductionHours: updateData.production_hours ?? null,
          previewAvailDate: p.availDate ?? null,
          previewTargetDate: p.targetDate ?? null,
          category: p.category ?? null,
          willWriteAvailDate: updateData.target_avail_date ?? 'unchanged',
        });

        // Mandated: verify the previewed avail date/placement equals what is applied.
        // Compute the effective preview date on the SAME category basis the apply/sort
        // logic uses (targetDate precedence for B/D, sentinel handling) so the
        // comparison doesn't emit false mismatches when the applied date legitimately
        // comes from the N10D target rather than the raw preview availDate.
        const _effectivePreviewAvailDate =
          p.appliedAvailDate ?? _existingOrder?.target_avail_date ?? null;
        const _appliedAvailDate = updateData.target_avail_date
          ?? _existingOrder?.target_avail_date ?? null;
        console.debug('[Auto-Sequence Preview vs Apply Date Consistency]', {
          feedmillLine: _existingOrder?.feedmill_line ?? null,
          orderId: p.id,
          category: p.category ?? null,
          previewAvailDate: _effectivePreviewAvailDate,
          appliedAvailDate: _appliedAvailDate,
          previewPlacement: p.proposedPrio,
          appliedPlacement: updateData.priority_seq,
          availDateMatches: String(_effectivePreviewAvailDate) === String(_appliedAvailDate),
        });

        return updateOrderMutation.mutateAsync({ id: p.id, data: updateData });
      }),
    );

    // Step 2: Build the reordered list with the freshest start-date values so
    // cascadeSchedule can compute correct completion dates for the NEW sequence.
    // Also carry the preview production_hours so the cascade doesn't recompute a
    // different value from batch-rounded volume.
    const orderedForCascade = compacted.map((p) => {
      const original = orders.find((o) => o.id === p.id) || {};
      return {
        ...original,
        priority_seq: p.proposedPrio,
        start_date: p.startDate || original.start_date || null,
        start_time: p.startTime || original.start_time || null,
        ...(p.production_hours != null ? { production_hours: p.production_hours } : {}),
      };
    });

    // Step 3: Recalculate ALL completion dates from the beginning of the new sequence.
    // preserveProductionHours=true: skip recalculation from volume/run_rate so the
    // times match exactly what the user approved in the preview.
    await cascadeSchedule(orderedForCascade, 0, { preserveProductionHours: true });

    toast.success("Auto-sequence applied successfully.");
    playSuccessNotificationSound();
  };

  // Handle navigation — now also accepts feedmill
  const handleNavigate = (section, subSection, feedmill) => {
    setActiveSection(section);
    setActiveSubSection(subSection || "all");
    if (feedmill) {
      setActiveFeedmill(feedmill);
    } else if (section === "fulfillment_demo") {
      // The demo workspace has no per-feedmill selector; its "All Feedmills"
      // board must always show the cross-line view. Force ALL_FM so the demo
      // never inherits a single-feedmill scope from the previously active live tab.
      setActiveFeedmill("ALL_FM");
    }
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
        const { kbMap: uploadKBMap } = buildLocalKBMap(uploadKBRecords);

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

        // ── Missing-line fallback ──────────────────────────────────────────────
        // Orders where the SAP "Feedmill Line" column was blank are auto-assigned
        // using: form (MX → Line 5), historical KB run-rate applicability, then
        // queue time. Line 5 is treated as an MX-only line and never considered
        // for non-MX (pelleting) orders.
        //
        // Staged flow:
        //   Stage 1 — valid-line orders are counted first (they represent the
        //             "just placed" schedule that the queue-time calculation must
        //             reflect, even on a first-time upload).
        //   Stage 2 — only then are missing-line orders detected and assigned,
        //             using queue times that include the Stage 1 load.
        {
          const PELLETING_LINES_FALLBACK = ["Line 1", "Line 2", "Line 3", "Line 4", "Line 6", "Line 7"];

          // ── Stage 1: count valid-line orders as "placed first" ──────────────
          // Separate the batch so queue-time always reflects the real workload
          // that will exist after direct-line orders are inserted.
          const validLineOrders   = parsedWithKB.filter((o) => !!o.feedmill_line);
          const missingLineOrders = parsedWithKB.filter((o) => !o.feedmill_line);

          console.debug("[SAP Upload Stage 1 Valid-Line Placement]", {
            uploadedOrderCount:  parsedWithKB.length,
            validLineOrderCount: validLineOrders.length,
            missingLineOrderCount: missingLineOrders.length,
            validLineOrdersPlacedFirst: true,
          });

          // Current MT queued on each line from orders already in the DB
          const existingLineMT = {};
          for (const pl of [...PELLETING_LINES_FALLBACK, "Line 5"]) {
            existingLineMT[pl] = existingOrders
              .filter((o) => o.feedmill_line === pl && !_UPLOAD_EXCLUDED_STATUSES.has(o.status))
              .reduce((s, o) => s + (parseFloat(o.total_volume_mt) || 0), 0);
          }

          // Pre-populate with Stage 1 (valid-line) upload volumes so the
          // queue-time basis already reflects the "just placed" workload.
          const uploadedLineMT = {};
          for (const o of validLineOrders) {
            const line = o.feedmill_line;
            uploadedLineMT[line] = (uploadedLineMT[line] || 0) + (parseFloat(o.total_volume_mt) || 0);
          }

          // ── Stage 2: detect and assign missing-line orders ──────────────────
          console.debug("[SAP Upload Stage 2 Missing-Line Detection]", {
            missingLineOrdersDetected: missingLineOrders.map((o) => ({
              orderId:      o.fpr || o.material_code,
              materialCode: o.material_code,
            })),
          });

          console.debug("[SAP Upload Queue Time Basis After Initial Placement]", {
            queueTimeCalculatedAfterValidLinePlacement: true,
            currentLineLoadsUsedForFallback: true,
          });

          for (const order of missingLineOrders) {
            const orderId      = order.fpr || order.material_code;
            const materialCode = String(order.material_code || "").trim();
            const form         = String(order.form || "").trim();
            const isMXOrder    =
              form.toUpperCase() === "MX" || form.toLowerCase() === "mix";

            let selectedLine = null;
            let fallbackPath = "";

            if (isMXOrder) {
              // MX products belong exclusively on Line 5 — no queue-time needed
              selectedLine = "Line 5";
              fallbackPath = "mx_direct_line5";
            } else {
              // Determine which pelleting lines this SKU has KB run-rate data for
              const applicableLinesFromMasterData = PELLETING_LINES_FALLBACK.filter((line) => {
                const rrKey   = RUN_RATE_COL[line];
                const kbEntry = uploadKBMap[materialCode];
                return rrKey && kbEntry && parseFloat(kbEntry[rrKey] || 0) > 0;
              });

              console.debug("[SAP Upload Missing Line Historical Applicability]", {
                orderId, materialCode,
                applicableLinesFromMasterData,
                applicableLineCount: applicableLinesFromMasterData.length,
              });

              if (applicableLinesFromMasterData.length === 1) {
                // Exactly one known pelleting line — assign directly, no queue calc
                selectedLine = applicableLinesFromMasterData[0];
                fallbackPath = "single_applicable_pelleting_line_direct_assign";
              } else {
                const candidateLines =
                  applicableLinesFromMasterData.length > 1
                    ? applicableLinesFromMasterData
                    : PELLETING_LINES_FALLBACK; // no KB history → all FM1-FM3

                fallbackPath =
                  applicableLinesFromMasterData.length > 1
                    ? "multiple_applicable_pelleting_lines_lowest_queue_time"
                    : "no_applicable_history_lowest_queue_time_fm1_fm3";

                // Queue time = (existing MT + already-assigned upload MT) / line run rate
                const queueTimesByLine = {};
                for (const cl of candidateLines) {
                  const curMT = (existingLineMT[cl] || 0) + (uploadedLineMT[cl] || 0);
                  const rr    = getLineRunRate(cl);
                  queueTimesByLine[cl] = rr > 0 ? curMT / rr : Infinity;
                }
                selectedLine = candidateLines.reduce(
                  (best, cl) =>
                    queueTimesByLine[cl] < (queueTimesByLine[best] ?? Infinity) ? cl : best,
                  candidateLines[0],
                );

                console.debug("[SAP Upload Missing Line Queue-Time Assignment]", {
                  orderId, materialCode, candidateLines, queueTimesByLine, selectedLine,
                });
              }
            }

            console.debug("[SAP Upload Missing Line Fallback Path]", {
              orderId, materialCode, fallbackPath,
            });

            // Commit line assignment
            order.feedmill_line           = selectedLine;
            order._autoAssignedLine       = true;
            order._autoAssignedLineSource = "missing_feedmill_line_fallback";

            // Accumulate this order's MT so subsequent missing-line orders
            // see it when choosing the lowest-queue-time line.
            uploadedLineMT[selectedLine] =
              (uploadedLineMT[selectedLine] || 0) + (parseFloat(order.total_volume_mt) || 0);

            // Re-apply KB fields for the newly assigned line (batch_size, run_rate)
            const kbEntry = uploadKBMap[materialCode];
            if (kbEntry) {
              const newBsKey = BATCH_SIZE_COL[selectedLine];
              if (newBsKey && kbEntry[newBsKey] != null && kbEntry[newBsKey] !== "") {
                order.batch_size = kbEntry[newBsKey];
              }
              const newRrKey = RUN_RATE_COL[selectedLine];
              if (newRrKey && kbEntry[newRrKey] != null && kbEntry[newRrKey] !== "") {
                order.run_rate = kbEntry[newRrKey];
              }
              // Recompute production_hours with the now-correct batch_size / run_rate
              const rr = parseFloat(order.run_rate);
              if (rr > 0 && order.form !== "M" && !order.production_hours_manual) {
                const sugVol =
                  order.batch_size > 0
                    ? Math.ceil((order.total_volume_mt || 0) / order.batch_size) *
                      order.batch_size
                    : order.total_volume_mt || 0;
                order.production_hours = parseFloat((sugVol / rr).toFixed(2));
              }
            }

            // Line 5: mirror the explicit Line 5 handler (sap_sfg1 → pmx)
            if (selectedLine === "Line 5") {
              order.pmx     = order.sap_sfg1 || "";
              order.sap_sfg1 = "";
            }

            // Update the history entry to reflect auto-assignment
            if (order.history && order.history[0]) {
              order.history[0].details =
                `Imported from SAP file. Feedmill Line was blank — auto-assigned to ${selectedLine} (${fallbackPath.replace(/_/g, " ")}).`;
            }

            console.debug("[SAP Upload Missing-Line Final Assignment]", {
              orderId, materialCode,
              selectedLine, fallbackPath,
            });
          }
        }
        // ── End missing-line fallback ──────────────────────────────────────────

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
        await queryClient.invalidateQueries({ queryKey: [ORDERS_QK] });

        // Auto-apply Powermix split rules for any Line 5/7 orders in the upload.
        // In the demo workspace we pass ?workspace=demo so the SAME split logic runs
        // against demo_orders only — full live parity for generated Powermix orders
        // with zero impact on the live orders table.
        try {
          const applyUrl = isDemo
            ? "/api/powermix/apply-all?workspace=demo"
            : "/api/powermix/apply-all";
          await fetch(applyUrl, { method: "POST" });
          await queryClient.invalidateQueries({ queryKey: [ORDERS_QK] });
        } catch (e) {
          console.warn("[Powermix] Auto-apply after upload failed:", e);
        }

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
            queryClient.invalidateQueries({ queryKey: [ORDERS_QK] });
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
    queryClient.invalidateQueries({ queryKey: [ORDERS_QK] });
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

  // Pure synchronous computation — returns the updates array without touching the server or cache.
  // Shared by cascadeSchedule (apply path) and the optimistic pre-patch in handleUpdateOrder.
  const computeCascadeUpdates = (orderedList, startFromIndex = 0, { preserveProductionHours = false } = {}) => {
    const updates = [];
    let prevCompletion = null;
    let prevChangeover = 0;

    for (let i = 0; i < orderedList.length; i++) {
      const order = orderedList[i];

      if (order.status === "completed" || order.status === "cancel_po") {
        const d = parseCompletionDateStr(order.target_completion_date);
        if (d) prevCompletion = d;
        prevChangeover = parseFloat(order._changeoverTotal ?? order.changeover_time ?? 0.17);
        continue;
      }

      if (i < startFromIndex) {
        const stored = parseCompletionDateStr(order.target_completion_date);
        if (stored) prevCompletion = stored;
        else prevCompletion = null;
        prevChangeover = parseFloat(order._changeoverTotal ?? order.changeover_time ?? 0.17);
        continue;
      }

      let updatedOrder = { ...order };

      if (!preserveProductionHours && !updatedOrder.production_hours_manual) {
        updatedOrder.production_hours = calcProductionHours(updatedOrder);
      } else if (preserveProductionHours && !updatedOrder.production_hours_manual) {
        const _wouldRecompute = calcProductionHours(updatedOrder);
        if (_wouldRecompute != null && updatedOrder.production_hours != null &&
            Math.abs(Number(_wouldRecompute) - Number(updatedOrder.production_hours)) > 0.005) {
          console.debug('[Auto-Sequence Value Drift Detection]', {
            orderId: order.id,
            previewProductionHours: updatedOrder.production_hours,
            wouldHaveRecomputed: _wouldRecompute,
            drift: Number(_wouldRecompute) - Number(updatedOrder.production_hours),
            action: 'preserved preview value (per-line cascade)',
          });
        }
      }

      if (updatedOrder.target_completion_manual) {
        prevCompletion = parseCompletionDateStr(updatedOrder.target_completion_date);
        prevChangeover = parseFloat(updatedOrder._changeoverTotal ?? updatedOrder.changeover_time ?? 0.17);
        const changed = updatedOrder.production_hours !== order.production_hours;
        if (changed) {
          updates.push({ id: order.id, data: { production_hours: updatedOrder.production_hours } });
        }
        continue;
      }

      let newCompletion = null;
      let effectiveStartDate = updatedOrder.start_date;
      let effectiveStartTime = updatedOrder.start_time;

      if (effectiveStartDate && !effectiveStartTime) {
        effectiveStartTime = "08:00";
      }

      const _todayStr = (() => {
        const t = new Date();
        return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
      })();

      if (effectiveStartDate && effectiveStartTime) {
        // Both explicitly set → use as direct anchor
        const ph = updatedOrder.production_hours != null ? parseFloat(updatedOrder.production_hours) : 0;
        newCompletion = calcCompletionDate(effectiveStartDate, effectiveStartTime, ph, 0);
      } else if (!effectiveStartDate && effectiveStartTime) {
        // Time set but no date (e.g. first active order after completed ones, user edited time only).
        // Use prevCompletion's date if available (same calendar day as handoff), else today.
        // This prevents completed orders' prevCompletion from being used as the TIME anchor and
        // ignoring the manually entered start_time.
        const ph = updatedOrder.production_hours != null ? parseFloat(updatedOrder.production_hours) : 0;
        const anchorDate = prevCompletion
          ? `${prevCompletion.getFullYear()}-${String(prevCompletion.getMonth() + 1).padStart(2, "0")}-${String(prevCompletion.getDate()).padStart(2, "0")}`
          : _todayStr;
        newCompletion = calcCompletionDate(anchorDate, effectiveStartTime, ph, 0);
      } else if (prevCompletion) {
        // Auto-cascade: start = prevCompletion + PREVIOUS order's changeover
        const ph = updatedOrder.production_hours != null ? parseFloat(updatedOrder.production_hours) : 0;
        const startMs = prevCompletion.getTime() + prevChangeover * 3600000;
        newCompletion = new Date(startMs + ph * 3600000);
      } else {
        // No start_time, no prevCompletion → anchor to today 08:00
        const ph = updatedOrder.production_hours != null ? parseFloat(updatedOrder.production_hours) : 0;
        newCompletion = calcCompletionDate(_todayStr, "08:00", ph, 0);
      }

      const newCompletionStr = newCompletion ? formatCompletionDate(newCompletion) : null;
      prevCompletion = newCompletion;
      prevChangeover = parseFloat(updatedOrder._changeoverTotal ?? updatedOrder.changeover_time ?? 0.17);

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

    return updates;
  };

  const cascadeSchedule = async (orderedList, startFromIndex = 0, { preserveProductionHours = false } = {}) => {
    const updates = computeCascadeUpdates(orderedList, startFromIndex, { preserveProductionHours });
    if (updates.length === 0) return;

    // Optimistic patch — reflect cascade instantly in the UI before any server round-trip.
    const patchMap = Object.fromEntries(updates.map(u => [u.id, u.data]));
    queryClient.setQueryData([ORDERS_QK], (old) => {
      if (!Array.isArray(old)) return old;
      return old.map(o => patchMap[o.id] ? { ...o, ...patchMap[o.id] } : o);
    });

    // Single batch request — one DB transaction, one invalidation, no cache thrashing.
    await batchUpdateOrderMutation.mutateAsync(updates);
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

    // Optimistic pre-patch — reflect new row positions and cascade dates instantly,
    // before any server round-trip. Server saves happen in the background below.
    const seqPatchMap = {};
    reordered.forEach((o, i) => {
      if (o && o.priority_seq !== i) seqPatchMap[o.id] = i;
    });
    if (Object.keys(seqPatchMap).length > 0) {
      queryClient.setQueryData([ORDERS_QK], (old) => {
        if (!Array.isArray(old)) return old;
        return old.map((o) =>
          seqPatchMap[o.id] !== undefined ? { ...o, priority_seq: seqPatchMap[o.id] } : o,
        );
      });
    }
    if (reordered[0]) {
      const _cascadeUpdates = computeCascadeUpdates(reordered, 0);
      if (_cascadeUpdates.length > 0) {
        const _cascadePatch = Object.fromEntries(_cascadeUpdates.map((u) => [u.id, u.data]));
        queryClient.setQueryData([ORDERS_QK], (old) => {
          if (!Array.isArray(old)) return old;
          return old.map((o) => (_cascadePatch[o.id] ? { ...o, ..._cascadePatch[o.id] } : o));
        });
      }
    }

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

    // Snapshot: capture the IDs of orders that are currently in production/completed
    // at the exact moment shutdown is triggered. All shutdown-specific protection
    // (diversion exclusion, status option gating) is based on this snapshot, NOT
    // on lifetime history. The snapshot is cleared automatically when the line resumes.
    const _snapIneligibleStatuses = new Set([
      'in_production', 'ongoing_batching', 'ongoing_pelleting', 'ongoing_bagging',
      'completed', 'done',
    ]);
    const _snapLineOrders = (scheduledOrders || []).filter(
      (o) => (o.feedmill_line || o.line) === line && !o.parent_id && o.status !== 'cancel_po'
    );
    const _snapProtectedIds = _snapLineOrders
      .filter(o => _snapIneligibleStatuses.has((o.status || '').toLowerCase()))
      .map(o => String(o.id));

    // Log snapshot evaluation per order on this line
    _snapLineOrders.forEach(o => {
      const _curStatus = (o.status || '').toLowerCase();
      console.debug('[Shutdown Snapshot Evaluation]', {
        lineId: line,
        orderId: o.id,
        currentStatusAtShutdown: o.status,
        treatedAsProtectedOperationalOrder: _snapIneligibleStatuses.has(_curStatus),
      });
    });

    setLineShutdowns(prev => ({
      ...prev,
      [line]: {
        isShutdown: true,
        reason: shutdownData.reason,
        notes: shutdownData.notes || '',
        since,
        feedmill: fm,
        shutdownType: shutdownData.shutdownType || 'unplanned',
        startDateTime: shutdownData.startDateTime || null,
        endDateTime: shutdownData.endDateTime || null,
        durationHours: shutdownData.durationHours || 0,
        protectedOrderIds: _snapProtectedIds,
      },
    }));
    setShutdownHistory(prev => [
      {
        id: `${Date.now()}_${line}`,
        line,
        feedmill: fm,
        shutdownType: shutdownData.shutdownType || 'unplanned',
        reason: shutdownData.reason,
        notes: shutdownData.notes || '',
        startDateTime: shutdownData.startDateTime || null,
        endDateTime: shutdownData.endDateTime || null,
        durationHours: shutdownData.durationHours || 0,
        since,
      },
      ...prev,
    ].slice(0, 50));
    console.debug('[Shutdown Input]', {
      lineId: line,
      shutdownType: shutdownData.shutdownType,
      shutdownReason: shutdownData.reason,
      startDateTime: shutdownData.startDateTime,
      endDateTime: shutdownData.endDateTime,
      durationHours: shutdownData.durationHours,
    });

    const _sdEligible = _snapLineOrders.filter(o => !_snapIneligibleStatuses.has((o.status || '').toLowerCase()));
    const _sdExcludedIP = _snapLineOrders.filter(o => {
      const s = (o.status || '').toLowerCase();
      return s === 'in_production' || s === 'ongoing_batching' || s === 'ongoing_pelleting' || s === 'ongoing_bagging';
    });
    const _sdExcludedDone = _snapLineOrders.filter(o => {
      const s = (o.status || '').toLowerCase();
      return s === 'completed' || s === 'done';
    });
    console.debug('[Shutdown Diversion Candidate Filter]', {
      lineId: line,
      shutdownId: since,
      totalOrders: _snapLineOrders.length,
      eligibleOrders: _sdEligible.length,
      excludedInProductionOrders: _sdExcludedIP.length,
      excludedCompletedOrders: _sdExcludedDone.length,
    });

    const typeLabel = shutdownData.shutdownType === 'planned' ? 'Planned' : 'Unplanned';
    toast.success(`${line} shut down (${typeLabel}). Reason: ${shutdownData.reason}.`);
  };

  const handleResumeLine = (line, fm) => {
    // Capture the shutdownEventId before clearing — used in the reset log below.
    const _resumeShutdownEventId = lineShutdowns[line]?.since || null;
    setLineShutdowns(prev => {
      const updated = { ...prev };
      delete updated[line]; // Clears isShutdown, protectedOrderIds, and all snapshot state.
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
    // Snapshot state (protectedOrderIds) is automatically cleared by deleting lineShutdowns[line].
    // The next shutdown will take a fresh snapshot based on status at that time.
    console.debug('[Shutdown State Reset On Resume]', {
      lineId: line,
      shutdownEventId: _resumeShutdownEventId,
      clearedShutdownProtectedState: true,
    });
    const _allowedStatuses = ['plotted', 'planned', 'hold', 'cut', 'ongoing_batching', 'ongoing_pelleting', 'ongoing_bagging', 'completed', 'cancel_po'];
    console.debug('[Shutdown Status Options Restored]', {
      lineId: line,
      shutdownActive: false,
      allowedStatuses: _allowedStatuses,
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

    // Snapshot: compute protectedOrderIds per line at the moment of feedmill shutdown.
    const _fmSnapIneligible = new Set([
      'in_production', 'ongoing_batching', 'ongoing_pelleting', 'ongoing_bagging',
      'completed', 'done',
    ]);
    const _fmLineSnapshots = {};
    fmLines.forEach(line => {
      const _lineOrders = (scheduledOrders || []).filter(
        o => (o.feedmill_line || o.line) === line && !o.parent_id && o.status !== 'cancel_po'
      );
      _fmLineSnapshots[line] = _lineOrders
        .filter(o => _fmSnapIneligible.has((o.status || '').toLowerCase()))
        .map(o => String(o.id));
      _lineOrders.forEach(o => {
        console.debug('[Shutdown Snapshot Evaluation]', {
          lineId: line,
          orderId: o.id,
          currentStatusAtShutdown: o.status,
          treatedAsProtectedOperationalOrder: _fmSnapIneligible.has((o.status || '').toLowerCase()),
        });
      });
    });

    setLineShutdowns(prev => {
      const updated = { ...prev };
      fmLines.forEach(line => {
        updated[line] = {
          isShutdown: true,
          reason: shutdownData.reason,
          notes: shutdownData.notes || '',
          since,
          feedmill: fm,
          isFeedmillShutdown: true,
          shutdownType: shutdownData.shutdownType || 'unplanned',
          startDateTime: shutdownData.startDateTime || null,
          endDateTime: shutdownData.endDateTime || null,
          durationHours: shutdownData.durationHours || 0,
          protectedOrderIds: _fmLineSnapshots[line] || [],
        };
      });
      console.debug('[Shutdown Input]', {
        lineId: `feedmill:${fm}`,
        shutdownType: shutdownData.shutdownType,
        shutdownReason: shutdownData.reason,
        startDateTime: shutdownData.startDateTime,
        endDateTime: shutdownData.endDateTime,
        durationHours: shutdownData.durationHours,
      });
      return updated;
    });
    setShutdownHistory(prev => [
      {
        id: `${Date.now()}_${fm}`,
        line: fmLines.join(', '),
        feedmill: fm,
        isFeedmillShutdown: true,
        shutdownType: shutdownData.shutdownType || 'unplanned',
        reason: shutdownData.reason,
        notes: shutdownData.notes || '',
        startDateTime: shutdownData.startDateTime || null,
        endDateTime: shutdownData.endDateTime || null,
        durationHours: shutdownData.durationHours || 0,
        since,
      },
      ...prev,
    ].slice(0, 50));
    setFeedmillStatus(prev => ({
      ...prev,
      [fm]: { isShutdown: true, shutdownDate: since.slice(0, 10), reason: shutdownData.reason, notes: shutdownData.notes || '', affectedLines: fmLines },
    }));
    const fmName = { FM1: 'Feedmill 1', FM2: 'Feedmill 2', FM3: 'Feedmill 3', PMX: 'Powermix' }[fm] || fm;
    toast.success(`${fmName} has been shut down. All lines marked as shutdown.`);
  };

  const handleDivertOrderConfirm = async (order, selectedLine, calcs, aiText) => {
    // Hard guard: orders that are currently in production/completed, OR were in that state
    // at the moment this shutdown was triggered (per snapshot), must never be diverted.
    // Uses per-event snapshot (protectedOrderIds), NOT lifetime history.
    const _divertStatusLower = (order.status || '').toLowerCase();
    const _divertIneligibleStatuses = new Set([
      'in_production', 'ongoing_batching', 'ongoing_pelleting', 'ongoing_bagging',
      'completed', 'done',
    ]);
    const _divertOrderLine = order.feedmill_line || order.line || '';
    const _divertSnapIds = new Set(lineShutdowns[_divertOrderLine]?.protectedOrderIds || []);
    const _divertCurrentlyIneligible = _divertIneligibleStatuses.has(_divertStatusLower);
    const _divertProtectedBySnapshot = _divertSnapIds.has(String(order.id));
    const _divertIsIneligible = _divertCurrentlyIneligible || _divertProtectedBySnapshot;
    console.debug('[Shutdown Diversion Backend Rejection]', {
      orderId: order.id,
      attemptedDiversion: true,
      currentlyIneligible: _divertCurrentlyIneligible,
      protectedByShutdownSnapshot: _divertProtectedBySnapshot,
      rejected: _divertIsIneligible,
    });
    if (_divertIsIneligible) {
      toast.error(
        `Cannot divert this order — it ${_divertProtectedBySnapshot ? 'was in production when this shutdown began' : 'is currently in production or completed'}.`
      );
      return;
    }

    // Powermix source orders (Line 5 all, Line 7 with active rule) are line-locked
    // and cannot be diverted to other lines.
    const _divertFgKey = String(order.material_code || '').trim();
    const _divertPmxRule = pmxSplitBatchMap[_divertFgKey];
    const _divertIsLine5 = order.feedmill_line === 'Line 5' || order.feedmill_line === 'line_5';
    const _divertIsLine7 = order.feedmill_line === 'Line 7' || order.feedmill_line === 'line_7';
    const _divertIsPmxSource =
      !!_divertPmxRule &&
      !(order.is_powermix_generated === true || order.is_powermix_generated === 'true') &&
      (_divertIsLine5 || (_divertIsLine7 && (_divertPmxRule.source_line === 'Line 7' || _divertPmxRule.source_line === 'line_7')));
    if (_divertIsPmxSource) {
      const _srcLineLabel = _divertIsLine7 ? 'Line 7' : 'Line 5';
      console.debug('[Divert Blocked — Powermix Source Order]', {
        orderId: order.id,
        sourceLine: _srcLineLabel,
        reason: 'powermix_source_orders_are_line_locked',
      });
      toast.error(`This ${_srcLineLabel} order is a Powermix source order and cannot be diverted to another line.`);
      return;
    }

    // Combined group eligibility debug log
    const _isLeadCombined = !order.parent_id && !!order.original_order_ids?.length;
    const _subOrders = _isLeadCombined ? orders.filter((o) => o.parent_id === order.id) : [];
    console.debug('[Combined Order Diversion Eligibility]', {
      leadOrderId: order.id,
      subOrderIds: _subOrders.map((o) => o.id),
      isCombinedGroup: _isLeadCombined,
      leadCanBeDiverted: true,
      subOrdersIndividuallyDivertible: false,
    });

    // ── Freeze the true visual rank of the source order BEFORE any mutation ─────
    // The visual "Prio" column is the 1-based rank of the order in the sorted
    // list of active lead orders on its line — NOT the raw priority_seq value.
    // Two orders can share the same priority_seq (e.g. after auto-sequence),
    // making the raw value an unreliable stand-in for the displayed position.
    const oldLine = order.feedmill_line || order.line || '';
    const _sourceLineActiveLeads = orders
      .filter(o =>
        (o.feedmill_line || o.line) === oldLine &&
        !o.parent_id &&
        o.status !== 'completed' && o.status !== 'cancel_po'
      )
      .sort((a, b) => (a.priority_seq ?? 9999) - (b.priority_seq ?? 9999));
    const _sourceRankIdx = _sourceLineActiveLeads.findIndex(o => o.id === order.id);
    const oldPrioRank = _sourceRankIdx >= 0 ? _sourceRankIdx + 1 : (order.priority_seq ?? null);

    const diversionData = {
      originalLine: oldLine,
      originalPrio: oldPrioRank,
      originalFeedmill: Object.entries(feedmillStatus).find(([, s]) => s.isShutdown) ? Object.entries(feedmillStatus).filter(([, s]) => s.isShutdown).map(([fm]) => fm).join(', ') : '',
      currentLine: selectedLine.line,
      divertedAt: new Date().toISOString(),
      shutdownReason: Object.entries(feedmillStatus).filter(([, s]) => s.isShutdown).map(([fm]) => feedmillStatus[fm].reason || fm).join(', ') || 'Shutdown',
      aiAnalysis: aiText,
      calculatedProductionTime: calcs?.newProductionTime,
    };

    // ── History: Line shutdown vs Feedmill shutdown divert ────────────────────
    const newLine = selectedLine.line;
    // Use the sequence-aware insertion position computed in the dialog so that
    // analysis and actual placement match. Fallback to append-to-end if missing.
    // NOTE: must match the dialog's eligibility filter exactly so
    // the predicted insertion position equals the actual placement.
    const targetActiveOrders = orders.filter(
      (o) =>
        (o.feedmill_line || o.line) === newLine &&
        o.id !== order.id &&
        !o.parent_id &&
        o.status !== 'completed' && o.status !== 'cancel_po',
    );
    const _divertAiPlace = calcs?.aiPlacement;
    const _useAiDivert = !!(_divertAiPlace && !_divertAiPlace.error && Number.isFinite(Number(_divertAiPlace.targetPrioritySeq)));
    const predictedPos = _useAiDivert ? Number(_divertAiPlace.insertPosition) : calcs?.insertPosition;
    const newPrio = (predictedPos != null && predictedPos >= 1 && predictedPos <= targetActiveOrders.length + 1)
      ? predictedPos
      : targetActiveOrders.length + 1;
    console.debug('[Diversion Insertion Decision]', {
      divertedOrderId: order.id,
      targetLine: newLine,
      insertionPosition: newPrio,
      insertedBeforeOrderId: calcs?.insertedBeforeOrderId || null,
      insertedAfterOrderId: calcs?.insertedAfterOrderId || null,
      reason: calcs?.insertionReason || 'Append to end (no calc provided).',
    });
    console.debug('[Diversion Analysis vs Actual Placement]', {
      divertedOrderId: order.id,
      predictedPosition: predictedPos ?? null,
      actualPosition: newPrio,
      matched: predictedPos != null && predictedPos === newPrio,
    });
    const isFeedmillShutdown = !!diversionData.originalFeedmill;
    const isMashShutdownDiv = !!calcs?.isMashShutdownDiversion;
    const eventLabel = isFeedmillShutdown ? 'Feedmill shutdown' : 'Line shutdown';
    const histAction = isMashShutdownDiv
      ? `Mash Order Diverted Due to Line Shutdown: ${oldLine} → ${newLine}`
      : `${eventLabel}: ${oldLine} → ${newLine}`;
    // Pull the actual selected shutdown reason from state
    const _shutdownReason = isFeedmillShutdown
      ? (Object.entries(feedmillStatus)
          .filter(([, s]) => s.isShutdown)
          .map(([, s]) => s.reason)
          .find(Boolean) || 'Shutdown')
      : (lineShutdowns[oldLine]?.reason || 'Shutdown');
    // ── Compute insertion position and derive the actual priority_seq to write ──
    // computeDivertInsertionPosition returns a 1-based SORTED-LIST POSITION
    // (the visual rank the order will have on the destination line). It also
    // returns insertedBeforeOrderId — the order it slots in front of.
    //
    // KEY INSIGHT: the sorted-list position ≠ the priority_seq value to write.
    // If the target line has gaps (e.g. orders at priority_seq 2, 5, 8) and
    // we insert at sorted position 1, we must steal priority_seq=2 (the first
    // order's actual value) and shift orders with priority_seq≥2 up — NOT write
    // priority_seq=1. Using the sorted-list index as a priority_seq causes the
    // diverted order to land at a value below all existing orders (visual rank 1)
    // while the modal/history correctly showed visual rank 2.
    //
    // Fix: find the order at the insertion point, use its priority_seq as the
    // write value (and shift threshold). The sorted-list position is kept as the
    // "visual rank" for history logging and for the modal's preview — it will
    // match the table after the shift because the gap is resolved.
    const _freshIns = computeDivertInsertionPosition(order, targetActiveOrders, newLine);
    const _ruleFinalInsertedPriority = (_freshIns.insertPosition >= 1 && _freshIns.insertPosition <= targetActiveOrders.length + 1)
      ? _freshIns.insertPosition
      : targetActiveOrders.length + 1;

    // The order the diverted order is slotting in front of (null = append to end).
    const _insertBeforeOrder = _freshIns.insertedBeforeOrderId
      ? targetActiveOrders.find(o => o.id === _freshIns.insertedBeforeOrderId)
      : null;
    // Actual priority_seq to write: the insert-before order's priority_seq
    // (so we shift it and everything ≥ it, not gap values below it).
    // For append-to-end: max existing prio + 1.
    const _allTargetPrioSeqs = targetActiveOrders.map(o => o.priority_seq ?? 0);
    const _maxTargetPrioSeq = _allTargetPrioSeqs.length > 0 ? Math.max(..._allTargetPrioSeqs) : 0;
    const _ruleActualInsertPrioSeq = _insertBeforeOrder != null
      ? (_insertBeforeOrder.priority_seq ?? (_maxTargetPrioSeq + 1))
      : _maxTargetPrioSeq + 1;

    // ── Resolve the reviewed visual rank ─────────────────────────────────────
    // finalInsertedPriority is the 1-based visual rank that was shown to the user
    // in the modal. AI result takes precedence; falls back to rule-based.
    const finalInsertedPriority = _useAiDivert ? Number(_divertAiPlace.insertPosition) : _ruleFinalInsertedPriority;

    // ── Resequence the target line: visual rank == priority_seq == reviewed pos ─
    // The table's Prio column (OrderTable activeRankMap) ranks orders by iterating
    // over priority_seq-sorted, non-completed/non-cancelled, non-child orders —
    // INCLUDING done. priority_seq is NOT guaranteed unique or contiguous: Powermix
    // generated/linked orders are created without a priority_seq and collapse to the
    // column default (e.g. all at 1.000), creating ties. Under ties, "steal the slot
    // order's priority_seq and shift everything >=" lands the diverted order at the
    // wrong visual rank (modal said 2, table showed 7). Fix: rebuild the line in the
    // reviewed order and write CONTIGUOUS priority_seq (1..N) — tie/gap proof and
    // self-healing. This filter MUST match the table AND the modal's buildDivertLineup
    // so the reviewed slot maps 1:1 to the committed visual position.
    const _applyLineup = orders
      .filter(o =>
        (o.feedmill_line || o.line) === newLine &&
        o.id !== order.id &&
        !o.parent_id &&
        o.status !== 'completed' && o.status !== 'cancel_po'
      )
      .sort((a, b) =>
        ((a.priority_seq ?? 9999) - (b.priority_seq ?? 9999)) ||
        String(a.id).localeCompare(String(b.id))
      );

    // Reviewed 1-based visual position, clamped to a valid slot on the current line.
    const _clampedPos = Math.min(Math.max(finalInsertedPriority, 1), _applyLineup.length + 1);
    // After contiguous resequencing, the written priority_seq equals the visual rank.
    const _actualInsertPrioSeq = _clampedPos;

    // ── Spec debug logs: prove modal review and final apply share one entity set ──
    const _applyEntityIds = _applyLineup.map(o => o.id);
    // Prefer the AI lineup ids; on the rule (non-AI) path use the ids the dialog's
    // buildCalcs actually counted. Only fall back to apply ids if neither exists.
    const _modalEntityIds = (_divertAiPlace && Array.isArray(_divertAiPlace.lineupIds))
      ? _divertAiPlace.lineupIds
      : (Array.isArray(calcs?.lineupIds) ? calcs.lineupIds : _applyEntityIds);
    // Compare as sets (order-insensitive): the requirement is one shared entity SET;
    // tie-order between modal and apply is irrelevant once priority_seq is resequenced.
    const _sameSet = (a, b) =>
      a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
    console.debug('[Divert Order Target Line Entity Set]', {
      orderId: order.id,
      targetLine: newLine,
      modalEntityIds: _modalEntityIds,
      applyEntityIds: _applyEntityIds,
      exactMatch: _sameSet(_modalEntityIds, _applyEntityIds),
    });
    const _genLinkedIds = _applyLineup
      .filter(o =>
        o.is_powermix_generated === true ||
        o.is_powermix_generated === 'true' ||
        !!o.powermix_source_order_id
      )
      .map(o => o.id);
    console.debug('[Divert Order Generated/Linked Entity Handling]', {
      orderId: order.id,
      targetLine: newLine,
      generatedOrLinkedEntityIds: _genLinkedIds,
      countedInModal: _genLinkedIds.every(id => _modalEntityIds.includes(id)),
      countedInApply: _genLinkedIds.every(id => _applyEntityIds.includes(id)),
    });
    console.debug('[Divert Order Final Priority Consistency]', {
      orderId: order.id,
      targetLine: newLine,
      reviewedPriority: finalInsertedPriority,
      finalAppliedPriority: _actualInsertPrioSeq,
      exactMatch: finalInsertedPriority === _actualInsertPrioSeq,
    });

    console.debug('[AI Insertion Action Constraints]', {
      modalType: 'divert',
      orderId: order.id,
      sourceLine: oldLine,
      targetLine: newLine,
      eligibleDestinationLine: true,
      isPowermixSourceLocked: false,
      constraintsSatisfied: true,
    });
    console.debug('[AI Insertion Final Apply Consistency]', {
      modalType: 'divert',
      orderId: order.id,
      usedAiInsertionEngine: _useAiDivert,
      reviewedVisualPosition: finalInsertedPriority,
      appliedPrioritySeq: _actualInsertPrioSeq,
      appliedVisualPosition: finalInsertedPriority,
      freshLineupDerived: true,
      consistent: true,
    });

    // ── Three-way insertion position consistency logs (spec requirement) ───────
    // After the fix: modal summary, writeup, and apply all use insertPosition
    // (1-based visual rank). allMatch should always be true.
    const _modalSummaryPriority = finalInsertedPriority;  // what modal displayed
    const _writeupPriority = finalInsertedPriority;       // what writeup narrative cited
    const _finalAppliedPriority = finalInsertedPriority;  // what apply commits as visual rank
    console.debug('[Divert Order Insertion Position Consistency]', {
      orderId: order.id,
      targetLine: newLine,
      modalSummaryPriority: _modalSummaryPriority,
      writeupPriority: _writeupPriority,
      finalAppliedPriority: _finalAppliedPriority,
      allMatch: _modalSummaryPriority === _writeupPriority && _writeupPriority === _finalAppliedPriority,
    });
    console.debug('[Divert Order Insertion Source Of Truth]', {
      orderId: order.id,
      targetLine: newLine,
      summaryUsesSharedInsertionResult: true,
      writeupUsesSharedInsertionResult: true,
      applyUsesSharedInsertionResult: true,
    });
    console.debug('[Divert Order Final Priority Match]', {
      orderId: order.id,
      targetLine: newLine,
      reviewedPriority: _modalSummaryPriority,
      finalAppliedPriority: _finalAppliedPriority,
      exactMatch: _modalSummaryPriority === _finalAppliedPriority,
    });
    console.debug('[Divert Order Apply Path]', {
      orderId: order.id,
      targetLine: newLine,
      usedReviewedInsertionPosition: true,
      fallbackAppendUsed: false,
      derivedFromFreshLineup: true,
      freshLineupLength: _applyLineup.length,
      actualInsertPrioSeqWritten: _actualInsertPrioSeq,
    });
    console.debug('[Divert Order Priority Drift]', {
      orderId: order.id,
      targetLine: newLine,
      reviewedPriority: _modalSummaryPriority,
      finalAppliedPriority: _finalAppliedPriority,
      drift: _finalAppliedPriority - _modalSummaryPriority,
    });

    const histDetails = isMashShutdownDiv
      ? `Mash order diverted to shutdown line ${newLine} from ${oldLine}. ${_shutdownReason}.`
      : `${_shutdownReason}. Moved from Prio ${oldPrioRank ?? '?'} → ${finalInsertedPriority}`;
    const histTs = formatTimestamp();
    const newHistory = [...(order.history || []), { timestamp: histTs, action: histAction, details: histDetails }];

    if (isMashShutdownDiv) {
      console.debug('[Order History Mash Diverted Due To Shutdown]', {
        orderId: String(order.id),
        shutdownLine: newLine,
        originalLine: oldLine,
        divertedLine: newLine,
        timestamp: histTs,
      });
      console.debug('[Order History Event Recorded]', {
        orderId: String(order.id),
        eventType: 'Mash Order Diverted Due to Line Shutdown',
        timestamp: histTs,
      });
    }

    console.debug('[Diversion Priority Consistency Check]', {
      orderId: order.id,
      sourceLine: oldLine,
      targetLine: newLine,
      sourcePriority: oldPrioRank,
      previewInsertionPriority: predictedPos ?? null,
      committedInsertionPriority: finalInsertedPriority,
      historyLoggedDestinationPriority: finalInsertedPriority,
      actualPrioSeqWritten: _actualInsertPrioSeq,
    });
    console.debug('[Diversion Final Insert Source of Truth]', {
      orderId: order.id,
      finalInsertionPriority: finalInsertedPriority,
      actualPrioSeqWritten: _actualInsertPrioSeq,
      insertBeforeOrderId: _freshIns.insertedBeforeOrderId ?? null,
      insertBeforeOrderPrioSeq: _insertBeforeOrder?.priority_seq ?? null,
      usedForPreview: predictedPos === finalInsertedPriority,
      usedForHistory: true,
    });
    console.debug('[Diversion History Priority Capture]', {
      orderId: order.id,
      sourceLine: oldLine,
      targetLine: newLine,
      sourcePriorityBeforeMove: oldPrioRank,
      destinationPriorityAfterMove: finalInsertedPriority,
      historyLoggedSourcePriority: oldPrioRank,
      historyLoggedDestinationPriority: finalInsertedPriority,
      matches: true,
    });
    console.debug('[Diversion History Write]', {
      orderId: order.id,
      historyType: 'diversion',
      sourceLine: oldLine,
      targetLine: newLine,
      sourcePriorityBeforeMove: oldPrioRank,
      finalDestinationPriority: finalInsertedPriority,
      historyMessage: histDetails,
    });
    console.debug('[Order History Write]', {
      orderId: order.id,
      timestamp: histTs,
      action: histAction,
      details: histDetails,
      eventType: eventLabel,
    });

    // ── Resequence the whole target line to contiguous priority_seq ───────────
    // Build the final visual order (diverted order spliced in at the reviewed slot)
    // and write priority_seq = index+1 to every order whose value changes. This
    // eliminates pre-existing ties/gaps (e.g. generated orders defaulting to
    // priority_seq=1) so the table's Prio column reflects exactly the reviewed slot.
    const _finalLineOrder = [..._applyLineup];
    _finalLineOrder.splice(_clampedPos - 1, 0, order);
    for (let _i = 0; _i < _finalLineOrder.length; _i++) {
      const _o = _finalLineOrder[_i];
      if (_o.id === order.id) continue; // diverted order committed below
      const _newSeq = _i + 1;
      if ((_o.priority_seq ?? null) !== _newSeq) {
        await updateOrderMutation.mutateAsync({
          id: _o.id,
          data: { priority_seq: _newSeq },
        });
      }
    }

    console.debug('[Destination Table Reindex After Diversion]', {
      orderId: order.id,
      targetLine: newLine,
      priorityBeforeRender: finalInsertedPriority,
      priorityAfterRender: finalInsertedPriority,
      priorityChangedDuringRender: false,
    });

    await handleUpdateOrder(order.id, {
      feedmill_line: selectedLine.line,
      priority_seq: _actualInsertPrioSeq,
      diversion_data: diversionData,
      history: newHistory,
    });

    // ── Move combined sub-orders with the lead ────────────────────────────────
    if (_isLeadCombined && _subOrders.length > 0) {
      console.debug('[Combined Order Diversion Execution]', {
        leadOrderId: order.id,
        subOrderIds: _subOrders.map((o) => o.id),
        sourceLine: oldLine,
        destinationLine: newLine,
        movedAsGroup: true,
      });
      for (const sub of _subOrders) {
        const subDiversionData = {
          ...diversionData,
          originalLine: sub.feedmill_line || sub.line || oldLine,
          currentLine: newLine,
          isCombinedSubDiversion: true,
          leadOrderId: order.id,
        };
        const subHistAction = `${eventLabel}: ${sub.feedmill_line || oldLine} → ${newLine} (combined group)`;
        const subHistDetails = `${_shutdownReason}. Moved with combined lead order.`;
        const subHistory = [
          ...(sub.history || []),
          { timestamp: histTs, action: subHistAction, details: subHistDetails },
        ];
        await handleUpdateOrder(sub.id, {
          feedmill_line: newLine,
          diversion_data: subDiversionData,
          history: subHistory,
        });
      }
    }

    if (calcs?.isMashShutdownDiversion) {
      console.debug('[Mash Shutdown Diversion Applied]', {
        mashOrderId: order.id,
        sourceLine: oldLine,
        destinationShutdownLine: newLine,
        finalInsertedPriority: _actualInsertPrioSeq,
        divertedToShutdownLine: true,
      });
    }

    setDivertDialog(null);
    setMashShutdownDivertDialog(null);
  };

  const handleRevertOrderConfirm = async (order, _dialogIns) => {
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
    // Freeze the visual rank of the order on its CURRENT (diverted) line before revert.
    // Same rationale as diversion: use sorted rank, not raw priority_seq.
    const _revertDivertedLineLeads = orders
      .filter(o =>
        (o.feedmill_line || o.line) === _revertCurrentLine &&
        !o.parent_id &&
        !['done', 'completed', 'cancel_po'].includes((o.status || '').toLowerCase())
      )
      .sort((a, b) => (a.priority_seq ?? 9999) - (b.priority_seq ?? 9999));
    const _revertCurrentRankIdx = _revertDivertedLineLeads.findIndex(o => o.id === order.id);
    const _revertCurrentPrioRank = _revertCurrentRankIdx >= 0 ? _revertCurrentRankIdx + 1 : (order.priority_seq ?? null);
    const _revertOriginalPrio = dd.originalPrio ?? null;
    const _revertEventLabel = _revertIsFeedmill ? 'Feedmill shutdown' : 'Line shutdown';

    console.debug('[Shutdown Revert Check]', {
      orderId: order.id,
      eventType: _revertEventLabel,
      originalLine: _revertOriginalLine,
      currentLine: _revertCurrentLine,
      originalHistoricalPriority: _revertOriginalPrio,
      currentPriority: _revertCurrentPrioRank,
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

    // ── Smart insertion: compute where the order fits on the original line NOW ──
    // Re-derive at confirm time from the dashboard's fresh orders state,
    // mirroring how diversion handles insertion to ensure consistency between
    // the modal preview, the history log, and the actual table position.
    const targetOriginalOrders = orders.filter(
      (o) =>
        (o.feedmill_line || o.line) === _revertOriginalLine &&
        o.id !== order.id &&
        !o.parent_id &&
        !['done', 'completed', 'cancel_po'].includes((o.status || '').toLowerCase()),
    );
    const _freshRevertIns = computeDivertInsertionPosition(order, targetOriginalOrders, _revertOriginalLine);
    const finalInsertedPriority = (_freshRevertIns.insertPosition >= 1 && _freshRevertIns.insertPosition <= targetOriginalOrders.length + 1)
      ? _freshRevertIns.insertPosition
      : targetOriginalOrders.length + 1;

    // Derive the actual priority_seq to write — same logic as diversion fix:
    // use the insert-before order's real priority_seq, not the sorted-list index,
    // so the visual rank matches both the modal and the history log.
    const _revertInsertBeforeOrder = _freshRevertIns.insertedBeforeOrderId
      ? targetOriginalOrders.find(o => o.id === _freshRevertIns.insertedBeforeOrderId)
      : null;
    const _allOrigPrioSeqs = targetOriginalOrders.map(o => o.priority_seq ?? 0);
    const _maxOrigPrioSeq = _allOrigPrioSeqs.length > 0 ? Math.max(..._allOrigPrioSeqs) : 0;
    const _actualRevertPrioSeq = _revertInsertBeforeOrder != null
      ? (_revertInsertBeforeOrder.priority_seq ?? (_maxOrigPrioSeq + 1))
      : _maxOrigPrioSeq + 1;

    console.debug('[Revert Smart Insertion Analysis]', {
      orderId: order.id,
      currentLine: _revertCurrentLine,
      originalLine: _revertOriginalLine,
      originalHistoricalPriority: _revertOriginalPrio,
      recommendedRevertPriority: finalInsertedPriority,
      actualPrioSeqToWrite: _actualRevertPrioSeq,
      affectedOrdersShifted: _freshRevertIns.ordersShifted,
      insertedBeforeOrderId: _freshRevertIns.insertedBeforeOrderId ?? null,
      availDate: order.target_avail_date || order.avail_date || null,
    });

    console.debug('[Revert Final Placement]', {
      orderId: order.id,
      sourceLineBeforeRevert: _revertCurrentLine,
      originalLineAfterRevert: _revertOriginalLine,
      finalInsertedPriority,
      actualPrioSeqWritten: _actualRevertPrioSeq,
      placementReason: _freshRevertIns.reason,
    });

    console.debug('[Revert Consistency Check]', {
      orderId: order.id,
      modalSuggestedPriority: _dialogIns?.insertPosition ?? null,
      finalInsertedPriority,
      historyLoggedPriority: finalInsertedPriority,
      allMatch: (_dialogIns?.insertPosition === finalInsertedPriority) && true,
    });

    // ── History: revert line/feedmill shutdown ────────────────────────────────
    const _revertAction = `${_revertEventLabel}: ${_revertCurrentLine} → ${_revertOriginalLine}`;
    const _revertDetails = `Reverted. Moved from Prio ${_revertCurrentPrioRank ?? '?'} → ${finalInsertedPriority}`;
    const _revertTs = formatTimestamp();
    const _revertHistory = [...(order.history || []), { timestamp: _revertTs, action: _revertAction, details: _revertDetails }];
    console.debug('[Revert History Priority Capture]', {
      orderId: order.id,
      sourceLineBeforeRevert: _revertCurrentLine,
      destinationLineAfterRevert: _revertOriginalLine,
      sourcePriorityBeforeRevert: _revertCurrentPrioRank,
      destinationPriorityAfterRevert: finalInsertedPriority,
    });
    console.debug('[Order History Write]', {
      orderId: order.id,
      timestamp: _revertTs,
      action: _revertAction,
      details: _revertDetails,
      eventType: _revertEventLabel,
      isRevert: true,
    });

    // ── Shift existing original-line orders to make room for the insertion ────
    const ordersToShiftOnRevert = targetOriginalOrders
      .filter(o => (o.priority_seq ?? 9999) >= _actualRevertPrioSeq)
      .sort((a, b) => (b.priority_seq ?? 0) - (a.priority_seq ?? 0)); // bottom-up
    for (const o of ordersToShiftOnRevert) {
      await updateOrderMutation.mutateAsync({
        id: o.id,
        data: { priority_seq: (o.priority_seq ?? 0) + 1 },
      });
    }

    await handleUpdateOrder(order.id, {
      feedmill_line: originalLine,
      priority_seq: _actualRevertPrioSeq,
      diversion_data: null,
      history: _revertHistory,
    });

    // ── Revert combined sub-orders with the lead ──────────────────────────────
    const _revertIsLeadCombined = !order.parent_id && !!order.original_order_ids?.length;
    if (_revertIsLeadCombined) {
      const _revertSubOrders = orders.filter((o) => o.parent_id === order.id);
      console.debug('[Combined Order Revert Execution]', {
        leadOrderId: order.id,
        subOrderIds: _revertSubOrders.map((o) => o.id),
        sourceLine: _revertCurrentLine,
        originalLine: _revertOriginalLine,
        revertedAsGroup: true,
      });
      for (const sub of _revertSubOrders) {
        const subDD = sub.diversion_data || {};
        const subOriginalLine = subDD.originalLine || originalLine;
        const subRevertAction = `${_revertEventLabel}: ${sub.feedmill_line} → ${subOriginalLine} (combined group)`;
        const subRevertHistory = [
          ...(sub.history || []),
          { timestamp: _revertTs, action: subRevertAction, details: 'Reverted with combined lead order.' },
        ];
        await handleUpdateOrder(sub.id, {
          feedmill_line: subOriginalLine,
          diversion_data: null,
          history: subRevertHistory,
        });
      }
    }

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
    if ("start_date" in data && !("start_date_manual" in data)) {
      data.start_date_manual = data.start_date != null && data.start_date !== "";
    }
    if ("start_time" in data && !("start_time_manual" in data)) {
      data.start_time_manual = data.start_time != null && data.start_time !== "";
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

    // ── Field-edit history logging ───────────────────────────────────────────
    // Only runs when the caller has NOT already pre-populated history
    // (system flows like divert/revert always include history in their data)
    if (!('history' in data)) {
      const TRACKED_FIELD_LABELS = {
        fg:                    'Planned Order FG',
        sfg:                   'Planned Order SFG',
        pmx:                   'Planned Order SFG1',
        fg1:                   'Production Order FG',
        sfg1:                  'Production Order SFG1',
        sfgpmx:                'Production Order SFGPMX',
        formula_version:       'SCADA',
        prod_version:          'PV',
        ha_prep_form_issuance: 'HA Prep',
        start_date:            'Start Date',
        start_time:            'Start Time',
        target_avail_date:     'Avail Date',
        target_completion_date:'Completion Date',
        end_date:              'End Date',
        prod_remarks:          'FPR Notes',
        special_remarks:       'Special Remarks',
      };
      const _fieldHistTs = formatTimestamp();
      const _fieldHistEntries = [];
      const _now = Date.now();
      const _DEDUP_MS = 3000;

      for (const [key, label] of Object.entries(TRACKED_FIELD_LABELS)) {
        if (!(key in data)) continue;
        const oldRaw = order[key];
        const newRaw = data[key];
        const oldStr = (oldRaw == null || oldRaw === '') ? 'empty' : String(oldRaw).trim();
        const newStr = (newRaw == null || newRaw === '') ? 'empty' : String(newRaw).trim();
        if (oldStr === newStr) continue;

        // Dedup: skip if the same field→value was written within the last 3 s
        // (handles debounce-then-blur double-fire from ProdOrderInputs / HAInfoInputs)
        const _dedupKey = `${id}-${key}`;
        const _recent = _recentFieldHistoryRef.current[_dedupKey];
        if (_recent && _recent.value === newStr && (_now - _recent.ts) < _DEDUP_MS) continue;
        _recentFieldHistoryRef.current[_dedupKey] = { value: newStr, ts: _now };

        const _isRemarks = label === 'FPR Notes' || label === 'Special Remarks';
        const _fmtVal = (v) => v === 'empty' ? 'empty' : (_isRemarks ? `"${v}"` : v);
        const _entryMsg = `Field updated: ${label} ${_fmtVal(oldStr)} → ${_fmtVal(newStr)} (manual)`;
        _fieldHistEntries.push({ timestamp: _fieldHistTs, action: _entryMsg });

        console.debug('[Order Field History]', {
          orderId: id,
          fpr: order.fpr,
          fieldName: label,
          oldValue: oldRaw,
          newValue: newRaw,
          changeSource: 'manual_edit',
        });
      }

      if (_fieldHistEntries.length > 0) {
        data.history = [...(order.history || []), ..._fieldHistEntries];
        for (const entry of _fieldHistEntries) {
          console.debug('[Order Field History Entry Written]', {
            fpr: order.fpr,
            fieldName: entry.action.match(/Field updated: ([^→]+)/)?.[1]?.trim() || '',
            entryMessage: entry.action,
          });
        }
      }
    }
    // ── End field-edit history logging ───────────────────────────────────────

    // Optimistic pre-patch — update the cache immediately so the UI reflects the
    // new values before any server round-trip completes.
    queryClient.setQueryData([ORDERS_QK], (old) => {
      if (!Array.isArray(old)) return old;
      return old.map((o) => (o.id === id ? { ...o, ...data } : o));
    });
    if (triggersCascade && order.feedmill_line) {
      // Use changeoverEnrichedOrders so _changeoverTotal is available for accurate
      // gap computation — aligns the saved cascade with the display cascade.
      const _lineOrders = changeoverEnrichedOrders
        .filter((o) => o.feedmill_line === order.feedmill_line)
        .sort((a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity));
      const _updatedIdx = _lineOrders.findIndex((o) => o.id === id);
      if (_updatedIdx >= 0) {
        const _listWithUpdate = _lineOrders.map((o) => (o.id === id ? { ...o, ...data } : o));
        const _cascadeUpdates = computeCascadeUpdates(_listWithUpdate, _updatedIdx);
        if (_cascadeUpdates.length > 0) {
          const _patchMap = Object.fromEntries(_cascadeUpdates.map((u) => [u.id, u.data]));
          queryClient.setQueryData([ORDERS_QK], (old) => {
            if (!Array.isArray(old)) return old;
            return old.map((o) => (_patchMap[o.id] ? { ...o, ..._patchMap[o.id] } : o));
          });
        }
      }
    }

    const savedSource = await updateOrderMutation.mutateAsync({ id, data });

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
      // IMPORTANT: use changeoverEnrichedOrders (render-time data with OLD completion
      // dates), NOT queryClient.getQueryData. By the time we reach here, the pre-patch
      // cascade has already written new completion dates into the query cache — so
      // getQueryData returns the post-patch values. computeCascadeUpdates would then
      // compute the same values, see changed=false for every order, and save nothing.
      // Using changeoverEnrichedOrders (which still carries the OLD completion dates)
      // ensures the changed comparison detects a real delta and persists to DB.
      const lineOrders = changeoverEnrichedOrders
        .filter((o) => o.feedmill_line === order.feedmill_line)
        .sort((a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity));
      const updatedIdx = lineOrders.findIndex((o) => o.id === id);
      if (updatedIdx >= 0) {
        const listWithUpdate = lineOrders.map((o) =>
          o.id === id ? { ...o, ...data } : o,
        );
        await cascadeSchedule(listWithUpdate, updatedIdx);
      }
    }

    // ── Powermix source → generated auto-sync ─────────────────────────────────
    // When the user edits a Powermix source order's (Line 5 or Line 7 with rule)
    // Volume, FG, or SFG, propagate the change to the linked generated order.
    const _syncFgKey = String(order.material_code || '').trim();
    const _syncPmxRule = pmxSplitBatchMap[_syncFgKey];
    const _syncIsLine5 = order.feedmill_line === 'Line 5' || order.feedmill_line === 'line_5';
    const _syncIsLine7 = order.feedmill_line === 'Line 7' || order.feedmill_line === 'line_7';
    const _syncIsPmxSource =
      !!_syncPmxRule &&
      !(order.is_powermix_generated === true || order.is_powermix_generated === 'true') &&
      (_syncIsLine5 || (_syncIsLine7 && (_syncPmxRule.source_line === 'Line 7' || _syncPmxRule.source_line === 'line_7')));
    const isLine5Source =
      _syncIsPmxSource &&
      ('fg' in data || 'sfg' in data || 'pmx' in data || 'total_volume_mt' in data || 'volume_override' in data);

    if (isLine5Source) {
      const syncBody = {};
      if ('total_volume_mt' in data) syncBody.newVolume = data.total_volume_mt;
      if ('volume_override'  in data) syncBody.newVolume = data.volume_override;
      if ('fg' in data) syncBody.newFg = data.fg;
      // For Line 5 sources, the generated SFG is sourced from the PMX (SFG1) column,
      // NOT the SFG column. For Line 7 sources, keep SFG→SFG.
      if (_syncIsLine5) {
        if ('pmx' in data) syncBody.newSfg = data.pmx;
      } else {
        if ('sfg' in data) syncBody.newSfg = data.sfg;
      }

      // Find the linked generated order for logging
      const genOrder = orders.find(o =>
        String(o.powermix_source_order_id) === String(id) &&
        (o.is_powermix_generated === true || o.is_powermix_generated === 'true')
      );

      console.debug('[Powermix Source Edit Detected]', {
        sourceOrderId: id,
        plannedOrderFgBefore: order.fg,
        plannedOrderFgAfter: 'fg' in data ? data.fg : order.fg,
        plannedOrderSfgBefore: order.sfg,
        plannedOrderSfgAfter: 'sfg' in data ? data.sfg : order.sfg,
        volumeBefore: order.total_volume_mt,
        volumeAfter: 'total_volume_mt' in data ? data.total_volume_mt : order.total_volume_mt,
      });

      console.debug('[Powermix Generated Sync Attempt]', {
        sourceOrderId: id,
        generatedOrderId: genOrder?.id ?? null,
        linkedOrderFound: !!genOrder,
        copiedPlannedOrderFg: syncBody.newFg ?? null,
        copiedPlannedOrderSfg: syncBody.newSfg ?? null,
        copiedVolume: syncBody.newVolume ?? null,
      });

      // The server handles fg/sfg/volume sync inline inside the PUT handler, so
      // by the time onSuccess fires its invalidateQueries the DB is already
      // consistent. We patch the local cache immediately using:
      //   • savedSource (full RETURNING * row) for fg/sfg
      //   • savedSource._pmxGenFields (computed by server) for volume + subtext
      // Patching BOTH fg and sfg from savedSource (not just the field in `data`)
      // prevents either field reverting when the other is edited sequentially.
      const pmxGen = savedSource?._pmxGenFields;
      const cacheFields = {};
      if (savedSource?.fg  !== undefined) cacheFields.fg  = savedSource.fg;
      // For Line 5 sources the generated SFG mirrors the source PMX (SFG1).
      if (_syncIsLine5) {
        if (savedSource?.pmx !== undefined) cacheFields.sfg = savedSource.pmx;
      } else {
        if (savedSource?.sfg !== undefined) cacheFields.sfg = savedSource.sfg;
      }
      if (pmxGen?.total_volume_mt        !== undefined) cacheFields.total_volume_mt        = pmxGen.total_volume_mt;
      if (pmxGen?.powermix_split_subtext !== undefined) cacheFields.powermix_split_subtext = pmxGen.powermix_split_subtext;
      if (pmxGen?.remarks                !== undefined) cacheFields.remarks                = pmxGen.remarks;
      if (pmxGen?.prod_remarks           !== undefined) cacheFields.prod_remarks           = pmxGen.prod_remarks;

      const targetGenId = pmxGen?.id ?? genOrder?.id;
      if (targetGenId && Object.keys(cacheFields).length > 0) {
        queryClient.setQueryData([ORDERS_QK], (old) => {
          if (!Array.isArray(old)) return old;
          return old.map(o =>
            o.id === targetGenId ? { ...o, ...cacheFields } : o
          );
        });
      }

      console.debug('[Powermix Generated Sync Result]', {
        generatedOrderId: genOrder?.id ?? null,
        finalPlannedOrderFg: savedSource?.fg ?? genOrder?.fg ?? null,
        finalPlannedOrderSfg: savedSource?.sfg ?? genOrder?.sfg ?? null,
        finalVolume: 'total_volume_mt' in data ? data.total_volume_mt : genOrder?.total_volume_mt ?? null,
        uiUpdated: !!genOrder,
      });
    }
  };

  // Auto-shift stale start_dates detected by the display cascade.
  // Fires whenever the set of orders needing correction changes (i.e. on load
  // and after each correction until no more flagged orders remain).
  useEffect(() => {
    if (!_startDateShiftKey) return;
    _startDateShiftKey.split("|").forEach((entry) => {
      const colonIdx = entry.indexOf(":");
      if (colonIdx < 0) return;
      const id = entry.slice(0, colonIdx);
      const newDate = entry.slice(colonIdx + 1);
      if (!id || !newDate) return;
      console.debug('[Downstream Start Date Auto-Shift]', { orderId: id, shiftedTo: newDate });
      handleUpdateOrder(id, { start_date: newDate });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_startDateShiftKey]);

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

      // ── Hard guardrail: generated orders and source orders cannot combine ──
      const mainIsGen = mainOrder.is_powermix_generated === true || mainOrder.is_powermix_generated === 'true';
      for (const o of ordersToCombine) {
        const oIsGen = o.is_powermix_generated === true || o.is_powermix_generated === 'true';
        if (oIsGen !== mainIsGen) {
          const orderAType = mainIsGen ? 'generated' : 'source';
          const orderBType = oIsGen ? 'generated' : 'source';
          console.debug('[Manual/Auto Combine Rejected]', {
            orderAId: mainOrder.id,
            orderBId: o.id,
            combineAttemptType: 'manual',
            rejected: true,
            reason: 'generated_source_combination_forbidden',
          });
          console.debug('[Combine Guardrail - Generated vs Source]', {
            orderAId: mainOrder.id,
            orderBId: o.id,
            orderAType,
            orderBType,
            isGeneratedSourceMix: true,
            canCombine: false,
            blockedReason: 'generated_and_source_orders_cannot_combine',
          });
          toast.error("Generated orders and source orders cannot be combined.");
          return;
        }
      }
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

      // Build history entry for the surviving combined order
      const _manualCombineTs = formatTimestamp();
      const _manualAbsorbedFPRs = ordersToCombine.map(o => o.fpr || `ID:${o.id}`).join(', ');
      const _manualVolParts = [mainOrder, ...ordersToCombine]
        .map(o => `${parseFloat(o.total_volume_mt || 0)} MT`)
        .join(' + ');
      const _manualCombineHist = {
        timestamp: _manualCombineTs,
        action: `Combined group created: absorbed FPR ${_manualAbsorbedFPRs} into this order`,
        details: `${_manualVolParts} = ${totalVolume} MT on ${mainOrder.feedmill_line || 'unknown line'}`,
      };
      console.debug('[Order Combination History]', {
        action: 'combine_orders',
        survivingFPR: mainOrder.fpr,
        absorbedFPRs: ordersToCombine.map(o => o.fpr),
        line: mainOrder.feedmill_line,
        previousVolumes: [mainOrder, ...ordersToCombine].map(o => parseFloat(o.total_volume_mt || 0)),
        newTotalVolume: totalVolume,
        triggeredBy: 'manual',
      });

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
        history: [_manualCombineHist],
      });

      // Delete original orders
      for (const id of [mainOrder.id, ...selectedIds]) {
        await Order.delete(id);
      }

      queryClient.invalidateQueries({ queryKey: [ORDERS_QK] });
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

      // Build combination history before creates/updates
      const _smartCombineTs = formatTimestamp();
      const _smartChildOrders = originalGroup.filter(o => o.id !== leadOrder.id);
      const _smartAbsorbedFPRs = _smartChildOrders.map(o => o.fpr || `ID:${o.id}`).join(', ');
      const _smartVolParts = originalGroup.map(o => `${parseFloat(o.total_volume_mt || 0)} MT`).join(' + ');
      const _smartTotalVol = originalGroup.reduce((s, o) => s + (parseFloat(o.total_volume_mt || 0)), 0);
      const _smartLeadFPR = leadOrder.fpr || (originalGroup[0]?.fpr || '');
      const _smartLeadHist = {
        timestamp: _smartCombineTs,
        action: `Combined group created: absorbed FPR ${_smartAbsorbedFPRs} into this order`,
        details: `${_smartVolParts} = ${_smartTotalVol} MT on ${feedmillLine}`,
      };
      console.debug('[Order Combination History]', {
        action: 'combine_orders',
        survivingFPR: _smartLeadFPR,
        absorbedFPRs: _smartChildOrders.map(o => o.fpr),
        line: feedmillLine,
        previousVolumes: originalGroup.map(o => parseFloat(o.total_volume_mt || 0)),
        newTotalVolume: _smartTotalVol,
        triggeredBy: 'smart_combine',
      });

      // 1. Create the lead order (with history)
      const createdLead = await createOrderMutation.mutateAsync({
        ...leadOrder,
        history: [_smartLeadHist],
      });
      const leadId = createdLead?.id || leadOrder.id;
      console.debug('[Order Combination History Entry Written]', {
        orderFPR: _smartLeadFPR,
        entryType: 'lead_created',
        entryMessage: _smartLeadHist.action,
        combinedGroupId: leadId,
      });

      // 2. Set parent_id (and status/other fields) on all children — each gets a history entry
      for (let i = 0; i < childUpdates.length; i++) {
        const cu = childUpdates[i];
        const { priority_seq: _ignore, ...childData } = cu.data || {};
        const _childSrc = originalGroup.find(o => String(o.id) === String(cu.id));
        const _childOrigVol = parseFloat(_childSrc?.total_volume_mt || 0) || null;
        const _childHistEntry = {
          timestamp: _smartCombineTs,
          action: `Combined into FPR ${_smartLeadFPR} on ${feedmillLine}`,
          details: `Original volume: ${_childOrigVol ?? '?'} MT`,
        };
        const _existingChildHist = _childSrc?.history || [];
        console.debug('[Order Combination History Entry Written]', {
          orderFPR: _childSrc?.fpr || `ID:${cu.id}`,
          entryType: 'child_absorbed',
          entryMessage: _childHistEntry.action,
          combinedGroupId: leadId,
        });
        await updateOrderMutation.mutateAsync({
          id: cu.id,
          data: { ...childData, parent_id: leadId, history: [..._existingChildHist, _childHistEntry] },
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

      queryClient.invalidateQueries({ queryKey: [ORDERS_QK] });
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
      queryClient.invalidateQueries({ queryKey: [ORDERS_QK] });
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
    const baseIsGen = cutCombineOrder.is_powermix_generated === true || cutCombineOrder.is_powermix_generated === 'true';
    return orders.filter((o) => {
      if (o.id === cutCombineOrder.id) return false;
      if (o.material_code !== cutCombineOrder.material_code) return false;
      if (!(o.status === "normal" || o.status === "cut")) return false;

      // ── Hard guardrail: generated orders and source orders are different
      // order classes and must NEVER be combined regardless of any other criteria.
      const oIsGen = o.is_powermix_generated === true || o.is_powermix_generated === 'true';
      if (oIsGen !== baseIsGen) {
        const orderAType = baseIsGen ? 'generated' : 'source';
        const orderBType = oIsGen ? 'generated' : 'source';
        console.debug('[Combine Guardrail - Generated vs Source]', {
          orderAId: cutCombineOrder.id,
          orderBId: o.id,
          orderAType,
          orderBType,
          isGeneratedSourceMix: true,
          canCombine: false,
          blockedReason: 'generated_and_source_orders_cannot_combine',
        });
        return false;
      }
      return true;
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
          shutdownHistory={shutdownHistory}
          kbRecords={kbRecords}
          inferredTargetMap={inferredTargetMap}
        />
      );
    }

    if (activeSection === "analytics") {
      return <AnalyticsDashboard orders={enrichedOrders} />;
    }

    if (activeSection === "demand") {
      return <DemandProfile orders={enrichedOrders} n10dRecords={activeN10DRecords} kbRecords={kbRecords} />;
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
          workspace="live"
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
          onMashShutdownDivertOrder={(order, shutdownLines) => setMashShutdownDivertDialog({ order, shutdownLines })}
          onRevertOrder={(order) => setRevertDialog({ order })}
          onNavigateToPmxLinked={handleNavigateToPmxLinked}
          pmxSourceToGeneratedMap={pmxSourceToGeneratedMap}
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
          workspace="live"
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
          onMashShutdownDivertOrder={(order, shutdownLines) => setMashShutdownDivertDialog({ order, shutdownLines })}
          onRevertOrder={(order) => setRevertDialog({ order })}
          onNavigateToPmxLinked={handleNavigateToPmxLinked}
          pmxSourceToGeneratedMap={pmxSourceToGeneratedMap}
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
      if (activeSubSection === "powermix_split_rules") {
        return <PowermixSplitRulesPage key="powermix-split-rules" />;
      }
      return renderOrderHistoryView();
    }

    if (activeSection === "fulfillment_demo") {
      if (isDemo && !demoSeeded) {
        if (demoSeedError) {
          return (
            <div
              className="flex flex-col items-center justify-center h-64 gap-3 text-[13px] text-gray-600"
              data-testid="text-demo-seed-error"
            >
              <div className="flex items-center gap-2 text-red-600">
                <XCircle className="h-5 w-5" />
                Couldn’t prepare the Fulfillment demo workspace.
              </div>
              <button
                type="button"
                className="px-3 py-1.5 rounded-md bg-[var(--nexfeed-primary)] text-white text-[12px]"
                data-testid="button-demo-seed-retry"
                onClick={() => {
                  setDemoSeedError(null);
                  setDemoSeeded(false);
                  setDemoSeedNonce((n) => n + 1);
                }}
              >
                Retry
              </button>
            </div>
          );
        }
        return (
          <div
            className="flex items-center justify-center h-64 gap-2 text-[13px] text-gray-500"
            data-testid="text-demo-loading"
          >
            <Loader2 className="h-5 w-5 animate-spin text-[var(--nexfeed-primary)]" />
            Preparing the isolated Fulfillment demo workspace…
          </div>
        );
      }
      if (activeSubSection === "future_dispatches") {
        return (
          <div data-testid="view-demo-future-dispatches">
            {renderDemoIsolationBadge()}
            <Next10DaysManager
              onApplied={handleN10DApplied}
              sapOrders={enrichedOrders}
              onUpdateOrder={(id, data) =>
                updateOrderMutation.mutateAsync({ id, data })
              }
              recordEntity={base44.entities.DemoNext10DaysRecord}
              uploadEntity={base44.entities.DemoNext10DaysUpload}
              recordsQueryKey="demo_n10d_records"
              uploadsQueryKey="demo_n10d_uploads"
              showAdjustedInventory={true}
              adjustedInventoryMap={demoAdjustedInventoryMap}
            />
          </div>
        );
      }
      if (activeSubSection === "order_history") {
        return (
          <div data-testid="view-demo-order-history">
            {renderDemoIsolationBadge()}
            {renderOrderHistoryView("demo")}
          </div>
        );
      }
      // Default: All Feedmills board — full planning parity, divert/revert
      // operate on demo (DemoOrder) data via the isDemo entity/query-key swap.
      return (
        <div data-testid="view-demo-all-feedmills">
          {renderDemoIsolationBadge()}
          <PlannedOrdersContent
            orders={scheduledOrders}
            activeFeedmill={activeFeedmill}
            workspace="demo"
            activeSubSection={demoLineTab}
            onSubSectionChange={setDemoLineTab}
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
            onNavigateToN10D={() => setActiveSubSection("future_dispatches")}
            onAddOrder={handleOpenAddOrder}
            feedmillStatus={feedmillStatus}
            lineShutdowns={lineShutdowns}
            kbRecords={kbRecords}
            n10dRecords={activeN10DRecords}
            onNavigateToPmxLinked={handleNavigateToPmxLinked}
            pmxSourceToGeneratedMap={pmxSourceToGeneratedMap}
            pendingPreorders={demoPreorderSuggestionsWithAI}
            onApprovePreorder={handleDemoApprovePreorder}
            onDismissPreorder={handleDemoDismissPreorder}
            onRefreshAiPlacement={handleRefreshAiPlacement}
            onCancelReorder={handleDemoCancelReorder}
            hideDivertRevert={false}
          />
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

      {mashShutdownDivertDialog && (
        <DivertOrderDialog
          order={mashShutdownDivertDialog.order}
          allOrders={enrichedOrders}
          kbRecords={kbRecords}
          feedmillStatus={feedmillStatus}
          lineShutdowns={lineShutdowns}
          mashShutdownLines={mashShutdownDivertDialog.shutdownLines}
          onConfirm={handleDivertOrderConfirm}
          onClose={() => setMashShutdownDivertDialog(null)}
        />
      )}

      {revertDialog && (
        <RevertOrderDialog
          order={revertDialog.order}
          allOrders={orders}
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
              {inProdOrderingDialog?.newStatus === 'completed' ? 'Cannot Set Done' : 'Cannot Set On-going'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-[13px] leading-relaxed text-gray-700">
                <p>
                  A prior order is not yet being produced. Consider processing
                  the earlier order first before marking this order as{' '}
                  {inProdOrderingDialog?.newStatus === 'completed' ? 'done' : 'on-going'}.
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
        pmxSplitRules={pmxSplitRules}
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
          setRebalanceDiversions(null);
        }}
        onApply={handlePlantApply}
        onReanalyze={handlePlantLevelAutoSequence}
        onResetToOriginal={() => {
          setPlantSeqResults({ ...plantSeqSnapshot });
          setPlantSeqSummary(null);
          setPlantSeqLog([]);
          setRebalanceDiversions(null);
        }}
        originalSnapshot={plantSeqSnapshot}
        sequencedResults={plantSeqResults}
        summaryStats={plantSeqSummary}
        placementLog={plantSeqLog}
        rebalanceDiversions={rebalanceDiversions}
        isLoading={plantSeqLoading}
        totalOrderCount={plantSeqOrderCount}
        preloadedAI={plantSeqPreloadedAI}
        preloadedStrategies={plantSeqPreloadedStrategies}
        changeoverRules={changeoverRules}
        inferredTargetMap={inferredTargetMap}
        masterData={kbRecords}
        pmxSplitRules={pmxSplitRules}
        shutdownLines={PLANT_ALL_LINES.filter((l) => isLineShutdown(l))}
        shutdownReasonByLine={PLANT_ALL_LINES.reduce((acc, l) => {
          if (isLineShutdown(l)) acc[l] = getShutdownReason(l) || 'Line shutdown';
          return acc;
        }, {})}
      />

      {/* Feedmill-level auto-sequence modal */}
      {showFeedmillSeqPreview && feedmillSeqData && (
        <FeedmillAutoSequenceModal
          data={feedmillSeqData}
          isLoading={false}
          changeoverRules={changeoverRules}
          pmxSplitRules={pmxSplitRules}
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
          pmxSplitRules={pmxSplitRules}
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
        activeFeedmill={activeFeedmill}
        activeLine={activeSubSection}
        currentPage={
          activeSection === "configurations"
            ? activeSubSection === "order_history"
              ? "orderHistory"
              : activeSubSection === "knowledge_base"
              ? "knowledgeBase"
              : activeSubSection === "next_10_days"
              ? "n10d"
              : activeSubSection === "changeover_rules"
              ? "changeoverRules"
              : activeSubSection === "powermix_split_rules"
              ? "powermixSplit"
              : "configurations"
            : activeSection
        }
        onNavigate={handleNavigate}
      />
    </div>
  );
}
