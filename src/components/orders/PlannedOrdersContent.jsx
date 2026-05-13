import React, { useState, useMemo } from "react";
import { Upload, Download, Sparkles, Settings, ClipboardList, Plus } from "lucide-react";
import * as XLSX from "xlsx";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FEEDMILL_LINES } from "../layout/Sidebar";
import SearchFilter from "./SearchFilter";
import KeyMetrics from "./KeyMetrics";
import InsightAlertsPanel from "./InsightAlertsPanel";
import OrderTable from "./OrderTable";
import ExportButton from "./ExportButton";

function getFeedmillFullName(fm) {
  if (fm === 'FM1' || fm === 'Feedmill 1') return 'Feedmill 1';
  if (fm === 'FM2' || fm === 'Feedmill 2') return 'Feedmill 2';
  if (fm === 'FM3' || fm === 'Feedmill 3') return 'Feedmill 3';
  if (fm === 'PMX' || fm === 'Powermix') return 'Line 5 (PMX)';
  return fm || 'Feedmill';
}

function getLineDisplayName(line) {
  const match = (line || '').match(/\d+/);
  if (!match) return line || 'Line';
  return match[0] === '5' ? `Line 5 (PMX)` : `Line ${match[0]}`;
}

// Map FM id → line names
const FM_LINE_MAP = {
  FM1: ["Line 1", "Line 2"],
  FM2: ["Line 3", "Line 4"],
  FM3: ["Line 6", "Line 7"],
  PMX: ["Line 5"],
};

// All lines across all feedmills in display order
const ALL_FM_LINES_ORDERED = [
  { feedmill: "FM1", fmLabel: "Feedmill 1", line: "Line 1" },
  { feedmill: "FM1", fmLabel: "Feedmill 1", line: "Line 2" },
  { feedmill: "FM2", fmLabel: "Feedmill 2", line: "Line 3" },
  { feedmill: "FM2", fmLabel: "Feedmill 2", line: "Line 4" },
  { feedmill: "FM3", fmLabel: "Feedmill 3", line: "Line 6" },
  { feedmill: "FM3", fmLabel: "Feedmill 3", line: "Line 7" },
  { feedmill: "PMX", fmLabel: "Powermix", line: "Line 5" },
];

const FM_LINES_DETAIL = {
  FM1: {
    all: "All orders for Feedmill 1 (Line 1 & 2)",
    "Line 1": "Orders assigned to Line 1",
    "Line 2": "Orders assigned to Line 2",
  },
  FM2: {
    all: "All orders for Feedmill 2 (Line 3 & 4)",
    "Line 3": "Orders assigned to Line 3",
    "Line 4": "Orders assigned to Line 4",
  },
  FM3: {
    all: "All orders for Feedmill 3 (Line 6 & 7)",
    "Line 6": "Orders assigned to Line 6",
    "Line 7": "Orders assigned to Line 7",
  },
  PMX: { all: "Orders assigned to Line 5" },
};

const FM_TABS = {
  FM1: [
    { id: "all", label: "All" },
    { id: "Line 1", label: "Line 1" },
    { id: "Line 2", label: "Line 2" },
  ],
  FM2: [
    { id: "all", label: "All" },
    { id: "Line 3", label: "Line 3" },
    { id: "Line 4", label: "Line 4" },
  ],
  FM3: [
    { id: "all", label: "All" },
    { id: "Line 6", label: "Line 6" },
    { id: "Line 7", label: "Line 7" },
  ],
  PMX: [], // No sub-tabs for Powermix
};

// Active = not done, not cancelled
const isActiveOrder = (o) =>
  o.status !== "completed" && o.status !== "cancel_po";

// Returns the "group key" for a done order — lead ID for groups, null for standalone
function getDoneGroupKey(order) {
  if (order.parent_id) return order.parent_id; // child → lead's id
  if (order.original_order_ids?.length) return order.id; // lead → own id
  return null; // standalone
}

// Get the best available cancellation timestamp for a cancelled order.
function getCancelledTimestamp(order) {
  if (order.cancelled_at) return order.cancelled_at;
  // Fallback: combine date + time strings stored separately
  if (order.cancelled_date) {
    return order.cancelled_date + (order.cancelled_time ? `T${order.cancelled_time}:00` : "T00:00:00");
  }
  return order.updated_date || "";
}

// Returns the top `limit` cancelled orders, newest first (most recently cancelled at top).
function getCancelledOrdersToDisplay(allCancelledOrders, limit = 3) {
  return [...allCancelledOrders]
    .sort((a, b) => {
      const aT = getCancelledTimestamp(a);
      const bT = getCancelledTimestamp(b);
      return bT > aT ? 1 : bT < aT ? -1 : 0;
    })
    .slice(0, limit);
}

