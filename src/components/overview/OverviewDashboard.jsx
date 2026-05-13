import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  ClipboardList, AlertTriangle, CheckCircle2,
  Activity, Loader2, FileText
} from 'lucide-react';
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { generateReportInsight, generateShutdownAnalysis } from '@/services/azureAI';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

// ─── Capacity map (MT/hr) ────────────────────────────────────────────────────
const CAPACITY_MAP = {
  'FM1': { total: 40, lines: { 'Line 1': 20, 'Line 2': 20 } },
  'FM2': { total: 20, lines: { 'Line 3': 10, 'Line 4': 10 } },
  'FM3': { total: 20, lines: { 'Line 6': 10, 'Line 7': 10 } },
  'PMX': { total: 20, lines: { 'Line 5': 10 } },
};

// ─── Feedmill mapping ─────────────────────────────────────────────────────────
const FEEDMILL_LINES = {
  'FM1': ['Line 1', 'Line 2'],
  'FM2': ['Line 3', 'Line 4'],
  'FM3': ['Line 6', 'Line 7'],
  'PMX': ['Line 5'],
};

// ─── Status category + segment config ────────────────────────────────────────
function getStatusCategory(status) {
  if (!status) return 'scheduled';
  const s = status.toLowerCase().replace(/[\s-]/g, '_');
  if (s === 'done' || s === 'completed') return 'completed';
  if (
    s === 'in_production' || s === 'ongoing_batching' || s === 'ongoing_pelleting' ||
    s === 'ongoing_bagging' || s.startsWith('on_going')
  ) return 'in_progress';
  if (s === 'hold') return 'on_hold';
  if (s === 'cancel_po' || s === 'cut') return 'cancelled';
  return 'scheduled';
}

// Order: Completed → In Progress → On Hold → Cancelled → Scheduled (rightmost base)
const STATUS_SEGMENTS = [
  { key: 'completed',   color: '#4ade80', textColor: '#ffffff', label: 'Completed',   pdfLabel: 'Completed' },
  { key: 'in_progress', color: '#fb923c', textColor: '#ffffff', label: 'In Progress', pdfLabel: 'In Progress' },
  { key: 'on_hold',     color: '#9ca3af', textColor: '#ffffff', label: 'On Hold',     pdfLabel: 'On Hold' },
  { key: 'cancelled',   color: '#f87171', textColor: '#ffffff', label: 'Cancelled',   pdfLabel: 'Cancelled' },
  { key: 'scheduled',   color: '#e5e7eb', textColor: '#374151', label: 'Scheduled',   pdfLabel: 'Scheduled' },
];

const STATUS_DOT_COLORS = Object.fromEntries(
  STATUS_SEGMENTS.map(s => [s.pdfLabel, s.color])
);

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

// ─── Date / volume helpers ────────────────────────────────────────────────────
function getOrderDate(order) {
  const avail = order.target_avail_date || order.avail_date;
  if (avail && avail !== '' && avail !== 'prio replenish' && avail !== 'safety stocks') {
    const d = new Date(avail);
    if (!isNaN(d)) return d;
  }
  if (order.start_date) {
    const d = new Date(order.start_date);
    if (!isNaN(d)) return d;
  }
  if (order.fpr && order.fpr.length >= 6) {
    return new Date(
      2000 + parseInt(order.fpr.substring(0, 2)),
      parseInt(order.fpr.substring(2, 4)) - 1,
      parseInt(order.fpr.substring(4, 6))
    );
  }
  return null;
}

// Mirrors getEffectiveVolume() from OrderTable.jsx so overview totals always
// match the bold volume displayed in the order table:
//   1. volume_override (user-set) takes priority
//   2. ceil(total_volume_mt / batch_size) * batch_size  (app-suggested ceiling)
//   3. raw total_volume_mt / volume as final fallback
function getVolume(order) {
  if (order.volume_override != null && order.volume_override !== "") {
    const ov = parseFloat(order.volume_override);
    if (!isNaN(ov)) return ov;
  }
  const raw = parseFloat(order.total_volume_mt || order.volume || 0) || 0;
  const bs = parseFloat(order.batch_size || 0) || 0;
  return bs > 0 ? Math.ceil(raw / bs) * bs : raw;
}

// ─── Rolling 12-month list ────────────────────────────────────────────────────
function getRollingMonths() {
  const now = new Date();
  const months = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      label: d.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
      month: d.getMonth(),
      year:  d.getFullYear(),
    });
  }
  return months;
}

// ─── Helper: is this order inactive (Done or Cancelled)? ─────────────────────
function isInactiveOrder(order) {
  const s = (order.status || '').toLowerCase().replace(/[\s-]/g, '_');
  return s === 'done' || s === 'completed' || s === 'cancel_po';
}

// ─── Breakdown calculation ────────────────────────────────────────────────────
// Bar chart proportions are month-scoped (historical view).
// Volume totals and hasData use ALL active orders across all months so no
// active order is hidden just because it falls outside the selected month.
function calculateBreakdown(orders, month, year) {
  const monthOrders = orders.filter(o => {
    const d = getOrderDate(o);
    return d && d.getMonth() === month && d.getFullYear() === year;
  });

  const CATS = STATUS_SEGMENTS.map(s => s.key);
  const result = {};

  // Helper: build a StackedBar-compatible breakdown object from an order list
  const buildBreakdown = (orderList) => {
    const bd = Object.fromEntries(CATS.map(c => [c, 0]));
    bd.grandTotal = 0;
    orderList.forEach(o => {
      const cat = getStatusCategory(o.status);
      const vol = getVolume(o);
      bd[cat] += vol;
      bd.grandTotal += vol;
    });
    CATS.forEach(c => {
      bd[`${c}_pct`] = bd.grandTotal > 0
        ? Math.round((bd[c] / bd.grandTotal) * 100) : 0;
    });
    return bd;
  };

  Object.entries(FEEDMILL_LINES).forEach(([fm, lines]) => {
    // Month-scoped orders — used for bar chart proportions only
    const fmMonthOrders = monthOrders.filter(o => lines.includes(o.feedmill_line || o.line));

    // ALL active orders across every month — used for totals and hasData
    const fmAllActive = orders.filter(o =>
      lines.includes(o.feedmill_line || o.line) && !isInactiveOrder(o)
    );

    const fmData = buildBreakdown(fmMonthOrders);

    // Active total = all active orders regardless of date
    fmData.total = fmAllActive.reduce((sum, o) => sum + getVolume(o), 0);

    // Fallback breakdown from all-active orders (shown when grandTotal === 0)
    fmData.activeBreakdown = buildBreakdown(fmAllActive);

    const lineBreakdowns = {};
    lines.forEach(line => {
      const lineMonthOrders = fmMonthOrders.filter(o => (o.feedmill_line || o.line) === line);
      const lineAllActive   = fmAllActive.filter(o => (o.feedmill_line || o.line) === line);

      const ld = buildBreakdown(lineMonthOrders);
      ld.total = lineAllActive.reduce((sum, o) => sum + getVolume(o), 0);

      // Fallback breakdown from all-active orders (shown when grandTotal === 0)
      ld.activeBreakdown = buildBreakdown(lineAllActive);

      lineBreakdowns[line] = ld;
    });

    result[fm] = { ...fmData, lines: lineBreakdowns };
  });

  return { breakdown: result, monthOrders };
}

