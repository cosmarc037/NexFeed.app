import { useState, useEffect, useMemo } from "react";
import { GripVertical, Loader2 } from "lucide-react";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { applyPreviewChangeovers, generateFallbackExplanation } from "./PlantAutoSequenceModal";
import { callPlantActionsAI, buildPlantActionsPrompt, parsePlantActionsResponse } from "@/services/azureAI";

function getLineDisplayName(line) {
  const match = (line || '').match(/\d+/);
  if (!match) return line || 'Line';
  return match[0] === '5' ? 'Line 5 (PMX)' : `Line ${match[0]}`;
}

const MAX_COMBINE_MT = 180;

/* ── helpers ── */
function getLineShortName(line) {
  const m = (line || "").match(/Line\s*(\d+)/i);
  return m ? `L${m[1]}` : line || "";
}

function formatAvailDate(v) {
  if (!v) return "—";
  if (/^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v)))
    return new Date(v).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const raw = String(v).toLowerCase().trim();
  if (raw.includes("prio")) return "prio replenish";
  if (raw.includes("safety")) return "safety stocks";
  if (raw === "stock_sufficient") return "stock sufficient";
  if (raw.includes("sched")) return "for sched";
  return v;
}

function formatDate(d) {
  if (!d) return "—";
  const p = new Date(d);
  if (isNaN(p)) return d;
  return p.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtVol(v) {
  const n = parseFloat(v);
  return isNaN(n) ? "—" : Math.round(n);
}

function formatProductionTime(h) {
  if (!h || isNaN(parseFloat(h))) return "—";
  return parseFloat(h).toFixed(2);
}

function numBatches(order) {
  const vol = parseFloat(order.total_volume_mt) || 0;
  const bs = parseFloat(order.batch_size);
  if (!bs || bs <= 0) return "—";
  return Math.ceil(vol / bs);
}

function localSort(orders) {
  const planned = orders
    .filter((o) => o.status === "planned")
    .sort((a, b) => (a.priority_seq || 9999) - (b.priority_seq || 9999));
  const movable = orders.filter((o) => o.status !== "planned");
  const catOrder = { A: 0, B: 1, C: 2, D: 3 };
  movable.sort((a, b) => {
    const catA = catOrder[a.category] ?? 2;
    const catB = catOrder[b.category] ?? 2;
    if (catA !== catB) return catA - catB;
    const toDate = (o) => {
      const v = o.target_avail_date;
      return v && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v)) ? new Date(v) : null;
    };
    const dA = toDate(a), dB = toDate(b);
    if (dA && dB) return dA - dB;
    if (dA) return -1;
    if (dB) return 1;
    return (parseFloat(a.diameter) || 0) - (parseFloat(b.diameter) || 0);
  });
  return [...planned, ...movable];
}

function combineOnLine(orders, targetLine) {
  const EXCLUDED = new Set(["completed", "cancel_po", "in_production", "ongoing_batching", "ongoing_pelleting", "ongoing_bagging"]);
  const eligible = orders.filter((o) => !EXCLUDED.has(o.status));
  const placed = new Set();
  const result = [];
  const placementLog = [];

  const groupKey = (o) => `${String(o.material_code || "").trim()}__${String(o.formula_version || "").trim()}`;
  const groups = {};
  eligible.forEach((o) => {
    const k = groupKey(o);
    if (!groups[k]) groups[k] = [];
    groups[k].push(o);
  });

  Object.values(groups).forEach((grp) => {
    if (grp.length < 2) return;
    const totalMT = grp.reduce((s, o) => s + (parseFloat(o.total_volume_mt) || 0), 0);
    if (totalMT > MAX_COMBINE_MT) return;

    const sorted = [...grp].sort((a, b) => (parseFloat(b.total_volume_mt) || 0) - (parseFloat(a.total_volume_mt) || 0));
    const lead = { ...sorted[0] };
    lead.total_volume_mt = totalMT.toFixed(1);
    lead.production_hours = (grp.reduce((s, o) => s + (parseFloat(o.production_hours) || 0), 0)).toFixed(2);
    lead._isCombined = true;
    lead._combinedFrom = grp.map((o) => ({
      id: o.id, line: o.feedmill_line || targetLine, fpr: o.fpr,
      volume: parseFloat(o.total_volume_mt) || 0, item_description: o.item_description,
      form: o.form, material_code_fg: o.material_code, material_code: o.material_code,
      fg: o.fg, sfg: o.sfg, batch_size: o.batch_size,
      production_time: o.production_hours, target_avail_date: o.target_avail_date, category: o.category,
    }));
    lead._combinedFromLines = [...new Set(grp.map((o) => o.feedmill_line || targetLine))];

    const changeoversSaved = grp.length - 1;
    placementLog.push({
      type: "combined", product: lead.item_description,
      materialCode: lead.material_code, ordersCount: grp.length,
      totalVolume: totalMT, toLine: targetLine,
      fromLines: grp.map((o) => o.feedmill_line || targetLine),
      changeoversSaved, timeSaved: changeoversSaved * 0.17,
      individualVolumes: grp.map((o) => ({ fromLine: o.feedmill_line || targetLine, volume: parseFloat(o.total_volume_mt) || 0 })),
      lineScores: [{ line: targetLine, runRate: 10, totalMTBefore: 0, queueTimeBefore: 0, totalMTAfter: totalMT, queueTimeAfter: 0 }],
      bestLineReason: { line: targetLine, queueTime: 0, totalMTBefore: 0, totalMTAfter: totalMT },
    });

    grp.forEach((o) => placed.add(o.id));
    result.push(lead);
  });

  eligible.forEach((o) => { if (!placed.has(o.id)) result.push({ ...o }); });
  return { combined: result, placementLog };
}

