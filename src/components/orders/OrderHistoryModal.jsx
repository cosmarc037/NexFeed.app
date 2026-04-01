import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { format } from 'date-fns';

export default function OrderHistoryModal({ isOpen, onClose, order }) {
  if (!order) return null;
  const history = order.history || [];

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[70vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Order History — FPR: {order.fpr || '—'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 mt-2">
          {history.length === 0 ? (
            <p className="text-sm text-gray-500">No history entries yet.</p>
          ) : (
            [...history].reverse().map((entry, idx) => (
              <div key={idx} className="border-l-2 border-[#fd5108] pl-3 py-1">
                <p className="text-xs text-[#a1a8b3]">{entry.timestamp}</p>
                <p className="text-sm font-medium text-gray-800">{entry.action}</p>
                {entry.details && <p className="text-xs text-gray-500 mt-0.5">{entry.details}</p>}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}