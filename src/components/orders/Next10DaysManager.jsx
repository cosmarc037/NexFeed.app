import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { ProductTooltipPanel, getTooltipPosition } from "@/utils/productTooltip";
import { getProductStatus, STATUS_ORDER } from "@/utils/statusUtils";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import {
  Upload,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Sparkles,
  Search,
  BarChart2,
  FileSpreadsheet,
  Download,
  Trash2,
  Calendar,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { format, parseISO } from "date-fns";
import { toast } from "@/components/ui/notifications";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { generateN10DSummary, generateProductInsights, buildInsightTemplates } from "@/services/azureAI";
import { setInsights, setTemplateInsights, hasInsights, getInsight } from "@/utils/insightCache";
import { AIText } from "@/lib/renderAIText";

const { Next10DaysRecord, Next10DaysUpload } = base44.entities;

function formatUploadDate(dateStr) {
  if (!dateStr) return "-";
  try {
    return format(new Date(dateStr), "MM/dd/yyyy hh:mm aa");
  } catch {
    return dateStr;
  }
}

function formatShortDate(dateStr) {
  if (!dateStr) return "—";
  try {
    return format(parseISO(dateStr), "MMM d");
  } catch {
    return dateStr;
  }
}

function clampToViewport(x, y, tooltipWidth, tooltipHeight) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pad = 8;
  if (x + tooltipWidth + pad > vw) x = x - tooltipWidth - 24;
  if (y + tooltipHeight + pad > vh) y = y - tooltipHeight - 24;
  if (x < pad) x = pad;
  if (y < pad) y = pad;
  return { x, y };
}

function formatDateWithYear(dateStr) {
  if (!dateStr) return "—";
  try {
    return format(parseISO(typeof dateStr === 'string' ? dateStr : dateStr.toISOString()), "MMMM d, yyyy");
  } catch {
    return dateStr;
  }
}

const MONTH_NAMES = {
  january: 0, february: 1, march: 2, april: 3,
  may: 4, june: 5, july: 6, august: 7,
  september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3,
  jun: 5, jul: 6, aug: 7,
  sep: 8, oct: 9, nov: 10, dec: 11,
};

// ─── Date header parsing ──────────────────────────────────────────────────────
// Handles: JS Date objects, Excel serial numbers, and every common string format.
function tryParseExcelDateHeader(rawValue) {
  // Already a JS Date object (cellDates: true)
  if (rawValue instanceof Date && !isNaN(rawValue.getTime())) {
    return rawValue;
  }

  // Excel date serial number (days since Dec 30, 1899)
  if (typeof rawValue === "number" && rawValue > 30000 && rawValue < 60000) {
    try {
      // Try XLSX.SSF if available
      if (XLSX.SSF?.parse_date_code) {
        const parsed = XLSX.SSF.parse_date_code(rawValue);
        if (parsed && parsed.y && parsed.m && parsed.d) {
          return new Date(parsed.y, parsed.m - 1, parsed.d);
        }
      }
    } catch (_) {}
    // Fallback: Unix epoch conversion (Excel epoch offset: 25569 days from 1970)
    const ms = Math.round((rawValue - 25569) * 86400000);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d;
  }

  const str = String(rawValue || "").trim();
  if (!str || str.length < 3) return null;

  // "Mar-18", "Mar 18", "April 15", "April 15, 2026", "Apr 15, 2026"
  const m1 = str.match(/^([A-Za-z]+)[\s\-]+(\d{1,2})(?:[\s,]+(\d{2,4}))?/);
  if (m1) {
    const key = m1[1].toLowerCase();
    const mo = MONTH_NAMES[key] ?? MONTH_NAMES[key.slice(0, 3)];
    if (mo !== undefined) {
      let year = m1[3] ? parseInt(m1[3]) : inferYear(mo, parseInt(m1[2]));
      if (year < 100) year += 2000;
      return new Date(year, mo, parseInt(m1[2]));
    }
  }
  // "18-Mar", "18 Mar", "18-April", "15-Apr-26", "15-Apr-2026", "15 April 2026"
  const m2 = str.match(/^(\d{1,2})[\s\-\/]([A-Za-z]+)(?:[\s\-\/](\d{2,4}))?/);
  if (m2) {
    const key = m2[2].toLowerCase();
    const mo = MONTH_NAMES[key] ?? MONTH_NAMES[key.slice(0, 3)];
    if (mo !== undefined) {
      let year = m2[3] ? parseInt(m2[3]) : inferYear(mo, parseInt(m2[1]));
      if (year < 100) year += 2000;
      return new Date(year, mo, parseInt(m2[1]));
    }
  }
  // "3/18" or "3/18/2026"
  const m3 = str.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m3) {
    const mo = parseInt(m3[1]) - 1;
    const day = parseInt(m3[2]);
    const year = m3[3]
      ? m3[3].length === 2
        ? 2000 + parseInt(m3[3])
        : parseInt(m3[3])
      : inferYear(mo, day);
    return new Date(year, mo, day);
  }
  // "2026-03-18" ISO
  const m4 = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m4)
    return new Date(parseInt(m4[1]), parseInt(m4[2]) - 1, parseInt(m4[3]));

  // Last resort: native parser (only if it yields a sensible year range)
  const native = new Date(str);
  if (
    !isNaN(native.getTime()) &&
    native.getFullYear() >= 2020 &&
    native.getFullYear() <= 2035
  ) {
    return native;
  }

  return null;
}

function inferYear(month, day) {
  const now = new Date();
  const thisYear = now.getFullYear();
  const candidate = new Date(thisYear, month, day);
  if ((candidate - now) / 86400000 < -30) return thisYear + 1;
  return thisYear;
}

function toISODateFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtHeaderLabel(d) {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[d.getMonth()]}-${String(d.getDate()).padStart(2, "0")}`;
}

function subtractOneDay(dateStr) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

function calculateStatus(dueForLoading, inventory, dailyValues) {
  // DFL >= Inv: demand already exceeds supply → Critical, needs production NOW
  if (dueForLoading >= inventory) {
    return { needsProduction: true, targetDate: null, note: null };
  }
  if (!dailyValues || dailyValues.length === 0) {
    return { needsProduction: true, targetDate: null, note: null };
  }
  let cumulative = dueForLoading;
  let previousDate = null;
  for (const day of dailyValues) {
    const v = day.value || 0;
    if (v === 0) {
      previousDate = day.date;
      continue;
    }
    const next = cumulative + v;
    if (next >= inventory) {
      if (previousDate)
        return { needsProduction: true, targetDate: previousDate, note: null };
      return {
        needsProduction: true,
        targetDate: subtractOneDay(dailyValues[0].date),
        note: null,
      };
    }
    cumulative = next;
    previousDate = day.date;
  }
  const lastDate = dailyValues[dailyValues.length - 1]?.date || null;
  return {
    needsProduction: true,
    targetDate: lastDate,
    note: `Inventory target unlikely to be met within 10 days. Start production as early as possible.`,
  };
}

// ── N10D status / date computation helpers (module-level, no React) ──────────

function parseDailyValuesArr(dailyValues) {
  if (!dailyValues) return [];
  try {
    return typeof dailyValues === "string" ? JSON.parse(dailyValues) : dailyValues || [];
  } catch { return []; }
}


function computeCompletionAndAvail(dfl, inv, dailyValues) {
  const dvArr = parseDailyValuesArr(dailyValues);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString().slice(0, 10);
  if (dfl >= inv) return { completionDate: null, availDate: todayISO };
  let cum = dfl;
  for (let i = 0; i < dvArr.length; i++) {
    cum += parseFloat(dvArr[i].value) || 0;
    if (cum >= inv) {
      const completionDate = i > 0 ? dvArr[i - 1].date : null;
      return { completionDate, availDate: dvArr[i].date };
    }
  }
  // Never breached within 10 days
  const lastDate = dvArr.length > 0 ? dvArr[dvArr.length - 1].date : null;
  return { completionDate: lastDate, availDate: null };
}

function computeBalToProduce(inv, dfl, dailyValues) {
  const dvArr = parseDailyValuesArr(dailyValues);
  const sumOf10Days = dvArr.reduce((s, d) => s + (parseFloat(d.value) || 0), 0);
  return inv - (dfl + sumOf10Days);
}

// ──────────────────────────────────────────────────────────────────────────────

function normalizeColKey(h) {
  return String(h || "")
    .trim()
    .toLowerCase();
}

function findColFuzzy(headers, candidates) {
  // Exact match first
  for (const c of candidates) {
    const idx = headers.findIndex(
      (h) => normalizeColKey(h) === c.toLowerCase(),
    );
    if (idx >= 0) return idx;
  }
  // Partial contains match
  for (const c of candidates) {
    const idx = headers.findIndex((h) =>
      normalizeColKey(h).includes(c.toLowerCase()),
    );
    if (idx >= 0) return idx;
  }
  return -1;
}

// ─── Core parser ─────────────────────────────────────────────────────────────
// Uses two XLSX reads:
//   • formattedRows  (raw: false) → headers as display strings ("Mar-18"), all values as strings
//   • rawRows        (raw: true)  → data values as actual numbers for accurate parseFloat
function parseN10DFile(worksheet) {
  // Read 1: formatted strings — ensures date-formatted headers appear as "Mar-18", "3/18", etc.
  const formattedRows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  });
  // Read 2: raw values — numeric cells stay as numbers (accurate for data rows)
  const rawRows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    raw: true,
    cellDates: true,
    defval: "",
    blankrows: false,
  });

  if (!formattedRows || formattedRows.length < 2)
    throw new Error("File appears to be empty or unreadable.");

  // ── Find the header row ────────────────────────────────────────────────────
  let headerRowIdx = formattedRows.findIndex((row) =>
    row.some((cell) => {
      const s = normalizeColKey(cell);
      return (
        s === "material code" ||
        s.includes("item description") ||
        s === "inventory"
      );
    }),
  );
  if (headerRowIdx < 0) headerRowIdx = 0;

  // Formatted header strings (for fixed-column detection)
  const fmtHeaders = (formattedRows[headerRowIdx] || []).map((h) =>
    String(h || "").trim(),
  );
  // Raw header cells (for date serial / Date object detection)
  const rawHeaderCells = rawRows[headerRowIdx] || [];

  console.log("[N10D] ALL HEADERS (formatted):", fmtHeaders);
  console.log("[N10D] HEADER COUNT:", fmtHeaders.length);

  // ── Identify fixed columns ────────────────────────────────────────────────
  const fixedCols = {};
  const usedIndices = new Set();
  const tryFixed = (key, candidates) => {
    const idx = findColFuzzy(fmtHeaders, candidates);
    if (idx >= 0) {
      fixedCols[key] = idx;
      usedIndices.add(idx);
    }
  };

  tryFixed("material_code", [
    "material code",
    "mat code",
    "material_code",
    "matcode",
  ]);
  tryFixed("category", ["category", "cat"]);
  tryFixed("item_description", [
    "item description",
    "item_description",
    "description",
    "item desc",
  ]);
  tryFixed("due_for_loading", [
    "due for loading",
    "due_for_loading",
    "due for ldg",
    "due for loading (mt)",
    "dfl",
  ]);
  tryFixed("inventory", ["inventory", "target inventory", "inv"]);
  tryFixed("bal_to_produce", [
    "bal. to produce",
    "bal to produce",
    "bal_to_produce",
    "balance to produce",
    "bal. to prod",
    "bal.to produce",
  ]);

  console.log("[N10D] FIXED COLUMNS:", fixedCols);

  // ── Identify date columns ─────────────────────────────────────────────────
  // Try raw header cell first (handles numeric serials & Date objects), then formatted string
  const dateColumns = [];
  fmtHeaders.forEach((fmtCell, i) => {
    if (usedIndices.has(i)) return; // skip fixed columns
    const rawCell = rawHeaderCells[i];
    // Try raw value first, then the formatted string
    const jsDate =
      tryParseExcelDateHeader(rawCell) || tryParseExcelDateHeader(fmtCell);
    if (jsDate) {
      const isoDate = toISODateFromDate(jsDate);
      const label =
        fmtCell && !fmtCell.match(/^\d{5}$/) ? fmtCell : fmtHeaderLabel(jsDate);
      dateColumns.push({ index: i, label, isoDate });
    } else if (fmtCell) {
      console.log(
        "[N10D] UNRECOGNIZED HEADER:",
        JSON.stringify(fmtCell),
        "(raw:",
        JSON.stringify(rawCell),
        ") at index",
        i,
      );
    }
  });
  dateColumns.sort((a, b) => a.isoDate.localeCompare(b.isoDate));

  console.log("[N10D] DATE COLUMN COUNT:", dateColumns.length);
  console.log(
    "[N10D] DATE COLUMNS:",
    dateColumns.map((d) => `${d.label}→${d.isoDate}`),
  );

  if (
    fixedCols.material_code === undefined &&
    fixedCols.item_description === undefined
  ) {
    throw new Error(
      "Could not find Material Code or Item Description columns. Check your file format.",
    );
  }

  // ── Parse data rows ───────────────────────────────────────────────────────
  const records = [];
  for (let i = headerRowIdx + 1; i < rawRows.length; i++) {
    const rawRow = rawRows[i];
    const fmtRow = formattedRows[i] || [];

    const matCode = String(
      rawRow[fixedCols.material_code] ?? fmtRow[fixedCols.material_code] ?? "",
    ).trim();
    const desc = String(
      rawRow[fixedCols.item_description] ??
        fmtRow[fixedCols.item_description] ??
        "",
    ).trim();
    if (!matCode && !desc) continue;

    // Use raw number for numeric fields; fall back to formatted string → parseFloat
    const toNum = (raw, fmt) => {
      if (typeof raw === "number" && isFinite(raw)) return raw;
      if (raw instanceof Date) return NaN; // date object where a number is expected
      const s = String(fmt ?? raw ?? "")
        .replace(/,/g, "")
        .trim();
      return parseFloat(s);
    };

    const dueForLoading =
      toNum(
        rawRow[fixedCols.due_for_loading],
        fmtRow[fixedCols.due_for_loading],
      ) || 0;
    const inventory =
      toNum(rawRow[fixedCols.inventory], fmtRow[fixedCols.inventory]) || 0;
    const balRaw = toNum(
      rawRow[fixedCols.bal_to_produce],
      fmtRow[fixedCols.bal_to_produce],
    );
    const balToProduce = isFinite(balRaw) ? balRaw : null;
    const category = String(
      fmtRow[fixedCols.category] ?? rawRow[fixedCols.category] ?? "",
    ).trim();

    const dailyValues = dateColumns.map((dc) => ({
      date: dc.isoDate,
      value: toNum(rawRow[dc.index], fmtRow[dc.index]) || 0,
    }));

    console.log("[N10D] ROW:", matCode, desc);
    console.log("  Due:", dueForLoading, "| Inventory:", inventory);
    console.log(
      "  Daily:",
      dailyValues.map((d) => `${d.date.slice(5)}:${d.value}`).join(" "),
    );

    const { needsProduction, targetDate, note } = calculateStatus(
      dueForLoading,
      inventory,
      dailyValues,
    );

    records.push({
      material_code: matCode,
      category,
      item_description: desc,
      due_for_loading: dueForLoading,
      inventory,
      bal_to_produce: balToProduce,
      daily_values: dailyValues,
      target_date: targetDate,
      needs_production: needsProduction,
      note: note || null,
    });
  }

  if (records.length === 0)
    throw new Error("No data rows found after the header row.");
  console.log(
    `[N10D] Parsed ${records.length} records, ${dateColumns.length} date columns.`,
  );
  return { records, dateColumns };
}

// ── N10D day cell cumulative tooltip (portal-rendered) ───────────────────────
function N10DDayCellTooltip({ data, position }) {
  const barColor = data.usagePct >= 100 ? '#f87171' : data.usagePct >= 80 ? '#fb923c' : data.usagePct >= 50 ? '#fde047' : '#4ade80';
  const cumColor = data.isBreached ? '#fca5a5' : '#ffffff';
  const remColor = data.remaining < 0 ? '#fca5a5' : '#86efac';
  const lbl = { fontSize: 11, fontWeight: 400, color: 'rgba(255,255,255,0.55)' };
  const val = { fontSize: 11, fontWeight: 600, color: '#ffffff' };
  return createPortal(
    <div style={{
      position: 'fixed', left: position.x, top: position.y,
      background: '#1a1a1a', color: '#ffffff', borderRadius: 8,
      padding: '10px 14px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      minWidth: 210, zIndex: 9999, pointerEvents: 'none',
      animation: 'n10dTipFade 0.15s ease',
    }}>
      <style>{`@keyframes n10dTipFade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 7, paddingBottom: 6, borderBottom: '1px solid rgba(255,255,255,0.12)' }}>
        {data.date}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', rowGap: 4 }}>
        <span style={lbl}>Day value:</span>
        <span style={val}>{Number(data.dayValue).toFixed(1)} MT</span>
        <span style={lbl}>Cumulative:</span>
        <span style={{ ...val, color: cumColor }}>{Number(data.cumulative).toFixed(1)} MT</span>
        <span style={lbl}>Inventory:</span>
        <span style={val}>{Number(data.inventory).toFixed(1)} MT</span>
        <span style={lbl}>Remaining:</span>
        <span style={{ ...val, color: remColor }}>{Number(data.remaining).toFixed(1)} MT</span>
      </div>
      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.12)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.min(100, data.usagePct)}%`, background: barColor, borderRadius: 3, transition: 'width 0.2s ease' }} />
        </div>
        <span style={{ fontSize: 10, fontWeight: 600, color: barColor, flexShrink: 0 }}>{data.usagePct}%</span>
      </div>
    </div>,
    document.body
  );
}
// ─────────────────────────────────────────────────────────────────────────────

export default function Next10DaysManager({ onApplied, sapOrders = [] }) {
  const queryClient = useQueryClient();
  const fileRef = useRef(null);
  const groupHeaderRef = useRef(null);
  const [subHeaderTop, setSubHeaderTop] = useState(28);

  useEffect(() => {
    if (groupHeaderRef.current) {
      const h = groupHeaderRef.current.getBoundingClientRect().height;
      setSubHeaderTop((prev) => (prev === h ? prev : h));
    }
  });
  const [isUploading, setIsUploading] = useState(false);
  const [isReapplying, setIsReapplying] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState("asc");
  const [successInfo, setSuccessInfo] = useState(null);
  const [hoveredIdx, setHoveredIdx] = useState(null);
  const [aiSummary, setAiSummary] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(false);
  const [hoveredProductIdx, setHoveredProductIdx] = useState(null);
  const [highlightedCode, setHighlightedCode] = useState(null);
  const tableScrollRef = useRef(null);
  const [deleteTarget, setDeleteTarget] = useState(null); // { upload, isActive }
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [uploadSearch, setUploadSearch] = useState("");
  const [uploadDateFilter, setUploadDateFilter] = useState("");
  const [tooltipData, setTooltipData] = useState(null);
  const [dayTooltipData, setDayTooltipData] = useState(null);
  const [hoverType, setHoverType] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const tooltipTimerRef = useRef(null);
  const lastHoveredCellRef = useRef(null);

  const { data: uploads = [] } = useQuery({
    queryKey: ["n10d_uploads"],
    queryFn: () => Next10DaysUpload.list("-created_date", 10),
    staleTime: 0,
  });

  const activeUpload = uploads[0] || null;

  const { data: allRecords = [] } = useQuery({
    queryKey: ["n10d_records"],
    queryFn: () => Next10DaysRecord.list("-created_date", 2000),
    staleTime: 0,
  });

  const activeRecords = activeUpload
    ? allRecords.filter(
        (r) => r.upload_session_id === activeUpload.upload_session_id,
      )
    : [];

  // ── Two-phase insight generation ───────────────────────────────────────────
  // Phase 1: template lines appear instantly (no API call)
  // Phase 2 (AI): triggered manually via sparkle button in the order table Summary column
  const runInsightGeneration = (records, orders) => {
    const templateMap = buildInsightTemplates(records, orders);
    setTemplateInsights(templateMap);
  };

  // Auto-generate when active N10D records become available and cache is empty
  useEffect(() => {
    if (activeRecords.length > 0 && !hasInsights()) {
      runInsightGeneration(activeRecords, sapOrders);
    }
  }, [activeRecords.length]);

  // Auto-generate for any new orders that don't have cached insights yet
  useEffect(() => {
    if (activeRecords.length > 0 && sapOrders.length > 0) {
      const uncached = sapOrders.filter(o => {
        const code = String(o.material_code_fg || o.material_code || '');
        return code && !getInsight(code);
      });
      if (uncached.length > 0) {
        runInsightGeneration(activeRecords, sapOrders);
      }
    }
  }, [sapOrders.length]);

  const handleFile = async (file) => {
    setIsUploading(true);
    setSuccessInfo(null);
    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: "array" });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];

      const { records, dateColumns } = parseN10DFile(worksheet);

      const sessionId = `n10d-${Date.now()}`;

      await Next10DaysRecord.bulkCreate(
        records.map((r) => ({
          ...r,
          upload_session_id: sessionId,
          daily_values: JSON.stringify(r.daily_values),
        })),
      );

      await Next10DaysUpload.create({
        upload_session_id: sessionId,
        file_name: file.name,
        record_count: records.length,
      });

      queryClient.invalidateQueries({ queryKey: ["n10d_records"] });
      queryClient.invalidateQueries({ queryKey: ["n10d_uploads"] });

      const matched = records.filter(
        (r) => r.needs_production && r.target_date,
      ).length;
      const sufficient = records.filter((r) => !r.needs_production).length;

      setSuccessInfo({
        total: records.length,
        matched,
        sufficient,
        dateColumns,
      });

      if (onApplied) onApplied(records);

      toast.success(`Next 10 Days loaded — ${records.length} products`);

      // Auto-generate AI insights
      try {
        localStorage.setItem("nexfeed_n10d_insights_open", "true");
      } catch {}
      triggerAiGenerate(records);
      // Generate and cache per-product insights for order table + auto-sequence
      runInsightGeneration(records, sapOrders);
    } catch (err) {
      console.error("[N10D Upload]", err);
      toast.error(`Upload failed: ${err.message}`);
    } finally {
      setIsUploading(false);
    }
  };

  const handleSort = (col) => {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  };

  const handleReapply = async () => {
    if (!activeRecords.length) return;
    setIsReapplying(true);
    try {
      if (onApplied) await onApplied(activeRecords);
      // Regenerate per-product template insights after re-apply
      runInsightGeneration(activeRecords, sapOrders);
      toast.success("Next 10 Days re-applied to existing orders.");
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
      // Delete all N10D records belonging to this session
      const sessionRecords = allRecords.filter(
        (r) => r.upload_session_id === upload.upload_session_id,
      );
      await Promise.all(
        sessionRecords.map((r) => Next10DaysRecord.delete(r.id)),
      );
      // Delete the upload metadata
      await Next10DaysUpload.delete(upload.id);
      queryClient.invalidateQueries(["n10d_records"]);
      queryClient.invalidateQueries(["n10d_uploads"]);
      setDeleteTarget(null);
      setConfirmText("");
      // Reset AI insights if the active file was deleted
      if (isActive) {
        setAiSummary(null);
        setAiError(false);
        toast.success(
          `Active file deleted: ${upload.file_name || "Uploaded file"}`,
        );
      } else {
        toast.success(`File deleted: ${upload.file_name || "Uploaded file"}`);
      }
    } catch (err) {
      toast.error("Delete failed: " + err.message);
    }
    setIsDeleting(false);
  };

  const triggerAiGenerate = (records) => {
    setAiSummary(null);
    setAiError(false);
    setAiLoading(true);
    generateN10DSummary(records || activeRecords, sapOrders)
      .then((s) => {
        setAiSummary(s);
        setAiLoading(false);
        if (!s) setAiError(true);
      })
      .catch(() => {
        setAiLoading(false);
        setAiError(true);
      });
  };

  // Auto-generate when data is loaded but no summary exists yet
  useEffect(() => {
    if (activeRecords.length > 0 && !aiSummary && !aiLoading && !aiError) {
      triggerAiGenerate(activeRecords);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRecords.length]);

  // Scroll to and highlight a row by material code when a product link is clicked
  const handleProductClick = (code) => {
    setHighlightedCode(code);
    // Scroll the row into view inside the table container
    requestAnimationFrame(() => {
      const container = tableScrollRef.current;
      const row = container
        ? container.querySelector(`[data-material-code="${CSS.escape(code)}"]`)
        : document.querySelector(`[data-row-material="${CSS.escape(code)}"]`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
    // Remove highlight after 2 seconds
    setTimeout(() => setHighlightedCode(null), 2000);
  };

  const sortedRecords = [...activeRecords].sort((a, b) => {
    if (!sortCol) {
      // Default: Critical → Urgent → Monitor → Sufficient, then by DFL/Inv ratio descending
      const sa = getProductStatus(a.due_for_loading || 0, a.inventory || 0, a.daily_values);
      const sb = getProductStatus(b.due_for_loading || 0, b.inventory || 0, b.daily_values);
      const diff = (STATUS_ORDER[sa] ?? 4) - (STATUS_ORDER[sb] ?? 4);
      if (diff !== 0) return diff;
      const ratioA = a.inventory > 0 ? (a.due_for_loading || 0) / a.inventory : Infinity;
      const ratioB = b.inventory > 0 ? (b.due_for_loading || 0) / b.inventory : Infinity;
      return ratioB - ratioA;
    }
    let va = a[sortCol], vb = b[sortCol];
    if (sortCol === "target_date" || sortCol === "completion_date" || sortCol === "avail_date") {
      va = va || "zzzz";
      vb = vb || "zzzz";
    }
    if (typeof va === "number") return sortDir === "asc" ? va - vb : vb - va;
    return sortDir === "asc"
      ? String(va || "").localeCompare(String(vb || ""))
      : String(vb || "").localeCompare(String(va || ""));
  });

  const displayRecords = searchTerm.trim()
    ? sortedRecords.filter((r) => {
        const q = searchTerm.toLowerCase();
        return (
          (r.material_code || "").toLowerCase().includes(q) ||
          (r.category || "").toLowerCase().includes(q) ||
          (r.item_description || "").toLowerCase().includes(q)
        );
      })
    : sortedRecords;

  const dateColumnsForTable = (() => {
    if (!activeRecords.length) return [];
    const sample = activeRecords[0];
    const dv =
      typeof sample.daily_values === "string"
        ? JSON.parse(sample.daily_values)
        : sample.daily_values || [];
    return dv.map((d) => d.date);
  })();

  const getDailyValues = (rec) => {
    if (!rec.daily_values) return {};
    const dv =
      typeof rec.daily_values === "string"
        ? JSON.parse(rec.daily_values)
        : rec.daily_values;
    const map = {};
    (dv || []).forEach((d) => {
      map[d.date] = d.value;
    });
    return map;
  };

  // Fixed column widths for sticky positioning
  const COL_W = { mat: 112, cat: 80, desc: 180, dfl: 86 };
  const LEFT = {
    mat: 0,
    cat: COL_W.mat,
    desc: COL_W.mat + COL_W.cat,
    dfl: COL_W.mat + COL_W.cat + COL_W.desc,
  };
  const FREEZE_EDGE = LEFT.dfl + COL_W.dfl; // right edge of frozen area

  const subThBase = {
    position: "sticky",
    top: subHeaderTop,
    background: "#fff",
    zIndex: 10,
    fontWeight: 500,
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    whiteSpace: "nowrap",
    borderBottom: "1px solid #e5e7eb",
    boxShadow: "0 2px 4px rgba(0,0,0,0.04)",
    padding: "8px 8px",
    cursor: "pointer",
  };

  const frozenSubTh = (leftPx, isLast = false) => ({
    ...subThBase,
    position: "sticky",
    left: leftPx,
    zIndex: 20,
    boxShadow: isLast
      ? "1px 0 3px rgba(0,0,0,0.03), 0 2px 4px rgba(0,0,0,0.04)"
      : "0 2px 4px rgba(0,0,0,0.04)",
    borderRight: isLast ? "1px solid #e5e7eb" : undefined,
  });

  const SortIndicator = ({ col }) =>
    sortCol === col ? (sortDir === "asc" ? " ↑" : " ↓") : "";

  const groupThBase = {
    position: "sticky",
    top: 0,
    background: "#fff",
    color: "#374151",
    fontWeight: 600,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    textAlign: "center",
    padding: "5px 8px",
    borderBottom: "2px solid #e5e7eb",
    whiteSpace: "nowrap",
    zIndex: 10,
  };

  const daysSince = activeUpload?.created_date
    ? Math.floor((Date.now() - new Date(activeUpload.created_date)) / 86400000)
    : null;
  const isOutdated = daysSince !== null && daysSince >= 1;

  const handleDownloadN10D = (records, label = "Active") => {
    if (!records?.length) { toast.info("No data available to download."); return; }
    try {
      /* Build ordered date keys from the first record (preserves column order as in the table) */
      const firstDv = parseDailyValuesArr(records[0].daily_values);
      const dateKeys = firstDv.map(d => d.date);
      /* For any records with extra dates not in the first record, append them */
      const seenDates = new Set(dateKeys);
      records.forEach(r => {
        parseDailyValuesArr(r.daily_values).forEach(d => {
          if (!seenDates.has(d.date)) { seenDates.add(d.date); dateKeys.push(d.date); }
        });
      });

      const rows = records.map(r => {
        const dvArr = parseDailyValuesArr(r.daily_values);
        const dvMap = {};
        dvArr.forEach(d => { dvMap[d.date] = d.value; });

        const dfl = r.due_for_loading || 0;
        const inv = r.inventory || 0;

        /* Computed columns — same logic as the table render */
        const status = getProductStatus(dfl, inv, r.daily_values);
        const { completionDate, availDate } = computeCompletionAndAvail(dfl, inv, r.daily_values);
        const balComputed = computeBalToProduce(inv, dfl, r.daily_values);
        const balVal = isFinite(balComputed) ? Number(balComputed.toFixed(1)) : "";

        /* Product Details */
        const row = {
          "Material Code": r.material_code ?? "",
          "Category": r.category ?? "",
          "Item Description": r.item_description ?? "",
          "Due for Loading": dfl,
        };

        /* Next 10 Days — date columns in order */
        dateKeys.forEach(dk => {
          const v = dvMap[dk];
          row[dk] = v !== undefined && v !== null ? Number(parseFloat(v).toFixed(1)) : "";
        });

        /* Tracking */
        row["Inventory"] = inv;
        row["Bal to Produce"] = balVal;
        row["Completion"] = completionDate ?? "";
        row["Avail"] = availDate ?? "";
        row["Status"] = status;

        return row;
      });

      /* Auto column widths */
      const colWidths = {};
      rows.forEach(row => {
        Object.keys(row).forEach(k => {
          const len = Math.max(String(row[k] ?? "").length, k.length, 8);
          if (!colWidths[k] || colWidths[k] < len) colWidths[k] = len;
        });
      });
      const ws = XLSX.utils.json_to_sheet(rows);
      ws["!cols"] = Object.values(colWidths).map(w => ({ wch: Math.min(w + 2, 40) }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "N10D");
      const dateStr = format(new Date(), "yyyy-MM-dd");
      XLSX.writeFile(wb, `N10D_${label}_${dateStr}.xlsx`);
      toast.success("N10D data exported.");
    } catch (err) { toast.error("Download failed: " + err.message); }
  };

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <BarChart2 className="h-8 w-8 text-[#fd5108]" />
            <div>
              <CardTitle className="text-[16px]">Next 10 Days</CardTitle>
              <p className="text-[12px] text-gray-500 mt-0.5">
                Upload daily stock level data for production prioritization
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {activeUpload && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleReapply}
                disabled={isReapplying || !activeRecords.length}
                className="n10d-reapply-btn text-[10px]"
                data-testid="button-reapply-n10d"
                data-tour="n10d-reapply"
              >
                {isReapplying ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3 mr-1" />
                )}
                Re-apply to Existing Orders
              </Button>
            )}
            <Button
              size="sm"
              className="n10d-upload-btn bg-[#fd5108] hover:bg-[#fe7c39] text-white text-[10px]"
              onClick={() => fileRef.current?.click()}
              disabled={isUploading}
              data-testid="button-upload-n10d"
              data-tour="n10d-upload"
            >
              {isUploading ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Upload className="h-3 w-3 mr-1" />
              )}
              Upload Next 10 Days
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.[0]) handleFile(e.target.files[0]);
                e.target.value = "";
              }}
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* ── SEARCH BAR ── */}
        {activeRecords.length > 0 && (
          <div className="flex items-center gap-3" data-tour="n10d-search">
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
              <Input
                placeholder="Search by code, description, or category..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-8 h-8 text-xs focus-visible:ring-[#fd5108] focus-visible:border-[#fd5108]"
                data-testid="input-search-n10d"
              />
            </div>
            <span className="text-[10px] text-gray-500 whitespace-nowrap">
              Showing {displayRecords.length} of {sortedRecords.length} products
            </span>
          </div>
        )}

        {/* ── STOCK LEVEL TABLE ── */}
        {sortedRecords.length > 0 && (
          <div
            ref={tableScrollRef}
            className="overflow-auto rounded-lg border border-gray-100"
            data-tour="n10d-table"
            style={{ maxHeight: "520px" }}
          >
            <table
              className="text-xs"
              style={{
                minWidth: "100%",
                borderCollapse: "collapse",
                tableLayout: "auto",
              }}
            >
              <thead>
                {/* ── Group header row ── */}
                <tr ref={groupHeaderRef}>
                  {/* PRODUCT DETAILS — frozen group header */}
                  <th
                    colSpan={4}
                    data-tour="n10d-header-product"
                    style={{
                      ...groupThBase,
                      position: "sticky",
                      left: 0,
                      top: 0,
                      zIndex: 30,
                      minWidth: FREEZE_EDGE,
                      borderRight: "1px solid #e5e7eb",
                    }}
                  >
                    Product Details
                  </th>
                  {/* NEXT 10 DAYS */}
                  <th
                    colSpan={Math.max(dateColumnsForTable.length, 1)}
                    data-tour="n10d-header-days"
                    style={{ ...groupThBase }}
                  >
                    Next 10 Days
                  </th>
                  {/* TRACKING — spans Inventory, Bal.to.Prod, Completion, Avail, Status */}
                  <th
                    colSpan={5}
                    data-tour="n10d-header-tracking"
                    style={{ ...groupThBase, borderLeft: "1px solid #e5e7eb" }}
                  >
                    Tracking
                  </th>
                </tr>

                {/* ── Individual column sub-header row ── */}
                <tr>
                  {/* Material Code — frozen */}
                  <th
                    onClick={() => handleSort("material_code")}
                    style={{
                      ...frozenSubTh(LEFT.mat),
                      left: LEFT.mat,
                      minWidth: COL_W.mat,
                      textAlign: "left",
                    }}
                  >
                    Material Code
                    <SortIndicator col="material_code" />
                  </th>
                  {/* Category — frozen */}
                  <th
                    onClick={() => handleSort("category")}
                    style={{
                      ...frozenSubTh(LEFT.cat),
                      left: LEFT.cat,
                      minWidth: COL_W.cat,
                      textAlign: "left",
                    }}
                  >
                    Category
                    <SortIndicator col="category" />
                  </th>
                  {/* Item Description — frozen */}
                  <th
                    onClick={() => handleSort("item_description")}
                    style={{
                      ...frozenSubTh(LEFT.desc),
                      left: LEFT.desc,
                      minWidth: COL_W.desc,
                      textAlign: "left",
                    }}
                  >
                    Item Description
                    <SortIndicator col="item_description" />
                  </th>
                  {/* Due for Loading — frozen, freeze edge */}
                  <th
                    onClick={() => handleSort("due_for_loading")}
                    style={{
                      ...frozenSubTh(LEFT.dfl, true),
                      left: LEFT.dfl,
                      minWidth: COL_W.dfl,
                      textAlign: "center",
                    }}
                  >
                    Due for Ldg
                    <SortIndicator col="due_for_loading" />
                  </th>
                  {/* Date columns */}
                  {dateColumnsForTable.map((d) => (
                    <th
                      key={d}
                      style={{
                        ...subThBase,
                        textAlign: "center",
                        minWidth: 52,
                      }}
                    >
                      {formatShortDate(d)}
                    </th>
                  ))}
                  {/* Inventory — subtle grey bg */}
                  <th
                    onClick={() => handleSort("inventory")}
                    style={{
                      ...subThBase,
                      textAlign: "center",
                      background: "#f9fafb",
                      minWidth: 72,
                      borderLeft: "1px solid #e5e7eb",
                    }}
                  >
                    Inventory
                    <SortIndicator col="inventory" />
                  </th>
                  {/* Bal. to Produce */}
                  <th
                    onClick={() => handleSort("bal_to_produce")}
                    style={{ ...subThBase, textAlign: "center", minWidth: 72 }}
                  >
                    Bal. to Prod
                    <SortIndicator col="bal_to_produce" />
                  </th>
                  {/* Completion Date */}
                  <th
                    onClick={() => handleSort("completion_date")}
                    title="Last date before inventory threshold is breached"
                    style={{ ...subThBase, textAlign: "center", minWidth: 90, cursor: "pointer" }}
                  >
                    Completion
                    <SortIndicator col="completion_date" />
                  </th>
                  {/* Avail Date */}
                  <th
                    onClick={() => handleSort("avail_date")}
                    title="Date when cumulative demand exceeds inventory"
                    style={{ ...subThBase, textAlign: "center", minWidth: 80, cursor: "pointer" }}
                  >
                    Avail
                    <SortIndicator col="avail_date" />
                  </th>
                  {/* Status */}
                  <th
                    style={{
                      ...subThBase,
                      textAlign: "center",
                      minWidth: 96,
                      cursor: "default",
                    }}
                  >
                    Status
                  </th>
                </tr>
              </thead>

              <tbody>
                {displayRecords.map((rec, idx) => {
                  const dvMap = getDailyValues(rec);
                  const dfl = rec.due_for_loading || 0;
                  const inv = rec.inventory || 0;

                  // Derived columns — all computed at render time from stored data
                  const status4 = getProductStatus(dfl, inv, rec.daily_values);
                  const { completionDate, availDate } = computeCompletionAndAvail(dfl, inv, rec.daily_values);
                  const balComputed = computeBalToProduce(inv, dfl, rec.daily_values);
                  const balVal = isFinite(balComputed) ? balComputed.toFixed(1) : "";

                  // Compute red-zone start index
                  const dueRed = dfl >= inv;
                  let redFromIdx = dueRed ? 0 : Infinity;
                  if (!dueRed) {
                    let cum = dfl;
                    for (let di = 0; di < dateColumnsForTable.length; di++) {
                      cum += dvMap[dateColumnsForTable[di]] || 0;
                      if (cum >= inv) {
                        redFromIdx = di;
                        break;
                      }
                    }
                  }

                  const redStyle = { background: "#fff5f5", color: "#ef4444" };
                  const frozenTdBase = {
                    background: "#fff",
                    position: "sticky",
                    zIndex: 2,
                  };
                  const isHovered = hoveredIdx === idx;
                  const isHighlighted = highlightedCode && rec.material_code === highlightedCode;
                  const hoverBg = "#fafafa";
                  const highlightBg = "#fef9c3";
                  const frozenBg = isHighlighted ? highlightBg : isHovered ? hoverBg : "#fff";
                  const cellPad = "4.5px 4.5px";

                  // Product tooltip data — computed once per row
                  const tData = {
                    name: rec.item_description || "—",
                    materialCode: rec.material_code || "",
                    dfl,
                    inv,
                    ratio: inv > 0 ? (dfl / inv).toFixed(2) : "∞",
                    buffer: inv > 0 ? (((inv - dfl) / inv) * 100).toFixed(1) : "-100.0",
                    status: status4,
                    completionDate: completionDate ? formatDateWithYear(completionDate) : null,
                    availDate: availDate ? formatDateWithYear(availDate) : null,
                    balToProd: balComputed,
                  };

                  return (
                    <tr
                      key={rec.id ?? idx}
                      data-material-code={rec.material_code || ""}
                      style={{
                        borderBottom: "1px solid #f9fafb",
                        background: isHighlighted ? highlightBg : undefined,
                        transition: "background 0.3s ease",
                      }}
                      onMouseEnter={() => setHoveredIdx(idx)}
                      onMouseOver={(e) => {
                        const td = e.target.closest('td');
                        if (!td || td === lastHoveredCellRef.current) return;
                        lastHoveredCellRef.current = td;
                        const tr = td.closest('tr');
                        if (!tr) return;
                        const ci = Array.from(tr.children).indexOf(td);
                        const isDayCell = ci >= 4 && ci < 4 + dateColumnsForTable.length;
                        clearTimeout(tooltipTimerRef.current);
                        if (isDayCell) {
                          const di = ci - 4;
                          const d = dateColumnsForTable[di];
                          const dayV = dvMap[d] || 0;
                          let cum = dfl;
                          for (let i = 0; i <= di; i++) cum += dvMap[dateColumnsForTable[i]] || 0;
                          const remaining = inv - cum;
                          const usagePct = inv > 0 ? Math.min(100, Math.round((cum / inv) * 100)) : 100;
                          const dayDataObj = {
                            date: format(parseISO(d), "MMMM d"),
                            dayValue: dayV,
                            cumulative: cum,
                            inventory: inv,
                            remaining,
                            usagePct,
                            isBreached: cum >= inv,
                          };
                          setTooltipData(null);
                          setTooltipPos({ x: e.clientX + 14, y: e.clientY - 160 });
                          tooltipTimerRef.current = setTimeout(() => {
                            setHoverType('day');
                            setDayTooltipData(dayDataObj);
                          }, 200);
                        } else {
                          setDayTooltipData(null);
                          const ex = e.clientX, ey = e.clientY;
                          tooltipTimerRef.current = setTimeout(() => {
                            setTooltipPos(clampToViewport(ex + 12, ey + 12, 480, 220));
                            setHoverType('product');
                            setTooltipData(tData);
                          }, 300);
                        }
                      }}
                      onMouseMove={(e) => {
                        if (hoverType === 'day') {
                          setTooltipPos({ x: e.clientX + 14, y: e.clientY - 160 });
                        } else if (hoverType === 'product') {
                          setTooltipPos(clampToViewport(e.clientX + 12, e.clientY + 12, 480, 220));
                        }
                      }}
                      onMouseLeave={() => {
                        setHoveredIdx(null);
                        lastHoveredCellRef.current = null;
                        clearTimeout(tooltipTimerRef.current);
                        setHoverType(null);
                        setTooltipData(null);
                        setDayTooltipData(null);
                      }}
                    >
                      {/* Material Code — frozen */}
                      <td
                        style={{
                          ...frozenTdBase,
                          left: LEFT.mat,
                          minWidth: COL_W.mat,
                          padding: cellPad,
                          color: "#374151",
                          background: frozenBg,
                        }}
                      >
                        {rec.material_code || "—"}
                      </td>
                      {/* Category — frozen */}
                      <td
                        style={{
                          ...frozenTdBase,
                          left: LEFT.cat,
                          minWidth: COL_W.cat,
                          padding: cellPad,
                          color: "#374151",
                          whiteSpace: "nowrap",
                          background: frozenBg,
                        }}
                      >
                        {rec.category || "—"}
                      </td>
                      {/* Item Description — frozen */}
                      <td
                        style={{
                          ...frozenTdBase,
                          left: LEFT.desc,
                          minWidth: COL_W.desc,
                          maxWidth: COL_W.desc,
                          padding: cellPad,
                          color: "#374151",
                          background: frozenBg,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={rec.item_description}
                      >
                        {rec.item_description || "—"}
                      </td>
                      {/* Due for Loading — frozen, freeze edge, bold */}
                      <td
                        style={{
                          ...frozenTdBase,
                          left: LEFT.dfl,
                          minWidth: COL_W.dfl,
                          padding: cellPad,
                          textAlign: "center",
                          fontWeight: 700,
                          boxShadow: "1px 0 3px rgba(0,0,0,0.03)",
                          borderRight: "1px solid #e5e7eb",
                          ...(dueRed
                            ? redStyle
                            : { color: "#1a1a1a", background: frozenBg }),
                        }}
                      >
                        {dfl.toFixed(1)}
                      </td>

                      {/* Date columns */}
                      {dateColumnsForTable.map((d, di) => {
                        const v = dvMap[d];
                        const isRed = di >= redFromIdx;
                        return (
                          <td
                            key={d}
                            style={{
                              padding: cellPad,
                              textAlign: "center",
                              minWidth: 48,
                              ...(isRed
                                ? redStyle
                                : {
                                    color: "#6b7280",
                                    background: isHovered ? hoverBg : undefined,
                                  }),
                            }}
                          >
                            {v ? v.toFixed(1) : ""}
                          </td>
                        );
                      })}

                      {/* Inventory — always light grey, bold, never red */}
                      <td
                        style={{
                          padding: cellPad,
                          textAlign: "center",
                          fontWeight: 700,
                          color: "#1a1a1a",
                          background: "#f9fafb",
                          minWidth: 68,
                          borderLeft: "1px solid #e5e7eb",
                        }}
                      >
                        {inv.toFixed(1)}
                      </td>

                      {/* Bal. to Produce — shows positive (surplus) and negative (deficit) */}
                      <td
                        style={{
                          padding: cellPad,
                          textAlign: "center",
                          minWidth: 68,
                          background: isHovered ? hoverBg : undefined,
                          color: balVal !== "" && parseFloat(balVal) < 0 ? "#dc2626" : "#374151",
                          fontWeight: balVal !== "" && parseFloat(balVal) < 0 ? 500 : undefined,
                        }}
                      >
                        {balVal !== "" ? balVal : ""}
                      </td>

                      {/* Completion Date — last safe date before breach */}
                      <td
                        title="Last date before inventory threshold is breached"
                        style={{
                          padding: cellPad,
                          textAlign: "center",
                          minWidth: 90,
                          background: isHovered ? hoverBg : undefined,
                        }}
                      >
                        {completionDate ? (
                          <span style={{ color: "#1a1a1a" }}>
                            {formatShortDate(completionDate)}
                          </span>
                        ) : (
                          <span style={{ color: "#9ca3af" }}>—</span>
                        )}
                      </td>

                      {/* Avail Date — date when cumulative demand exceeds inventory */}
                      <td
                        title="Date when cumulative demand exceeds inventory"
                        style={{
                          padding: cellPad,
                          textAlign: "center",
                          minWidth: 80,
                          background: isHovered ? hoverBg : undefined,
                        }}
                      >
                        {availDate ? (
                          <span style={{ color: "#1a1a1a" }}>
                            {formatShortDate(availDate)}
                          </span>
                        ) : (
                          <span style={{ color: "#9ca3af" }}>—</span>
                        )}
                      </td>

                      {/* Status — 4-level badge */}
                      <td
                        style={{
                          padding: cellPad,
                          textAlign: "center",
                          minWidth: 96,
                          whiteSpace: "nowrap",
                          background: isHovered ? hoverBg : undefined,
                        }}
                      >
                        {status4 === "Critical" && (
                          <span style={{ color: "#dc2626", fontWeight: 600 }}>Critical</span>
                        )}
                        {status4 === "Urgent" && (
                          <span style={{ color: "#ea580c", fontWeight: 600 }}>Urgent</span>
                        )}
                        {status4 === "Monitor" && (
                          <span style={{ color: "#ca8a04", fontWeight: 600 }}>Monitor</span>
                        )}
                        {status4 === "Sufficient" && (
                          <span style={{ color: "#16a34a", fontWeight: 600 }}>Sufficient</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ── AI STOCK INSIGHTS ── */}
        <div style={{ margin: "12px 0" }} data-testid="section-ai-stock-insights" data-tour="n10d-safety-insights">
          {/* Title row — outside the container */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Sparkles
                style={{ width: 13, height: 13, color: "#fd5108", flexShrink: 0 }}
              />
              <span style={{ fontSize: 13, fontWeight: 700, color: "#1a1a1a" }}>
                Safety Stock Insights
              </span>
            </div>
            {activeRecords.length > 0 && (
              <button
                onClick={() => triggerAiGenerate(activeRecords)}
                disabled={aiLoading}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  background: "none",
                  border: "none",
                  cursor: aiLoading ? "default" : "pointer",
                  color: "#fd5108",
                  fontSize: 11,
                  fontWeight: 500,
                  padding: 0,
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => {
                  if (!aiLoading) e.currentTarget.style.color = "#c2410c";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "#fd5108";
                }}
                data-testid="button-refresh-ai-insights"
              >
                {aiLoading ? (
                  <Loader2 style={{ width: 11, height: 11 }} className="animate-spin" />
                ) : (
                  <RefreshCw style={{ width: 11, height: 11 }} />
                )}
                Refresh
              </button>
            )}
          </div>

          {/* Content container — white, bordered, scrollable */}
          <div className="safety-stock-insights-container">
            {!activeRecords.length && !aiLoading && !aiSummary && !aiError && (
              <p style={{ fontSize: 12, color: "#9ca3af", fontStyle: "italic", margin: 0, lineHeight: 1.6 }}>
                Upload a Next 10 Days file to generate stock insights.
              </p>
            )}
            {aiLoading && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#9ca3af", fontSize: 12, fontStyle: "italic" }}>
                <Loader2 style={{ width: 12, height: 12, flexShrink: 0 }} className="animate-spin" />
                Analyzing stock levels…
              </div>
            )}
            {aiError && !aiLoading && (
              <p style={{ fontSize: 12, color: "#9ca3af", fontStyle: "italic", margin: 0, lineHeight: 1.6 }}>
                Unable to generate insights. Click Refresh to try again.
              </p>
            )}
            {aiSummary && !aiLoading && (
              <AIText
                text={aiSummary}
                fontSize={11}
                color="#4b5563"
                lineHeight={1.7}
                gap={6}
              />
            )}
          </div>
        </div>

        {/* ── UPLOAD HISTORY ── */}
        <div style={{ marginTop: 16 }} data-tour="n10d-history">
          <h4
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "#1a1a1a",
              marginBottom: 8,
            }}
          >
            Upload History
          </h4>
          {uploads.length === 0 ? (
            <p
              style={{
                fontSize: 10,
                color: "#9ca3af",
                fontStyle: "italic",
                textAlign: "center",
                padding: "12px 0",
              }}
            >
              No uploads yet. Upload a file to get started.
            </p>
          ) : (
            (() => {
              const filteredUploads = uploads.filter((up) => {
                const nameMatch =
                  !uploadSearch ||
                  (up.file_name || "")
                    .toLowerCase()
                    .includes(uploadSearch.toLowerCase());
                const dateMatch =
                  !uploadDateFilter ||
                  (up.created_date || "").startsWith(uploadDateFilter);
                return nameMatch && dateMatch;
              });
              return (
                <>
                  {/* Search + Date filter bar */}
                  <div
                    className="flex items-center gap-2 flex-wrap"
                    style={{ marginBottom: 8 }}
                  >
                    <div style={{ position: "relative", width: 200 }}>
                      <Search
                        style={{
                          position: "absolute",
                          left: 7,
                          top: "50%",
                          transform: "translateY(-50%)",
                          width: 11,
                          height: 11,
                          color: "#9ca3af",
                          pointerEvents: "none",
                        }}
                      />
                      <input
                        type="text"
                        value={uploadSearch}
                        onChange={(e) => setUploadSearch(e.target.value)}
                        placeholder="Search by filename..."
                        data-testid="input-n10d-upload-search"
                        style={{
                          width: "100%",
                          paddingLeft: 24,
                          paddingRight: 6,
                          paddingTop: 4,
                          paddingBottom: 4,
                          fontSize: 10,
                          border: "1px solid #d1d5db",
                          borderRadius: 4,
                          outline: "none",
                          color: "#374151",
                        }}
                        onFocus={(e) =>
                          (e.target.style.borderColor = "#fd5108")
                        }
                        onBlur={(e) => (e.target.style.borderColor = "#d1d5db")}
                      />
                    </div>
                    <div style={{ position: "relative", width: 160 }}>
                      <Calendar
                        style={{
                          position: "absolute",
                          left: 7,
                          top: "50%",
                          transform: "translateY(-50%)",
                          width: 11,
                          height: 11,
                          color: "#9ca3af",
                          pointerEvents: "none",
                        }}
                      />
                      <input
                        type="date"
                        value={uploadDateFilter}
                        onChange={(e) => setUploadDateFilter(e.target.value)}
                        data-testid="input-n10d-upload-date"
                        style={{
                          width: "100%",
                          paddingLeft: 24,
                          paddingRight: 6,
                          paddingTop: 4,
                          paddingBottom: 4,
                          fontSize: 10,
                          border: "1px solid #d1d5db",
                          borderRadius: 4,
                          outline: "none",
                          color: uploadDateFilter ? "#374151" : "#9ca3af",
                        }}
                        onFocus={(e) =>
                          (e.target.style.borderColor = "#fd5108")
                        }
                        onBlur={(e) => (e.target.style.borderColor = "#d1d5db")}
                      />
                    </div>
                    <span
                      style={{
                        fontSize: 9,
                        color: "#6B7280",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Showing {filteredUploads.length} of {uploads.length}{" "}
                      upload{uploads.length !== 1 ? "s" : ""}
                    </span>
                  </div>

                  {/* Table */}
                  <div
                    style={{
                      maxHeight: 200,
                      overflowY: "auto",
                      border: "1px solid #e5e7eb",
                      borderRadius: 4,
                    }}
                  >
                    <table
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        tableLayout: "fixed",
                      }}
                    >
                      <colgroup>
                        <col style={{ width: 36 }} />
                        <col style={{ width: "35%" }} />
                        <col style={{ width: "25%" }} />
                        <col style={{ width: "10%" }} />
                        <col style={{ width: "10%" }} />
                        <col style={{ width: "10%" }} />
                      </colgroup>
                      <thead
                        style={{
                          position: "sticky",
                          top: 0,
                          background: "#fff",
                          zIndex: 1,
                        }}
                      >
                        <tr style={{ borderBottom: "1px solid #e5e7eb" }}>
                          {[
                            "#",
                            "FILE NAME",
                            "UPLOAD DATE",
                            "RECORDS",
                            "STATUS",
                            "ACTIONS",
                          ].map((col) => (
                            <th
                              key={col}
                              style={{
                                fontSize: 9,
                                fontWeight: 600,
                                color: "#6b7280",
                                letterSpacing: "0.5px",
                                padding: "6px 10px",
                                textAlign:
                                  col === "#" ||
                                  col === "RECORDS" ||
                                  col === "STATUS" ||
                                  col === "ACTIONS"
                                    ? "center"
                                    : "left",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredUploads.length === 0 ? (
                          <tr>
                            <td
                              colSpan={6}
                              style={{
                                fontSize: 10,
                                color: "#9ca3af",
                                fontStyle: "italic",
                                textAlign: "center",
                                padding: "12px 0",
                              }}
                            >
                              No uploads match your search.
                            </td>
                          </tr>
                        ) : (
                          filteredUploads.map((up, i) => {
                            const isActive = uploads[0]?.id === up.id;
                            return (
                              <tr
                                key={up.id ?? up.upload_session_id ?? i}
                                style={{
                                  borderBottom: "1px solid #f3f4f6",
                                  background: "#fff",
                                }}
                                onMouseEnter={(e) =>
                                  (e.currentTarget.style.background = "#fafafa")
                                }
                                onMouseLeave={(e) =>
                                  (e.currentTarget.style.background = "#fff")
                                }
                                data-testid={`row-n10d-upload-${i}`}
                              >
                                <td
                                  style={{
                                    fontSize: 10,
                                    color: "#6b7280",
                                    padding: "6px 10px",
                                    textAlign: "center",
                                  }}
                                >
                                  {i + 1}
                                </td>
                                <td
                                  style={{
                                    fontSize: 10,
                                    fontWeight: 500,
                                    color: "#1a1a1a",
                                    padding: "6px 10px",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                  title={up.file_name || "Uploaded file"}
                                >
                                  {up.file_name || "Uploaded file"}
                                </td>
                                <td
                                  style={{
                                    fontSize: 10,
                                    color: "#6b7280",
                                    padding: "6px 10px",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {formatUploadDate(up.created_date)}
                                </td>
                                <td
                                  style={{
                                    fontSize: 10,
                                    color: "#6b7280",
                                    padding: "6px 10px",
                                    textAlign: "center",
                                  }}
                                >
                                  {up.record_count != null
                                    ? up.record_count
                                    : "?"}
                                </td>
                                <td
                                  style={{
                                    padding: "6px 10px",
                                    textAlign: "center",
                                  }}
                                >
                                  {isActive && (
                                    <span
                                      style={{
                                        fontSize: 9,
                                        fontWeight: 600,
                                        color: "#43a047",
                                        background: "#dcfce7",
                                        padding: "2px 6px",
                                        borderRadius: 3,
                                      }}
                                    >
                                      Active
                                    </span>
                                  )}
                                </td>
                                <td
                                  style={{
                                    padding: "6px 10px",
                                    textAlign: "center",
                                  }}
                                >
                                  <div
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: 8,
                                    }}
                                  >
                                    {(() => {
                                      const uploadRecs = allRecords.filter(r => r.upload_session_id === up.upload_session_id);
                                      const canDownload = uploadRecs.length > 0;
                                      return (
                                        <button
                                          onClick={() => canDownload && handleDownloadN10D(uploadRecs, (up.file_name || "upload").replace(/\.[^/.]+$/, ""))}
                                          title={canDownload ? "Download this upload" : "Download not available"}
                                          disabled={!canDownload}
                                          style={{ color: canDownload ? "#9ca3af" : "#d1d5db", background: "none", border: "none", cursor: canDownload ? "pointer" : "default", padding: 0, lineHeight: 1, opacity: canDownload ? 1 : 0.45 }}
                                          onMouseEnter={e => { if (canDownload) e.currentTarget.style.color = "#fd5108"; }}
                                          onMouseLeave={e => { e.currentTarget.style.color = canDownload ? "#9ca3af" : "#d1d5db"; }}
                                          data-testid={`button-download-n10d-upload-${i}`}
                                        >
                                          <Download style={{ width: 12, height: 12 }} />
                                        </button>
                                      );
                                    })()}
                                    <button
                                      onClick={() =>
                                        setDeleteTarget({
                                          upload: up,
                                          isActive,
                                        })
                                      }
                                      title="Delete upload"
                                      style={{
                                        color: "#9ca3af",
                                        background: "none",
                                        border: "none",
                                        cursor: "pointer",
                                        padding: 0,
                                        lineHeight: 1,
                                      }}
                                      onMouseEnter={(e) =>
                                        (e.currentTarget.style.color =
                                          "#e53935")
                                      }
                                      onMouseLeave={(e) =>
                                        (e.currentTarget.style.color =
                                          "#9ca3af")
                                      }
                                      data-testid={`button-delete-n10d-upload-${i}`}
                                    >
                                      <Trash2
                                        style={{ width: 12, height: 12 }}
                                      />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              );
            })()
          )}
        </div>
      </CardContent>

      {/* Delete confirmation dialog */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !isDeleting) {
            setDeleteTarget(null);
            setConfirmText("");
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogTitle className="sr-only">Delete Upload</DialogTitle>
          {deleteTarget &&
            (() => {
              const { upload, isActive } = deleteTarget;
              const fileName = upload.file_name || "Uploaded file";
              const isExact = confirmText === "Confirm";
              const isPartial =
                !isExact &&
                confirmText.length > 0 &&
                "Confirm".startsWith(confirmText);
              const isWrong = !isExact && !isPartial && confirmText.length > 0;
              const canDelete = isExact && !isDeleting;
              const inputBorderColor = isExact
                ? "#43a047"
                : isWrong
                  ? "#fecaca"
                  : "#d1d5db";
              return (
                <div>
                  {/* Title */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 10,
                    }}
                  >
                    <Trash2
                      style={{
                        width: 15,
                        height: 15,
                        color: "#e53935",
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: "#1a1a1a",
                      }}
                    >
                      Delete Upload
                    </span>
                  </div>
                  <p
                    style={{ fontSize: 12, color: "#6b7280", marginBottom: 14 }}
                  >
                    Are you sure you want to delete this file?
                  </p>

                  {/* File details */}
                  <div style={{ marginBottom: 14 }}>
                    {[
                      ["File", fileName],
                      ["Uploaded", formatUploadDate(upload.created_date)],
                      [
                        "Records",
                        `${upload.record_count != null ? upload.record_count : "?"} products`,
                      ],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        style={{ display: "flex", gap: 8, marginBottom: 3 }}
                      >
                        <span
                          style={{
                            fontSize: 11,
                            color: "#6b7280",
                            minWidth: 78,
                          }}
                        >
                          {label}:
                        </span>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 500,
                            color: "#1a1a1a",
                          }}
                        >
                          {value}
                        </span>
                      </div>
                    ))}
                    {isActive && (
                      <div style={{ display: "flex", gap: 8, marginBottom: 3 }}>
                        <span
                          style={{
                            fontSize: 11,
                            color: "#6b7280",
                            minWidth: 78,
                          }}
                        >
                          Status:
                        </span>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: "#43a047",
                          }}
                        >
                          Active ✓
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Warning */}
                  <div
                    style={{
                      background: "#fef2f2",
                      border: "1px solid #fecaca",
                      borderRadius: 6,
                      padding: "8px 12px",
                      marginBottom: 14,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                      }}
                    >
                      <AlertTriangle
                        style={{
                          width: 13,
                          height: 13,
                          color: "#e53935",
                          marginTop: 1,
                          flexShrink: 0,
                        }}
                      />
                      <p
                        style={{
                          fontSize: 11,
                          color: "#991b1b",
                          lineHeight: 1.5,
                        }}
                      >
                        {isActive ? (
                          <>
                            <strong>This is the currently ACTIVE file.</strong>{" "}
                            Deleting it will remove all associated data. The
                            next most recent upload will become active, or the
                            page will revert to empty state if no other uploads
                            exist. This action cannot be undone.
                          </>
                        ) : (
                          "This action cannot be undone. The file and its data will be permanently removed."
                        )}
                      </p>
                    </div>
                  </div>

                  {/* Confirm input */}
                  <div style={{ marginBottom: 18 }}>
                    <label
                      style={{
                        display: "block",
                        fontSize: 12,
                        fontWeight: 500,
                        color: "#1a1a1a",
                        marginBottom: 6,
                      }}
                    >
                      Type <em>"Confirm"</em> to proceed:
                    </label>
                    <input
                      autoFocus
                      type="text"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && canDelete)
                          handleConfirmDelete();
                      }}
                      placeholder="Type Confirm here..."
                      disabled={isDeleting}
                      data-testid="input-delete-confirm"
                      style={{
                        width: "100%",
                        padding: "6px 10px",
                        fontSize: 12,
                        border: `1px solid ${inputBorderColor}`,
                        borderRadius: 6,
                        outline: "none",
                        color: "#374151",
                        fontStyle: confirmText ? "normal" : "italic",
                      }}
                    />
                    {isWrong && (
                      <p
                        style={{ fontSize: 10, color: "#e53935", marginTop: 4 }}
                      >
                        Please type 'Confirm' exactly.
                      </p>
                    )}
                  </div>

                  {/* Buttons */}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      gap: 8,
                    }}
                  >
                    <button
                      onClick={() => {
                        setDeleteTarget(null);
                        setConfirmText("");
                      }}
                      disabled={isDeleting}
                      style={{
                        fontSize: 12,
                        color: "#374151",
                        padding: "6px 16px",
                        border: "1px solid #d1d5db",
                        borderRadius: 6,
                        background: "none",
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.borderColor = "#9ca3af")
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.borderColor = "#d1d5db")
                      }
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleConfirmDelete}
                      disabled={!canDelete}
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        padding: "6px 16px",
                        border: "none",
                        borderRadius: 6,
                        color: canDelete ? "#fff" : "#d1d5db",
                        background: isDeleting
                          ? "#f87171"
                          : canDelete
                            ? "#e53935"
                            : "#f3f4f6",
                        cursor: canDelete ? "pointer" : "not-allowed",
                      }}
                      onMouseEnter={(e) => {
                        if (canDelete)
                          e.currentTarget.style.background = "#c62828";
                      }}
                      onMouseLeave={(e) => {
                        if (canDelete && !isDeleting)
                          e.currentTarget.style.background = "#e53935";
                      }}
                    >
                      {isDeleting ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </div>
              );
            })()}
        </DialogContent>
      </Dialog>

      {/* ── Row hover tooltips (both portal-rendered) ── */}
      {hoverType === 'product' && tooltipData && <ProductTooltipPanel data={tooltipData} position={tooltipPos} />}
      {hoverType === 'day' && dayTooltipData && <N10DDayCellTooltip data={dayTooltipData} position={tooltipPos} />}
    </Card>
  );
}
