import React, { useState } from 'react';
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
import { Label } from "@/components/ui/label";
import { AlertTriangle } from 'lucide-react';
import { getMinMT, getFeedmillGroupName } from '@/components/utils/orderUtils';

export default function MinVolumeCheckDialog({ isOpen, onClose, order, eligibleSources, onProceed, onSplitAndMerge }) {
  const [mode, setMode] = useState(null);
  const [selectedSource, setSelectedSource] = useState(null);
  const [splitAmount, setSplitAmount] = useState('');
  const [splitWarning, setSplitWarning] = useState('');

  if (!order) return null;

  const minMT = getMinMT(order.feedmill_line);
  const feedmillLabel = getFeedmillGroupName(order.feedmill_line) || order.feedmill_line || 'this feedmill line';

  const handleClose = () => {
    setMode(null);
    setSelectedSource(null);
    setSplitAmount('');
    setSplitWarning('');
    onClose();
  };

  const handleSelectSource = (src) => {
    setSelectedSource(src);
    setSplitAmount('');
    setSplitWarning('');
  };

  const handleSplitAmountChange = (val) => {
    setSplitAmount(val);
    const amt = parseFloat(val) || 0;
    if (selectedSource && amt > 0) {
      const remaining = (selectedSource.total_volume_mt || 0) - amt;
      const srcMinMT = getMinMT(selectedSource.feedmill_line);
      if (srcMinMT > 0 && remaining < srcMinMT && remaining > 0) {
        setSplitWarning(`Splitting ${amt} MT will reduce "${selectedSource.item_description || selectedSource.material_code}" to ${remaining.toFixed(1)} MT, which is below the recommended minimum of ${srcMinMT} MT for ${selectedSource.feedmill_line || feedmillLabel}. Do you wish to proceed?`);
      } else {
        setSplitWarning('');
      }
    }
  };

  const handleSplitMerge = () => {
    const amt = parseFloat(splitAmount) || 0;
    if (!selectedSource || amt <= 0 || amt > (selectedSource.total_volume_mt || 0)) return;
    onSplitAndMerge(order, selectedSource, amt);
    handleClose();
  };

  const mt = order.total_volume_mt || 0;

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[18px] font-bold">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Volume Below Recommended Minimum
          </DialogTitle>
          <DialogDescription className="text-[14px] leading-relaxed">
            This order is <strong>{mt} MT</strong>, which is below the recommended minimum of <strong>{minMT} MT</strong> for {feedmillLabel}. Do you wish to proceed?
          </DialogDescription>
        </DialogHeader>

        {mode === null && (
          <div className="py-2 space-y-3">
            <Button
              className="w-full justify-start bg-green-50 text-green-800 border border-green-200 hover:bg-green-100 text-[14px] font-semibold h-10"
              variant="outline"
              onClick={() => { handleClose(); onProceed(); }}
            >
              Proceed Anyway
            </Button>
            {eligibleSources && eligibleSources.length > 0 && (
              <Button
                className="w-full justify-start bg-blue-50 text-blue-800 border border-blue-200 hover:bg-blue-100 text-[14px] font-semibold h-10"
                variant="outline"
                onClick={() => setMode('split')}
              >
                Split & Merge from Another Order
              </Button>
            )}
          </div>
        )}

        {mode === 'split' && (
          <div className="py-2 space-y-4">
            <div>
              <Label className="mb-2 block text-[14px] font-medium">Select source order (same Material Code)</Label>
              <div className="max-h-48 overflow-y-auto space-y-2">
                {eligibleSources.map(src => {
                  const srcTag = src.status === 'cut' ? 'Pending' : 'Normal';
                  const tagColor = src.status === 'cut' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700';
                  return (
                    <div
                      key={src.id}
                      onClick={() => handleSelectSource(src)}
                      className={`p-3 rounded-lg border cursor-pointer transition-all ${selectedSource?.id === src.id ? 'border-[#fd5108] bg-orange-50' : 'border-gray-200 hover:border-gray-300'}`}
                    >
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded ${tagColor}`}>{srcTag}</span>
                        <span className="text-[14px] font-medium text-gray-900 truncate">{src.item_description}</span>
                      </div>
                      <p className="text-[13px] text-gray-500">FPR: {src.fpr} — {src.total_volume_mt} MT</p>
                    </div>
                  );
                })}
              </div>
            </div>

            {selectedSource && (
              <div className="space-y-1">
                <Label className="text-[14px] font-medium">Volume to split from source (MT)</Label>
                <Input
                  type="number"
                  min="0.1"
                  max={selectedSource.total_volume_mt}
                  step="0.1"
                  value={splitAmount}
                  onChange={(e) => handleSplitAmountChange(e.target.value)}
                  placeholder="Enter MT to take"
                  className="text-[14px] md:text-[14px]"
                />
                {splitWarning && (
                  <p className="text-[13px] text-amber-600 mt-1">{splitWarning}</p>
                )}
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setMode(null)} className="text-[14px] font-semibold h-10 px-5">Back</Button>
              <Button
                onClick={handleSplitMerge}
                disabled={!selectedSource || !splitAmount || parseFloat(splitAmount) <= 0 || parseFloat(splitAmount) > (selectedSource?.total_volume_mt || 0)}
                className="bg-[#fd5108] hover:bg-[#fe7c39] text-[14px] font-semibold h-10 px-5"
              >
                Split & Merge, then Produce
              </Button>
            </DialogFooter>
          </div>
        )}

        {mode === null && (
          <DialogFooter>
            <Button variant="outline" onClick={handleClose} className="text-[14px] font-semibold h-10 px-5">Cancel</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