/* ── StatBadge ── */
function StatBadge({ label, value, color = "default" }) {
  const colors = {
    default: { bg: "#f9fafb", border: "#e5e7eb", textColor: "#6b7280", valColor: "#1a1a1a" },
    green:   { bg: "#f0fdf4", border: "#bbf7d0", textColor: "#16a34a", valColor: "#15803d" },
    orange:  { bg: "#fff7ed", border: "#fed7aa", textColor: "#ea580c", valColor: "#c2410c" },
    blue:    { bg: "#eff6ff", border: "#bfdbfe", textColor: "#1d4ed8", valColor: "#1e40af" },
    amber:   { bg: "#fffbeb", border: "#fde68a", textColor: "#b45309", valColor: "#92400e" },
  };
  const c = colors[color] || colors.default;
  return (
    <div style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 8, padding: "8px 16px", minWidth: 80, textAlign: "center", flexShrink: 0 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: c.valColor, lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: 10, color: c.textColor, fontWeight: 500, marginTop: 2, whiteSpace: "nowrap" }}>{label}</div>
    </div>
  );
}

/* ── After-row with DnD ── */
function LineAfterRow({ order, prio, provided, snapshot, destinationLine }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isFromOther = order._movement === "new_to_line";
  const isCombined = !!order._isCombined;

  return (
    <>
      <tr
        ref={provided.innerRef}
        {...provided.draggableProps}
        className={`auto-sequence-row-after border-l-4 ${isFromOther ? "border-l-green-400" : isCombined ? "border-l-blue-400" : "border-l-gray-200"}${snapshot.isDragging ? " shadow-xl" : ""}`}
        style={{ ...provided.draggableProps.style, borderBottom: "1px solid #f3f4f6" }}
      >
        <td className="as-col-drag" style={{ width: 32, padding: "10px 4px", textAlign: "center", cursor: "grab" }}
          {...provided.dragHandleProps}>
          <GripVertical style={{ width: 14, height: 14, color: "#9ca3af" }} />
        </td>
        <td className="as-col-prio">
          <span className="as-prio-badge as-prio-badge-after">{prio}</span>
        </td>
        <td className="as-col-fpr" style={{ color: "#2e343a" }}>{order.fpr || "—"}</td>
        <td className="as-col-planned">
          <div style={{ color: "#2e343a" }}>{order.fg || "—"}</div>
          <div className="as-sub-text">{order.sfg || "—"}</div>
        </td>
        <td className="as-col-material" style={{ color: "#2e343a" }}>{order.material_code || "—"}</td>
        <td className="as-col-desc">
          <div className="as-desc-with-movement">
            {isFromOther && (
              <span className="as-line-badge" style={{ background: "#dcfce7", color: "#15803d", border: "1px solid #86efac", fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, flexShrink: 0 }}
                title={`Moved from ${order._movedFromLine || "another line"}`}>
                {getLineShortName(order._movedFromLine || "")} →
              </span>
            )}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div className="as-desc-main" title={order.item_description || ""}>{order.item_description || "—"}</div>
                {isCombined && (
                  <button className="as-combined-toggle" onClick={() => setIsExpanded(!isExpanded)}
                    title={`${order._combinedFrom?.length || 0} orders combined`}>
                    {isExpanded ? "▼" : "▶"}
                  </button>
                )}
              </div>
              {(order.category || order.color || order.diameter) && (
                <div className="as-sub-text">
                  {[order.category, order.color, order.diameter != null && order.diameter !== "" ? `${parseFloat(order.diameter).toFixed(2)}mm` : null].filter(Boolean).join(" · ")}
                </div>
              )}
              {isCombined && order._combinedFrom && (
                <div className="as-combined-label">{order._combinedFrom.length} orders combined</div>
              )}
            </div>
          </div>
        </td>
        <td className="as-col-form" style={{ color: "#2e343a" }}>{order.form || "—"}</td>
        <td className="as-col-volume">
          <strong style={{ color: "#1a1a1a" }}>{fmtVol(order.total_volume_mt)}</strong>
          <span style={{ color: "#6b7280", marginLeft: 2 }}>MT</span>
        </td>
        <td className="as-col-batch" style={{ color: "#2e343a" }}>{order.batch_size ? Math.round(parseFloat(order.batch_size)) : "—"}</td>
        <td className="as-col-batches" style={{ color: "#2e343a" }}>{numBatches(order)}</td>
        <td className="as-col-prod">
          <div style={{ fontSize: 12, fontWeight: 600, color: "#1a1a1a" }}>{formatProductionTime(order.production_hours)} hours</div>
          <div className="as-sub-text">CO: {formatProductionTime(order._changeoverTotal || 0)}</div>
        </td>
        <td className="as-col-start-date" style={{ color: "#2e343a" }}>{order.start_date ? formatDate(order.start_date) : "—"}</td>
        <td className="as-col-start-time" style={{ color: "#2e343a" }}>{order.start_time || "—"}</td>
        <td className="as-col-avail" style={{ color: "#2e343a" }}>{formatAvailDate(order.target_avail_date)}</td>
        <td className="as-col-completion" style={{ color: "#2e343a" }}>{order.target_completion_date || "—"}</td>
      </tr>
      {isCombined && isExpanded && (order._combinedFrom || []).map((sub, si) => (
        <tr key={si} className="as-row-combined-sub" style={{ background: "#f8faff", borderBottom: "1px solid #f3f4f6" }}>
          <td></td><td></td>
          <td className="as-col-fpr" style={{ color: "#9ca3af", fontSize: 11 }}>{sub.fpr || "—"}</td>
          <td></td><td></td>
          <td colSpan={10} style={{ fontSize: 11, color: "#6b7280", paddingLeft: 8 }}>
            {sub.item_description} · {fmtVol(sub.volume)} MT from {getLineShortName(sub.line || destinationLine)}
          </td>
        </tr>
      ))}
    </>
  );
}