// Get the best available timestamp for a Done order (most precise first).
function getDoneTimestamp(order) {
  // done_timestamp is set as an ISO string when the order is marked Done
  if (order.done_timestamp) return order.done_timestamp;
  // Fallback: history entry timestamp
  const histEntry = order.history?.findLast?.((h) => h.action?.includes("Done"));
  if (histEntry?.timestamp) return histEntry.timestamp;
  // Fallback: end_date/end_time or updated_date
  if (order.end_date) {
    return order.end_date + (order.end_time ? `T${order.end_time}:00` : "T00:00:00");
  }
  return order.updated_date || "";
}

// Returns the top `limit` done "units" (combined group = 1 unit) including all group members.
// SELECTION: 3 most recently completed units.
// DISPLAY ORDER: oldest at top (prio 1), newest at bottom (prio 3) — FIFO rotation.
function getDoneOrdersToDisplay(allDoneOrders, limit = 3) {
  // Sort most-recent first for SELECTION purposes
  const sortedDesc = [...allDoneOrders].sort((a, b) => {
    const aT = getDoneTimestamp(a);
    const bT = getDoneTimestamp(b);
    return bT > aT ? 1 : bT < aT ? -1 : 0;
  });

  // Walk through newest-first to select top `limit` units
  const selectedGroupKeys = new Set();
  const selectedStandaloneIds = new Set();
  let unitCount = 0;

  for (const order of sortedDesc) {
    if (unitCount >= limit) break;
    const key = getDoneGroupKey(order);
    if (key) {
      if (!selectedGroupKeys.has(key)) {
        selectedGroupKeys.add(key);
        unitCount++;
      }
    } else {
      if (!selectedStandaloneIds.has(order.id)) {
        selectedStandaloneIds.add(order.id);
        unitCount++;
      }
    }
  }

  // Collect all matching orders (includes all children of selected groups)
  const toDisplay = allDoneOrders.filter((o) => {
    const key = getDoneGroupKey(o);
    if (key) return selectedGroupKeys.has(key);
    return selectedStandaloneIds.has(o.id);
  });

  // Build unit-timestamp map for display ordering (oldest first = ascending)
  // Use the representative timestamp for each unit (lead or standalone)
  const unitTimestampMap = {};
  for (const order of toDisplay) {
    const key = getDoneGroupKey(order) || order.id;
    if (!(key in unitTimestampMap)) {
      unitTimestampMap[key] = getDoneTimestamp(order);
    }
  }

  // Final sort: ASCENDING by completion time — oldest at top, newest at bottom
  toDisplay.sort((a, b) => {
    const aKey = getDoneGroupKey(a) || a.id;
    const bKey = getDoneGroupKey(b) || b.id;
    if (aKey !== bKey) {
      const tA = unitTimestampMap[aKey] || "";
      const tB = unitTimestampMap[bKey] || "";
      return tA > tB ? 1 : tA < tB ? -1 : 0; // oldest first
    }
    // Same group: lead first, then children by priority_seq
    const aIsLead = !a.parent_id && a.original_order_ids?.length;
    const bIsLead = !b.parent_id && b.original_order_ids?.length;
    if (aIsLead && !bIsLead) return -1;
    if (!aIsLead && bIsLead) return 1;
    return (a.priority_seq ?? 0) - (b.priority_seq ?? 0);
  });

  return toDisplay;
}