// ─── StackedBar ───────────────────────────────────────────────────────────────
function StackedBar({ data, height = 24, borderRadius = 6 }) {
  return (
    <div style={{ display: 'flex', width: '100%', height: `${height}px`, borderRadius: `${borderRadius}px`, overflow: 'hidden' }}>
      {STATUS_SEGMENTS.map(seg => {
        const pct = data[`${seg.key}_pct`] || 0;
        if (pct === 0) return null;
        return (
          <div
            key={seg.key}
            title={`${seg.label}: ${(data[seg.key] || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} MT (${pct}%)`}
            style={{
              width: `${pct}%`, minWidth: '2px', backgroundColor: seg.color,
              display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default',
            }}
          >
            {pct >= 8 && (
              <span style={{ fontSize: '9px', fontWeight: 600, color: seg.textColor, whiteSpace: 'nowrap' }}>
                {pct}%
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── AI Insight text renderer ─────────────────────────────────────────────────
const HEADING_EMOJIS = ['📊', '⚖', '📈', '⚠', '💡'];

function InsightText({ text }) {
  if (!text) return null;
  const lines = text.split('\n');
  const blocks = [];
  let key = 0;
  let firstHeading = false;

  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const isHeading = HEADING_EMOJIS.some(e => trimmed.startsWith(e));
    const isBullet = trimmed.startsWith('- ');

    if (isHeading) {
      if (firstHeading) {
        blocks.push(<div key={`sep-${key++}`} style={{ borderTop: '1px dashed #e5e7eb', margin: '10px 0' }} />);
      }
      firstHeading = true;
      blocks.push(
        <div key={key++} style={{ fontSize: '11px', fontWeight: 700, color: '#1a1a1a', marginBottom: '4px' }}>
          {trimmed}
        </div>
      );
    } else if (isBullet) {
      blocks.push(
        <div key={key++} style={{ fontSize: '11px', color: '#4b5563', lineHeight: 1.7, paddingLeft: '8px' }}>
          {trimmed}
        </div>
      );
    } else {
      blocks.push(
        <div key={key++} style={{ fontSize: '11px', color: '#4b5563', lineHeight: 1.7 }}>
          {trimmed}
        </div>
      );
    }
  });

  return <>{blocks}</>;
}

// ─── Shutdown Dialog helpers ───────────────────────────────────────────────────
const SD_LINE_RATE_KEYS = {
  'Line 1': 'line_1_run_rate', 'Line 2': 'line_2_run_rate', 'Line 3': 'line_3_run_rate',
  'Line 4': 'line_4_run_rate', 'Line 5': 'line_5_run_rate', 'Line 6': 'line_6_run_rate',
  'Line 7': 'line_7_run_rate',
};
const SD_LINE_TO_FM = {};
Object.entries(FEEDMILL_LINES).forEach(([fm, ls]) => ls.forEach(l => { SD_LINE_TO_FM[l] = fm; }));

function sdFindKb(order, kbRecords) {
  if (!kbRecords || !kbRecords.length) return null;
  const code = String(order.material_code_fg || order.material_code || '').trim().replace(/^0+/, '');
  return kbRecords.find(p => {
    const kc = String(p.fg_material_code || p.material_code_fg || '').trim().replace(/^0+/, '');
    return kc && code && kc === code;
  }) || null;
}

function ShutdownAnalysisDisplay({ analysis }) {
  if (!analysis) return null;
  const lines = analysis.split('\n').filter(l => l.trim());
  return (
    <div className="shutdown-analysis-content">
      {lines.map((line, index) => {
        const trimmed = line.trim();

        if (trimmed.startsWith('•') || trimmed.startsWith('-')) {
          const text = trimmed.replace(/^[•\-]\s*/, '');
          const dashSplit = text.split('—');
          if (dashSplit.length >= 2) {
            const productName = dashSplit[0].trim();
            const details = dashSplit.slice(1).join('—').trim();
            const dl = details.toLowerCase();
            let statusClass = '';
            if (dl.includes('critical')) statusClass = 'shutdown-order-critical';
            else if (dl.includes('urgent')) statusClass = 'shutdown-order-urgent';
            else if (dl.includes('monitor')) statusClass = 'shutdown-order-monitor';
            else if (dl.includes('sufficient')) statusClass = 'shutdown-order-sufficient';
            return (
              <div key={index} className={`shutdown-order-card ${statusClass}`}>
                <div className="shutdown-order-name">{productName}</div>
                <div className="shutdown-order-details">{details}</div>
              </div>
            );
          }
          return (
            <div key={index} className="shutdown-analysis-bullet">
              <span className="shutdown-bullet-dot">•</span>
              <span className="shutdown-bullet-text">{text}</span>
            </div>
          );
        }

        const lc = trimmed.toLowerCase();
        if (lc.startsWith('capacity note') || lc.startsWith('partner line capacity') || lc.startsWith('total impact')) {
          return (
            <div key={index} className="shutdown-analysis-note">{trimmed}</div>
          );
        }

        if (trimmed.endsWith(':') && trimmed.length < 60) {
          return (
            <div key={index} className="shutdown-analysis-subheader">{trimmed}</div>
          );
        }

        return (
          <p key={index} className="shutdown-analysis-paragraph">{trimmed}</p>
        );
      })}
    </div>
  );
}

// ─── Shutdown Dialog (AI-powered) ─────────────────────────────────────────────
const SHUTDOWN_REASONS = [
  'Scheduled maintenance',
  'Equipment breakdown',
  'Natural disaster',
  'Power outage',
  'Supply shortage',
  'Staff shortage',
  'Quality issue',
  'Regulatory compliance',
  'Other',
];

const FM_DISPLAY_MAP = { FM1: 'Feedmill 1', FM2: 'Feedmill 2', FM3: 'Feedmill 3', PMX: 'Powermix' };

function ShutdownDialogAI({ target, targetType, feedmill, fmLines = [], orders = [], lineShutdowns = {}, kbRecords = [], inferredTargetMap = {}, onConfirm, onClose }) {
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(true);
  const [refreshCount, setRefreshCount] = useState(0);

  const affectedLines = targetType === 'feedmill' ? fmLines : [target];
  const allShutdownLines = [
    ...affectedLines,
    ...Object.entries(lineShutdowns).filter(([, info]) => info.isShutdown).map(([l]) => l),
  ];
  const uniqueShutdownLines = [...new Set(allShutdownLines)];
  const partnerLines = fmLines.filter(l => !affectedLines.includes(l) && !uniqueShutdownLines.includes(l));
  const allLineKeys = Object.keys(SD_LINE_TO_FM);
  const outsideAvailableLines = allLineKeys.filter(l => !fmLines.includes(l) && !uniqueShutdownLines.includes(l));

  const affectedOrders = orders.filter(o => {
    const ol = o.feedmill_line || o.line || '';
    return affectedLines.includes(ol) && !['done', 'completed', 'cancel_po', 'cancelled'].includes((o.status || '').toLowerCase());
  });
  const totalVolume = affectedOrders.reduce((s, o) => s + getVolume(o), 0);

  useEffect(() => {
    async function runAnalysis() {
      setIsAnalyzing(true);
      try {
        // Build partner line load
        const partnerLineLoad = {};
        const partnerLineVolume = {};
        partnerLines.forEach(pl => {
          const plOrders = orders.filter(o => (o.feedmill_line || o.line) === pl && !['done', 'completed', 'cancel_po', 'cancelled'].includes((o.status || '').toLowerCase()));
          partnerLineLoad[pl] = plOrders.length;
          partnerLineVolume[pl] = plOrders.reduce((s, o) => s + getVolume(o), 0).toFixed(0);
        });

        // Build outside line load
        const outsideLineLoad = {};
        const outsideLineVolume = {};
        outsideAvailableLines.forEach(ol => {
          const olOrders = orders.filter(o => (o.feedmill_line || o.line) === ol && !['done', 'completed', 'cancel_po', 'cancelled'].includes((o.status || '').toLowerCase()));
          outsideLineLoad[ol] = olOrders.length;
          outsideLineVolume[ol] = olOrders.reduce((s, o) => s + getVolume(o), 0).toFixed(0);
        });

        // Enrich affected orders
        const enrichedOrders = affectedOrders.map(o => {
          const kb = sdFindKb(o, kbRecords);
          const lineRateMap = {};
          if (kb) {
            Object.entries(SD_LINE_RATE_KEYS).forEach(([line, key]) => {
              lineRateMap[line] = parseFloat(kb[key]) || 0;
            });
          }
          const outsideLines = outsideAvailableLines.filter(l => lineRateMap[l] > 0).map(l => `${l} (rate: ${lineRateMap[l]} MT/hr)`);
          const canDivertOutside = outsideLines.length > 0;
          const canDivertWithin = partnerLines.length > 0;

          const inf = inferredTargetMap[o.material_code_fg || o.material_code] || null;
          const volume = getVolume(o);
          const runRate = parseFloat(o.run_rate) || (kb ? parseFloat(kb[SD_LINE_RATE_KEYS[o.feedmill_line || o.line]] || 0) : 0);
          const productionHours = runRate > 0 ? (volume / runRate).toFixed(2) : '0.00';

          return {
            prio: o.priority_seq || o.prio || '—',
            name: o.item_description || o.item || '—',
            fpr: o.fpr || null,
            volume,
            form: o.form || '',
            status: o.status || '',
            availDate: o.target_avail_date || o.avail_date || null,
            n10dStatus: inf ? inf.status : null,
            dfl: inf ? inf.dueForLoading : null,
            inventory: inf ? inf.inventory : null,
            runRate,
            productionHours,
            canDivertWithin,
            canDivertOutside,
            partnerLines,
            outsideLines,
          };
        });

        // Sort: Critical → Urgent → Monitor → Sufficient → null
        const statusOrder = { Critical: 0, Urgent: 1, Monitor: 2, Sufficient: 3 };
        enrichedOrders.sort((a, b) => {
          const ao = statusOrder[a.n10dStatus] ?? 4;
          const bo = statusOrder[b.n10dStatus] ?? 4;
          return ao !== bo ? ao - bo : (a.prio || 999) - (b.prio || 999);
        });

        const totalProductionHours = enrichedOrders.reduce((s, o) => s + (parseFloat(o.productionHours) || 0), 0).toFixed(1);

        const result = await generateShutdownAnalysis({
          target, feedmill,
          affectedOrders: enrichedOrders,
          totalVolume: totalVolume.toFixed(0),
          totalProductionHours,
          partnerLines,
          partnerLineLoad,
          partnerLineVolume,
          outsideAvailableLines,
          outsideLineLoad,
          outsideLineVolume,
        });
        setAnalysis(result.analysis);
      } catch {
        setAnalysis('Unable to generate analysis. You can still proceed with the shutdown.');
      } finally {
        setIsAnalyzing(false);
      }
    }
    runAnalysis();
  }, [refreshCount]);

  const canSubmit = reason !== '' && !isAnalyzing;

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 10001, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div style={{ background: 'var(--color-bg-secondary)', borderRadius: '12px', width: '560px', maxWidth: '100%', maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 8px 30px rgba(0,0,0,0.22)' }}>

        {/* Header — fixed */}
        <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '16px', fontWeight: 700, color: '#dc2626' }}>
            <span style={{ fontSize: '20px' }}>⏻</span>
            <span>Shutdown {target}</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '18px', color: '#9ca3af', cursor: 'pointer' }}>✕</button>
        </div>

        {/* Summary — fixed */}
        <div style={{ flexShrink: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', padding: '16px 20px', background: 'var(--color-bg-tertiary)', borderBottom: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span style={{ fontSize: '10px', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.3px' }}>Affected Lines</span>
            <span style={{ fontSize: '14px', fontWeight: 700, color: '#1a1a1a' }}>{affectedLines.join(', ')}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span style={{ fontSize: '10px', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.3px' }}>Active Orders</span>
            <span style={{ fontSize: '14px', fontWeight: 700, color: '#1a1a1a' }}>{affectedOrders.length}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span style={{ fontSize: '10px', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.3px' }}>Total Volume</span>
            <span style={{ fontSize: '14px', fontWeight: 700, color: '#1a1a1a' }}>{totalVolume.toFixed(0)} MT</span>
          </div>
          {partnerLines.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontSize: '10px', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.3px' }}>Available Lines</span>
              <span style={{ fontSize: '14px', fontWeight: 700, color: '#16a34a' }}>{partnerLines.join(', ')}</span>
            </div>
          )}
        </div>

        {/* AI Analysis — header fixed, body scrollable */}
        <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px', background: '#fff7ed', borderBottom: '1px solid #fed7aa', fontSize: '12px', fontWeight: 600, color: '#92400e' }}>
          <span>✨ Impact Analysis</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {isAnalyzing ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 400, color: '#c2410c' }}>
                <Loader2 size={11} className="animate-spin" /> Analyzing...
              </span>
            ) : (
              <button
                onClick={() => setRefreshCount(c => c + 1)}
                data-testid="button-refresh-shutdown-analysis"
                style={{ fontSize: '12px', fontWeight: 400, color: '#92400e', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', padding: '2px 4px', borderRadius: '4px' }}
                onMouseEnter={e => { e.currentTarget.style.color = '#78350f'; }}
                onMouseLeave={e => { e.currentTarget.style.color = '#92400e'; }}
              >
                ↻ Refresh
              </button>
            )}
          </div>
        </div>
        <div className="shutdown-analysis-scroll">
          {isAnalyzing && !analysis ? (
            <span style={{ fontSize: '12px', color: '#9ca3af', fontStyle: 'italic' }}>
              Analyzing impact on orders and identifying diversion opportunities...
            </span>
          ) : analysis ? (
            <ShutdownAnalysisDisplay analysis={analysis} />
          ) : null}
        </div>

        {/* No partner lines notice — fixed */}
        {!isAnalyzing && partnerLines.length === 0 && (
          <div style={{ flexShrink: 0, padding: '10px 20px', fontSize: '12px', color: '#6b7280', background: 'var(--color-bg-tertiary)', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>ℹ</span>
            No other lines available in {FM_DISPLAY_MAP[feedmill] || feedmill} for diversion. Orders will remain on the shutdown line until resumed.
          </div>
        )}

        {/* Form — fixed */}
        <div style={{ flexShrink: 0, padding: '16px 20px', borderBottom: '1px solid var(--color-border)' }}>
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#374151', marginBottom: '6px' }}>
              Reason for Shutdown <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <select
              value={reason}
              onChange={e => setReason(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', fontSize: '13px', border: '1px solid #d1d5db', borderRadius: '6px', outline: 'none', background: 'var(--color-bg-secondary)', boxSizing: 'border-box' }}
            >
              <option value="">Select reason...</option>
              {SHUTDOWN_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#374151', marginBottom: '6px' }}>Notes (optional)</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Add any additional details about this shutdown..."
              rows={3}
              style={{ width: '100%', padding: '8px 12px', fontSize: '13px', border: '1px solid #d1d5db', borderRadius: '6px', outline: 'none', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }}
            />
          </div>
        </div>

        {/* Footer — fixed */}
        <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '14px 20px' }}>
          <button onClick={onClose} style={{ padding: '8px 20px', fontSize: '13px', fontWeight: 500, color: '#6b7280', background: 'var(--color-bg-secondary)', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer' }}>
            Cancel
          </button>
          <button
            onClick={() => canSubmit && onConfirm({ reason, notes, timestamp: new Date().toISOString() })}
            disabled={!canSubmit}
            style={{ padding: '8px 20px', fontSize: '13px', fontWeight: 600, color: canSubmit ? '#fff' : '#d1d5db', background: canSubmit ? '#dc2626' : '#f3f4f6', border: 'none', borderRadius: '6px', cursor: canSubmit ? 'pointer' : 'not-allowed' }}
          >
            Confirm Shutdown
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── FeedmillCard ─────────────────────────────────────────────────────────────
function FeedmillCard({ fm, lines, data, fmStatus = {}, onStatusChange, lineShutdowns = {}, onShutdownLine, onResumeLine, onShutdownFeedmill, onResumeFeedmill, orders = [], kbRecords = [], inferredTargetMap = {} }) {
  const [expanded, setExpanded] = useState(false);
  const [activeShutdown, setActiveShutdown] = useState(null); // { target, targetType }
  const [resumeConfirm, setResumeConfirm] = useState(null); // { type: 'line'|'feedmill', line?, displayName }
  const fmData = data[fm];
  const hasData = fmData && fmData.total > 0;
  const maxCat = hasData ? Math.max(...STATUS_SEGMENTS.map(s => fmData[s.key] || 0)) : 0;
  const isFeedmillShutdown = lines.every(l => lineShutdowns[l]?.isShutdown);

  const FM_DISPLAY = FM_DISPLAY_MAP;

  return (
    <>
      <div style={{ background: 'var(--color-bg-secondary)', border: `1px solid ${isFeedmillShutdown ? '#fca5a5' : '#e5e7eb'}`, borderRadius: '8px', overflow: 'hidden', boxShadow: isFeedmillShutdown ? '0 0 0 2px rgba(220,38,38,0.1)' : 'none' }}>
        {/* Feedmill-level shutdown banner */}
        {isFeedmillShutdown && (
          <div style={{ background: '#fef2f2', borderBottom: '1px solid #fca5a5', padding: '6px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '11px' }}>⛔</span>
              <span style={{ fontSize: '11px', fontWeight: 600, color: '#b91c1c' }}>SHUTDOWN</span>
              {lines[0] && lineShutdowns[lines[0]]?.since && (
                <span style={{ fontSize: '10px', color: '#ef4444' }}>
                  since {new Date(lineShutdowns[lines[0]].since).toLocaleDateString()}
                </span>
              )}
            </div>
            <button
              onClick={() => setResumeConfirm({ type: 'feedmill', displayName: FM_DISPLAY[fm] || fm })}
              style={{ fontSize: '10px', color: '#16a34a', fontWeight: 600, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '4px', padding: '2px 8px', cursor: 'pointer' }}
              data-testid={`button-resume-all-${fm.toLowerCase()}`}
            >▶ Resume All</button>
          </div>
        )}

        <div
          style={{ background: 'var(--color-bg-secondary)', padding: '12px 16px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}
          onClick={() => setExpanded(e => !e)}
          data-testid={`card-fm-${fm.toLowerCase()}`}
        >
          <span style={{ fontSize: '13px', fontWeight: 700, color: isFeedmillShutdown ? '#b91c1c' : '#1a1a1a' }}>{FM_DISPLAY[fm] || fm}</span>
          <span style={{ fontSize: '10px', color: '#6b7280' }}>{expanded ? '▼' : '▶'}</span>
        </div>

        <div style={{ padding: '12px 16px' }}>
          {!hasData ? (
            <>
              <p style={{ fontSize: '11px', color: '#9ca3af', fontStyle: 'italic', textAlign: 'center', padding: '16px 0' }}>
                No active orders.
              </p>
              {expanded && !isFeedmillShutdown && (
                <div style={{ borderTop: '1px dashed #e5e7eb', marginTop: '4px', paddingTop: '8px', textAlign: 'center' }}>
                  <button
                    onClick={() => setActiveShutdown({ target: FM_DISPLAY[fm] || fm, targetType: 'feedmill' })}
                    style={{ fontSize: '11px', fontWeight: 500, color: '#e53935', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                    onMouseEnter={e => { e.currentTarget.style.color = '#c62828'; e.currentTarget.style.textDecoration = 'underline'; }}
                    onMouseLeave={e => { e.currentTarget.style.color = '#e53935'; e.currentTarget.style.textDecoration = 'none'; }}
                    data-testid={`button-shutdown-nodata-${fm.toLowerCase()}`}
                    data-tour="overview-shutdown"
                  >⏻ Shutdown</button>
                </div>
              )}
            </>
          ) : (
            <>
              {fmData.grandTotal > 0
                ? <StackedBar data={fmData} height={24} borderRadius={6} />
                : fmData.activeBreakdown?.grandTotal > 0
                  ? <StackedBar data={fmData.activeBreakdown} height={24} borderRadius={6} />
                  : <div style={{ height: '24px', borderRadius: '6px', backgroundColor: 'var(--color-border)', width: '100%' }} title="No active orders" />
              }
              <div style={{ fontSize: '11px', fontWeight: 500, marginTop: '6px' }}>
                <span style={{ color: '#6b7280' }}>{fmData.total.toLocaleString(undefined, { maximumFractionDigits: 1 })} MT total</span>
                <span style={{ color: '#9ca3af' }}> · {CAPACITY_MAP[fm]?.total ?? 0} MT/hr</span>
              </div>

              {expanded && (
                <>
                  <div style={{ borderTop: '1px dashed #e5e7eb', margin: '12px 0' }} />
                  {lines.map(line => {
                    const ld = fmData.lines[line];
                    const isLineDown = lineShutdowns[line]?.isShutdown;
                    return (
                      <div key={line} style={{ marginBottom: '12px' }}>
                        {/* Per-line header with shutdown/resume button */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontSize: '11px', fontWeight: 600, color: isLineDown ? '#b91c1c' : '#374151' }}>{line}</span>
                            {isLineDown && (
                              <span style={{ fontSize: '9px', fontWeight: 700, color: '#dc2626', background: '#fef2f2', padding: '1px 5px', borderRadius: '3px', letterSpacing: '0.02em' }}>🔴 SHUTDOWN</span>
                            )}
                          </div>
                          {isLineDown ? (
                            <button
                              onClick={() => setResumeConfirm({ type: 'line', line, displayName: line })}
                              style={{ display: 'flex', alignItems: 'center', gap: '3px', background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#16a34a', fontSize: '10px', fontWeight: 600, cursor: 'pointer', padding: '3px 8px', borderRadius: '4px' }}
                              data-testid={`button-resume-line-${line.replace(' ', '-').toLowerCase()}`}
                            >▶ Resume</button>
                          ) : (
                            <button
                              onClick={() => setActiveShutdown({ target: line, targetType: 'line' })}
                              style={{ display: 'flex', alignItems: 'center', gap: '3px', background: 'none', border: 'none', color: '#9ca3af', fontSize: '10px', fontWeight: 500, cursor: 'pointer', padding: '3px 6px', borderRadius: '4px', transition: 'all 0.15s' }}
                              onMouseEnter={e => { e.currentTarget.style.color = '#dc2626'; e.currentTarget.style.background = '#fef2f2'; }}
                              onMouseLeave={e => { e.currentTarget.style.color = '#9ca3af'; e.currentTarget.style.background = 'none'; }}
                              data-testid={`button-shutdown-line-${line.replace(' ', '-').toLowerCase()}`}
                              title={`Shutdown ${line}`}
                            >⏻ Shutdown</button>
                          )}
                        </div>

                        {ld && ld.total > 0 ? (
                          <>
                            {ld.grandTotal > 0
                              ? <StackedBar data={ld} height={20} borderRadius={4} />
                              : ld.activeBreakdown?.grandTotal > 0
                                ? <StackedBar data={ld.activeBreakdown} height={20} borderRadius={4} />
                                : <div style={{ height: '20px', borderRadius: '4px', backgroundColor: isLineDown ? '#fecaca' : 'var(--color-border)', width: '100%' }} title={isLineDown ? 'Line is shutdown' : 'No active orders'} />
                            }
                            <div style={{ fontSize: '11px', fontWeight: 500, marginTop: '4px' }}>
                              <span style={{ color: '#6b7280' }}>{ld.total.toLocaleString(undefined, { maximumFractionDigits: 1 })} MT</span>
                              <span style={{ color: '#9ca3af' }}> · {CAPACITY_MAP[fm]?.lines[line] ?? 0} MT/hr</span>
                            </div>
                          </>
                        ) : (
                          <p style={{ fontSize: '11px', color: '#9ca3af', fontStyle: 'italic' }}>No orders.</p>
                        )}
                      </div>
                    );
                  })}

                  <div style={{ borderTop: '1px dashed #e5e7eb', margin: '12px 0' }} />
                  <div style={{ fontSize: '11px', fontWeight: 600, color: '#1a1a1a', marginBottom: '12px' }}>Category Breakdown</div>
                  {STATUS_SEGMENTS.map(seg => {
                    const mt = fmData[seg.key] || 0;
                    const barPct = maxCat > 0 ? (mt / maxCat) * 100 : 0;
                    return (
                      <div key={seg.key} style={{ marginBottom: '12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '4px', gap: '6px' }}>
                          <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', backgroundColor: seg.color, flexShrink: 0 }} />
                          <span style={{ fontSize: '11px', fontWeight: 500, color: '#374151' }}>{seg.label}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ height: '14px', borderRadius: '3px', backgroundColor: seg.color, width: `${barPct}%`, minWidth: mt > 0 ? '4px' : '0' }} />
                          </div>
                          <span style={{ fontSize: '11px', fontWeight: 600, color: '#1a1a1a', whiteSpace: 'nowrap' }}>
                            {mt.toLocaleString(undefined, { maximumFractionDigits: 1 })} MT
                          </span>
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--color-border)', paddingTop: '8px', marginTop: '8px', fontSize: '11px', fontWeight: 700, color: '#1a1a1a' }}>
                    <span>Total</span>
                    <span>{fmData.total.toLocaleString(undefined, { maximumFractionDigits: 1 })} MT</span>
                  </div>

                  {!isFeedmillShutdown && (
                    <div style={{ borderTop: '1px dashed #e5e7eb', marginTop: '8px', paddingTop: '8px', textAlign: 'center' }}>
                      <button
                        onClick={() => setActiveShutdown({ target: FM_DISPLAY[fm] || fm, targetType: 'feedmill' })}
                        style={{ fontSize: '11px', fontWeight: 500, color: '#e53935', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                        onMouseEnter={e => { e.currentTarget.style.color = '#c62828'; e.currentTarget.style.textDecoration = 'underline'; }}
                        onMouseLeave={e => { e.currentTarget.style.color = '#e53935'; e.currentTarget.style.textDecoration = 'none'; }}
                        data-testid={`button-shutdown-${fm.toLowerCase()}`}
                      >⏻ Shutdown {FM_DISPLAY[fm] || fm}</button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* AI Shutdown Dialog */}
      {activeShutdown && (
        <ShutdownDialogAI
          target={activeShutdown.target}
          targetType={activeShutdown.targetType}
          feedmill={fm}
          fmLines={lines}
          orders={orders}
          lineShutdowns={lineShutdowns}
          kbRecords={kbRecords}
          inferredTargetMap={inferredTargetMap}
          onConfirm={(shutdownData) => {
            if (activeShutdown.targetType === 'line') {
              onShutdownLine && onShutdownLine(activeShutdown.target, fm, shutdownData);
            } else {
              onShutdownFeedmill && onShutdownFeedmill(fm, lines, shutdownData);
            }
            setActiveShutdown(null);
          }}
          onClose={() => setActiveShutdown(null)}
        />
      )}

      {/* Resume Confirmation Dialog */}
      {resumeConfirm && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 10002, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div style={{ background: 'var(--color-bg-secondary)', borderRadius: '12px', width: '420px', maxWidth: '100%', boxShadow: '0 8px 30px rgba(0,0,0,0.22)', overflow: 'hidden' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--color-border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '15px', fontWeight: 700, color: '#15803d' }}>
                <span style={{ fontSize: '18px' }}>▶</span>
                <span>Resume {resumeConfirm.displayName}</span>
              </div>
              <button onClick={() => setResumeConfirm(null)} style={{ background: 'none', border: 'none', fontSize: '18px', color: '#9ca3af', cursor: 'pointer' }}>✕</button>
            </div>
            {/* Body */}
            <div style={{ padding: '20px', fontSize: '13px', color: '#374151', lineHeight: '1.6' }}>
              <p>
                Are you sure you want to resume{' '}
                <strong>{resumeConfirm.displayName}</strong>?
              </p>
              {resumeConfirm.type === 'feedmill' && (
                <p style={{ marginTop: '8px', fontSize: '12px', color: '#6b7280' }}>
                  This will mark all lines in {resumeConfirm.displayName} as active and clear their shutdown status.
                </p>
              )}
            </div>
            {/* Footer */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '14px 20px', borderTop: '1px solid var(--color-border)' }}>
              <button
                onClick={() => setResumeConfirm(null)}
                data-testid="button-resume-cancel"
                style={{ padding: '8px 20px', fontSize: '13px', fontWeight: 500, color: '#6b7280', background: 'var(--color-bg-secondary)', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (resumeConfirm.type === 'line') {
                    onResumeLine && onResumeLine(resumeConfirm.line, fm);
                  } else {
                    onResumeFeedmill ? onResumeFeedmill(fm) : lines.forEach(l => onResumeLine && onResumeLine(l, fm));
                  }
                  setResumeConfirm(null);
                }}
                data-testid="button-resume-confirm"
                style={{ padding: '8px 20px', fontSize: '13px', fontWeight: 600, color: '#fff', background: '#16a34a', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
              >
                Confirm Resume
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

// ─── PDF helpers ──────────────────────────────────────────────────────────────
const ORANGE = [253, 81, 8];
const DARK   = [26, 26, 26];
const GREY   = [107, 114, 128];
const LGREY  = [229, 231, 235];
const LORANGE = [255, 247, 237];

function drawSectionHeader(pdf, num, title, y, MARGIN, PAGE_W) {
  pdf.setDrawColor(...LGREY);
  pdf.setLineWidth(0.3);
  pdf.line(MARGIN, y - 2, PAGE_W - MARGIN, y - 2);
  y += 4;

  pdf.setFontSize(14);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(...ORANGE);
  pdf.text(`${num}.`, MARGIN, y);
  pdf.setTextColor(...DARK);
  pdf.text(` ${title}`, MARGIN + 7, y);
  y += 5;

  pdf.setDrawColor(...LGREY);
  pdf.line(MARGIN, y, PAGE_W - MARGIN, y);
  return y + 6;
}

function buildAutoTableOptions(pdf, body, MARGIN) {
  return {
    theme: 'grid',
    head: [['Status', 'Volume', '%']],
    body,
    headStyles: { fillColor: ORANGE, textColor: [255, 255, 255], fontSize: 10, fontStyle: 'bold' },
    styles: { fontSize: 10, cellPadding: { top: 4, right: 8, bottom: 4, left: 8 } },
    alternateRowStyles: { fillColor: [249, 250, 251] },
    margin: { left: MARGIN, right: MARGIN },
    willDrawCell(d) {
      if (d.column.index === 0 && d.section === 'body') {
        d.cell.styles.cellPadding = { top: 4, right: 8, bottom: 4, left: 14 };
      }
    },
    didDrawCell(d) {
      if (d.column.index === 0 && d.section === 'body') {
        const dotColor = STATUS_DOT_COLORS[d.cell.raw];
        if (dotColor) {
          pdf.setFillColor(...hexToRgb(dotColor));
          pdf.ellipse(d.cell.x + 5, d.cell.y + d.cell.height / 2, 1.8, 1.8, 'F');
        }
      }
    },
    didParseCell(d) {
      if (d.section === 'body' && d.row.index === body.length - 1) {
        d.cell.styles.fillColor = LORANGE;
        d.cell.styles.fontStyle = 'bold';
      }
    },
  };
}

function buildSummaryRows(data) {
  const fmt = v => (v || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const rows = STATUS_SEGMENTS.map(seg => [
    seg.pdfLabel,
    `${fmt(data[seg.key])} MT`,
    `${data.total > 0 ? (((data[seg.key] || 0) / data.total) * 100).toFixed(1) : '0.0'}%`,
  ]);
  rows.push(['TOTAL', `${fmt(data.total)} MT`, '100%']);
  return rows;
}

function renderAIInsightToPDF(pdf, aiText, startY, MARGIN, PAGE_W) {
  if (!aiText) return startY;
  const TEXT_W = PAGE_W - 2 * MARGIN - 16;
  const LINE_H_HEAD = 7;
  const LINE_H_BODY = 5;

  const lines = aiText.split('\n').filter(l => l.trim());
  const processed = [];

  lines.forEach(line => {
    const t = line.trim();
    const isHeading = HEADING_EMOJIS.some(e => t.startsWith(e));
    const isBullet = t.startsWith('- ');
    if (isHeading) {
      const stripped = t.replace(/[📊⚖📈⚠💡]/gu, '').replace(/\*\*/g, '').trim();
      processed.push({ type: 'heading', text: stripped, origLine: t });
      processed.push({ type: 'spacer', h: 2 });
    } else if (isBullet) {
      const wrapped = pdf.splitTextToSize(t, TEXT_W - 8);
      wrapped.forEach((wl, i) => processed.push({ type: 'bullet', text: wl, indent: i === 0 }));
      processed.push({ type: 'spacer', h: 2 });
    } else {
      const stripped = t.replace(/\*\*/g, '');
      const wrapped = pdf.splitTextToSize(stripped, TEXT_W);
      wrapped.forEach(wl => processed.push({ type: 'body', text: wl }));
      processed.push({ type: 'spacer', h: 2 });
    }
  });

  // Measure total height
  let totalH = 14;
  processed.forEach(p => {
    if (p.type === 'heading') totalH += LINE_H_HEAD;
    else if (p.type === 'spacer') totalH += p.h;
    else totalH += LINE_H_BODY;
  });

  let y = startY;
  if (y + totalH > 278) { pdf.addPage(); y = 20; }

  // Background box
  pdf.setFillColor(249, 250, 251);
  pdf.setDrawColor(...LGREY);
  pdf.setLineWidth(0.3);
  pdf.roundedRect(MARGIN, y, PAGE_W - 2 * MARGIN, totalH, 3, 3, 'FD');

  let textY = y + 8;
  processed.forEach(p => {
    if (p.type === 'heading') {
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(11);
      pdf.setTextColor(...DARK);
      pdf.text(p.text, MARGIN + 8, textY);
      textY += LINE_H_HEAD;
    } else if (p.type === 'bullet') {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(10);
      pdf.setTextColor(55, 65, 81);
      pdf.text(p.text, MARGIN + 16, textY);
      textY += LINE_H_BODY;
    } else if (p.type === 'body') {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(10);
      pdf.setTextColor(55, 65, 81);
      pdf.text(p.text, MARGIN + 8, textY);
      textY += LINE_H_BODY;
    } else {
      textY += p.h;
    }
  });

  return y + totalH;
}

// ─── PDF generation ───────────────────────────────────────────────────────────
async function generatePDF(breakdown, monthOrders, monthLabel, aiInsight) {
  const pdf = new jsPDF('p', 'mm', 'a4');
  const PAGE_W = 210;
  const MARGIN = 20;
  const fmt = v => (v || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });

  const drawHeader = () => {
    // "NexFeed" in orange + rest in dark
    pdf.setFontSize(20);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(...ORANGE);
    pdf.text('NexFeed', MARGIN, 20);
    pdf.setTextColor(...DARK);
    pdf.text(': Feed Production Report', MARGIN + 33, 20);

    // Orange accent line
    pdf.setDrawColor(...ORANGE);
    pdf.setLineWidth(0.75);
    pdf.line(MARGIN, 24, PAGE_W - MARGIN, 24);

    pdf.setFontSize(12);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(...DARK);
    pdf.text(`Report Period: ${monthLabel}`, MARGIN, 32);

    pdf.setFontSize(9);
    pdf.setTextColor(...GREY);
    pdf.text(`Generated: ${new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })}`, MARGIN, 38);
    pdf.setTextColor(...DARK);
  };

  const addFooters = () => {
    const total = pdf.getNumberOfPages();
    for (let i = 1; i <= total; i++) {
      pdf.setPage(i);
      pdf.setFontSize(8);
      pdf.setTextColor(...GREY);
      pdf.text('Generated by NexFeed Production Scheduling System', PAGE_W / 2, 290, { align: 'center' });
      pdf.text(`Page ${i} of ${total}`, PAGE_W - MARGIN, 290, { align: 'right' });
    }
  };

  // Overall totals
  const CATS = STATUS_SEGMENTS.map(s => s.key);
  const overall = Object.fromEntries(CATS.map(c => [c, 0]));
  overall.total = 0;
  Object.values(breakdown).forEach(fm => {
    CATS.forEach(c => { overall[c] += fm[c] || 0; });
    overall.total += fm.total || 0;
  });

  // PAGE 1 — Header
  drawHeader();
  let y = 48;

  // === 1. OVERALL SUMMARY ===
  y = drawSectionHeader(pdf, 1, 'OVERALL SUMMARY', y, MARGIN, PAGE_W);
  pdf.setFontSize(10); pdf.setFont('helvetica', 'normal'); pdf.setTextColor(...DARK);
  pdf.text(`Total Orders: ${monthOrders.length}`, MARGIN, y); y += 5;
  pdf.text(`Total Volume: ${fmt(overall.total)} MT`, MARGIN, y); y += 8;

  autoTable(pdf, { ...buildAutoTableOptions(pdf, buildSummaryRows(overall), MARGIN), startY: y });
  y = pdf.lastAutoTable.finalY + 14;

  // === 2. FEEDMILL BREAKDOWN ===
  if (y > 220) { pdf.addPage(); drawHeader(); y = 48; }
  y = drawSectionHeader(pdf, 2, 'FEEDMILL BREAKDOWN', y, MARGIN, PAGE_W);

  for (const [fm, lines] of Object.entries(FEEDMILL_LINES)) {
    if (y > 230) { pdf.addPage(); y = 20; }
    const fmData = breakdown[fm] || Object.fromEntries([...CATS.map(c => [c, 0]), ['total', 0]]);
    const fmLabel = fm === 'PMX' ? 'POWERMIX (PMX)' : `FEEDMILL ${fm.replace('FM', '')} (${fm})`;

    // Orange left border + text
    pdf.setFillColor(...ORANGE);
    pdf.rect(MARGIN, y - 4, 3, 7, 'F');
    pdf.setFontSize(12); pdf.setFont('helvetica', 'bold'); pdf.setTextColor(...DARK);
    pdf.text(fmLabel, MARGIN + 6, y);
    y += 7;

    autoTable(pdf, { ...buildAutoTableOptions(pdf, buildSummaryRows(fmData), MARGIN), startY: y });
    y = pdf.lastAutoTable.finalY + 6;

    for (const line of lines) {
      if (y > 240) { pdf.addPage(); y = 20; }
      const ld = (fmData.lines || {})[line] || Object.fromEntries([...CATS.map(c => [c, 0]), ['total', 0]]);
      pdf.setFontSize(11); pdf.setFont('helvetica', 'bold'); pdf.setTextColor(55, 65, 81);
      pdf.text(`${line}:`, MARGIN + 5, y); y += 5;

      const lineOpts = {
        ...buildAutoTableOptions(pdf, buildSummaryRows(ld), MARGIN),
        startY: y,
        margin: { left: MARGIN + 5, right: MARGIN },
        headStyles: { fillColor: [100, 116, 139], textColor: [255, 255, 255], fontSize: 9, fontStyle: 'bold' },
        styles: { fontSize: 9, cellPadding: { top: 3, right: 6, bottom: 3, left: 6 } },
      };
      lineOpts.willDrawCell = (d) => {
        if (d.column.index === 0 && d.section === 'body') {
          d.cell.styles.cellPadding = { top: 3, right: 6, bottom: 3, left: 14 };
        }
      };
      autoTable(pdf, lineOpts);
      y = pdf.lastAutoTable.finalY + 6;
    }
    y += 6;
  }

  // === 3. ORDER LIST ===
  pdf.addPage();
  drawHeader();
  y = 48;
  y = drawSectionHeader(pdf, 3, 'ORDER LIST', y, MARGIN, PAGE_W);

  const sorted = [...monthOrders].sort((a, b) => {
    const la = a.feedmill_line || a.line || '';
    const lb = b.feedmill_line || b.line || '';
    return la.localeCompare(lb) || (a.priority_seq || 0) - (b.priority_seq || 0);
  });

  autoTable(pdf, {
    startY: y,
    head: [['#', 'Item Description', 'Volume', 'Line', 'Status']],
    body: sorted.map((o, i) => [
      i + 1,
      o.item_description || o.item || '-',
      `${getVolume(o).toLocaleString(undefined, { maximumFractionDigits: 1 })} MT`,
      o.feedmill_line || o.line || '-',
      o.status || '-',
    ]),
    theme: 'grid',
    headStyles: { fillColor: ORANGE, textColor: [255, 255, 255], fontSize: 10, fontStyle: 'bold' },
    styles: { fontSize: 9, cellPadding: { top: 3, right: 6, bottom: 3, left: 6 }, overflow: 'linebreak' },
    alternateRowStyles: { fillColor: [249, 250, 251] },
    columnStyles: { 0: { halign: 'center', cellWidth: 10 }, 2: { halign: 'right' } },
    margin: { left: MARGIN, right: MARGIN },
  });
  y = pdf.lastAutoTable.finalY + 14;

  // === 4. AI PRODUCTION INSIGHT ===
  if (aiInsight) {
    if (y > 220) { pdf.addPage(); drawHeader(); y = 48; }
    y = drawSectionHeader(pdf, 4, 'AI PRODUCTION INSIGHT', y, MARGIN, PAGE_W);
    y = renderAIInsightToPDF(pdf, aiInsight, y, MARGIN, PAGE_W);
  }

  addFooters();

  const [mon, yr] = [monthLabel.split(' ')[0], monthLabel.split(' ')[1]];
  pdf.save(`NexFeed_Report_${mon}_${yr}.pdf`);
}

// ─── ProductionStatusMonitoring ───────────────────────────────────────────────
function ProductionStatusMonitoring({ breakdown, monthOrders, monthLabel, rollingMonths, selectedIdx, setSelectedIdx, onExport, exporting, feedmillStatus = {}, onFeedmillStatusChange, lineShutdowns = {}, onShutdownLine, onResumeLine, onShutdownFeedmill, orders = [], kbRecords = [], inferredTargetMap = {} }) {
  return (
    <div>
      {/* Title */}
      <div
        data-tour="overview-line-monitoring"
        style={{ fontSize: '14px', fontWeight: 700, color: '#1a1a1a', marginBottom: '16px' }}
      >
        Line Status Monitoring
      </div>

      {/* Header row */}
      <div
        data-tour="overview-month-export"
        style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}
      >
        <select
          value={selectedIdx}
          onChange={e => setSelectedIdx(Number(e.target.value))}
          data-testid="select-production-month"
          style={{ width: '160px', border: '1px solid #d1d5db', borderRadius: '6px', padding: '0 10px', fontSize: '12px', height: '36px', cursor: 'pointer', background: 'var(--color-bg-secondary)' }}
        >
          {rollingMonths.map((m, i) => (
            <option key={i} value={i}>{m.label}</option>
          ))}
        </select>

        <Button
          onClick={onExport}
          disabled={exporting}
          data-testid="button-export-production-report"
          size="sm"
          className="bg-[var(--nexfeed-primary)] hover:bg-[var(--nexfeed-primary-dark)] text-white h-9 text-[12px] font-normal gap-1.5"
        >
          <FileText size={14} />
          {exporting ? 'Generating…' : 'Export Report'}
        </Button>
      </div>

      {/* Feedmill cards */}
      <div className="production-status-grid" data-tour="overview-feedmill-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
        {Object.entries(FEEDMILL_LINES).map(([fm, lines]) => (
          <FeedmillCard
            key={fm}
            fm={fm}
            lines={lines}
            data={breakdown}
            fmStatus={feedmillStatus[fm] || {}}
            onStatusChange={onFeedmillStatusChange}
            lineShutdowns={lineShutdowns}
            onShutdownLine={onShutdownLine}
            onResumeLine={onResumeLine}
            onShutdownFeedmill={onShutdownFeedmill}
            orders={orders}
            kbRecords={kbRecords}
            inferredTargetMap={inferredTargetMap}
          />
        ))}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '20px', marginTop: '16px', flexWrap: 'wrap' }}>
        {STATUS_SEGMENTS.map(seg => (
          <div key={seg.key} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '2px', backgroundColor: seg.color, flexShrink: 0 }} />
            <span style={{ fontSize: '11px', color: '#6b7280' }}>{seg.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main OverviewDashboard ───────────────────────────────────────────────────
export default function OverviewDashboard({ orders, feedmillStatus = {}, onFeedmillStatusChange, lineShutdowns = {}, onShutdownLine, onResumeLine, onShutdownFeedmill, kbRecords = [], inferredTargetMap = {} }) {
  // ── Month selection (lifted from ProductionStatusMonitoring) ──
  const rollingMonths = useMemo(() => getRollingMonths(), []);
  const [selectedIdx, setSelectedIdx] = useState(0);

  const { month, year, label: monthLabel } = rollingMonths[selectedIdx];

  const { breakdown, monthOrders } = useMemo(
    () => calculateBreakdown(orders, month, year),
    [orders, month, year]
  );

  // ── Smart Production Insight state ──
  const [insightExpanded, setInsightExpanded] = useState(false);
  const [lineInsight, setLineInsight]         = useState('');
  const [isLoadingInsight, setIsLoadingInsight] = useState(false);
  const hasGeneratedRef = useRef(false);

  const runGenerateInsight = useCallback(async (bd, mo, mon, yr) => {
    if (!orders.length) return;
    setIsLoadingInsight(true);
    try {
      const result = await generateReportInsight(bd, mon, yr, mo);
      setLineInsight(result);
      hasGeneratedRef.current = true;
    } catch {
      setLineInsight('Unable to generate insight at this time.');
    }
    setIsLoadingInsight(false);
  }, [orders.length]);

  // Regenerate when month changes AND panel is expanded
  useEffect(() => {
    if (insightExpanded && orders.length > 0) {
      const mon = rollingMonths[selectedIdx].label.split(' ')[0];
      runGenerateInsight(breakdown, monthOrders, mon, year);
    }
  }, [selectedIdx, orders.length > 0]);

  const handleInsightToggle = () => {
    const willExpand = !insightExpanded;
    setInsightExpanded(willExpand);
    // Generate on first expand if no content yet
    if (willExpand && !hasGeneratedRef.current && orders.length > 0) {
      const mon = rollingMonths[selectedIdx].label.split(' ')[0];
      runGenerateInsight(breakdown, monthOrders, mon, year);
    }
  };

  const handleRefreshInsight = (e) => {
    e.stopPropagation();
    const mon = rollingMonths[selectedIdx].label.split(' ')[0];
    runGenerateInsight(breakdown, monthOrders, mon, year);
  };

  // ── PDF export ──
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      let insight = lineInsight;
      if (!insight) {
        const mon = rollingMonths[selectedIdx].label.split(' ')[0];
        insight = await generateReportInsight(breakdown, mon, year, monthOrders);
      }
      await generatePDF(breakdown, monthOrders, monthLabel, insight);
    } catch (e) {
      console.error('PDF export failed', e);
    }
    setExporting(false);
  };

  // ── Key metric stats ──
  const totalOrders = orders.length;
  const completed = orders.filter(o => {
    const s = (o.status || '').toLowerCase();
    return s === 'done' || s === 'completed';
  }).length;

  const now = new Date();
  const twoDaysLater = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const INACTIVE_STATUSES = ['completed', 'done', 'cancel_po', 'cancel po'];
  const urgentOrders = orders.filter(order => {
    // Skip completed/cancelled orders
    if (INACTIVE_STATUSES.includes((order.status || '').toLowerCase())) return false;
    // 1. Safety stock Critical or Urgent status always counts
    const inf = inferredTargetMap[order.material_code] || inferredTargetMap[order.material_code_fg];
    if (inf?.status === 'Critical' || inf?.status === 'Urgent') return true;
    // 2. target_avail_date within the next 2 days (from start of today)
    const raw = order.target_avail_date;
    if (!raw) return false;
    try {
      // Parse date-only strings (YYYY-MM-DD) in local time to avoid UTC-offset mismatches
      const d = /^\d{4}-\d{2}-\d{2}$/.test(raw)
        ? new Date(raw + 'T00:00:00')
        : new Date(raw);
      return !isNaN(d) && d <= twoDaysLater && d >= startOfToday;
    } catch { return false; }
  }).length;

  const activeOrders = orders.filter(o => {
    const s = (o.status || '').toLowerCase();
    return !['completed', 'done', 'cancel_po', 'cancel po'].includes(s);
  }).length;

  const stats = [
    { label: 'Total Orders',    value: totalOrders,   icon: ClipboardList,  color: 'text-blue-600',   bg: 'bg-blue-50' },
    { label: 'Active Orders',   value: activeOrders,  icon: Activity,       color: 'text-green-600',  bg: 'bg-green-50' },
    { label: 'Complete Orders', value: completed,     icon: CheckCircle2,   color: 'text-teal-600',   bg: 'bg-teal-50' },
    { label: 'Urgent Orders',   value: urgentOrders,  icon: AlertTriangle,  color: 'text-orange-600', bg: 'bg-orange-50' },
  ];

  return (
    <div className="space-y-6">

      {/* ── 1. Smart Production Insight (collapsible, collapsed by default) ── */}
      <div style={{ marginBottom: '0' }} data-tour="overview-insights">
        {/* Header */}
        <div
          onClick={handleInsightToggle}
          data-testid="panel-smart-insight-header"
          style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '12px 16px', cursor: 'pointer', userSelect: 'none',
            background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border)',
            borderRadius: insightExpanded ? '8px 8px 0 0' : '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '14px' }}>✨</span>
            <span style={{ fontSize: '13px', fontWeight: 700, color: '#1a1a1a' }}>Smart Production Insight</span>
            <span style={{ fontSize: '10px', color: '#6b7280', marginLeft: '8px' }}>{insightExpanded ? '▼' : '▶'}</span>
          </div>
          <button
            onClick={handleRefreshInsight}
            disabled={isLoadingInsight}
            data-testid="button-refresh-smart-insight"
            style={{ fontSize: '12px', color: 'var(--nexfeed-primary)', background: 'none', border: 'none', cursor: isLoadingInsight ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '4px', opacity: isLoadingInsight ? 0.5 : 1, padding: '2px 4px', borderRadius: '4px' }}
            onMouseEnter={e => { if (!isLoadingInsight) e.currentTarget.style.color = '#c2410c'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--nexfeed-primary)'; }}
          >
            {isLoadingInsight ? <Loader2 size={12} className="animate-spin" /> : '↻'} Refresh
          </button>
        </div>

        {/* Expanded content */}
        {insightExpanded && (
          <div
            className="smart-insight-content"
            style={{
              background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border)', borderTop: 'none',
              borderRadius: '0 0 8px 8px', padding: '16px 20px',
              maxHeight: '400px', overflowY: 'auto',
            }}
          >
            {isLoadingInsight ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#9ca3af' }}>
                <Loader2 size={14} className="animate-spin" />
                <span style={{ fontSize: '11px' }}>Generating insight…</span>
              </div>
            ) : lineInsight ? (
              <InsightText text={lineInsight} />
            ) : (
              <p style={{ fontSize: '11px', color: '#9ca3af', fontStyle: 'italic' }}>
                No insight available. Click ↻ Refresh to generate.
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── 2. Key metric stat cards ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" data-tour="overview-metrics">
        {stats.map(stat => {
          const Icon = stat.icon;
          return (
            <Card key={stat.label} className="border-0 shadow-sm" data-testid={`card-stat-${stat.label.toLowerCase().replace(/\s/g, '-')}`}>
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[12px] text-gray-500 mb-1">{stat.label}</p>
                    <p className="text-[24px] font-bold text-gray-900">{stat.value}</p>
                  </div>
                  <div className={`p-3 rounded-xl ${stat.bg}`}>
                    <Icon className={`h-6 w-6 ${stat.color}`} />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* ── 3. Line Status Monitoring ── */}
      <Card className="border-0 shadow-sm">
        <CardContent className="p-6">
          <ProductionStatusMonitoring
            breakdown={breakdown}
            monthOrders={monthOrders}
            monthLabel={monthLabel}
            rollingMonths={rollingMonths}
            selectedIdx={selectedIdx}
            setSelectedIdx={setSelectedIdx}
            onExport={handleExport}
            exporting={exporting}
            feedmillStatus={feedmillStatus}
            onFeedmillStatusChange={onFeedmillStatusChange}
            lineShutdowns={lineShutdowns}
            onShutdownLine={onShutdownLine}
            onResumeLine={onResumeLine}
            onShutdownFeedmill={onShutdownFeedmill}
            orders={orders}
            kbRecords={kbRecords}
            inferredTargetMap={inferredTargetMap}
          />
        </CardContent>
      </Card>

      <style>{`
        @media (max-width: 1200px) { .production-status-grid { grid-template-columns: 1fr 1fr !important; } }
        @media (max-width: 768px)  { .production-status-grid { grid-template-columns: 1fr !important; } }
        .smart-insight-content::-webkit-scrollbar { width: 6px; }
        .smart-insight-content::-webkit-scrollbar-track { background: rgba(0,0,0,0.03); border-radius: 3px; }
        .smart-insight-content::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }
      `}</style>
    </div>
  );
}
