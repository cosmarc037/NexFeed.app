import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { generateDiversionImpact, generateInsertionPlacement } from '@/services/azureAI';

const FEEDMILL_LINES = {
  FM1: ['Line 1', 'Line 2'],
  FM2: ['Line 3', 'Line 4'],
  FM3: ['Line 6', 'Line 7'],
  PMX: ['Line 5'],
};

const LINE_FEEDMILL = {};
Object.entries(FEEDMILL_LINES).forEach(([fm, lines]) => {
  lines.forEach(l => { LINE_FEEDMILL[l] = fm; });
});

const LINE_RATE_KEY = {
  'Line 1': 'line_1_run_rate',
  'Line 2': 'line_2_run_rate',
  'Line 3': 'line_3_run_rate',
  'Line 4': 'line_4_run_rate',
  'Line 5': 'line_5_run_rate',
  'Line 6': 'line_6_run_rate',
  'Line 7': 'line_7_run_rate',
};

const HEADING_EMOJIS = ['📍', '⏱', '⚠', '📅'];

// Parse an order's effective avail date. Returns Date or null for non-date values
// like "prio replenish" / "safety stocks".
function parseAvailDate(o) {
  const v = o?.target_avail_date || o?.avail_date;
  if (!v || typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (!s || s === 'prio replenish' || s === 'safety stocks' || s === 'stock sufficient' || s === 'for sched' || s === 'tld') return null;
  const m = v.match(/\d{4}-\d{2}-\d{2}/);
  const iso = m ? m[0] : v;
  const d = new Date(iso);
  return isNaN(d) ? null : d;
}

const fmtDate = (d) => d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?';

// Decide where a diverted order should slot into a target line, based on avail date.
// Returns { insertPosition, ordersShifted, insertedBeforeOrderId, insertedAfterOrderId, reason, sortedTargetOrders }.
export function computeDivertInsertionPosition(divertedOrder, targetLineOrders, targetLineName) {
  // Exclude combined sub-orders (they ride with the lead) and the diverted order itself.
  const sorted = (targetLineOrders || [])
    .filter(o => o && o.id !== divertedOrder?.id && !o.parent_id
      && o.status !== 'completed' && o.status !== 'cancel_po')
    .slice()
    .sort((a, b) => (a.priority_seq ?? 9999) - (b.priority_seq ?? 9999));

  const divertedDate = parseAvailDate(divertedOrder);

  if (!divertedDate) {
    return {
      insertPosition: sorted.length + 1,
      ordersShifted: 0,
      insertedBeforeOrderId: null,
      insertedAfterOrderId: sorted[sorted.length - 1]?.id || null,
      reason: `No parseable avail date on the diverted order — appended to the end of ${targetLineName}.`,
      sortedTargetOrders: sorted,
    };
  }

  // Find first existing order with a later avail date.
  for (let i = 0; i < sorted.length; i++) {
    const od = parseAvailDate(sorted[i]);
    if (od && od.getTime() > divertedDate.getTime()) {
      const insertPos = i + 1; // 1-indexed slot before sorted[i]
      const before = sorted[i];
      const after = i > 0 ? sorted[i - 1] : null;
      const laterDates = [...new Set(sorted.slice(i).map(o => parseAvailDate(o)).filter(Boolean).map(fmtDate))].slice(0, 3).join('/');
      const reason = `Diverted order avail ${fmtDate(divertedDate)} is earlier than later ${laterDates} order(s) on ${targetLineName}, so it slots in ahead of them at priority ${insertPos}.`;
      return {
        insertPosition: insertPos,
        ordersShifted: sorted.length - i,
        insertedBeforeOrderId: before.id,
        insertedAfterOrderId: after?.id || null,
        reason,
        sortedTargetOrders: sorted,
      };
    }
  }

  // Everything on the target line is earlier or undated — append.
  return {
    insertPosition: sorted.length + 1,
    ordersShifted: 0,
    insertedBeforeOrderId: null,
    insertedAfterOrderId: sorted[sorted.length - 1]?.id || null,
    reason: `Diverted order avail ${fmtDate(divertedDate)} is on or after every dated order on ${targetLineName}; placed at the end.`,
    sortedTargetOrders: sorted,
  };
}

function ImpactText({ text }) {
  if (!text) return null;
  const lines = text.split('\n');
  const blocks = [];
  let key = 0;
  let firstH = false;
  lines.forEach(line => {
    const t = line.trim();
    if (!t) return;
    const isH = HEADING_EMOJIS.some(e => t.startsWith(e));
    if (isH) {
      if (firstH) blocks.push(<div key={`sep-${key++}`} style={{ borderTop: '1px dashed #fed7aa', margin: '8px 0' }} />);
      firstH = true;
      blocks.push(<div key={key++} style={{ fontSize: '11px', fontWeight: 700, color: '#92400e', marginBottom: '3px' }}>{t}</div>);
    } else {
      blocks.push(<div key={key++} style={{ fontSize: '11px', color: '#78350f', lineHeight: 1.6 }}>{t}</div>);
    }
  });
  return <>{blocks}</>;
}

// ─── DIVERT ORDER DIALOG ──────────────────────────────────────────────────────
export function DivertOrderDialog({ order, allOrders, kbRecords, feedmillStatus, lineShutdowns = {}, onConfirm, onClose, mashShutdownLines = null }) {
  // isMashDiversion: caller is opening this for a Mash-to-shutdown opportunistic diversion
  const isMashDiversion = Array.isArray(mashShutdownLines) && mashShutdownLines.length > 0;

  const allShutdownLines = [...new Set([
    ...Object.entries(feedmillStatus || {})
      .filter(([, s]) => s && s.isShutdown)
      .flatMap(([fm]) => FEEDMILL_LINES[fm] || []),
    ...Object.keys(lineShutdowns).filter(l => lineShutdowns[l]?.isShutdown),
  ])];

  const currentLine = order.feedmill_line || order.line || '';
  const currentFM = LINE_FEEDMILL[currentLine];
  const currentFMLines = FEEDMILL_LINES[currentFM] || [];

  // Find KB entry for this order
  const matCode = String(order.material_code_fg || order.material_code || '').trim();
  const kbEntry = kbRecords.find(r => {
    const kbCode = String(r.fg_material_code || r.material_code_fg || '').trim();
    return kbCode && matCode && (kbCode === matCode || kbCode.replace(/^0+/, '') === matCode.replace(/^0+/, ''));
  });

  // Partner lines: same feedmill, not shutdown, not this line, any rate.
  // Skipped for mash-to-shutdown diversion.
  const partnerLineObjects = isMashDiversion ? [] : currentFMLines
    .filter(l => l !== currentLine && !allShutdownLines.includes(l))
    .map(l => ({ line: l, rate: parseFloat(kbEntry?.[LINE_RATE_KEY[l]] || 0), isPartner: true }));

  // Outside lines: different feedmill, not shutdown, has rate > 0.
  // Skipped for mash-to-shutdown diversion.
  const outsideLineObjects = isMashDiversion ? [] : Object.entries(LINE_RATE_KEY)
    .map(([line, key]) => ({ line, rate: parseFloat(kbEntry?.[key] || 0), isPartner: false }))
    .filter(({ line, rate }) => !currentFMLines.includes(line) && !allShutdownLines.includes(line) && rate > 0)
    .sort((a, b) => b.rate - a.rate);

  // For mash diversion: all candidate shutdown lines become selectable destinations.
  // Prefer lines with a run rate on record (already sorted that way by getMashShutdownDiversionInfo).
  const availableLines = isMashDiversion
    ? mashShutdownLines.map(l => ({ line: l, rate: parseFloat(kbEntry?.[LINE_RATE_KEY[l]] || 0), isPartner: false, isShutdownDestination: true }))
    : [...partnerLineObjects, ...outsideLineObjects];

  // The outside line with the highest run rate is "recommended" among outside lines
  const bestOutsideRate = outsideLineObjects.length > 0 ? outsideLineObjects[0].rate : -1;
  const bestOutsideLine = outsideLineObjects.length > 0 ? outsideLineObjects[0].line : null;

  const [selectedLine, setSelectedLine] = useState(availableLines[0] || null);
  const [aiText, setAiText] = useState('');
  const [loadingAI, setLoadingAI] = useState(false);
  const [aiPlacement, setAiPlacement] = useState(null);
  const [aiPlacementLoading, setAiPlacementLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Monotonic token: only the latest placement request may mutate state. Guards
  // against a stale response (from a previously-selected line) overwriting the
  // recommendation for the line the user is actually looking at.
  const placementReqRef = useRef(0);

  const volume = parseFloat(order.total_volume_mt || order.volume || 0);
  const originalRate = parseFloat(order.run_rate || 0);

  const buildCalcs = useCallback((line) => {
    if (!line) return null;
    const newProdTime = line.rate > 0 ? volume / line.rate : null;
    const origProdTime = originalRate > 0 ? volume / originalRate : null;
    // Match the table's visual-rank basis (OrderTable activeRankMap) and the apply
    // layer: exclude completed/cancelled (children are dropped inside compute), but
    // KEEP done so the rule-path reviewed slot maps 1:1 to the committed position.
    const targetLineOrders = (allOrders || []).filter(
      o => (o.feedmill_line || o.line) === line.line && o.status !== 'completed' && o.status !== 'cancel_po'
    );
    const ins = computeDivertInsertionPosition(order, targetLineOrders, line.line);
    console.debug('[Diversion Target Line Insertion Analysis]', {
      divertedOrderId: order.id,
      divertedOrderAvailDate: order.target_avail_date || order.avail_date,
      divertedOrderProductionHours: origProdTime,
      targetLine: line.line,
      targetLineOrders: ins.sortedTargetOrders.map(o => ({
        orderId: o.id,
        priority: o.priority_seq,
        availDate: o.target_avail_date || o.avail_date,
        productionHours: o.production_hours,
      })),
      computedInsertionPosition: ins.insertPosition,
      insertionReason: ins.reason,
    });
    return {
      originalRate,
      newProductionTime: newProdTime?.toFixed(2),
      originalProductionTime: origProdTime?.toFixed(2),
      insertPosition: ins.insertPosition,
      ordersShifted: ins.ordersShifted,
      insertedBeforeOrderId: ins.insertedBeforeOrderId,
      insertedAfterOrderId: ins.insertedAfterOrderId,
      insertionReason: ins.reason,
      // The exact entity set the rule path counted, so the apply layer can log a
      // truthful modal-vs-apply comparison on the non-AI (fallback) path.
      lineupIds: (ins.sortedTargetOrders || []).map(o => o.id),
    };
  }, [allOrders, order, originalRate, volume]);

  // Build the destination-line lineup the shared AI insertion engine reasons
  // over. MUST mirror BOTH the table's visual-rank basis (OrderTable activeRankMap)
  // AND the apply layer's eligibility filter: exclude the diverted order, sub-orders,
  // and completed/cancelled — but KEEP done orders (the table counts them in the Prio
  // column), so the reviewed slot maps 1:1 to the committed visual position.
  const buildDivertLineup = useCallback((lineName) => {
    return (allOrders || [])
      .filter(o => (o.feedmill_line || o.line) === lineName
        && o.id !== order.id
        && !o.parent_id
        && o.status !== 'completed' && o.status !== 'cancel_po')
      .slice()
      .sort((a, b) => (a.priority_seq ?? 9999) - (b.priority_seq ?? 9999))
      .map(o => ({
        id: o.id, fpr: o.fpr, item_description: o.item_description,
        volume: o.volume_override ?? o.total_volume_mt ?? o.volume ?? 0,
        production_hours: o.production_hours,
        changeover_time: o.changeover_time,
        target_avail_date: o.target_avail_date,
        avail_date: o.avail_date,
        start_date: o.start_date,
        target_completion_date: o.target_completion_date,
        priority_seq: o.priority_seq,
      }));
  }, [allOrders, order]);

  const generateAI = useCallback(async (line) => {
    if (!line) return;
    const reqId = ++placementReqRef.current;
    const isStale = () => reqId !== placementReqRef.current;
    setLoadingAI(true);
    setAiText('');
    setAiPlacement(null);
    setAiPlacementLoading(true);
    const calcs = buildCalcs(line);
    const lineup = buildDivertLineup(line.line);

    // ── Step 1: Resolve AI insertion placement ─────────────────────────────
    // Single source of truth for the reviewed insertion position. The impact
    // writeup (step 2) awaits this result so the modal summary, the narrative,
    // and the final apply all cite the SAME slot — no more 3-way divergence.
    let resolvedPlacement = null;
    try {
      const res = await generateInsertionPlacement('divert', order, lineup, { lineName: line.line });
      if (isStale()) return;
      if (res && !res.error) {
        // Carry the exact entity set the AI reasoned over so the apply layer can
        // assert (via debug logs) that modal review and final apply count the same
        // target-line orders.
        resolvedPlacement = { ...res, lineupIds: lineup.map(o => o.id) };
        setAiPlacement(resolvedPlacement);
        console.debug('[AI Insertion Recommendation]', {
          modalType: 'divert',
          orderId: order.id,
          targetLine: line.line,
          recommendedInsertPosition: res.insertPosition,
          recommendedPriority: res.targetPrioritySeq,
          recommendedAvailDate: res.aiAvailDate ?? null,
          downstreamDelayRisk: res.downstreamDelayRisk,
          ordersShifted: res.ordersShifted,
          usedAiInsertionEngine: true,
        });
      } else {
        setAiPlacement({ error: res?.error || 'AI placement failed' });
      }
    } catch (err) {
      if (!isStale()) setAiPlacement({ error: err?.message || 'AI placement failed' });
    }
    if (!isStale()) setAiPlacementLoading(false);
    if (isStale()) return;

    // ── Step 2: Generate impact writeup with the resolved authoritative slot ─
    // authInsertPos matches what the modal summary displays and what
    // handleDivertOrderConfirm will apply — guaranteed single source of truth.
    const authInsertPos = resolvedPlacement ? resolvedPlacement.insertPosition : calcs?.insertPosition;
    const calcsForWriteup = {
      ...(calcs || {}),
      insertionReason: resolvedPlacement?.reason || calcs?.insertionReason,
      // Use the authoritative shifted count from the resolved AI placement so the
      // writeup's "orders shifted" matches the modal summary (both position-based).
      ordersShifted: resolvedPlacement ? resolvedPlacement.ordersShifted : calcs?.ordersShifted,
    };
    try {
      const result = await generateDiversionImpact(order, line, calcsForWriteup, authInsertPos);
      if (!isStale()) setAiText(result);
    } catch {
      if (!isStale()) setAiText('Unable to generate impact analysis.');
    }
    if (!isStale()) setLoadingAI(false);
  }, [order, buildCalcs, buildDivertLineup]);

  useEffect(() => {
    if (selectedLine) {
      if (isMashDiversion) {
        console.debug('[Mash Shutdown Diversion Modal]', {
          mashOrderId: order.id,
          sourceLine: currentLine,
          availableShutdownLines: mashShutdownLines,
          selectedDestination: selectedLine.line,
          singleShutdownMode: mashShutdownLines.length === 1,
          multiShutdownMode: mashShutdownLines.length > 1,
          modalOpened: true,
        });
        console.debug('[Mash Diversion Active Shutdown Lines]', {
          mashOrderId: order.id,
          activeShutdownLines: mashShutdownLines,
          singleShutdownMode: mashShutdownLines.length === 1,
          multiShutdownMode: mashShutdownLines.length > 1,
        });
        console.debug('[Mash Diversion Destination Options]', {
          mashOrderId: order.id,
          availableShutdownDestinations: mashShutdownLines,
          selectedDestination: selectedLine.line,
        });
      }
      generateAI(selectedLine);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectLine = (line) => {
    setSelectedLine(line);
    generateAI(line);
  };

  const handleConfirm = async () => {
    if (!selectedLine || isSubmitting) return;
    const calcsAtConfirm = { ...buildCalcs(selectedLine), aiPlacement, isMashShutdownDiversion: isMashDiversion };
    setIsSubmitting(true);
    console.debug('[Diversion/Revert Button State]', { actionType: 'divert', loading: true, disabled: true });
    console.debug('[Diversion Submit]', {
      orderId: order.id,
      sourceLine: currentLine,
      targetLine: selectedLine.line,
      suggestedTargetPriority: (aiPlacement && !aiPlacement.error) ? aiPlacement.targetPrioritySeq : calcsAtConfirm?.insertPosition,
      submitting: true,
    });
    try {
      await onConfirm(order, selectedLine, calcsAtConfirm, aiText);
    } finally {
      setIsSubmitting(false);
      console.debug('[Diversion/Revert Button State]', { actionType: 'divert', loading: false, disabled: false });
    }
  };

  const calcs = buildCalcs(selectedLine);

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div style={{ background: 'var(--color-bg-secondary)', borderRadius: '12px', width: '100%', maxWidth: '600px', maxHeight: '80vh', overflowY: 'auto', padding: '24px 28px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        {/* Title */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '18px' }}>{isMashDiversion ? '🌿' : '🔄'}</span>
            <span style={{ fontSize: '16px', fontWeight: 700, color: '#1a1a1a' }}>
              {isMashDiversion
                ? (mashShutdownLines.length > 1 ? 'Mash Diversion — Choose Shutdown Line' : 'Mash Diversion to Shutdown Line')
                : 'Divert Order'}
            </span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '18px', color: '#9ca3af', cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>

        {/* Order Summary */}
        <div style={{ background: 'var(--color-bg-tertiary)', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '14px 18px', marginBottom: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: '#6b7280', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Order Summary</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
            {/* Row 1: Material Code | Volume */}
            <div>
              <span style={{ fontSize: '11px', color: '#6b7280' }}>Material Code: </span>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#1a1a1a' }}>{order.material_code || '—'}</span>
            </div>
            <div>
              <span style={{ fontSize: '11px', color: '#6b7280' }}>Volume: </span>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#1a1a1a' }}>{volume.toLocaleString(undefined, { maximumFractionDigits: 1 })} MT</span>
            </div>
            {/* Row 2: Item | Batches */}
            <div>
              <span style={{ fontSize: '11px', color: '#6b7280' }}>Item: </span>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#1a1a1a' }}>{(order.item_description || '—').substring(0, 28)}</span>
            </div>
            <div>
              <span style={{ fontSize: '11px', color: '#6b7280' }}>Batches: </span>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#1a1a1a' }}>{order.batch_size ? Math.ceil(volume / order.batch_size) : '—'}</span>
            </div>
            {/* Row 3: Form | Avail Date */}
            <div>
              <span style={{ fontSize: '11px', color: '#6b7280' }}>Form: </span>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#1a1a1a' }}>{order.form || '—'}</span>
            </div>
            <div>
              <span style={{ fontSize: '11px', color: '#6b7280' }}>Avail Date: </span>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#1a1a1a' }}>{order.target_avail_date || order.avail_date || '—'}</span>
            </div>
            {/* Row 4: Current Line (spans full width) */}
            <div style={{ gridColumn: '1 / -1' }}>
              <span style={{ fontSize: '11px', color: '#6b7280' }}>Current Line: </span>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#1a1a1a' }}>{currentLine} </span>
              {!isMashDiversion && <span style={{ fontSize: '9px', fontWeight: 700, color: '#e53935', background: '#fef2f2', padding: '1px 6px', borderRadius: '3px' }}>SHUTDOWN</span>}
            </div>
          </div>
        </div>

        {/* Available Lines / Mash Destination (single or multi-shutdown) */}
        {isMashDiversion ? (
          <div style={{ border: '1px solid #6ee7b7', borderRadius: '8px', marginBottom: '16px', background: '#ecfdf5', overflow: 'hidden' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#065f46', padding: '10px 18px 6px', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #a7f3d0' }}>
              🌿 Mash Opportunistic Diversion{mashShutdownLines.length > 1 ? ' — Select Destination' : ''}
            </div>
            {mashShutdownLines.length === 1 ? (
              <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: '#065f46' }}>
                    Destination: {mashShutdownLines[0]}
                    {selectedLine?.rate > 0 ? ` (rate: ${selectedLine.rate.toFixed(2)} MT/hr)` : ' (no rate on record)'}
                  </div>
                  <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '3px' }}>
                    Mash orders skip the pellet mill and can run on a shutdown line — diverting here keeps production moving.
                  </div>
                </div>
                <span style={{ flexShrink: 0, fontSize: '9px', fontWeight: 700, color: '#e53935', background: '#fef2f2', padding: '2px 8px', borderRadius: '3px' }}>SHUTDOWN LINE</span>
              </div>
            ) : (
              <>
                <div style={{ padding: '8px 18px 4px', fontSize: '11px', color: '#065f46' }}>
                  Mash orders skip the pellet mill and can run on any shutdown line. Choose where to divert.
                </div>
                {availableLines.map((lineObj, idx) => {
                  const isSelected = selectedLine?.line === lineObj.line;
                  return (
                    <div key={lineObj.line}>
                      {idx > 0 && <div style={{ borderTop: '1px solid #a7f3d0' }} />}
                      <div
                        onClick={() => handleSelectLine(lineObj)}
                        style={{
                          display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '12px 18px', cursor: 'pointer',
                          borderLeft: `3px solid ${isSelected ? '#065f46' : '#6ee7b7'}`,
                          background: isSelected ? '#d1fae5' : '#ecfdf5',
                        }}
                      >
                        <div style={{ marginTop: '2px', flexShrink: 0 }}>
                          <div style={{ width: '14px', height: '14px', borderRadius: '50%', border: `2px solid ${isSelected ? '#065f46' : '#6ee7b7'}`, background: isSelected ? '#065f46' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {isSelected && <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#fff' }} />}
                          </div>
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                            <span style={{ fontSize: '12px', fontWeight: 600, color: '#065f46' }}>
                              {lineObj.line}
                              {lineObj.rate > 0 ? ` (rate: ${lineObj.rate.toFixed(2)} MT/hr)` : ' (no rate on record)'}
                            </span>
                            {idx === 0 && availableLines.some(l => l.rate > 0) && (
                              <span style={{ fontSize: '9px', fontWeight: 700, color: '#047857', background: '#d1fae5', padding: '1px 5px', borderRadius: '3px' }}>BEST MATCH</span>
                            )}
                            <span style={{ fontSize: '9px', fontWeight: 700, color: '#e53935', background: '#fef2f2', padding: '1px 5px', borderRadius: '3px' }}>SHUTDOWN LINE</span>
                          </div>
                          <div style={{ fontSize: '11px', color: '#6b7280' }}>{LINE_FEEDMILL[lineObj.line] ? `Feedmill ${(LINE_FEEDMILL[lineObj.line] || '').replace('FM', '')}` : ''}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        ) : (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden', marginBottom: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: '#6b7280', padding: '10px 18px 6px', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #f3f4f6' }}>Available Lines</div>
          {availableLines.length === 0 ? (
            <div style={{ padding: '16px 18px', fontSize: '12px', color: '#9ca3af', fontStyle: 'italic' }}>No alternative lines found in Master Data.</div>
          ) : (
            availableLines.map((lineObj, idx) => {
              const isSelected = selectedLine?.line === lineObj.line;
              const isPartner = lineObj.isPartner;
              const isBestOutside = !isPartner && lineObj.line === bestOutsideLine && bestOutsideRate > 0;
              const isHighlighted = isPartner || isBestOutside;
              const fm = LINE_FEEDMILL[lineObj.line] || '';
              const fmLabel = fm === 'PMX' ? 'Powermix' : fm ? `Feedmill ${fm.replace('FM', '')}` : '';
              const accentColor = isPartner ? '#f59e0b' : '#10b981';
              const selectedBg = isPartner ? '#fffbeb' : '#f0fdf4';
              const unselectedBg = isPartner ? '#fffef7' : isBestOutside ? '#f6fef9' : 'var(--color-bg-secondary)';
              const unselectedBorder = isPartner ? '#fcd34d' : isBestOutside ? '#6ee7b7' : '#e5e7eb';
              const labelColor = isPartner ? '#92400e' : isBestOutside ? '#065f46' : '#374151';
              const badgeColor = isPartner
                ? { color: '#b45309', bg: '#fef3c7' }
                : { color: '#047857', bg: '#d1fae5' };
              return (
                <div key={lineObj.line}>
                  {idx > 0 && <div style={{ borderTop: '1px solid #f3f4f6' }} />}
                  <div
                    onClick={() => handleSelectLine(lineObj)}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '12px 18px', cursor: 'pointer',
                      borderLeft: `3px solid ${isSelected ? accentColor : unselectedBorder}`,
                      background: isSelected ? selectedBg : unselectedBg,
                    }}
                  >
                    <div style={{ marginTop: '2px', flexShrink: 0 }}>
                      <div style={{ width: '14px', height: '14px', borderRadius: '50%', border: `2px solid ${isSelected ? accentColor : '#d1d5db'}`, background: isSelected ? accentColor : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {isSelected && <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: 'var(--color-bg-secondary)' }} />}
                      </div>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                        {isHighlighted && <span style={{ fontSize: '11px' }}>⭐</span>}
                        <span style={{ fontSize: '12px', fontWeight: isHighlighted ? 600 : 500, color: labelColor }}>
                          {lineObj.line} {lineObj.rate > 0 ? `(rate: ${lineObj.rate.toFixed(2)} MT/hr)` : '(no rate on record)'}
                        </span>
                        {isHighlighted && (
                          <span style={{ fontSize: '9px', fontWeight: 700, color: badgeColor.color, background: badgeColor.bg, padding: '1px 5px', borderRadius: '3px' }}>RECOMMENDED</span>
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: '#6b7280' }}>
                        {fmLabel}
                        {isPartner ? ' · Same feedmill — generally compatible' : isBestOutside ? ' · Highest run rate among outside lines' : ''}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
        )}

        {/* Impact Analysis */}
        <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: '8px', padding: '14px 18px', marginBottom: '20px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: '#92400e', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>🤖 Impact Analysis</div>
          {calcs && (() => {
            const hasAi = aiPlacement && !aiPlacement.error;
            // Use insertPosition (1-based visual rank in the sorted lineup) so the
            // modal summary, the writeup, and the applied visual rank in the table
            // all show the same number. targetPrioritySeq is the internal DB write
            // value (gap-aware) and is not shown to the user.
            const shownPos = hasAi ? aiPlacement.insertPosition : calcs.insertPosition;
            const shownShift = hasAi ? aiPlacement.ordersShifted : calcs.ordersShifted;
            return (
              <div style={{ marginBottom: '10px' }} data-testid="panel-divert-ai-placement">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
                  <div style={{ fontSize: '11px', color: '#78350f' }} data-testid="text-divert-placement-position">
                    Insertion Position: <strong>Priority {shownPos}</strong>{shownShift > 0 ? ` (${shownShift} shifted)` : ''}
                    {aiPlacementLoading ? ' …' : ''}
                  </div>
                  <div style={{ fontSize: '11px', color: '#78350f' }}>
                    Production Time:{' '}
                    {calcs.newProductionTime
                      ? <><strong>{calcs.newProductionTime}h</strong>{calcs.originalProductionTime ? ` (was ${calcs.originalProductionTime}h)` : ''}</>
                      : <strong>—</strong>}
                    {calcs.newProductionTime === null || calcs.newProductionTime === undefined ? '' : ''}
                    {(() => {
                      if (!calcs.newProductionTime) {
                        console.debug('[Mash Diversion No-Rate Production Time Formatting]', {
                          mashOrderId: order.id,
                          targetLine: selectedLine?.line,
                          targetRunRate: selectedLine?.rate,
                          displayedProductionTime: '—',
                          usedCleanNoRateFallback: true,
                        });
                      }
                      return null;
                    })()}
                  </div>
                </div>
                {hasAi && (
                  <div style={{ fontSize: '11px', color: '#78350f', marginTop: '4px' }}>
                    Downstream delay risk: <strong style={{ textTransform: 'capitalize' }}>{aiPlacement.downstreamDelayRisk}</strong>
                    {aiPlacement.aiAvailDate ? ` · est. ready ${aiPlacement.aiAvailDate}` : ''}
                  </div>
                )}
                {(hasAi && aiPlacement.reason) ? (
                  <div style={{ fontSize: '11px', color: '#78350f', marginTop: '6px', fontStyle: 'italic' }} data-testid="text-insertion-reason">{aiPlacement.reason}</div>
                ) : calcs.insertionReason ? (
                  <div style={{ fontSize: '11px', color: '#78350f', marginTop: '6px', fontStyle: 'italic' }} data-testid="text-insertion-reason">{calcs.insertionReason}</div>
                ) : null}
              </div>
            );
          })()}
          {loadingAI ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#92400e' }}>
              <Loader2 size={12} className="animate-spin" />
              <span style={{ fontSize: '11px' }}>Generating analysis…</span>
            </div>
          ) : (
            <ImpactText text={aiText} />
          )}
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button onClick={onClose} disabled={isSubmitting} style={{ padding: '8px 18px', fontSize: '13px', color: '#374151', background: 'var(--color-bg-secondary)', border: '1px solid #d1d5db', borderRadius: '6px', cursor: isSubmitting ? 'not-allowed' : 'pointer', opacity: isSubmitting ? 0.6 : 1 }}>Cancel</button>
          <button
            onClick={handleConfirm}
            disabled={!selectedLine || availableLines.length === 0 || isSubmitting || aiPlacementLoading}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 18px', fontSize: '13px', fontWeight: 600, color: '#1a1a1a', background: (!selectedLine || availableLines.length === 0 || isSubmitting || aiPlacementLoading) ? '#d1b832' : '#eab308', border: 'none', borderRadius: '6px', cursor: (!selectedLine || availableLines.length === 0 || isSubmitting || aiPlacementLoading) ? 'not-allowed' : 'pointer', opacity: (isSubmitting || aiPlacementLoading) ? 0.8 : 1 }}
          >
            {(isSubmitting || aiPlacementLoading) && <Loader2 size={13} className="animate-spin" />}
            {isSubmitting ? 'Diverting…' : aiPlacementLoading ? 'Analyzing…' : 'Confirm Diversion'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── REVERT ORDER DIALOG ──────────────────────────────────────────────────────
export function RevertOrderDialog({ order, allOrders, feedmillStatus, lineShutdowns, onConfirm, onClose }) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const dd = order.diversion_data || {};
  const originalLine = dd.originalLine || '—';
  const originalFeedmill = dd.originalFeedmill || '—';
  const currentLine = dd.currentLine || order.feedmill_line || '—';
  const divertedAt = dd.divertedAt ? new Date(dd.divertedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '—';
  const reason = dd.shutdownReason || '—';

  const origFM = LINE_FEEDMILL[originalLine];
  const origLineShutdown = !!(lineShutdowns?.[originalLine]?.isShutdown);
  const origFMShutdown = origFM ? !!(feedmillStatus?.[origFM]?.isShutdown) : false;
  const isOrigActive = !origLineShutdown && !origFMShutdown;
  const isFeedmillShutdown = !!(dd.originalFeedmill);
  const blockMessage = !isOrigActive
    ? (isFeedmillShutdown
        ? 'Cannot revert order until the feedmill is back in operation.'
        : 'Cannot revert order while the original line is still in shutdown.')
    : null;

  // Smart insertion analysis — compute where the order fits on the original line right now.
  // Uses the same algorithm as diversion so the modal, table, and history all agree.
  const revertLineOrders = (allOrders || []).filter(
    o => (o.feedmill_line || o.line) === originalLine &&
         !['done', 'completed', 'cancel_po'].includes((o.status || '').toLowerCase())
  );
  const revertIns = computeDivertInsertionPosition(order, revertLineOrders, originalLine);
  const revertInsertionReason = revertIns.reason
    ? revertIns.reason.replace(/Diverted order/gi, 'Reverted order').replace(/diverted order/gi, 'reverted order')
    : null;

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div style={{ background: 'var(--color-bg-secondary)', borderRadius: '12px', width: '100%', maxWidth: '520px', maxHeight: '85vh', overflowY: 'auto', padding: '24px 28px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        {/* Title */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '18px' }}>↩</span>
            <span style={{ fontSize: '16px', fontWeight: 700, color: '#1a1a1a' }}>Revert Order</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '18px', color: '#9ca3af', cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>

        {/* Order Summary */}
        <div style={{ background: 'var(--color-bg-tertiary)', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '14px 18px', marginBottom: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: '#6b7280', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Order Summary</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '6px' }}>
            <div style={{ fontSize: '12px' }}>
              <span style={{ color: '#6b7280' }}>Item: </span>
              <span style={{ fontWeight: 600, color: '#1a1a1a' }}>{order.item_description || '—'}</span>
              <span style={{ color: '#6b7280' }}> · </span>
              <span style={{ fontWeight: 600, color: '#1a1a1a' }}>{(order.total_volume_mt || 0).toLocaleString()} MT</span>
            </div>
            <div style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ color: '#6b7280' }}>Original Line: </span>
              <span style={{ fontWeight: 600, color: '#1a1a1a' }}>{originalLine} ({originalFeedmill})</span>
              {isOrigActive && (
                <span style={{ fontSize: '10px', fontWeight: 700, color: '#16a34a', background: '#dcfce7', padding: '1px 6px', borderRadius: '3px' }}>✅ Active</span>
              )}
            </div>
            <div style={{ fontSize: '12px' }}>
              <span style={{ color: '#6b7280' }}>Current Line: </span>
              <span style={{ fontWeight: 600, color: '#1a1a1a' }}>{currentLine} ({LINE_FEEDMILL[currentLine] || '—'})</span>
            </div>
            <div style={{ fontSize: '12px' }}>
              <span style={{ color: '#6b7280' }}>Diverted on: </span>
              <span style={{ fontWeight: 600, color: '#1a1a1a' }}>{divertedAt}</span>
            </div>
            <div style={{ fontSize: '12px' }}>
              <span style={{ color: '#6b7280' }}>Reason: </span>
              <span style={{ fontWeight: 600, color: '#1a1a1a' }}>{reason}</span>
            </div>
          </div>
        </div>

        {/* Smart Revert Placement — insertion analysis on the original line */}
        <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px', padding: '14px 18px', marginBottom: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: '#166534', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>↩ Revert Placement</div>
          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', marginBottom: revertInsertionReason ? '8px' : 0 }}>
            <div style={{ fontSize: '11px', color: '#15803d' }}>
              Insertion Position: <strong>Priority {revertIns.insertPosition}</strong>
              {revertIns.ordersShifted > 0 ? ` (${revertIns.ordersShifted} shifted)` : ' (no orders shifted)'}
            </div>
          </div>
          {revertInsertionReason && (
            <div style={{ fontSize: '11px', color: '#166534', fontStyle: 'italic', lineHeight: 1.5 }}>{revertInsertionReason}</div>
          )}
          <div style={{ fontSize: '11px', color: '#166534', marginTop: '8px', lineHeight: 1.5 }}>
            The position above is computed from the <strong>current queue</strong> on {originalLine} — not the historical priority before diversion. This ensures the order slots in where it fits best now.
          </div>
        </div>

        <div style={{ fontSize: '12px', color: '#4b5563', lineHeight: 1.6, marginBottom: '20px' }}>
          This will move the order back to <strong>{originalLine}</strong>, resuming production there. Previously diverted orders can be re-diverted if needed.
        </div>

        {/* Revert blocked message */}
        {blockMessage && (
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '6px', padding: '10px 14px', marginBottom: '16px', fontSize: '12px', color: '#b91c1c', lineHeight: 1.5 }}>
            ⚠ {blockMessage}
          </div>
        )}

        {/* Buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button onClick={onClose} disabled={isSubmitting} style={{ padding: '8px 18px', fontSize: '13px', color: '#374151', background: 'var(--color-bg-secondary)', border: '1px solid #d1d5db', borderRadius: '6px', cursor: isSubmitting ? 'not-allowed' : 'pointer', opacity: isSubmitting ? 0.6 : 1 }}>Cancel</button>
          <button
            onClick={async () => {
              if (blockMessage || isSubmitting) return;
              setIsSubmitting(true);
              console.debug('[Revert Order Submit]', {
                orderId: order.id,
                originalLine,
                currentLine,
                previewInsertionPriority: revertIns.insertPosition,
                previewOrdersShifted: revertIns.ordersShifted,
                submitting: true,
              });
              console.debug('[Diversion/Revert Button State]', { actionType: 'revert', loading: true, disabled: true });
              try {
                await onConfirm(order, revertIns);
              } finally {
                setIsSubmitting(false);
                console.debug('[Diversion/Revert Button State]', { actionType: 'revert', loading: false, disabled: false });
              }
            }}
            disabled={!!blockMessage || isSubmitting}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 18px', fontSize: '13px', fontWeight: 600, color: '#fff', background: (blockMessage || isSubmitting) ? '#6dab6d' : '#16a34a', border: 'none', borderRadius: '6px', cursor: (blockMessage || isSubmitting) ? 'not-allowed' : 'pointer', opacity: (blockMessage || isSubmitting) ? 0.8 : 1 }}
          >
            {isSubmitting && <Loader2 size={13} className="animate-spin" />}
            {isSubmitting ? 'Reverting…' : 'Confirm Revert'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
