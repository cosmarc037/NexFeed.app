import { useState, useEffect, useMemo, useRef } from 'react';
import { X, Loader2, AlertTriangle, Info, Plus, ChevronDown, CheckCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { generateOrderImpactAnalysis } from '@/services/azureAI';
import { AIText } from '@/lib/renderAIText';

const BATCH_SIZE_COL = {
  'Line 1': 'batch_size_fm1', 'Line 2': 'batch_size_fm1',
  'Line 3': 'batch_size_fm2', 'Line 4': 'batch_size_fm2',
  'Line 5': 'batch_size_pmx',
  'Line 6': 'batch_size_fm3', 'Line 7': 'batch_size_fm3',
};

const RUN_RATE_COL = {
  'Line 1': 'line_1_run_rate', 'Line 2': 'line_2_run_rate',
  'Line 3': 'line_3_run_rate', 'Line 4': 'line_4_run_rate',
  'Line 5': 'line_5_run_rate',
  'Line 6': 'line_6_run_rate', 'Line 7': 'line_7_run_rate',
};

// App's actual line → feedmill mapping
const LINE_TO_FM = {
  'Line 1': { fmKey: 'FM1', fmName: 'Feedmill 1' },
  'Line 2': { fmKey: 'FM1', fmName: 'Feedmill 1' },
  'Line 3': { fmKey: 'FM2', fmName: 'Feedmill 2' },
  'Line 4': { fmKey: 'FM2', fmName: 'Feedmill 2' },
  'Line 5': { fmKey: 'PMX', fmName: 'Powermix' },
  'Line 6': { fmKey: 'FM3', fmName: 'Feedmill 3' },
  'Line 7': { fmKey: 'FM3', fmName: 'Feedmill 3' },
};

// ─── Insertion position helper (mirrors _calcInsertionPosition in azureAI.js) ──
function computeInsertionPrio(newAvailValue, existingOrders, feedmillLine) {
  const lineOrders = (existingOrders || [])
    .filter(o => o.feedmill_line === feedmillLine && o.status !== 'completed' && o.status !== 'cancel_po')
    .sort((a, b) => (a.priority_seq ?? 999) - (b.priority_seq ?? 999));
  function parseD(val) {
    if (!val || typeof val !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(val)) return null;
    const d = new Date(val); return isNaN(d.getTime()) ? null : d;
  }
  const newDate = parseD(newAvailValue);
  if (newDate) {
    for (let i = 0; i < lineOrders.length; i++) {
      const od = parseD(lineOrders[i].target_avail_date);
      // First non-dated order → dated new order goes before it
      if (!od) return i + 1;
      // First dated order with later date → insert before it
      if (od > newDate) return i + 1;
    }
    // Date >= all existing orders → append at end
    return lineOrders.length + 1;
  }
  // Non-dated new order → append at very bottom
  return lineOrders.length + 1;
}

function fmtConfirmDate(val) {
  if (!val || typeof val !== 'string') return val || '—';
  if (/^\d{4}-\d{2}-\d{2}/.test(val)) {
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  }
  return val;
}

function validate7Digit(val) {
  if (!val) return '';
  return /^\d{7}$/.test(val) ? '' : 'Must be exactly 7 digits';
}

// ─── Confirm Order Dialog ─────────────────────────────────────────────────────
function ConfirmOrderDialog({ orderData, onConfirm, onCancel, isLoading = false }) {
  const { materialCode, itemDescription, form, line, volume, prodHrs, availValue, fg, sfg, pmx, insertionPrio } = orderData;
  const dash = (v) => v ? <span style={{ fontSize: 14, fontWeight: 600, color: '#1a1a1a' }}>{v}</span> : <span style={{ fontSize: 14, color: '#d1d5db' }}>—</span>;
  const Row = ({ label, value }) => (
    <div>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#1a1a1a' }}>{value || '—'}</div>
    </div>
  );
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)' }}
      onClick={e => e.stopPropagation()}
    >
      <div
        style={{ background: 'white', borderRadius: 12, boxShadow: '0 24px 64px rgba(0,0,0,0.2)', width: '100%', maxWidth: 520, padding: '24px 28px' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: '#1a1a1a', margin: 0 }}>Confirm New Order</h3>
            <p style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 0' }}>Please review the details before adding this order.</p>
          </div>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 4 }} data-testid="button-close-confirm">
            <X style={{ width: 16, height: 16 }} />
          </button>
        </div>

        {/* Summary card */}
        <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Row 1 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            <Row label="Material Code" value={materialCode} />
            <Row label="Volume (MT)" value={volume ? `${volume} MT` : '—'} />
          </div>
          {/* Row 2 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            <Row label="Item" value={itemDescription} />
            <Row label="Production Time" value={prodHrs || 'N/A'} />
          </div>
          {/* Row 3 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            <Row label="Form" value={form || '—'} />
            <Row label="Avail Date" value={fmtConfirmDate(availValue)} />
          </div>
          {/* Row 4 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            <Row label="Line" value={line} />
            <Row label="Position" value={`Prio ${insertionPrio}`} />
          </div>
          {/* Planned Orders */}
          <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 12 }}>
            <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 500, marginBottom: 8 }}>Planned Orders</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
              <div>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 2 }}>FG</div>
                {dash(fg)}
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 2 }}>SFG</div>
                {dash(sfg)}
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 2 }}>PMX</div>
                {dash(pmx)}
              </div>
            </div>
          </div>
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button
            onClick={onCancel}
            disabled={isLoading}
            style={{ height: 40, padding: '0 20px', fontSize: 14, fontWeight: 600, background: 'white', border: '1px solid #d1d5db', borderRadius: 6, color: isLoading ? '#9ca3af' : '#374151', cursor: isLoading ? 'not-allowed' : 'pointer', opacity: isLoading ? 0.6 : 1 }}
            data-testid="button-cancel-confirm"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            style={{ height: 40, padding: '0 20px', fontSize: 14, fontWeight: 600, background: isLoading ? '#fe9d72' : '#fd5108', border: 'none', borderRadius: 6, color: 'white', cursor: isLoading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
            data-testid="button-confirm-add"
          >
            {isLoading
              ? <><Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> Adding…</>
              : <><Plus style={{ width: 14, height: 14 }} /> Confirm</>
            }
          </button>
        </div>
      </div>
    </div>
  );
}

