import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { Undo2, AlertTriangle } from "lucide-react";
import { Fragment } from "react";
import { StatusBadge, getStatusLabel } from './StatusDropdown';

function formatLongDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export default function RestoreOrderDialog({ order, open, onClose, onConfirm, newStatus }) {
  if (!order) return null;

  const lineNum = order.feedmill_line ? order.feedmill_line.replace(/\D/g, '') : '—';
  const itemDisplay = order.item_description || '—';
  const volumeStr = order.total_volume_mt ? `${order.total_volume_mt} MT` : '—';
  const availDate = order.target_avail_date;
  const isNonDate = availDate && isNaN(Date.parse(availDate));
  const formattedAvail = availDate
    ? (isNonDate ? availDate : (formatLongDate(availDate) || availDate))
    : '—';
  const isSapCancelled = order.cancelled_by === 'SAP Import';

  const detailRows = [
    { label: 'Line', value: lineNum, bold: true, testId: 'text-restore-line' },
    { label: 'FPR', value: order.fpr || '—', bold: true, testId: 'text-restore-fpr' },
    { label: 'Item', value: itemDisplay, bold: true, testId: 'text-restore-item' },
    { label: 'Volume', value: volumeStr, bold: true, testId: 'text-restore-volume' },
    { label: 'Availability', value: formattedAvail, bold: !isNonDate, orange: isNonDate, testId: 'text-restore-availability' },
  ];

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent className="max-w-[480px]" data-testid="dialog-restore-order">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-[18px] font-bold">
            <Undo2 className="h-5 w-5 text-[#43a047]" />
            Restore Order
          </AlertDialogTitle>
          <AlertDialogDescription className="text-[14px] leading-relaxed text-gray-600">
            Are you sure you want to restore this order?
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-[110px_1fr] gap-y-2 text-[14px]">
            {detailRows.map(({ label, value, bold, orange, testId }) => (
              <Fragment key={label}>
                <span className="text-[#6b7280]">{label}:</span>
                <span
                  className={
                    orange ? 'text-[#fd5108] font-semibold'
                    : bold ? 'font-semibold text-[#1a1a1a]'
                    : 'text-[#1a1a1a]'
                  }
                  data-testid={testId}
                >
                  {value}
                </span>
              </Fragment>
            ))}
          </div>

          {newStatus && (
            <div className="grid grid-cols-[110px_1fr] gap-y-2 text-[14px]">
              <span className="text-[#6b7280]">New Status:</span>
              <span><StatusBadge status={newStatus} /></span>
            </div>
          )}

          <p className="text-[14px] leading-relaxed text-gray-500">
            This order will be moved back to active orders.
          </p>

          {isSapCancelled && (
            <div className="flex gap-2 p-3 rounded-md bg-[#fef3c7] text-[#92400e]" data-testid="warning-sap-cancel">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span className="text-[13px] leading-relaxed">
                This order was cancelled from SAP. Restoring it in NexFeed does not change its status in SAP. Please verify with SAP before proceeding.
              </span>
            </div>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={onClose}
            className="border-gray-300 text-gray-600 hover:bg-gray-50 text-[14px] font-semibold h-10 px-5"
            data-testid="button-restore-go-back"
          >
            Go Back
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-[#43a047] hover:bg-[#388e3c] text-white text-[14px] font-semibold h-10 px-5"
            data-testid="button-confirm-restore"
          >
            Confirm Restore
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
