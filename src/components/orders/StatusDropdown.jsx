import { useState, useRef } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export const ALL_STATUSES = [
  { value: 'plotted',           label: 'Plotted',               group: 'Planning' },
  { value: 'planned',           label: 'Planned',               group: 'Planning' },
  { value: 'hold',              label: 'Hold',                  group: 'Planning' },
  { value: 'cut',               label: 'Cut',                   group: 'Planning' },
  { value: 'in_production',     label: 'In production',         group: 'Production' },
  { value: 'ongoing_batching',  label: 'On-going batching',     group: 'Production' },
  { value: 'ongoing_pelleting', label: 'On-going pelleting',    group: 'Production' },
  { value: 'ongoing_bagging',   label: 'On-going bagging',      group: 'Production' },
  { value: 'completed',         label: 'Done',                  group: 'Completion' },
  { value: 'cancel_po',         label: 'Cancel PO',             group: 'Cancel' },
];

const LEAD_COMBINED_STATUSES_BASE = [
  { value: 'uncombine',         label: 'Uncombine',            group: 'Group' },
  { value: 'combined',          label: 'Combined with other PO', group: 'Planning' },
  { value: 'planned',           label: 'Planned',              group: 'Planning' },
  { value: 'hold',              label: 'Hold',                 group: 'Planning' },
  { value: 'in_production',     label: 'In production',        group: 'Production' },
  { value: 'ongoing_batching',  label: 'On-going batching',    group: 'Production' },
  { value: 'ongoing_pelleting', label: 'On-going pelleting',   group: 'Production' },
  { value: 'ongoing_bagging',   label: 'On-going bagging',     group: 'Production' },
  { value: 'completed',         label: 'Done',                 group: 'Completion' },
];

const CUT_ORDER_STATUSES_BASE = [
  { value: 'merge_back',        label: 'Merge Back',           group: 'Cut' },
  { value: 'cut',               label: 'Cut',                  group: 'Cut' },
  { value: 'planned',           label: 'Planned',              group: 'Planning' },
  { value: 'hold',              label: 'Hold',                 group: 'Planning' },
  { value: 'in_production',     label: 'In production',        group: 'Production' },
  { value: 'ongoing_batching',  label: 'On-going batching',    group: 'Production' },
  { value: 'ongoing_pelleting', label: 'On-going pelleting',   group: 'Production' },
  { value: 'ongoing_bagging',   label: 'On-going bagging',     group: 'Production' },
  { value: 'completed',         label: 'Done',                 group: 'Completion' },
  { value: 'cancel_po',         label: 'Cancel PO',            group: 'Cancel' },
];

export const STATUS_COLORS = {
  plotted:           'bg-[#eeeff1] text-[#2e343a]',
  planned:           'bg-[#eff6ff] text-[#2563eb]',
  hold:              'bg-[#a1a8b3] text-white',
  cut:               'bg-[#e0d4f5] text-[#2e343a]',
  combined:          'bg-[#e0d4f5] text-[#2e343a]',
  uncombine:         'bg-[#f3f4f6] text-[#6b7280]',
  merge_back:        'bg-[#f3f4f6] text-[#6b7280]',
  cancelled:         'bg-[#e53935] text-white',
  cancel_po:         'bg-[#e53935] text-white',
  in_production:     'bg-[#ffe8d4] text-[#2e343a]',
  ongoing_batching:  'bg-[#fff9c4] text-[#2e343a]',
  ongoing_pelleting: 'bg-[#fff9c4] text-[#2e343a]',
  ongoing_bagging:   'bg-[#fff9c4] text-[#2e343a]',
  completed:         'bg-[#4CAF50] text-white',
  normal:            'bg-[#eeeff1] text-[#2e343a]',
};

// LOCKED_STATUSES = used for preSortOrders anchoring (planned stays in slot during auto-sort)
export const LOCKED_STATUSES = [
  'completed',
  'cancel_po',
  'in_production',
  'ongoing_batching',
  'ongoing_pelleting',
  'ongoing_bagging',
  'planned',
];

// HARD_LOCKED_STATUSES = statuses where the row itself cannot be dragged (planned is draggable)
export const HARD_LOCKED_STATUSES = [
  'completed',
  'cancel_po',
  'in_production',
  'ongoing_batching',
  'ongoing_pelleting',
  'ongoing_bagging',
];

export function isLockedStatus(status) {
  return LOCKED_STATUSES.includes(status);
}

export function isHardLockedStatus(status) {
  return HARD_LOCKED_STATUSES.includes(status);
}

export function isMovableStatus(status) {
  return !isLockedStatus(status);
}

// Known statuses — any other value is a custom free-text status
export const KNOWN_STATUSES = new Set([
  'plotted', 'planned', 'hold', 'cut', 'combined', 'uncombine', 'merge_back',
  'in_production', 'ongoing_batching', 'ongoing_pelleting', 'ongoing_bagging',
  'completed', 'cancel_po', 'normal', 'cancelled',
]);

