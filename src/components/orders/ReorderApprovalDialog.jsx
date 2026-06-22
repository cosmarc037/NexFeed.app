import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { generateReorderImpact, generateReorderPlacement } from '@/services/azureAI';

const HEADING_EMOJIS = ['📍', '⏱', '⚠', '📅'];

const RISK_STYLE = {
  none: { color: '#047857', bg: '#d1fae5', label: 'None' },
  low: { color: '#047857', bg: '#d1fae5', label: 'Low' },
  medium: { color: '#b45309', bg: '#fef3c7', label: 'Medium' },
  high: { color: '#b91c1c', bg: '#fee2e2', label: 'High' },
};

// Line → master-data run-rate column (same mapping the Divert feature uses).
const LINE_RATE_KEY = {
  'Line 1': 'line_1_run_rate',
  'Line 2': 'line_2_run_rate',
  'Line 3': 'line_3_run_rate',
  'Line 4': 'line_4_run_rate',
  'Line 5': 'line_5_run_rate',
  'Line 6': 'line_6_run_rate',
  'Line 7': 'line_7_run_rate',
};

const FEEDMILL_OF_LINE = {
  'Line 1': 'Feedmill 1', 'Line 2': 'Feedmill 1',
  'Line 3': 'Feedmill 2', 'Line 4': 'Feedmill 2',
  'Line 5': 'Powermix',
  'Line 6': 'Feedmill 3', 'Line 7': 'Feedmill 3',
};

