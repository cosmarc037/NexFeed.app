import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  ClipboardList, AlertTriangle, CheckCircle2,
  Activity, Loader2, FileText
} from 'lucide-react';
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { generateReportInsight } from '@/services/azureAI';
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

function getVolume(order) {
  return parseFloat(order.volume || order.total_volume_mt || 0);
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

  Object.entries(FEEDMILL_LINES).forEach(([fm, lines]) => {
    // Month-scoped orders — used for bar chart proportions only
    const fmMonthOrders = monthOrders.filter(o => lines.includes(o.feedmill_line || o.line));

    // ALL active orders across every month — used for totals and hasData
    const fmAllActive = orders.filter(o =>
      lines.includes(o.feedmill_line || o.line) && !isInactiveOrder(o)
    );

    const fmData = Object.fromEntries(CATS.map(c => [c, 0]));
    fmData.grandTotal = 0; // monthly volume — drives bar % widths

    fmMonthOrders.forEach(o => {
      const cat = getStatusCategory(o.status);
      const vol = getVolume(o);
      fmData[cat] += vol;
      fmData.grandTotal += vol;
    });
    CATS.forEach(c => {
      fmData[`${c}_pct`] = fmData.grandTotal > 0
        ? Math.round((fmData[c] / fmData.grandTotal) * 100) : 0;
    });

    // Active total = all active orders regardless of date
    fmData.total = fmAllActive.reduce((sum, o) => sum + getVolume(o), 0);

    const lineBreakdowns = {};
    lines.forEach(line => {
      const lineMonthOrders = fmMonthOrders.filter(o => (o.feedmill_line || o.line) === line);
      const lineAllActive   = fmAllActive.filter(o => (o.feedmill_line || o.line) === line);

      const ld = Object.fromEntries(CATS.map(c => [c, 0]));
      ld.grandTotal = 0;

      lineMonthOrders.forEach(o => {
        const cat = getStatusCategory(o.status);
        const vol = getVolume(o);
        ld[cat] += vol;
        ld.grandTotal += vol;
      });
      CATS.forEach(c => {
        ld[`${c}_pct`] = ld.grandTotal > 0
          ? Math.round((ld[c] / ld.grandTotal) * 100) : 0;
      });

      ld.total = lineAllActive.reduce((sum, o) => sum + getVolume(o), 0);

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

// ─── Shutdown Dialog ──────────────────────────────────────────────────────────
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

const FIELD_LABEL = { display: 'block', fontSize: '11px', fontWeight: 600, color: '#6b7280', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' };
const FIELD_INPUT = { width: '100%', border: '1px solid #d1d5db', borderRadius: '6px', padding: '8px 12px', fontSize: '12px', color: '#1a1a1a', outline: 'none', boxSizing: 'border-box' };

function ShutdownDialog({ fm, fmStatus, onSave, onClose }) {
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState(fmStatus?.notes || '');
  const [shutdownDate, setShutdownDate] = useState(fmStatus?.shutdownDate || new Date().toISOString().slice(0, 10));
  const isShutdown = fmStatus?.isShutdown;
  const isOther = reason === 'Other';
  const canSubmit = reason !== '' && (!isOther || notes.trim() !== '');

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div style={{ background: '#fff', borderRadius: '12px', width: '100%', maxWidth: '440px', padding: '24px 28px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        {/* Title */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '18px' }}>{isShutdown ? '✅' : '🚫'}</span>
            <span style={{ fontSize: '16px', fontWeight: 700, color: '#1a1a1a' }}>
              {isShutdown ? `Resume ${fm}` : `Mark ${fm} Shutdown`}
            </span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '18px', color: '#9ca3af', cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>

        {!isShutdown ? (
          <>
            {/* Shutdown Date */}
            <div style={{ marginBottom: '16px' }}>
              <label style={FIELD_LABEL}>Shutdown Date</label>
              <input
                type="date"
                value={shutdownDate}
                onChange={e => setShutdownDate(e.target.value)}
                style={FIELD_INPUT}
              />
            </div>

            {/* Reason dropdown */}
            <div style={{ marginBottom: '16px' }}>
              <label style={FIELD_LABEL}>Reason *</label>
              <select
                value={reason}
                onChange={e => setReason(e.target.value)}
                style={{ ...FIELD_INPUT, appearance: 'auto', background: '#fff', cursor: 'pointer', color: reason === '' ? '#9ca3af' : '#1a1a1a' }}
              >
                <option value="" disabled>Select a reason...</option>
                {SHUTDOWN_REASONS.map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>

            {/* Notes textarea */}
            <div style={{ marginBottom: '20px' }}>
              <label style={FIELD_LABEL}>Notes {isOther ? '*' : '(Optional)'}</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder={isOther ? 'Please specify the reason...' : 'Any additional details...'}
                style={{ ...FIELD_INPUT, height: '80px', resize: 'vertical', fontFamily: 'inherit' }}
              />
            </div>

            {/* Buttons */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button onClick={onClose} style={{ padding: '8px 18px', fontSize: '13px', color: '#374151', background: '#fff', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer' }}>Cancel</button>
              <button
                onClick={() => canSubmit && onSave({ isShutdown: true, shutdownDate, reason, notes })}
                disabled={!canSubmit}
                style={{ padding: '8px 18px', fontSize: '13px', fontWeight: 600, color: canSubmit ? '#fff' : '#d1d5db', background: canSubmit ? '#e53935' : '#f3f4f6', border: 'none', borderRadius: '6px', cursor: canSubmit ? 'pointer' : 'not-allowed' }}
              >Mark Shutdown</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', padding: '12px 16px', marginBottom: '20px', fontSize: '12px', color: '#7f1d1d' }}>
              <div><strong>Date:</strong> {fmStatus.shutdownDate}</div>
              <div style={{ marginTop: '4px' }}><strong>Reason:</strong> {fmStatus.reason || '—'}</div>
              {fmStatus.notes && <div style={{ marginTop: '4px' }}><strong>Notes:</strong> {fmStatus.notes}</div>}
            </div>
            <p style={{ fontSize: '12px', color: '#4b5563', lineHeight: 1.6, marginBottom: '20px' }}>
              Resuming <strong>{fm}</strong> will remove the shutdown flag. Orders already diverted will remain on their new lines until manually reverted.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button onClick={onClose} style={{ padding: '8px 18px', fontSize: '13px', color: '#374151', background: '#fff', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={() => onSave({ isShutdown: false, shutdownDate: null, reason: '', notes: '' })} style={{ padding: '8px 18px', fontSize: '13px', fontWeight: 600, color: '#fff', background: '#16a34a', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>Resume {fm}</button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

// ─── FeedmillCard ─────────────────────────────────────────────────────────────
function FeedmillCard({ fm, lines, data, fmStatus = {}, onStatusChange }) {
  const [expanded, setExpanded] = useState(false);
  const [showShutdownDialog, setShowShutdownDialog] = useState(false);
  const fmData = data[fm];
  const hasData = fmData && fmData.total > 0;
  const maxCat = hasData ? Math.max(...STATUS_SEGMENTS.map(s => fmData[s.key] || 0)) : 0;
  const isShutdown = fmStatus.isShutdown;

  const FM_DISPLAY = { FM1: 'Feedmill 1', FM2: 'Feedmill 2', FM3: 'Feedmill 3', PMX: 'Powermix' };

  return (
    <>
      <div style={{ background: '#ffffff', border: `1px solid ${isShutdown ? '#fca5a5' : '#e5e7eb'}`, borderRadius: '8px', overflow: 'hidden', boxShadow: isShutdown ? '0 0 0 2px rgba(220,38,38,0.1)' : 'none' }}>
        {/* Shutdown banner */}
        {isShutdown && (
          <div style={{ background: '#fef2f2', borderBottom: '1px solid #fca5a5', padding: '6px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '11px' }}>⛔</span>
              <span style={{ fontSize: '11px', fontWeight: 600, color: '#b91c1c' }}>SHUTDOWN</span>
              {fmStatus.shutdownDate && <span style={{ fontSize: '10px', color: '#ef4444' }}>since {fmStatus.shutdownDate}</span>}
            </div>
            <button
              onClick={() => setShowShutdownDialog(true)}
              style={{ fontSize: '10px', color: '#16a34a', fontWeight: 600, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '4px', padding: '2px 8px', cursor: 'pointer' }}
            >Resume</button>
          </div>
        )}
        <div
          style={{ background: '#ffffff', padding: '12px 16px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}
          onClick={() => setExpanded(e => !e)}
          data-testid={`card-fm-${fm.toLowerCase()}`}
        >
          <span style={{ fontSize: '13px', fontWeight: 700, color: isShutdown ? '#b91c1c' : '#1a1a1a' }}>{FM_DISPLAY[fm] || fm}</span>
          <span style={{ fontSize: '10px', color: '#6b7280' }}>{expanded ? '▼' : '▶'}</span>
        </div>
        <div style={{ padding: '12px 16px' }}>
          {!hasData ? (
            <>
              <p style={{ fontSize: '11px', color: '#9ca3af', fontStyle: 'italic', textAlign: 'center', padding: '16px 0' }}>
                No active orders.
              </p>
              {expanded && !isShutdown && (
                <div style={{ borderTop: '1px dashed #e5e7eb', marginTop: '4px', paddingTop: '8px', textAlign: 'center' }}>
                  <button
                    onClick={() => setShowShutdownDialog(true)}
                    style={{ fontSize: '11px', fontWeight: 500, color: '#e53935', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                    onMouseEnter={e => { e.currentTarget.style.color = '#c62828'; e.currentTarget.style.textDecoration = 'underline'; }}
                    onMouseLeave={e => { e.currentTarget.style.color = '#e53935'; e.currentTarget.style.textDecoration = 'none'; }}
                    data-testid={`button-shutdown-nodata-${fm.toLowerCase()}`}
                  >⏻ Shutdown</button>
                </div>
              )}
            </>
          ) : (
            <>
              {fmData.grandTotal > 0
                ? <StackedBar data={fmData} height={24} borderRadius={6} />
                : <div style={{ height: '24px', borderRadius: '6px', backgroundColor: '#e5e7eb', width: '100%' }} title="No orders in selected month — showing all-time active backlog" />
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
                    return (
                      <div key={line} style={{ marginBottom: '10px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, color: '#374151', marginBottom: '4px' }}>{line}</div>
                        {ld && ld.total > 0 ? (
                          <>
                            {ld.grandTotal > 0
                              ? <StackedBar data={ld} height={20} borderRadius={4} />
                              : <div style={{ height: '20px', borderRadius: '4px', backgroundColor: '#e5e7eb', width: '100%' }} title="No orders in selected month — showing all-time active backlog" />
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #e5e7eb', paddingTop: '8px', marginTop: '8px', fontSize: '11px', fontWeight: 700, color: '#1a1a1a' }}>
                    <span>Total</span>
                    <span>{fmData.total.toLocaleString(undefined, { maximumFractionDigits: 1 })} MT</span>
                  </div>

                  {!isShutdown && (
                    <div style={{ borderTop: '1px dashed #e5e7eb', marginTop: '8px', paddingTop: '8px', textAlign: 'center' }}>
                      <button
                        onClick={() => setShowShutdownDialog(true)}
                        style={{ fontSize: '11px', fontWeight: 500, color: '#e53935', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                        onMouseEnter={e => { e.currentTarget.style.color = '#c62828'; e.currentTarget.style.textDecoration = 'underline'; }}
                        onMouseLeave={e => { e.currentTarget.style.color = '#e53935'; e.currentTarget.style.textDecoration = 'none'; }}
                        data-testid={`button-shutdown-${fm.toLowerCase()}`}
                      >⏻ Shutdown</button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
      {showShutdownDialog && (
        <ShutdownDialog
          fm={FM_DISPLAY[fm] || fm}
          fmStatus={fmStatus}
          onSave={(updates) => {
            onStatusChange && onStatusChange(fm, updates);
            setShowShutdownDialog(false);
          }}
          onClose={() => setShowShutdownDialog(false)}
        />
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
function ProductionStatusMonitoring({ breakdown, monthOrders, monthLabel, rollingMonths, selectedIdx, setSelectedIdx, onExport, exporting, feedmillStatus = {}, onFeedmillStatusChange }) {
  return (
    <div>
      {/* Title */}
      <div style={{ fontSize: '14px', fontWeight: 700, color: '#1a1a1a', marginBottom: '16px' }}>
        Line Status Monitoring
      </div>

      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
        <select
          value={selectedIdx}
          onChange={e => setSelectedIdx(Number(e.target.value))}
          data-testid="select-production-month"
          style={{ width: '160px', border: '1px solid #d1d5db', borderRadius: '6px', padding: '0 10px', fontSize: '12px', height: '36px', cursor: 'pointer', background: '#fff' }}
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
          className="bg-[#fd5108] hover:bg-[#e8490b] text-white h-9 text-[12px] font-normal gap-1.5"
        >
          <FileText size={14} />
          {exporting ? 'Generating…' : 'Export Report'}
        </Button>
      </div>

      {/* Feedmill cards */}
      <div className="production-status-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
        {Object.entries(FEEDMILL_LINES).map(([fm, lines]) => (
          <FeedmillCard
            key={fm}
            fm={fm}
            lines={lines}
            data={breakdown}
            fmStatus={feedmillStatus[fm] || {}}
            onStatusChange={onFeedmillStatusChange}
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
export default function OverviewDashboard({ orders, feedmillStatus = {}, onFeedmillStatusChange }) {
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
  const urgentOrders = orders.filter(order => {
    if (!order.target_avail_date) return false;
    try {
      const d = new Date(order.target_avail_date);
      return !isNaN(d) && d <= twoDaysLater && d >= now;
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
      <div style={{ marginBottom: '0' }}>
        {/* Header */}
        <div
          onClick={handleInsightToggle}
          data-testid="panel-smart-insight-header"
          style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '12px 16px', cursor: 'pointer', userSelect: 'none',
            background: '#f9fafb', border: '1px solid #e5e7eb',
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
            style={{ fontSize: '12px', color: '#fd5108', background: 'none', border: 'none', cursor: isLoadingInsight ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '4px', opacity: isLoadingInsight ? 0.5 : 1, padding: '2px 4px', borderRadius: '4px' }}
            onMouseEnter={e => { if (!isLoadingInsight) e.currentTarget.style.color = '#c2410c'; }}
            onMouseLeave={e => { e.currentTarget.style.color = '#fd5108'; }}
          >
            {isLoadingInsight ? <Loader2 size={12} className="animate-spin" /> : '↻'} Refresh
          </button>
        </div>

        {/* Expanded content */}
        {insightExpanded && (
          <div
            className="smart-insight-content"
            style={{
              background: '#f9fafb', border: '1px solid #e5e7eb', borderTop: 'none',
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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
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
