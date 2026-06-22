import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Scissors, Bot, Loader2 } from "lucide-react";
import { useState, useEffect, useRef, Fragment } from "react";
import { generateCutInsights, generateInsertionPlacement } from "@/services/azureAI";

const EPS = 0.001;
const isDivisible = (n, d) => d > 0 && Math.abs(Math.round(n / d) * d - n) < EPS;

function formatLongDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function fmt(n) {
  const v = parseFloat(n);
  if (!v && v !== 0) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

function InsightSections({ text }) {
  const paragraphs = text.split(/\n\n+/).map(s => s.trim()).filter(Boolean);
  return (
    <div className="text-[13px] leading-relaxed text-[#4b5563] space-y-2.5">
      {paragraphs.map((para, i) => (
        <p key={i} className="whitespace-pre-wrap">{para}</p>
      ))}
    </div>
  );
}

export default function CutOrderDialog({ order, open, onClose, onConfirm, allOrders }) {
  const [portion1Str, setPortion1Str] = useState('');
  const [aiInsights, setAiInsights] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiPlacement, setAiPlacement] = useState(null);
  const [aiPlacementLoading, setAiPlacementLoading] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const aiTimerRef = useRef(null);
  // Monotonic token: only the latest placement request may mutate state, so a
  // stale response from a previous Portion 1 value can't overwrite the current
  // recommendation.
  const placementReqRef = useRef(0);

  useEffect(() => {
    if (open) {
      setPortion1Str('');
      setAiInsights('');
      setAiLoading(false);
      setAiPlacement(null);
      setAiPlacementLoading(false);
      setIsConfirming(false);
    }
    return () => { if (aiTimerRef.current) clearTimeout(aiTimerRef.current); };
  }, [open]);

  if (!order) return null;

  const totalVolume = parseFloat(order.volume_override ?? order.total_volume_mt ?? 0);
  const batchSize   = parseFloat(order.batch_size ?? 0);
  const totalBatches = batchSize > 0 ? totalVolume / batchSize : 0;

  const p1 = parseFloat(portion1Str) || 0;
  const p2 = totalVolume - p1;

  const lineNum    = order.feedmill_line ? order.feedmill_line.replace(/\D/g, '') : '—';
  const availDate  = order.target_avail_date;
  const isNonDate  = availDate && isNaN(Date.parse(availDate));
  const availDisplay = availDate
    ? (isNonDate ? availDate : (formatLongDate(availDate) || availDate))
    : '—';

  const batchSizeDisplay = batchSize > 0 ? batchSize.toFixed(2) : '—';

  let validationError = null;
  if (portion1Str !== '') {
    if (p1 <= 0) {
      validationError = '⚠ Please enter a volume greater than 0.';
    } else if (p1 >= totalVolume) {
      validationError = p1 === totalVolume
        ? '⚠ Portion 1 cannot equal the total volume. Leave some for Portion 2.'
        : `⚠ Portion 1 cannot exceed the total volume of ${fmt(totalVolume)} MT.`;
    } else if (batchSize > 0 && !isDivisible(p1, batchSize)) {
      const lower = Math.floor(p1 / batchSize) * batchSize;
      const upper = Math.ceil(p1 / batchSize) * batchSize;
      const suggestions = [];
      if (lower > 0 && isDivisible(totalVolume - lower, batchSize)) suggestions.push(`${fmt(lower)} MT`);
      if (upper < totalVolume && isDivisible(totalVolume - upper, batchSize)) suggestions.push(`${fmt(upper)} MT`);
      validationError = `⚠ ${fmt(p1)} MT is not divisible by batch size ${batchSizeDisplay}.${suggestions.length ? ` Try ${suggestions.join(' or ')}.` : ''}`;
    } else if (batchSize > 0 && !isDivisible(p2, batchSize)) {
      const r2lower = Math.floor(p2 / batchSize) * batchSize;
      const r2upper = Math.ceil(p2 / batchSize) * batchSize;
      const adj1 = totalVolume - r2upper;
      const adj2 = totalVolume - r2lower;
      const suggestions = [];
      if (adj1 > 0 && adj1 < totalVolume && isDivisible(adj1, batchSize)) suggestions.push(`${fmt(adj1)} MT`);
      if (adj2 > 0 && adj2 < totalVolume && isDivisible(adj2, batchSize)) suggestions.push(`${fmt(adj2)} MT`);
      validationError = `⚠ Remaining ${fmt(p2)} MT is not divisible by batch size ${batchSizeDisplay}.${suggestions.length ? ` Try ${suggestions.join(' or ')} for Portion 1.` : ''}`;
    }
  }

  const p1Valid = portion1Str !== '' && p1 > 0 && p1 < totalVolume && !validationError;
  const p1Batches = batchSize > 0 ? p1 / batchSize : 0;
  const p2Batches = batchSize > 0 ? p2 / batchSize : 0;
  const canConfirm = p1Valid && !isConfirming;

  // Build the line lineup the shared AI insertion engine reasons over for the
  // cut. It INCLUDES the order being cut (which becomes Portion 1) so the engine
  // can place Portion 2 relative to it. Mirrors handleCutConfirm's lineOrders
  // basis (active orders on the line, sorted by priority_seq) so the reviewed
  // slot maps to the same array position when committed.
  const buildCutLineup = () => {
    return (allOrders || [])
      .filter(o => o.feedmill_line === order.feedmill_line
        && o.status !== 'cancel_po' && o.status !== 'completed')
      .slice()
      .sort((a, b) => (a.priority_seq ?? Infinity) - (b.priority_seq ?? Infinity))
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
  };

  const handlePortion1Change = (val) => {
    setPortion1Str(val);
    setAiInsights('');
    setAiPlacement(null);
    if (aiTimerRef.current) clearTimeout(aiTimerRef.current);
    // Invalidate any in-flight placement request on every edit.
    const reqId = ++placementReqRef.current;
    const isStale = () => reqId !== placementReqRef.current;

    const numVal = parseFloat(val) || 0;
    const numP2  = totalVolume - numVal;
    const isValidInput = numVal > 0 && numVal < totalVolume
      && isDivisible(numVal, batchSize)
      && isDivisible(numP2, batchSize);

    if (isValidInput) {
      setAiLoading(true);
      setAiPlacementLoading(true);
      aiTimerRef.current = setTimeout(async () => {
        // Shared AI insertion placement for Portion 2 — constrained to land
        // AFTER Portion 1 (but not forced immediately after).
        const lineup = buildCutLineup();
        const p1Idx = lineup.findIndex(o => o.id === order.id);
        const p1PrioSeq = p1Idx >= 0 ? (Number(lineup[p1Idx].priority_seq) || 0) : (Number(order.priority_seq) || 0);
        const p2Order = {
          item_description: order.item_description,
          fpr: order.fpr,
          feedmill_line: order.feedmill_line,
          total_volume_mt: numP2,
          batch_size: order.batch_size,
          run_rate: order.run_rate,
          production_hours: null,
          form: order.form,
          target_avail_date: order.target_avail_date,
        };
        const placementPromise = generateInsertionPlacement('cut', p2Order, lineup, {
          lineName: order.feedmill_line,
          minInsertPos: (p1Idx >= 0 ? p1Idx : lineup.length - 1) + 2,
          minTargetPrioritySeq: p1PrioSeq + 1,
        }).then((res) => {
          if (isStale()) return; // a newer Portion 1 value superseded this request
          if (res && !res.error) {
            setAiPlacement(res);
            console.debug('[AI Insertion Recommendation]', {
              modalType: 'cut',
              orderId: order.id,
              targetLine: order.feedmill_line,
              portion1PrioritySeq: p1PrioSeq,
              recommendedPriority: res.targetPrioritySeq,
              recommendedInsertPosition: res.insertPosition,
              recommendedAvailDate: res.aiAvailDate ?? null,
              downstreamDelayRisk: res.downstreamDelayRisk,
              ordersShifted: res.ordersShifted,
              usedAiInsertionEngine: true,
            });
          } else {
            setAiPlacement({ error: res?.error || 'AI placement failed' });
          }
        }).catch((err) => {
          if (isStale()) return;
          setAiPlacement({ error: err?.message || 'AI placement failed' });
        }).finally(() => { if (!isStale()) setAiPlacementLoading(false); });
        try {
          const text = await generateCutInsights(order, numVal, numP2, allOrders || []);
          setAiInsights(text);
        } catch {
          setAiInsights('');
        }
        setAiLoading(false);
        await placementPromise;
      }, 900);
    } else {
      setAiPlacementLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!canConfirm) return;
    const orderId = order.id;
    console.debug('[Order Action Modal Confirm Click]', { modalType: 'cut', orderId, loadingStarted: true });
    setIsConfirming(true);
    console.debug('[Order Action Modal Loading State]', { modalType: 'cut', orderId, confirmButtonDisabled: true, loadingVisible: true });
    let success = false;
    try {
      await onConfirm({ portion1: p1, portion2: p2, placement: aiPlacement });
      success = true;
    } catch (err) {
      console.error('[CutOrderDialog] confirm error', err);
      setIsConfirming(false);
    } finally {
      console.debug('[Order Action Modal Processing Complete]', { modalType: 'cut', orderId, success, loadingEnded: true });
    }
  };

  const detailRows = [
    { label: 'Line',         value: lineNum,                 bold: true },
    { label: 'FPR',          value: order.fpr || '—',        bold: true },
    { label: 'Item',         value: order.item_description || '—', bold: true },
    { label: 'Volume',       value: `${fmt(totalVolume)} MT`, bold: true },
    { label: 'Batch Size',   value: batchSizeDisplay,         bold: true },
    { label: 'Availability', value: availDisplay,             bold: !isNonDate, orange: isNonDate },
  ];

  const summaryRows = [
    {
      label: 'Portion 1',
      mt: p1 > 0 ? `${fmt(p1)} MT` : '— MT',
      batches: p1 > 0 ? `(${fmt(p1Batches)} batches)` : '(— batches)',
      valid: p1Valid ? true : (portion1Str && p1 > 0) ? false : null,
    },
    {
      label: 'Portion 2',
      mt: p1 > 0 ? `${fmt(p2)} MT` : '— MT',
      batches: p1 > 0 ? `(${fmt(p2Batches)} batches)` : '(— batches)',
      valid: p1Valid ? true : (portion1Str && p1 > 0) ? false : null,
    },
    {
      label: 'Total',
      mt: `${fmt(totalVolume)} MT`,
      batches: `(${fmt(totalBatches)} batches)`,
      valid: null,
      bold: true,
    },
  ];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !isConfirming && onClose()}>
      <DialogContent className="cut-order-dialog max-w-[520px] max-h-[90vh] overflow-y-auto" data-testid="dialog-cut-order">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[18px] font-bold">
            <Scissors className="h-5 w-5 text-[#7c3aed]" />
            Cut Order
          </DialogTitle>
          <DialogDescription className="text-[14px] leading-relaxed text-gray-600">
            Split this order into two separate production runs.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <p className="text-[14px] font-semibold text-[#6b7280] uppercase tracking-wider mb-2">Order Details</p>
            <div className="grid grid-cols-[120px_1fr] gap-y-2 text-[14px]">
              {detailRows.map(({ label, value, bold, orange }) => (
                <Fragment key={label}>
                  <span className="text-[#6b7280]">{label}:</span>
                  <span className={
                    orange ? 'text-[var(--nexfeed-primary)] font-semibold'
                    : bold  ? 'font-semibold text-[#1a1a1a]'
                    : 'text-[#1a1a1a]'
                  }>{value}</span>
                </Fragment>
              ))}
            </div>
          </div>

          <div>
            <p className="text-[14px] font-semibold text-[#6b7280] uppercase tracking-wider mb-2">Split Volume</p>
            <div className="space-y-3">
              <div>
                <label className="text-[14px] font-medium text-gray-700 mb-1 block">
                  Portion 1 (MT) <span className="text-red-500">*</span>
                </label>
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={portion1Str}
                  onChange={(e) => handlePortion1Change(e.target.value)}
                  placeholder="Enter volume for first portion"
                  className="w-full text-[14px] md:text-[14px]"
                  data-testid="input-cut-portion1"
                  disabled={isConfirming}
                />
                {validationError && (
                  <p className="text-[13px] mt-1" style={{ color: '#e53935' }} data-testid="text-cut-validation-error">
                    {validationError}
                  </p>
                )}
              </div>

              <div>
                <label className="text-[14px] font-medium text-gray-700 mb-1 flex items-center gap-1.5">
                  Portion 2 (MT)
                  <span className="text-[12px] text-[#a1a8b3] italic font-normal">auto-calculated</span>
                </label>
                <Input
                  type="number"
                  value={p1 > 0 && p1 < totalVolume ? fmt(p2) : ''}
                  readOnly
                  placeholder="0"
                  className="w-full bg-white text-[14px] md:text-[14px] text-[#1a1a1a] cursor-default select-none"
                  style={{ pointerEvents: 'none' }}
                  data-testid="input-cut-portion2"
                />
              </div>
            </div>
          </div>

          <div>
            <p className="text-[14px] font-semibold text-[#6b7280] uppercase tracking-wider mb-2">Split Summary</p>
            <div className="rounded-md border border-gray-100 divide-y divide-gray-100 text-[14px]">
              {summaryRows.map(({ label, mt, batches, valid, bold }) => (
                <div key={label} className={`flex items-center justify-between px-3 py-2 ${bold ? 'bg-gray-50' : ''}`}>
                  <span className={bold ? 'font-semibold text-[#1a1a1a]' : 'text-gray-600'}>{label}</span>
                  <div className="flex items-center gap-2">
                    <span className={`font-medium ${
                      valid === true  ? 'text-[#2e7d32]'
                      : valid === false ? 'text-[#e53935]'
                      : bold ? 'text-[#1a1a1a]' : 'text-gray-500'
                    }`}>
                      {mt}
                    </span>
                    <span className={`text-[13px] ${
                      valid === true  ? 'text-[#4CAF50]'
                      : valid === false ? 'text-[#e53935]'
                      : 'text-gray-400'
                    }`}>
                      {batches}
                    </span>
                    {valid === true  && <span className="text-base">✅</span>}
                    {valid === false && <span className="text-base">❌</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="text-[14px] font-semibold text-[#6b7280] uppercase tracking-wider mb-2 flex items-center gap-1">
              <Bot className="h-3.5 w-3.5" /> Smart Insights
            </p>
            <div className="cut-ai-insights rounded-lg border border-[#fed7aa] bg-[#fff7ed] p-3.5 min-h-[60px]">
              {(aiPlacement && !aiPlacement.error) && (
                <div className="mb-3 pb-3 border-b border-[#fed7aa]" data-testid="panel-cut-ai-placement">
                  <p className="text-[13px] text-[#78350f]" data-testid="text-cut-placement-position">
                    Portion 2 insertion: <strong>Priority {aiPlacement.insertPosition}</strong>
                    {aiPlacement.ordersShifted > 0 ? ` (${aiPlacement.ordersShifted} shifted)` : ''}
                  </p>
                  <p className="text-[13px] text-[#78350f] mt-0.5">
                    Downstream delay risk: <strong className="capitalize">{aiPlacement.downstreamDelayRisk}</strong>
                    {aiPlacement.aiAvailDate ? ` · est. ready ${aiPlacement.aiAvailDate}` : ''}
                  </p>
                  {aiPlacement.reason && (
                    <p className="text-[13px] text-[#78350f] mt-1 italic" data-testid="text-cut-placement-reason">{aiPlacement.reason}</p>
                  )}
                </div>
              )}
              {aiPlacementLoading && (
                <p className="text-[13px] text-[#a1a8b3] italic mb-2 animate-pulse">Calculating Portion 2 placement…</p>
              )}
              {aiLoading ? (
                <p className="text-[13px] text-[#a1a8b3] italic animate-pulse">Analyzing cut decision…</p>
              ) : aiInsights ? (
                <InsightSections text={aiInsights} />
              ) : (
                <p className="text-[13px] text-[#a1a8b3] italic">
                  {p1Valid
                    ? 'Loading insights…'
                    : '🤖 Enter a valid volume for Portion 1 to see AI insights.'}
                </p>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isConfirming}
            className="border-gray-300 text-gray-600 hover:bg-gray-50 text-[14px] font-semibold h-10 px-5 disabled:opacity-50"
            data-testid="button-cut-go-back"
          >
            Go Back
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!canConfirm || aiPlacementLoading}
            className="bg-[var(--nexfeed-primary)] hover:bg-[var(--nexfeed-primary-dark)] text-white disabled:bg-[#fed7aa] disabled:text-gray-400 disabled:cursor-not-allowed text-[14px] font-semibold h-10 px-5"
            data-testid="button-cut-confirm"
          >
            {isConfirming ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Cutting…
              </>
            ) : aiPlacementLoading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Analyzing…
              </>
            ) : (
              'Confirm Cut'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
