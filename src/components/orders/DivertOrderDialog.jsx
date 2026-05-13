import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { generateDiversionImpact } from '@/services/azureAI';

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
export function DivertOrderDialog({ order, allOrders, kbRecords, feedmillStatus, lineShutdowns = {}, onConfirm, onClose }) {
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

  // Partner lines: same feedmill, not shutdown, not this line, any rate
  const partnerLineObjects = currentFMLines
    .filter(l => l !== currentLine && !allShutdownLines.includes(l))
    .map(l => ({ line: l, rate: parseFloat(kbEntry?.[LINE_RATE_KEY[l]] || 0), isPartner: true }));

  // Outside lines: different feedmill, not shutdown, has rate > 0
  const outsideLineObjects = Object.entries(LINE_RATE_KEY)
    .map(([line, key]) => ({ line, rate: parseFloat(kbEntry?.[key] || 0), isPartner: false }))
    .filter(({ line, rate }) => !currentFMLines.includes(line) && !allShutdownLines.includes(line) && rate > 0)
    .sort((a, b) => b.rate - a.rate);

  // Show partner lines first, then outside lines
  const availableLines = [...partnerLineObjects, ...outsideLineObjects];

  const [selectedLine, setSelectedLine] = useState(availableLines[0] || null);
  const [aiText, setAiText] = useState('');
  const [loadingAI, setLoadingAI] = useState(false);

  const volume = parseFloat(order.total_volume_mt || order.volume || 0);
  const originalRate = parseFloat(order.run_rate || 0);

  const buildCalcs = useCallback((line) => {
    if (!line) return null;
    const newProdTime = line.rate > 0 ? volume / line.rate : null;
    const origProdTime = originalRate > 0 ? volume / originalRate : null;
    const targetLineOrders = (allOrders || []).filter(
      o => (o.feedmill_line || o.line) === line.line && !['done', 'completed', 'cancel_po'].includes((o.status || '').toLowerCase())
    );
    return {
      originalRate,
      newProductionTime: newProdTime?.toFixed(2),
      originalProductionTime: origProdTime?.toFixed(2),
      insertPosition: targetLineOrders.length + 1,
      ordersShifted: 0,
    };
  }, [allOrders, originalRate, volume]);

  const generateAI = useCallback(async (line) => {
    if (!line) return;
    setLoadingAI(true);
    setAiText('');
    const calcs = buildCalcs(line);
    try {
      const result = await generateDiversionImpact(order, line, calcs || {});
      setAiText(result);
    } catch {
      setAiText('Unable to generate impact analysis.');
    }
    setLoadingAI(false);
  }, [order, buildCalcs]);

  useEffect(() => {
    if (selectedLine) generateAI(selectedLine);
  }, []);

  const handleSelectLine = (line) => {
    setSelectedLine(line);
    generateAI(line);
  };

  const handleConfirm = () => {
    if (!selectedLine) return;
    const calcs = buildCalcs(selectedLine);
    onConfirm(order, selectedLine, calcs, aiText);
  };

  const calcs = buildCalcs(selectedLine);

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div style={{ background: 'var(--color-bg-secondary)', borderRadius: '12px', width: '100%', maxWidth: '600px', maxHeight: '80vh', overflowY: 'auto', padding: '24px 28px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        {/* Title */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '18px' }}>🔄</span>
            <span style={{ fontSize: '16px', fontWeight: 700, color: '#1a1a1a' }}>Divert Order</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '18px', color: '#9ca3af', cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>

        {/* Order Summary */}
        <div style={{ background: 'var(--color-bg-tertiary)', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '14px 18px', marginBottom: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: '#6b7280', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Order Summary</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
            {[
              ['Material Code', order.material_code || '—'],
              ['Volume', `${volume.toLocaleString(undefined, { maximumFractionDigits: 1 })} MT`],
              ['Item', (order.item_description || '—').substring(0, 28)],
              ['Batches', order.batch_size ? Math.ceil(volume / order.batch_size) : '—'],
              ['Form', order.form || '—'],
              ['Prod Time', originalRate > 0 ? `${(volume / originalRate).toFixed(2)}h` : '—'],
              ['Current Line', null],
              ['Avail Date', order.target_avail_date || order.avail_date || '—'],
            ].map(([label, val], i) => (
              <div key={i}>
                <span style={{ fontSize: '11px', color: '#6b7280' }}>{label}: </span>
                {label === 'Current Line' ? (
                  <>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: '#1a1a1a' }}>{currentLine} </span>
                    <span style={{ fontSize: '9px', fontWeight: 700, color: '#e53935', background: '#fef2f2', padding: '1px 6px', borderRadius: '3px' }}>SHUTDOWN</span>
                  </>
                ) : (
                  <span style={{ fontSize: '12px', fontWeight: 600, color: '#1a1a1a' }}>{val}</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Available Lines */}
        <div style={{ border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden', marginBottom: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: '#6b7280', padding: '10px 18px 6px', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #f3f4f6' }}>Available Lines</div>
          {availableLines.length === 0 ? (
            <div style={{ padding: '16px 18px', fontSize: '12px', color: '#9ca3af', fontStyle: 'italic' }}>No alternative lines found in Master Data.</div>
          ) : (
            availableLines.map((lineObj, idx) => {
              const isSelected = selectedLine?.line === lineObj.line;
              const isPartner = lineObj.isPartner;
              const fm = LINE_FEEDMILL[lineObj.line] || '';
              const fmLabel = fm === 'PMX' ? 'Powermix' : fm ? `Feedmill ${fm.replace('FM', '')}` : '';
              const accentColor = isPartner ? '#f59e0b' : '#10b981';
              const selectedBg = isPartner ? '#fffbeb' : '#f0fdf4';
              return (
                <div key={lineObj.line}>
                  {idx > 0 && <div style={{ borderTop: '1px solid #f3f4f6' }} />}
                  <div
                    onClick={() => handleSelectLine(lineObj)}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '12px 18px', cursor: 'pointer',
                      borderLeft: `3px solid ${isSelected ? accentColor : isPartner ? '#fcd34d' : '#e5e7eb'}`,
                      background: isSelected ? selectedBg : isPartner ? '#fffef7' : 'var(--color-bg-secondary)',
                    }}
                  >
                    <div style={{ marginTop: '2px', flexShrink: 0 }}>
                      <div style={{ width: '14px', height: '14px', borderRadius: '50%', border: `2px solid ${isSelected ? accentColor : '#d1d5db'}`, background: isSelected ? accentColor : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {isSelected && <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: 'var(--color-bg-secondary)' }} />}
                      </div>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                        {isPartner && <span style={{ fontSize: '11px' }}>⭐</span>}
                        <span style={{ fontSize: '12px', fontWeight: isPartner ? 600 : 500, color: isPartner ? '#92400e' : '#374151' }}>
                          {lineObj.line} {lineObj.rate > 0 ? `(rate: ${lineObj.rate.toFixed(2)} MT/hr)` : '(no rate on record)'}
                        </span>
                        {isPartner && (
                          <span style={{ fontSize: '9px', fontWeight: 700, color: '#b45309', background: '#fef3c7', padding: '1px 5px', borderRadius: '3px' }}>RECOMMENDED</span>
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: '#6b7280' }}>
                        {fmLabel}
                        {isPartner ? ' · Same feedmill — generally compatible' : ''}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Impact Analysis */}
        <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: '8px', padding: '14px 18px', marginBottom: '20px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: '#92400e', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>🤖 Impact Analysis</div>
          {calcs && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px', marginBottom: '10px' }}>
              <div style={{ fontSize: '11px', color: '#78350f' }}>Insertion Position: <strong>Priority {calcs.insertPosition}</strong></div>
              <div style={{ fontSize: '11px', color: '#78350f' }}>Production Time: <strong>{calcs.newProductionTime}h</strong> (was {calcs.originalProductionTime}h)</div>
            </div>
          )}
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
          <button onClick={onClose} style={{ padding: '8px 18px', fontSize: '13px', color: '#374151', background: 'var(--color-bg-secondary)', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer' }}>Cancel</button>
          <button
            onClick={handleConfirm}
            disabled={!selectedLine || availableLines.length === 0}
            style={{ padding: '8px 18px', fontSize: '13px', fontWeight: 600, color: '#1a1a1a', background: !selectedLine || availableLines.length === 0 ? '#e5e7eb' : '#eab308', border: 'none', borderRadius: '6px', cursor: !selectedLine || availableLines.length === 0 ? 'not-allowed' : 'pointer' }}
          >
            Confirm Diversion
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── REVERT ORDER DIALOG ──────────────────────────────────────────────────────
export function RevertOrderDialog({ order, feedmillStatus, lineShutdowns, onConfirm, onClose }) {
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

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div style={{ background: 'var(--color-bg-secondary)', borderRadius: '12px', width: '100%', maxWidth: '480px', padding: '24px 28px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
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
          <button onClick={onClose} style={{ padding: '8px 18px', fontSize: '13px', color: '#374151', background: 'var(--color-bg-secondary)', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer' }}>Cancel</button>
          <button
            onClick={() => !blockMessage && onConfirm(order)}
            disabled={!!blockMessage}
            style={{ padding: '8px 18px', fontSize: '13px', fontWeight: 600, color: '#fff', background: blockMessage ? '#9ca3af' : '#16a34a', border: 'none', borderRadius: '6px', cursor: blockMessage ? 'not-allowed' : 'pointer', opacity: blockMessage ? 0.7 : 1 }}
          >
            Confirm Revert
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