export default function PlannedOrdersContent({
  orders,
  activeFeedmill,
  activeSubSection,
  onSubSectionChange,
  onStatusChange,
  onCancelRequest,
  onRestoreRequest,
  onUncombineRequest,
  onCutRequest,
  onMergeBackRequest,
  onUpdateOrder,
  onReorder,
  onUpload,
  isUploading,
  sortConfig,
  onSort,
  onAutoSequence,
  onPlantAutoSequence = null,
  onFeedmillAutoSequence = null,
  lastUploadDate,
  inferredTargetMap = {},
  lastN10DUploadDate = null,
  onNavigateToN10D = null,
  onAddOrder = null,
  feedmillStatus = {},
  lineShutdowns = {},
  kbRecords = [],
  n10dRecords = [],
  onDivertOrder,
  onRevertOrder,
}) {
  const [searchTerm, setSearchTerm] = useState("");
  const [filters, setFilters] = useState({
    form: "all",
    status: "all",
    readiness: "all",
  });

  const fmLines = FM_LINE_MAP[activeFeedmill] || [];
  const tabs = FM_TABS[activeFeedmill] || [];
  const lineDetail = FM_LINES_DETAIL[activeFeedmill] || {};
  const fmLabel =
    FEEDMILL_LINES.find((f) => f.id === activeFeedmill)?.label ||
    activeFeedmill;

  // Title/sub-header
  const titleTab =
    activeSubSection === "all"
      ? "All Orders"
      : activeFeedmill === "PMX"
        ? "Powermix Orders"
        : `${activeSubSection} Orders`;
  const subHeader =
    activeFeedmill === "PMX"
      ? lineDetail.all
      : lineDetail[activeSubSection] || lineDetail.all;

  // Filter orders for this FM line + line sub-tab
  const filteredOrders = useMemo(() => {
    let result = orders.filter((o) => fmLines.includes(o.feedmill_line));

    // Line sub-tab filter
    if (activeSubSection !== "all") {
      result = result.filter((o) => o.feedmill_line === activeSubSection);
    }

    const allCompleted = result.filter((o) => o.status === "completed");
    const completed = getDoneOrdersToDisplay(allCompleted, 3);

    const allCancelled = result.filter((o) => o.status === "cancel_po");
    const cancelled = getCancelledOrdersToDisplay(allCancelled, 3);
    const cancelledHistory = allCancelled.filter((o) => !cancelled.includes(o));

    console.debug("[Order Table Blocks]", {
      visibleDone: completed.map((o) => ({ id: o.id, done_at: o.done_timestamp })),
      active: result.filter((o) => o.status !== "completed" && o.status !== "cancel_po").map((o) => ({ id: o.id })),
      visibleCancelled: cancelled.map((o) => ({ id: o.id, cancelled_at: o.cancelled_at || getCancelledTimestamp(o) })),
      cancelledHistory: cancelledHistory.map((o) => ({ id: o.id, cancelled_at: o.cancelled_at || getCancelledTimestamp(o) })),
    });

    let active = result.filter(
      (o) => o.status !== "completed" && o.status !== "cancel_po",
    );

    // Search — applied across all active orders on all visible lines
    if (searchTerm) {
      const t = searchTerm.toLowerCase();
      active = active.filter((o) => {
        const fields = [
          o.fpr,
          o.item_description,
          o.material_code,
          o.material_code_fg,
          o.material_code_sfg,
          o.planned_order_fg,
          o.planned_order_sfg,
          o.production_order_fg1,
          o.production_order_sfg1,
          o.category,
          o.form,
          o.status,
          o.avail_date,
          o.feedmill_line,
          o.volume != null ? String(o.volume) : null,
          o.prio != null ? String(o.prio) : null,
        ];
        return fields.some(
          (f) => f && String(f).toLowerCase().includes(t),
        );
      });
    }

    // Filters
    if (filters.form && filters.form !== "all")
      active = active.filter((o) => o.form === filters.form);
    if (filters.status && filters.status !== "all")
      active = active.filter((o) => o.status === filters.status);

    // Sort active by priority_seq
    active.sort(
      (a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity),
    );

    // Compact combined groups: move children to immediately after their lead
    const leadToChildrenLocal = {};
    const childLeadMapLocal = {};
    active.forEach((o) => {
      if (o.parent_id) {
        if (!leadToChildrenLocal[o.parent_id])
          leadToChildrenLocal[o.parent_id] = [];
        leadToChildrenLocal[o.parent_id].push(o);
        childLeadMapLocal[o.id] = o.parent_id;
      }
    });
    if (Object.keys(leadToChildrenLocal).length > 0) {
      const compacted = [];
      const processed = new Set();
      active.forEach((o) => {
        if (processed.has(o.id)) return;
        if (childLeadMapLocal[o.id]) {
          // Skip child if its lead exists in the list (will be inserted after the lead)
          if (active.find((lo) => lo.id === childLeadMapLocal[o.id])) return;
          compacted.push(o);
          processed.add(o.id);
          return;
        }
        compacted.push(o);
        processed.add(o.id);
        if (leadToChildrenLocal[o.id]) {
          [...leadToChildrenLocal[o.id]]
            .sort((a, b) => (a.priority_seq ?? 0) - (b.priority_seq ?? 0))
            .forEach((child) => {
              compacted.push(child);
              processed.add(child.id);
            });
        }
      });
      active = compacted;
    }

    return { completed, active, cancelled };
  }, [orders, activeFeedmill, activeSubSection, searchTerm, filters]);

  const lineOrdersForMetrics = [
    ...filteredOrders.completed,
    ...filteredOrders.active,
    ...filteredOrders.cancelled,
  ];

  const isAllTab = activeSubSection === "all" && fmLines.length > 1;

  const perLineData = useMemo(() => {
    if (!isAllTab) return null;
    return fmLines.map((lineName) => {
      const lineCompleted = filteredOrders.completed.filter(
        (o) => o.feedmill_line === lineName,
      );
      const lineActive = filteredOrders.active.filter(
        (o) => o.feedmill_line === lineName,
      );
      const lineCancelled = filteredOrders.cancelled.filter(
        (o) => o.feedmill_line === lineName,
      );
      // Unfiltered active count for "X of Y" display when searching
      const unfilteredActive = orders.filter(
        (o) =>
          o.feedmill_line === lineName &&
          o.status !== "completed" &&
          o.status !== "cancel_po",
      ).length;
      return {
        lineName,
        completed: lineCompleted,
        active: lineActive,
        cancelled: lineCancelled,
        total: lineCompleted.length + lineActive.length + lineCancelled.length,
        unfilteredActive,
      };
    });
  }, [isAllTab, fmLines, filteredOrders, orders]);

  // Per-line data for "All Feedmills" view
  const isAllFeedmills = activeFeedmill === "ALL_FM";
  const allFmPerLineData = useMemo(() => {
    if (!isAllFeedmills) return null;
    return ALL_FM_LINES_ORDERED.map(({ feedmill, fmLabel, line }) => {
      const allLineOrders = orders.filter((o) => o.feedmill_line === line);
      const allCompleted = allLineOrders.filter((o) => o.status === "completed");
      const completed = getDoneOrdersToDisplay(allCompleted, 3);
      const allCancelled = allLineOrders.filter((o) => o.status === "cancel_po");
      const cancelled = getCancelledOrdersToDisplay(allCancelled, 3);
      let active = allLineOrders.filter(
        (o) => o.status !== "completed" && o.status !== "cancel_po"
      );
      if (searchTerm) {
        const t = searchTerm.toLowerCase();
        active = active.filter((o) => {
          const fields = [
            o.fpr, o.item_description, o.material_code, o.material_code_fg,
            o.material_code_sfg, o.planned_order_fg, o.planned_order_sfg,
            o.production_order_fg1, o.production_order_sfg1,
            o.category, o.form, o.status, o.avail_date, o.feedmill_line,
            o.volume != null ? String(o.volume) : null,
            o.prio != null ? String(o.prio) : null,
          ];
          return fields.some((f) => f && String(f).toLowerCase().includes(t));
        });
      }
      if (filters.form && filters.form !== "all")
        active = active.filter((o) => o.form === filters.form);
      if (filters.status && filters.status !== "all")
        active = active.filter((o) => o.status === filters.status);
      active.sort((a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity));

      // Compact combined groups: move children immediately after their lead (same as filteredOrders)
      const leadToChildrenLocal = {};
      const childLeadMapLocal = {};
      active.forEach((o) => {
        if (o.parent_id) {
          if (!leadToChildrenLocal[o.parent_id]) leadToChildrenLocal[o.parent_id] = [];
          leadToChildrenLocal[o.parent_id].push(o);
          childLeadMapLocal[o.id] = o.parent_id;
        }
      });
      if (Object.keys(leadToChildrenLocal).length > 0) {
        const compacted = [];
        const processed = new Set();
        active.forEach((o) => {
          if (processed.has(o.id)) return;
          if (childLeadMapLocal[o.id]) {
            if (active.find((lo) => lo.id === childLeadMapLocal[o.id])) return;
            compacted.push(o);
            processed.add(o.id);
            return;
          }
          compacted.push(o);
          processed.add(o.id);
          if (leadToChildrenLocal[o.id]) {
            [...leadToChildrenLocal[o.id]]
              .sort((a, b) => (a.priority_seq ?? 0) - (b.priority_seq ?? 0))
              .forEach((child) => {
                compacted.push(child);
                processed.add(child.id);
              });
          }
        });
        active = compacted;
      }

      const unfilteredActive = allLineOrders.filter(
        (o) => o.status !== "completed" && o.status !== "cancel_po"
      ).length;
      return { feedmill, fmLabel, line, completed, active, cancelled, unfilteredActive };
    });
  }, [isAllFeedmills, orders, searchTerm, filters]);

  function downloadSAPTemplate() {
    const headers = ["FPR", "Material Code", "Item Description", "Category", "Feedmill Line", "Metric Ton", "Remarks", "FG", "SFG", "SFG1", "PO STATUS"];
    const sampleData = [
      [260413, "1000000000543", "Salto Stag Developer P 1kg (Bundle)", "GAMEFOWL", "Line 5", 8, "prio replenish", "-----", "5863692", "5875660", "Planned"],
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleData]);
    ws["!cols"] = [
      { wch: 10 }, { wch: 18 }, { wch: 42 }, { wch: 12 }, { wch: 14 },
      { wch: 12 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, "SAP Orders");
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    XLSX.writeFile(wb, `SAP_Orders_Template_${dateStr}.xlsx`);
  }

  if (isAllFeedmills) {
    const allActive = orders.filter(
      (o) => o.status !== "completed" && o.status !== "cancel_po"
    );
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">All Feedmills</h1>
          <p className="text-gray-500 text-[12px] mt-1">
            Production orders across all feedmills and lines
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 flex-wrap">
          {onPlantAutoSequence && (
            <Button
              onClick={onPlantAutoSequence}
              variant="outline"
              size="sm"
              className="border-[var(--nexfeed-primary)] text-[var(--nexfeed-primary)] hover:bg-[var(--nexfeed-primary)] hover:text-white h-9 text-[12px]"
              data-testid="button-auto-sequence-all"
            >
              <Sparkles className="h-4 w-4 mr-1.5" />
              Auto-Sequence (All)
            </Button>
          )}
          <Button
            onClick={onUpload}
            disabled={isUploading}
            className="bg-[var(--nexfeed-primary)] hover:bg-[var(--nexfeed-primary-dark)] h-9 text-[12px]"
            size="sm"
          >
            <Upload className="h-4 w-4 mr-1.5" />
            {isUploading ? "Uploading..." : "Upload SAP Orders"}
          </Button>
          <ExportButton
            orders={allActive}
            feedmillTab="All Feedmills"
            orderCategory="All"
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="flex-1">
            <SearchFilter
              searchTerm={searchTerm}
              onSearchChange={setSearchTerm}
              filters={filters}
              onFilterChange={(k, v) => setFilters((p) => ({ ...p, [k]: v }))}
              onClearFilters={() => setFilters({ form: "all", status: "all", readiness: "all" })}
            />
          </div>
          <span
            onClick={downloadSAPTemplate}
            data-testid="link-sap-download-template"
            style={{ color: "#4b5563", fontSize: 13, fontWeight: 500, cursor: "pointer", padding: "6px 10px", transition: "color 0.15s", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 5, fontStyle: "normal", textDecoration: "none" }}
            onMouseEnter={e => e.currentTarget.style.color = "var(--nexfeed-primary)"}
            onMouseLeave={e => e.currentTarget.style.color = "#4b5563"}
          >
            <Download style={{ width: 13, height: 13 }} />
            Download SAP Orders Template
          </span>
        </div>

        <div className="metrics-cards">
          <KeyMetrics orders={allActive} inferredTargetMap={inferredTargetMap} />
        </div>

        <div className="production-insights">
          <InsightAlertsPanel
            orders={allActive}
            lastUploadDate={lastUploadDate}
            lastN10DUploadDate={lastN10DUploadDate}
            inferredTargetMap={inferredTargetMap}
            onUpload={onUpload}
            onAutoSequence={onPlantAutoSequence}
            onNavigateToN10D={onNavigateToN10D}
            feedmill={null}
            line="all"
            lineShutdowns={lineShutdowns}
            kbRecords={kbRecords}
          />
        </div>

        <div className="space-y-6">
          {(allFmPerLineData || []).map(({ feedmill, fmLabel, line, completed, active, cancelled, unfilteredActive }) => {
            const isSearching = searchTerm.trim().length > 0;
            const noActiveMatch = isSearching && active.length === 0;
            const lineShutdown = lineShutdowns[line];
            const isLineDown = !!(lineShutdown?.isShutdown);
            const headerBorderCls = isLineDown ? "border-red-400" : "border-gray-300";
            const headerBgCls = isLineDown ? "bg-red-50" : "bg-gray-200";
            const containerBorderCls = isLineDown ? "border-red-400" : "border-gray-200";
            const total = completed.length + active.length + cancelled.length;
            return (
              <div key={line} data-testid={`section-line-${line}`}>
                <div className={`flex items-center justify-between px-4 py-2.5 ${headerBgCls} border ${headerBorderCls} rounded-t-lg`}>
                  <div className="flex items-center gap-2">
                    <ClipboardList className={`h-4 w-4 ${isLineDown ? "text-red-600" : "text-[#2e343a]"}`} />
                    <span className={`text-sm font-bold ${isLineDown ? "text-red-700" : "text-[#2e343a]"}`}>
                      {fmLabel} — {line}
                    </span>
                    {isLineDown && (
                      <span style={{ fontSize: '10px', fontWeight: 700, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', padding: '1px 6px', borderRadius: '4px' }}>
                        🔴 SHUTDOWN
                      </span>
                    )}
                    {!isLineDown && onAddOrder && (
                      <>
                        <span className="text-[#d1d5db] text-[12px] select-none">|</span>
                        <button
                          onClick={() => onAddOrder(line)}
                          style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 500, color: "#c2410c", background: "none", border: "none", padding: 0, cursor: "pointer" }}
                          onMouseEnter={e => { e.currentTarget.style.textDecoration = "underline"; e.currentTarget.style.color = "#9a3412"; }}
                          onMouseLeave={e => { e.currentTarget.style.textDecoration = "none"; e.currentTarget.style.color = "#c2410c"; }}
                          data-testid={`button-add-order-${line}`}
                        >
                          <Plus style={{ width: 11, height: 11 }} />
                          Add Order
                        </button>
                      </>
                    )}
                  </div>
                  <span className="text-[13px] text-gray-500 font-medium" data-testid={`text-line-order-count-${line}`}>
                    {isSearching
                      ? `${active.length} of ${unfilteredActive} orders matching`
                      : `${total} orders`}
                  </span>
                </div>
                <div className={`border border-t-0 ${containerBorderCls} rounded-b-lg overflow-hidden`}>
                  {isLineDown && (
                    <div style={{ background: '#fef2f2', color: '#dc2626', fontSize: '12px', fontWeight: 600, padding: '8px 16px', borderBottom: '1px solid #fecaca' }}>
                      🔴 {line} — SHUTDOWN{lineShutdown.since ? ` since ${new Date(lineShutdown.since).toLocaleDateString()}` : ''}
                      {lineShutdown.reason ? ` · ${lineShutdown.reason}` : ''}
                    </div>
                  )}
                  {noActiveMatch ? (
                    <div className="py-5 text-center text-[12px] text-gray-400 italic bg-gray-50">
                      No orders matching &ldquo;{searchTerm}&rdquo; on {line}
                    </div>
                  ) : (
                    <OrderTable
                      orders={[...completed, ...active, ...cancelled]}
                      allOrders={orders}
                      onStatusChange={onStatusChange}
                      onCancelRequest={onCancelRequest}
                      onRestoreRequest={onRestoreRequest}
                      onUncombineRequest={onUncombineRequest}
                      onCutRequest={onCutRequest}
                      onMergeBackRequest={onMergeBackRequest}
                      onUpdateOrder={onUpdateOrder}
                      onReorder={(from, to) => {
                        const offset = completed.length;
                        onReorder && onReorder(from - offset, to - offset, active);
                      }}
                      sortConfig={sortConfig}
                      onSort={onSort}
                      completedCount={completed.length}
                      cancelledCount={cancelled.length}
                      activeFeedmill={feedmill}
                      inferredTargetMap={inferredTargetMap}
                      feedmillStatus={feedmillStatus}
                      lineShutdowns={lineShutdowns}
                      kbRecords={kbRecords}
                      n10dRecords={n10dRecords}
                      onDivertOrder={onDivertOrder}
                      onRevertOrder={onRevertOrder}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{titleTab}</h1>
        <p className="text-gray-500 text-[12px] mt-1">{subHeader}</p>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="line-tabs flex items-center gap-1" data-tour="orders-line-tabs">
          {tabs.map((tab) => {
            const isActive = activeSubSection === tab.id;
            const tabOrders = orders.filter((o) =>
              tab.id === "all"
                ? fmLines.includes(o.feedmill_line)
                : o.feedmill_line === tab.id,
            );
            const activeCount = tabOrders.filter(isActiveOrder).length;
            return (
              <button
                key={tab.id}
                onClick={() => onSubSectionChange(tab.id)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all flex items-center gap-1.5",
                  isActive
                    ? "bg-[var(--nexfeed-primary)] text-white"
                    : "text-[#2e343a] hover:bg-[#fff5ed]",
                )}
                data-testid={`tab-${tab.id}`}
              >
                {tab.label}
                {activeCount > 0 && (
                  <span
                    className={cn(
                      "text-[12px] px-1.5 py-0.5 rounded-full font-semibold",
                      isActive
                        ? "bg-white/20 text-white"
                        : "bg-gray-200 text-gray-600",
                    )}
                  >
                    {activeCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex gap-2">
          {onAutoSequence && (() => {
            // Feedmill-specific "All" tab → feedmill-level AS button
            if (isAllTab && !isAllFeedmills && onFeedmillAutoSequence) {
              return (
                <Button
                  onClick={() => onFeedmillAutoSequence(activeFeedmill)}
                  variant="outline"
                  size="sm"
                  className="auto-sequence-btn border-[var(--nexfeed-primary)] text-[var(--nexfeed-primary)] hover:bg-[var(--nexfeed-primary)] hover:text-white h-9 text-[12px]"
                  data-testid="button-auto-sequence"
                  data-tour="orders-auto-sequence"
                  title={`Optimize ${getFeedmillFullName(activeFeedmill)} utilization — find and move orders from other lines`}
                >
                  <Settings className="h-4 w-4 mr-1.5" />
                  Optimize {getFeedmillFullName(activeFeedmill)}
                </Button>
              );
            }
            // Feedmill "All" tab without handler (fallback disabled state)
            if (isAllTab && !isAllFeedmills) {
              return (
                <Button
                  variant="outline"
                  size="sm"
                  disabled
                  className="auto-sequence-btn border-[#d1d5db] text-[#d1d5db] h-9 text-[12px] opacity-60 cursor-not-allowed hover:bg-transparent hover:text-[#d1d5db]"
                  data-testid="button-auto-sequence"
                >
                  <Settings className="h-4 w-4 mr-1.5" />
                  Optimize {getFeedmillFullName(activeFeedmill)}
                </Button>
              );
            }
            // All Feedmills "all" view → keep Auto-Sequence (All); per-line tab → Optimize Line X
            return (
              <Button
                onClick={isAllFeedmills ? undefined : onAutoSequence}
                variant="outline"
                size="sm"
                disabled={isAllFeedmills}
                className={cn(
                  "auto-sequence-btn",
                  isAllFeedmills
                    ? "border-[#d1d5db] text-[#d1d5db] h-9 text-[12px] opacity-60 cursor-not-allowed hover:bg-transparent hover:text-[#d1d5db]"
                    : "border-[var(--nexfeed-primary)] text-[var(--nexfeed-primary)] hover:bg-[var(--nexfeed-primary)] hover:text-white h-9 text-[12px]"
                )}
                data-testid="button-auto-sequence"
                data-tour="orders-auto-sequence"
                title={isAllFeedmills ? "Auto-sequence entire plant — combine, move, and sort all orders" : (() => {
                  const resolvedLine = (activeSubSection === "all" && fmLines.length === 1) ? fmLines[0] : activeSubSection;
                  return `Optimize ${getLineDisplayName(resolvedLine)} utilization — find and move orders from other lines`;
                })()}
              >
                {isAllFeedmills ? <Sparkles className="h-4 w-4 mr-1.5" /> : <Settings className="h-4 w-4 mr-1.5" />}
                {isAllFeedmills
                  ? "Auto-Sequence (All)"
                  : `Optimize ${getLineDisplayName((activeSubSection === "all" && fmLines.length === 1) ? fmLines[0] : activeSubSection)}`}
              </Button>
            );
          })()}
          <Button
            onClick={onUpload}
            disabled={isUploading}
            className="bg-[var(--nexfeed-primary)] hover:bg-[var(--nexfeed-primary-dark)] h-9 text-[12px]"
            size="sm"
            data-tour="orders-upload-sap"
          >
            <Upload className="h-4 w-4 mr-1.5" />
            {isUploading ? "Uploading..." : "Upload SAP Orders"}
          </Button>
          <div data-tour="orders-export">
            <ExportButton
              orders={lineOrdersForMetrics}
              feedmillTab={fmLabel}
              orderCategory={
                activeSubSection === "all" ? "All" : activeSubSection
              }
            />
          </div>
        </div>
      </div>

      <div className="search-bar-container" data-tour="orders-search">
        <SearchFilter
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          filters={filters}
          onFilterChange={(k, v) => setFilters((p) => ({ ...p, [k]: v }))}
          onClearFilters={() =>
            setFilters({ form: "all", status: "all", readiness: "all" })
          }
        />
      </div>

      <div className="metrics-cards" data-tour="orders-metrics">
        <KeyMetrics orders={lineOrdersForMetrics} inferredTargetMap={inferredTargetMap} />
      </div>

      <div className="production-insights">
        <InsightAlertsPanel
          orders={lineOrdersForMetrics}
          lastUploadDate={lastUploadDate}
          lastN10DUploadDate={lastN10DUploadDate}
          inferredTargetMap={inferredTargetMap}
          onUpload={onUpload}
          onAutoSequence={onAutoSequence}
          onNavigateToN10D={onNavigateToN10D}
          feedmill={activeFeedmill}
          line={activeSubSection || 'all'}
          lineShutdowns={lineShutdowns}
          kbRecords={kbRecords}
        />
      </div>

      {isAllTab && perLineData ? (
        <div className="space-y-6">
          {perLineData.map(
            ({ lineName, completed, active, cancelled, total, unfilteredActive }) => {
              const isSearching = searchTerm.trim().length > 0;
              const noActiveMatch = isSearching && active.length === 0;
              const lineShutdown = lineShutdowns[lineName];
              const isLineDown = !!(lineShutdown?.isShutdown);
              const headerBorderCls = isLineDown ? "border-red-400" : "border-gray-300";
              const headerBgCls = isLineDown ? "bg-red-50" : "bg-gray-200";
              const containerBorderCls = isLineDown ? "border-red-400" : "border-gray-200";
              return (
                  <div key={lineName} data-testid={`section-line-${lineName}`}>
                    <div className={`flex items-center justify-between px-4 py-2.5 ${headerBgCls} border ${headerBorderCls} rounded-t-lg`}>
                      <div className="flex items-center gap-2">
                        <ClipboardList className={`h-4 w-4 ${isLineDown ? "text-red-600" : "text-[#2e343a]"}`} />
                        <span className={`text-sm font-bold ${isLineDown ? "text-red-700" : "text-[#2e343a]"}`}>
                          {lineName}
                        </span>
                        {isLineDown && (
                          <span style={{ fontSize: '10px', fontWeight: 700, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', padding: '1px 6px', borderRadius: '4px' }}>
                            🔴 SHUTDOWN
                          </span>
                        )}
                        {!isLineDown && onAddOrder && (
                          <>
                            <span className="text-[#d1d5db] text-[12px] select-none">|</span>
                            <button
                              onClick={() => onAddOrder(lineName)}
                              style={{
                                display: "flex", alignItems: "center", gap: 4,
                                fontSize: 12, fontWeight: 500, color: "#c2410c",
                                background: "none", border: "none",
                                padding: 0, cursor: "pointer",
                              }}
                              onMouseEnter={e => { e.currentTarget.style.textDecoration = "underline"; e.currentTarget.style.color = "#9a3412"; }}
                              onMouseLeave={e => { e.currentTarget.style.textDecoration = "none"; e.currentTarget.style.color = "#c2410c"; }}
                              data-testid={`button-add-order-${lineName}`}
                              data-tour="orders-add-order"
                            >
                              <Plus style={{ width: 11, height: 11 }} />
                              Add Order
                            </button>
                          </>
                        )}
                      </div>
                      <span className="text-[13px] text-gray-500 font-medium" data-testid={`text-line-order-count-${lineName}`}>
                        {isSearching
                          ? `${active.length} of ${unfilteredActive} orders matching`
                          : `${total} orders`}
                      </span>
                    </div>
                    <div className={`border border-t-0 ${containerBorderCls} rounded-b-lg overflow-hidden`}>
                      {isLineDown && (
                        <div style={{ background: '#fef2f2', color: '#dc2626', fontSize: '12px', fontWeight: 600, padding: '8px 16px', borderBottom: '1px solid #fecaca' }}>
                          🔴 {lineName} — SHUTDOWN{lineShutdown.since ? ` since ${new Date(lineShutdown.since).toLocaleDateString()}` : ''}
                          {lineShutdown.reason ? ` · ${lineShutdown.reason}` : ''}
                        </div>
                      )}
                      {noActiveMatch ? (
                        <div className="py-5 text-center text-[12px] text-gray-400 italic bg-gray-50" data-testid={`text-no-results-${lineName}`}>
                          No orders matching &ldquo;{searchTerm}&rdquo; on {lineName}
                        </div>
                      ) : (
                        <OrderTable
                          orders={[...completed, ...active, ...cancelled]}
                          allOrders={orders}
                          onStatusChange={onStatusChange}
                          onCancelRequest={onCancelRequest}
                          onRestoreRequest={onRestoreRequest}
                          onUncombineRequest={onUncombineRequest}
                          onCutRequest={onCutRequest}
                          onMergeBackRequest={onMergeBackRequest}
                          onUpdateOrder={onUpdateOrder}
                          onReorder={(from, to) => {
                            const offset = completed.length;
                            onReorder &&
                              onReorder(from - offset, to - offset, active);
                          }}
                          sortConfig={sortConfig}
                          onSort={onSort}
                          completedCount={completed.length}
                          cancelledCount={cancelled.length}
                          activeFeedmill={activeFeedmill}
                          inferredTargetMap={inferredTargetMap}
                          feedmillStatus={feedmillStatus}
                          lineShutdowns={lineShutdowns}
                          kbRecords={kbRecords}
                          n10dRecords={n10dRecords}
                          onDivertOrder={onDivertOrder}
                          onRevertOrder={onRevertOrder}
                        />
                      )}
                    </div>
                  </div>
              );
            },
          )}
        </div>
      ) : (
        (() => {
          const singleLineShutdown = (activeSubSection && activeSubSection !== "all") ? lineShutdowns[activeSubSection] : null;
          const isSingleLineDown = !!(singleLineShutdown?.isShutdown);
          return (
            <div className={`border ${isSingleLineDown ? "border-red-400" : "border-gray-200"} rounded-lg overflow-hidden`}>
              {isSingleLineDown && (
                <div style={{ background: "#fef2f2", color: "#dc2626", fontSize: "12px", fontWeight: 600, padding: "8px 16px", borderBottom: "1px solid #fecaca" }}>
                  🔴 {activeSubSection} — SHUTDOWN{singleLineShutdown.since ? ` since ${new Date(singleLineShutdown.since).toLocaleDateString()}` : ""}
                  {singleLineShutdown.reason ? ` · ${singleLineShutdown.reason}` : ""}
                </div>
              )}
              {onAddOrder && !isSingleLineDown && (
                <div
                  style={{
                    display: "flex", alignItems: "center",
                    padding: "8px 16px",
                    background: "#e5e7eb",
                    borderBottom: "1px solid #d1d5db",
                  }}
                >
                  <button
                    onClick={() => onAddOrder(activeSubSection === "all" ? null : activeSubSection)}
                    style={{
                      display: "flex", alignItems: "center", gap: 5,
                      fontSize: 12, fontWeight: 500, color: "#c2410c",
                      background: "none", border: "none",
                      padding: 0, cursor: "pointer",
                    }}
                    onMouseEnter={e => { e.currentTarget.style.textDecoration = "underline"; e.currentTarget.style.color = "#9a3412"; }}
                    onMouseLeave={e => { e.currentTarget.style.textDecoration = "none"; e.currentTarget.style.color = "#c2410c"; }}
                    data-testid="button-add-order"
                    data-tour="orders-add-order"
                  >
                    <Plus style={{ width: 12, height: 12 }} />
                    Add Order
                  </button>
                </div>
              )}
              <OrderTable
                orders={[
                  ...filteredOrders.completed,
                  ...filteredOrders.active,
                  ...filteredOrders.cancelled,
                ]}
                allOrders={orders}
                onStatusChange={onStatusChange}
                onCancelRequest={onCancelRequest}
                onRestoreRequest={onRestoreRequest}
                onUncombineRequest={onUncombineRequest}
                onCutRequest={onCutRequest}
                onMergeBackRequest={onMergeBackRequest}
                onUpdateOrder={onUpdateOrder}
                onReorder={(from, to, orderedList) => {
                  const offset = filteredOrders.completed.length;
                  onReorder &&
                    onReorder(from - offset, to - offset, filteredOrders.active);
                }}
                sortConfig={sortConfig}
                onSort={onSort}
                completedCount={filteredOrders.completed.length}
                cancelledCount={filteredOrders.cancelled.length}
                activeFeedmill={activeFeedmill}
                inferredTargetMap={inferredTargetMap}
                feedmillStatus={feedmillStatus}
                lineShutdowns={lineShutdowns}
                kbRecords={kbRecords}
                n10dRecords={n10dRecords}
                onDivertOrder={onDivertOrder}
                onRevertOrder={onRevertOrder}
              />
            </div>
          );
        })()
      )}
    </div>
  );
}
