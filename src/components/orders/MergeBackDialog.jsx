import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Undo2 } from "lucide-react";

function fmt(n) {
  const v = parseFloat(n);
  if (!v && v !== 0) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

export default function MergeBackDialog({ open, onClose, onConfirm, portion1, portion2 }) {
  if (!portion1 || !portion2) return null;

  const batchSize = parseFloat(portion1.batch_size ?? portion2.batch_size ?? 0);
  const p1Vol = parseFloat(portion1.volume_override ?? portion1.total_volume_mt ?? 0);
  const p2Vol = parseFloat(portion2.volume_override ?? portion2.total_volume_mt ?? 0);
  const mergedVol = p1Vol + p2Vol;

  const p1Batches = batchSize > 0 ? Math.round(p1Vol / batchSize) : null;
  const p2Batches = batchSize > 0 ? Math.round(p2Vol / batchSize) : null;
  const mergedBatches = batchSize > 0 ? Math.round(mergedVol / batchSize) : null;

  const lineNum = portion1.feedmill_line ? portion1.feedmill_line.replace(/\D/g, '') : '—';

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[480px]" data-testid="dialog-merge-back">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[18px] font-bold">
            <Undo2 className="h-5 w-5 text-[#6b7280]" />
            Merge Back
          </DialogTitle>
          <DialogDescription className="text-[14px] leading-relaxed text-gray-600">
            This will merge both cut portions back into one order.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-[80px_1fr] gap-y-2 text-[14px]">
            <span className="text-[#6b7280]">Line:</span>
            <span className="font-semibold text-[#1a1a1a]">{lineNum}</span>
            <span className="text-[#6b7280]">FPR:</span>
            <span className="font-semibold text-[#1a1a1a]">{portion1.fpr || '—'}</span>
            <span className="text-[#6b7280]">Item:</span>
            <span className="font-semibold text-[#1a1a1a]">{portion1.item_description || '—'}</span>
          </div>

          <div>
            <p className="text-[14px] font-semibold text-[#6b7280] uppercase tracking-wider mb-2">Current Portions</p>
            <div className="rounded-md border border-gray-200 divide-y divide-gray-100 text-[14px]">
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-gray-600">Portion 1</span>
                <div className="flex items-center gap-3 text-right">
                  <span className="font-semibold text-[#1a1a1a]">{fmt(p1Vol)} MT</span>
                  {p1Batches !== null && (
                    <span className="text-[13px] text-gray-400">({p1Batches} batches)</span>
                  )}
                  <span className="text-[13px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
                    Prio {portion1.priority_seq ?? '—'}
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-gray-600">Portion 2</span>
                <div className="flex items-center gap-3 text-right">
                  <span className="font-semibold text-[#1a1a1a]">{fmt(p2Vol)} MT</span>
                  {p2Batches !== null && (
                    <span className="text-[13px] text-gray-400">({p2Batches} batches)</span>
                  )}
                  <span className="text-[13px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
                    Prio {portion2.priority_seq ?? '—'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div>
            <p className="text-[14px] font-semibold text-[#6b7280] uppercase tracking-wider mb-2">Merged Order</p>
            <div className="rounded-md border border-green-200 bg-[#dcfce7] px-3 py-2.5 text-[14px] flex items-center justify-between">
              <span className="text-[#166534] font-medium">Volume</span>
              <div className="flex items-center gap-3">
                <span className="font-bold text-[#166534]">{fmt(mergedVol)} MT</span>
                {mergedBatches !== null && (
                  <span className="text-[13px] text-[#166534]/70">({mergedBatches} batches)</span>
                )}
              </div>
            </div>
          </div>

          <div className="rounded-md bg-[#fef3c7] border border-amber-200 p-3">
            <p className="text-[14px] font-semibold text-[#92400e] mb-2 flex items-center gap-1">
              <span>⚠</span> After merging:
            </p>
            <ul className="space-y-1 text-[13px] text-[#92400e]">
              <li>• Both portions will become one order again.</li>
              <li>• The merged order will be placed at Portion 1's current position (Prio {portion1.priority_seq ?? '—'}).</li>
              <li>• Portion 2 will be removed from the table.</li>
              <li>• The "Cut" tag will be removed.</li>
              <li>• Status will reset to "Plotted".</li>
              <li>• Production hours and completion dates will recalculate.</li>
            </ul>
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button
            variant="outline"
            onClick={onClose}
            className="border-gray-300 text-gray-600 hover:bg-gray-50 text-[14px] font-semibold h-10 px-5"
            data-testid="button-merge-back-cancel"
          >
            Go Back
          </Button>
          <Button
            onClick={onConfirm}
            className="bg-[#fd5108] hover:bg-[#e8490b] text-white text-[14px] font-semibold h-10 px-5"
            data-testid="button-merge-back-confirm"
          >
            Confirm Merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
