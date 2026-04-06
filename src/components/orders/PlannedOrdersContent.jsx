import React, { useState, useMemo } from "react";
import { Upload, Download, Sparkles, ClipboardList, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FEEDMILL_LINES } from "../layout/Sidebar";
import SearchFilter from "./SearchFilter";
import KeyMetrics from "./KeyMetrics";
import InsightAlertsPanel from "./InsightAlertsPanel";
import OrderTable from "./OrderTable";
import ExportButton from "./ExportButton";

// Map FM id → line names
const FM_LINE_MAP = {
  FM1: ["Line 1", "Line 2"],
  FM2: ["Line 3", "Line 4"],
  FM3: ["Line 6", "Line 7"],
  PMX: ["Line 5"],
};

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
  lastUploadDate,
  inferredTargetMap = {},
  lastN10DUploadDate = null,
  onNavigateToN10D = null,
  onAddOrder = null,
  feedmillStatus = {},
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

    const cancelled = result
      .filter((o) => o.status === "cancel_po")
      .sort((a, b) => {
        const aT = a.cancelled_date || a.updated_date || "";
        const bT = b.cancelled_date || b.updated_date || "";
        return aT > bT ? -1 : 1;
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
                    ? "bg-[#fd5108] text-white"
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
          {onAutoSequence && (
            <div className="relative group">
              <Button
                onClick={isAllTab ? undefined : onAutoSequence}
                variant="outline"
                size="sm"
                disabled={isAllTab}
                className={cn(
                  "auto-sequence-btn",
                  isAllTab
                    ? "border-[#d1d5db] text-[#d1d5db] h-9 text-[12px] opacity-60 cursor-not-allowed hover:bg-transparent hover:text-[#d1d5db]"
                    : "border-[#fd5108] text-[#fd5108] hover:bg-[#fd5108] hover:text-white h-9 text-[12px]"
                )}
                data-testid="button-auto-sequence"
                data-tour="orders-auto-sequence"
                style={isAllTab ? { pointerEvents: "auto" } : undefined}
              >
                <Sparkles className="h-4 w-4 mr-1.5" />
                Auto-Sequence
              </Button>
              {isAllTab && (
                <div
                  className="absolute top-full left-1/2 -translate-x-1/2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity delay-300 pointer-events-none"
                  style={{
                    background: "#374151",
                    color: "#fff",
                    fontSize: 11,
                    fontWeight: 400,
                    padding: "8px 12px",
                    borderRadius: 6,
                    minWidth: 250,
                    maxWidth: 300,
                    width: "max-content",
                    textAlign: "left",
                    whiteSpace: "normal",
                    lineHeight: 1.5,
                    zIndex: 9999,
                    boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                  }}
                >
                  Auto-Sequence is available per line. Select a specific line
                  tab (e.g., Line 1, Line 2) to use this feature.
                  <div
                    style={{
                      position: "absolute",
                      bottom: "100%",
                      left: "50%",
                      transform: "translateX(-50%)",
                      borderWidth: 5,
                      borderStyle: "solid",
                      borderColor:
                        "transparent transparent #374151 transparent",
                    }}
                  />
                </div>
              )}
            </div>
          )}
          <Button
            onClick={onUpload}
            disabled={isUploading}
            className="bg-[#fd5108] hover:bg-[#fe7c39] h-9 text-[12px]"
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
        <KeyMetrics orders={lineOrdersForMetrics} />
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
        />
      </div>

      {isAllTab && perLineData ? (
        <div className="space-y-6">
          {perLineData.map(
            ({ lineName, completed, active, cancelled, total, unfilteredActive }) => {
              const isSearching = searchTerm.trim().length > 0;
              const noActiveMatch = isSearching && active.length === 0;
              return (
              <div key={lineName} data-testid={`section-line-${lineName}`}>
                <div className="flex items-center justify-between px-4 py-2.5 bg-gray-200 border border-gray-300 rounded-t-lg">
                  <div className="flex items-center gap-2">
                    <ClipboardList className="h-4 w-4 text-[#2e343a]" />
                    <span className="text-sm font-bold text-[#2e343a]">
                      {lineName}
                    </span>
                    {onAddOrder && (
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
                <div className="border border-t-0 border-gray-200 rounded-b-lg overflow-hidden">
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
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          {onAddOrder && (
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
            kbRecords={kbRecords}
            n10dRecords={n10dRecords}
            onDivertOrder={onDivertOrder}
            onRevertOrder={onRevertOrder}
          />
        </div>
      )}
    </div>
  );
}
