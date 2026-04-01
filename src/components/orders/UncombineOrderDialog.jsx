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
import { Unlock, AlertTriangle } from "lucide-react";
import { Fragment } from "react";

function fmtVol(v) {
  if (v == null || v === '') return '—';
  const n = parseFloat(v);
  return isNaN(n) ? '—' : `${n % 1 === 0 ? n : n.toFixed(2)} MT`;
}

export default function UncombineOrderDialog({ open, onClose, onConfirm, leadOrder, childOrders = [] }) {
  if (!leadOrder) return null;

  const lineNum = leadOrder.feedmill_line ? leadOrder.feedmill_line.replace('Line ', '') : '—';
  const groupName = `Combine Group ${leadOrder.fpr || '—'}`;
  const leadVol = parseFloat(leadOrder.volume_override ?? leadOrder.total_volume_mt) || 0;
  const totalOrders = 1 + childOrders.length;

  const totalVol = childOrders.reduce((sum, c) => {
    const v = parseFloat(c.volume_override ?? c.total_volume_mt) || 0;
    return sum + v;
  }, leadVol);

  const rows = [
    { role: 'Lead', fpr: leadOrder.fpr, vol: leadVol, origVol: null },
    ...childOrders.map(c => {
      const vol = parseFloat(c.volume_override ?? c.total_volume_mt) || 0;
      const origVol = c.volume_override != null && c.volume_override !== '' ? parseFloat(c.total_volume_mt) || null : null;
      return { role: 'Sub', fpr: c.fpr, vol, origVol: origVol !== vol ? origVol : null };
    }),
  ];

  const detailRows = [
    { label: 'Line', value: lineNum },
    { label: 'Combined Group', value: groupName, blue: true },
    { label: 'Lead Order', value: `FPR ${leadOrder.fpr || '—'} (${fmtVol(leadVol)})`, bold: true },
    { label: 'Total Orders', value: `${totalOrders} (1 lead + ${childOrders.length} sub)` },
    { label: 'Combined Volume', value: fmtVol(totalVol), bold: true },
  ];

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent className="max-w-[520px]" data-testid="dialog-uncombine-order">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-[18px] font-bold">
            <Unlock className="h-5 w-5 text-[#fd5108]" />
            Uncombine Order
          </AlertDialogTitle>
        </AlertDialogHeader>

        <AlertDialogDescription className="text-[14px] leading-relaxed text-gray-600 -mt-2 mb-3">
          This will uncombine the entire group. All orders will become standalone and set to "Plotted". Are you sure?
        </AlertDialogDescription>

        <div className="grid grid-cols-[140px_1fr] gap-y-2 text-[14px] mb-4">
          {detailRows.map(({ label, value, bold, blue }) => (
            <Fragment key={label}>
              <span className="text-[#6b7280]">{label}:</span>
              <span className={bold ? 'font-semibold text-[#1a1a1a]' : blue ? 'text-[#1976d2] font-medium' : 'text-[#1a1a1a]'}>
                {value}
              </span>
            </Fragment>
          ))}
        </div>

        <div className="text-[14px] font-medium text-gray-500 mb-2">Orders in this group:</div>
        <div className="border border-gray-200 rounded-md overflow-hidden mb-4">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-3 py-1.5 font-medium text-gray-500">Role</th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-500">FPR</th>
                <th className="text-right px-3 py-1.5 font-medium text-gray-500">Volume</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-gray-100 last:border-0">
                  <td className="px-3 py-1.5">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${
                      row.role === 'Lead' ? 'bg-blue-100 text-blue-700' : 'bg-blue-50 text-blue-500'
                    }`}>
                      {row.role}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 font-semibold text-gray-900">{row.fpr || '—'}</td>
                  <td className="px-3 py-1.5 text-right">
                    <span className="font-medium text-gray-900">{fmtVol(row.vol)}</span>
                    {row.origVol != null && (
                      <span className="ml-1 text-[#6b7280]">(Original: {fmtVol(row.origVol)})</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="bg-[#fef3c7] rounded-md px-3 py-2.5 mb-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-[#92400e] shrink-0 mt-0.5" />
            <div className="text-[#92400e] space-y-0.5">
              <p className="text-[14px] font-semibold">After uncombining:</p>
              <ul className="list-disc list-inside space-y-0.5 mt-1 text-[13px]">
                <li>All orders will become standalone.</li>
                <li>All statuses will reset to "Plotted".</li>
                <li>Blue highlight will be removed.</li>
                <li>Lead and Sub badges will be removed.</li>
                <li>Orders will remain in their current positions.</li>
                <li>You can then Cut, Cancel, or rearrange each order independently.</li>
              </ul>
            </div>
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={onClose}
            className="border-gray-300 text-gray-600 hover:bg-gray-50 text-[14px] font-semibold h-10 px-5"
            data-testid="button-uncombine-go-back"
          >
            Go Back
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-[#fd5108] hover:bg-[#e04600] text-white text-[14px] font-semibold h-10 px-5"
            data-testid="button-confirm-uncombine"
          >
            Confirm Uncombine
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