function getFPR() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

function getProductLineNums(product) {
  const nums = [];
  for (const [l, col] of Object.entries(RUN_RATE_COL)) {
    if (parseFloat(product[col]) > 0) nums.push(l.replace('Line ', ''));
  }
  return nums;
}

function Section({ title, children }) {
  return (
    <div style={{ border: '1px solid #f3f4f6', borderRadius: 8, padding: 16 }}>
      <h3 style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>
        {title}
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {children}
      </div>
    </div>
  );
}

function Field({ label, required, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>
        {label}{required && <span style={{ color: '#f87171', marginLeft: 2 }}>*</span>}
      </label>
      {children}
    </div>
  );
}

function ReadOnlyValue({ value, placeholder }) {
  return (
    <div style={{ height: 40, padding: '0 12px', border: '1px solid #f3f4f6', borderRadius: 6, display: 'flex', alignItems: 'center', background: '#f9fafb' }}>
      {value != null && value !== ''
        ? <span style={{ fontSize: 14, color: '#2e343a' }}>{value}</span>
        : <span style={{ fontSize: 14, color: '#9ca3af', fontStyle: 'italic' }}>{placeholder || '—'}</span>
      }
    </div>
  );
}

const INPUT_STYLE = {
  width: '100%', height: 40, padding: '0 12px', border: '1px solid #d1d5db',
  borderRadius: 6, fontSize: 14, color: '#2e343a', outline: 'none', background: 'white',
  boxSizing: 'border-box',
};

// ─── Line Recommendation Box ──────────────────────────────────────────────────
function LineLinkBtn({ line, onClick }) {
  return (
    <button
      type="button"
      style={{ fontSize: 12, color: '#fd5108', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontWeight: 500 }}
      onMouseEnter={e => { e.currentTarget.style.textDecoration = 'underline'; e.currentTarget.style.color = '#c2410c'; }}
      onMouseLeave={e => { e.currentTarget.style.textDecoration = 'none'; e.currentTarget.style.color = '#fd5108'; }}
      onClick={() => onClick(line)}
    >{line}</button>
  );
}

