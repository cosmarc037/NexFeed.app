import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { isCustomStatus } from "./StatusDropdown";

export function FilterIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M1 1.5h8M2.5 4h5M4 6.5h2" strokeLinecap="round" />
    </svg>
  );
}

/* ─── Status display-name ↔ internal-value map ───────────────────────────── */
const STATUS_DISPLAY_VALUES = [
  { label: "Plotted",             value: "plotted" },
  { label: "Planned",             value: "planned" },
  { label: "Hold",                value: "hold" },
  { label: "Cut",                 value: "cut" },
  { label: "In Production",       value: "in_production" },
  { label: "On-going batching",   value: "ongoing_batching" },
  { label: "On-going pelleting",  value: "ongoing_pelleting" },
  { label: "On-going bagging",    value: "ongoing_bagging" },
  { label: "Done",                value: "completed" },
  { label: "Cancel PO",           value: "cancel_po" },
  { label: "Custom",              value: "__custom__" },
];
const STATUS_LABEL_TO_VALUE = Object.fromEntries(STATUS_DISPLAY_VALUES.map((s) => [s.label, s.value]));

/* ─── Column filter config ───────────────────────────────────────────────── */
export const COLUMN_FILTER_CONFIG = {
  readiness: {
    type: "multi-select",
    label: "Readiness",
    getValues: () => ["Ready", "Almost Ready", "Needs Attention"],
  },
  prio: { type: "number-range", label: "Prio" },
  fpr: { type: "text-search", label: "FPR" },
  planned_order: { type: "text-search", label: "Planned Order" },
  prod_order: { type: "text-search", label: "Production Order" },
  mat_code_sfg: {
    type: "multi-select",
    label: "Material Code (SFG)",
    getValues: (orders) =>
      [...new Set(orders.map((o) => o.kb_sfg_material_code).filter(Boolean))].sort(),
  },
  mat_code_fg: {
    type: "multi-select",
    label: "Material Code (FG)",
    getValues: (orders) =>
      [...new Set(orders.map((o) => o.material_code || o.material_code_fg).filter(Boolean))].sort(),
  },
  item_desc: {
    type: "custom",
    component: "ItemDescriptionFilter",
    label: "Item Description",
  },
  form: {
    type: "multi-select",
    label: "Form",
    getValues: (orders) =>
      [...new Set(orders.map((o) => o.form).filter(Boolean))].sort(),
  },
  volume: { type: "number-range", label: "Volume (MT)" },
  batch_size: { type: "number-range", label: "Batch Size" },
  num_batches: { type: "number-range", label: "Batches" },
  num_bags: { type: "number-range", label: "Bags" },
  prod_time: {
    type: "custom",
    component: "ProductionTimeFilter",
    label: "Production Time",
  },
  ha_info: {
    type: "custom",
    component: "HAInfoFilter",
    label: "HA Info",
  },
  ha_prep: {
    type: "multi-select",
    label: "HA Prep",
    getValues: () => ["-", "On Going", "Done", "Issued 3F", "Issued 2F", "Need to Elevate", "Sacks to Elevate"],
  },
  status: {
    type: "multi-select",
    label: "Status",
    getValues: () => STATUS_DISPLAY_VALUES.map((s) => s.label),
  },
  start_date: { type: "date-range", label: "Start Date" },
  start_time: { type: "time-range", label: "Start Time" },
  avail_date: {
    type: "custom",
    component: "AvailDateFilter",
    label: "Avail Date",
  },
  completion_date: {
    type: "custom",
    component: "CompletionDateFilter",
    label: "Estimated Completion Date",
  },
  smart_insight: { type: "text-search", label: "Summary" },
  fpr_notes: { type: "text-search", label: "FPR Notes" },
  special_remarks: { type: "text-search", label: "Special Remarks" },
  threads: {
    type: "multi-select",
    label: "Threads",
    getValues: (orders) =>
      [...new Set(orders.map((o) => o.threads).filter(Boolean))].sort(),
  },
  sacks: {
    type: "multi-select",
    label: "Sacks",
    getValues: (orders) =>
      [...new Set(orders.map((o) => String(o.sacks || "")).filter(Boolean))].sort(),
  },
  markings: {
    type: "multi-select",
    label: "Markings",
    getValues: (orders) =>
      [...new Set(orders.map((o) => o.markings).filter(Boolean))].sort(),
  },
  tags: {
    type: "multi-select",
    label: "Tags",
    getValues: (orders) => {
      const all = [];
      orders.forEach((o) => {
        if (Array.isArray(o.tags)) all.push(...o.tags);
        else if (o.tags) all.push(o.tags);
      });
      return [...new Set(all.filter(Boolean))].sort();
    },
  },
  end_date: {
    type: "custom",
    component: "EndDateFilter",
    label: "End Date",
  },
  history: {
    type: "toggle",
    label: "History",
    options: [
      { value: "any", label: "Any" },
      { value: "has_history", label: "Has history" },
      { value: "none", label: "None" },
    ],
  },
};

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function _getSuggestedVolume(order) {
  const orig = parseFloat(order.total_volume_mt) || 0;
  const bs = parseFloat(order.batch_size) || 4;
  if (bs <= 0) return orig;
  return Math.ceil(orig / bs) * bs;
}

function _getEffVol(order) {
  if (order.volume_override != null && order.volume_override !== "") {
    return parseFloat(order.volume_override) || 0;
  }
  return _getSuggestedVolume(order);
}

