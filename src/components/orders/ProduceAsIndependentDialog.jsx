import React, { useState } from 'react';
import { format } from 'date-fns';
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

export default function ProduceAsIndependentDialog({ isOpen, onClose, order, onConfirm }) {
  const [confirmText, setConfirmText] = useState('');

  if (!order) return null;

  const now = new Date();
  const newFPR = format(now, 'yyMMdd');

  const handleConfirm = () => {
    onConfirm(order, newFPR);
    setConfirmText('');
    onClose();
  };

  const handleClose = () => {
    setConfirmText('');
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-[18px] font-bold">Produce as Independent Order</DialogTitle>
          <DialogDescription className="text-[14px] leading-relaxed">
            This will convert the pending order into an independent order with a new FPR ({newFPR}).
            Type <strong>Confirm</strong> to proceed.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2 space-y-3">
          <div className="bg-gray-50 rounded-lg p-3 text-[14px] text-gray-700 space-y-1.5">
            <p><span className="text-gray-500">Item:</span> <span className="font-semibold text-[#1a1a1a]">{order.item_description}</span></p>
            <p><span className="text-gray-500">Current FPR:</span> <span className="font-semibold text-[#1a1a1a]">{order.fpr || '—'}</span></p>
            <p><span className="text-gray-500">New FPR:</span> <span className="font-semibold text-[#1a1a1a]">{newFPR}</span></p>
            <p><span className="text-gray-500">Volume:</span> <span className="font-semibold text-[#1a1a1a]">{order.total_volume_mt} MT</span></p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-input" className="text-[14px] font-medium">Type "Confirm" to proceed</Label>
            <Input
              id="confirm-input"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="Confirm"
              autoComplete="off"
              className="text-[14px] md:text-[14px]"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} className="text-[14px] font-semibold h-10 px-5">Cancel</Button>
          <Button
            onClick={handleConfirm}
            disabled={confirmText !== 'Confirm'}
            className="bg-[#fd5108] hover:bg-[#fe7c39] text-[14px] font-semibold h-10 px-5"
          >
            Proceed
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
