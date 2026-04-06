import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export default function PendingRevertDialog({ isOpen, onClose, order, parentOrder, onRevertToParent, onMakeStandalone }) {
  if (!order) return null;

  const parentStatus = parentOrder?.status;
  const parentAction = parentStatus === 'in_production' ? 'produced' : parentStatus === 'cancelled' ? 'cancelled' : null;

  if (parentOrder && parentAction) {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="text-[18px] font-bold">Original Order No Longer Available</DialogTitle>
            <DialogDescription className="text-[14px] leading-relaxed">
              The original order (FPR: <strong>{parentOrder.fpr || '—'}</strong>) has already been <strong>{parentAction}</strong>.
              Move this order to Normal Orders as a standalone?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} className="text-[14px] font-semibold h-10 px-5">Cancel</Button>
            <Button onClick={onMakeStandalone} className="bg-[#fd5108] hover:bg-[#fe7c39] text-[14px] font-semibold h-10 px-5">
              Move to Normal Orders
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-[18px] font-bold">Revert Pending Order</DialogTitle>
          <DialogDescription className="text-[14px] leading-relaxed">
            This will merge the pending order ({order.total_volume_mt} MT) back into the original order
            (FPR: <strong>{parentOrder?.fpr || '—'}</strong>, currently {parentOrder?.total_volume_mt} MT),
            restoring the original volume.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="text-[14px] font-semibold h-10 px-5">Cancel</Button>
          <Button onClick={onRevertToParent} className="bg-[#fd5108] hover:bg-[#fe7c39] text-[14px] font-semibold h-10 px-5">
            Merge Back to Parent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
