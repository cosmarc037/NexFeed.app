import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import * as XLSX from "xlsx";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

import Header from "../components/layout/Header";
import Sidebar, { FEEDMILL_LINES } from "../components/layout/Sidebar";
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
import KnowledgeBaseManager from "../components/orders/KnowledgeBaseManager";
import Next10DaysManager from "../components/orders/Next10DaysManager";
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
import { autoSequenceOrders, buildInsightTemplates } from "@/services/azureAI";
import { setTemplateInsights, hasInsights, getInsight } from "@/utils/insightCache";
import { getProductStatus } from "@/utils/statusUtils";
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
  if (tab === "all") return orders;
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

export default function Dashboard() {
  const queryClient = useQueryClient();

  // UI State
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeSection, setActiveSection] = useState("orders");
  const [activeSubSection, setActiveSubSection] = useState("all");
  const [activeFeedmill, setActiveFeedmill] = useState("FM1");
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

  // Feedmill shutdown / order diversion state (in-memory, no DB persistence)
  const [feedmillStatus, setFeedmillStatus] = useState({
    FM1: { isShutdown: false, shutdownDate: null, reason: '', notes: '', affectedLines: [] },
    FM2: { isShutdown: false, shutdownDate: null, reason: '', notes: '', affectedLines: [] },
    FM3: { isShutdown: false, shutdownDate: null, reason: '', notes: '', affectedLines: [] },
    PMX: { isShutdown: false, shutdownDate: null, reason: '', notes: '', affectedLines: [] },
  });
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
        };
      });
    }

    const lineGroups = {};
    for (const o of result) {
      if (!o.feedmill_line) continue;
      if (!lineGroups[o.feedmill_line]) lineGroups[o.feedmill_line] = [];
      lineGroups[o.feedmill_line].push(o);
    }

    // Identify first active (non-completed/cancel_po) order per line for default start values
    const firstInLineStartDefaults = {};
    for (const line in lineGroups) {
      const sorted = [...lineGroups[line]].sort(
        (a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity),
      );
      const firstActive = sorted.find(
        (o) => o.status !== "completed" && o.status !== "cancel_po",
      );
      if (firstActive && !firstActive.start_date && isAvailDateValidMemo(firstActive.target_avail_date)) {
        firstInLineStartDefaults[firstActive.id] = {
          start_date: firstActive.target_avail_date,
          start_time: firstActive.start_time || "08:00",
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

  // Auto-populate template insights whenever N10D records or orders change —
  // no need to visit the N10D tab first.
  useEffect(() => {
    if (activeN10DRecords.length === 0 || enrichedOrders.length === 0) return;
    const uncached = enrichedOrders.filter((o) => {
      const code = String(o.material_code_fg || o.material_code || "");
      return code && !getInsight(code);
    });
    if (uncached.length > 0 || !hasInsights()) {
      const templateMap = buildInsightTemplates(activeN10DRecords, enrichedOrders);
      setTemplateInsights(templateMap);
    }
  }, [activeN10DRecords.length, enrichedOrders.length]);

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
          (o.fpr || "").toLowerCase().includes(term),
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
    return counts;
  }, [orders]);

  // Handle status change from Status dropdown
  const handleStatusChange = async (order, newStatus) => {
    const ts = formatTimestamp();
    const oldStatus = order.status || "plotted";

    const extraData = {};

    // Ordering check: In Production / On-going can only be set when all orders
    // above on the same line are Done / In Production / On-going / Planned.
    const ONGOING_STATUSES = ["ongoing_batching", "ongoing_pelleting", "ongoing_bagging"];
    if (newStatus === "in_production" || ONGOING_STATUSES.includes(newStatus)) {
      const ALLOWED_ABOVE = [
        "completed", "in_production",
        "ongoing_batching", "ongoing_pelleting", "ongoing_bagging",
        "planned", "cancel_po",
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

    // Setting to Done: store previous prio + precise timestamp for FIFO rotation
    if (newStatus === "completed") {
      const now = new Date();
      extraData.end_date = now.toISOString().split("T")[0];
      extraData.end_time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      extraData.previous_prio = order.priority_seq ?? null;
      extraData.done_timestamp = now.toISOString();
    }

    // Reverting from Done to active: restore previous prio position
    if (oldStatus === "completed" && newStatus !== "completed") {
      extraData.end_date = null;
      extraData.end_time = null;
      extraData.previous_prio = null;
      extraData.done_timestamp = null;

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
      feedmill_line: order.feedmill_line,
      total_volume_mt: portion2,
      volume_override: null,
      is_cut: true,
      cut_original_volume: effVol,
      cut_note: `Cut: Portion 2 of 2 — ${portion2} MT (split from FPR ${order.fpr})`,
      prod_remarks: cutRemark,
      status: "cut",
      form: order.form,
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
    // Form — preserve exact value, normalize lowercase
    if (entry.form)
      updates.form =
        String(entry.form).toUpperCase() === entry.form
          ? entry.form
          : entry.form.charAt(0).toUpperCase() + entry.form.slice(1);
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
  const handleReapplyKB = async (activeKBRecords) => {
    const kbMap = buildLocalKBMap(activeKBRecords);
    const toUpdate = orders.filter((o) => o.status !== "completed");
    await Promise.all(
      toUpdate.map((order) => {
        const entry = kbMap[String(order.material_code || "").trim()];
        const updates = applyKBFields(order, entry);
        if (!Object.keys(updates).length) return Promise.resolve();
        return updateOrderMutation.mutateAsync({ id: order.id, data: updates });
      }),
    );
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

  // Reverse map: line name → feedmill key
  const LINE_TO_FM_KEY = {
    'Line 1': 'FM1', 'Line 2': 'FM1',
    'Line 3': 'FM2', 'Line 4': 'FM2',
    'Line 5': 'PMX',
    'Line 6': 'FM3', 'Line 7': 'FM3',
  };

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
      await createOrderMutation.mutateAsync({
        ...orderData,
        priority_seq: insertionPrio,
        status: "normal",
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
          description: bulletLines + moreText + '\n\nRun Auto-Sequence to apply updated positions.',
          duration: 60000,
        }
      );
    }

    // Fix any auto-sequenced orders that still have the old 'stock_sufficient' sentinel
    // value — write the actual N10D window-end date now that we have real data
    const stockSentinelOrders = activeOrders.filter(
      (o) => o.avail_date_source === 'auto_sequence' && o.target_avail_date === 'stock_sufficient',
    );
    if (stockSentinelOrders.length > 0) {
      await Promise.all(
        stockSentinelOrders.map((o) => {
          const inf = freshMap[o.material_code];
          if (!inf?.targetDate) return Promise.resolve();
          return updateOrderMutation.mutateAsync({
            id: o.id,
            data: {
              target_avail_date: inf.targetDate,
              last_target_date: inf.targetDate,
            },
          });
        }),
      );
    }

    // N10D data saved — inferredTargetMap will update reactively.
    // Auto-sorting is intentionally disabled here; use Auto-Sequence to sort by target dates.
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

        // Only save new orders (byLine arrays now contain only new orders after splice)
        const ordersToCreate = Object.values(byLine).flat();
        console.log(
          "[Upload] Step 5: Saving",
          ordersToCreate.length,
          "new orders to database...",
        );
        if (ordersToCreate.length > 0)
          console.log(
            "[Upload] Sample order to save:",
            JSON.stringify(ordersToCreate[0]),
          );
        await bulkCreateMutation.mutateAsync(ordersToCreate);

        // Re-sequence existing orders displaced by new dated order insertions
        if (existingReseqUpdates.length > 0) {
          console.log(
            "[Upload] Resequencing",
            existingReseqUpdates.length,
            "existing orders...",
          );
          await Promise.all(
            existingReseqUpdates.map(({ id, priority_seq }) =>
              updateOrderMutation.mutateAsync({ id, data: { priority_seq } }),
            ),
          );
        }

        // Persist NEW badge FPRs (non-dated appended orders) to localStorage
        if (newNonDatedBadgeFprs.length > 0) {
          const existing = JSON.parse(
            localStorage.getItem("nexfeed_new_non_dated_fprs") || "[]",
          );
          const updated = [
            ...existing.filter((b) => Date.now() - b.ts < 24 * 60 * 60 * 1000),
            ...newNonDatedBadgeFprs.map((fpr) => ({ fpr, ts: Date.now() })),
          ];
          localStorage.setItem(
            "nexfeed_new_non_dated_fprs",
            JSON.stringify(updated),
          );
        }

        console.log("[Upload] Step 6: Success!");

        // Build per-line summary toast
        const statsLines = Object.entries(lineUploadStats);
        if (statsLines.length > 0) {
          const bulletLines = statsLines.map(([line, s]) => {
            const parts = [];
            if (s.newDated > 0)
              parts.push(`${s.newDated} dated order${s.newDated !== 1 ? "s" : ""} merged`);
            if (s.newNonDated > 0)
              parts.push(`${s.newNonDated} non-dated order${s.newNonDated !== 1 ? "s" : ""} added to bottom`);
            if (parts.length === 0) parts.push("no new orders added");
            return { line, text: parts.join(", ") };
          });
          toast("✅ SAP Upload Complete", {
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
            duration: 60000,
            style: {
              background: "#f0fdf4",
              borderLeft: "4px solid #43a047",
              color: "#111827",
            },
          });
        } else {
          toast.success(
            `Successfully imported ${ordersToCreate.length} orders`,
          );
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

    for (let i = 0; i < orderedList.length; i++) {
      const order = orderedList[i];

      if (order.status === "completed" || order.status === "cancel_po") {
        const d = parseCompletionDateStr(order.target_completion_date);
        if (d) prevCompletion = d;
        continue;
      }

      if (i < startFromIndex) {
        const stored = parseCompletionDateStr(order.target_completion_date);
        if (stored) prevCompletion = stored;
        else prevCompletion = null;
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

      // For start_date/start_time: use the order's own value, or for the very first
      // order in the list (i===0) with no start values, fall back to avail_date + 08:00
      const effectiveStartDate =
        updatedOrder.start_date ||
        (i === 0 && isAvailDateValidMemo(updatedOrder.target_avail_date)
          ? updatedOrder.target_avail_date
          : null);
      const effectiveStartTime =
        updatedOrder.start_time || (effectiveStartDate && i === 0 ? "08:00" : null);

      if (effectiveStartDate && effectiveStartTime) {
        const ph =
          updatedOrder.production_hours != null
            ? parseFloat(updatedOrder.production_hours)
            : 0;
        newCompletion = calcCompletionDate(
          effectiveStartDate,
          effectiveStartTime,
          ph,
          0,
        );
      } else if (prevCompletion) {
        const ph =
          updatedOrder.production_hours != null
            ? parseFloat(updatedOrder.production_hours)
            : 0;
        const co =
          updatedOrder.changeover_time != null
            ? parseFloat(updatedOrder.changeover_time)
            : 0.17;
        newCompletion = new Date(
          prevCompletion.getTime() + (ph + co) * 3600000,
        );
      }

      const newCompletionStr = newCompletion
        ? formatCompletionDate(newCompletion)
        : null;
      prevCompletion = newCompletion;

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
      if (
        firstActive &&
        !firstActive.start_date &&
        isAvailDateValid(firstActive.target_avail_date) &&
        !firstActive.target_completion_date
      ) {
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
    await Promise.all(
      reordered.map((o, i) =>
        o && o.priority_seq !== i
          ? updateOrderMutation.mutateAsync({
              id: o.id,
              data: { priority_seq: i },
            })
          : Promise.resolve(),
      ),
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

  const handleDivertOrderConfirm = async (order, selectedLine, calcs, aiText) => {
    const diversionData = {
      originalLine: order.feedmill_line || order.line || '',
      originalFeedmill: Object.entries(feedmillStatus).find(([, s]) => s.isShutdown) ? Object.entries(feedmillStatus).filter(([, s]) => s.isShutdown).map(([fm]) => fm).join(', ') : '',
      currentLine: selectedLine.line,
      divertedAt: new Date().toISOString(),
      shutdownReason: Object.entries(feedmillStatus).filter(([, s]) => s.isShutdown).map(([fm]) => feedmillStatus[fm].reason || fm).join(', ') || 'Shutdown',
      aiAnalysis: aiText,
      calculatedProductionTime: calcs?.newProductionTime,
    };
    await handleUpdateOrder(order.id, {
      feedmill_line: selectedLine.line,
      diversion_data: diversionData,
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
    await handleUpdateOrder(order.id, {
      feedmill_line: originalLine,
      diversion_data: null,
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
          toast(`↕ Order re-sorted`, {
            description: `FPR ${order.fpr} moved from Prio ${oldPrio} to Prio ${newPrio} to maintain date sequence (${dateLabel}).`,
            duration: 4000,
            style: { background: "#eff6ff", borderLeft: "4px solid #3b82f6" },
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

    if ((triggersCascade || completionReverted) && order.feedmill_line) {
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
      // Mirrors the app's standard insertion rule:
      //   - Dated lead  → insert before the first non-dated order OR the first
      //                    order whose avail date is strictly later.
      //   - Non-dated   → insert after all dated orders, before other non-dated ones.
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
        // No valid date → insert after all dated top-level orders, before other non-dated ones
        insertIdx = nonGroupTopLevel.length; // default: very end of top-level
        for (let j = 0; j < nonGroupTopLevel.length; j++) {
          if (!isValidISODate(nonGroupTopLevel[j].target_avail_date)) {
            insertIdx = j; // first non-dated top-level slot → lead goes here
            break;
          }
        }
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
            <Loader2 className="h-8 w-8 animate-spin text-[#fd5108]" />
          </div>
        );
      return (
        <PlannedOrdersContent
          orders={enrichedOrders}
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
          onAutoSequence={handleAutoSequence}
          lastUploadDate={lastUploadDate}
          inferredTargetMap={inferredTargetMap}
          lastN10DUploadDate={lastN10DUploadDate}
          onNavigateToN10D={() => {
            setActiveSection("configurations");
            setActiveSubSection("next_10_days");
          }}
          onAddOrder={handleOpenAddOrder}
          feedmillStatus={feedmillStatus}
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
            <Loader2 className="h-8 w-8 animate-spin text-[#fd5108]" />
          </div>
        );
      return (
        <PlannedOrdersContent
          orders={enrichedOrders}
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
          onAutoSequence={handleAutoSequence}
          lastUploadDate={lastUploadDate}
          inferredTargetMap={inferredTargetMap}
          lastN10DUploadDate={lastN10DUploadDate}
          onNavigateToN10D={() => {
            setActiveSection("configurations");
            setActiveSubSection("next_10_days");
          }}
          onAddOrder={handleOpenAddOrder}
          feedmillStatus={feedmillStatus}
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
          />
        );
      }
      // Order History (default)
      const completedOrders = enrichedOrders
        .filter((o) => o.status === "completed")
        .sort((a, b) => {
          const aDate = a.end_date || a.updated_date || "";
          const bDate = b.end_date || b.updated_date || "";
          return bDate > aDate ? 1 : bDate < aDate ? -1 : 0;
        });
      const cancelledOrders = enrichedOrders
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
                  ? "text-[#fd5108] border-b-2 border-[#fd5108]"
                  : "text-gray-500 hover:text-gray-700"
              }`}
              data-testid="tab-history-completed"
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
                  ? "text-[#fd5108] border-b-2 border-[#fd5108]"
                  : "text-gray-500 hover:text-gray-700"
              }`}
              data-testid="tab-history-cancelled"
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
          <div className="flex items-center gap-1 mb-4 flex-wrap">
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
                      ? "bg-[#fd5108] text-white"
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
      );
    }

    return null;
  };

  return (
    <div className="min-h-screen bg-[#f5f7f8]">
      <Header onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />

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
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 p-5 space-y-4">
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
          onConfirm={handleDivertOrderConfirm}
          onClose={() => setDivertDialog(null)}
        />
      )}

      {revertDialog && (
        <RevertOrderDialog
          order={revertDialog.order}
          feedmillStatus={feedmillStatus}
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
              {inProdOrderingDialog?.newStatus === "in_production"
                ? "Cannot Set In Production"
                : "Cannot Set On-going"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-[13px] leading-relaxed text-gray-700">
                <p>
                  There are orders at earlier priorities that have not been
                  produced or completed yet. Consider producing or completing
                  those orders first before{" "}
                  {inProdOrderingDialog?.newStatus === "in_production"
                    ? "starting this one."
                    : "marking this order as on-going."}
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
              style={{ background: "#fd5108", color: "#ffffff", border: "none" }}
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
      />

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

      {(activeSection === "orders" || activeSection === "planned") && (
        <SmartCombinePanel
          orders={enrichedOrders}
          allOrders={enrichedOrders}
          activeFeedmill={activeFeedmill}
          activeSubSection={activeSubSection}
          kbRecords={kbRecords}
          onCombine={handleSmartCombine}
          newFprValues={newFprValues}
        />
      )}

      {/* AI Chatbot */}
      <AIChatbot orders={orders} hidden={anyModalOpen} />
    </div>
  );
}
