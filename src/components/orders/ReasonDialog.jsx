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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

export default function ReasonDialog({ isOpen, onClose, onConfirm, title, description, confirmText = "Confirm", variant = "default" }) {
  const [reason, setReason] = useState('');

  const handleConfirm = () => {
    onConfirm(reason.trim());
    setReason('');
    onClose();
  };

  const handleClose = () => {
    setReason('');
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-[18px] font-bold">{title}</DialogTitle>
          {description && <DialogDescription className="text-[14px] leading-relaxed">{description}</DialogDescription>}
        </DialogHeader>
        <div className="py-2 space-y-2">
          <Label className="text-[14px] font-medium">Reason <span className="text-red-500">*</span></Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Enter reason..."
            className="min-h-[100px] resize-none text-[14px]"
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose} className="text-[14px] font-semibold h-10 px-5">Cancel</Button>
          <Button
            onClick={handleConfirm}
            disabled={!reason.trim()}
            className={`text-[14px] font-semibold h-10 px-5 ${variant === 'destructive' ? 'bg-red-600 hover:bg-red-700' : 'bg-[#fd5108] hover:bg-[#fe7c39]'}`}
          >
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