function LineRecommendationBox({ selectedProduct, availableLines, runRateInfo, selectedLine, onLineLinkClick }) {
  if (!selectedProduct) return null;

  const fmLines = availableLines;

  // All lines with rate > 0, sorted descending — global comparison
  const allWithRate = Object.entries(runRateInfo)
    .filter(([, r]) => r > 0)
    .sort(([, a], [, b]) => b - a);

  // Scenario F — no rates anywhere
  if (allWithRate.length === 0) {
    return (
      <div style={{ marginTop: 8, background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '12px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <AlertTriangle style={{ width: 13, height: 13, color: '#d97706', marginTop: 1, flexShrink: 0 }} />
          <div style={{ fontSize: 12, color: '#92400e' }}>
            <div style={{ fontWeight: 600 }}>No production history found on any line.</div>
            <div style={{ color: '#6b7280', marginTop: 2 }}>Run rate will need to be manually configured.</div>
          </div>
        </div>
      </div>
    );
  }

  const globalBestRate = allWithRate[0][1];
  const tiedGlobalBest = allWithRate.filter(([, r]) => r === globalBestRate).map(([l]) => l);

  // Feedmill(s) of the global best — lines in the same feedmill as global best are "Also available"
  const recommendedFmKeys = new Set(tiedGlobalBest.map(l => LINE_TO_FM[l]?.fmKey).filter(Boolean));

  // Helper: get label for a cross-feedmill line (outside current feedmill)
  const getCrossFmLabel = (l) => {
    if (tiedGlobalBest.includes(l)) return 'recommended';
    if (recommendedFmKeys.has(LINE_TO_FM[l]?.fmKey)) return 'also-available';
    return 'not-recommended';
  };

  // Lines in / outside current feedmill (with rate > 0), sorted descending
  const withRateInFm = allWithRate.filter(([l]) => fmLines.includes(l)).map(([l, r]) => ({ l, r }));
  const withRateOutside = allWithRate.filter(([l]) => !fmLines.includes(l)).map(([l, r]) => ({ l, r }));

  // Is the global best achievable within the current feedmill?
  const isGlobalBestInFm = tiedGlobalBest.some(l => fmLines.includes(l));

  // ── Scenario G: global best tied and all tied lines are in current feedmill ──
  const allTiedInFm = tiedGlobalBest.length > 1 && tiedGlobalBest.every(l => fmLines.includes(l));
  if (allTiedInFm) {
    return (
      <div style={{ marginTop: 8, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '12px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <Info style={{ width: 13, height: 13, color: '#3b82f6', marginTop: 1, flexShrink: 0 }} />
          <div style={{ fontSize: 12, color: '#1e40af', fontWeight: 600 }}>Both lines are equally recommended:</div>
        </div>
        {tiedGlobalBest.map(l => (
          <div key={l} style={{ paddingLeft: 19, fontSize: 12, color: '#1e40af', marginTop: 4 }}>
            {l} (rate: {runRateInfo[l].toFixed(2)} min/batch)
          </div>
        ))}
        {withRateOutside.length > 0 && (
          <>
            <div style={{ borderTop: '1px dashed #bfdbfe', margin: '8px 0' }} />
            {withRateOutside.map(({ l, r }) => {
              const label = getCrossFmLabel(l);
              return (
                <div key={l} style={{ paddingLeft: 19, marginBottom: 6 }}>
                  <div style={{ fontSize: 12, color: '#4b5563' }}>
                    Also producible on <LineLinkBtn line={l} onClick={onLineLinkClick} /> ({r.toFixed(2)} min/batch)
                  </div>
                  {label === 'not-recommended' && (
                    <div style={{ fontSize: 11, color: '#9f1239', fontStyle: 'italic' }}>— not recommended</div>
                  )}
                  <div style={{ fontSize: 11, color: '#6b7280' }}>Different feedmill — {LINE_TO_FM[l]?.fmName || l}</div>
                </div>
              );
            })}
          </>
        )}
      </div>
    );
  }

  // ── Blue box: global best is within current feedmill (Scenarios A / B / E-single) ──
  if (isGlobalBestInFm) {
    const bestLine = tiedGlobalBest.find(l => fmLines.includes(l));
    const userMatchesBest = selectedLine === bestLine;
    // Same-feedmill lines (rate > 0, not the best) — these are "Also available", NO "not recommended"
    const otherFmLines = withRateInFm.filter(({ l }) => l !== bestLine);

    return (
      <div style={{ marginTop: 8, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '12px 16px' }}>
        {/* Recommended line */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <Info style={{ width: 13, height: 13, color: '#3b82f6', marginTop: 1, flexShrink: 0 }} />
          <div style={{ fontSize: 12, color: '#1e40af', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            Recommended: {bestLine} (rate: {runRateInfo[bestLine].toFixed(2)} min/batch)
            {userMatchesBest && (
              <span style={{ color: '#43a047', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 2 }}>
                <CheckCircle style={{ width: 11, height: 11 }} /> ✓
              </span>
            )}
          </div>
        </div>

        {/* Other same-feedmill lines — "Also available", no "not recommended" */}
        {otherFmLines.length > 0 ? (
          otherFmLines.map(({ l, r }) => (
            <div key={l} style={{ paddingLeft: 19, marginTop: 4 }}>
              <div style={{ fontSize: 12, color: '#4b5563' }}>Also available: {l} ({r.toFixed(2)} min/batch)</div>
            </div>
          ))
        ) : (
          <div style={{ paddingLeft: 19, fontSize: 11, color: '#6b7280', marginTop: 4 }}>
            No other lines available in this feedmill.
          </div>
        )}

        {/* Separator + outside feedmill lines */}
        {withRateOutside.length > 0 && (
          <>
            <div style={{ borderTop: '1px dashed #bfdbfe', margin: '8px 0' }} />
            {withRateOutside.map(({ l, r }) => {
              const label = getCrossFmLabel(l);
              return (
                <div key={l} style={{ paddingLeft: 19, marginBottom: 6 }}>
                  <div style={{ fontSize: 12, color: '#4b5563' }}>
                    Also producible on <LineLinkBtn line={l} onClick={onLineLinkClick} /> ({r.toFixed(2)} min/batch)
                  </div>
                  {label === 'not-recommended' && (
                    <div style={{ fontSize: 11, color: '#9f1239', fontStyle: 'italic' }}>— not recommended</div>
                  )}
                  <div style={{ fontSize: 11, color: '#6b7280' }}>Different feedmill — {LINE_TO_FM[l]?.fmName || l}</div>
                </div>
              );
            })}
          </>
        )}
      </div>
    );
  }

  // ── Amber box: global best is in a DIFFERENT feedmill (Scenarios C / D / no-fm-rates) ──
  const localBest = withRateInFm[0];
  const otherLocalLines = withRateInFm.slice(1);

  return (
    <div style={{ marginTop: 8, background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '12px 16px' }}>
      {/* Current feedmill's best (or no-rate warning) — all local lines are "not recommended" */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <AlertTriangle style={{ width: 13, height: 13, color: '#d97706', marginTop: 1, flexShrink: 0 }} />
        <div style={{ fontSize: 12, color: '#92400e', fontWeight: 600 }}>
          {localBest
            ? (otherLocalLines.length > 0
              ? `Best in this feedmill: ${localBest.l} (${localBest.r.toFixed(2)} min/batch)`
              : `${localBest.l} can produce this product (${localBest.r.toFixed(2)} min/batch)`)
            : `No production history on ${fmLines.join(' or ')}.`}
        </div>
      </div>
      {localBest && (
        <div style={{ paddingLeft: 19, fontSize: 11, color: '#9f1239', fontStyle: 'italic', marginTop: 2 }}>
          — not recommended
        </div>
      )}

      {/* Other local lines — also "not recommended" (different feedmill from global best) */}
      {otherLocalLines.map(({ l, r }) => (
        <div key={l} style={{ paddingLeft: 19, marginTop: 6 }}>
          <div style={{ fontSize: 12, color: '#4b5563' }}>Also available: {l} ({r.toFixed(2)} min/batch)</div>
          <div style={{ fontSize: 11, color: '#9f1239', fontStyle: 'italic' }}>— not recommended</div>
        </div>
      ))}

      {/* Separator + better options in other feedmills */}
      {withRateOutside.length > 0 && (
        <>
          <div style={{ borderTop: '1px dashed #fcd34d', margin: '8px 0' }} />
          <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, marginBottom: 6 }}>Better options in other feedmills:</div>
          {withRateOutside.map(({ l, r }) => {
            const label = getCrossFmLabel(l);
            return (
              <div key={l} style={{ paddingLeft: 0, marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: '#4b5563' }}>
                  <LineLinkBtn line={l} onClick={onLineLinkClick} /> ({r.toFixed(2)} min/batch) — {LINE_TO_FM[l]?.fmName || l}
                </div>
                {label === 'recommended' && (
                  <div style={{ fontSize: 11, color: '#1e40af', fontWeight: 600 }}>— Recommended</div>
                )}
                {label === 'not-recommended' && (
                  <div style={{ fontSize: 11, color: '#9f1239', fontStyle: 'italic' }}>— not recommended</div>
                )}
                {/* label === 'also-available': no sub-label shown */}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// ─── Switch Confirmation Dialog ───────────────────────────────────────────────
function SwitchLineDialog({ targetLine, onConfirm, onCancel }) {
  if (!targetLine) return null;
  const fm = LINE_TO_FM[targetLine]?.fmName || targetLine;
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)' }}
      onClick={onCancel}
    >
      <div
        style={{ background: 'white', borderRadius: 10, boxShadow: '0 16px 48px rgba(0,0,0,0.2)', width: '100%', maxWidth: 400, padding: 24 }}
        onClick={e => e.stopPropagation()}
      >
        <h3 style={{ fontSize: 16, fontWeight: 600, color: '#1a1a1a', marginBottom: 10 }}>Switch to {targetLine}?</h3>
        <p style={{ fontSize: 14, color: '#4b5563', lineHeight: 1.6, marginBottom: 20 }}>
          This will close the current dialog and open a new Add Order dialog on {targetLine} ({fm}) with your current details pre-filled.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <Button variant="outline" style={{ height: 38, padding: '0 18px', fontSize: 14 }} onClick={onCancel}>
            Cancel
          </Button>
          <button
            style={{ height: 38, padding: '0 18px', fontSize: 14, fontWeight: 600, background: '#fd5108', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}
            onClick={onConfirm}
          >
            Switch to {targetLine}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Dialog ──────────────────────────────────────────────────────────────
export default function AddOrderDialog({
  isOpen, onClose, onAdd,
  kbRecords = [], currentOrders = [],
  defaultLine = null, availableLines = [],
  onSwitchLine = null,
  prefillData = null,
}) {
  const [fprValue, setFprValue] = useState(getFPR());
  const [productSearch, setProductSearch] = useState('');
  const [matCodeInput, setMatCodeInput] = useState('');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [volume, setVolume] = useState('');
  const [line, setLine] = useState('');
  const [availType, setAvailType] = useState('');
  const [availDate, setAvailDate] = useState('');
  const [customAvail, setCustomAvail] = useState('');
  const [fg, setFg] = useState('');
  const [sfg, setSfg] = useState('');
  const [pmx, setPmx] = useState('');
  const [impactAnalysis, setImpactAnalysis] = useState(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [switchConfirmLine, setSwitchConfirmLine] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fgError, setFgError] = useState('');
  const [sfgError, setSfgError] = useState('');
  const [pmxError, setPmxError] = useState('');
  const impactTimerRef = useRef(null);
  const dropdownRef = useRef(null);
  const searchRef = useRef(null);

  // KB lookup maps
  const kbByCode = useMemo(() => {
    const m = {};
    for (const r of kbRecords) {
      if (r.fg_material_code) m[String(r.fg_material_code).trim()] = r;
    }
    return m;
  }, [kbRecords]);

  // Products eligible for this feedmill context (run rate > 0 on at least one available line)
  const eligibleProducts = useMemo(() => {
    const lines = availableLines.length ? availableLines : Object.keys(RUN_RATE_COL);
    return kbRecords.filter(r =>
      lines.some(l => {
        const col = RUN_RATE_COL[l];
        return col && parseFloat(r[col]) > 0;
      })
    );
  }, [kbRecords, availableLines]);

  // Products with NO run rate on any line globally — greyed out in dropdown
  const noRateProducts = useMemo(() => {
    return kbRecords.filter(r =>
      !Object.values(RUN_RATE_COL).some(col => parseFloat(r[col]) > 0)
    );
  }, [kbRecords]);

  // Dropdown list (selectable + greyed)
  const dropdownProducts = useMemo(() => {
    if (!showDropdown) return { selectable: [], greyed: [] };
    const q = productSearch.trim().toLowerCase();
    const matches = (r) =>
      (r.fg_item_description || '').toLowerCase().includes(q) ||
      (r.fg_material_code || '').toLowerCase().includes(q);
    const selectable = (q ? eligibleProducts.filter(matches) : eligibleProducts).slice(0, 30);
    const greyed = (q ? noRateProducts.filter(matches) : noRateProducts).slice(0, 10);
    return { selectable, greyed };
  }, [showDropdown, productSearch, eligibleProducts, noRateProducts]);

  // Reset / pre-fill on open
  useEffect(() => {
    if (!isOpen) return;
    setFprValue(prefillData?.fpr || getFPR());
    setVolume(prefillData?.volume || '');
    setAvailType(prefillData?.availType || '');
    setAvailDate(prefillData?.availDate || '');
    setCustomAvail(prefillData?.customAvail || '');
    setFg(prefillData?.fg || '');
    setSfg(prefillData?.sfg || '');
    setPmx(prefillData?.pmx || '');
    setImpactAnalysis(null);
    setImpactLoading(false);
    setShowDropdown(false);
    setSwitchConfirmLine(null);
    setShowConfirm(false);
    setFgError('');
    setSfgError('');
    setPmxError('');

    if (prefillData?.selectedProduct) {
      setSelectedProduct(prefillData.selectedProduct);
      setProductSearch(prefillData.selectedProduct.fg_item_description || '');
      setMatCodeInput(String(prefillData.selectedProduct.fg_material_code || ''));
      setLine(defaultLine || '');
    } else {
      setSelectedProduct(null);
      setProductSearch('');
      setMatCodeInput('');
      setLine(defaultLine || '');
    }
  }, [isOpen]);

  // Clear PMX when switching away from Line 5
  useEffect(() => {
    if (line !== 'Line 5') {
      setPmx('');
      setPmxError('');
    }
  }, [line]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target) &&
        searchRef.current && !searchRef.current.contains(e.target)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Run rates across all lines
  const runRateInfo = useMemo(() => {
    if (!selectedProduct) return {};
    const r = {};
    for (const [l, col] of Object.entries(RUN_RATE_COL)) {
      const v = parseFloat(selectedProduct[col]);
      if (v > 0) r[l] = v;
    }
    return r;
  }, [selectedProduct]);

  // Batch size driven by selected line
  const batchSize = useMemo(() => {
    if (!selectedProduct || !line) return null;
    const bsKey = BATCH_SIZE_COL[line];
    if (!bsKey) return null;
    const val = selectedProduct[bsKey];
    return (val != null && val !== '') ? parseFloat(val) : null;
  }, [selectedProduct, line]);

  const vol = parseFloat(volume) || 0;
  const bs = batchSize || 4;
  const batches = vol > 0 ? Math.ceil(vol / bs) : 0;
  const suggestedVolume = vol > 0 && batchSize ? Math.ceil(vol / batchSize) * batchSize : null;
  const volumeNeedsSuggestion = vol > 0 && batchSize && vol !== suggestedVolume;

  const availValue = (() => {
    if (availType === 'date') return availDate || null;
    if (availType === 'prio replenish') return 'prio replenish';
    if (availType === 'safety stocks') return 'safety stocks';
    if (availType === 'for sched') return 'for sched';
    if (availType === 'custom') return customAvail || null;
    return null;
  })();

  const isComplete = !!(selectedProduct && vol > 0 && line && availValue);

  // ── Product selection ──────────────────────────────────────────────────────
  const clearProduct = () => {
    setSelectedProduct(null);
    setProductSearch('');
    setMatCodeInput('');
  };

  const selectProduct = (product, keepMatCode = false) => {
    setSelectedProduct(product);
    setProductSearch(product.fg_item_description || '');
    if (!keepMatCode) setMatCodeInput(String(product.fg_material_code || ''));
    setShowDropdown(false);

    // Auto-suggest best line (higher rate = better) when not from a specific line tab
    if (!defaultLine) {
      const rates = {};
      for (const [l, col] of Object.entries(RUN_RATE_COL)) {
        const v = parseFloat(product[col]);
        if (v > 0 && availableLines.includes(l)) rates[l] = v;
      }
      const bestLine = Object.entries(rates).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (bestLine) setLine(bestLine);
    }
  };

  // Item description input change — mutual clearing
  const handleProductSearchChange = (val) => {
    setProductSearch(val);
    setShowDropdown(true);
    if (val === '') {
      clearProduct();
    } else if (selectedProduct) {
      setSelectedProduct(null);
      setMatCodeInput('');
    }
  };

  // Material code input change — reverse lookup + mutual clearing
  const handleMatCodeChange = (val) => {
    setMatCodeInput(val);
    if (val === '') {
      clearProduct();
      return;
    }
    if (val.trim().length >= 8) {
      const found = kbByCode[val.trim()];
      if (found) selectProduct(found, true);
    }
  };

  // ── Debounced impact analysis ──────────────────────────────────────────────
  useEffect(() => {
    if (impactTimerRef.current) clearTimeout(impactTimerRef.current);
    if (!isComplete) { setImpactAnalysis(null); setImpactLoading(false); return; }
    setImpactLoading(true);
    setImpactAnalysis(null);
    impactTimerRef.current = setTimeout(async () => {
      try {
        const rr = runRateInfo[line];
        const prodHrs = batchSize && rr ? (vol / rr) : null;
        const newOrderData = {
          item_description: selectedProduct.fg_item_description,
          material_code: selectedProduct.fg_material_code,
          total_volume_mt: vol, feedmill_line: line,
          target_avail_date: availValue, batch_size: bs,
          batches, production_hours: prodHrs,
        };
        const analysis = await generateOrderImpactAnalysis(newOrderData, currentOrders);
        setImpactAnalysis(analysis);
      } catch {
        setImpactAnalysis('Unable to generate impact analysis at this time.');
      } finally {
        setImpactLoading(false);
      }
    }, 1500);
    return () => clearTimeout(impactTimerRef.current);
  }, [isComplete, selectedProduct?.fg_material_code, vol, line, availValue]);

  // ── Manual refresh for impact analysis ────────────────────────────────────
  const refreshImpactAnalysis = async () => {
    if (!isComplete || impactLoading) return;
    if (impactTimerRef.current) clearTimeout(impactTimerRef.current);
    setImpactLoading(true);
    setImpactAnalysis(null);
    try {
      const rr = runRateInfo[line];
      const prodHrs = batchSize && rr ? (vol / rr) : null;
      const newOrderData = {
        item_description: selectedProduct.fg_item_description,
        material_code: selectedProduct.fg_material_code,
        total_volume_mt: vol, feedmill_line: line,
        target_avail_date: availValue, batch_size: bs,
        batches, production_hours: prodHrs,
      };
      const analysis = await generateOrderImpactAnalysis(newOrderData, currentOrders);
      setImpactAnalysis(analysis);
    } catch {
      setImpactAnalysis('Unable to generate impact analysis at this time.');
    } finally {
      setImpactLoading(false);
    }
  };

  // ── Add order — open confirmation dialog first ─────────────────────────────
  const handleAdd = () => {
    if (!isComplete) return;
    // Run validation before showing confirm
    const e1 = validate7Digit(fg);
    const e2 = validate7Digit(sfg);
    const e3 = line === 'Line 5' ? validate7Digit(pmx) : '';
    setFgError(e1); setSfgError(e2); setPmxError(e3);
    if (e1 || e2 || e3) return;
    setShowConfirm(true);
  };

  const handleConfirmAdd = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    const rr = runRateInfo[line];
    const prodHrs = batchSize && rr ? (vol / rr) : null;
    try {
      await onAdd({
        fpr: fprValue,
        material_code: String(selectedProduct.fg_material_code || ''),
        item_description: selectedProduct.fg_item_description || '',
        category: selectedProduct.category || '',
        form: selectedProduct.form || '',
        total_volume_mt: vol, feedmill_line: line,
        target_avail_date: availValue, original_avail_date: availValue,
        batch_size: bs, production_hours: prodHrs,
        changeover_time: 0.17, run_rate: rr || null,
        fg: fg || null, sfg: sfg || null, pmx: pmx || null,
        status: 'plotted',
      });
      setShowConfirm(false);
    } catch {
      // handleAddOrder shows its own error toast; just re-enable the button
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Switch to other line ───────────────────────────────────────────────────
  const handleLineLinkClick = (targetLine) => {
    setSwitchConfirmLine(targetLine);
  };

  const handleConfirmSwitch = () => {
    if (!switchConfirmLine || !onSwitchLine) return;
    const prefilledData = {
      fpr: fprValue,
      selectedProduct,
      volume,
      availType,
      availDate,
      customAvail,
      fg,
      sfg,
      pmx,
    };
    setSwitchConfirmLine(null);
    onClose();
    onSwitchLine(switchConfirmLine, prefilledData);
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)' }}
        data-testid="dialog-add-order"
      >
        <div
          style={{ background: 'white', borderRadius: 12, boxShadow: '0 24px 64px rgba(0,0,0,0.18)', width: '100%', maxWidth: 600, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div style={{ padding: '22px 28px 16px', borderBottom: '1px solid #f3f4f6', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1a1a1a', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Plus style={{ width: 18, height: 18, color: '#fd5108' }} />
                  Add New Order
                </h2>
                <p style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>Manually create a new production order</p>
              </div>
              <button onClick={onClose} style={{ color: '#9ca3af', cursor: 'pointer', background: 'none', border: 'none', padding: 4 }} data-testid="button-close-add-order">
                <X style={{ width: 16, height: 16 }} />
              </button>
            </div>
          </div>

          {/* Scrollable body */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '20px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* ORDER DETAILS */}
            <Section title="Order Details">

              <Field label="FPR">
                <input
                  type="text"
                  style={INPUT_STYLE}
                  value={fprValue}
                  onChange={e => setFprValue(e.target.value)}
                  data-testid="input-fpr"
                />
              </Field>

              {/* Item Description */}
              <Field label="Item Description" required>
                <div style={{ position: 'relative' }}>
                  <input
                    ref={searchRef}
                    type="text"
                    style={{ ...INPUT_STYLE, paddingRight: 32 }}
                    placeholder="Search or select product..."
                    value={productSearch}
                    onChange={e => handleProductSearchChange(e.target.value)}
                    onFocus={() => setShowDropdown(true)}
                    data-testid="input-product-search"
                  />
                  <button
                    type="button"
                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#9ca3af', display: 'flex', alignItems: 'center' }}
                    onClick={() => setShowDropdown(v => !v)}
                    tabIndex={-1}
                  >
                    <ChevronDown style={{ width: 14, height: 14 }} />
                  </button>

                  {showDropdown && (
                    <div ref={dropdownRef} style={{ position: 'absolute', zIndex: 100, top: '100%', left: 0, right: 0, marginTop: 4, background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', maxHeight: 220, overflowY: 'auto' }}>
                      {dropdownProducts.selectable.length === 0 && dropdownProducts.greyed.length === 0 ? (
                        <div style={{ padding: '14px 16px', fontSize: 12, color: '#9ca3af', textAlign: 'center' }}>
                          {eligibleProducts.length === 0
                            ? 'No products found for this line. Try adding from the "All" tab to see all products.'
                            : 'No products match your search.'}
                        </div>
                      ) : (
                        <>
                          {dropdownProducts.selectable.map(p => {
                            const lineNums = getProductLineNums(p);
                            return (
                              <button
                                key={p.fg_material_code}
                                style={{ width: '100%', padding: '10px 14px', textAlign: 'left', background: 'none', border: 'none', borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}
                                onMouseEnter={e => e.currentTarget.style.background = '#f9fafb'}
                                onMouseLeave={e => e.currentTarget.style.background = 'none'}
                                onClick={() => selectProduct(p)}
                                data-testid={`option-product-${p.fg_material_code}`}
                              >
                                <div style={{ fontSize: 13, fontWeight: 500, color: '#1a1a1a' }}>{p.fg_item_description}</div>
                                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                                  {p.fg_material_code}{p.category ? ` · ${p.category}` : ''}{lineNums.length > 0 ? ` · Lines: ${lineNums.join(', ')}` : ''}
                                </div>
                              </button>
                            );
                          })}
                          {dropdownProducts.greyed.length > 0 && (
                            <>
                              <div style={{ padding: '5px 14px 4px', fontSize: 10, color: '#9ca3af', fontStyle: 'italic', borderTop: dropdownProducts.selectable.length > 0 ? '1px solid #e5e7eb' : 'none', background: '#fafafa' }}>
                                Products without production history
                              </div>
                              {dropdownProducts.greyed.map(p => (
                                <div
                                  key={p.fg_material_code}
                                  title="No production history on any line. Update Master Data to enable this product."
                                  style={{ width: '100%', padding: '10px 14px', borderBottom: '1px solid #f3f4f6', cursor: 'not-allowed' }}
                                  data-testid={`option-product-greyed-${p.fg_material_code}`}
                                >
                                  <div style={{ fontSize: 13, fontWeight: 500, color: '#d1d5db' }}>{p.fg_item_description}</div>
                                  <div style={{ fontSize: 11, color: '#d1d5db', marginTop: 2 }}>
                                    {p.fg_material_code}{p.category ? ` · ${p.category}` : ''} · No line available
                                  </div>
                                </div>
                              ))}
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </Field>

              {/* Material Code (FG) + Form */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Material Code (FG)">
                  <input
                    type="text"
                    style={INPUT_STYLE}
                    placeholder="Type to reverse-lookup..."
                    value={matCodeInput}
                    onChange={e => handleMatCodeChange(e.target.value)}
                    data-testid="input-mat-code"
                  />
                </Field>
                <Field label="Form">
                  <ReadOnlyValue value={selectedProduct?.form} placeholder="Auto-populated" />
                </Field>
              </div>

            </Section>

            {/* PRODUCTION PARAMETERS */}
            <Section title="Production Parameters">

              {/* 3-column grid — Row 1: Volume | Batch Size | Batches */}
              {/*                  Row 2: Production Time | Changeover | Run Rate */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', rowGap: 16, columnGap: 16 }}>

                {/* Row 1, Col 1 — Volume */}
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>
                    Volume (MT)<span style={{ color: '#f87171', marginLeft: 2 }}>*</span>
                  </label>
                  <input
                    type="number" min="0" step="any"
                    style={INPUT_STYLE}
                    placeholder="Enter volume..."
                    value={volume}
                    onChange={e => setVolume(e.target.value)}
                    data-testid="input-volume"
                  />
                </div>

                {/* Row 1, Col 2 — Batch Size */}
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Batch Size</label>
                  <div style={{ height: 40, padding: '0 12px', border: '1px solid #e5e7eb', borderRadius: 6, display: 'flex', alignItems: 'center', background: '#f9fafb', cursor: 'default' }}>
                    {batchSize != null
                      ? <span style={{ fontSize: 14, color: '#1a1a1a' }}>{batchSize.toFixed(2)}</span>
                      : null}
                  </div>
                </div>

                {/* Row 1, Col 3 — Batches */}
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Batches</label>
                  <div style={{ height: 40, padding: '0 12px', border: '1px solid #e5e7eb', borderRadius: 6, display: 'flex', alignItems: 'center', background: '#f9fafb', cursor: 'default' }}>
                    {batches > 0
                      ? <span style={{ fontSize: 14, color: '#1a1a1a' }}>{batches}</span>
                      : null}
                  </div>
                </div>

                {/* Row 2, Col 1 — Production Time */}
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Production Time</label>
                  <div style={{ height: 40, padding: '0 12px', border: '1px solid #e5e7eb', borderRadius: 6, display: 'flex', alignItems: 'center', background: '#f9fafb', cursor: 'default' }}>
                    {vol > 0 && runRateInfo[line] != null
                      ? <span style={{ fontSize: 14, color: '#1a1a1a' }}>{(vol / runRateInfo[line]).toFixed(2)} hrs</span>
                      : vol > 0 && line
                      ? <span style={{ fontSize: 14, color: '#9ca3af' }}>—</span>
                      : null}
                  </div>
                  {vol > 0 && line && runRateInfo[line] == null && (
                    <div style={{ fontSize: 10, color: '#9ca3af', fontStyle: 'italic', marginTop: 3 }}>No run rate available</div>
                  )}
                </div>

                {/* Row 2, Col 2 — Changeover */}
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Changeover</label>
                  <div style={{ height: 40, padding: '0 12px', border: '1px solid #e5e7eb', borderRadius: 6, display: 'flex', alignItems: 'center', background: '#f9fafb', cursor: 'default' }}>
                    {selectedProduct
                      ? <span style={{ fontSize: 14, color: '#1a1a1a' }}>0.17 hrs</span>
                      : null}
                  </div>
                </div>

                {/* Row 2, Col 3 — Run Rate */}
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Run Rate</label>
                  <div style={{ height: 40, padding: '0 12px', border: '1px solid #e5e7eb', borderRadius: 6, display: 'flex', alignItems: 'center', background: '#f9fafb', cursor: 'default' }}>
                    {runRateInfo[line] != null
                      ? <span style={{ fontSize: 14, color: '#1a1a1a' }}>{runRateInfo[line].toFixed(2)} MT/hr</span>
                      : selectedProduct && line
                      ? <span style={{ fontSize: 14, color: '#9ca3af' }}>—</span>
                      : null}
                  </div>
                  {selectedProduct && line && runRateInfo[line] == null && (
                    <div style={{ fontSize: 10, color: '#9ca3af', fontStyle: 'italic', marginTop: 3 }}>No run rate for this line</div>
                  )}
                </div>

              </div>

              {/* Divisibility warning — full width below grid */}
              {volumeNeedsSuggestion && suggestedVolume != null && (
                <div style={{ padding: '8px 12px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 6 }}>
                  <p style={{ fontSize: 11, color: '#c2410c', margin: 0 }}>
                    ⚠ {vol} MT is not divisible by batch size {batchSize?.toFixed(2)}. Suggested: <strong>{suggestedVolume} MT</strong> ({Math.ceil(suggestedVolume / batchSize)} batches)
                  </p>
                  <button
                    style={{ fontSize: 11, color: '#fd5108', fontWeight: 600, marginTop: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                    onMouseEnter={e => e.currentTarget.style.textDecoration = 'underline'}
                    onMouseLeave={e => e.currentTarget.style.textDecoration = 'none'}
                    onClick={() => setVolume(String(suggestedVolume))}
                    data-testid="button-use-suggested-volume"
                  >
                    Use {suggestedVolume} MT
                  </button>
                </div>
              )}

            </Section>

            {/* SCHEDULING */}
            <Section title="Scheduling">

              <Field label="Line" required>
                <select
                  style={{ ...INPUT_STYLE, appearance: 'auto' }}
                  value={line}
                  onChange={e => setLine(e.target.value)}
                  data-testid="select-line"
                >
                  <option value="">Select line...</option>
                  {availableLines.map(l => <option key={l} value={l}>{l}</option>)}
                </select>

                <LineRecommendationBox
                  selectedProduct={selectedProduct}
                  availableLines={availableLines}
                  runRateInfo={runRateInfo}
                  selectedLine={line}
                  onLineLinkClick={handleLineLinkClick}
                />
              </Field>

              <Field label="Availability" required>
                <select
                  style={{ ...INPUT_STYLE, appearance: 'auto' }}
                  value={availType}
                  onChange={e => setAvailType(e.target.value)}
                  data-testid="select-availability"
                >
                  <option value="">Select type...</option>
                  <option value="date">Set specific date...</option>
                  <option value="prio replenish">Prio replenish</option>
                  <option value="safety stocks">Safety stocks</option>
                  <option value="for sched">For sched</option>
                  <option value="custom">Custom text...</option>
                </select>
                {availType === 'date' && (
                  <input type="date" min={new Date().toISOString().slice(0, 10)} style={{ ...INPUT_STYLE, marginTop: 8 }} value={availDate} onChange={e => setAvailDate(e.target.value)} data-testid="input-avail-date" />
                )}
                {availType === 'custom' && (
                  <input type="text" style={{ ...INPUT_STYLE, marginTop: 8 }} placeholder="Enter custom availability..." value={customAvail} onChange={e => setCustomAvail(e.target.value)} data-testid="input-avail-custom" />
                )}
              </Field>

            </Section>

            {/* PLANNED ORDERS */}
            <Section title="Planned Orders (Optional)">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
                {/* FG */}
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Finished Goods (FG)</label>
                  <input
                    type="text" maxLength={7}
                    style={{ ...INPUT_STYLE, borderColor: fgError ? '#e53935' : '#d1d5db' }}
                    placeholder="Enter 7 digits"
                    value={fg}
                    onChange={e => { setFg(e.target.value); setFgError(validate7Digit(e.target.value)); }}
                    data-testid="input-fg"
                  />
                  {fgError && <div style={{ fontSize: 10, color: '#e53935', fontStyle: 'italic', marginTop: 3 }}>{fgError}</div>}
                </div>
                {/* SFG */}
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Semi-Finished Goods (SFG)</label>
                  <input
                    type="text" maxLength={7}
                    style={{ ...INPUT_STYLE, borderColor: sfgError ? '#e53935' : '#d1d5db' }}
                    placeholder="Enter 7 digits"
                    value={sfg}
                    onChange={e => { setSfg(e.target.value); setSfgError(validate7Digit(e.target.value)); }}
                    data-testid="input-sfg"
                  />
                  {sfgError && <div style={{ fontSize: 10, color: '#e53935', fontStyle: 'italic', marginTop: 3 }}>{sfgError}</div>}
                </div>
                {/* PMX — only enabled on Line 5 */}
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Powermix (PMX)</label>
                  <input
                    type="text" maxLength={7}
                    disabled={line !== 'Line 5'}
                    title={line !== 'Line 5' ? 'Powermix is only applicable for Line 5' : undefined}
                    style={{
                      ...INPUT_STYLE,
                      background: line !== 'Line 5' ? '#f3f4f6' : 'white',
                      borderColor: pmxError ? '#e53935' : (line !== 'Line 5' ? '#e5e7eb' : '#d1d5db'),
                      color: line !== 'Line 5' ? '#d1d5db' : '#2e343a',
                      cursor: line !== 'Line 5' ? 'not-allowed' : 'text',
                      fontStyle: line !== 'Line 5' ? 'italic' : 'normal',
                    }}
                    placeholder={line !== 'Line 5' ? 'Line 5 only' : 'Enter 7 digits'}
                    value={pmx}
                    onChange={e => { setPmx(e.target.value); setPmxError(validate7Digit(e.target.value)); }}
                    data-testid="input-pmx"
                  />
                  {pmxError && <div style={{ fontSize: 10, color: '#e53935', fontStyle: 'italic', marginTop: 3 }}>{pmxError}</div>}
                </div>
              </div>
            </Section>

            {/* IMPACT ANALYSIS */}
            <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '16px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, color: '#1a1a1a', margin: 0 }}>🤖 Impact Analysis</h3>
                {isComplete && (
                  <button
                    onClick={refreshImpactAnalysis}
                    disabled={impactLoading}
                    title="Refresh impact analysis"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      background: 'none', border: 'none', borderRadius: 5,
                      padding: '3px 0', cursor: impactLoading ? 'not-allowed' : 'pointer',
                      color: impactLoading ? '#d1d5db' : '#fd5108',
                      fontSize: 11, fontWeight: 500,
                    }}
                    data-testid="button-refresh-impact"
                  >
                    <RefreshCw style={{ width: 11, height: 11 }} className={impactLoading ? 'animate-spin' : ''} />
                    Refresh
                  </button>
                )}
              </div>
              {!isComplete ? (
                <p style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.6, margin: 0 }}>
                  Fill in the required fields above to see the impact analysis for this new order.
                </p>
              ) : impactLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Loader2 style={{ width: 14, height: 14, color: '#fd5108' }} className="animate-spin" />
                  <span style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>Analyzing impact...</span>
                </div>
              ) : impactAnalysis ? (
                <AIText
                  text={impactAnalysis}
                  fontSize={12}
                  color="#4b5563"
                  lineHeight={1.7}
                  gap={6}
                />
              ) : null}
            </div>

          </div>

          {/* Footer */}
          <div style={{ padding: '14px 28px', borderTop: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, flexShrink: 0, background: 'white' }}>
            <Button variant="outline" style={{ height: 40, padding: '0 20px', fontSize: 14, fontWeight: 600 }} onClick={onClose} data-testid="button-cancel-add-order">
              Cancel
            </Button>
            <button
              onClick={isComplete ? handleAdd : undefined}
              disabled={!isComplete}
              style={{
                height: 40, padding: '0 20px', fontSize: 14, fontWeight: 600, borderRadius: 6, border: 'none',
                background: isComplete ? '#fd5108' : '#f3f4f6',
                color: isComplete ? 'white' : '#d1d5db',
                cursor: isComplete ? 'pointer' : 'not-allowed',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
              data-testid="button-confirm-add-order"
            >
              <Plus style={{ width: 14, height: 14 }} />
              Add Order
            </button>
          </div>
        </div>
      </div>

      {/* Switch line confirmation dialog */}
      {switchConfirmLine && (
        <SwitchLineDialog
          targetLine={switchConfirmLine}
          onConfirm={handleConfirmSwitch}
          onCancel={() => setSwitchConfirmLine(null)}
        />
      )}

      {showConfirm && (() => {
        const rr = runRateInfo[line];
        const prodHrsVal = batchSize && rr ? `${(vol / rr).toFixed(2)} hrs` : 'N/A';
        const insertionPrio = computeInsertionPrio(availValue, currentOrders, line);
        return (
          <ConfirmOrderDialog
            orderData={{
              materialCode: String(selectedProduct?.fg_material_code || ''),
              itemDescription: selectedProduct?.fg_item_description || '',
              form: selectedProduct?.form || '',
              line, volume: vol,
              prodHrs: prodHrsVal,
              availValue, fg, sfg, pmx, insertionPrio,
            }}
            onConfirm={handleConfirmAdd}
            onCancel={() => { if (!isSubmitting) setShowConfirm(false); }}
            isLoading={isSubmitting}
          />
        );
      })()}
    </>
  );
}