/* ── Main modal ── */
export default function LineAutoSequenceModal({ data, isLoading = false, inferredTargetMap = {}, changeoverRules, onApply, onCancel }) {
  const [selectedOrders, setSelectedOrders] = useState(() =>
    new Set((data?.selectedToMove || []).map((o) => o.id))
  );
  const [isCombined, setIsCombined] = useState(false);
  const [isCombining, setIsCombining] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [orderedResult, setOrderedResult] = useState(null);
  const [extraPlacementLog, setExtraPlacementLog] = useState([]);
  const [aiExplanations, setAiExplanations] = useState(null);
  const [isLoadingAI, setIsLoadingAI] = useState(false);
  const [useFallback, setUseFallback] = useState(false);

  // When data loads, seed selectedOrders from preselected candidates
  useEffect(() => {
    if (!data) return;
    setSelectedOrders(new Set((data.selectedToMove || []).map((o) => o.id)));
    setOrderedResult(null);
    setIsCombined(false);
    setExtraPlacementLog([]);
    // Use preloaded AI
    if (data.preloadedAI) {
      if (data.preloadedAI.explanations) {
        setAiExplanations(data.preloadedAI.explanations);
        setUseFallback(false);
      } else {
        setUseFallback(data.preloadedAI.useFallback || true);
      }
    }
  }, [data]);

  // Build the "after" sequence based on selected orders
  const sequencedResult = useMemo(() => {
    if (!data) return [];
    const afterOrders = data.targetLineOrders.map((o) => ({ ...o }));
    const movedOrders = (data.selectedToMove || []).filter((o) => selectedOrders.has(o.id));
    movedOrders.forEach((order) => {
      afterOrders.push({
        ...order,
        feedmill_line: data.targetLine,
        _movedFromLine: order._sourceLineNormalized || order._sourceLine,
        _movement: "new_to_line",
      });
    });

    const sorted = localSort(afterOrders);
    const withCO = applyPreviewChangeovers([...sorted], changeoverRules);
    const originalIds = new Set(data.targetLineOrders.map((o) => o.id));

    return withCO.map((order, index) => {
      const newPrio = index + 1;
      if (!originalIds.has(order.id)) return { ...order, prio: newPrio, _movement: "new_to_line" };
      const origIdx = data.targetLineOrders.findIndex((o) => o.id === order.id);
      const origPrio = origIdx >= 0 ? origIdx + 1 : -1;
      const delta = origPrio - newPrio;
      return { ...order, prio: newPrio, _originalPrio: origPrio, _movement: delta > 0 ? "up" : delta < 0 ? "down" : "same", _movementDelta: Math.abs(delta) };
    });
  }, [data, selectedOrders, changeoverRules]);

  // Display = manual reorder if any, otherwise computed
  const displayResult = orderedResult || sequencedResult;

  // Build placement log = precomputed moves + combine log
  const placementLog = useMemo(() => {
    if (!data) return [];
    const baseMoves = (data.placementLog || []).filter((e) =>
      selectedOrders.has((data.selectedToMove || []).find((o) => o.item_description === e.product)?.id)
    );
    // rebuild from currently selected (simpler):
    const moveMoved = (data.selectedToMove || []).filter((o) => selectedOrders.has(o.id)).map((order) => ({
      type: "moved", product: order.item_description,
      materialCode: order.material_code_fg || order.material_code,
      fromLine: order._sourceLineNormalized || order._sourceLine,
      toLine: data.targetLine, volume: parseFloat(order.total_volume_mt) || 0, fpr: order.fpr,
      lineScores: [
        { line: order._sourceLineNormalized, runRate: order._sourceRunRate || 10, totalMTBefore: order._sourceMTBefore || 0, queueTimeBefore: order._sourceQueueBefore || 0, totalMTAfter: order._sourceMTAfter || 0, queueTimeAfter: order._sourceQueueAfter || 0 },
        { line: data.targetLine, runRate: order._targetRunRate || 10, totalMTBefore: order._targetMTBefore || 0, queueTimeBefore: order._targetQueueBefore || 0, totalMTAfter: order._targetMTAfter || 0, queueTimeAfter: order._targetQueueAfter || 0 },
      ],
      bestLineReason: { line: data.targetLine, runRate: order._targetRunRate || 10, queueTime: order._targetQueueBefore || 0, totalMTBefore: order._targetMTBefore || 0, totalMTAfter: order._targetMTAfter || 0 },
      fromLineReason: { line: order._sourceLineNormalized, queueTime: order._sourceQueueBefore || 0, runRate: order._sourceRunRate || 10 },
    }));
    return [...moveMoved, ...extraPlacementLog];
  }, [data, selectedOrders, extraPlacementLog]);

  function toggleOrder(orderId) {
    const next = new Set(selectedOrders);
    if (next.has(orderId)) next.delete(orderId); else next.add(orderId);
    setSelectedOrders(next);
    setOrderedResult(null);
    setAiExplanations(null);
    setUseFallback(false);
  }
  function selectAll() { setSelectedOrders(new Set((data?.selectedToMove || []).map((o) => o.id))); setOrderedResult(null); setAiExplanations(null); }
  function deselectAll() { setSelectedOrders(new Set()); setOrderedResult(null); setAiExplanations(null); }

  async function handleRefreshAI() {
    if (!placementLog.length) return;
    setIsLoadingAI(true);
    setAiExplanations(null);
    setUseFallback(false);
    try {
      const { systemPrompt, userPrompt, precomputedInsights } = buildPlantActionsPrompt(placementLog);
      const response = await callPlantActionsAI(systemPrompt, userPrompt, 1400);
      const parsed = parsePlantActionsResponse(response, placementLog, precomputedInsights);
      if (Object.keys(parsed).length >= Math.max(1, placementLog.length * 0.5)) {
        setAiExplanations(parsed);
      } else {
        setUseFallback(true);
      }
    } catch {
      setUseFallback(true);
    }
    setIsLoadingAI(false);
  }

  async function handleCombine() {
    if (isCombining || isCombined || !data) return;
    setIsCombining(true);
    const ordersForCombine = (displayResult || []).map((o) => ({ ...o, feedmill_line: data.targetLine }));
    const { combined, placementLog: combineLog } = combineOnLine(ordersForCombine, data.targetLine);
    const resorted = localSort(combined);
    const withCO = applyPreviewChangeovers([...resorted], changeoverRules);
    const originalIds = new Set(data.targetLineOrders.map((o) => o.id));
    const withMovement = withCO.map((order, index) => ({
      ...order, prio: index + 1,
      _movement: !originalIds.has(order.id) && !order._isCombined ? "new_to_line" : order._movement || "same",
    }));
    setOrderedResult(withMovement);
    setExtraPlacementLog(combineLog);
    setIsCombined(true);
    setIsCombining(false);
    setAiExplanations(null);
    setUseFallback(false);
  }

  function onDragEnd(result) {
    if (!result.destination || result.destination.index === result.source.index) return;
    const current = [...(displayResult || [])];
    const [moved] = current.splice(result.source.index, 1);
    current.splice(result.destination.index, 0, moved);
    setOrderedResult(current.map((o, i) => ({ ...o, prio: i + 1 })));
  }

  const candidateCount = data ? (data.selectedToMove || []).length : 0;
  const movedCount = (displayResult || []).filter((o) => o._movement === "new_to_line").length;
  const combinedCount = (displayResult || []).filter((o) => o._isCombined).length;

  // Enrich before orders with changeovers for display
  const enrichedBeforeOrders = useMemo(() => {
    if (!data) return [];
    const rows = data.targetLineOrders.map((o) => ({ ...o }));
    applyPreviewChangeovers(rows, changeoverRules);
    return rows;
  }, [data, changeoverRules]);

  return (
    <div className="plant-modal-overlay" style={{ zIndex: 10100 }} onClick={(e) => e.stopPropagation()}>
      <div className="plant-modal-container" style={{ maxWidth: 1440 }} onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="plant-modal-header">
          <div>
            <h2 className="plant-modal-title">
              ⚙️ Optimize {data ? getLineDisplayName(data.targetLineLabel) : "Loading…"}
            </h2>
            <div className="plant-modal-subtitle">
              Find orders from other lines that can be moved to {data ? getLineDisplayName(data.targetLineLabel) : "…"}
            </div>
          </div>
          <button className="plant-modal-close" onClick={onCancel} disabled={isApplying}>✕</button>
        </div>

        {/* Loading screen */}
        {isLoading ? (
          <div className="flex-1 flex flex-col items-center justify-center py-16 px-8">
            <Loader2 className="h-10 w-10 text-[var(--nexfeed-primary)] animate-spin mb-4" />
            <p className="text-sm font-medium text-[#2e343a]">Analyzing orders and generating AI insights…</p>
            <p className="text-xs text-gray-400 mt-1">This may take a few seconds</p>
          </div>
        ) : data ? (
          <>
            {/* Scrollable body */}
            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>

            {/* Stats strip */}
            <div className="plant-stats-strip">
              <StatBadge label="Current Orders" value={data.targetLineOrders.length} />
              <StatBadge label="Candidates Found" value={candidateCount} color={candidateCount > 0 ? "blue" : "default"} />
              <StatBadge label="Selected to Move" value={selectedOrders.size} color={selectedOrders.size > 0 ? "green" : "default"} />
              {displayResult && <StatBadge label="After Optimization" value={displayResult.length} />}
              {isCombined && combinedCount > 0 && <StatBadge label="Combined" value={combinedCount} color="green" />}
            </div>

            {/* Candidates panel */}
            {candidateCount > 0 ? (
              <div className="line-as-candidates">
                <div className="line-as-candidates-header">
                  <span className="line-as-candidates-title">
                    📋 Orders available to move to {getLineDisplayName(data.targetLineLabel)}
                  </span>
                  <div className="line-as-candidates-actions">
                    <button className="line-as-select-btn" onClick={selectAll}>Select All</button>
                    <button className="line-as-select-btn" onClick={deselectAll}>Deselect All</button>
                  </div>
                </div>
                <div className="line-as-candidates-list">
                  {(data.selectedToMove || []).map((candidate) => (
                    <label key={candidate.id} className="line-as-candidate-row">
                      <input
                        type="checkbox"
                        checked={selectedOrders.has(candidate.id)}
                        onChange={() => toggleOrder(candidate.id)}
                        disabled={isApplying}
                      />
                      <span className="line-as-candidate-line-badge">
                        {getLineShortName(candidate._sourceLineNormalized || candidate._sourceLine || "")}
                      </span>
                      <span className="line-as-candidate-desc">{candidate.item_description}</span>
                      <span className="line-as-candidate-volume">{fmtVol(candidate.total_volume_mt)} MT</span>
                      <span className="line-as-candidate-improvement">
                        {candidate._queueImprovement > 0 ? `↓ ${candidate._queueImprovement.toFixed(2)} hrs` : "—"}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <div className="line-as-no-candidates">
                No orders from other lines can be moved to {data.targetLineLabel} at this time. All eligible lines have lower or equal queue times.
              </div>
            )}

            {/* Side-by-side Before / After */}
            <div className="plant-line-comparison" style={{ minHeight: 380, marginTop: 12 }}>
              <div className="plant-line-comparison-container">
                <div className="plant-line-comparison-scroll">

                  {/* Before */}
                  <div className="as-before-panel">
                    <div className="as-before-label">
                      <span>📋</span> Before — {data.targetLineOrders.length} orders
                    </div>
                    <div className="as-before-table-wrap">
                      <table className="as-before-table" style={{ minWidth: 1100 }}>
                        <thead>
                          <tr>
                            <th className="as-col-prio">Prio</th>
                            <th className="as-col-fpr">FPR</th>
                            <th className="as-col-planned">Planned Order</th>
                            <th className="as-col-material">Material Code (FG)</th>
                            <th className="as-col-desc">Item Description</th>
                            <th className="as-col-form">Form</th>
                            <th className="as-col-volume">Volume (MT)</th>
                            <th className="as-col-batch">Batch Size</th>
                            <th className="as-col-batches">Batches</th>
                            <th className="as-col-prod">Production Time</th>
                            <th className="as-col-start-date">Start Date</th>
                            <th className="as-col-start-time">Start Time</th>
                            <th className="as-col-avail">Avail Date</th>
                            <th className="as-col-completion">Est. Completion</th>
                          </tr>
                        </thead>
                        <tbody>
                          {enrichedBeforeOrders.map((order, idx) => (
                            <tr key={order.id} className="auto-sequence-row-before">
                              <td className="as-col-prio"><span className="as-before-prio">{idx + 1}</span></td>
                              <td className="as-col-fpr" style={{ color: "#2e343a" }}>{order.fpr || "—"}</td>
                              <td className="as-col-planned">
                                <div style={{ color: "#2e343a" }}>{order.fg || "—"}</div>
                                <div className="as-sub-text">{order.sfg || "—"}</div>
                              </td>
                              <td className="as-col-material" style={{ color: "#2e343a" }}>{order.material_code || "—"}</td>
                              <td className="as-col-desc">
                                <div className="as-desc-main">{order.item_description || "—"}</div>
                                {(order.category || order.color || order.diameter) && (
                                  <div className="as-sub-text">
                                    {[order.category, order.color, order.diameter != null && order.diameter !== "" ? `${parseFloat(order.diameter).toFixed(2)}mm` : null].filter(Boolean).join(" · ")}
                                  </div>
                                )}
                              </td>
                              <td className="as-col-form" style={{ color: "#2e343a" }}>{order.form || "—"}</td>
                              <td className="as-col-volume">
                                <strong style={{ color: "#1a1a1a" }}>{fmtVol(order.total_volume_mt)}</strong>
                                <span style={{ color: "#6b7280", marginLeft: 2 }}>MT</span>
                              </td>
                              <td className="as-col-batch" style={{ color: "#2e343a" }}>{order.batch_size ? Math.round(parseFloat(order.batch_size)) : "—"}</td>
                              <td className="as-col-batches" style={{ color: "#2e343a" }}>{numBatches(order)}</td>
                              <td className="as-col-prod">
                                <div style={{ fontSize: 12, fontWeight: 600, color: "#1a1a1a" }}>{formatProductionTime(order.production_hours)} hours</div>
                                <div className="as-sub-text">CO: {formatProductionTime(order._changeoverTotal || 0)}</div>
                              </td>
                              <td className="as-col-start-date" style={{ color: "#2e343a" }}>{order.start_date ? formatDate(order.start_date) : "—"}</td>
                              <td className="as-col-start-time" style={{ color: "#2e343a" }}>{order.start_time || "—"}</td>
                              <td className="as-col-avail" style={{ color: "#2e343a" }}>{formatAvailDate(order.target_avail_date)}</td>
                              <td className="as-col-completion" style={{ color: "#2e343a" }}>{order.target_completion_date || "—"}</td>
                            </tr>
                          ))}
                          {enrichedBeforeOrders.length === 0 && (
                            <tr><td colSpan={14} style={{ textAlign: "center", color: "#9ca3af", padding: "32px 8px", fontSize: 12, fontStyle: "italic" }}>No orders on this line before sequencing</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Divider */}
                  <div className="as-comparison-divider" />

                  {/* After with DnD */}
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                    <div className="as-after-label">
                      <span>✨</span> After — {(displayResult || []).length} orders
                      {movedCount > 0 && ` · ${movedCount} from other lines`}
                      {combinedCount > 0 && ` · ${combinedCount} combined`}
                    </div>
                    <div style={{ flex: 1, overflowY: "auto", overflowX: "auto" }}>
                      <DragDropContext onDragEnd={onDragEnd}>
                        <table className="as-after-table" style={{ minWidth: 1100 }}>
                          <thead>
                            <tr>
                              <th className="as-col-drag"></th>
                              <th className="as-col-prio">Prio</th>
                              <th className="as-col-fpr">FPR</th>
                              <th className="as-col-planned">Planned Order</th>
                              <th className="as-col-material">Material Code (FG)</th>
                              <th className="as-col-desc">Item Description</th>
                              <th className="as-col-form">Form</th>
                              <th className="as-col-volume">Volume (MT)</th>
                              <th className="as-col-batch">Batch Size</th>
                              <th className="as-col-batches">Batches</th>
                              <th className="as-col-prod">Production Time</th>
                              <th className="as-col-start-date">Start Date</th>
                              <th className="as-col-start-time">Start Time</th>
                              <th className="as-col-avail">Avail Date</th>
                              <th className="as-col-completion">Est. Completion</th>
                            </tr>
                          </thead>
                          <Droppable droppableId="line-after-table">
                            {(droppableProvided) => (
                              <tbody ref={droppableProvided.innerRef} {...droppableProvided.droppableProps}>
                                {(displayResult || []).map((order, index) => (
                                  <Draggable
                                    key={String(order.id || `idx-${index}`)}
                                    draggableId={String(order.id || `idx-${index}`)}
                                    index={index}
                                    isDragDisabled={isApplying}
                                  >
                                    {(provided, snapshot) => (
                                      <LineAfterRow
                                        order={order}
                                        prio={index + 1}
                                        provided={provided}
                                        snapshot={snapshot}
                                        destinationLine={data.targetLine}
                                      />
                                    )}
                                  </Draggable>
                                ))}
                                {droppableProvided.placeholder}
                                {(displayResult || []).length === 0 && (
                                  <tr><td colSpan={15} style={{ textAlign: "center", color: "#9ca3af", padding: "32px 8px", fontSize: 12, fontStyle: "italic" }}>No orders after sequencing</td></tr>
                                )}
                              </tbody>
                            )}
                          </Droppable>
                        </table>
                      </DragDropContext>
                    </div>
                  </div>

                </div>
              </div>
            </div>

            {/* Actions Taken */}
            {placementLog.length > 0 && (
              <div className="line-actions-plain">
                <div className="plant-actions-header">
                  <div className="plant-summary-title">📋 Actions Taken</div>
                  {!isLoadingAI && (
                    <button className="plant-actions-refresh" onClick={handleRefreshAI}>↻ Refresh</button>
                  )}
                </div>
                {isLoadingAI && (
                  <div className="plant-actions-loading"><span style={{ marginRight: 8 }}>✦</span>Analyzing actions…</div>
                )}
                {!isLoadingAI && placementLog.map((entry, index) => {
                  const explanation = (!useFallback && aiExplanations?.[index]) ? aiExplanations[index] : generateFallbackExplanation(entry);
                  const isAI = !useFallback && !!aiExplanations?.[index];
                  const inPlace = entry.type === "combined" && (entry.fromLines || []).every((fl) => fl === entry.toLine);
                  const toScore = (entry.lineScores || []).find((ls) => ls.line === entry.toLine);
                  const showMTBadge = toScore && !inPlace;
                  const mtDiff = showMTBadge ? (toScore.totalMTAfter || 0) - (toScore.totalMTBefore || 0) : 0;

                  return (
                    <div key={index} className="plant-action-card">
                      <div className="plant-action-header">
                        {entry.type === "combined" ? (
                          <>
                            <span className="plant-action-icon plant-action-combine">🔗</span>
                            <span className="plant-action-title">
                              Combined <strong>{entry.ordersCount}</strong> orders of <strong>{entry.product}</strong> ({parseFloat(entry.totalVolume || 0).toFixed(1)} MT) in place on {data.targetLineLabel}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="plant-action-icon plant-action-move">↗</span>
                            <span className="plant-action-title">
                              Moved <strong>{entry.product}</strong> ({parseFloat(entry.volume || 0).toFixed(1)} MT) from {entry.fromLine} → {entry.toLine}
                            </span>
                          </>
                        )}
                        {isAI && <span className="plant-action-ai-badge">AI</span>}
                      </div>
                      <div className="plant-action-explanation">{explanation}</div>
                      <div className="plant-action-badges">
                        {showMTBadge && (
                          <span className="plant-action-mt-badge plant-action-mt-increase">
                            {entry.toLine} {(toScore.totalMTBefore || 0).toFixed(1)} MT → {(toScore.totalMTAfter || 0).toFixed(1)} MT
                            <span className="plant-action-mt-diff">(+{mtDiff.toFixed(1)} MT)</span>
                          </span>
                        )}
                        {entry.type === "combined" && (entry.individualVolumes || []).map((iv, si) => (
                          <span key={si} className="plant-action-sub-chip">{getLineShortName(iv.fromLine)} · {parseFloat(iv.volume || 0).toFixed(1)} MT</span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

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

            </div>{/* end scrollable body */}

            {/* Footer */}
            <div className="plant-modal-footer">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {!isCombined && displayResult && displayResult.length > 0 && (
                  <button
                    className={`plant-footer-btn ${isCombining ? "opacity-50 cursor-not-allowed" : ""}`}
                    onClick={handleCombine}
                    disabled={isCombining || isApplying}
                    style={{ display: "flex", alignItems: "center", gap: 6, color: "#16a34a", borderColor: "#86efac" }}
                  >
                    {isCombining
                      ? <><Loader2 className="h-3 w-3 animate-spin" />Combining…</>
                      : "🔗 Combine Orders"}
                  </button>
                )}
                {isCombined && <span className="btn-combine-done">✅ Orders Combined</span>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button className="plant-footer-btn" onClick={onCancel} disabled={isApplying}>Cancel</button>
                <button
                  className={`plant-footer-apply-btn ${isApplying ? "plant-footer-apply-btn-loading" : ""}`}
                  disabled={isApplying || !displayResult}
                  onClick={() => {
                    if (isApplying) return;
                    setIsApplying(true);
                    onApply({
                      targetLine: data.targetLine,
                      sequencedOrders: displayResult || [],
                      affectedSourceLines: [...new Set(
                        (data.selectedToMove || [])
                          .filter((o) => selectedOrders.has(o.id))
                          .map((o) => o._sourceLineNormalized || o._sourceLine)
                          .filter(Boolean)
                      )],
                    });
                  }}
                >
                  {isApplying
                    ? <><Loader2 className="h-3 w-3 animate-spin" style={{ marginRight: 6 }} />Applying…</>
                    : "Apply to Schedule"}
                </button>
              </div>
            </div>
          </>
        ) : null}

      </div>
    </div>
  );
}
