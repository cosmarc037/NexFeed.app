import React, { useState, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import {
  Upload, Download, Database, RefreshCw, Search, Loader2,
  Trash2, AlertTriangle, Calendar, History,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { format } from "date-fns";
import { toast } from "@/components/ui/notifications";

const { KnowledgeBase, KnowledgeBaseUpload } = base44.entities;

/* ─── Constants ─────────────────────────────────────────────────────────── */

const REQUIRED_FIELDS_KB = [
  { key: "fg_material_code",    label: "FG Material Code" },
  { key: "fg_item_description", label: "FG Item Description" },
];
const BATCH_FIELDS_KB     = ["batch_size_fm1","batch_size_fm2","batch_size_fm3","batch_size_pmx"];
const RUN_RATE_FIELDS_KB  = ["line_1_run_rate","line_2_run_rate","line_3_run_rate","line_4_run_rate","line_5_run_rate","line_6_run_rate","line_7_run_rate"];
const VALID_FORMS_KB      = ["P","MP","MP-CS","M","MX","C-S","C-M","C-L"];
const NUMERIC_COLS_KB     = new Set([...BATCH_FIELDS_KB, ...RUN_RATE_FIELDS_KB, "finished_goods_weight", "diameter", "undetermined_value"]);
const REQUIRED_KEYS_KB    = new Set(REQUIRED_FIELDS_KB.map(f => f.key));

function formatUploadDate(dateStr) {
  if (!dateStr) return "-";
  try { return format(new Date(dateStr), "MM/dd/yyyy hh:mm aa"); }
  catch { return dateStr; }
}

function formatDateTimeFull(ts) {
  if (!ts) return "-";
  try { return format(new Date(ts), "MMM d, yyyy 'at' h:mm aa"); }
  catch { return ts; }
}

function getTypeLabel(type) {
  switch (type) {
    case "file_upload":  return "File Upload";
    case "manual_edit":  return "Manual Edit";
    case "revert":       return "Revert";
    default:             return type;
  }
}

/* Deep clone — prevents shared references between snapshots and live state */
const deepClone = (data) => JSON.parse(JSON.stringify(data));

const formatRowForSave = (r) => {
  const toNum = v => { if (v === "" || v == null) return null; const n = parseFloat(v); return isNaN(n) ? null : n; };
  const toStr = v => v == null ? "" : String(v);
  return {
    fg_material_code:      toStr(r.fg_material_code),
    fg_item_description:   toStr(r.fg_item_description),
    sfg1_material_code:    toStr(r.sfg1_material_code),
    sfg_item_description:  toStr(r.sfg_item_description),
    diameter:              toNum(r.diameter),
    form:                  toStr(r.form),
    batch_size_fm1:        toNum(r.batch_size_fm1),
    batch_size_fm2:        toNum(r.batch_size_fm2),
    batch_size_fm3:        toNum(r.batch_size_fm3),
    batch_size_pmx:        toNum(r.batch_size_pmx),
    finished_goods_weight: toNum(r.finished_goods_weight),
    thread:                toStr(r.thread),
    sacks_material_code:   toStr(r.sacks_material_code),
    sacks_item_description:toStr(r.sacks_item_description),
    tags_material_code:    toStr(r.tags_material_code),
    tags_item_description: toStr(r.tags_item_description),
    label_1:               toStr(r.label_1),
    label_2:               toStr(r.label_2),
    line_1_run_rate:       toNum(r.line_1_run_rate),
    line_2_run_rate:       toNum(r.line_2_run_rate),
    line_3_run_rate:       toNum(r.line_3_run_rate),
    line_4_run_rate:       toNum(r.line_4_run_rate),
    line_5_run_rate:       toNum(r.line_5_run_rate),
    line_6_run_rate:       toNum(r.line_6_run_rate),
    line_7_run_rate:       toNum(r.line_7_run_rate),
  };
};

function getFieldLabel_kb(field) {
  const L = {
    fg_material_code:"FG Material Code", fg_item_description:"FG Item Description",
    sfg1_material_code:"SFG1 Material Code", sfg_item_description:"SFG Item Description",
    form:"Form", batch_size_fm1:"Batch FM1", batch_size_fm2:"Batch FM2",
    batch_size_fm3:"Batch FM3", batch_size_pmx:"Batch PMX",
    finished_goods_weight:"FG Weight", thread:"Thread",
    sacks_material_code:"Sacks Code", sacks_item_description:"Sacks Desc",
    tags_material_code:"Tags Code", tags_item_description:"Tags Desc",
    label_1:"Label 1", label_2:"Label 2",
    line_1_run_rate:"Run Rate L1", line_2_run_rate:"Run Rate L2",
    line_3_run_rate:"Run Rate L3", line_4_run_rate:"Run Rate L4",
    line_5_run_rate:"Run Rate L5", line_6_run_rate:"Run Rate L6",
    line_7_run_rate:"Run Rate L7",
  };
  return L[field] || field;
}

function validateKBData(data) {
  const errors = [];
  const isFilled = v => v != null && String(v).trim() !== "" && String(v).trim() !== "-";

  data.forEach(row => {
    // Only two required fields
    REQUIRED_FIELDS_KB.forEach(f => {
      if (!isFilled(row[f.key]))
        errors.push({ rowId: row.id, field: f.key });
    });

    // Numeric optional fields — valid only if a value is actually entered
    [...BATCH_FIELDS_KB, ...RUN_RATE_FIELDS_KB].forEach(f => {
      const v = row[f];
      if (isFilled(v) && (isNaN(parseFloat(v)) || parseFloat(v) <= 0))
        errors.push({ rowId: row.id, field: f });
    });

    // FG Weight — optional but must be positive if filled
    const w = row.finished_goods_weight;
    if (isFilled(w) && (isNaN(parseFloat(w)) || parseFloat(w) <= 0))
      errors.push({ rowId: row.id, field: "finished_goods_weight" });

  });
  return errors;
}

/* ─── Shared helpers ─────────────────────────────────────────────────────── */

function Spinner({ size = 13, color = "currentColor" }) {
  return (
    <svg className="loading-spinner" width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" stroke={color} strokeWidth="2" strokeLinecap="round" opacity="0.3" />
      <path d="M12.5 7a5.5 5.5 0 01-5.5 5.5" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/* ─── Sub-components ─────────────────────────────────────────────────────── */

function KBRowInsertLine({ onInsert }) {
  const [vis, setVis] = useState(false);
  return (
    <tr style={{ height: 8 }} onMouseEnter={() => setVis(true)} onMouseLeave={() => setVis(false)}>
      <td colSpan={999} style={{ padding: 0, position: "relative", height: 8 }}>
        {vis && (
          <div style={{ position:"absolute", top:"50%", left:0, right:0, transform:"translateY(-50%)", display:"flex", alignItems:"center", zIndex:5 }}>
            <button
              className="kb-insert-btn"
              onClick={onInsert}
              onMouseDown={e => e.preventDefault()}
            >+</button>
            <div className="kb-insert-line-bar" />
          </div>
        )}
      </td>
    </tr>
  );
}

function HistoryNotesCell({ summary, details }) {
  const [show, setShow] = useState(false);
  const [pos, setPos]   = useState({ x: 0, y: 0 });
  const tRef  = useRef(null);
  const cellRef = useRef(null);

  function clamp(x, y, w, h) {
    const vw = window.innerWidth, vh = window.innerHeight;
    return { x: Math.min(x, vw - w - 8), y: Math.min(y, vh - h - 8) };
  }

  return (
    <td
      ref={cellRef}
      className="history-notes-cell"
      onMouseEnter={() => {
        tRef.current = setTimeout(() => {
          if (cellRef.current) {
            const r = cellRef.current.getBoundingClientRect();
            setPos(clamp(r.left, r.bottom + 4, 400, 200));
          }
          setShow(true);
        }, 300);
      }}
      onMouseLeave={() => { clearTimeout(tRef.current); setShow(false); }}
    >
      <span className="history-notes-text">{summary}</span>
      {show && createPortal(
        <div className="history-notes-tooltip" style={{ left: pos.x, top: pos.y }}>
          <div className="tooltip-summary">{summary}</div>
          {details && (
            <>
              <div className="tooltip-divider" />
              <div className="tooltip-label">Details:</div>
              <div className="tooltip-details">
                {details.split("\n").map((l, i) => <div key={i} className="tooltip-detail-line">{l}</div>)}
              </div>
            </>
          )}
        </div>,
        document.body
      )}
    </td>
  );
}

function RevertDialog({ entry, onConfirm, onCancel, isSaving }) {
  const [text, setText] = useState("");
  const ok = text === "Confirm";
  return (
    <div className="kb-dialog-overlay" onClick={!isSaving ? onCancel : undefined}>
      <div className="kb-dialog-box" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
        <div className="kb-dialog-header">
          <span>⚠ Revert Master Data</span>
          {/* Fix 5: disable close button during revert */}
          <button className="kb-dialog-close" onClick={onCancel} disabled={isSaving} style={{ opacity: isSaving ? 0.4 : 1, cursor: isSaving ? "not-allowed" : "pointer" }}>✕</button>
        </div>
        <div className="kb-dialog-body">
          <p style={{ fontSize:12, color:"#374151", lineHeight:1.6 }}>You are about to revert the Master Data to the version saved at:</p>
          <p style={{ fontSize:13, fontWeight:600, color:"#1a1a1a", margin:"8px 0" }}>{formatDateTimeFull(entry.timestamp)}</p>
          <p style={{ fontSize:11, color:"#6b7280", marginBottom:12 }}>{entry.summary}</p>
          <p style={{ fontSize:12, color:"#374151", lineHeight:1.6 }}>This will replace the current Master Data with this version. All changes made after this point will be lost.</p>
          <p style={{ fontSize:12, color:"#374151", lineHeight:1.6, marginTop:12 }}>Type <strong>Confirm</strong> to proceed:</p>
          {/* Fix 5: disable input during loading */}
          <input
            type="text" value={text} onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && ok && !isSaving) onConfirm(); }}
            placeholder="Type Confirm"
            disabled={isSaving}
            autoFocus
            style={{ width:"100%", padding:"8px 12px", fontSize:13, border:`1px solid ${ok ? "#43a047" : "#e5e7eb"}`, borderRadius:6, marginTop:8, outline:"none", opacity: isSaving ? 0.5 : 1 }}
          />
        </div>
        <div className="kb-dialog-footer">
          {/* Fix 5: disable cancel button during loading */}
          <button
            onClick={onCancel}
            disabled={isSaving}
            style={{ background:"#fff", color:"#374151", border:"1px solid #d1d5db", borderRadius:6, padding:"8px 20px", fontSize:13, cursor: isSaving ? "not-allowed" : "pointer", opacity: isSaving ? 0.5 : 1 }}
          >
            Cancel
          </button>
          {/* Fix 5: spinner on Revert button */}
          <button
            onClick={() => ok && !isSaving && onConfirm()}
            disabled={!ok || isSaving}
            style={{ background: (ok && !isSaving) ? "#fd5108" : "#d1d5db", color:"#fff", border:"none", borderRadius:6, padding:"8px 20px", fontSize:13, fontWeight:600, cursor: (ok && !isSaving) ? "pointer" : "not-allowed", display:"inline-flex", alignItems:"center", gap:6 }}
          >
            {isSaving && <Spinner size={12} color="#fff" />}
            {isSaving ? "Reverting…" : "Revert"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Main component ─────────────────────────────────────────────────────── */

export default function KnowledgeBaseManager({ orders, onReapply }) {
  const queryClient = useQueryClient();
  const fileRef = useRef(null);

  /* existing state */
  const [isUploading,       setIsUploading]       = useState(false);
  const [searchTerm,        setSearchTerm]         = useState("");
  const [showReapplyConfirm,setShowReapplyConfirm] = useState(false);
  const [isReapplying,      setIsReapplying]       = useState(false);
  const [deleteTarget,      setDeleteTarget]       = useState(null);
  const [isDeleting,        setIsDeleting]         = useState(false);
  const [confirmText,       setConfirmText]        = useState("");
  const [historySearch,     setHistorySearch]      = useState("");
  const [historyDateFilter, setHistoryDateFilter]  = useState("");

  /* edit-mode state */
  const [isEditMode,        setIsEditMode]         = useState(false);
  const [editData,          setEditData]           = useState([]);
  const [originalData,      setOriginalData]       = useState([]);
  const [changes,           setChanges]            = useState([]);
  const [validationErrors,  setValidationErrors]   = useState([]);
  const [selectedRows,      setSelectedRows]       = useState(new Set());
  const [kbContextMenu,     setKbContextMenu]      = useState(null);
  const [discardConfirmOpen,setDiscardConfirmOpen] = useState(false);
  const [isSaving,          setIsSaving]           = useState(false);
  const [editHistory,       setEditHistory]        = useState(() => {
    try { const s = localStorage.getItem("nexfeed_kb_history"); return s ? JSON.parse(s) : []; }
    catch { return []; }
  });
  const [revertTarget,      setRevertTarget]       = useState(null);
  const [deleteHistoryTarget,setDeleteHistoryTarget] = useState(null);
  const [deleteHistoryConfirmText, setDeleteHistoryConfirmText] = useState("");
  /* Fix 1: preserve display order after save */
  const [savedViewData,     setSavedViewData]      = useState(null);
  /* Fix 1: independent snapshots for each uploaded file (keyed by session_id) */
  const [uploadSnapshots,   setUploadSnapshots]    = useState(() => {
    try { const s = localStorage.getItem("nexfeed_kb_upload_snapshots"); return s ? JSON.parse(s) : {}; }
    catch { return {}; }
  });

  /* queries */
  const { data: kbRecords = [] } = useQuery({
    queryKey: ["kb"],
    queryFn: () => KnowledgeBase.list("id", 2000),
  });
  const { data: uploads = [] } = useQuery({
    queryKey: ["kb_uploads"],
    queryFn: () => KnowledgeBaseUpload.list("-created_date"),
  });

  const activeUpload = uploads[0] || null;
  const activeKB = activeUpload
    ? kbRecords.filter(r => r.upload_session_id === activeUpload.upload_session_id)
    : [];

  const kbSearchFilter = (row) =>
    !searchTerm ||
    (row.fg_item_description  || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
    (row.fg_material_code     || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
    (row.sfg1_material_code   || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
    (row.sfg_item_description || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
    (row.thread               || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
    (row.sacks_item_description || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
    (row.tags_item_description  || "").toLowerCase().includes(searchTerm.toLowerCase());

  const filteredKB = activeKB.filter(kbSearchFilter);

  /* Fix 1+2: use savedViewData (preserves save/revert order), sort by _originalIndex when available */
  const _displayBase = savedViewData ? savedViewData.filter(kbSearchFilter) : filteredKB;
  const displayRows = _displayBase.length > 0 && _displayBase[0]?._originalIndex != null
    ? [..._displayBase].sort((a, b) => (a._originalIndex ?? 0) - (b._originalIndex ?? 0))
    : _displayBase;

  /* ── Duplicate FG Material Code detection ── */
  const [duplicateMaterialCodes, duplicateCountMap] = useMemo(() => {
    const rows = isEditMode ? editData : (savedViewData ?? activeKB);
    if (!rows?.length) return [new Set(), {}];
    const count = {};
    rows.forEach(r => {
      const code = normalizeVal(r.fg_material_code);
      if (code) count[code] = (count[code] || 0) + 1;
    });
    const dups = new Set(Object.entries(count).filter(([, n]) => n > 1).map(([code]) => code));
    return [dups, count];
  }, [isEditMode, editData, savedViewData, activeKB]);

  function isDuplicateMaterialCode(row) {
    const code = normalizeVal(row.fg_material_code);
    return code !== '' && duplicateMaterialCodes.has(code);
  }

  /* ── Edited-cell highlighting: baseline = the stored upload snapshot for the active session ── */
  const baselineByCode = useMemo(() => {
    const snap = uploadSnapshots[activeUpload?.upload_session_id];
    if (!snap?.length) return null;
    const map = {};
    snap.forEach(r => { if (r.fg_material_code) map[r.fg_material_code] = r; });
    return map;
  }, [uploadSnapshots, activeUpload?.upload_session_id]);

  /* Normalize values before comparison — prevents false highlights from:
     - null / undefined vs ""   → all collapse to ''
     - whitespace               → trim
     - numeric type mismatches  → 4, "4", "4.0", "4.000" all → "4"
     - Excel full-precision vs DB → DB columns are numeric(10,3), so
       8.258131953810624 (Excel) and "8.258" (DB) both normalize to "8.258"
       22.6796 (Excel) and "22.680" (DB) both normalize to "22.68" */
  function normalizeVal(v) {
    if (v === null || v === undefined) return '';
    const s = String(v).trim();
    if (s === '') return '';
    // Purely numeric strings → round to 3dp (matching numeric(10,3) DB
    // precision), then strip trailing zeros via parseFloat
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      const n = parseFloat(s);
      if (!isNaN(n)) return String(parseFloat(n.toFixed(3)));
    }
    return s;
  }

  function isCellEdited(row, field) {
    if (!baselineByCode) return false;
    const base = baselineByCode[row.fg_material_code];
    if (!base) return true; // new row — all data cells considered edited
    return normalizeVal(row[field]) !== normalizeVal(base[field]);
  }

  function getOriginalValue(row, field) {
    if (!baselineByCode) return '';
    const base = baselineByCode[row.fg_material_code];
    if (!base) return '(new row)';
    return normalizeVal(base[field]);
  }

  /* persist editHistory to localStorage */
  useEffect(() => {
    try { localStorage.setItem("nexfeed_kb_history", JSON.stringify(editHistory)); }
    catch (e) { console.warn("Failed to save KB history:", e); }
  }, [editHistory]);

  /* persist uploadSnapshots to localStorage */
  useEffect(() => {
    try { localStorage.setItem("nexfeed_kb_upload_snapshots", JSON.stringify(uploadSnapshots)); }
    catch (e) { console.warn("Failed to save upload snapshots:", e); }
  }, [uploadSnapshots]);

  /* unified history: file uploads (from DB) + manual edits/reverts (from localStorage) */
  const uploadEntries = uploads.map(u => ({
    id: `upload_${u.id}`,
    type: "file_upload",
    timestamp: u.created_date || new Date().toISOString(),
    summary: `Uploaded: ${u.filename} (${u.record_count ?? "?"} records)`,
    details: `File "${u.filename}" uploaded as new Master Data with ${u.record_count ?? "?"} records.`,
    fileUrl: u.file_url,
    _upload: u,
  }));
  const localEntries = editHistory.filter(e => e.type !== "file_upload");
  const unifiedHistory = [...uploadEntries, ...localEntries]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const filteredUnifiedHistory = unifiedHistory.filter(entry => {
    const txt = historySearch.toLowerCase();
    const matchSearch = !txt ||
      (entry.summary || "").toLowerCase().includes(txt) ||
      (entry._upload?.filename || "").toLowerCase().includes(txt);
    const matchDate = !historyDateFilter ||
      (entry.timestamp || "").startsWith(historyDateFilter);
    return matchSearch && matchDate;
  });

  /* context menu close on outside click / Escape */
  useEffect(() => {
    if (!kbContextMenu) return;
    const close = () => setKbContextMenu(null);
    const onKey = e => { if (e.key === "Escape") close(); };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [kbContextMenu]);

  /* ── Edit-mode handlers ─────────────────────────────────────────────── */

  const handleToggleEditMode = () => {
    const copy = activeKB.map(r => ({ ...r }));
    setEditData(copy);
    setOriginalData(copy.map(r => ({ ...r })));
    setChanges([]);
    setValidationErrors([]);
    setSelectedRows(new Set());
    setSearchTerm("");
    setSavedViewData(null);   /* clear saved order so DB order is used as fresh base */
    setIsEditMode(true);
  };

  const handleCellChange = (rowId, field, value) => {
    setEditData(prev => prev.map(r => r.id === rowId ? { ...r, [field]: value } : r));
    setValidationErrors(prev => prev.filter(e => !(e.rowId === rowId && e.field === field)));
    setChanges(prev => [...prev, { type: "modify", rowId, field, newValue: value }]);
  };

  const handleInsertRow = (afterIndex) => {
    const newRow = {
      id: `new_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      fg_material_code:"", fg_item_description:"",
      sfg1_material_code:"", sfg_item_description:"",
      diameter:"", form:"",
      batch_size_fm1:"", batch_size_fm2:"", batch_size_fm3:"", batch_size_pmx:"",
      finished_goods_weight:"", thread:"",
      sacks_material_code:"", sacks_item_description:"",
      tags_material_code:"", tags_item_description:"",
      label_1:"", label_2:"",
      line_1_run_rate:"", line_2_run_rate:"", line_3_run_rate:"", line_4_run_rate:"",
      line_5_run_rate:"", line_6_run_rate:"", line_7_run_rate:"",
      _isNew: true,
    };
    setEditData(prev => {
      const a = [...prev];
      a.splice(afterIndex + 1, 0, newRow);
      return a;
    });
    setChanges(prev => [...prev, { type: "add", rowId: newRow.id }]);
  };

  const handleDeleteRow = (rowId) => {
    setEditData(prev => prev.filter(r => r.id !== rowId));
    setSelectedRows(prev => { const s = new Set(prev); s.delete(rowId); return s; });
    setKbContextMenu(null);
    setChanges(prev => [...prev, { type: "delete", rowId }]);
  };

  const handleDeleteSelected = () => {
    selectedRows.forEach(id => setChanges(prev => [...prev, { type: "delete", rowId: id }]));
    setEditData(prev => prev.filter(r => !selectedRows.has(r.id)));
    setSelectedRows(new Set());
  };

  const toggleRowSelection = (rowId) => {
    setSelectedRows(prev => { const s = new Set(prev); s.has(rowId) ? s.delete(rowId) : s.add(rowId); return s; });
  };

  const toggleAllRows = () => {
    setSelectedRows(selectedRows.size === editData.length ? new Set() : new Set(editData.map(r => r.id)));
  };

  const getCellError = (rowId, field) => validationErrors.some(e => e.rowId === rowId && e.field === field);

  const handleRowContextMenu = (e, row, rowIndex) => {
    if (!isEditMode) return;
    e.preventDefault();
    setKbContextMenu({ row, rowIndex, position: { x: e.clientX, y: e.clientY } });
  };

  const handleSaveChanges = async () => {
    const errors = validateKBData(editData);
    if (errors.length > 0) {
      setValidationErrors(errors);
      const uniqueRows = new Set(errors.map(e => e.rowId)).size;
      toast.error(`Cannot save. Found errors in ${uniqueRows} row(s). Please fix the highlighted fields.`);
      return;
    }
    setIsSaving(true);
    try {
      const origIds  = new Set(originalData.map(r => r.id));
      const editIds  = new Set(editData.filter(r => !String(r.id).startsWith("new_")).map(r => r.id));
      const deletedIds = [...origIds].filter(id => !editIds.has(id));
      const newRows    = editData.filter(r => String(r.id).startsWith("new_"));
      const modifiedRows = editData.filter(r => {
        if (String(r.id).startsWith("new_")) return false;
        const orig = originalData.find(o => o.id === r.id);
        if (!orig) return false;
        return JSON.stringify(formatRowForSave(r)) !== JSON.stringify(formatRowForSave(orig));
      });

      await Promise.all([
        ...deletedIds.map(id => KnowledgeBase.delete(id)),
        ...newRows.map(r => KnowledgeBase.create({ ...formatRowForSave(r), upload_session_id: activeUpload?.upload_session_id || `kb_manual_${Date.now()}` })),
        ...modifiedRows.map(r => KnowledgeBase.update(r.id, formatRowForSave(r))),
      ]);

      queryClient.invalidateQueries({ queryKey: ["kb"] });

      const aCount = newRows.length, dCount = deletedIds.length, mCount = modifiedRows.length;
      const parts = [];
      if (mCount > 0) parts.push(`${mCount} row(s) modified`);
      if (aCount > 0) parts.push(`${aCount} row(s) added`);
      if (dCount > 0) parts.push(`${dCount} row(s) deleted`);
      const summary = parts.length > 0 ? `Manual edit — ${parts.join(", ")}` : "Manual edit — no changes";

      /* build details string */
      const detailLines = [];
      newRows.forEach(r => {
        detailLines.push(`Added new row: ${r.fg_material_code || "New"} - ${r.fg_item_description || "Untitled"}`);
      });
      deletedIds.forEach(id => {
        const orig = originalData.find(o => o.id === id);
        if (orig) detailLines.push(`Deleted row: ${orig.fg_material_code} - ${orig.fg_item_description}`);
      });
      modifiedRows.forEach(r => {
        const orig = originalData.find(o => o.id === r.id);
        if (!orig) return;
        const fieldChanges = colHeaders
          .filter(col => String(orig[col.key] ?? "") !== String(r[col.key] ?? ""))
          .map(col => `${col.label}: ${orig[col.key] ?? "-"} → ${r[col.key] ?? "-"}`);
        if (fieldChanges.length) {
          detailLines.push(`Modified ${r.fg_material_code} - ${r.fg_item_description}: ${fieldChanges.join(", ")}`);
        }
      });
      const details = detailLines.join("\n");

      if (aCount > 0 || dCount > 0 || mCount > 0) {
        /* Fix 1: deep-clone the snapshot so it's fully independent */
        const snap = deepClone(editData);
        setEditHistory(prev => [{ id: Date.now(), type: "manual_edit", timestamp: new Date().toISOString(), summary, details, snapshot: snap }, ...prev]);
      }

      /* Fix 1: preserve display order — store deep-cloned editData snapshot for read-only view */
      const viewSnap = deepClone(editData);
      setSavedViewData(viewSnap);
      setIsEditMode(false);
      setChanges([]);
      setValidationErrors([]);
      setSelectedRows(new Set());
      toast.success("Master Data saved successfully.");
    } catch (err) {
      toast.error("Save failed: " + err.message);
    }
    setIsSaving(false);
  };

  const handleDiscard = () => {
    if (changes.length === 0) { setIsEditMode(false); setValidationErrors([]); return; }
    setDiscardConfirmOpen(true);
  };

  const handleConfirmDiscard = () => {
    setEditData([]); setOriginalData([]); setChanges([]);
    setValidationErrors([]); setSelectedRows(new Set());
    setIsEditMode(false); setDiscardConfirmOpen(false);
  };

  const handleRevertConfirm = async () => {
    if (!revertTarget) return;
    setIsSaving(true);
    try {
      const sessionId = activeUpload?.upload_session_id || `kb_revert_${Date.now()}`;
      const currentRecs = kbRecords.filter(r => r.upload_session_id === sessionId);

      let sourceRows;
      if (revertTarget.type === "file_upload") {
        const targetSessionId = revertTarget._upload?.upload_session_id;
        /* Fix 1: use the stored upload snapshot (not possibly-mutated DB records).
           Manual edits mutate the DB records in-place (same session_id), so we can't
           trust DB lookup to return the original file data. Use snapshots instead. */
        const snap = uploadSnapshots[targetSessionId];
        if (snap?.length) {
          sourceRows = deepClone(snap);
          /* Highlight fix: if reverting to a DIFFERENT session's file upload, update
             the baseline for the current session so highlights clear correctly */
          if (targetSessionId !== sessionId) {
            setUploadSnapshots(prev => ({ ...prev, [sessionId]: deepClone(snap) }));
          }
        } else {
          /* Fallback: try DB records — may not reflect original data after edits */
          sourceRows = kbRecords.filter(r => r.upload_session_id === targetSessionId);
        }
        if (!sourceRows?.length) {
          toast.error("Records for this version are no longer available.");
          setIsSaving(false); setRevertTarget(null); return;
        }
      } else {
        if (!revertTarget.snapshot?.length) {
          toast.error("No snapshot data available for this entry.");
          setIsSaving(false); setRevertTarget(null); return;
        }
        sourceRows = deepClone(revertTarget.snapshot);
      }

      await Promise.all(currentRecs.map(r => KnowledgeBase.delete(r.id)));
      await KnowledgeBase.bulkCreate(sourceRows.map(r => ({ ...formatRowForSave(r), upload_session_id: sessionId })));
      queryClient.invalidateQueries({ queryKey: ["kb"] });

      /* Fix 1: deep-clone snapshot for the new revert history entry */
      const revertSnap = deepClone(sourceRows);
      setEditHistory(prev => [{
        id: Date.now(), type: "revert",
        timestamp: new Date().toISOString(),
        summary: `Reverted to: ${revertTarget.summary}`,
        snapshot: revertSnap,
      }, ...prev]);

      /* Fix 2: immediately show the restored data in correct order */
      setSavedViewData(deepClone(sourceRows));
      setRevertTarget(null);
      toast.success("Master Data reverted successfully.");
    } catch (err) {
      toast.error("Revert failed: " + err.message);
    }
    setIsSaving(false);
  };

  const handleDownloadSnapshot = (entry) => {
    if (entry.type === "file_upload") {
      /* file_url is always "" — generate XLSX from the stored upload snapshot instead */
      const sessionId = entry._upload?.upload_session_id;
      const snap = uploadSnapshots[sessionId];
      if (!snap?.length) { toast.info("Download not available — snapshot not found."); return; }
      try {
        const rows = snap.map(r => ({
          "FG Material Code": r.fg_material_code, "FG Item Description": r.fg_item_description,
          "SFG1 Material Code": r.sfg1_material_code, "SFG Item Description": r.sfg_item_description,
          "Form": r.form, "Batch Size FM1": r.batch_size_fm1, "Batch Size FM2": r.batch_size_fm2,
          "Batch Size FM3": r.batch_size_fm3, "Batch Size PMX": r.batch_size_pmx,
          "Finished Goods Weight": r.finished_goods_weight, "Thread": r.thread,
          "Sacks Material Code": r.sacks_material_code, "Sacks Item Description": r.sacks_item_description,
          "Tags Material Code": r.tags_material_code, "Tags Item Description": r.tags_item_description,
          "Label 1": r.label_1, "Label 2": r.label_2,
          "Line 1 Run Rate": r.line_1_run_rate, "Line 2 Run Rate": r.line_2_run_rate,
          "Line 3 Run Rate": r.line_3_run_rate, "Line 4 Run Rate": r.line_4_run_rate,
          "Line 5 Run Rate": r.line_5_run_rate, "Line 6 Run Rate": r.line_6_run_rate,
          "Line 7 Run Rate": r.line_7_run_rate,
        }));
        const ws = XLSX.utils.json_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Master Data");
        const baseName = entry._upload?.filename
          ? entry._upload.filename.replace(/\.[^/.]+$/, "")
          : `kb_upload_${entry.timestamp ? format(new Date(entry.timestamp), "yyyy-MM-dd_HHmm") : "snapshot"}`;
        XLSX.writeFile(wb, `${baseName}.xlsx`);
        toast.success("File exported.");
      } catch (err) { toast.error("Download failed: " + err.message); }
      return;
    }
    if (!entry.snapshot?.length) { toast.info("No snapshot data available."); return; }
    try {
      const rows = entry.snapshot.map(r => ({
        "FG Material Code": r.fg_material_code, "FG Item Description": r.fg_item_description,
        "SFG1 Material Code": r.sfg1_material_code, "SFG Item Description": r.sfg_item_description,
        "Form": r.form, "Batch Size FM1": r.batch_size_fm1, "Batch Size FM2": r.batch_size_fm2,
        "Batch Size FM3": r.batch_size_fm3, "Batch Size PMX": r.batch_size_pmx,
        "Finished Goods Weight": r.finished_goods_weight, "Thread": r.thread,
        "Sacks Material Code": r.sacks_material_code, "Sacks Item Description": r.sacks_item_description,
        "Tags Material Code": r.tags_material_code, "Tags Item Description": r.tags_item_description,
        "Label 1": r.label_1, "Label 2": r.label_2,
        "Line 1 Run Rate": r.line_1_run_rate, "Line 2 Run Rate": r.line_2_run_rate,
        "Line 3 Run Rate": r.line_3_run_rate, "Line 4 Run Rate": r.line_4_run_rate,
        "Line 5 Run Rate": r.line_5_run_rate, "Line 6 Run Rate": r.line_6_run_rate,
        "Line 7 Run Rate": r.line_7_run_rate,
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Master Data");
      const d = entry.timestamp ? format(new Date(entry.timestamp), "yyyy-MM-dd_HHmm") : "snapshot";
      XLSX.writeFile(wb, `kb_snapshot_${d}.xlsx`);
      toast.success("Snapshot exported.");
    } catch (err) { toast.error("Download failed: " + err.message); }
  };

  const handleDeleteHistoryEntry = (entry) => {
    const isActiveEntry = unifiedHistory[0]?.id === entry.id;
    if (!isActiveEntry && entry.type === "file_upload") {
      /* non-active file upload → existing upload delete dialog */
      setDeleteTarget({ upload: entry._upload, isActive: false });
    } else {
      /* all active entries, and non-active manual_edit/revert → our unified dialog */
      setDeleteHistoryTarget(entry);
      setDeleteHistoryConfirmText("");
    }
  };

  const handleConfirmDeleteHistoryEntry = async () => {
    if (!deleteHistoryTarget) return;
    const isActiveEntry = unifiedHistory[0]?.id === deleteHistoryTarget.id;

    if (isActiveEntry) {
      setIsSaving(true);
      try {
        /* Fix 3: allow deleting the last remaining history entry — clears the KB */
        if (unifiedHistory.length <= 1) {
          /* Delete all KB records */
          await Promise.all(kbRecords.map(r => KnowledgeBase.delete(r.id)));
          if (deleteHistoryTarget.type === "file_upload") {
            await KnowledgeBaseUpload.delete(deleteHistoryTarget._upload.id);
            queryClient.invalidateQueries({ queryKey: ["kb_uploads"] });
          } else {
            setEditHistory([]);
          }
          queryClient.invalidateQueries({ queryKey: ["kb"] });
          setSavedViewData(null);
          toast.info("Master Data cleared. Upload a new file or add data manually.");
          setDeleteHistoryTarget(null); setDeleteHistoryConfirmText("");
          setIsSaving(false); return;
        }

        const nextEntry = unifiedHistory[1];
        const sessionId = activeUpload?.upload_session_id;
        const currentRecs = kbRecords.filter(r => r.upload_session_id === sessionId);

        /* Fix 1: use upload snapshot for file_upload nextEntry instead of
           possibly-mutated DB records. Manual edits mutate DB records in-place,
           so DB lookup would return edited data, not the original file data. */
        let sourceRows = [];
        if (nextEntry.type === "file_upload") {
          const nextSessionId = nextEntry._upload?.upload_session_id;
          const snap = uploadSnapshots[nextSessionId];
          if (snap?.length) {
            sourceRows = deepClone(snap);
          } else {
            /* Fallback to DB records if no snapshot stored */
            sourceRows = kbRecords.filter(r => r.upload_session_id === nextSessionId);
          }
        } else if (nextEntry.snapshot?.length) {
          sourceRows = deepClone(nextEntry.snapshot);
        }

        if (sourceRows.length > 0) {
          await Promise.all(currentRecs.map(r => KnowledgeBase.delete(r.id)));
          await KnowledgeBase.bulkCreate(sourceRows.map(r => ({ ...formatRowForSave(r), upload_session_id: sessionId })));
          queryClient.invalidateQueries({ queryKey: ["kb"] });
        }

        /* remove the active entry from its source */
        if (deleteHistoryTarget.type === "file_upload") {
          await KnowledgeBaseUpload.delete(deleteHistoryTarget._upload.id);
          queryClient.invalidateQueries({ queryKey: ["kb_uploads"] });
        } else {
          setEditHistory(prev => prev.filter(e => e.id !== deleteHistoryTarget.id));
        }

        /* Fix 2: immediately show the restored data so the table reflects the change */
        setSavedViewData(sourceRows.length > 0 ? deepClone(sourceRows) : null);
        toast.info("Active version deleted. Master Data reverted to previous version.");
      } catch (err) {
        toast.error("Delete failed: " + err.message);
      }
      setIsSaving(false);
    } else {
      /* non-active manual_edit / revert — sync but guard against double-click */
      setIsSaving(true);
      setEditHistory(prev => prev.filter(e => e.id !== deleteHistoryTarget.id));
      toast.success("History entry deleted.");
      setIsSaving(false);
    }

    setDeleteHistoryTarget(null);
    setDeleteHistoryConfirmText("");
  };

  /* ── Upload handlers ────────────────────────────────────────────────── */

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploading(true);
    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: "array" });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "" });

      let headerRowIdx = rawRows.findIndex(row => row.some(cell => String(cell).trim().toLowerCase() === "fg material code"));
      if (headerRowIdx < 0) headerRowIdx = 0;
      const headers = rawRows[headerRowIdx].map(h => String(h).trim());

      const KB_COLUMN_MAP = {
        "fg material code":"FG Material Code", "fg item description":"FG Item Description",
        "sfg1 material code":"SFG1 Material Code", "sfg item description":"SFG Item Description",
        diamater:"Diamater", diameter:"Diamater", form:"Form",
        "batch size fm1":"Batch Size FM1", "batch size fm2":"Batch Size FM2",
        "batch size fm3":"Batch Size FM3", "batch size pmx":"Batch Size PMX",
        "finished goods weight":"Finished Goods Weight", thread:"Thread",
        "sacks material code":"Sacks Material Code", "sacks item description":"Sacks Item Description",
        "tags material code":"Tags Material Code", "tags item description":"Tags Item Description",
        "label 1":"Label 1", "label 2":"Label 2",
        "undetermined value":"Undetermined Value",
        "line 1 run rate":"Line 1 Run Rate", "line 2 run rate":"Line 2 Run Rate",
        "line 3 run rate":"Line 3 Run Rate", "line 4 run rate":"Line 4 Run Rate",
        "line 5 run rate":"Line 5 Run Rate", "line 6 run rate":"Line 6 Run Rate",
        "line 7 run rate":"Line 7 Run Rate",
      };

      const colIndex = {};
      headers.forEach((h, i) => { const k = h.toLowerCase(); if (KB_COLUMN_MAP[k]) colIndex[KB_COLUMN_MAP[k]] = i; });

      const dataRows = rawRows.slice(headerRowIdx + 1).filter(row => row.some(c => c !== "" && c != null));
      const toNum = v => { if (v === "" || v == null) return null; const n = parseFloat(v); return isNaN(n) ? null : n; };

      const excelRows = dataRows.map(row => {
        const obj = {};
        for (const [field, idx] of Object.entries(colIndex)) {
          let val = row[idx]; if (val != null) val = String(val).trim();
          obj[field] = val || "";
        }
        return obj;
      }).filter(r => r["FG Material Code"]);

      const sessionId = `kb_${Date.now()}`;
      const records = excelRows.map(r => ({
        fg_material_code:      String(r["FG Material Code"] || ""),
        fg_item_description:   r["FG Item Description"] || "",
        sfg1_material_code:    r["SFG1 Material Code"] ? String(r["SFG1 Material Code"]) : "",
        sfg_item_description:  r["SFG Item Description"] || "",
        diameter:              toNum(r["Diamater"]),
        form:                  r["Form"] || "",
        batch_size_fm1:        toNum(r["Batch Size FM1"]),
        batch_size_fm2:        toNum(r["Batch Size FM2"]),
        batch_size_fm3:        toNum(r["Batch Size FM3"]),
        batch_size_pmx:        toNum(r["Batch Size PMX"]),
        finished_goods_weight: toNum(r["Finished Goods Weight"]),
        thread:                r["Thread"] || "",
        sacks_material_code:   r["Sacks Material Code"] ? String(r["Sacks Material Code"]) : "",
        sacks_item_description:r["Sacks Item Description"] || "",
        tags_material_code:    r["Tags Material Code"] ? String(r["Tags Material Code"]) : "",
        tags_item_description: r["Tags Item Description"] || "",
        label_1:               r["Label 1"] || "",
        label_2:               r["Label 2"] || "",
        undetermined_value:    toNum(r["Undetermined Value"]),
        line_1_run_rate:       toNum(r["Line 1 Run Rate"]),
        line_2_run_rate:       toNum(r["Line 2 Run Rate"]),
        line_3_run_rate:       toNum(r["Line 3 Run Rate"]),
        line_4_run_rate:       toNum(r["Line 4 Run Rate"]),
        line_5_run_rate:       toNum(r["Line 5 Run Rate"]),
        line_6_run_rate:       toNum(r["Line 6 Run Rate"]),
        line_7_run_rate:       toNum(r["Line 7 Run Rate"]),
        upload_session_id:     sessionId,
      }));

      await KnowledgeBase.bulkCreate(records);
      await KnowledgeBaseUpload.create({ filename: file.name, file_url: "", upload_session_id: sessionId, record_count: records.length, is_active: true });

      /* Fix 1: store an independent deep-cloned snapshot of the uploaded data.
         This is keyed by sessionId and used for revert/delete-active operations.
         We add _originalIndex here so stable row-position tracking works. */
      const uploadSnap = records.map((r, idx) => ({ ...r, _originalIndex: idx }));
      setUploadSnapshots(prev => ({ ...prev, [sessionId]: deepClone(uploadSnap) }));

      setSavedViewData(null);
      queryClient.invalidateQueries({ queryKey: ["kb"] });
      queryClient.invalidateQueries({ queryKey: ["kb_uploads"] });
      toast.success(`${records.length} products loaded in Master Data.`);
    } catch (err) {
      toast.error("Failed to upload Master Data: " + err.message);
    }
    setIsUploading(false);
    e.target.value = "";
  };

  const handleReapply = async () => {
    if (!activeUpload || !orders?.length) return;
    setIsReapplying(true);
    setShowReapplyConfirm(false);
    try {
      await onReapply?.(activeKB);
      toast.success("Master Data re-applied to all existing orders.");
    } catch (err) {
      toast.error("Re-apply failed: " + err.message);
    }
    setIsReapplying(false);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    const { upload, isActive } = deleteTarget;
    setIsDeleting(true);
    try {
      const sessionRecords = kbRecords.filter(r => r.upload_session_id === upload.upload_session_id);
      await Promise.all(sessionRecords.map(r => KnowledgeBase.delete(r.id)));
      await KnowledgeBaseUpload.delete(upload.id);
      queryClient.invalidateQueries(["kb"]);
      queryClient.invalidateQueries(["kb_uploads"]);
      setDeleteTarget(null); setConfirmText("");
      toast.success(isActive ? `Active file deleted: ${upload.filename}` : `File deleted: ${upload.filename}`);
    } catch (err) {
      toast.error("Delete failed: " + err.message);
    }
    setIsDeleting(false);
  };

  /* ── Column definitions ─────────────────────────────────────────────── */

  const colHeaders = [
    { key:"fg_material_code",    label:"FG Material Code",   w:150 },
    { key:"fg_item_description", label:"FG Item Description",w:280 },
    { key:"sfg1_material_code",  label:"SFG1 Material Code", w:150 },
    { key:"sfg_item_description",label:"SFG Item Description",w:220 },
    { key:"form",                label:"Form",               w:70  },
    { key:"batch_size_fm1",      label:"Batch FM1",          w:90  },
    { key:"batch_size_fm2",      label:"Batch FM2",          w:90  },
    { key:"batch_size_fm3",      label:"Batch FM3",          w:90  },
    { key:"batch_size_pmx",      label:"Batch PMX",          w:90  },
    { key:"finished_goods_weight",label:"FG Weight",         w:90  },
    { key:"thread",              label:"Thread",             w:80  },
    { key:"sacks_material_code", label:"Sacks Code",         w:130 },
    { key:"sacks_item_description",label:"Sacks Desc",       w:200 },
    { key:"tags_material_code",  label:"Tags Code",          w:130 },
    { key:"tags_item_description",label:"Tags Desc",         w:200 },
    { key:"label_1",             label:"Label 1",            w:100 },
    { key:"label_2",             label:"Label 2",            w:100 },
    { key:"line_1_run_rate",     label:"L1 Rate",            w:90  },
    { key:"line_2_run_rate",     label:"L2 Rate",            w:90  },
    { key:"line_3_run_rate",     label:"L3 Rate",            w:90  },
    { key:"line_4_run_rate",     label:"L4 Rate",            w:90  },
    { key:"line_5_run_rate",     label:"L5 Rate",            w:90  },
    { key:"line_6_run_rate",     label:"L6 Rate",            w:90  },
    { key:"line_7_run_rate",     label:"L7 Rate",            w:90  },
  ];

  const displayData = isEditMode ? editData : filteredKB;
  const hasChanges = changes.length > 0;

  /* ── Render ─────────────────────────────────────────────────────────── */

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <Database className="h-8 w-8 text-[#fd5108]" />
            <div>
              <CardTitle className="text-[16px]">Master Data</CardTitle>
              <p className="text-[12px] text-gray-500 mt-0.5">Upload and manage master data for auto-populating order details</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {activeUpload && !isEditMode && (
              <Button variant="outline" size="sm" onClick={() => setShowReapplyConfirm(true)} disabled={isReapplying} className="kb-reapply-btn text-[10px]" data-tour="kb-reapply">
                {isReapplying ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                Re-apply to Existing Orders
              </Button>
            )}
            {!isEditMode && (
              <Button
                size="sm"
                className="kb-upload-btn bg-[#fd5108] hover:bg-[#fe7c39] text-white text-[10px]"
                data-tour="kb-upload"
                onClick={() => fileRef.current?.click()}
                disabled={isUploading}
              >
                {isUploading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Upload className="h-3 w-3 mr-1" />}
                Upload Master Data
              </Button>
            )}
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleUpload} />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* ── Active KB Table ─────────────────────────────────────────── */}
        {activeKB.length > 0 ? (
          <div>
            {/* Search + Edit controls */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8, gap:12 }}>
              <div style={{ display:"flex", alignItems:"center", gap:12, flex:1 }}>
                {!isEditMode ? (
                  <div className="relative" style={{ maxWidth:300, flex:1 }}>
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                    <Input
                      placeholder="Search by code or description..."
                      value={searchTerm}
                      onChange={e => setSearchTerm(e.target.value)}
                      className="pl-8 h-8 text-xs"
                    />
                  </div>
                ) : (
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    {selectedRows.size > 0 && (
                      <button
                        className="kb-delete-selected-btn"
                        onClick={handleDeleteSelected}
                      >
                        Delete {selectedRows.size} selected
                      </button>
                    )}
                  </div>
                )}
                <span style={{ fontSize:10, color:"#6b7280", whiteSpace:"nowrap" }}>
                  {isEditMode
                    ? `${editData.length} row${editData.length !== 1 ? "s" : ""}`
                    : `Showing ${displayRows.length} of ${savedViewData ? savedViewData.length : activeKB.length} products`}
                </span>
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                {!isEditMode ? (
                  activeUpload && (
                    <span className="kb-edit-link kb-edit-mode-btn" onClick={handleToggleEditMode} data-testid="button-kb-edit-table" data-tour="kb-edit-mode">
                      Edit Table
                    </span>
                  )
                ) : (
                  <div style={{ display:"flex", gap:8 }}>
                    <Button variant="outline" size="sm" className="text-[10px]" onClick={handleDiscard} disabled={isSaving} data-testid="button-kb-discard">
                      Discard
                    </Button>
                    <Button size="sm" className="bg-[#fd5108] hover:bg-[#fe7c39] text-white text-[10px]" onClick={handleSaveChanges} disabled={isSaving} data-testid="button-kb-save">
                      {isSaving ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Saving…</> : "Save Changes"}
                    </Button>
                  </div>
                )}
              </div>
            </div>

            {/* Table */}
            <div className="kb-table overflow-auto rounded-lg border border-gray-100" data-tour="kb-table" style={{ maxHeight:"calc(100vh - 420px)", minHeight:300 }}>
              <table
                className="text-xs"
                style={{ tableLayout:"fixed", width:"max-content", minWidth:"100%", borderCollapse:"collapse" }}
              >
                <thead className="bg-gray-50" style={{ position:"sticky", top:0, zIndex:10 }}>
                  <tr>
                    {/* Fix 2: # row number column */}
                    <th style={{ width:36, minWidth:36 }} className="px-1 py-2 border-b border-gray-200 text-center font-bold text-gray-500 sticky left-0 bg-gray-50 z-10 text-xs">#</th>
                    {isEditMode && (
                      <th style={{ width:28, minWidth:28 }} className="px-1 py-2 border-b border-gray-200 text-center">
                        <input
                          type="checkbox"
                          checked={editData.length > 0 && selectedRows.size === editData.length}
                          onChange={toggleAllRows}
                          style={{ cursor:"pointer" }}
                        />
                      </th>
                    )}
                    {colHeaders.map(col => (
                      <th key={col.key} style={{ width:col.w, minWidth:col.w }}
                        className="px-2 py-2 text-left font-bold text-gray-600 whitespace-nowrap border-b border-gray-200">
                        {col.label}
                        {isEditMode && REQUIRED_KEYS_KB.has(col.key) && (
                          <span style={{ color:"#fd5108", marginLeft:2 }}>*</span>
                        )}
                      </th>
                    ))}
                    {isEditMode && (
                      <th style={{ width:36, minWidth:36 }} className="px-1 py-2 border-b border-gray-200" />
                    )}
                  </tr>
                </thead>
                <tbody>
                  {isEditMode ? (
                    <>
                      <KBRowInsertLine onInsert={() => handleInsertRow(-1)} />
                      {editData.map((row, i) => {
                        const isRowDup = isDuplicateMaterialCode(row);
                        const dupCount = isRowDup ? (duplicateCountMap[normalizeVal(row.fg_material_code)] ?? 0) : 0;
                        return (
                        <React.Fragment key={row.id}>
                          <tr
                            style={{ background: isRowDup ? "#fef2f2" : (row._isNew ? "#fffbf7" : (i % 2 === 0 ? "#fff" : "#fafafa")) }}
                            onContextMenu={e => handleRowContextMenu(e, row, i)}
                          >
                            {/* Fix 2: row number cell */}
                            <td style={{ width:36, textAlign:"center", padding:"2px 4px", borderBottom:"1px solid #f3f4f6", color:"#9ca3af", fontSize:10, fontWeight:500 }}>
                              {i + 1}
                            </td>
                            <td style={{ width:28, textAlign:"center", padding:"2px 4px", borderBottom:"1px solid #f3f4f6" }}>
                              <input
                                type="checkbox"
                                checked={selectedRows.has(row.id)}
                                onChange={() => toggleRowSelection(row.id)}
                                style={{ cursor:"pointer" }}
                              />
                            </td>
                            {colHeaders.map(col => {
                              const hasErr     = getCellError(row.id, col.key);
                              const isNum      = NUMERIC_COLS_KB.has(col.key);
                              const isReq      = REQUIRED_KEYS_KB.has(col.key);
                              const edited     = !isRowDup && isCellEdited(row, col.key);
                              const origVal    = edited ? getOriginalValue(row, col.key) : undefined;
                              const cellTitle  = isRowDup
                                ? `Duplicated — FG Material Code appears ${dupCount} times`
                                : edited ? `Original: ${origVal === '' ? '(empty)' : origVal}` : undefined;
                              const cellBg     = hasErr ? "#fef2f2" : edited ? "#fef9e7" : "transparent";
                              const cellClass  = edited && !hasErr ? "kb-cell-edited" : undefined;
                              const inputBorder = hasErr ? "#fca5a5" : edited ? "#f59e0b" : undefined;
                              const inputClass  = edited && !hasErr ? " kb-cell-input-edited" : "";
                              return (
                                <td
                                  key={col.key}
                                  style={{ width:col.w, maxWidth:col.w, padding:"2px 4px", borderBottom:"1px solid #f3f4f6", background: cellBg }}
                                  title={cellTitle}
                                  className={cellClass}
                                >
                                  <input
                                    type={isNum ? "number" : "text"}
                                    value={row[col.key] ?? ""}
                                    onChange={e => handleCellChange(row.id, col.key, e.target.value)}
                                    className={`kb-cell-input${inputClass}`}
                                    style={{ borderColor: inputBorder }}
                                    placeholder={isReq ? "Required" : "-"}
                                    min={isNum ? 0 : undefined}
                                  />
                                </td>
                              );
                            })}
                            <td style={{ width:36, textAlign:"center", padding:"2px 4px", borderBottom:"1px solid #f3f4f6" }}>
                              <button className="kb-delete-btn" onClick={() => handleDeleteRow(row.id)} title="Delete row">🗑</button>
                            </td>
                          </tr>
                          <KBRowInsertLine onInsert={() => handleInsertRow(i)} />
                        </React.Fragment>
                        );
                      })}
                    </>
                  ) : (
                    /* Fix 1+2: use displayRows (preserves save/revert order) + stable # row number */
                    displayRows.map((row, i) => {
                      const isRowDup = isDuplicateMaterialCode(row);
                      const dupCount = isRowDup ? (duplicateCountMap[normalizeVal(row.fg_material_code)] ?? 0) : 0;
                      return (
                      <tr key={row.id ?? row._originalIndex ?? i}
                        className={isRowDup ? "kb-row-duplicate" : (i % 2 === 0 ? "bg-white" : "bg-gray-50/50")}>
                        <td style={{ width:36, textAlign:"center", color:"#9ca3af", fontSize:10, fontWeight:500 }}
                          className="px-1 py-1.5 border-b border-gray-50">
                          {/* Fix 2: show original file position if available */}
                          {row._originalIndex != null ? row._originalIndex + 1 : i + 1}
                        </td>
                        {colHeaders.map(col => {
                          const val = row[col.key];
                          const isRate = col.key.includes("run_rate");
                          const isBatch = col.key.includes("batch_size") || col.key === "finished_goods_weight";
                          const display = val == null || val === ""
                            ? "-"
                            : (isRate || isBatch) ? (isNaN(parseFloat(val)) ? String(val) : parseFloat(val).toFixed(isRate ? 2 : 0))
                            : String(val);
                          const edited    = !isRowDup && isCellEdited(row, col.key);
                          const origVal   = edited ? getOriginalValue(row, col.key) : undefined;
                          const cellTitle = isRowDup
                            ? `Duplicated — FG Material Code appears ${dupCount} times`
                            : edited ? `Original: ${origVal === '' ? '(empty)' : origVal}` : undefined;
                          return (
                            <td key={col.key} style={{ width:col.w, maxWidth:col.w }}
                              className={`px-2 py-1.5 text-gray-700 border-b border-gray-50 truncate whitespace-nowrap overflow-hidden${edited ? ' kb-cell-edited' : ''}`}
                              title={cellTitle}>
                              {display}
                            </td>
                          );
                        })}
                      </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-10 text-gray-400 border border-dashed border-gray-200 rounded-lg">
            <Database className="h-8 w-8 mb-2 opacity-40" />
            <p className="text-sm">No Master Data uploaded yet</p>
            <p className="text-xs mt-1">Upload an Excel file to enable auto-population of order fields</p>
          </div>
        )}

        {/* ── Unified History ───────────────────────────────────────────── */}
        <div className="kb-history" data-tour="kb-history" style={{ marginTop:16 }}>
          <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:10 }}>
            <History style={{ width:13, height:13, color:"#9ca3af" }} />
            <h4 style={{ fontSize:12, fontWeight:600, color:"#1a1a1a" }}>History</h4>
          </div>
          {unifiedHistory.length === 0 ? (
            <p style={{ fontSize:10, color:"#9ca3af", fontStyle:"italic", textAlign:"center", padding:"12px 0" }}>
              No history yet. Upload a file to get started.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom:8 }}>
                <div style={{ position:"relative", width:200 }}>
                  <Search style={{ position:"absolute", left:7, top:"50%", transform:"translateY(-50%)", width:11, height:11, color:"#9ca3af", pointerEvents:"none" }} />
                  <input type="text" value={historySearch} onChange={e => setHistorySearch(e.target.value)}
                    placeholder="Search history..." data-testid="input-kb-history-search"
                    style={{ width:"100%", paddingLeft:24, paddingRight:6, paddingTop:4, paddingBottom:4, fontSize:10, border:"1px solid #d1d5db", borderRadius:4, outline:"none", color:"#374151" }}
                    onFocus={e => e.target.style.borderColor="#fd5108"}
                    onBlur={e => e.target.style.borderColor="#d1d5db"}
                  />
                </div>
                <div style={{ position:"relative", width:160 }}>
                  <Calendar style={{ position:"absolute", left:7, top:"50%", transform:"translateY(-50%)", width:11, height:11, color:"#9ca3af", pointerEvents:"none" }} />
                  <input type="date" value={historyDateFilter} onChange={e => setHistoryDateFilter(e.target.value)}
                    data-testid="input-kb-history-date"
                    style={{ width:"100%", paddingLeft:24, paddingRight:6, paddingTop:4, paddingBottom:4, fontSize:10, border:"1px solid #d1d5db", borderRadius:4, outline:"none", color: historyDateFilter ? "#374151" : "#9ca3af" }}
                    onFocus={e => e.target.style.borderColor="#fd5108"}
                    onBlur={e => e.target.style.borderColor="#d1d5db"}
                  />
                </div>
                <span style={{ fontSize:10, color:"#6B7280", whiteSpace:"nowrap" }}>
                  Showing {filteredUnifiedHistory.length} of {unifiedHistory.length} entr{unifiedHistory.length !== 1 ? "ies" : "y"}
                </span>
              </div>
              <div style={{ maxHeight:240, overflowY:"auto", border:"1px solid #e5e7eb", borderRadius:4 }}>
                <table style={{ width:"100%", borderCollapse:"collapse", tableLayout:"fixed" }}>
                  <colgroup>
                    <col style={{ width:28 }} />
                    <col style={{ width:"19%" }} />
                    <col style={{ width:96 }} />
                    <col />
                    <col style={{ width:72 }} />
                    <col style={{ width:80 }} />
                  </colgroup>
                  <thead style={{ position:"sticky", top:0, background:"#fff", zIndex:1, borderBottom:"1px solid #e5e7eb" }}>
                    <tr>
                      {["#","DATE","TYPE","NOTES","STATUS","ACTIONS"].map(h => (
                        <th key={h} style={{ fontSize:9, fontWeight:600, color:"#6b7280", letterSpacing:"0.5px", padding:"6px 10px", textAlign: h === "#" || h === "STATUS" || h === "ACTIONS" ? "center" : "left" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUnifiedHistory.length === 0 ? (
                      <tr><td colSpan={6} style={{ fontSize:10, color:"#9ca3af", fontStyle:"italic", textAlign:"center", padding:"12px 0" }}>No entries match your search.</td></tr>
                    ) : filteredUnifiedHistory.map((entry, i) => {
                      const isActive = unifiedHistory[0]?.id === entry.id;
                      const badgeStyle = entry.type === "file_upload"
                        ? { background:"#eff6ff", color:"#1d4ed8" }
                        : entry.type === "manual_edit"
                          ? { background:"#f5f3ff", color:"#6d28d9" }
                          : { background:"#fff7ed", color:"#92400e" };
                      return (
                        <tr key={entry.id}
                          style={{ borderBottom:"1px solid #f3f4f6", background: isActive ? "#fafffe" : "#fff" }}
                          onMouseEnter={e => e.currentTarget.style.background= isActive ? "#f0fdf4" : "#fafafa"}
                          onMouseLeave={e => e.currentTarget.style.background= isActive ? "#fafffe" : "#fff"}
                          data-testid={`row-kb-history-${i}`}
                        >
                          <td style={{ fontSize:10, color:"#6b7280", padding:"6px 10px", textAlign:"center" }}>{i + 1}</td>
                          <td style={{ fontSize:10, color:"#6b7280", padding:"6px 10px", whiteSpace:"nowrap" }}>
                            {formatDateTimeFull(entry.timestamp)}
                          </td>
                          <td style={{ padding:"6px 10px" }}>
                            <span style={{ fontSize:9, fontWeight:600, padding:"2px 6px", borderRadius:3, ...badgeStyle }}>
                              {getTypeLabel(entry.type)}
                            </span>
                          </td>
                          <HistoryNotesCell summary={entry.summary} details={entry.details} />
                          <td style={{ padding:"6px 10px", textAlign:"center" }}>
                            {isActive && (
                              <span style={{ fontSize:10, fontWeight:600, color:"#16a34a", background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:4, padding:"2px 8px", whiteSpace:"nowrap" }}>
                                Active
                              </span>
                            )}
                          </td>
                          <td style={{ padding:"6px 4px", textAlign:"center" }}>
                            <div style={{ display:"inline-flex", alignItems:"center", gap:6 }}>
                              {/* Download — always available */}
                              {(() => {
                                const snapAvail = entry.type === "file_upload"
                                  ? !!(uploadSnapshots[entry._upload?.upload_session_id]?.length)
                                  : !!(entry.snapshot?.length);
                                return (
                                  <button
                                    onClick={() => snapAvail && handleDownloadSnapshot(entry)}
                                    title={snapAvail ? "Download this version" : "Download not available — no snapshot found"}
                                    disabled={!snapAvail}
                                    style={{ color: snapAvail ? "#9ca3af" : "#d1d5db", background:"none", border:"none", cursor: snapAvail ? "pointer" : "default", padding:0, lineHeight:1, opacity: snapAvail ? 1 : 0.45 }}
                                    onMouseEnter={e => { if (snapAvail) e.currentTarget.style.color="#fd5108"; }}
                                    onMouseLeave={e => { e.currentTarget.style.color = snapAvail ? "#9ca3af" : "#d1d5db"; }}
                                    data-testid={`button-download-history-${i}`}
                                  ><Download style={{ width:12, height:12 }} /></button>
                                );
                              })()}
                              {/* Revert — visible for all, disabled on active */}
                              <button
                                onClick={() => { if (!isActive) setRevertTarget(entry); }}
                                disabled={isActive}
                                title={isActive ? "This is the current active version — already in use." : "Revert to this version"}
                                style={{ color: isActive ? "#d1d5db" : "#9ca3af", background:"none", border:"none", cursor: isActive ? "not-allowed" : "pointer", padding:0, lineHeight:1, fontSize:13, opacity: isActive ? 0.5 : 1 }}
                                onMouseEnter={e => { if (!isActive) e.currentTarget.style.color="#fd5108"; }}
                                onMouseLeave={e => { if (!isActive) e.currentTarget.style.color="#9ca3af"; }}
                                data-testid={`button-revert-history-${i}`}
                              >↩</button>
                              {/* Delete — always visible */}
                              <button
                                onClick={() => handleDeleteHistoryEntry(entry)}
                                title="Delete this entry"
                                style={{ color:"#9ca3af", background:"none", border:"none", cursor:"pointer", padding:0, lineHeight:1 }}
                                onMouseEnter={e => e.currentTarget.style.color="#e53935"}
                                onMouseLeave={e => e.currentTarget.style.color="#9ca3af"}
                                data-testid={`button-delete-history-${i}`}
                              ><Trash2 style={{ width:12, height:12 }} /></button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </CardContent>

      {/* ── Context menu ───────────────────────────────────────────────── */}
      {kbContextMenu && createPortal(
        <div
          className="kb-context-menu"
          style={{ left: kbContextMenu.position.x, top: kbContextMenu.position.y }}
          onClick={e => e.stopPropagation()}
        >
          <div className="kb-context-item" onClick={() => { handleInsertRow(kbContextMenu.rowIndex - 1); setKbContextMenu(null); }}>
            Insert row above
          </div>
          <div className="kb-context-item" onClick={() => { handleInsertRow(kbContextMenu.rowIndex); setKbContextMenu(null); }}>
            Insert row below
          </div>
          <div className="kb-context-divider" />
          <div className="kb-context-item kb-context-danger" onClick={() => handleDeleteRow(kbContextMenu.row.id)}>
            Delete row
          </div>
        </div>,
        document.body
      )}

      {/* ── Discard confirmation ────────────────────────────────────────── */}
      {discardConfirmOpen && (
        <div className="kb-dialog-overlay" onClick={() => setDiscardConfirmOpen(false)}>
          <div className="kb-dialog-box" style={{ maxWidth:400 }} onClick={e => e.stopPropagation()}>
            <div className="kb-dialog-header">
              <span>Discard Changes</span>
              <button className="kb-dialog-close" onClick={() => setDiscardConfirmOpen(false)}>✕</button>
            </div>
            <div className="kb-dialog-body">
              <p style={{ fontSize:13, color:"#374151", lineHeight:1.6 }}>
                You have unsaved changes. Are you sure you want to discard all changes? This cannot be undone.
              </p>
            </div>
            <div className="kb-dialog-footer">
              <button onClick={() => setDiscardConfirmOpen(false)} style={{ background:"#fff", color:"#374151", border:"1px solid #d1d5db", borderRadius:6, padding:"8px 20px", fontSize:13, cursor:"pointer" }}>Keep Editing</button>
              <button onClick={handleConfirmDiscard} style={{ background:"#e53935", color:"#fff", border:"none", borderRadius:6, padding:"8px 20px", fontSize:13, fontWeight:600, cursor:"pointer" }}>Discard</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Revert confirmation ─────────────────────────────────────────── */}
      {revertTarget && (
        <RevertDialog entry={revertTarget} onConfirm={handleRevertConfirm} onCancel={() => setRevertTarget(null)} isSaving={isSaving} />
      )}

      {/* ── Re-apply confirmation ───────────────────────────────────────── */}
      <AlertDialog open={showReapplyConfirm} onOpenChange={setShowReapplyConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-apply Master Data</AlertDialogTitle>
            <AlertDialogDescription>
              This will update Form, Batch Size, and Run Rate for all existing orders based on the current Master Data. User-edited values will be overwritten. Proceed?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleReapply} className="bg-[#fd5108] hover:bg-[#fe7c39] text-white">Re-apply</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete upload confirmation ──────────────────────────────────── */}
      <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open && !isDeleting) { setDeleteTarget(null); setConfirmText(""); } }}>
        <DialogContent className="max-w-sm">
          <DialogTitle className="sr-only">Delete Upload</DialogTitle>
          {deleteTarget && (() => {
            const { upload, isActive } = deleteTarget;
            const isExact = confirmText === "Confirm";
            const isPartial = !isExact && confirmText.length > 0 && "Confirm".startsWith(confirmText);
            const isWrong = !isExact && !isPartial && confirmText.length > 0;
            const canDelete = isExact && !isDeleting;
            return (
              <div>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
                  <Trash2 style={{ width:15, height:15, color:"#e53935", flexShrink:0 }} />
                  <span style={{ fontSize:14, fontWeight:600, color:"#1a1a1a" }}>Delete Upload</span>
                </div>
                <p style={{ fontSize:12, color:"#6b7280", marginBottom:14 }}>Are you sure you want to delete this file?</p>
                <div style={{ marginBottom:14 }}>
                  {[["File",upload.filename],["Uploaded",formatUploadDate(upload.created_date)],["Records",`${upload.record_count ?? "?"} records`]].map(([l,v]) => (
                    <div key={l} style={{ display:"flex", gap:8, marginBottom:3 }}>
                      <span style={{ fontSize:11, color:"#6b7280", minWidth:78 }}>{l}:</span>
                      <span style={{ fontSize:11, fontWeight:500, color:"#1a1a1a" }}>{v}</span>
                    </div>
                  ))}
                  {isActive && <div style={{ display:"flex", gap:8 }}><span style={{ fontSize:11, color:"#6b7280", minWidth:78 }}>Status:</span><span style={{ fontSize:11, fontWeight:600, color:"#43a047" }}>Active ✓</span></div>}
                </div>
                <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:6, padding:"8px 12px", marginBottom:14 }}>
                  <div style={{ display:"flex", alignItems:"flex-start", gap:8 }}>
                    <AlertTriangle style={{ width:13, height:13, color:"#e53935", marginTop:1, flexShrink:0 }} />
                    <p style={{ fontSize:11, color:"#991b1b", lineHeight:1.5 }}>
                      {isActive ? <><strong>This is the currently ACTIVE file.</strong> Deleting it will remove all associated data. The next most recent upload will become active, or the page will revert to empty state if no other uploads exist. This action cannot be undone.</> : "This action cannot be undone. The file and its data will be permanently removed."}
                    </p>
                  </div>
                </div>
                <div style={{ marginBottom:18 }}>
                  <label style={{ display:"block", fontSize:12, fontWeight:500, color:"#1a1a1a", marginBottom:6 }}>Type <em>"Confirm"</em> to proceed:</label>
                  <input
                    autoFocus type="text" value={confirmText} onChange={e => setConfirmText(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && canDelete) handleConfirmDelete(); }}
                    placeholder="Type Confirm here..." disabled={isDeleting}
                    data-testid="input-delete-confirm"
                    style={{ width:"100%", padding:"6px 10px", fontSize:12, border:`1px solid ${isExact ? "#43a047" : isWrong ? "#fecaca" : "#d1d5db"}`, borderRadius:6, outline:"none", color:"#374151", fontStyle: confirmText ? "normal" : "italic" }}
                  />
                  {isWrong && <p style={{ fontSize:10, color:"#e53935", marginTop:4 }}>Please type 'Confirm' exactly.</p>}
                </div>
                <div style={{ display:"flex", justifyContent:"flex-end", gap:8 }}>
                  <button onClick={() => { setDeleteTarget(null); setConfirmText(""); }} disabled={isDeleting}
                    style={{ fontSize:12, color:"#374151", padding:"6px 16px", border:"1px solid #d1d5db", borderRadius:6, background:"none", cursor:"pointer" }}
                    onMouseEnter={e => e.currentTarget.style.borderColor="#9ca3af"}
                    onMouseLeave={e => e.currentTarget.style.borderColor="#d1d5db"}
                  >Cancel</button>
                  <button onClick={handleConfirmDelete} disabled={!canDelete}
                    style={{ fontSize:12, fontWeight:600, padding:"6px 16px", border:"none", borderRadius:6, color: canDelete ? "#fff" : "#d1d5db", background: isDeleting ? "#f87171" : canDelete ? "#e53935" : "#f3f4f6", cursor: canDelete ? "pointer" : "not-allowed" }}
                    onMouseEnter={e => { if (canDelete) e.currentTarget.style.background="#c62828"; }}
                    onMouseLeave={e => { if (canDelete && !isDeleting) e.currentTarget.style.background="#e53935"; }}
                  >{isDeleting ? "Deleting…" : "Delete"}</button>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* ── Delete History Entry Dialog ─────────────────────────────────── */}
      {deleteHistoryTarget && createPortal(
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.35)", zIndex:9999, display:"flex", alignItems:"center", justifyContent:"center" }}
          onClick={() => { setDeleteHistoryTarget(null); setDeleteHistoryConfirmText(""); }}
        >
          <div style={{ background:"#fff", borderRadius:10, padding:28, width:380, maxWidth:"92vw", boxShadow:"0 8px 32px rgba(0,0,0,0.18)" }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
              <div style={{ background:"#fef2f2", borderRadius:"50%", width:34, height:34, display:"flex", alignItems:"center", justifyContent:"center" }}>
                <Trash2 style={{ width:16, height:16, color:"#e53935" }} />
              </div>
              <span style={{ fontSize:14, fontWeight:600, color:"#1a1a1a" }}>Delete History Entry</span>
            </div>
            {(() => {
              const isActiveDel = unifiedHistory[0]?.id === deleteHistoryTarget.id;
              const isLastEntry = unifiedHistory.length <= 1;
              return (
                <>
                  <p style={{ fontSize:12, color:"#6b7280", marginBottom:10 }}>
                    {isActiveDel && isLastEntry
                      ? "You are about to delete the only history entry."
                      : isActiveDel
                        ? "You are about to delete the currently active version."
                        : "This will permanently remove this history entry."}
                  </p>
                  <div style={{ background:"#f9fafb", border:"1px solid #e5e7eb", borderRadius:6, padding:"8px 12px", marginBottom:10, fontSize:11, color:"#374151" }}>
                    {deleteHistoryTarget.summary}
                  </div>
                  {/* Fix 3: red warning for last entry, orange for active-but-not-last */}
                  {isActiveDel && isLastEntry && (
                    <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:6, padding:"10px 12px", marginBottom:10 }}>
                      <p style={{ fontSize:12, color:"#dc2626", lineHeight:1.6, fontWeight:500, margin:0 }}>
                        ⚠ This is the only history entry. Deleting it will completely clear the Master Data. You will need to upload a new file or add data manually.
                      </p>
                    </div>
                  )}
                  {isActiveDel && !isLastEntry && (
                    <div style={{ background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:6, padding:"10px 12px", marginBottom:10 }}>
                      <p style={{ fontSize:12, color:"#ea580c", lineHeight:1.6, fontWeight:500, margin:0 }}>
                        ⚠ This is the currently active version. Deleting it will revert the Master Data to the next version in the history.
                      </p>
                    </div>
                  )}
                  <p style={{ fontSize:11, color:"#dc2626", marginBottom:14 }}>This action cannot be undone.</p>
                </>
              );
            })()}
            <div style={{ marginBottom:18 }}>
              <label style={{ display:"block", fontSize:12, fontWeight:500, color:"#1a1a1a", marginBottom:6 }}>Type <em>"Confirm"</em> to proceed:</label>
              <input
                autoFocus type="text" value={deleteHistoryConfirmText}
                onChange={e => setDeleteHistoryConfirmText(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && deleteHistoryConfirmText === "Confirm") handleConfirmDeleteHistoryEntry(); }}
                placeholder="Type Confirm here..."
                data-testid="input-delete-history-confirm"
                style={{ width:"100%", padding:"6px 10px", fontSize:12, border:`1px solid ${deleteHistoryConfirmText === "Confirm" ? "#43a047" : "#d1d5db"}`, borderRadius:6, outline:"none", color:"#374151" }}
              />
            </div>
            <div style={{ display:"flex", justifyContent:"flex-end", gap:8 }}>
              <button onClick={() => { setDeleteHistoryTarget(null); setDeleteHistoryConfirmText(""); }} disabled={isSaving}
                style={{ fontSize:12, color:"#374151", padding:"6px 16px", border:"1px solid #d1d5db", borderRadius:6, background:"none", cursor: isSaving ? "not-allowed" : "pointer", opacity: isSaving ? 0.5 : 1 }}
              >Cancel</button>
              <button
                onClick={handleConfirmDeleteHistoryEntry}
                disabled={deleteHistoryConfirmText !== "Confirm" || isSaving}
                className={isSaving ? "action-btn-loading" : ""}
                style={{
                  fontSize:12, fontWeight:600, padding:"6px 16px", border:"none", borderRadius:6, color:"#fff",
                  background: isSaving ? "#f87171" : deleteHistoryConfirmText === "Confirm" ? "#e53935" : "#f3f4f6",
                  cursor: (deleteHistoryConfirmText === "Confirm" && !isSaving) ? "pointer" : "not-allowed",
                  display:"inline-flex", alignItems:"center", gap:6
                }}
              >
                {isSaving && <Spinner size={12} color="#fff" />}
                {isSaving ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </Card>
  );
}
