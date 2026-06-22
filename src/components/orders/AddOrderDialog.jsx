import { useState, useEffect, useMemo, useRef } from 'react';
import { X, Loader2, AlertTriangle, Info, Plus, ChevronDown, CheckCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { generateOrderImpactAnalysis, generateInsertionPlacement } from '@/services/azureAI';
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

// Build the active-order lineup for a line in the shape the shared AI insertion
// engine expects (sorted by priority_seq, sub-orders + completed/cancelled
// excluded). Mirrors the lineup basis used by the apply layer so the reviewed
// position maps to the same slot at confirm time.
function buildInsertionLineup(existingOrders, feedmillLine, excludeId = null) {
  return (existingOrders || [])
    .filter(o => o.feedmill_line === feedmillLine
      && o.id !== excludeId
      && !o.parent_id
      && o.status !== 'completed' && o.status !== 'cancel_po')
    .slice()
    .sort((a, b) => (a.priority_seq ?? 9999) - (b.priority_seq ?? 9999))
    .map(o => ({
      id: o.id, fpr: o.fpr, item_description: o.item_description,
      volume: o.volume_override ?? o.total_volume_mt ?? 0,
      production_hours: o.production_hours,
      changeover_time: o.changeover_time,
      target_avail_date: o.target_avail_date,
      avail_date: o.avail_date,
      start_date: o.start_date,
      target_completion_date: o.target_completion_date,
      priority_seq: o.priority_seq,
    }));
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
    <div className="aod-section" style={{ border: '1px solid #f3f4f6', borderRadius: 8, padding: 16 }}>
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
    <div className="aod-readonly" style={{ height: 40, padding: '0 12px', border: '1px solid #f3f4f6', borderRadius: 6, display: 'flex', alignItems: 'center', background: 'var(--color-bg-tertiary)' }}>
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
      style={{ fontSize: 12, color: 'var(--nexfeed-primary)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontWeight: 500 }}
      onMouseEnter={e => { e.currentTarget.style.textDecoration = 'underline'; e.currentTarget.style.color = '#c2410c'; }}
      onMouseLeave={e => { e.currentTarget.style.textDecoration = 'none'; e.currentTarget.style.color = 'var(--nexfeed-primary)'; }}
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
      <div className="aod-rec-box aod-rec-amber" style={{ marginTop: 8, background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '12px 16px' }}>
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
      <div className="aod-rec-box aod-rec-blue" style={{ marginTop: 8, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '12px 16px' }}>
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
      <div className="aod-rec-box aod-rec-blue" style={{ marginTop: 8, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '12px 16px' }}>
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
    <div className="aod-rec-box aod-rec-amber" style={{ marginTop: 8, background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '12px 16px' }}>
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
            style={{ height: 38, padding: '0 18px', fontSize: 14, fontWeight: 600, background: 'var(--nexfeed-primary)', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [aiPlacement, setAiPlacement] = useState(null);
  const [aiPlacementLoading, setAiPlacementLoading] = useState(false);
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

  // Products eligible for this feedmill context (run rate > 0 on at least one available line,
  // OR Mash form — Mash orders don't require a run rate and can go on any line except Line 5)
  const eligibleProducts = useMemo(() => {
    const lines = availableLines.length ? availableLines : Object.keys(RUN_RATE_COL);
    return kbRecords.filter(r => {
      const form = (r.form || r['Form'] || '').trim();
      if (form.match(/^m(ash)?$/i)) return true; // Mash always eligible
      return lines.some(l => {
        const col = RUN_RATE_COL[l];
        return col && parseFloat(r[col]) > 0;
      });
    });
  }, [kbRecords, availableLines]);

  // Products with NO run rate on any line globally — greyed out in dropdown.
  // Mash products are excluded here because they are always in eligibleProducts above.
  const noRateProducts = useMemo(() => {
    return kbRecords.filter(r => {
      const form = (r.form || r['Form'] || '').trim();
      if (form.match(/^m(ash)?$/i)) return false; // Mash appears in eligible, not greyed
      return !Object.values(RUN_RATE_COL).some(col => parseFloat(r[col]) > 0);
    });
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
    setAiPlacement(null);
    setAiPlacementLoading(false);
    setShowDropdown(false);
    setSwitchConfirmLine(null);
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

  // Run rates across all lines (from KB product record). Declared before the
  // effects below that read it, otherwise the const is in its temporal dead zone
  // when those effects run (crashes with "Cannot access 'runRateInfo' before initialization").
  const runRateInfo = useMemo(() => {
    if (!selectedProduct) return {};
    const r = {};
    for (const [l, col] of Object.entries(RUN_RATE_COL)) {
      const v = parseFloat(selectedProduct[col]);
      if (v > 0) r[l] = v;
    }
    return r;
  }, [selectedProduct]);

  // Effective run rate: strictly the selected line's KB rate — no cross-line borrowing.
  // If the selected line has no historical run rate for this product, effectiveRunRate is null.
  const effectiveRunRate = (line && runRateInfo[line] != null) ? runRateInfo[line] : null;

  // Auto-clear the selected line if the current product has no run rate on it.
  // Prevents a pre-selected line from silently remaining invalid after product changes.
  useEffect(() => {
    if (!selectedProduct) return;
    // If the current line has no run rate for this product, switch to the best
    // available line instead of clearing to blank — so the recommendation is
    // auto-selected rather than leaving the dropdown empty.
    if (line && runRateInfo[line] == null) {
      const rates = {};
      for (const [l, col] of Object.entries(RUN_RATE_COL)) {
        const v = parseFloat(selectedProduct[col]);
        if (v > 0 && availableLines.includes(l)) rates[l] = v;
      }
      const best = Object.entries(rates).sort((a, b) => b[1] - a[1])[0]?.[0];
      setLine(best || '');
    }
    // No existing line — also try to auto-select the best line.
    if (!line) {
      const rates = {};
      for (const [l, col] of Object.entries(RUN_RATE_COL)) {
        const v = parseFloat(selectedProduct[col]);
        if (v > 0 && availableLines.includes(l)) rates[l] = v;
      }
      const best = Object.entries(rates).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (best) setLine(best);
    }
  }, [selectedProduct?.fg_material_code]);

  // Debug: line-specific run-rate source logging
  useEffect(() => {
    if (!selectedProduct || !line) return;
    const displayedRunRate = runRateInfo[line] ?? null;
    const displayedRunRateSourceLine = displayedRunRate != null ? line : null;
    const productId = selectedProduct.fg_material_code;
    console.debug('[Add Order Line-Specific Run Rate]', {
      productId, selectedLine: line,
      displayedRunRate, displayedRunRateSourceLine,
      usesSelectedLineRate: line === displayedRunRateSourceLine,
    });
    console.debug('[Add Order Invalid Cross-Line Rate Check]', {
      productId, selectedLine: line,
      displayedRunRateSourceLine,
      invalidCrossLineRateUsed: false,
    });
  }, [selectedProduct?.fg_material_code, line]);

  // Debug: which lines are disabled due to no historical run rate
  useEffect(() => {
    if (!selectedProduct) return;
    const productId = selectedProduct.fg_material_code;
    const selectableLines = availableLines.filter(l => runRateInfo[l] != null);
    const disabledLines = availableLines.filter(l => runRateInfo[l] == null);
    console.debug('[Add Order Disabled Invalid Lines]', {
      productId, selectableLines, disabledLines,
      disabledBecauseNoHistoricalRunRate: true,
    });
  }, [selectedProduct?.fg_material_code, availableLines, runRateInfo]);

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

  // Mash products (Form = 'M') skip the pellet mill and can run on any line except Line 5
  const isMashProduct = !!(selectedProduct && (selectedProduct.form || selectedProduct['Form'] || '').trim().match(/^m(ash)?$/i));

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
        const rr = effectiveRunRate;
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
      const rr = effectiveRunRate;
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

  // ── AI insertion placement ─────────────────────────────────────────────────
  // Runs as soon as the form is complete so the recommendation is already
  // resolved when the user clicks Add Order. The result is shown in the first
  // modal and passed directly to onAdd — no second confirmation step.
  useEffect(() => {
    if (!isComplete || !selectedProduct || !line) return;
    let cancelled = false;
    const rr = effectiveRunRate;
    const prodHrs = batchSize && rr ? (vol / rr) : null;
    const orderForAI = {
      item_description: selectedProduct.fg_item_description,
      fpr: fprValue,
      feedmill_line: line,
      total_volume_mt: vol,
      batch_size: bs,
      run_rate: rr || null,
      production_hours: prodHrs,
      form: selectedProduct.form || null,
      target_avail_date: availValue,
    };
    const lineup = buildInsertionLineup(currentOrders, line);
    setAiPlacement(null);
    setAiPlacementLoading(true);
    generateInsertionPlacement('add', orderForAI, lineup, { lineName: line })
      .then((res) => {
        if (cancelled) return;
        if (res && !res.error) {
          setAiPlacement(res);
          console.debug('[AI Insertion Recommendation]', {
            modalType: 'add',
            orderId: 'new',
            targetLine: line,
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
      })
      .catch((err) => { if (!cancelled) setAiPlacement({ error: err?.message || 'AI placement failed' }); })
      .finally(() => { if (!cancelled) setAiPlacementLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isComplete, line, vol, availValue, selectedProduct?.fg_material_code]);

  // ── Add order — single-step: review in first modal, submit directly ────────
  // The second "Confirm New Order" modal has been removed. The first modal is
  // now the single source of truth for the insertion position and impact analysis.
  const handleAdd = async () => {
    if (!isComplete || isSubmitting) return;
    const e1 = validate7Digit(fg);
    const e2 = validate7Digit(sfg);
    const e3 = line === 'Line 5' ? validate7Digit(pmx) : '';
    setFgError(e1); setSfgError(e2); setPmxError(e3);
    if (e1 || e2 || e3) return;
    setIsSubmitting(true);
    const rr = effectiveRunRate;
    const prodHrs = batchSize && rr ? (vol / rr) : null;
    const reviewedAiPlacement = aiPlacement && !aiPlacement.error ? aiPlacement : null;
    console.debug('[Add Order Flow Simplified]', {
      secondConfirmationModalRemoved: true,
      firstModalContainsInsertionPosition: true,
      firstModalContainsImpactAnalysis: true,
    });
    try {
      await onAdd({
        fpr: fprValue,
        material_code: String(selectedProduct.fg_material_code || ''),
        item_description: selectedProduct.fg_item_description || '',
        category: selectedProduct.category || '',
        color: selectedProduct.color || '',
        form: selectedProduct.form || '',
        diameter: selectedProduct.diameter != null && selectedProduct.diameter !== "" ? parseFloat(selectedProduct.diameter) : null,
        total_volume_mt: vol, feedmill_line: line,
        target_avail_date: availValue, original_avail_date: availValue,
        batch_size: bs, production_hours: prodHrs,
        changeover_time: selectedProduct?.changeover != null && selectedProduct.changeover !== "" ? parseFloat(selectedProduct.changeover) || 0.17 : 0.17,
        run_rate: rr || null,
        fg: fg || null, sfg: sfg || null, pmx: pmx || null,
        status: 'plotted',
      }, reviewedAiPlacement);
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
          className="add-order-dialog"
          style={{ background: 'white', borderRadius: 12, boxShadow: '0 24px 64px rgba(0,0,0,0.18)', width: '100%', maxWidth: 600, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div style={{ padding: '22px 28px 16px', borderBottom: '1px solid #f3f4f6', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1a1a1a', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Plus style={{ width: 18, height: 18, color: 'var(--nexfeed-primary)' }} />
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
                    <div ref={dropdownRef} className="aod-product-dropdown" style={{ position: 'absolute', zIndex: 100, top: '100%', left: 0, right: 0, marginTop: 4, background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', maxHeight: 220, overflowY: 'auto' }}>
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
                                onMouseEnter={e => e.currentTarget.style.background = 'var(--color-hover-bg)'}
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
                              <div style={{ padding: '5px 14px 4px', fontSize: 10, color: '#9ca3af', fontStyle: 'italic', borderTop: dropdownProducts.selectable.length > 0 ? '1px solid #e5e7eb' : 'none', background: 'var(--color-bg-tertiary)' }}>
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
                  <div className="aod-readonly-field" style={{ height: 40, padding: '0 12px', border: '1px solid #e5e7eb', borderRadius: 6, display: 'flex', alignItems: 'center', background: 'var(--color-bg-tertiary)', cursor: 'default' }}>
                    {batchSize != null
                      ? <span style={{ fontSize: 14, color: '#1a1a1a' }}>{batchSize.toFixed(2)}</span>
                      : null}
                  </div>
                </div>

                {/* Row 1, Col 3 — Batches */}
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Batches</label>
                  <div className="aod-readonly-field" style={{ height: 40, padding: '0 12px', border: '1px solid #e5e7eb', borderRadius: 6, display: 'flex', alignItems: 'center', background: 'var(--color-bg-tertiary)', cursor: 'default' }}>
                    {batches > 0
                      ? <span style={{ fontSize: 14, color: '#1a1a1a' }}>{batches}</span>
                      : null}
                  </div>
                </div>

                {/* Row 2, Col 1 — Production Time */}
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Production Time</label>
                  <div className="aod-readonly-field" style={{ height: 40, padding: '0 12px', border: '1px solid #e5e7eb', borderRadius: 6, display: 'flex', alignItems: 'center', background: 'var(--color-bg-tertiary)', cursor: 'default' }}>
                    {vol > 0 && effectiveRunRate != null
                      ? <span style={{ fontSize: 14, color: '#1a1a1a' }}>{(vol / effectiveRunRate).toFixed(2)} hrs</span>
                      : vol > 0 && line
                      ? <span style={{ fontSize: 14, color: '#9ca3af' }}>—</span>
                      : null}
                  </div>
                  {vol > 0 && line && effectiveRunRate == null && (
                    <div style={{ fontSize: 10, color: '#9ca3af', fontStyle: 'italic', marginTop: 3 }}>No run rate for this line</div>
                  )}
                </div>

                {/* Row 2, Col 2 — Changeover */}
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Changeover</label>
                  <div className="aod-readonly-field" style={{ height: 40, padding: '0 12px', border: '1px solid #e5e7eb', borderRadius: 6, display: 'flex', alignItems: 'center', background: 'var(--color-bg-tertiary)', cursor: 'default' }}>
                    {selectedProduct
                      ? <span style={{ fontSize: 14, color: '#1a1a1a' }}>
                          {selectedProduct.changeover != null && selectedProduct.changeover !== ""
                            ? `${parseFloat(selectedProduct.changeover) || 0.17} hrs`
                            : '0.17 hrs'}
                        </span>
                      : null}
                  </div>
                </div>

                {/* Row 2, Col 3 — Run Rate */}
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Run Rate</label>
                  <div className="aod-readonly-field" style={{ height: 40, padding: '0 12px', border: '1px solid #e5e7eb', borderRadius: 6, display: 'flex', alignItems: 'center', background: 'var(--color-bg-tertiary)', cursor: 'default' }}>
                    {effectiveRunRate != null && selectedProduct && line
                      ? <span style={{ fontSize: 14, color: '#1a1a1a' }}>{effectiveRunRate.toFixed(2)} min/batch</span>
                      : selectedProduct && line
                      ? <span style={{ fontSize: 14, color: '#9ca3af' }}>—</span>
                      : null}
                  </div>
                  {selectedProduct && line && effectiveRunRate == null && (
                    <div style={{ fontSize: 10, color: '#9ca3af', fontStyle: 'italic', marginTop: 3 }}>No run rate for this line</div>
                  )}
                </div>

              </div>

              {/* Divisibility warning — full width below grid */}
              {volumeNeedsSuggestion && suggestedVolume != null && (
                <div className="aod-divisibility-warn" style={{ padding: '8px 12px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 6 }}>
                  <p style={{ fontSize: 11, color: '#c2410c', margin: 0 }}>
                    ⚠ {vol} MT is not divisible by batch size {batchSize?.toFixed(2)}. Suggested: <strong>{suggestedVolume} MT</strong> ({Math.ceil(suggestedVolume / batchSize)} batches)
                  </p>
                  <button
                    style={{ fontSize: 11, color: 'var(--nexfeed-primary)', fontWeight: 600, marginTop: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
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
                  {availableLines.map(l => {
                    const isLine5 = l === 'Line 5';
                    // Mash exception: enabled on all lines except Line 5 (no pellet mill needed)
                    const hasRate = !selectedProduct
                      ? true
                      : isMashProduct
                        ? !isLine5
                        : runRateInfo[l] != null;
                    const noRateLabel = isMashProduct && !isLine5 && runRateInfo[l] == null
                      ? ' (no run rate)'
                      : !hasRate ? ' (no run rate)' : '';
                    const isDisabled = isMashProduct ? isLine5 : !hasRate;
                    return (
                      <option key={l} value={l} disabled={isDisabled}
                        style={{ color: isDisabled ? '#9ca3af' : undefined }}>
                        {l}{noRateLabel}{isMashProduct && isLine5 ? ' (Powermix only)' : ''}
                      </option>
                    );
                  })}
                </select>

                {isMashProduct && (
                  <div style={{ marginTop: 6, fontSize: 11, color: '#065f46', background: '#ecfdf5', border: '1px solid #6ee7b7', borderRadius: 5, padding: '5px 10px' }}>
                    🌿 Mash orders skip the pellet mill and can run on any line except Line 5.
                  </div>
                )}

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

            {/* AI INSERTION RECOMMENDATION — single source of truth for placement */}
            {isComplete && (
              <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '14px 18px' }} data-testid="panel-add-ai-placement">
                <div style={{ fontSize: 11, fontWeight: 700, color: '#92400e', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>🤖 AI Insertion Recommendation</div>
                {aiPlacementLoading ? (
                  <div style={{ fontSize: 12, color: '#a16207', fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Loader2 className="animate-spin" style={{ width: 12, height: 12 }} /> Analyzing best insertion position…
                  </div>
                ) : aiPlacement && !aiPlacement.error ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ fontSize: 12, color: '#78350f' }} data-testid="text-add-placement-position">
                      Recommended position: <strong>Priority {aiPlacement.insertPosition ?? aiPlacement.targetPrioritySeq}</strong>
                      {aiPlacement.ordersShifted > 0
                        ? ` · ${aiPlacement.ordersShifted} order${aiPlacement.ordersShifted === 1 ? '' : 's'} shifted`
                        : ' · no orders shifted'}
                    </div>
                    <div style={{ fontSize: 12, color: '#78350f' }}>
                      Downstream delay risk: <strong style={{ textTransform: 'capitalize' }}>{aiPlacement.downstreamDelayRisk}</strong>
                      {aiPlacement.aiAvailDate ? ` · est. ready ${fmtConfirmDate(aiPlacement.aiAvailDate)}` : ''}
                    </div>
                    {aiPlacement.reason && (
                      <div style={{ fontSize: 11, color: '#92400e', fontStyle: 'italic' }} data-testid="text-add-placement-reason">{aiPlacement.reason}</div>
                    )}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: '#a16207' }} data-testid="text-add-placement-fallback">
                    AI unavailable — order will be placed using date-based positioning.
                  </div>
                )}
              </div>
            )}

            {/* IMPACT ANALYSIS */}
            <div className="aod-impact" style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '16px 20px' }}>
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
                      color: impactLoading ? '#d1d5db' : 'var(--nexfeed-primary)',
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
                  <Loader2 style={{ width: 14, height: 14, color: 'var(--nexfeed-primary)' }} className="animate-spin" />
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
          <div className="aod-footer" style={{ padding: '14px 28px', borderTop: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, flexShrink: 0, background: 'white' }}>
            <Button variant="outline" style={{ height: 40, padding: '0 20px', fontSize: 14, fontWeight: 600 }} onClick={onClose} data-testid="button-cancel-add-order">
              Cancel
            </Button>
            <button
              onClick={isComplete && !isSubmitting ? handleAdd : undefined}
              disabled={!isComplete || isSubmitting}
              style={{
                height: 40, padding: '0 20px', fontSize: 14, fontWeight: 600, borderRadius: 6, border: 'none',
                background: (isComplete && !isSubmitting) ? 'var(--nexfeed-primary)' : '#f3f4f6',
                color: (isComplete && !isSubmitting) ? 'white' : '#d1d5db',
                cursor: (isComplete && !isSubmitting) ? 'pointer' : 'not-allowed',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
              data-testid="button-confirm-add-order"
            >
              {isSubmitting
                ? <><Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> Adding…</>
                : <><Plus style={{ width: 14, height: 14 }} /> Add Order</>
              }
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

    </>
  );
}