function _isValid10Digit(value) {
  if (!value) return false;
  return /^\d{10}$/.test(String(value).trim());
}

function _readinessLabel(order) {
  const sugVol = _getEffVol(order);
  const batchSize = parseFloat(order.batch_size) || 0;
  const numBatches = batchSize > 0 ? Math.ceil(sugVol / batchSize) : 0;

  const criticalOK = !!(
    order.fpr &&
    order.item_description &&
    order.material_code &&
    sugVol > 0 &&
    batchSize > 0 &&
    order.production_hours > 0 &&
    order.changeover_time !== null &&
    order.changeover_time !== undefined &&
    order.changeover_time !== "" &&
    order.run_rate > 0 &&
    order.target_completion_date
  );

  if (!criticalOK) return "Needs Attention";

  const prodOrderOK = !!(
    _isValid10Digit(order.fg1) &&
    _isValid10Digit(order.sfg1) &&
    (order.feedmill_line !== "Line 5" || _isValid10Digit(order.sfgpmx))
  );
  const haOK = !!(
    prodOrderOK &&
    numBatches > 0 &&
    order.formula_version &&
    order.prod_version &&
    order.ha_prep_form_issuance === "Done"
  );

  return haOK ? "Ready" : "Almost Ready";
}

function _parseOrderDate(val) {
  if (!val || val === "TBD" || val === "—") return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(val)) return new Date(val);
  if (/^\d{2}\/\d{2}\/\d{4}/.test(val)) {
    const parts = val.split(/[\s/]/);
    const [m, d, y] = parts;
    return new Date(`${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`);
  }
  const parsed = new Date(val);
  return isNaN(parsed) ? null : parsed;
}

function _getColValue(order, colKey) {
  switch (colKey) {
    case "readiness": return _readinessLabel(order);
    case "prio": return parseFloat(order.prio) || 0;
    case "fpr": return order.fpr || "";
    case "planned_order": return `${order.fg || ""} ${order.sfg || ""}`.trim();
    case "prod_order": return `${order.fg1 || ""} ${order.sfg1 || ""}`.trim();
    case "mat_code_sfg": return order.kb_sfg_material_code || "";
    case "mat_code_fg": return order.material_code || order.material_code_fg || "";
    case "item_desc": return order.item_description || "";
    case "form": return order.form || "";
    case "volume": return _getEffVol(order);
    case "batch_size": return parseFloat(order.batch_size) || 0;
    case "num_batches": {
      const vol = _getEffVol(order);
      const bs = parseFloat(order.batch_size) || 4;
      return bs > 0 ? Math.ceil(vol / bs) : 0;
    }
    case "num_bags": {
      const vol = _getEffVol(order);
      return Math.round((vol / 50) * 1000);
    }
    case "prod_time": return parseFloat(order.production_hours) || 0;
    case "ha_info": return `${order.formula_version || ""} ${order.prod_version || ""}`.trim();
    case "ha_prep": return order.ha_prep_form_issuance || "-";
    case "status": return order.status || "";
    case "start_date": return order.start_date || "";
    case "start_time": return order.start_time || "";
    case "avail_date": return order.target_avail_date || "";
    case "completion_date": return order.target_completion_date || "";
    case "smart_insight": return order.smart_insight || "";
    case "fpr_notes": return order.fpr_notes || "";
    case "special_remarks": return order.special_remarks || "";
    case "threads": return order.threads || "";
    case "sacks": return order.sacks != null ? String(order.sacks) : "";
    case "markings": return order.markings || "";
    case "tags": return Array.isArray(order.tags) ? order.tags.join(" ") : order.tags || "";
    case "end_date": return order.end_date || "";
    case "history": return order.history;
    default: return "";
  }
}