function fmtAvail(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function stripMarkdown(text) {
  return text.replace(/\*\*/g, '').replace(/\*/g, '');
}

function ImpactText({ text }) {
  if (!text) return null;
  const lines = text.split('\n');
  const blocks = [];
  let key = 0;
  let firstH = false;
  lines.forEach((line) => {
    const t = stripMarkdown(line.trim());
    if (!t) return;
    const isH = HEADING_EMOJIS.some((e) => t.startsWith(e));
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

function DetailCell({ label, value }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{ fontSize: '11px', color: '#6b7280' }}>{label}</span>
      <span style={{ fontSize: '13px', fontWeight: 600, color: '#1a1a1a' }}>{value}</span>
    </div>
  );
}

// ─── RE-ORDER APPROVAL DIALOG (DEMO ONLY) ─────────────────────────────────────
// Like the Divert feature: the user evaluates which production LINE is best for
// the re-order. Candidate lines are sourced from Master Data historical run rates;
// the recommended Avail Date, insertion position, downstream risk and impact
// analysis are all generated PER selected line (recomputed when the line changes).
// Confirming applies exactly the reviewed placement for the chosen line.
export function ReorderApprovalDialog({ suggestion, kbRecords = [], allOrders = [], onConfirm, onClose }) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Per-line generation cache: { [lineName]: { loading, aiLoading, error, placement, aiText, lineRunRate, productionHours } }
  const [lineData, setLineData] = useState({});

  const order = suggestion?.order || {};
  const sourceLine = order.feedmill_line || '';
  const batchSz = parseFloat(order.batch_size) || 0;
  const rawVtp = suggestion?.avgDaily > 0 ? suggestion.avgDaily : suggestion?.volume;
  const volumeToProduce = batchSz > 0
    ? Math.ceil((rawVtp || 0) / batchSz) * batchSz
    : Math.round(rawVtp || 0);

  // Find the Master Data (KnowledgeBase) entry for this product.
  const kbEntry = useMemo(() => {
    const matCode = String(order.material_code_fg || order.material_code || '').trim();
    return (kbRecords || []).find((r) => {
      const kbCode = String(r.fg_material_code || r.material_code_fg || '').trim();
      return kbCode && matCode && (kbCode === matCode || kbCode.replace(/^0+/, '') === matCode.replace(/^0+/, ''));
    }) || null;
  }, [kbRecords, order.material_code_fg, order.material_code]);

  // Candidate lines: eligible when the product has a historical run rate on the
  // line in Master Data (rate > 0), plus the source line is always included.
  const candidateLines = useMemo(() => {
    const list = Object.entries(LINE_RATE_KEY)
      .map(([line, key]) => ({
        line,
        rate: parseFloat(kbEntry?.[key] || 0) || 0,
        isSource: line === sourceLine,
      }))
      .filter((c) => c.rate > 0 || c.isSource);
    list.sort((a, b) => (b.rate - a.rate) || a.line.localeCompare(b.line));
    return list;
  }, [kbEntry, sourceLine]);

  const bestLine = useMemo(
    () => candidateLines.find((c) => c.rate > 0)?.line || sourceLine,
    [candidateLines, sourceLine],
  );

  const [selectedLine, setSelectedLine] = useState(
    () => candidateLines[0] || null,
  );

  // Build the active lineup for a line from the live order list — mirrors
  // Dashboard.buildDemoLineup so the modal's insertion matches what gets applied.
  const buildLineupFor = useCallback(
    (lineName) =>
      (allOrders || [])
        .filter(
          (o) =>
            (o.feedmill_line || '') === lineName &&
            o.id !== order.id &&
            !o.parent_id &&
            !['completed', 'cancel_po'].includes(String(o.status || '').toLowerCase()),
        )
        .sort((a, b) => (Number(a.priority_seq) || 9999) - (Number(b.priority_seq) || 9999))
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
    [allOrders, order.id],
  );

  // Generate the line-specific placement (date + insertion) AND impact narrative.
  const generateForLine = useCallback(
    async (lineObj) => {
      if (!lineObj) return;
      const lineName = lineObj.line;
      const lineRunRate = lineObj.rate > 0 ? lineObj.rate : (parseFloat(order.run_rate) || null);
      const productionHours = lineRunRate && volumeToProduce
        ? parseFloat((volumeToProduce / lineRunRate).toFixed(2))
        : null;

      setLineData((prev) => ({
        ...prev,
        [lineName]: { ...(prev[lineName] || {}), loading: true, aiLoading: true, error: null, lineRunRate, productionHours },
      }));

      const lineup = buildLineupFor(lineName);
      const payload = {
        item_description: order.item_description,
        fpr: order.fpr,
        feedmill_line: lineName,
        volumeToProduce,
        total_volume_mt: volumeToProduce,
        batch_size: order.batch_size,
        run_rate: lineRunRate,
        production_hours: productionHours,
        changeover_time: order.changeover_time,
        form: order.form,
        sourceTargetAvailDate: suggestion?.sourceTargetAvailDate,
        sourceOriginalAvailDate: suggestion?.sourceOriginalAvailDate,
        // Source-order dependency only applies when re-ordering on the SAME line
        // the source order sits on. On a different line there is no such order.
        sourcePrioritySeq: lineName === sourceLine ? (order.priority_seq ?? null) : null,
      };

      try {
        const placement = await generateReorderPlacement(payload, lineup, {
          today: new Date().toISOString().slice(0, 10),
          lineName,
        });
        if (!placement || placement.error) {
          setLineData((prev) => ({
            ...prev,
            [lineName]: { loading: false, aiLoading: false, error: placement?.error || 'AI placement failed', placement: null, aiText: '', lineRunRate, productionHours },
          }));
          return;
        }
        console.debug('[Approve Re-Order Selected Line Impact]', {
          suggestionId: order.id,
          selectedLine: lineName,
          recommendedAvailDate: placement.aiAvailDate ?? null,
          insertionPosition: placement.targetPrioritySeq ?? placement.insertPosition ?? null,
          downstreamDelayRisk: placement.downstreamDelayRisk ?? null,
          changeoverImpact: Number(order.changeover_time ?? 0.17) || 0.17,
        });
        const firstExistingLineAvailDate = lineup.length > 0
          ? (lineup[0].target_avail_date || lineup[0].avail_date || null)
          : null;
        console.debug('[Approve Re-Order Priority Recommendation Check]', {
          suggestionId: order.id,
          selectedLine: lineName,
          reorderRecommendedAvailDate: placement.aiAvailDate ?? null,
          firstExistingLineAvailDate,
          shouldBePriority1:
            placement.aiAvailDate &&
            firstExistingLineAvailDate &&
            new Date(placement.aiAvailDate) < new Date(firstExistingLineAvailDate),
          recommendedPriority: placement.targetPrioritySeq ?? placement.insertPosition ?? null,
        });
        setLineData((prev) => ({
          ...prev,
          [lineName]: { loading: false, aiLoading: true, error: null, placement, aiText: '', lineRunRate, productionHours },
        }));

        const impactPayload = {
          item_description: order.item_description,
          feedmill_line: lineName,
          volumeToProduce,
          total_volume_mt: volumeToProduce,
          production_hours: productionHours,
          changeover_time: order.changeover_time,
        };
        let txt = '';
        try {
          txt = await generateReorderImpact(impactPayload, placement, lineup);
        } catch {
          txt = 'Unable to generate impact analysis.';
        }
        setLineData((prev) => ({
          ...prev,
          [lineName]: { ...(prev[lineName] || {}), aiLoading: false, aiText: txt },
        }));
      } catch (err) {
        setLineData((prev) => ({
          ...prev,
          [lineName]: { loading: false, aiLoading: false, error: err?.message || 'AI placement failed', placement: null, aiText: '', lineRunRate, productionHours },
        }));
      }
    },
    [order, volumeToProduce, buildLineupFor, sourceLine, suggestion],
  );

  useEffect(() => {
    console.debug('[Approve Re-Order Line Recommendations]', {
      suggestionId: order.id,
      product: order.item_description,
      evaluatedLines: candidateLines.map((c) => ({ line: c.line, rate: c.rate, eligible: c.rate > 0 })),
      recommendedLines: bestLine ? [bestLine] : [],
      basedOnMasterDataRunRate: true,
    });
    if (selectedLine) generateForLine(selectedLine);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectLine = (lineObj) => {
    if (!lineObj || isSubmitting) return;
    setSelectedLine(lineObj);
    const existing = lineData[lineObj.line];
    if (!existing || (!existing.loading && !existing.placement)) {
      generateForLine(lineObj);
    }
  };

  const cur = selectedLine ? lineData[selectedLine.line] : null;
  const placement = cur?.placement || null;
  const aiText = cur?.aiText || '';
  const loadingAI = !!(cur?.loading || cur?.aiLoading);
  const curRunRate = cur?.lineRunRate ?? (selectedLine && selectedLine.rate > 0 ? selectedLine.rate : (parseFloat(order.run_rate) || null));
  const prodTime = cur?.productionHours ?? (curRunRate && volumeToProduce ? Number((volumeToProduce / curRunRate).toFixed(2)) : null);
  const risk = RISK_STYLE[placement?.downstreamDelayRisk] || RISK_STYLE.low;
  const changeover = Number(order.changeover_time ?? 0.17) || 0.17;

  const handleConfirm = async () => {
    if (!selectedLine || isSubmitting) return;
    const data = lineData[selectedLine.line];
    if (!data || !data.placement) return;
    setIsSubmitting(true);
    const tableAiAvailDate = suggestion?.aiPlacement?.aiAvailDate || suggestion?.suggestedDate || null;
    const recalculatedModalAiAvailDate = data.placement?.aiAvailDate ?? null;
    const originalLine = order.feedmill_line || '';
    console.debug('[Approve Re-Order Line-Specific Date Recalculation]', {
      suggestionId: order.id,
      originalLine,
      selectedLine: selectedLine.line,
      tableAiAvailDate,
      recalculatedModalAiAvailDate,
      changedBecauseDifferentLineSelected: originalLine !== selectedLine.line,
    });
    console.debug('[Approve Re-Order Final Insert Date Source]', {
      suggestionId: order.id,
      selectedLine: selectedLine.line,
      finalInsertedAvailDate: recalculatedModalAiAvailDate,
      cameFromOriginalLineDefault: selectedLine.line === originalLine,
      cameFromModalRecalculation: selectedLine.line !== originalLine,
    });
    console.debug('[Demo Re-Order Approval Modal]', {
      suggestionId: order.id,
      confirmed: true,
      selectedLine: selectedLine.line,
      applyingInsertPosition: data.placement?.targetPrioritySeq ?? data.placement?.insertPosition ?? null,
      applyingAiAvailDate: data.placement?.aiAvailDate ?? null,
    });
    try {
      await onConfirm(suggestion, selectedLine, data.placement);
    } finally {
      setIsSubmitting(false);
    }
  };

  const batchSizeDisplay = order.batch_size ? `${Math.round(parseFloat(order.batch_size))}` : '—';
  const volumeDisplay = `${(volumeToProduce || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} MT`;
  const prodTimeDisplay = loadingAI ? 'Generating…' : prodTime != null ? `${Number(prodTime).toFixed(2)} hrs` : '—';
  const recommendedDateDisplay = loadingAI ? 'Generating…' : cur?.error ? '—' : fmtAvail(placement?.aiAvailDate);
  const confirmDisabled = isSubmitting || !selectedLine || loadingAI || !placement;

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div style={{ background: 'var(--color-bg-secondary)', borderRadius: '12px', width: '100%', maxWidth: '600px', maxHeight: '85vh', overflowY: 'auto', padding: '24px 28px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }} data-testid="dialog-reorder-approval">
        {/* Title */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '18px' }}>✨</span>
            <span style={{ fontSize: '16px', fontWeight: 700, color: '#1a1a1a' }}>Approve Re-order</span>
          </div>
          <button onClick={onClose} disabled={isSubmitting} style={{ background: 'none', border: 'none', fontSize: '18px', color: '#9ca3af', cursor: isSubmitting ? 'not-allowed' : 'pointer', lineHeight: 1 }} data-testid="button-close-reorder-approval">✕</button>
        </div>

        {/* Re-order Details */}
        <div style={{ background: 'var(--color-bg-tertiary)', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '14px 18px', marginBottom: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: '#6b7280', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Re-order Details</div>
          <div style={{ marginBottom: '10px' }} data-testid="text-reorder-product">
            <DetailCell label="Product" value={order.item_description || '—'} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', marginBottom: '10px' }}>
            <div data-testid="text-reorder-volume-to-produce">
              <DetailCell label="Volume to Produce" value={volumeDisplay} />
            </div>
            <div data-testid="text-reorder-batch-size">
              <DetailCell label="Batch Size" value={batchSizeDisplay} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
            <div data-testid="text-reorder-production-time">
              <DetailCell label={`Production Time${selectedLine ? ` (${selectedLine.line})` : ''}`} value={prodTimeDisplay} />
            </div>
            <div data-testid="text-reorder-recommended-date">
              <DetailCell label="Recommended Avail Date" value={recommendedDateDisplay} />
            </div>
          </div>
        </div>

        {/* Available Lines — evaluate the best line using Master Data run rates */}
        <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden', marginBottom: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: '#6b7280', padding: '10px 18px 6px', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #f3f4f6' }}>Production Line</div>
          {candidateLines.length === 0 ? (
            <div style={{ padding: '16px 18px', fontSize: '12px', color: '#9ca3af', fontStyle: 'italic' }}>No eligible lines found in Master Data.</div>
          ) : (
            candidateLines.map((lineObj, idx) => {
              const isSelected = selectedLine?.line === lineObj.line;
              const isBest = lineObj.line === bestLine && lineObj.rate > 0;
              const isHighlighted = isBest;
              const accentColor = isBest ? '#10b981' : '#9ca3af';
              const selectedBg = isBest ? '#f0fdf4' : '#f9fafb';
              const unselectedBg = isBest ? '#f6fef9' : 'var(--color-bg-secondary)';
              const unselectedBorder = isBest ? '#6ee7b7' : '#e5e7eb';
              const labelColor = isBest ? '#065f46' : '#374151';
              const fmLabel = FEEDMILL_OF_LINE[lineObj.line] || '';
              const ld = lineData[lineObj.line];
              return (
                <div key={lineObj.line}>
                  {idx > 0 && <div style={{ borderTop: '1px solid #f3f4f6' }} />}
                  <div
                    onClick={() => handleSelectLine(lineObj)}
                    data-testid={`option-reorder-line-${lineObj.line.replace(/\s+/g, '-').toLowerCase()}`}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '12px 18px', cursor: isSubmitting ? 'not-allowed' : 'pointer',
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
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px', flexWrap: 'wrap' }}>
                        {isHighlighted && <span style={{ fontSize: '11px' }}>⭐</span>}
                        <span style={{ fontSize: '12px', fontWeight: isHighlighted ? 600 : 500, color: labelColor }}>
                          {lineObj.line} {lineObj.rate > 0 ? `(rate: ${lineObj.rate.toFixed(2)} MT/hr)` : '(no rate on record)'}
                        </span>
                        {isBest && (
                          <span style={{ fontSize: '9px', fontWeight: 700, color: '#047857', background: '#d1fae5', padding: '1px 5px', borderRadius: '3px' }}>RECOMMENDED</span>
                        )}
                        {lineObj.isSource && (
                          <span style={{ fontSize: '9px', fontWeight: 700, color: '#6b7280', background: '#f3f4f6', padding: '1px 5px', borderRadius: '3px' }}>CURRENT</span>
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: '#6b7280' }}>
                        {fmLabel}
                        {isBest ? ' · Highest historical run rate' : lineObj.rate > 0 ? ' · Eligible by Master Data run rate' : ''}
                        {isSelected && ld?.placement && !ld.loading
                          ? ` · Avail ${fmtAvail(ld.placement.aiAvailDate)}`
                          : isSelected && (ld?.loading || ld?.aiLoading)
                            ? ' · Evaluating…'
                            : ''}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Proposed Insertion Position — line-specific */}
        <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '14px 18px', marginBottom: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: '#6b7280', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Proposed Insertion {selectedLine ? `· ${selectedLine.line}` : ''}</div>
          {loadingAI ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#6b7280' }} data-testid="status-placement-loading">
              <Loader2 size={12} className="animate-spin" />
              <span style={{ fontSize: '11px' }}>Evaluating this line…</span>
            </div>
          ) : cur?.error ? (
            <div style={{ fontSize: '12px', color: '#b45309', fontStyle: 'italic' }} data-testid="text-placement-error">Could not evaluate this line — try another line.</div>
          ) : placement ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
              <div style={{ fontSize: '12px', color: '#374151' }} data-testid="text-insert-position">
                Insertion Position: <strong>Priority {placement.targetPrioritySeq ?? placement.insertPosition}</strong>
                {placement.ordersShifted > 0 ? ` (${placement.ordersShifted} shifted)` : ''}
              </div>
              <div style={{ fontSize: '12px', color: '#374151' }} data-testid="text-downstream-risk">
                Downstream Delay Risk:{' '}
                <span style={{ fontSize: '10px', fontWeight: 700, color: risk.color, background: risk.bg, padding: '1px 6px', borderRadius: '3px' }}>{risk.label}</span>
              </div>
              <div style={{ fontSize: '12px', color: '#374151' }} data-testid="text-production-impact">
                Production Time: <strong>{prodTime != null ? `${Number(prodTime).toFixed(2)} hrs` : '—'}</strong>
              </div>
              <div style={{ fontSize: '12px', color: '#374151' }} data-testid="text-changeover-impact">
                Changeover: <strong>{changeover.toFixed(2)} hrs</strong>
              </div>
              {placement.reason && (
                <div style={{ gridColumn: '1 / -1', fontSize: '11px', color: '#6b7280', fontStyle: 'italic' }} data-testid="text-placement-reason">{placement.reason}</div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: '12px', color: '#9ca3af', fontStyle: 'italic' }}>Select a line to evaluate the insertion position.</div>
          )}
        </div>

        {/* Impact Analysis — line-specific */}
        <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: '8px', padding: '14px 18px', marginBottom: '20px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: '#92400e', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>🤖 Impact Analysis</div>
          {loadingAI ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#92400e' }} data-testid="status-impact-loading">
              <Loader2 size={12} className="animate-spin" />
              <span style={{ fontSize: '11px' }}>Generating analysis…</span>
            </div>
          ) : (
            <ImpactText text={aiText} />
          )}
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button onClick={onClose} disabled={isSubmitting} style={{ padding: '8px 18px', fontSize: '13px', color: '#374151', background: 'var(--color-bg-secondary)', border: '1px solid #d1d5db', borderRadius: '6px', cursor: isSubmitting ? 'not-allowed' : 'pointer', opacity: isSubmitting ? 0.6 : 1 }} data-testid="button-cancel-reorder">Cancel</button>
          <button
            onClick={handleConfirm}
            disabled={confirmDisabled}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 18px', fontSize: '13px', fontWeight: 600, color: '#1a1a1a', background: confirmDisabled ? '#d1b832' : '#eab308', border: 'none', borderRadius: '6px', cursor: confirmDisabled ? 'not-allowed' : 'pointer', opacity: confirmDisabled ? 0.7 : 1 }}
            data-testid="button-confirm-reorder"
          >
            {isSubmitting && <Loader2 size={13} className="animate-spin" />}
            {isSubmitting ? 'Approving…' : 'Confirm & Insert'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default ReorderApprovalDialog;
