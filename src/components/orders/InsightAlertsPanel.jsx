import { useState, useEffect, useMemo, useRef } from 'react';
import { Upload, RefreshCw, Sparkles } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { generatePanelSummary } from '@/services/azureAI';

function displayPrio(seq) {
  return seq != null ? seq + 1 : '?';
}

function parseDate(str) {
  if (!str) return null;
  try { const d = new Date(str); return isNaN(d.getTime()) ? null : d; } catch { return null; }
}

function parseCompletionStr(str) {
  if (!str) return null;
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[4]);
  if (m[6].toUpperCase() === 'PM' && h < 12) h += 12;
  if (m[6].toUpperCase() === 'AM' && h === 12) h = 0;
  return new Date(parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]), h, parseInt(m[5]));
}

function fmtDate(d) {
  if (!d) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(d) {
  if (!d) return '';
  return `${fmtDate(d)} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

function daysDiff(a, b) {
  return Math.round((a - b) / (1000 * 60 * 60 * 24));
}

function hoursDiff(a, b) {
  return (a - b) / (1000 * 60 * 60);
}

function OrderRef({ fpr, name, orderId, onScrollToOrder }) {
  const handleClick = () => {
    if (!orderId) return;
    const row = document.querySelector(`[data-order-id="${orderId}"]`);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('highlight-flash');
      setTimeout(() => row.classList.remove('highlight-flash'), 2000);
    }
    if (onScrollToOrder) onScrollToOrder(orderId);
  };

  return (
    <span
      style={{
        fontWeight: 600,
        color: '#374151',
        cursor: 'pointer',
        textDecoration: 'underline dotted #d1d5db',
        textUnderlineOffset: '2px',
      }}
      onMouseEnter={e => { e.currentTarget.style.color = '#fd5108'; e.currentTarget.style.textDecoration = 'underline solid #fd5108'; }}
      onMouseLeave={e => { e.currentTarget.style.color = '#374151'; e.currentTarget.style.textDecoration = 'underline dotted #d1d5db'; }}
      onClick={handleClick}
      data-testid={`link-order-ref-${orderId}`}
    >
      FPR: {fpr}{name ? ` (${name})` : ''}
    </span>
  );
}

function InsightCard({ emoji, title, children }) {
  return (
    <div
      className="rounded-md"
      style={{ background: '#ffffff', border: '1px solid #f3f4f6', borderRadius: 6, padding: '10px 12px' }}
      data-testid={`card-insight-${title}`}
    >
      <p style={{ fontWeight: 500, fontSize: 12, color: '#374151', marginBottom: 4 }}>{emoji} {title}</p>
      <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.5 }}>{children}</div>
    </div>
  );
}

function AlertCard({ emoji, title, children, severity }) {
  const leftBorderColor = {
    critical: '#e53935',
    urgent: '#fd5108',
    warning: '#f59e0b',
    info: '#9ca3af',
  };
  const borderColor = leftBorderColor[severity] || leftBorderColor.info;

  return (
    <div
      className="rounded-md"
      style={{ background: '#ffffff', border: '1px solid #f3f4f6', borderLeft: `2px solid ${borderColor}`, borderRadius: 6, padding: '10px 12px' }}
      data-testid={`card-alert-${title}`}
    >
      <p style={{ fontWeight: 500, fontSize: 12, color: '#374151', marginBottom: 4 }}>{emoji} {title}</p>
      <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.5 }}>{children}</div>
    </div>
  );
}

const FM_LABEL_MAP = { FM1: 'Feedmill 1', FM2: 'Feedmill 2', FM3: 'Feedmill 3', PMX: 'Powermix' };

function buildSummaryContext(orders, inferredTargetMap, feedmill, line) {
  const now = new Date();
  const fmLabel = FM_LABEL_MAP[feedmill] || feedmill || 'All';
  const scope = (!line || line === 'all') ? fmLabel : line;

  const active = orders.filter(o => o.status !== 'completed' && o.status !== 'cancel_po');

  const overdueOrders = active.filter(o => {
    if (!o.target_avail_date) return false;
    const d = parseDate(o.target_avail_date);
    return d && d < now;
  }).map(o => ({
    prio: displayPrio(o.priority_seq),
    description: (o.item_description || '').substring(0, 40),
    availDate: o.target_avail_date,
    fpr: o.fpr,
  }));

  const criticalProducts = [];
  const urgentProducts = [];
  for (const o of active) {
    const inf = inferredTargetMap[o.material_code];
    if (!inf) continue;
    const entry = { name: (o.item_description || '').substring(0, 35), prio: displayPrio(o.priority_seq), fpr: o.fpr };
    if (inf.status === 'Critical') criticalProducts.push(entry);
    else if (inf.status === 'Urgent') urgentProducts.push(entry);
  }

  const uncombined = active.filter(o => !o.parent_id && !(o.original_order_ids?.length));
  const groupMap = {};
  for (const o of uncombined) {
    const key = o.material_code_fg ? `${o.material_code_fg}|${o.feedmill_line}` : null;
    if (!key) continue;
    if (!groupMap[key]) groupMap[key] = { product: (o.item_description || '').substring(0, 30), count: 0, totalVolume: 0 };
    groupMap[key].count++;
    groupMap[key].totalVolume += parseFloat(o.volume_override ?? o.total_volume_mt) || 0;
  }
  const combinableGroups = Object.values(groupMap).filter(g => g.count >= 2).map(g => ({
    ...g, totalVolume: g.totalVolume.toFixed(0),
  }));

  return {
    scope,
    totalOrders: active.length,
    totalVolume: active.reduce((s, o) => s + (parseFloat(o.volume_override ?? o.total_volume_mt) || 0), 0),
    plotted: active.filter(o => o.status === 'plotted').length,
    planned: active.filter(o => o.status === 'planned').length,
    inProduction: active.filter(o => o.status === 'in_production').length,
    onHold: active.filter(o => o.status === 'hold').length,
    done: orders.filter(o => o.status === 'completed').length,
    cancelled: orders.filter(o => o.status === 'cancel_po').length,
    overdueOrders,
    criticalProducts,
    urgentProducts,
    combinableGroups,
    orders: active.slice(0, 25).map(o => ({
      prio: displayPrio(o.priority_seq),
      description: (o.item_description || '').substring(0, 40),
      volume: parseFloat((o.volume_override ?? o.total_volume_mt) || 0).toFixed(0),
      status: o.status,
      availDate: o.target_avail_date || null,
    })),
  };
}

function formatSummaryContent(text) {
  const lines = text.split('\n').filter(l => l.trim());
  return lines.map((line, i) => {
    const numbered = line.match(/^(\d+)\.\s(.+)/);
    if (numbered) {
      return (
        <div key={i} style={{ display: 'flex', gap: 6, fontSize: 12, color: '#374151', lineHeight: 1.6, padding: '2px 0' }}>
          <span style={{ fontWeight: 700, color: '#374151', minWidth: 16, flexShrink: 0 }}>{numbered[1]}.</span>
          <span>{numbered[2]}</span>
        </div>
      );
    }
    const isHeader = /recommended actions|action items|priorities/i.test(line);
    if (isHeader) {
      return <div key={i} style={{ fontSize: 11, fontWeight: 700, color: '#374151', margin: '10px 0 6px 0' }}>{line}</div>;
    }
    return <p key={i} style={{ margin: '0 0 8px 0', fontSize: 12, color: '#374151', lineHeight: 1.6 }}>{line}</p>;
  });
}

function AISummaryCard({ type, orders, feedmill, line, inferredTargetMap, isOpen }) {
  const [summary, setSummary] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const hasGeneratedRef = useRef(false);
  const currentScopeRef = useRef(null);

  async function generateSummary(ctx) {
    setIsLoading(true);
    try {
      const result = await generatePanelSummary(type, ctx);
      setSummary(result || 'Unable to generate summary at this time. Click Refresh to try again.');
    } catch {
      setSummary('Unable to generate summary at this time. Click Refresh to try again.');
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (!isOpen || !orders || orders.length === 0) return;
    const scopeKey = `${feedmill}|${line}`;
    const scopeChanged = currentScopeRef.current !== scopeKey;
    if (!hasGeneratedRef.current || scopeChanged) {
      currentScopeRef.current = scopeKey;
      hasGeneratedRef.current = true;
      const ctx = buildSummaryContext(orders, inferredTargetMap, feedmill, line);
      generateSummary(ctx);
    }
  }, [isOpen, feedmill, line]);

  function handleRefresh() {
    if (isLoading) return;
    const ctx = buildSummaryContext(orders, inferredTargetMap, feedmill, line);
    generateSummary(ctx);
  }

  const bodyContent = (() => {
    if (isLoading && !summary) {
      return (
        <div style={{ fontSize: 12, color: '#92400e', fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Sparkles style={{ width: 12, height: 12, animation: 'spin 1s linear infinite' }} />
          Generating smart summary...
        </div>
      );
    }
    if (isLoading && summary) {
      return <div style={{ opacity: 0.5 }}>{formatSummaryContent(summary)}</div>;
    }
    if (!isLoading && summary) {
      return <div>{formatSummaryContent(summary)}</div>;
    }
    return (
      <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>
        Click Refresh to generate a smart summary.
      </div>
    );
  })();

  return (
    <div className="rounded-md" style={{ background: '#ffffff', border: '1px solid #f3f4f6', borderRadius: 6, padding: '10px 12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <p style={{ fontWeight: 500, fontSize: 12, color: '#374151', margin: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
          <Sparkles style={{ width: 13, height: 13, color: '#d97706', flexShrink: 0 }} />
          Smart Summary
        </p>
        <button
          onClick={handleRefresh}
          disabled={isLoading}
          title="Refresh summary"
          data-testid={`button-ai-summary-refresh-${type}`}
          style={{ background: 'none', border: 'none', cursor: isLoading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 4, color: '#9ca3af', fontSize: 11, padding: '2px 4px', borderRadius: 4, opacity: isLoading ? 0.5 : 1, transition: 'color 0.15s', flexShrink: 0 }}
          onMouseEnter={e => { if (!isLoading) e.currentTarget.style.color = '#6b7280'; }}
          onMouseLeave={e => { e.currentTarget.style.color = '#9ca3af'; }}
        >
          <RefreshCw style={{ width: 11, height: 11, animation: isLoading ? 'spin 1s linear infinite' : 'none' }} />
          Refresh
        </button>
      </div>
      <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.5, minHeight: 20 }}>
        {bodyContent}
      </div>
    </div>
  );
}

function computeInsights(orders, onScrollToOrder, inferredTargetMap = {}, onAutoSequence = null) {
  const now = new Date();
  const categoryBuckets = { n10d: [], priority: [], combine: [], cut: [], sequence: [], capacity: [] };
  const active = orders.filter(o => o.status !== 'completed' && o.status !== 'cancel_po');
  const sorted = [...active].sort((a, b) => (a.priority_seq ?? 999) - (b.priority_seq ?? 999));

  // A — Priority Orders
  for (const o of sorted) {
    const availDate = parseDate(o.target_avail_date);
    if (!availDate) continue;
    const completionDate = parseCompletionStr(o.target_completion_date);
    const hoursLeft = availDate ? hoursDiff(availDate, now) : Infinity;

    if (hoursLeft < 48 || (completionDate && completionDate > availDate)) {
      const prio = displayPrio(o.priority_seq);
      const desc = (o.item_description || '').substring(0, 40);
      const isOverdue = completionDate && completionDate > availDate;

      categoryBuckets.priority.push({
        priority: isOverdue ? 1 : 2,
        render: (
          <InsightCard emoji="📌" title="Prioritize Order">
            <OrderRef fpr={o.fpr} name={desc} orderId={o.id} onScrollToOrder={onScrollToOrder} />{' '}
            has an availability date of {fmtDate(availDate)} but is currently at Prio {prio}.
            {completionDate && (
              <> Estimated completion: {fmtDateTime(completionDate)}.
                {isOverdue ? ' This order may miss its deadline — consider moving it higher.' : ' The timeline is tight — monitor closely.'}
              </>
            )}
            {!completionDate && ' No completion date estimated yet. Consider setting start date and time to enable scheduling.'}
          </InsightCard>
        ),
      });
    }
  }

  // B — Combine Suggestions (same line + form + same FG or same material_code)
  const uncombined = sorted.filter(o => !o.parent_id && !(o.original_order_ids?.length));
  const combineGroups = {};
  for (const o of uncombined) {
    const fgKey = o.fg ? `fg:${o.fg}|${o.feedmill_line}|${o.form}` : null;
    const matKey = o.material_code ? `mat:${o.material_code}|${o.feedmill_line}|${o.form}` : null;
    if (fgKey) { if (!combineGroups[fgKey]) combineGroups[fgKey] = []; combineGroups[fgKey].push(o); }
    if (matKey) { if (!combineGroups[matKey]) combineGroups[matKey] = []; combineGroups[matKey].push(o); }
  }
  const seenCombinePairs = new Set();
  for (const [, group] of Object.entries(combineGroups)) {
    if (group.length < 2) continue;
    const first = group[0];
    const second = group[1];
    const pairKey = [first.id, second.id].sort().join('|');
    if (seenCombinePairs.has(pairKey)) continue;
    seenCombinePairs.add(pairKey);
    const desc = (first.item_description || '').substring(0, 35);
    const totalVol = group.reduce((s, o) => s + (parseFloat(o.volume_override ?? o.total_volume_mt) || 0), 0);
    const bs = parseFloat(first.batch_size) || 4;
    const batches = Math.ceil(totalVol / bs);
    const coSaved = ((group.length - 1) * (parseFloat(first.changeover_time) || 0.17)).toFixed(1);

    categoryBuckets.combine.push({
      priority: 3,
      render: (
        <InsightCard emoji="🔗" title="Consider Combining">
          <OrderRef fpr={first.fpr} name={`Prio ${displayPrio(first.priority_seq)}, ${parseFloat(first.volume_override ?? first.total_volume_mt) || 0} MT`} orderId={first.id} onScrollToOrder={onScrollToOrder} />{' '}
          and <OrderRef fpr={second.fpr} name={`Prio ${displayPrio(second.priority_seq)}, ${parseFloat(second.volume_override ?? second.total_volume_mt) || 0} MT`} orderId={second.id} onScrollToOrder={onScrollToOrder} />{' '}
          are the same product ({desc}) on the same line.
          Combining would save ~{coSaved} hr changeover and create a {totalVol} MT run ({batches} batches).
          {group.length > 2 && ` Plus ${group.length - 2} more order(s) could join the group.`}
        </InsightCard>
      ),
    });
  }

  // C — Cut Suggestions (volume > 2× next order's volume, production_hours > 6, downstream has tighter deadline)
  for (let i = 0; i < sorted.length; i++) {
    const o = sorted[i];
    const prodHrs = parseFloat(o.production_hours) || 0;
    if (prodHrs < 6 || o.is_cut) continue;
    const oVol = parseFloat(o.volume_override ?? o.total_volume_mt) || 0;
    const oAvail = parseDate(o.target_avail_date);
    const nextOrder = sorted[i + 1];
    if (!nextOrder) continue;
    const nextVol = parseFloat(nextOrder.volume_override ?? nextOrder.total_volume_mt) || 0;
    if (nextVol <= 0 || oVol <= 2 * nextVol) continue;
    const nextAvail = parseDate(nextOrder.target_avail_date);
    if (!nextAvail || (oAvail && nextAvail >= oAvail)) continue;
    const bs = parseFloat(o.batch_size) || 4;
    const half = Math.ceil((oVol / 2) / bs) * bs;
    const rest = oVol - half;
    if (rest <= 0) continue;
    const desc = (o.item_description || '').substring(0, 35);
    const nextDesc = (nextOrder.item_description || '').substring(0, 30);

    categoryBuckets.cut.push({
      priority: 4,
      render: (
        <InsightCard emoji="✂️" title="Consider Cutting">
          <OrderRef fpr={o.fpr} name={`Prio ${displayPrio(o.priority_seq)}, ${oVol} MT, ${desc}`} orderId={o.id} onScrollToOrder={onScrollToOrder} />{' '}
          takes ~{prodHrs.toFixed(1)} hrs and is {(oVol / nextVol).toFixed(1)}× larger than the next order. Cutting into {half} MT + {rest} MT could let{' '}
          <OrderRef fpr={nextOrder.fpr} name={nextDesc} orderId={nextOrder.id} onScrollToOrder={onScrollToOrder} />{' '}
          (deadline: {fmtDate(nextAvail)}) start sooner.
        </InsightCard>
      ),
    });
  }

  // D — Sequence Optimization
  for (let i = 0; i < sorted.length - 1; i++) {
    const curr = sorted[i];
    const next = sorted[i + 1];
    if (!curr.form || !next.form || curr.form === next.form) continue;
    const sameFormNeighbor = sorted.find((o, j) => j > i + 1 && o.form === curr.form);
    if (!sameFormNeighbor) continue;
    const coTime = parseFloat(curr.changeover_time) || 0.17;
    const currDesc = (curr.item_description || '').substring(0, 25);
    const neighborDesc = (sameFormNeighbor.item_description || '').substring(0, 25);

    categoryBuckets.sequence.push({
      priority: 5,
      render: (
        <InsightCard emoji="🔄" title="Sequence Optimization">
          Swapping <OrderRef fpr={next.fpr} name={`Prio ${displayPrio(next.priority_seq)}, ${next.form}`} orderId={next.id} onScrollToOrder={onScrollToOrder} />{' '}
          with <OrderRef fpr={sameFormNeighbor.fpr} name={`Prio ${displayPrio(sameFormNeighbor.priority_seq)}, ${sameFormNeighbor.form}`} orderId={sameFormNeighbor.id} onScrollToOrder={onScrollToOrder} />{' '}
          could save ~{(coTime * 60).toFixed(0)} min changeover. Both{' '}
          <OrderRef fpr={curr.fpr} name={currDesc} orderId={curr.id} onScrollToOrder={onScrollToOrder} />{' '}
          and <OrderRef fpr={sameFormNeighbor.fpr} name={neighborDesc} orderId={sameFormNeighbor.id} onScrollToOrder={onScrollToOrder} />{' '}
          share the same form ({curr.form}).
        </InsightCard>
      ),
    });
    break;
  }

  // E — Line Capacity Gaps
  for (let i = 0; i < sorted.length - 1; i++) {
    const curr = sorted[i];
    const next = sorted[i + 1];
    const currCompletion = parseCompletionStr(curr.target_completion_date);
    const nextStart = parseDate(next.start_date);
    if (!currCompletion || !nextStart) continue;
    let nextStartFull = new Date(nextStart);
    if (next.start_time) {
      const tm = next.start_time.match(/(\d+):(\d+)\s*(AM|PM)?/i);
      if (tm) {
        let h = parseInt(tm[1]);
        if (tm[3]?.toUpperCase() === 'PM' && h < 12) h += 12;
        if (tm[3]?.toUpperCase() === 'AM' && h === 12) h = 0;
        nextStartFull.setHours(h, parseInt(tm[2]), 0, 0);
      }
    }
    const gap = hoursDiff(nextStartFull, currCompletion);
    if (gap < 1) continue;

    categoryBuckets.capacity.push({
      priority: 6,
      render: (
        <InsightCard emoji="⏳" title="Line Capacity Gap">
          There's a ~{gap.toFixed(1)} hour gap between{' '}
          <OrderRef fpr={curr.fpr} name={`Prio ${displayPrio(curr.priority_seq)}`} orderId={curr.id} onScrollToOrder={onScrollToOrder} />{' '}
          (completes {fmtDateTime(currCompletion)}) and{' '}
          <OrderRef fpr={next.fpr} name={`Prio ${displayPrio(next.priority_seq)}`} orderId={next.id} onScrollToOrder={onScrollToOrder} />{' '}
          (starts {fmtDateTime(nextStartFull)}). Consider filling this slot or adjusting start times.
        </InsightCard>
      ),
    });
  }

  // N10D — Stock-Level Sequencing Available + Stock-sufficient deprioritize insight
  const hasN10DData = Object.keys(inferredTargetMap).length > 0;
  if (hasN10DData) {
    // Insight 1: Stock-Level Sequencing Available (orders with inferred targets)
    const stockTargetedOrders = sorted.filter(o => {
      const inf = inferredTargetMap[o.material_code];
      return inf && inf.status !== 'Sufficient' && inf.targetDate;
    });
    if (stockTargetedOrders.length > 0) {
      categoryBuckets.n10d.push({
        priority: 1,
        render: (
          <InsightCard emoji="📊" title="Stock-Level Sequencing Available">
            Next 10 Days data shows <strong>{stockTargetedOrders.length}</strong> order{stockTargetedOrders.length !== 1 ? 's' : ''} with inferred target dates.
            {' '}Run Auto-Sequence to optimize the production schedule based on stock demand forecasts.
            {onAutoSequence && (
              <div style={{ marginTop: 6 }}>
                <button
                  onClick={onAutoSequence}
                  style={{ background: '#fd5108', color: 'white', border: 'none', borderRadius: 5, padding: '3px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}
                  data-testid="button-run-autosequence-from-insight"
                >
                  Run Auto-Sequence
                </button>
              </div>
            )}
          </InsightCard>
        ),
      });
    }

    // Insight 2: Stock-sufficient deprioritize
    const stockOkOrders = sorted.filter(o => {
      const inf = inferredTargetMap[o.material_code];
      return inf && inf.status === 'Sufficient';
    });
    if (stockOkOrders.length > 0) {
      const shown = stockOkOrders.slice(0, 3);
      const extra = stockOkOrders.length - shown.length;
      categoryBuckets.n10d.push({
        priority: 3,
        render: (
          <InsightCard emoji="✅" title="Deprioritize Stock-Sufficient Orders">
            <strong>{stockOkOrders.length}</strong> order{stockOkOrders.length !== 1 ? 's are' : ' is'} flagged as Stock Sufficient. These can be moved to lower priority:
            <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {shown.map((o, i) => (
                <span key={i} style={{ fontSize: 11 }}>
                  • FPR: {o.fpr || '-'} —{' '}
                  <OrderRef fpr={o.fpr} name={(o.item_description || '').substring(0, 28)} orderId={o.id} onScrollToOrder={onScrollToOrder} />
                  {' '}({parseFloat((o.volume_override ?? o.total_volume_mt) || 0).toFixed(0)} MT{o.feedmill_line ? `, ${o.feedmill_line}` : ''})
                </span>
              ))}
              {extra > 0 && <span style={{ fontSize: 11, color: '#6b7280' }}>+{extra} more</span>}
            </div>
            {onAutoSequence && (
              <div style={{ marginTop: 6 }}>
                <button
                  onClick={onAutoSequence}
                  style={{ background: '#fd5108', color: 'white', border: 'none', borderRadius: 5, padding: '3px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}
                  data-testid="button-deprioritize-autosequence"
                >
                  Run Auto-Sequence
                </button>
              </div>
            )}
          </InsightCard>
        ),
      });
    }

    // N10D — Multiple orders same product
    const productGroups = {};
    for (const o of sorted) {
      if (!o.material_code) continue;
      if (!productGroups[o.material_code]) productGroups[o.material_code] = [];
      productGroups[o.material_code].push(o);
    }
    for (const [code, grp] of Object.entries(productGroups)) {
      if (grp.length < 2) continue;
      const inf = inferredTargetMap[code];
      const totalVol = grp.reduce((s, o) => s + (parseFloat(o.volume_override ?? o.total_volume_mt) || 0), 0);
      categoryBuckets.n10d.push({
        priority: 5,
        render: (
          <InsightCard emoji="🔁" title="Multiple Orders — Same Product">
            {grp.length} orders for <strong>{code}</strong>
            {inf?.targetDate && ` (target: ${fmtDate(parseDate(inf.targetDate))})`}
            {' '}total {totalVol.toFixed(0)} MT. Consider combining them for production efficiency.
          </InsightCard>
        ),
      });
    }
  }

  // Category-aware selection: take best 1 from each category first, then fill remaining slots
  const catOrder = ['n10d', 'priority', 'combine', 'cut', 'sequence', 'capacity'];
  const result = [];
  for (const cat of catOrder) {
    if (categoryBuckets[cat].length > 0) {
      categoryBuckets[cat].sort((a, b) => a.priority - b.priority);
      result.push(categoryBuckets[cat].shift());
    }
  }
  const remaining = catOrder.flatMap(cat => categoryBuckets[cat]);
  remaining.sort((a, b) => a.priority - b.priority);
  for (const item of remaining) {
    if (result.length >= 5) break;
    result.push(item);
  }
  return result;
}

function computeAlerts(orders, lastUploadDate, onUpload, onScrollToOrder, inferredTargetMap = {}, lastN10DUploadDate = null, onNavigateToN10D = null) {
  const now = new Date();
  const catBuckets = { n10d: [], deadline: [], sap: [], missing: [], hold: [], overdue: [] };
  const active = orders.filter(o => o.status !== 'completed' && o.status !== 'cancel_po');

  // A — Deadline alerts + E — Overdue
  for (const o of active) {
    const availDate = parseDate(o.target_avail_date);
    if (!availDate) continue;
    const hoursLeft = hoursDiff(availDate, now);
    const daysOver = daysDiff(now, availDate);
    const prio = displayPrio(o.priority_seq);
    const desc = (o.item_description || '').substring(0, 35);
    const completionDate = parseCompletionStr(o.target_completion_date);

    if (hoursLeft < 0) {
      catBuckets.overdue.push({
        sortOrder: 0,
        render: (
          <AlertCard emoji="🔴" title="Overdue — Past Deadline" severity="critical">
            <OrderRef fpr={o.fpr} name={desc} orderId={o.id} onScrollToOrder={onScrollToOrder} />{' '}
            had an availability date of {fmtDate(availDate)} but is still active at Prio {prio}.
            {daysOver > 0 && ` This order is ${daysOver} day(s) overdue.`}
            {completionDate && ` Estimated completion: ${fmtDateTime(completionDate)}.`}
            {' '}Immediate action recommended.
          </AlertCard>
        ),
      });
    } else if (hoursLeft <= 24) {
      catBuckets.deadline.push({
        sortOrder: 1,
        render: (
          <AlertCard emoji="🟠" title="Urgent — Deadline Approaching" severity="urgent">
            <OrderRef fpr={o.fpr} name={desc} orderId={o.id} onScrollToOrder={onScrollToOrder} />{' '}
            has an availability date of {fmtDate(availDate)} (within 24 hours).
            Currently at Prio {prio}.
            {completionDate && ` Estimated completion: ${fmtDateTime(completionDate)}.`}
            {' '}Consider prioritizing.
          </AlertCard>
        ),
      });
    } else if (hoursLeft <= 48) {
      catBuckets.deadline.push({
        sortOrder: 2,
        render: (
          <AlertCard emoji="🟡" title="Warning — Deadline Within 48h" severity="warning">
            <OrderRef fpr={o.fpr} name={desc} orderId={o.id} onScrollToOrder={onScrollToOrder} />{' '}
            has an availability date of {fmtDate(availDate)}.
            Currently at Prio {prio}.{' '}Monitor scheduling.
          </AlertCard>
        ),
      });
    }
  }

  // B — SAP Upload Reminder
  const dayOfWeek = now.getDay();
  const uploadDays = [1, 3, 5];
  const isUploadDay = uploadDays.includes(dayOfWeek);
  const lastUpload = lastUploadDate ? new Date(lastUploadDate) : null;
  const daysSinceUpload = lastUpload ? daysDiff(now, lastUpload) : Infinity;

  if (!lastUpload) {
    catBuckets.sap.push({
      sortOrder: 0.5,
      render: (
        <AlertCard emoji="🔴" title="No Orders Uploaded" severity="critical">
          No production orders have been uploaded yet. Please upload an SAP file to get started.
          {onUpload && (
            <div className="mt-2">
              <Button size="sm" className="bg-[#fd5108] hover:bg-[#fe7c39] text-white text-xs h-7 px-3" onClick={onUpload} data-testid="button-upload-sap-alert">
                <Upload className="h-3 w-3 mr-1" /> Upload SAP File
              </Button>
            </div>
          )}
        </AlertCard>
      ),
    });
  } else if (daysSinceUpload >= 5) {
    catBuckets.sap.push({
      sortOrder: 0.5,
      render: (
        <AlertCard emoji="🔴" title="SAP Data Outdated" severity="critical">
          Your last SAP upload was {daysSinceUpload}+ days ago ({fmtDate(lastUpload)}).
          Production orders may not reflect the latest SAP data. Please upload as soon as possible.
          {onUpload && (
            <div className="mt-2">
              <Button size="sm" className="bg-[#fd5108] hover:bg-[#fe7c39] text-white text-xs h-7 px-3" onClick={onUpload} data-testid="button-upload-sap-alert">
                <Upload className="h-3 w-3 mr-1" /> Upload SAP File
              </Button>
            </div>
          )}
        </AlertCard>
      ),
    });
  } else if (isUploadDay && daysSinceUpload >= 1) {
    catBuckets.sap.push({
      sortOrder: 4,
      render: (
        <AlertCard emoji="📥" title="SAP Upload Day" severity="info">
          Today is a scheduled upload day. {lastUpload ? `Your last upload was ${fmtDate(lastUpload)}.` : ''}{' '}
          Please upload the latest SAP file to keep production orders current.
          {onUpload && (
            <div className="mt-2">
              <Button size="sm" className="bg-[#fd5108] hover:bg-[#fe7c39] text-white text-xs h-7 px-3" onClick={onUpload} data-testid="button-upload-sap-alert">
                <Upload className="h-3 w-3 mr-1" /> Upload SAP File
              </Button>
            </div>
          )}
        </AlertCard>
      ),
    });
  } else if (!isUploadDay && daysSinceUpload >= 3) {
    catBuckets.sap.push({
      sortOrder: 2.5,
      render: (
        <AlertCard emoji="⚠️" title="Missed SAP Upload" severity="warning">
          It looks like a scheduled upload was missed. {lastUpload ? `Last upload was ${fmtDate(lastUpload)} (${daysSinceUpload} days ago).` : ''}{' '}
          Orders may be outdated. Consider uploading today.
          {onUpload && (
            <div className="mt-2">
              <Button size="sm" className="bg-[#fd5108] hover:bg-[#fe7c39] text-white text-xs h-7 px-3" onClick={onUpload} data-testid="button-upload-sap-alert">
                <Upload className="h-3 w-3 mr-1" /> Upload SAP File
              </Button>
            </div>
          )}
        </AlertCard>
      ),
    });
  }

  // C — Missing Order Data
  const missingData = [];
  for (const o of active) {
    const missing = [];
    if (!o.fg) missing.push('FG');
    if (!o.sfg) missing.push('SFG');
    if (o.feedmill_line === 'Line 5' && !o.pmx) missing.push('PMX');
    if (!o.material_code) missing.push('Material Code');
    if (!o.item_description) missing.push('Item Description');
    if (!o.total_volume_mt || parseFloat(o.total_volume_mt) <= 0) missing.push('Volume');
    if (!o.form) missing.push('Form');
    if (!o.batch_size) missing.push('Batch Size');
    if (missing.length > 0) {
      missingData.push({ order: o, missing });
    }
  }
  if (missingData.length > 0) {
    const shown = missingData.slice(0, 5);
    const extra = missingData.length - shown.length;
    catBuckets.missing.push({
      sortOrder: 3.5,
      render: (
        <AlertCard emoji="📋" title="Missing Order Data" severity="info">
          {missingData.length} order(s) have incomplete data:
          <ul className="mt-1 space-y-0.5 list-none pl-0">
            {shown.map((item, i) => (
              <li key={i}>
                • <OrderRef fpr={item.order.fpr} name={`Prio ${displayPrio(item.order.priority_seq)}`} orderId={item.order.id} onScrollToOrder={onScrollToOrder} />{' '}
                — Missing: {item.missing.join(', ')}
              </li>
            ))}
          </ul>
          {extra > 0 && <p className="mt-1 text-[11px] text-gray-400">...and {extra} more order(s) with missing data.</p>}
        </AlertCard>
      ),
    });
  }

  // D — Orders On Hold Too Long
  const holdOrders = active.filter(o => o.status === 'hold');
  for (const o of holdOrders) {
    const holdSince = o.updated_date ? new Date(o.updated_date) : null;
    if (!holdSince) continue;
    const holdHours = hoursDiff(now, holdSince);
    if (holdHours < 24) continue;
    const holdDays = Math.floor(holdHours / 24);
    const desc = (o.item_description || '').substring(0, 35);
    let severity = 'warning';
    let emoji = '🟡';
    if (holdHours >= 72) { severity = 'critical'; emoji = '🔴'; }
    else if (holdHours >= 48) { severity = 'urgent'; emoji = '🟠'; }

    catBuckets.hold.push({
      sortOrder: severity === 'critical' ? 0.7 : severity === 'urgent' ? 1.5 : 2.5,
      render: (
        <AlertCard emoji={`${emoji} ⏸️`} title="Order On Hold" severity={severity}>
          <OrderRef fpr={o.fpr} name={desc} orderId={o.id} onScrollToOrder={onScrollToOrder} />{' '}
          has been on Hold for {holdDays} day(s) (since {fmtDate(holdSince)}).
          This may be blocking downstream orders. Consider resolving the hold.
        </AlertCard>
      ),
    });
  }

  // N10D — Stock level upload reminder
  const hasN10DMap = Object.keys(inferredTargetMap).length > 0;
  const lastN10D = lastN10DUploadDate ? new Date(lastN10DUploadDate) : null;
  const n10dDaysAgo = lastN10D ? daysDiff(now, lastN10D) : null;
  if (n10dDaysAgo === null || n10dDaysAgo >= 1) {
    let title, msg, severity, sortOrder;
    if (n10dDaysAgo === null) {
      title = 'Enable Stock-Based Prioritization';
      msg = 'Upload a Next 10 Days stock level file to help the AI prioritize prio replenish and safety stock orders based on warehouse demand forecasts.';
      severity = 'info';
      sortOrder = 2.3;
    } else if (n10dDaysAgo >= 2) {
      title = 'Stock Data Outdated';
      msg = `Next 10 Days data was last uploaded ${n10dDaysAgo} day${n10dDaysAgo !== 1 ? 's' : ''} ago (${fmtDate(lastN10D)}). Production priorities may be inaccurate. Please upload today's file.`;
      severity = 'warning';
      sortOrder = 2.4;
    } else {
      title = 'Next 10 Days Update';
      msg = `Last stock level upload was yesterday (${fmtDate(lastN10D)}). Upload today's file for accurate production prioritization.`;
      severity = 'info';
      sortOrder = 3.0;
    }
    catBuckets.n10d.push({
      sortOrder,
      render: (
        <AlertCard emoji="📊" title={title} severity={severity}>
          {msg}
          {onNavigateToN10D && (
            <div className="mt-2">
              <button
                onClick={onNavigateToN10D}
                style={{ background: 'transparent', border: '1px solid #fd5108', color: '#fd5108', borderRadius: 5, padding: '3px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 500 }}
                data-testid="button-navigate-n10d-alert"
              >
                Upload Next 10 Days
              </button>
            </div>
          )}
        </AlertCard>
      ),
    });
  }

  // N10D — Critical stock alerts: active non-dated orders with soon inferred targets
  if (hasN10DMap) {
    const nonDatedActive = active.filter(o => !parseDate(o.target_avail_date));
    for (const o of nonDatedActive) {
      const inf = inferredTargetMap[o.material_code];
      if (!inf || inf.status === 'Sufficient' || !inf.targetDate) continue;
      const targetD = parseDate(inf.targetDate);
      if (!targetD) continue;
      const daysLeft = daysDiff(targetD, now);
      if (daysLeft > 5) continue;
      const desc = (o.item_description || '').substring(0, 35);
      const prio = displayPrio(o.priority_seq);
      let severity = 'info';
      let emoji = '🟡';
      let sortOrder = 3.0;
      if (daysLeft <= 0) { severity = 'critical'; emoji = '🔴'; sortOrder = 0.5; }
      else if (daysLeft <= 2) { severity = 'urgent'; emoji = '🟠'; sortOrder = 1.0; }
      else if (daysLeft <= 5) { severity = 'warning'; emoji = '🟡'; sortOrder = 2.0; }
      catBuckets.n10d.push({
        sortOrder,
        render: (
          <AlertCard emoji={`${emoji} 📦`} title="Stock Running Low" severity={severity}>
            <OrderRef fpr={o.fpr} name={desc} orderId={o.id} onScrollToOrder={onScrollToOrder} />{' '}
            (Prio {prio}) has inferred target {fmtDate(targetD)}{' '}
            {daysLeft <= 0 ? '— target has passed!' : `— ${daysLeft} day(s) away.`}{' '}
            This order has no avail date set. Consider prioritizing it.
          </AlertCard>
        ),
      });
    }
  }

  // Flatten all alerts, tag with category, sort by severity, then cap per-category to ensure diversity
  const catOrder = ['n10d', 'deadline', 'sap', 'missing', 'hold', 'overdue'];
  const allAlerts = [];
  for (const cat of catOrder) {
    for (const item of catBuckets[cat]) {
      allAlerts.push({ ...item, _cat: cat });
    }
  }
  allAlerts.sort((a, b) => a.sortOrder - b.sortOrder);

  const result = [];
  const catCounts = {};
  const maxPerCat = 2;
  for (const item of allAlerts) {
    if (result.length >= 5) break;
    catCounts[item._cat] = (catCounts[item._cat] || 0);
    if (catCounts[item._cat] >= maxPerCat) continue;
    catCounts[item._cat]++;
    result.push(item);
  }
  return result;
}

function readLS(key, fallback) {
  try { const v = localStorage.getItem(key); return v !== null ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function writeLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function alertSeverityDot(alerts) {
  const hasCritical = alerts.some(a => a.sortOrder < 1);
  const hasUrgent = alerts.some(a => a.sortOrder >= 1 && a.sortOrder < 2);
  const hasWarning = alerts.some(a => a.sortOrder >= 2 && a.sortOrder < 4);
  if (alerts.length === 0) return '✅';
  if (hasCritical) return '🔴';
  if (hasUrgent) return '🟠';
  if (hasWarning) return '🟡';
  return '🔵';
}

export default function InsightAlertsPanel({ orders, lastUploadDate, lastN10DUploadDate = null, inferredTargetMap = {}, onUpload, onScrollToOrder, onAutoSequence = null, onNavigateToN10D = null, feedmill = null, line = 'all' }) {
  const [tickState, setTickState] = useState(0);
  const timerRef = useRef(null);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);

  useEffect(() => {
    timerRef.current = setInterval(() => setTickState(t => t + 1), 5 * 60 * 1000);
    return () => clearInterval(timerRef.current);
  }, []);

  const insights = useMemo(() => computeInsights(orders, onScrollToOrder, inferredTargetMap, onAutoSequence), [orders, onScrollToOrder, inferredTargetMap, onAutoSequence, tickState]);
  const alerts = useMemo(() => computeAlerts(orders, lastUploadDate, onUpload, onScrollToOrder, inferredTargetMap, lastN10DUploadDate, onNavigateToN10D), [orders, lastUploadDate, lastN10DUploadDate, inferredTargetMap, onUpload, onScrollToOrder, onNavigateToN10D, tickState]);

  function toggleInsights() {
    setInsightsOpen(v => { const next = !v; writeLS('nexfeed_insights_open', next); return next; });
  }
  function toggleAlerts() {
    setAlertsOpen(v => { const next = !v; writeLS('nexfeed_alerts_open', next); return next; });
  }

  const insightCount = insights.length;
  const insightCountLabel = insightCount === 0 ? 'No insights' : insightCount === 1 ? '1 insight' : `${insightCount} insights`;
  const alertCount = alerts.length;
  const alertCountLabel = alertCount === 0 ? 'No alerts' : alertCount === 1 ? '1 alert' : `${alertCount} alerts`;
  const alertDot = alertSeverityDot(alerts);

  return (
    <>
      <style>{`
        @keyframes highlightFlash {
          0% { background-color: #fef9c3; }
          100% { background-color: transparent; }
        }
        tr.highlight-flash {
          animation: highlightFlash 2s ease-out forwards;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .panel-body-collapse {
          display: grid;
          grid-template-rows: 1fr;
          transition: grid-template-rows 250ms ease-in-out, opacity 250ms ease-in-out;
          opacity: 1;
        }
        .panel-body-collapse.collapsed {
          grid-template-rows: 0fr;
          opacity: 0;
        }
        .panel-body-inner {
          overflow: hidden;
        }
        .chevron-icon {
          transition: transform 250ms ease-in-out;
          flex-shrink: 0;
        }
        .chevron-icon.open {
          transform: rotate(180deg);
        }
      `}</style>
      <div className="flex flex-col md:flex-row gap-4" data-testid="section-insight-alerts">
        {/* Panel 1 — Production Insights */}
        <div
          className="flex-1 overflow-hidden"
          style={{ border: '1px solid #e5e7eb', borderRadius: 8 }}
          data-testid="panel-production-insights"
          data-tour="orders-insights"
        >
          <button
            type="button"
            onClick={toggleInsights}
            className="w-full flex items-center justify-between cursor-pointer"
            style={{
              background: '#fff',
              padding: '10px 16px',
              borderBottom: insightsOpen ? '1px solid #e5e7eb' : 'none',
              transition: 'background-color 150ms ease',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#f9fafb'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
            data-testid="button-toggle-insights"
            aria-expanded={insightsOpen}
          >
            <span style={{ fontWeight: 500, fontSize: 13, color: '#374151' }}>
              🧠 Production Insights
              {!insightsOpen && (
                <span style={{ fontWeight: 400, fontSize: 12, color: '#9ca3af', marginLeft: 6 }}>({insightCountLabel})</span>
              )}
            </span>
            <svg
              className={`chevron-icon ${insightsOpen ? 'open' : ''}`}
              style={{ width: 14, height: 14, color: '#9ca3af', flexShrink: 0 }}
              viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"
            >
              <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.085l3.71-3.755a.75.75 0 111.08 1.04l-4.25 4.3a.75.75 0 01-1.08 0l-4.25-4.3a.75.75 0 01.02-1.06z" clipRule="evenodd" />
            </svg>
          </button>
          <div className={`panel-body-collapse${insightsOpen ? '' : ' collapsed'}`}>
            <div className="panel-body-inner">
              <div style={{ background: '#fafafa', padding: 12, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 400, overflowY: 'auto', borderRadius: '0 0 8px 8px' }}>
                <AISummaryCard
                  type="production_insights"
                  orders={orders}
                  feedmill={feedmill}
                  line={line}
                  inferredTargetMap={inferredTargetMap}
                  isOpen={insightsOpen}
                />
                {insightCount === 0 ? (
                  <p style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', padding: '8px 0' }} data-testid="text-no-insights">
                    ✅ No suggestions right now.
                  </p>
                ) : (
                  insights.map((item, i) => <div key={i}>{item.render}</div>)
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Panel 2 — Alerts & Reminders */}
        <div
          className="flex-1 overflow-hidden"
          style={{ border: '1px solid #e5e7eb', borderRadius: 8 }}
          data-testid="panel-alerts-reminders"
          data-tour="orders-alerts"
        >
          <button
            type="button"
            onClick={toggleAlerts}
            className="w-full flex items-center justify-between cursor-pointer"
            style={{
              background: '#fff',
              padding: '10px 16px',
              borderBottom: alertsOpen ? '1px solid #e5e7eb' : 'none',
              transition: 'background-color 150ms ease',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#f9fafb'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
            data-testid="button-toggle-alerts"
            aria-expanded={alertsOpen}
          >
            <span style={{ fontWeight: 500, fontSize: 13, color: '#374151' }}>
              🔔 Alerts & Reminders
              {!alertsOpen && (
                <span style={{ fontWeight: 400, fontSize: 12, color: '#9ca3af', marginLeft: 6 }}>
                  {alertDot} ({alertCountLabel})
                </span>
              )}
            </span>
            <svg
              className={`chevron-icon ${alertsOpen ? 'open' : ''}`}
              style={{ width: 14, height: 14, color: '#9ca3af', flexShrink: 0 }}
              viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"
            >
              <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.085l3.71-3.755a.75.75 0 111.08 1.04l-4.25 4.3a.75.75 0 01-1.08 0l-4.25-4.3a.75.75 0 01.02-1.06z" clipRule="evenodd" />
            </svg>
          </button>
          <div className={`panel-body-collapse${alertsOpen ? '' : ' collapsed'}`}>
            <div className="panel-body-inner">
              <div style={{ background: '#fafafa', padding: 12, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 400, overflowY: 'auto', borderRadius: '0 0 8px 8px' }}>
                <AISummaryCard
                  type="alerts_reminders"
                  orders={orders}
                  feedmill={feedmill}
                  line={line}
                  inferredTargetMap={inferredTargetMap}
                  isOpen={alertsOpen}
                />
                {alertCount === 0 ? (
                  <p style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', padding: '8px 0' }} data-testid="text-no-alerts">
                    ✅ No alerts right now.
                  </p>
                ) : (
                  alerts.map((item, i) => <div key={i}>{item.render}</div>)
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