/* ─── Filter engine ──────────────────────────────────────────────────────── */
export function applyColumnFilters(orders, activeFilters) {
  if (!activeFilters || Object.keys(activeFilters).length === 0) return orders;

  return orders.filter((order) => {
    for (const [colKey, filter] of Object.entries(activeFilters)) {

      /* ── Custom multi-field filters ─────────────────────────────── */
      if (colKey === "item_desc") {
        if (filter.categories && filter.categories.length > 0) {
          const cat = order.category || "";
          if (!filter.categories.some((c) => c.toLowerCase() === cat.toLowerCase())) return false;
        }
        if (filter.items && filter.items.length > 0) {
          const desc = order.item_description || "";
          if (!filter.items.some((i) => i.toLowerCase() === desc.toLowerCase())) return false;
        }
        continue;
      }

      if (colKey === "prod_time") {
        const prodTime = parseFloat(order.production_hours) || 0;
        const changeover = parseFloat(order.changeover_time) || 0;
        const runRate = parseFloat(order.run_rate) || 0;
        if (filter.prodMin != null && prodTime < filter.prodMin) return false;
        if (filter.prodMax != null && prodTime > filter.prodMax) return false;
        if (filter.coMin != null && changeover < filter.coMin) return false;
        if (filter.coMax != null && changeover > filter.coMax) return false;
        if (filter.rateMin != null && runRate < filter.rateMin) return false;
        if (filter.rateMax != null && runRate > filter.rateMax) return false;
        continue;
      }

      if (colKey === "ha_info") {
        const scada = (order.formula_version || "").toLowerCase();
        const pv = (order.prod_version || "").toLowerCase();
        const haNum = parseFloat(order.ha) || 0;
        if (filter.haMin != null && haNum < filter.haMin) return false;
        if (filter.haMax != null && haNum > filter.haMax) return false;
        if (filter.scadaText && filter.scadaText.trim() !== "") {
          if (!scada.includes(filter.scadaText.toLowerCase())) return false;
        }
        if (filter.pvText && filter.pvText.trim() !== "") {
          if (!pv.includes(filter.pvText.toLowerCase())) return false;
        }
        continue;
      }

      if (colKey === "status") {
        if (filter.values && filter.values.length > 0) {
          const orderStatus = order.status || "";
          const isCustom = isCustomStatus(orderStatus);
          if (isCustom) {
            if (!filter.values.includes("Custom")) return false;
          } else {
            /* map selected display labels back to internal values for comparison */
            const selectedInternals = filter.values
              .map((label) => STATUS_LABEL_TO_VALUE[label] || label)
              .filter((v) => v !== "__custom__");
            if (!selectedInternals.includes(orderStatus)) return false;
          }
        }
        continue;
      }

      if (colKey === "avail_date") {
        const rawDate = order.target_avail_date || "";
        /* Date range check */
        if (filter.from || filter.to) {
          const dateVal = _parseOrderDate(rawDate);
          if (filter.from) {
            const fromD = new Date(filter.from); fromD.setHours(0,0,0,0);
            if (!dateVal || dateVal < fromD) return false;
          }
          if (filter.to) {
            const toD = new Date(filter.to); toD.setHours(23,59,59,999);
            if (!dateVal || dateVal > toD) return false;
          }
        }
        /* Sub-text check */
        if (filter.subTexts && filter.subTexts.length > 0) {
          const subText = (order._originalAvailDate || rawDate || "").toLowerCase();
          const matches = filter.subTexts.some((st) => subText.includes(st.toLowerCase()));
          if (!matches) return false;
        }
        continue;
      }

      if (colKey === "completion_date" || colKey === "end_date") {
        const rawVal = colKey === "completion_date"
          ? (order.target_completion_date || "")
          : (order.end_date || "");
        if (filter.from || filter.to) {
          const dateVal = _parseOrderDate(rawVal);
          if (filter.from) {
            const fromD = new Date(filter.from); fromD.setHours(0,0,0,0);
            if (!dateVal || dateVal < fromD) return false;
          }
          if (filter.to) {
            const toD = new Date(filter.to); toD.setHours(23,59,59,999);
            if (!dateVal || dateVal > toD) return false;
          }
        }
        if (filter.fromTime || filter.toTime) {
          /* completion_date stored as "MM/DD/YYYY - hh:mm AM/PM" */
          const timeMatch = rawVal.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
          const rawTime = timeMatch ? timeMatch[1].trim() : "";
          if (!rawTime) return false;
          const [hm, period] = rawTime.split(/\s+/);
          const [hStr, mStr] = hm.split(":");
          let h = parseInt(hStr, 10);
          const m = parseInt(mStr, 10);
          if (period?.toUpperCase() === "PM" && h !== 12) h += 12;
          if (period?.toUpperCase() === "AM" && h === 12) h = 0;
          const t24 = `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
          if (filter.fromTime && t24 < filter.fromTime) return false;
          if (filter.toTime && t24 > filter.toTime) return false;
        }
        continue;
      }

      /* ── Standard type-based filters ──────────────────────────────── */
      const config = COLUMN_FILTER_CONFIG[colKey];
      if (!config) continue;
      const value = _getColValue(order, colKey);

      switch (config.type) {
        case "multi-select": {
          if (filter.values && filter.values.length > 0) {
            const strVal = String(value || "");
            const match = filter.values.some(
              (v) => String(v).toLowerCase() === strVal.toLowerCase()
            );
            if (!match) return false;
          }
          break;
        }
        case "text-search": {
          if (filter.text && filter.text.trim() !== "") {
            const cellValue = (value || "").toString().toLowerCase();
            if (!cellValue.includes(filter.text.toLowerCase())) return false;
          }
          break;
        }
        case "number-range": {
          const numValue = parseFloat(value) || 0;
          if (filter.min != null && numValue < filter.min) return false;
          if (filter.max != null && numValue > filter.max) return false;
          break;
        }
        case "date-range": {
          const dateValue = _parseOrderDate(value);
          if (filter.from) {
            const fromDate = new Date(filter.from);
            fromDate.setHours(0, 0, 0, 0);
            if (!dateValue || dateValue < fromDate) return false;
          }
          if (filter.to) {
            const toDate = new Date(filter.to);
            toDate.setHours(23, 59, 59, 999);
            if (!dateValue || dateValue > toDate) return false;
          }
          break;
        }
        case "time-range": {
          const timeStr = String(value || "");
          if (filter.from && timeStr < filter.from) return false;
          if (filter.to && timeStr > filter.to) return false;
          break;
        }
        case "toggle": {
          const toggleVal = filter.value;
          if (toggleVal && toggleVal !== "any") {
            if (colKey === "ha_prep") {
              const isDone = value === "Done";
              if (toggleVal === "checked" && !isDone) return false;
              if (toggleVal === "unchecked" && isDone) return false;
            } else if (colKey === "history") {
              const hasHistory = Array.isArray(value) ? value.length > 0 : !!value;
              if (toggleVal === "has_history" && !hasHistory) return false;
              if (toggleVal === "none" && hasHistory) return false;
            }
          }
          break;
        }
        default:
          break;
      }
    }
    return true;
  });
}

/* ─── Standard filter sub-components ────────────────────────────────────── */

function MultiSelectFilter({ config, orders, activeFilter, onApply, onClear, onClose }) {
  const allValues = config.getValues ? config.getValues(orders) : [];
  const [selected, setSelected] = useState(() =>
    activeFilter?.values ? new Set(activeFilter.values) : new Set()
  );
  const [searchText, setSearchText] = useState("");
  const searchRef = useRef(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  const filteredValues = allValues.filter((v) =>
    String(v).toLowerCase().includes(searchText.toLowerCase())
  );

  function toggle(val) {
    const next = new Set(selected);
    if (next.has(val)) next.delete(val);
    else next.add(val);
    setSelected(next);
  }

  return (
    <>
      <div className="filter-dropdown-header">
        <span className="filter-dropdown-title">Filter: {config.label}</span>
        <button className="filter-close-btn" onClick={onClose}>✕</button>
      </div>
      <div className="filter-search">
        <input ref={searchRef} type="text" placeholder="Search..." value={searchText}
          onChange={(e) => setSearchText(e.target.value)} className="filter-search-input" />
      </div>
      <div className="filter-actions">
        <button className="filter-action-btn" onClick={() => setSelected(new Set(allValues))}>Select all</button>
        <button className="filter-action-btn" onClick={() => setSelected(new Set())}>Deselect all</button>
      </div>
      <div className="filter-options-list">
        {filteredValues.length === 0 ? (
          <div style={{ color: "#9ca3af", fontSize: 11, padding: "4px 0" }}>No options</div>
        ) : filteredValues.map((val) => (
          <label key={val} className="filter-option">
            <input type="checkbox" checked={selected.has(val)} onChange={() => toggle(val)} />
            <span>{String(val) || "(empty)"}</span>
          </label>
        ))}
      </div>
      <div className="filter-dropdown-footer">
        <button className="filter-clear-btn" onClick={() => { onClear(); onClose(); }}>Clear</button>
        <button className="filter-apply-btn" onClick={() => { onApply({ values: Array.from(selected) }); onClose(); }}>Apply</button>
      </div>
    </>
  );
}

function TextSearchFilter({ config, activeFilter, onApply, onClear, onClose }) {
  const [text, setText] = useState(activeFilter?.text || "");
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  function handleKeyDown(e) {
    if (e.key === "Enter") { onApply({ text }); onClose(); }
  }

  return (
    <>
      <div className="filter-dropdown-header">
        <span className="filter-dropdown-title">Filter: {config.label}</span>
        <button className="filter-close-btn" onClick={onClose}>✕</button>
      </div>
      <div className="filter-text-input-container">
        <input ref={inputRef} type="text" placeholder={`Search ${config.label}...`}
          value={text} onChange={(e) => setText(e.target.value)} onKeyDown={handleKeyDown}
          className="filter-text-input" />
      </div>
      <div className="filter-dropdown-footer">
        <button className="filter-clear-btn" onClick={() => { onClear(); onClose(); }}>Clear</button>
        <button className="filter-apply-btn" onClick={() => { onApply({ text }); onClose(); }}>Apply</button>
      </div>
    </>
  );
}

function NumberRangeFilter({ config, activeFilter, onApply, onClear, onClose }) {
  const [min, setMin] = useState(activeFilter?.min != null ? String(activeFilter.min) : "");
  const [max, setMax] = useState(activeFilter?.max != null ? String(activeFilter.max) : "");

  return (
    <>
      <div className="filter-dropdown-header">
        <span className="filter-dropdown-title">Filter: {config.label}</span>
        <button className="filter-close-btn" onClick={onClose}>✕</button>
      </div>
      <div className="filter-range-inputs">
        <div className="filter-range-field">
          <label>Min</label>
          <input type="number" placeholder="Min" value={min} onChange={(e) => setMin(e.target.value)}
            className="filter-number-input" autoFocus />
        </div>
        <span className="filter-range-separator">—</span>
        <div className="filter-range-field">
          <label>Max</label>
          <input type="number" placeholder="Max" value={max} onChange={(e) => setMax(e.target.value)}
            className="filter-number-input" />
        </div>
      </div>
      <div className="filter-dropdown-footer">
        <button className="filter-clear-btn" onClick={() => { onClear(); onClose(); }}>Clear</button>
        <button className="filter-apply-btn" onClick={() => {
          onApply({ min: min !== "" ? parseFloat(min) : null, max: max !== "" ? parseFloat(max) : null });
          onClose();
        }}>Apply</button>
      </div>
    </>
  );
}

function DateRangeFilter({ config, activeFilter, onApply, onClear, onClose }) {
  const [from, setFrom] = useState(activeFilter?.from || "");
  const [to, setTo] = useState(activeFilter?.to || "");

  return (
    <>
      <div className="filter-dropdown-header">
        <span className="filter-dropdown-title">Filter: {config.label}</span>
        <button className="filter-close-btn" onClick={onClose}>✕</button>
      </div>
      <div className="filter-date-inputs">
        <div className="filter-date-field">
          <label>From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="filter-date-input" autoFocus />
        </div>
        <div className="filter-date-field">
          <label>To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="filter-date-input" />
        </div>
      </div>
      <div className="filter-dropdown-footer">
        <button className="filter-clear-btn" onClick={() => { onClear(); onClose(); }}>Clear</button>
        <button className="filter-apply-btn" onClick={() => { onApply({ from, to }); onClose(); }}>Apply</button>
      </div>
    </>
  );
}

function TimeRangeFilter({ config, activeFilter, onApply, onClear, onClose }) {
  const [from, setFrom] = useState(activeFilter?.from || "");
  const [to, setTo] = useState(activeFilter?.to || "");

  return (
    <>
      <div className="filter-dropdown-header">
        <span className="filter-dropdown-title">Filter: {config.label}</span>
        <button className="filter-close-btn" onClick={onClose}>✕</button>
      </div>
      <div className="filter-time-inputs">
        <div className="filter-time-field">
          <label>From</label>
          <input type="time" value={from} onChange={(e) => setFrom(e.target.value)}
            className="filter-time-input" autoFocus />
        </div>
        <span className="filter-range-separator">—</span>
        <div className="filter-time-field">
          <label>To</label>
          <input type="time" value={to} onChange={(e) => setTo(e.target.value)}
            className="filter-time-input" />
        </div>
      </div>
      <div className="filter-dropdown-footer">
        <button className="filter-clear-btn" onClick={() => { onClear(); onClose(); }}>Clear</button>
        <button className="filter-apply-btn" onClick={() => { onApply({ from, to }); onClose(); }}>Apply</button>
      </div>
    </>
  );
}

function ToggleFilter({ config, activeFilter, onApply, onClear, onClose }) {
  const [selected, setSelected] = useState(activeFilter?.value || "any");
  const options = config.options || [
    { value: "any", label: "Any" },
    { value: "yes", label: "Yes" },
    { value: "no", label: "No" },
  ];

  return (
    <>
      <div className="filter-dropdown-header">
        <span className="filter-dropdown-title">Filter: {config.label}</span>
        <button className="filter-close-btn" onClick={onClose}>✕</button>
      </div>
      <div className="filter-toggle-options">
        {options.map((opt) => (
          <label key={opt.value} className="filter-toggle-option">
            <input type="radio" name={`filter-toggle-${config.label}`}
              checked={selected === opt.value} onChange={() => setSelected(opt.value)} />
            <span>{opt.label}</span>
          </label>
        ))}
      </div>
      <div className="filter-dropdown-footer">
        <button className="filter-clear-btn" onClick={() => { onClear(); onClose(); }}>Clear</button>
        <button className="filter-apply-btn" onClick={() => { onApply({ value: selected }); onClose(); }}>Apply</button>
      </div>
    </>
  );
}

/* ─── Custom filter components ───────────────────────────────────────────── */

function ItemDescriptionFilter({ orders, activeFilter, onApply, onClear, onClose }) {
  const [selectedItems, setSelectedItems] = useState(
    () => new Set(activeFilter?.items || [])
  );
  const [selectedCategories, setSelectedCategories] = useState(
    () => new Set(activeFilter?.categories || [])
  );
  const [itemSearch, setItemSearch] = useState("");

  const allItems = [...new Set(orders.map((o) => o.item_description).filter(Boolean))].sort();
  const allCategories = [...new Set(orders.map((o) => o.category).filter(Boolean))].sort();
  const filteredItems = allItems.filter((v) =>
    v.toLowerCase().includes(itemSearch.toLowerCase())
  );

  function toggleItem(val) {
    const next = new Set(selectedItems);
    if (next.has(val)) next.delete(val); else next.add(val);
    setSelectedItems(next);
  }

  function toggleCat(val) {
    const next = new Set(selectedCategories);
    if (next.has(val)) next.delete(val); else next.add(val);
    setSelectedCategories(next);
  }

  return (
    <>
      <div className="filter-dropdown-header">
        <span className="filter-dropdown-title">Filter: Item Description</span>
        <button className="filter-close-btn" onClick={onClose}>✕</button>
      </div>
      <div className="filter-section">
        <div className="filter-section-title">Category</div>
        <div className="filter-options-list" style={{ maxHeight: 120 }}>
          {allCategories.length === 0 ? (
            <div style={{ color: "#9ca3af", fontSize: 11, padding: "4px 0" }}>No categories</div>
          ) : allCategories.map((cat) => (
            <label key={cat} className="filter-option">
              <input type="checkbox" checked={selectedCategories.has(cat)} onChange={() => toggleCat(cat)} />
              <span>{cat}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="filter-section-divider" />
      <div className="filter-section">
        <div className="filter-section-title">Item</div>
        <div className="filter-search">
          <input type="text" placeholder="Search items..." value={itemSearch}
            onChange={(e) => setItemSearch(e.target.value)} className="filter-search-input" autoFocus />
        </div>
        <div className="filter-actions">
          <button className="filter-action-btn" onClick={() => setSelectedItems(new Set(allItems))}>Select all</button>
          <button className="filter-action-btn" onClick={() => setSelectedItems(new Set())}>Deselect all</button>
        </div>
        <div className="filter-options-list" style={{ maxHeight: 160 }}>
          {filteredItems.length === 0 ? (
            <div style={{ color: "#9ca3af", fontSize: 11, padding: "4px 0" }}>No items</div>
          ) : filteredItems.map((item) => (
            <label key={item} className="filter-option">
              <input type="checkbox" checked={selectedItems.has(item)} onChange={() => toggleItem(item)} />
              <span>{item}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="filter-dropdown-footer">
        <button className="filter-clear-btn" onClick={() => { onClear(); onClose(); }}>Clear</button>
        <button className="filter-apply-btn" onClick={() => {
          onApply({ items: Array.from(selectedItems), categories: Array.from(selectedCategories) });
          onClose();
        }}>Apply</button>
      </div>
    </>
  );
}

function ProductionTimeFilter({ activeFilter, onApply, onClear, onClose }) {
  const [prodMin, setProdMin] = useState(activeFilter?.prodMin != null ? String(activeFilter.prodMin) : "");
  const [prodMax, setProdMax] = useState(activeFilter?.prodMax != null ? String(activeFilter.prodMax) : "");
  const [coMin, setCoMin] = useState(activeFilter?.coMin != null ? String(activeFilter.coMin) : "");
  const [coMax, setCoMax] = useState(activeFilter?.coMax != null ? String(activeFilter.coMax) : "");
  const [rateMin, setRateMin] = useState(activeFilter?.rateMin != null ? String(activeFilter.rateMin) : "");
  const [rateMax, setRateMax] = useState(activeFilter?.rateMax != null ? String(activeFilter.rateMax) : "");

  return (
    <>
      <div className="filter-dropdown-header">
        <span className="filter-dropdown-title">Filter: Production</span>
        <button className="filter-close-btn" onClick={onClose}>✕</button>
      </div>
      <div className="filter-section">
        <div className="filter-section-title">Production Hours</div>
        <div className="filter-range-inputs">
          <div className="filter-range-field"><label>Min</label>
            <input type="number" step="0.01" placeholder="Min" value={prodMin}
              onChange={(e) => setProdMin(e.target.value)} className="filter-number-input" autoFocus />
          </div>
          <span className="filter-range-separator">—</span>
          <div className="filter-range-field"><label>Max</label>
            <input type="number" step="0.01" placeholder="Max" value={prodMax}
              onChange={(e) => setProdMax(e.target.value)} className="filter-number-input" />
          </div>
        </div>
      </div>
      <div className="filter-section-divider" />
      <div className="filter-section">
        <div className="filter-section-title">Changeover</div>
        <div className="filter-range-inputs">
          <div className="filter-range-field"><label>Min</label>
            <input type="number" step="0.01" placeholder="Min" value={coMin}
              onChange={(e) => setCoMin(e.target.value)} className="filter-number-input" />
          </div>
          <span className="filter-range-separator">—</span>
          <div className="filter-range-field"><label>Max</label>
            <input type="number" step="0.01" placeholder="Max" value={coMax}
              onChange={(e) => setCoMax(e.target.value)} className="filter-number-input" />
          </div>
        </div>
      </div>
      <div className="filter-section-divider" />
      <div className="filter-section">
        <div className="filter-section-title">Run Rate</div>
        <div className="filter-range-inputs">
          <div className="filter-range-field"><label>Min</label>
            <input type="number" step="0.01" placeholder="Min" value={rateMin}
              onChange={(e) => setRateMin(e.target.value)} className="filter-number-input" />
          </div>
          <span className="filter-range-separator">—</span>
          <div className="filter-range-field"><label>Max</label>
            <input type="number" step="0.01" placeholder="Max" value={rateMax}
              onChange={(e) => setRateMax(e.target.value)} className="filter-number-input" />
          </div>
        </div>
      </div>
      <div className="filter-dropdown-footer">
        <button className="filter-clear-btn" onClick={() => { onClear(); onClose(); }}>Clear</button>
        <button className="filter-apply-btn" onClick={() => {
          onApply({
            prodMin: prodMin !== "" ? parseFloat(prodMin) : null,
            prodMax: prodMax !== "" ? parseFloat(prodMax) : null,
            coMin: coMin !== "" ? parseFloat(coMin) : null,
            coMax: coMax !== "" ? parseFloat(coMax) : null,
            rateMin: rateMin !== "" ? parseFloat(rateMin) : null,
            rateMax: rateMax !== "" ? parseFloat(rateMax) : null,
          });
          onClose();
        }}>Apply</button>
      </div>
    </>
  );
}

function HAInfoFilter({ activeFilter, onApply, onClear, onClose }) {
  const [haMin, setHaMin] = useState(activeFilter?.haMin != null ? String(activeFilter.haMin) : "");
  const [haMax, setHaMax] = useState(activeFilter?.haMax != null ? String(activeFilter.haMax) : "");
  const [scadaText, setScadaText] = useState(activeFilter?.scadaText || "");
  const [pvText, setPvText] = useState(activeFilter?.pvText || "");

  return (
    <>
      <div className="filter-dropdown-header">
        <span className="filter-dropdown-title">Filter: HA Info</span>
        <button className="filter-close-btn" onClick={onClose}>✕</button>
      </div>
      <div className="filter-section">
        <div className="filter-section-title">HA</div>
        <div className="filter-range-inputs">
          <div className="filter-range-field"><label>Min</label>
            <input type="number" placeholder="Min" value={haMin}
              onChange={(e) => setHaMin(e.target.value)} className="filter-number-input" autoFocus />
          </div>
          <span className="filter-range-separator">—</span>
          <div className="filter-range-field"><label>Max</label>
            <input type="number" placeholder="Max" value={haMax}
              onChange={(e) => setHaMax(e.target.value)} className="filter-number-input" />
          </div>
        </div>
      </div>
      <div className="filter-section-divider" />
      <div className="filter-section">
        <div className="filter-section-title">SCADA</div>
        <div className="filter-text-input-container">
          <input type="text" placeholder="Search SCADA..." value={scadaText}
            onChange={(e) => setScadaText(e.target.value)} className="filter-text-input" />
        </div>
      </div>
      <div className="filter-section-divider" />
      <div className="filter-section">
        <div className="filter-section-title">PV</div>
        <div className="filter-text-input-container">
          <input type="text" placeholder="Search PV..." value={pvText}
            onChange={(e) => setPvText(e.target.value)} className="filter-text-input" />
        </div>
      </div>
      <div className="filter-dropdown-footer">
        <button className="filter-clear-btn" onClick={() => { onClear(); onClose(); }}>Clear</button>
        <button className="filter-apply-btn" onClick={() => {
          onApply({
            haMin: haMin !== "" ? parseFloat(haMin) : null,
            haMax: haMax !== "" ? parseFloat(haMax) : null,
            scadaText,
            pvText,
          });
          onClose();
        }}>Apply</button>
      </div>
    </>
  );
}

function AvailDateFilter({ orders, activeFilter, onApply, onClear, onClose }) {
  const [from, setFrom] = useState(activeFilter?.from || "");
  const [to, setTo] = useState(activeFilter?.to || "");
  const [selectedSubTexts, setSelectedSubTexts] = useState(
    () => new Set(activeFilter?.subTexts || [])
  );

  const allSubTexts = [...new Set(orders.map((o) => {
    const v = o.target_avail_date || o._originalAvailDate || "";
    if (!v) return null;
    if (v === "prio replenish") return "prio replenish";
    if (v === "safety stocks") return "safety stocks";
    if (v.includes("TLD")) return "TLD";
    if (v.includes("Sufficient")) return "Sufficient";
    return null;
  }).filter(Boolean))].sort();

  function toggleSub(val) {
    const next = new Set(selectedSubTexts);
    if (next.has(val)) next.delete(val); else next.add(val);
    setSelectedSubTexts(next);
  }

  return (
    <>
      <div className="filter-dropdown-header">
        <span className="filter-dropdown-title">Filter: Avail Date</span>
        <button className="filter-close-btn" onClick={onClose}>✕</button>
      </div>
      <div className="filter-section">
        <div className="filter-section-title">Date Range</div>
        <div className="filter-date-inputs">
          <div className="filter-date-field">
            <label>From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="filter-date-input" autoFocus />
          </div>
          <div className="filter-date-field">
            <label>To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="filter-date-input" />
          </div>
        </div>
      </div>
      {allSubTexts.length > 0 && (
        <>
          <div className="filter-section-divider" />
          <div className="filter-section">
            <div className="filter-section-title">Type</div>
            <div className="filter-options-list" style={{ maxHeight: 120 }}>
              {allSubTexts.map((text) => (
                <label key={text} className="filter-option">
                  <input type="checkbox" checked={selectedSubTexts.has(text)} onChange={() => toggleSub(text)} />
                  <span>{text}</span>
                </label>
              ))}
            </div>
          </div>
        </>
      )}
      <div className="filter-dropdown-footer">
        <button className="filter-clear-btn" onClick={() => { onClear(); onClose(); }}>Clear</button>
        <button className="filter-apply-btn" onClick={() => {
          onApply({ from, to, subTexts: Array.from(selectedSubTexts) });
          onClose();
        }}>Apply</button>
      </div>
    </>
  );
}

function CompletionDateFilter({ activeFilter, onApply, onClear, onClose }) {
  const [from, setFrom] = useState(activeFilter?.from || "");
  const [to, setTo] = useState(activeFilter?.to || "");
  const [fromTime, setFromTime] = useState(activeFilter?.fromTime || "");
  const [toTime, setToTime] = useState(activeFilter?.toTime || "");

  return (
    <>
      <div className="filter-dropdown-header">
        <span className="filter-dropdown-title">Filter: Completion Date</span>
        <button className="filter-close-btn" onClick={onClose}>✕</button>
      </div>
      <div className="filter-section">
        <div className="filter-section-title">Date Range</div>
        <div className="filter-date-inputs">
          <div className="filter-date-field"><label>From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="filter-date-input" autoFocus />
          </div>
          <div className="filter-date-field"><label>To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="filter-date-input" />
          </div>
        </div>
      </div>
      <div className="filter-section-divider" />
      <div className="filter-section">
        <div className="filter-section-title">Time Range</div>
        <div className="filter-time-inputs">
          <div className="filter-time-field"><label>From</label>
            <input type="time" value={fromTime} onChange={(e) => setFromTime(e.target.value)}
              className="filter-time-input" />
          </div>
          <span className="filter-range-separator">—</span>
          <div className="filter-time-field"><label>To</label>
            <input type="time" value={toTime} onChange={(e) => setToTime(e.target.value)}
              className="filter-time-input" />
          </div>
        </div>
      </div>
      <div className="filter-dropdown-footer">
        <button className="filter-clear-btn" onClick={() => { onClear(); onClose(); }}>Clear</button>
        <button className="filter-apply-btn" onClick={() => {
          onApply({ from, to, fromTime, toTime });
          onClose();
        }}>Apply</button>
      </div>
    </>
  );
}

function EndDateFilter({ activeFilter, onApply, onClear, onClose }) {
  const [from, setFrom] = useState(activeFilter?.from || "");
  const [to, setTo] = useState(activeFilter?.to || "");
  const [fromTime, setFromTime] = useState(activeFilter?.fromTime || "");
  const [toTime, setToTime] = useState(activeFilter?.toTime || "");

  return (
    <>
      <div className="filter-dropdown-header">
        <span className="filter-dropdown-title">Filter: End Date</span>
        <button className="filter-close-btn" onClick={onClose}>✕</button>
      </div>
      <div className="filter-section">
        <div className="filter-section-title">Date Range</div>
        <div className="filter-date-inputs">
          <div className="filter-date-field"><label>From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="filter-date-input" autoFocus />
          </div>
          <div className="filter-date-field"><label>To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="filter-date-input" />
          </div>
        </div>
      </div>
      <div className="filter-section-divider" />
      <div className="filter-section">
        <div className="filter-section-title">Time Range</div>
        <div className="filter-time-inputs">
          <div className="filter-time-field"><label>From</label>
            <input type="time" value={fromTime} onChange={(e) => setFromTime(e.target.value)}
              className="filter-time-input" />
          </div>
          <span className="filter-range-separator">—</span>
          <div className="filter-time-field"><label>To</label>
            <input type="time" value={toTime} onChange={(e) => setToTime(e.target.value)}
              className="filter-time-input" />
          </div>
        </div>
      </div>
      <div className="filter-dropdown-footer">
        <button className="filter-clear-btn" onClick={() => { onClear(); onClose(); }}>Clear</button>
        <button className="filter-apply-btn" onClick={() => {
          onApply({ from, to, fromTime, toTime });
          onClose();
        }}>Apply</button>
      </div>
    </>
  );
}

/* ─── FilterDropdown portal ──────────────────────────────────────────────── */
export function FilterDropdown({ colKey, orders, activeFilter, position, onApply, onClear, onClose }) {
  const config = COLUMN_FILTER_CONFIG[colKey];
  const dropdownRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  if (!config) return null;

  const style = {
    position: "fixed",
    left: Math.min(position.x, window.innerWidth - 320),
    top: Math.min(position.y, window.innerHeight - 420),
    zIndex: 10000,
  };

  const commonProps = { config, orders, activeFilter, onApply, onClear, onClose };

  let content = null;
  if (config.type === "custom") {
    switch (config.component) {
      case "ItemDescriptionFilter":
        content = <ItemDescriptionFilter orders={orders} activeFilter={activeFilter} onApply={onApply} onClear={onClear} onClose={onClose} />;
        break;
      case "ProductionTimeFilter":
        content = <ProductionTimeFilter activeFilter={activeFilter} onApply={onApply} onClear={onClear} onClose={onClose} />;
        break;
      case "HAInfoFilter":
        content = <HAInfoFilter activeFilter={activeFilter} onApply={onApply} onClear={onClear} onClose={onClose} />;
        break;
      case "AvailDateFilter":
        content = <AvailDateFilter orders={orders} activeFilter={activeFilter} onApply={onApply} onClear={onClear} onClose={onClose} />;
        break;
      case "CompletionDateFilter":
        content = <CompletionDateFilter activeFilter={activeFilter} onApply={onApply} onClear={onClear} onClose={onClose} />;
        break;
      case "EndDateFilter":
        content = <EndDateFilter activeFilter={activeFilter} onApply={onApply} onClear={onClear} onClose={onClose} />;
        break;
      default:
        return null;
    }
  } else {
    switch (config.type) {
      case "multi-select":
        content = <MultiSelectFilter {...commonProps} />;
        break;
      case "text-search":
        content = <TextSearchFilter {...commonProps} />;
        break;
      case "number-range":
        content = <NumberRangeFilter {...commonProps} />;
        break;
      case "date-range":
        content = <DateRangeFilter {...commonProps} />;
        break;
      case "time-range":
        content = <TimeRangeFilter {...commonProps} />;
        break;
      case "toggle":
        content = <ToggleFilter {...commonProps} />;
        break;
      default:
        return null;
    }
  }

  return createPortal(
    <div ref={dropdownRef} className="filter-dropdown" style={style}>
      {content}
    </div>,
    document.body
  );
}

/* ─── GroupContextMenu portal ────────────────────────────────────────────── */
export function GroupContextMenu({ position, label, onHide, onClose }) {
  const menuRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="col-context-menu"
      style={{
        position: "fixed",
        left: position.x,
        top: position.y,
        zIndex: 10000,
      }}
    >
      <div
        className="col-context-menu-item"
        onClick={() => { onHide(); onClose(); }}
      >
        Hide {label}
      </div>
    </div>,
    document.body
  );
}

/* ─── ColumnContextMenu portal ───────────────────────────────────────────── */
export function ColumnContextMenu({ position, onHide, onClose }) {
  const menuRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="col-context-menu"
      style={{
        position: "fixed",
        left: position.x,
        top: position.y,
        zIndex: 10000,
      }}
    >
      <div
        className="col-context-menu-item"
        onClick={() => { onHide(); onClose(); }}
      >
        Hide column
      </div>
    </div>,
    document.body
  );
}