export function isCustomStatus(status) {
  return !!status && !KNOWN_STATUSES.has(status);
}

export function getStatusLabel(value) {
  if (value === 'combined') return 'Combined with other PO';
  if (value === 'uncombine') return 'Uncombine';
  if (value === 'merge_back') return 'Merge Back';
  return ALL_STATUSES.find(s => s.value === value)?.label || value || 'Plotted';
}

export function StatusBadge({ status }) {
  const colorClass = STATUS_COLORS[status];
  if (!colorClass) {
    return (
      <span className="text-[13px] font-normal text-[#374151] whitespace-nowrap">
        {status || 'Plotted'}
      </span>
    );
  }
  return (
    <span className={cn(
      "inline-flex items-center px-2 py-0.5 rounded-full text-[13px] font-medium whitespace-nowrap",
      colorClass
    )}>
      {getStatusLabel(status)}
    </span>
  );
}

export default function StatusDropdown({
  value,
  onChange,
  disabled = false,
  onCancelRequest,
  onRestoreRequest,
  isLeadCombined = false,
  onUncombineRequest,
  onCutRequest,
  isCutOrder = false,
  canMergeBack = false,
  mergeBackDisabledReason = '',
  onMergeBackRequest,
}) {
  const [open, setOpen] = useState(false);
  const [customText, setCustomText] = useState('');
  const inputRef = useRef(null);

  const isCancelledOrder = value === 'cancel_po';
  const isDone = value === 'completed';

  const handleSelect = (newValue) => {
    setOpen(false);
    setCustomText('');
    if (newValue === 'uncombine') {
      if (onUncombineRequest) onUncombineRequest();
      return;
    }
    if (newValue === 'cut') {
      if (!isCutOrder && onCutRequest) onCutRequest();
      return;
    }
    if (newValue === 'merge_back') {
      if (onMergeBackRequest) onMergeBackRequest();
      return;
    }
    if (newValue === 'cancel_po' && onCancelRequest) {
      onCancelRequest();
      return;
    }
    if (isCancelledOrder && newValue !== 'cancel_po' && onRestoreRequest) {
      onRestoreRequest(newValue);
      return;
    }
    onChange(newValue);
  };

  const handleCustomSubmit = () => {
    const trimmed = customText.trim();
    if (!trimmed) return;
    setOpen(false);
    setCustomText('');
    onChange(trimmed);
  };

  let dropdownOptions;
  if (isLeadCombined) {
    dropdownOptions = isDone
      ? LEAD_COMBINED_STATUSES_BASE.filter(s => s.value !== 'uncombine')
      : LEAD_COMBINED_STATUSES_BASE;
  } else if (isCutOrder) {
    if (canMergeBack) {
      dropdownOptions = CUT_ORDER_STATUSES_BASE;
    } else if (mergeBackDisabledReason) {
      dropdownOptions = CUT_ORDER_STATUSES_BASE.map(s =>
        s.value === 'merge_back' ? { ...s, disabled: true, disabledHint: mergeBackDisabledReason } : s
      );
    } else {
      dropdownOptions = CUT_ORDER_STATUSES_BASE.filter(s => s.value !== 'merge_back');
    }
  } else {
    dropdownOptions = ALL_STATUSES;
  }

  return (
    <Popover open={open} onOpenChange={(o) => { if (!disabled) setOpen(o); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-no-drag="true"
          className="focus:outline-none focus:ring-0 disabled:cursor-not-allowed disabled:opacity-60 w-full text-left"
          onClick={(e) => { e.stopPropagation(); }}
        >
          <StatusBadge status={value || 'plotted'} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0 w-[210px] shadow-lg border border-gray-200 rounded-md overflow-hidden"
        align="start"
        sideOffset={4}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="max-h-[280px] overflow-y-auto py-1">
          {dropdownOptions.map(s => (
            <button
              key={s.value}
              type="button"
              disabled={s.disabled}
              title={s.disabledHint || undefined}
              onClick={() => !s.disabled && handleSelect(s.value)}
              className={cn(
                "w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-gray-50 transition-colors",
                s.disabled && "opacity-40 cursor-not-allowed",
                (value === s.value || (!STATUS_COLORS[value] && s.value === 'plotted')) && "bg-blue-50"
              )}
            >
              <StatusBadge status={s.value} />
              {s.disabledHint && (
                <span className="text-[10px] text-gray-400 italic max-w-[120px] leading-tight">{s.disabledHint}</span>
              )}
            </button>
          ))}
        </div>
        <div className="border-t border-gray-200">
          <input
            ref={inputRef}
            type="text"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); handleCustomSubmit(); }
              if (e.key === 'Escape') { setOpen(false); }
              e.stopPropagation();
            }}
            placeholder="Type custom status..."
            className="w-full px-3 py-1.5 text-[12px] border-0 outline-none bg-white placeholder-gray-400 placeholder:italic focus:bg-gray-50"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
