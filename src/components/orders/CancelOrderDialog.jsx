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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle } from "lucide-react";
import { useState, useEffect, Fragment } from "react";

const CANCEL_REASONS = [
  "Client request",
  "Material unavailable",
  "Scheduling conflict",
  "Duplicate order",
  "Quality issue",
  "Management decision",
  "Other",
];

function formatLongDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export default function CancelOrderDialog({ order, open, onClose, onConfirm }) {
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (open) {
      setReason("");
      setNotes("");
    }
  }, [open]);

  const isValid = reason && (reason !== "Other" || notes.trim().length > 0);

  const handleConfirm = () => {
    if (!isValid) return;
    onConfirm({ reason, notes: notes.trim() });
  };

  if (!order) return null;

  const lineNum = order.feedmill_line ? order.feedmill_line.replace(/\D/g, '') : '—';
  const itemDisplay = order.item_description || '—';
  const volumeStr = order.total_volume_mt ? `${order.total_volume_mt} MT` : '—';
  const availDate = order.target_avail_date;
  const isNonDate = availDate && isNaN(Date.parse(availDate));
  const formattedAvail = availDate
    ? (isNonDate ? availDate : (formatLongDate(availDate) || availDate))
    : '—';

  const detailRows = [
    { label: 'Line', value: lineNum, bold: true, testId: 'text-cancel-line' },
    { label: 'FPR', value: order.fpr || '—', bold: true, testId: 'text-cancel-fpr' },
    { label: 'Item', value: itemDisplay, bold: true, testId: 'text-cancel-item' },
    { label: 'Volume', value: volumeStr, bold: true, testId: 'text-cancel-volume' },
    { label: 'Availability', value: formattedAvail, bold: !isNonDate, orange: isNonDate, testId: 'text-cancel-availability' },
  ];

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent className="max-w-[480px]" data-testid="dialog-cancel-order">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-[18px] font-bold">
            <AlertTriangle className="h-5 w-5 text-[#e53935]" />
            Cancel Order
          </AlertDialogTitle>
          <AlertDialogDescription className="text-[14px] leading-relaxed text-gray-600">
            Are you sure you want to cancel this order?
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-[110px_1fr] gap-y-2 text-[14px]">
            {detailRows.map(({ label, value, bold, grey, orange, testId }) => (
              <Fragment key={label}>
                <span className="text-[#6b7280]">{label}:</span>
                <span
                  className={
                    grey ? 'text-[#a1a8b3]'
                    : orange ? 'text-[#fd5108] font-semibold'
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

          <div className="space-y-1.5">
            <label className="text-[14px] font-medium text-gray-700">
              Cancellation Reason <span className="text-red-500">*</span>
            </label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger className="w-full text-[14px]" data-testid="select-cancel-reason">
                <SelectValue placeholder="Select a reason" />
              </SelectTrigger>
              <SelectContent>
                {CANCEL_REASONS.map(r => (
                  <SelectItem key={r} value={r} className="text-[14px]" data-testid={`option-cancel-reason-${r.toLowerCase().replace(/\s+/g, '-')}`}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-[14px] font-medium text-gray-700">
              Additional Notes {reason === "Other" ? <span className="text-red-500">*</span> : "(optional)"}
            </label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={reason === "Other" ? "Please explain the reason..." : "Any additional details..."}
              className="resize-none h-20 text-[14px]"
              data-testid="textarea-cancel-notes"
            />
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={onClose}
            className="border-gray-300 text-gray-600 hover:bg-gray-50 text-[14px] font-semibold h-10 px-5"
            data-testid="button-cancel-go-back"
          >
            Go Back
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={!isValid}
            className="bg-[#e53935] hover:bg-[#c62828] text-white disabled:opacity-50 disabled:cursor-not-allowed text-[14px] font-semibold h-10 px-5"
            data-testid="button-confirm-cancel"
          >
            Confirm Cancel
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
