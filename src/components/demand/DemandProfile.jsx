import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Search,
  Package,
  TrendingUp,
  Calendar,
  BarChart3,
  Loader2,
  Upload,
  Download,
  X,
  CheckCircle2,
  AlertCircle,
  Plus,
  AlertTriangle,
  ShieldCheck,
  Boxes,
  RefreshCw,
} from "lucide-react";
import * as XLSX from "xlsx";
import { parseFile, normalizeData } from "./demandUploadParser";
import { generateDemandInsight, generateSmartDemandBatch } from "@/services/azureAI";

const GRAINS = [
  { value: "daily", label: "Daily" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
];

const ALL_YEARS = ["2021", "2022", "2023", "2024", "2025"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTH_SHORT = [
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

const FORMAT_LABELS = {
  wide_monthly: "Monthly Format (e.g. January 2025)",
  wide_5_year: "Legacy Format (Jan-2021 … Dec-2025)",
};

// Cache fetched JSON datasets
const _cache = new Map();

async function loadGrainData(grain, year) {
  const key = grain === "daily" ? `daily_${year}` : grain;
  if (_cache.has(key)) return _cache.get(key);
  const file =
    grain === "daily"
      ? `/data/demand_daily_${year}.json`
      : `/data/demand_${grain}.json`;
  const res = await fetch(file);
  if (!res.ok) throw new Error(`Failed to load ${file}`);
  const data = await res.json();
  _cache.set(key, data);
  return data;
}

// Build compact {fgs, rows} from done-order history.
// Returns null when there's nothing to derive.
// Uses strict year+month from end_date — distinct from the year-agnostic
// matching used for "Delivered to Date" (matchEndDateToPeriod).
function buildDemandFromOrderHistory(orders) {
  if (!Array.isArray(orders) || orders.length === 0) return null;
  const fgs = {};
  const aggMap = new Map(); // `${YYYY-MM}\x01${fg}` -> qty
  for (const o of orders) {
    const status = (o.status || "").toLowerCase().trim();
    if (status !== "done" && status !== "completed") continue;
    if (!o.end_date) continue;
    // Strict, timezone-safe year+month from end_date.
    // Prefer the leading "YYYY-MM" of an ISO-like string to avoid local-time
    // shifts (e.g. "2026-06-01" → "2026-05" in negative offsets when parsed
    // as a Date). Fall back to UTC accessors for non-ISO inputs.
    const s = String(o.end_date);
    let pk;
    const isoMatch = s.match(/^(\d{4})-(\d{2})/);
    if (isoMatch) {
      pk = `${isoMatch[1]}-${isoMatch[2]}`;
    } else {
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) continue;
      pk = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    }
    const fg = String(o.material_code_fg || o.material_code || "").trim();
    if (!fg) continue;
    const vol = parseFloat(o.volume_override ?? o.total_volume_mt ?? 0) || 0;
    if (vol <= 0) continue;
    const key = `${pk}\x01${fg}`;
    aggMap.set(key, (aggMap.get(key) || 0) + vol);
    if (!fgs[fg]) fgs[fg] = o.item_description || fg;
  }
  if (aggMap.size === 0) return null;
  const rows = [];
  for (const [key, qty] of aggMap) {
    const sep = key.indexOf("\x01");
    rows.push([key.slice(0, sep), key.slice(sep + 1), qty]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { fgs, rows };
}

// Build compact {fgs, rows} from uploaded raw rows for a given grain
function buildCompactFromUploaded(dataset, grain) {
  const { fgs, rawRows } = dataset;
  if (grain === "daily") return { fgs, rows: [] };

  const aggMap = new Map();
  for (const { fg, year, month, qty } of rawRows) {
    let pk;
    if (grain === "monthly") pk = `${year}-${String(month).padStart(2, "0")}`;
    else if (grain === "quarterly") pk = `${year}-Q${Math.ceil(month / 3)}`;
    else pk = String(year);
    const key = `${pk}\x01${fg}`;
    aggMap.set(key, (aggMap.get(key) || 0) + qty);
  }
  const rows = [];
  for (const [key, qty] of aggMap) {
    const sep = key.indexOf("\x01");
    rows.push([key.slice(0, sep), key.slice(sep + 1), qty]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { fgs, rows };
}

// Returns true when an order's end_date falls inside the demand row's period.
// Monthly / Daily / Quarterly: match by period component only (year-agnostic),
// so a Done order ending in May 2026 counts against a May 2025 benchmark row.
// Yearly: strict year match (the only grain where year equality is required).
function matchEndDateToPeriod(endDate, period, grain) {
  if (!endDate) return false;
  const ed = String(endDate).slice(0, 10); // "YYYY-MM-DD"
  if (grain === "monthly") {
    // Match by month only — period = "YYYY-MM", compare MM part only
    return ed.slice(5, 7) === period.slice(5, 7);
  }
  if (grain === "yearly") {
    // Only grain that requires year equality — period = "YYYY"
    return ed.slice(0, 4) === period;
  }
  if (grain === "daily") {
    // Match by month + day only — period = "YYYY-MM-DD", compare MM-DD
    return ed.slice(5, 10) === period.slice(5, 10);
  }
  if (grain === "quarterly") {
    // Match by quarter number only — period = "YYYY-Q2", compare Q digit
    const edQ = Math.ceil(parseInt(ed.slice(5, 7), 10) / 3); // end_date month → Q
    const pQ = parseInt(period.slice(6), 10); // "2025-Q2" → 2
    return edQ === pQ;
  }
  return false;
}

function periodLabel(key, grain) {
  if (grain === "daily") {
    const [y, m, d] = key.split("-");
    return `${MONTH_NAMES[parseInt(m, 10) - 1].slice(0, 3)} ${parseInt(d, 10)}, ${y}`;
  }
  if (grain === "monthly") {
    const [y, m] = key.split("-");
    return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
  }
  if (grain === "quarterly") return key;
  return key;
}

function classifyCoverage(pct, fulfilled, pipeline, demand) {
  if (demand == null || demand === 0 || pct == null)
    return { label: "No benchmark", cls: "bg-gray-100 text-gray-600" };
  if (pct > 100)
    return {
      label: "Exceeds demand",
      cls: "bg-green-50 text-green-700 border border-green-200",
    };
  if (pct >= 100)
    return {
      label: "Covered",
      cls: "bg-green-50 text-green-700 border border-green-200",
    };
  if (pct >= 70)
    return {
      label: "Near target",
      cls: "bg-blue-50 text-blue-700 border border-blue-200",
    };
  if (pct >= 30)
    return {
      label: "Below target",
      cls: "bg-amber-50 text-amber-700 border border-amber-200",
    };
  if (pct > 0)
    return {
      label: "Large gap",
      cls: "bg-red-50 text-red-700 border border-red-200",
    };
  return { label: "No fulfillment yet", cls: "bg-gray-100 text-gray-500" };
}

function deriveInsight(pcts) {
  const nonZero = pcts.filter((p) => p > 0);
  if (nonZero.length === 0) return "No data";
  const maxPct = Math.max(...pcts);
  const maxIdx = pcts.indexOf(maxPct);
  if (maxPct > 25) return `Seasonal spike in ${MONTH_SHORT[maxIdx]}`;
  const q1 = pcts[0] + pcts[1] + pcts[2];
  const q2 = pcts[3] + pcts[4] + pcts[5];
  const q3 = pcts[6] + pcts[7] + pcts[8];
  const q4 = pcts[9] + pcts[10] + pcts[11];
  const quarters = [q1, q2, q3, q4];
  const maxQ = Math.max(...quarters);
  const maxQIdx = quarters.indexOf(maxQ);
  if (maxQ > 40) return `Peaks in Q${maxQIdx + 1}`;
  const h1 = q1 + q2,
    h2 = q3 + q4;
  if (h1 > 60) return "Higher in 1st half";
  if (h2 > 60) return "Higher in 2nd half";
  if (nonZero.length >= 10 && maxPct < 12) return "Stable all year";
  return `Strong in ${MONTH_SHORT[maxIdx]}`;
}

function heatmapStyle(pct, rowMaxPct) {
  if (!pct || !rowMaxPct) return {};
  const intensity = pct / rowMaxPct;
  const r = Math.round(220 + (22 - 220) * intensity);
  const g = Math.round(38 + (163 - 38) * intensity);
  const b = Math.round(38 + (74 - 38) * intensity);
  const alpha = 0.15 + intensity * 0.55;
  return {
    backgroundColor: `rgba(${r},${g},${b},${alpha.toFixed(2)})`,
    color: intensity > 0.55 || intensity < 0.18 ? "#fff" : undefined,
  };
}

const fmt = (n, d = 1) =>
  (Number(n) || 0).toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });

const DEFAULT_CAPACITY_MT_PER_HR = 15;

function deriveOpsMetrics(r) {
  const demand = Number(r.demand) || 0;
  const fulfilled = Number(r.fulfilled) || 0;
  const pipeline = Number(r.pipeline) || 0;
  const daily = demand / 30;
  const onHand = fulfilled + pipeline;
  const capacity = DEFAULT_CAPACITY_MT_PER_HR;
  const daysCovered = daily > 0 ? onHand / daily : null;
  const leadTime = capacity > 0 ? daily / capacity : null;
  return { daily, onHand, capacity, daysCovered, leadTime };
}

// ── AI Demand Insights text renderer ─────────────────────────────────────────
const INSIGHT_HEADING_EMOJIS = ["📊", "✅", "⚠️", "💡", "🔍", "📌"];
function DemandInsightText({ text }) {
  if (!text) return null;
  const lines = text.split("\n");
  const blocks = [];
  let key = 0;
  let firstHeading = false;
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const isHeading = INSIGHT_HEADING_EMOJIS.some((e) => trimmed.startsWith(e));
    const isBullet = trimmed.startsWith("- ");
    if (isHeading) {
      if (firstHeading) {
        blocks.push(
          <div
            key={`sep-${key++}`}
            style={{
              borderTop: "1px dashed var(--color-border)",
              margin: "10px 0",
            }}
          />,
        );
      }
      firstHeading = true;
      blocks.push(
        <div
          key={key++}
          style={{
            fontSize: "11px",
            fontWeight: 700,
            color: "var(--color-text)",
            marginBottom: "4px",
          }}
        >
          {trimmed}
        </div>,
      );
    } else if (isBullet) {
      blocks.push(
        <div
          key={key++}
          style={{
            fontSize: "11px",
            color: "var(--color-text-muted)",
            lineHeight: 1.7,
            paddingLeft: "8px",
          }}
        >
          {trimmed}
        </div>,
      );
    } else {
      blocks.push(
        <div
          key={key++}
          style={{
            fontSize: "11px",
            color: "var(--color-text-muted)",
            lineHeight: 1.7,
          }}
        >
          {trimmed}
        </div>,
      );
    }
  });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      {blocks}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export default function DemandProfile({ orders = [], n10dRecords = [], kbRecords = [] }) {
  const [grain, setGrain] = useState("monthly");
  // Default to the last fully-completed year (current year is still in progress).
  const [year, setYear] = useState(() => String(new Date().getFullYear() - 1));
  const [month, setMonth] = useState(() => String(new Date().getMonth() + 1));
  const [search, setSearch] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Uploaded demand dataset replaces JSON files when set
  const [uploadedDataset, setUploadedDataset] = useState(null);
  // Modal state: null | { step, parseResult?, selectedYear?, errorMsg? }
  const [uploadModal, setUploadModal] = useState(null);
  const fileInputRef = useRef(null);

  // ── AI Demand Insights state ─────────────────────────────────────────────
  const [demandInsightExpanded, setDemandInsightExpanded] = useState(false);
  const [demandInsightText, setDemandInsightText] = useState("");
  const [demandInsightLoading, setDemandInsightLoading] = useState(false);
  const demandInsightGenerated = useRef(false);

  // ── Smart Demand AI state ─────────────────────────────────────────────────
  const [smartDemandAiMap, setSmartDemandAiMap] = useState(new Map());
  const [smartDemandAiLoading, setSmartDemandAiLoading] = useState(false);
  // Cache: keyed by "grain:year:month" → Map<fg__period, value>
  const smartDemandCacheRef = useRef(new Map());
  // Incrementing counter — bumping this forces a fresh AI+DB call
  const [smartDemandForceCounter, setSmartDemandForceCounter] = useState(0);

  // Derived demand from done-order history (used as fallback / year source)
  const orderHistoryDemand = useMemo(
    () => buildDemandFromOrderHistory(orders),
    [orders],
  );

  // Years available depend on uploaded data; also surface any years present
  // in done-order history so the Year filter exposes them automatically.
  const availableYears = useMemo(() => {
    if (uploadedDataset) {
      const ys = [
        ...new Set(uploadedDataset.rawRows.map((r) => String(r.year))),
      ].sort();
      return ys.length ? ys : ALL_YEARS;
    }
    const historyYears = orderHistoryDemand
      ? [...new Set(orderHistoryDemand.rows.map((r) => r[0].slice(0, 4)))]
      : [];
    const merged = [...new Set([...ALL_YEARS, ...historyYears])].sort();
    return merged.length ? merged : ALL_YEARS;
  }, [uploadedDataset, orderHistoryDemand]);

  // When uploaded data changes, reset year to first available
  useEffect(() => {
    if (uploadedDataset && !availableYears.includes(year)) {
      setYear(availableYears[availableYears.length - 1] || "2024");
    }
  }, [uploadedDataset, availableYears]);

  // Load / compute data when grain/year/uploadedDataset changes
  useEffect(() => {
    if (uploadedDataset) {
      setLoading(false);
      setError(null);
      setData(buildCompactFromUploaded(uploadedDataset, grain));
      return;
    }
    let aborted = false;
    setLoading(true);
    setError(null);
    loadGrainData(grain, year)
      .then((d) => {
        if (aborted) return;
        const hasRowsForYear =
          d &&
          Array.isArray(d.rows) &&
          d.rows.some((r) => String(r[0]).slice(0, 4) === String(year));
        if (!hasRowsForYear && orderHistoryDemand && grain === "monthly") {
          setData(orderHistoryDemand);
        } else {
          setData(d);
        }
      })
      .catch((e) => {
        if (aborted) return;
        if (orderHistoryDemand && grain === "monthly") {
          setData(orderHistoryDemand);
        } else {
          setError(e.message || "Failed to load demand data");
        }
      })
      .finally(() => {
        if (!aborted) setLoading(false);
      });
    return () => {
      aborted = true;
    };
  }, [grain, year, uploadedDataset, orderHistoryDemand]);

  // True when displayed data is sourced from done-order history
  const isOrderHistorySource =
    !uploadedDataset &&
    !!orderHistoryDemand &&
    data === orderHistoryDemand;

  // ── Reset to current period when grain or available years change ─────────
  useEffect(() => {
    const now = new Date();
    const sysYear = now.getFullYear();
    const currentMonth = String(now.getMonth() + 1);
    const currentDay = String(now.getDate());
    const currentQuarter = Math.ceil((now.getMonth() + 1) / 3);

    // Pick the latest fully-completed year (strictly before the current year,
    // since the current year is still in progress and its data is incomplete).
    const validYears = availableYears
      .filter((y) => parseInt(y, 10) < sysYear)
      .sort();
    const appliedDefaultYear =
      validYears.length > 0
        ? validYears[validYears.length - 1]
        : availableYears[availableYears.length - 1] || "2025";

    setYear(appliedDefaultYear);
    if (grain === "monthly" || grain === "daily") setMonth(currentMonth);
    else setMonth("all");

    const appliedDefaultPeriod =
      grain === "monthly"
        ? `${appliedDefaultYear}-${currentMonth.padStart(2, "0")}`
        : grain === "quarterly"
          ? `${appliedDefaultYear}-Q${currentQuarter}`
          : grain === "daily"
            ? `${appliedDefaultYear}-${currentMonth.padStart(2, "0")}-${currentDay.padStart(2, "0")}`
            : appliedDefaultYear;

    console.debug("[Demand Profile Default Historical Period]", {
      today: now.toISOString(),
      selectedTimeGrain: grain,
      currentMonth: now.toLocaleString("default", { month: "long" }),
      currentDay: now.getDate(),
      currentQuarter: `Q${currentQuarter}`,
      availableHistoricalYears: availableYears,
      appliedDefaultYear,
      appliedDefaultPeriod,
    });
  }, [grain, availableYears]);

  // ── SKU Monitoring template download ────────────────────────────────────
  function downloadSKUMonitoringTemplate() {
    const currentYear = new Date().getFullYear();
    const headers = [
      "FG Material Code",
      "FG Item Description",
      "SFG1 Material Code",
      "SFG Item Description",
      ...["January","February","March","April","May","June",
          "July","August","September","October","November","December"]
        .map((m) => `${m} ${currentYear}`),
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers]);
    const colWidths = headers.map((h) => ({ wch: Math.max(h.length + 4, 18) }));
    ws["!cols"] = colWidths;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Demand");
    XLSX.writeFile(wb, "SKU_Monitoring_Template.xlsx");
  }

  // ── Upload handlers ─────────────────────────────────────────────────────
  function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setUploadModal({ step: "parsing" });
    parseFile(file)
      .then((parseResult) => {
        setUploadModal({ step: "preview", parseResult });
      })
      .catch((err) => {
        setUploadModal({ step: "error", errorMsg: err.message });
      });
  }

  function handleConfirmImport() {
    if (!uploadModal?.parseResult) return;
    const dataset = normalizeData(uploadModal.parseResult);
    setUploadedDataset(dataset);
    setUploadModal(null);
  }

  function handleClearUpload() {
    setUploadedDataset(null);
    setData(null);
  }

  // ── Done orders by FG — period-aware source for "Delivered to Date" ─────
  // Source: Order History (Done orders with end_date) from the orders prop.
  const doneOrdersByFg = useMemo(() => {
    const m = new Map(); // fg → [{end_date, vol, id}]
    console.debug("[SKU Monitoring LinedUp Source]", {
      source: "active_orders",
      includedStatuses: [
        "Plotted",
        "Planned",
        "Cut",
        "On-going",
        "Combined with other PO",
      ],
    });
    for (const o of orders || []) {
      const status = (o.status || "").toLowerCase().trim();
      if (status !== "done" && status !== "completed") continue;
      const fg = String(o.material_code_fg || o.material_code || "").trim();
      if (!fg) continue;
      const vol = parseFloat(o.volume_override ?? o.total_volume_mt ?? 0) || 0;
      const end_date = o.end_date || null;
      if (!m.has(fg)) m.set(fg, []);
      m.get(fg).push({ end_date, vol, id: o.id || o.planned_order_id || "" });
    }
    return m;
  }, [orders]);

  // ── Pipeline by FG — flat totals for "Lined-up (MT)" ────────────────────
  // Source: active Orders table (non-Done, non-Cancelled).
  const pipelineByFg = useMemo(() => {
    const PIPELINE_S = new Set([
      "plotted",
      "planned",
      "cut",
      "on-going",
      "combined with other po",
    ]);
    const m = new Map(); // fg → total pipeline MT
    for (const o of orders || []) {
      const status = (o.status || "").toLowerCase().trim();
      if (!PIPELINE_S.has(status)) continue;
      const fg = String(o.material_code_fg || o.material_code || "").trim();
      if (!fg) continue;
      const vol = parseFloat(o.volume_override ?? o.total_volume_mt ?? 0) || 0;
      m.set(fg, (m.get(fg) || 0) + vol);
    }
    return m;
  }, [orders]);

  // ── Monthly pivot matrix ────────────────────────────────────────────────
  const monthlyMatrix = useMemo(() => {
    if (grain !== "monthly" || !data) return null;
    const { fgs, rows } = data;
    const term = search.trim().toLowerCase();
    const fgMap = new Map();
    for (const [period, fg, qty] of rows) {
      if (!period.startsWith(year)) continue;
      const mIdx = parseInt(period.slice(5, 7), 10) - 1;
      if (mIdx < 0 || mIdx > 11) continue;
      const name = fgs[fg] || "";
      if (
        term &&
        !fg.toLowerCase().includes(term) &&
        !name.toLowerCase().includes(term)
      )
        continue;
      if (!fgMap.has(fg)) fgMap.set(fg, new Array(12).fill(0));
      fgMap.get(fg)[mIdx] += qty;
    }
    const matrixRows = [];
    for (const [fg, monthly] of fgMap) {
      const annualTotal = monthly.reduce((s, v) => s + v, 0);
      const pcts = monthly.map((v) =>
        annualTotal > 0 ? (v / annualTotal) * 100 : 0,
      );
      const insight = deriveInsight(pcts);
      console.debug("[Demand Profile Monthly Share Calculation]", {
        fgMaterialCode: fg,
        annualDemandMT: annualTotal,
        monthlyValuesMT: monthly,
        monthlyPercentages: pcts.map((p) => +p.toFixed(2)),
        insight,
      });
      matrixRows.push({
        fg,
        name: fgs[fg] || "",
        monthly,
        pcts,
        annualTotal,
        insight,
      });
    }
    matrixRows.sort((a, b) => b.annualTotal - a.annualTotal);
    console.debug("[Demand Profile Monthly Matrix Build]", {
      skuCount: matrixRows.length,
      selectedYear: year,
      rows: matrixRows,
    });
    return matrixRows;
  }, [data, grain, year, search]);

  // ── Flat rows ───────────────────────────────────────────────────────────
  const tableRows = useMemo(() => {
    if (!data) return [];
    const { fgs, rows } = data;
    const term = search.trim().toLowerCase();
    const periodMatches = (pk) => {
      if (grain === "yearly") return pk === year;
      if (grain === "quarterly") return pk.startsWith(year);
      if (grain === "monthly") {
        if (!pk.startsWith(year)) return false;
        if (month === "all") return true;
        return parseInt(pk.slice(5, 7), 10) === parseInt(month, 10);
      }
      if (month === "all") return true;
      return parseInt(pk.slice(5, 7), 10) === parseInt(month, 10);
    };
    const out = [];
    for (const [period, fg, qty] of rows) {
      if (!periodMatches(period)) continue;
      const name = fgs[fg] || "";
      if (
        term &&
        !fg.toLowerCase().includes(term) &&
        !name.toLowerCase().includes(term)
      )
        continue;
      out.push({ fg, name, period, demand: qty });
    }
    out.sort((a, b) =>
      a.period < b.period ? -1 : a.period > b.period ? 1 : b.demand - a.demand,
    );
    return out;
  }, [data, search, year, month, grain]);

  const enrichedRows = useMemo(() => {
    console.debug("[SKU Monitoring Delivered To Date Source]", {
      source: "order_history",
      selectedTimeGrain: grain,
      selectedPeriod:
        month !== "all" ? `${year}-${String(month).padStart(2, "0")}` : year,
    });
    return tableRows.map((r) => {
      // Delivered to Date — period-aware: only Done orders whose end_date falls in this row's period
      const doneEntries = doneOrdersByFg.get(r.fg) || [];
      let fulfilled = 0;
      const matchedOrderIds = [];
      const periodParts = r.period.split("-");
      const benchYear = periodParts[0] || "";
      const benchMonth =
        grain === "monthly"
          ? periodParts[1]
          : grain === "daily"
            ? periodParts[1]
            : "";
      const benchDay = grain === "daily" ? periodParts[2] : "";
      for (const entry of doneEntries) {
        const matchedByPeriod = matchEndDateToPeriod(
          entry.end_date,
          r.period,
          grain,
        );
        console.debug("[SKU Monitoring Delivered Period Match]", {
          selectedTimeGrain: grain,
          historicalBenchmarkLabel: r.period,
          historicalBenchmarkYear: benchYear,
          historicalBenchmarkMonth: benchMonth,
          historicalBenchmarkDay: benchDay,
          orderId: entry.id,
          orderEndDate: entry.end_date,
          matchedByPeriod,
        });
        if (matchedByPeriod) {
          fulfilled += entry.vol;
          matchedOrderIds.push(entry.id);
        }
      }
      console.debug("[SKU Monitoring Delivered Aggregation]", {
        selectedTimeGrain: grain,
        selectedPeriodLabel: r.period,
        matchedOrderIds,
        deliveredToDateMT: fulfilled,
      });
      // Lined-up — flat FG total from active orders (no period constraint)
      const pipeline = pipelineByFg.get(r.fg) || 0;
      const total = fulfilled + pipeline;
      const coverage = r.demand > 0 ? (total / r.demand) * 100 : null;
      const gap = r.demand > 0 ? Math.max(0, r.demand - total) : 0;
      const ins = classifyCoverage(coverage, fulfilled, pipeline, r.demand);
      console.debug("[Demand Profile Fulfillment Comparison]", {
        fgMaterialCode: r.fg,
        benchmarkPeriod: r.period,
        historicalDemandMT: r.demand,
        fulfilledDoneMT: fulfilled,
        pipelineMT: pipeline,
        remainingGapMT: gap,
        coveragePct: coverage != null ? +coverage.toFixed(1) : null,
      });
      return {
        ...r,
        fulfilled,
        pipeline,
        gap,
        coverage,
        insightLabel: ins.label,
        insightCls: ins.cls,
      };
    });
  }, [tableRows, doneOrdersByFg, pipelineByFg, grain, year, month]);

  // ── Smart Demand AI: fire batch call when visible rows change ────────────
  useEffect(() => {
    if (!enrichedRows.length || !data?.rows) return;
    const isForce = smartDemandForceCounter > 0;
    // Cache key includes the focus month so any month change triggers a fresh call
    const cacheKey = `${grain}:${year}:${month}`;

    if (!isForce) {
      const cached = smartDemandCacheRef.current.get(cacheKey);
      if (cached) {
        console.debug('[Smart Demand Cache Lookup]', {
          grain, year, month, foundExistingSmartDemand: true,
        });
        setSmartDemandAiMap(cached);
        return;
      }
    } else {
      // Clear in-memory cache for this key so fresh results are stored after the call
      smartDemandCacheRef.current.delete(cacheKey);
    }
    console.debug('[Smart Demand Cache Lookup]', {
      grain, year, month, foundExistingSmartDemand: false, force: isForce,
    });

    // ── Build payload ────────────────────────────────────────────────────
    // CORE RULE: only actual historical demand records are sent to the AI.
    // Smart Demand values are NEVER used as historical input here.
    const allRows = data.rows; // [period, fg, qty][]
    const seen = new Set();
    const payloads = [];
    for (const r of enrichedRows) {
      const key = `${r.fg}__${r.period}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Extract focus month ("05" for May) from the row's period
      const focusMonth = grain === "monthly" ? r.period.slice(5, 7) : null;

      // MONTH FOCUS RULE: prefer same-month records across all historical years.
      // This keeps the AI analysis aligned with the current page context and
      // reduces token usage / waiting time.
      let fgHistory = focusMonth
        ? allRows
            .filter(([p, f]) => f === r.fg && p.slice(5, 7) === focusMonth)
            .map(([period, , qty]) => ({ period, demandMT: qty }))
            .sort((a, b) => (a.period < b.period ? -1 : 1))
        : [];

      // Fallback: if fewer than 1 same-month record exists, use all FG records
      if (fgHistory.length === 0) {
        fgHistory = allRows
          .filter(([, f]) => f === r.fg)
          .map(([period, , qty]) => ({ period, demandMT: qty }))
          .sort((a, b) => (a.period < b.period ? -1 : 1));
      }

      console.debug('[Smart Demand Historical Input]', {
        sku: r.fg,
        focusMonth: focusMonth || r.period,
        historicalRecordsCount: fgHistory.length,
        includesOnlyActualHistoricalData: true,
      });
      console.debug('[Smart Demand Source Separation Check]', {
        sku: r.fg,
        smartDemandUsedAsHistoricalInput: false,
      });

      payloads.push({
        key,
        sku: r.fg,
        description: r.name || r.fg,
        targetPeriod: r.period,
        focusMonth: focusMonth || r.period.slice(5, 7) || null,
        historicalRecords: fgHistory,
      });
    }
    if (!payloads.length) return;

    // Batch into chunks of 30 to stay within token limits
    // Smaller batches = shorter prompts = faster individual responses.
    // All batches fire in parallel so total wait ≈ slowest single batch, not sum of all.
    const BATCH = 15;
    setSmartDemandAiLoading(true);
    const resultMap = new Map();
    const chunks = [];
    for (let i = 0; i < payloads.length; i += BATCH) chunks.push(payloads.slice(i, i + BATCH));
    (async () => {
      await Promise.all(chunks.map(async (chunk) => {
        try {
          const results = await generateSmartDemandBatch(chunk, { force: isForce });
          for (const [k, v] of Object.entries(results)) {
            const num = parseFloat(v);
            if (!isNaN(num) && num >= 0) {
              resultMap.set(k, num);
              console.debug('[Smart Demand AI Generated]', {
                sku: k.split('__')[0],
                focusMonth: k.split('__')[1]?.slice(5, 7) || null,
                smartDemandMT: num,
                aiBacked: true,
              });
            }
          }
          // Render values progressively as each batch arrives
          setSmartDemandAiMap(new Map(resultMap));
        } catch (err) {
          console.debug('[Smart Demand AI Failure]', {
            errorMessage: err.message,
            fallbackUsed: false,
            aiUnavailable: true,
          });
        }
      }));
      smartDemandCacheRef.current.set(cacheKey, new Map(resultMap));
      setSmartDemandAiMap(new Map(resultMap));
      setSmartDemandAiLoading(false);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrichedRows, data, grain, year, month, smartDemandForceCounter]);

  // ── KPIs ────────────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    if (grain === "monthly" && monthlyMatrix) {
      let totalDemand = 0,
        topFg = null,
        topFgQty = 0,
        peakMonthIdx = -1,
        peakMonthQty = 0;
      const monthTotals = new Array(12).fill(0);
      for (const r of monthlyMatrix) {
        totalDemand += r.annualTotal;
        if (r.annualTotal > topFgQty) {
          topFg = r.fg;
          topFgQty = r.annualTotal;
        }
        r.monthly.forEach((v, i) => {
          monthTotals[i] += v;
        });
      }
      monthTotals.forEach((v, i) => {
        if (v > peakMonthQty) {
          peakMonthQty = v;
          peakMonthIdx = i;
        }
      });
        let reorderCount = 0, coveredCount = 0, totalOnHand = 0;
      for (const r of enrichedRows) {
        const m = deriveOpsMetrics(r);
        const threshold = m.leadTime != null ? m.leadTime + 12 : null;
        if (m.daysCovered != null && threshold != null && m.daysCovered <= threshold / 24) reorderCount++;
        if (r.insightLabel === "Covered" || r.insightLabel === "Exceeds demand") coveredCount++;
        totalOnHand += m.onHand;
      }
      return {
        totalSkus: monthlyMatrix.length,
        totalDemand,
        topFg,
        topFgQty,
        topFgName: topFg ? data?.fgs?.[topFg] || "" : "",
        peakPeriod:
          peakMonthIdx >= 0
            ? `${year}-${String(peakMonthIdx + 1).padStart(2, "0")}`
            : null,
        peakPeriodQty: peakMonthQty,
        reorderCount,
        coveredCount,
        totalOnHand,
      };
    }
    const uniqueFgs = new Set();
    let totalDemand = 0,
      reorderCount = 0,
      coveredCount = 0,
      totalOnHand = 0;
    const fgTotals = new Map(),
      periodTotals = new Map();
    for (const r of enrichedRows) {
      uniqueFgs.add(r.fg);
      totalDemand += r.demand;
      fgTotals.set(r.fg, (fgTotals.get(r.fg) || 0) + r.demand);
      periodTotals.set(r.period, (periodTotals.get(r.period) || 0) + r.demand);
      // Re-order flag (mirrors FlatTable row renderer logic)
      const m = deriveOpsMetrics(r);
      const threshold = m.leadTime != null ? m.leadTime + 12 : null;
      if (m.daysCovered != null && threshold != null && m.daysCovered <= threshold / 24) {
        reorderCount++;
      }
      // Covered / Exceeds demand
      if (r.insightLabel === "Covered" || r.insightLabel === "Exceeds demand") {
        coveredCount++;
      }
      totalOnHand += m.onHand;
    }
    let topFg = null,
      topFgQty = 0;
    for (const [fg, q] of fgTotals) {
      if (q > topFgQty) {
        topFg = fg;
        topFgQty = q;
      }
    }
    let peakPeriod = null,
      peakPeriodQty = 0;
    for (const [p, q] of periodTotals) {
      if (q > peakPeriodQty) {
        peakPeriod = p;
        peakPeriodQty = q;
      }
    }
    return {
      totalSkus: uniqueFgs.size,
      totalDemand,
      topFg,
      topFgQty,
      topFgName: topFg ? data?.fgs?.[topFg] || "" : "",
      peakPeriod,
      peakPeriodQty,
      reorderCount,
      coveredCount,
      totalOnHand,
    };
  }, [enrichedRows, monthlyMatrix, grain, data, year]);

  useEffect(() => {
    if (!data) return;
    console.debug("[SKU Monitoring Label Update]", {
      sidebarLabel: "Monitoring",
      pageTitle: "SKU Monitoring",
    });
    console.debug("[Demand Profile Data Load]", {
      totalRows: data.rows.length,
      selectedFilters: { search, year, month },
      selectedTimeGrain: grain,
      aggregatedRows:
        grain === "monthly"
          ? (monthlyMatrix?.length ?? 0)
          : enrichedRows.length,
    });
  }, [data, enrichedRows.length, monthlyMatrix, search, year, month, grain]);

  const monthRelevant = grain === "daily" || grain === "monthly";
  const isEmpty =
    enrichedRows.length === 0 &&
    (grain !== "monthly" ||
      (monthlyMatrix !== null && monthlyMatrix.length === 0));

  // ── AI Demand Insights helpers ───────────────────────────────────────────
  const selectedPeriodLabel = useMemo(() => {
    if (grain === "yearly") return year;
    if (grain === "monthly" && month !== "all")
      return `${MONTH_NAMES[parseInt(month, 10) - 1]} ${year}`;
    if (grain === "monthly") return `All months ${year}`;
    if (grain === "quarterly") return year;
    return year;
  }, [grain, year, month]);

  const runDemandInsight = useCallback(async (rows, period, grainVal) => {
    if (!rows || rows.length === 0) return;
    setDemandInsightLoading(true);
    try {
      const result = await generateDemandInsight(rows, {
        selectedPeriod: period,
        timeGrain: grainVal,
      });
      const recommendationCount = (result || "")
        .split("\n")
        .filter((l) => l.trim().startsWith("- ")).length;
      const riskCount = 0;
      console.debug("[Demand AI Insights Output]", {
        summaryGenerated: !!result,
        recommendationCount,
        riskCount,
      });
      setDemandInsightText(
        result || "Unable to generate insight at this time.",
      );
      demandInsightGenerated.current = true;
    } catch {
      setDemandInsightText("Unable to generate insight at this time.");
    }
    setDemandInsightLoading(false);
  }, []);

  // Regenerate when filters change and panel is already open
  useEffect(() => {
    if (demandInsightExpanded && enrichedRows.length > 0) {
      runDemandInsight(enrichedRows, selectedPeriodLabel, grain);
    }
  }, [grain, year, month, enrichedRows.length > 0 && demandInsightExpanded]);

  const handleDemandInsightToggle = () => {
    const willExpand = !demandInsightExpanded;
    setDemandInsightExpanded(willExpand);
    if (
      willExpand &&
      !demandInsightGenerated.current &&
      enrichedRows.length > 0
    ) {
      runDemandInsight(enrichedRows, selectedPeriodLabel, grain);
    }
  };
  const isDailyFromUpload = uploadedDataset && grain === "daily";

  return (
    <div className="space-y-4">
      {/* Title row */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1
            className="text-2xl font-bold text-gray-900"
            data-testid="text-demand-title"
          >
            SKU Monitoring
          </h1>
          <p className="text-[12px] text-gray-500 mt-1">
            Historical demand patterns across SKUs, with supply coverage from
            current orders.
          </p>
        </div>
        {uploadedDataset && (
          <div className="flex items-center gap-1.5 px-3 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded-full text-[12px] font-medium mt-1 shrink-0">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Uploaded data active
            <button
              onClick={handleClearUpload}
              className="ml-1 hover:text-blue-900"
              title="Clear uploaded data, revert to default"
              data-testid="button-demand-clear-upload"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={handleFileChange}
          data-testid="input-demand-file"
        />
      </div>

      {/* ── AI Demand Insights panel ── */}
      {!isEmpty && !loading && !error && (
        <div data-testid="panel-demand-insight" data-tour="demand-smart-insights">
          <div
            onClick={handleDemandInsightToggle}
            data-testid="button-demand-insight-toggle"
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "12px 16px",
              cursor: "pointer",
              userSelect: "none",
              background: "var(--color-bg-tertiary)",
              border: "1px solid var(--color-border)",
              borderRadius: demandInsightExpanded ? "8px 8px 0 0" : "8px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ fontSize: "14px", filter: 'grayscale(1)', opacity: 0.7 }}>✨</span>
              <span
                style={{
                  fontSize: "13px",
                  fontWeight: 700,
                  color: "var(--color-text)",
                }}
              >
                Smart Demand Insights
              </span>
              <span
                style={{
                  fontSize: "11px",
                  color: "var(--color-text-muted)",
                  marginLeft: "4px",
                }}
              >
                {selectedPeriodLabel}
              </span>
              <span
                style={{
                  fontSize: "10px",
                  color: "var(--color-text-muted)",
                  marginLeft: "6px",
                }}
              >
                {demandInsightExpanded ? "▼" : "▶"}
              </span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                runDemandInsight(enrichedRows, selectedPeriodLabel, grain);
              }}
              disabled={demandInsightLoading}
              data-testid="button-demand-insight-refresh"
              style={{
                fontSize: "12px",
                color: "var(--nexfeed-primary)",
                background: "none",
                border: "none",
                cursor: demandInsightLoading ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: "4px",
                opacity: demandInsightLoading ? 0.5 : 1,
                padding: "2px 4px",
                borderRadius: "4px",
              }}
              onMouseEnter={(e) => {
                if (!demandInsightLoading)
                  e.currentTarget.style.color = "#c2410c";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--nexfeed-primary)";
              }}
            >
              {demandInsightLoading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                "↻"
              )}{" "}
              Refresh
            </button>
          </div>

          {demandInsightExpanded && (
            <div
              style={{
                background: "var(--color-bg-tertiary)",
                border: "1px solid var(--color-border)",
                borderTop: "none",
                borderRadius: "0 0 8px 8px",
                padding: "16px 20px",
                maxHeight: "420px",
                overflowY: "auto",
              }}
            >
              {demandInsightLoading ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    color: "#9ca3af",
                  }}
                >
                  <Loader2 size={14} className="animate-spin" />
                  <span style={{ fontSize: "11px" }}>
                    Analyzing demand coverage data…
                  </span>
                </div>
              ) : demandInsightText ? (
                <DemandInsightText text={demandInsightText} />
              ) : (
                <p
                  style={{
                    fontSize: "11px",
                    color: "#9ca3af",
                    fontStyle: "italic",
                  }}
                >
                  No insight yet. Click ↻ Refresh or expand this panel to
                  generate.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      <Card className="border-0 shadow-sm" data-tour="demand-filters">
        <CardContent className="p-4">
          <div className="flex items-end gap-3">
            <div className="flex-1 min-w-0">
              <label className="block text-[12px] text-gray-500 mb-1.5">
                Search SKU
              </label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="FG code or item description..."
                  className="pl-8 h-9 text-[13px]"
                  data-testid="input-demand-search"
                />
              </div>
            </div>
            {/* Time grain selector hidden — locked to monthly on load */}
            <div className="w-[120px] shrink-0">
              <label className="block text-[12px] text-gray-500 mb-1.5">
                Year
              </label>
              <Select value={year} onValueChange={setYear}>
                <SelectTrigger
                  className="h-9 text-[13px]"
                  data-testid="select-demand-year"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableYears.map((y) => (
                    <SelectItem key={y} value={y}>
                      {y}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-[130px] shrink-0">
              <label className="block text-[12px] text-gray-500 mb-1.5">
                Month
              </label>
              <Select
                value={month}
                onValueChange={setMonth}
                disabled={!monthRelevant}
              >
                <SelectTrigger
                  className="h-9 text-[13px]"
                  data-testid="select-demand-month"
                >
                  <SelectValue placeholder="All months" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All months</SelectItem>
                  {MONTH_NAMES.map((m, i) => (
                    <SelectItem key={m} value={String(i + 1)}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 whitespace-nowrap px-3 h-9 rounded-md text-[13px] font-medium bg-[var(--nexfeed-primary)] text-white hover:opacity-90 transition-opacity"
                data-testid="button-demand-upload"
              >
                <Upload className="h-3.5 w-3.5 flex-shrink-0" />
                Upload Demand Data
              </button>
              <span
                onClick={downloadSKUMonitoringTemplate}
                data-testid="link-demand-download-template"
                className="flex items-center gap-1.5 text-[12px] text-gray-500 cursor-pointer hover:text-[var(--nexfeed-primary)] transition-colors select-none whitespace-nowrap"
              >
                <Download className="h-3.5 w-3.5 flex-shrink-0" />
                Download Template
              </span>
            </div>
          </div>
          {isOrderHistorySource && (
            <div
              className="mt-3 flex items-center gap-1.5 text-[11px] text-gray-500"
              data-testid="badge-demand-source-order-history"
            >
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
              Demand sourced from order history
            </div>
          )}
        </CardContent>
      </Card>

      {/* KPI Cards */}
      <div className="grid gap-4" style={{ gridTemplateColumns: '1fr 1fr 1fr 1.6fr 1.6fr' }} data-tour="demand-kpi-cards">
        <KpiCard
          icon={Package}
          iconBg="bg-gray-100"
          iconColor="text-gray-500"
          label="SKUs in view"
          value={fmt(kpis.totalSkus, 0)}
          testId="kpi-skus"
        />
        <KpiCard
          icon={AlertTriangle}
          iconBg="bg-red-50"
          iconColor="text-red-500"
          label="Need to re-order"
          value={fmt(kpis.reorderCount, 0)}
          testId="kpi-reorder-count"
        />
        <KpiCard
          icon={ShieldCheck}
          iconBg="bg-green-50"
          iconColor="text-green-600"
          label="Covered or exceeds"
          value={fmt(kpis.coveredCount, 0)}
          testId="kpi-covered-count"
        />
        <KpiCard
          icon={Boxes}
          iconBg="bg-indigo-50"
          iconColor="text-indigo-600"
          label="Total volume on-hand"
          value={`${fmt(kpis.totalOnHand)} MT`}
          testId="kpi-total-onhand"
        />
        <KpiCard
          icon={BarChart3}
          iconBg="bg-green-50"
          iconColor="text-green-600"
          label="Total historical demand"
          value={`${fmt(kpis.totalDemand)} MT`}
          testId="kpi-total-demand"
        />
      </div>

      {/* Tables */}
      {loading ? (
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-[var(--nexfeed-primary)]" />
              <span className="ml-2 text-[13px] text-[var(--color-text-muted)]">
                Loading demand data...
              </span>
            </div>
          </CardContent>
        </Card>
      ) : error ? (
        <Card>
          <CardContent className="p-0">
            <div className="py-12 text-center text-[13px] text-red-600">
              {error}
            </div>
          </CardContent>
        </Card>
      ) : isDailyFromUpload ? (
        <Card>
          <CardContent className="p-0">
            <div className="py-14 text-center text-[13px] text-[var(--color-text-muted)] italic">
              Daily-level data is not available from uploaded files. Switch to
              Monthly, Quarterly, or Yearly to view uploaded demand.
            </div>
          </CardContent>
        </Card>
      ) : isEmpty ? (
        <Card>
          <CardContent className="p-0">
            <div
              className="py-16 text-center text-[13px] text-[var(--color-text-muted)] italic"
              data-testid="text-demand-empty"
            >
              No demand profile data available for the selected filters
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <SectionHeader
            title="Detailed Demand View"
            sub="Historical demand benchmark vs. delivered (Done) and on-hand orders — with remaining volume and completion %"
          />
          <Card className="demand-flat-table-light overflow-hidden" data-tour="demand-detailed-view">
            <CardContent className="p-0">
              <FlatTable
                rows={enrichedRows}
                grain={grain}
                kbRecords={kbRecords}
                allRows={data?.rows ?? []}
                smartDemandAiMap={smartDemandAiMap}
                smartDemandAiLoading={smartDemandAiLoading}
                onRegenerateSmartDemand={() => setSmartDemandForceCounter(c => c + 1)}
                onRender={(rowCount) => {
                  console.debug("[Demand Profile Detailed Table Render]", {
                    timeGrain: grain,
                    rowCount,
                    filters: { search, year, month },
                  });
                  console.debug("[SKU Monitoring Default Sort]", {
                    sortColumn: "accountedFor",
                    sortDirection: "desc",
                    rowCount,
                  });
                }}
              />
            </CardContent>
          </Card>

          {grain === "monthly" && (
            <>
              <SectionHeader
                title="Monthly Demand Profile"
                sub="Seasonal demand pattern per SKU — percentage share of annual demand with heatmap intensity"
              />
              <Card className="demand-flat-table-light overflow-hidden" data-tour="demand-monthly-profile">
                <CardContent className="p-0">
                  <MonthlyMatrix
                    rows={monthlyMatrix}
                    onRender={(skuCount) =>
                      console.debug("[Demand Profile Heatmap Table Render]", {
                        timeGrain: grain,
                        skuCount,
                        filters: { search, year, month },
                        visible: grain === "monthly",
                      })
                    }
                  />
                </CardContent>
              </Card>
            </>
          )}
        </>
      )}

      {/* Upload Modal */}
      {uploadModal && (
        <UploadModal
          modal={uploadModal}
          onClose={() => setUploadModal(null)}
          onConfirm={handleConfirmImport}
        />
      )}
    </div>
  );
}

// ── Upload Modal ───────────────────────────────────────────────────────────────
function UploadModal({ modal, onClose, onConfirm }) {
  const { step, parseResult, errorMsg } = modal;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <h2 className="text-[15px] font-semibold text-[var(--color-text)]">
            Upload Demand Data
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-5">
          {step === "parsing" && (
            <div className="flex flex-col items-center gap-3 py-6">
              <Loader2 className="h-8 w-8 animate-spin text-[var(--nexfeed-primary)]" />
              <p className="text-[13px] text-[var(--color-text-muted)]">
                Analysing file…
              </p>
            </div>
          )}

          {step === "error" && (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <AlertCircle className="h-8 w-8 text-red-500" />
              <p className="text-[13px] font-semibold text-red-600">
                Could not import file
              </p>
              <p className="text-[12px] text-[var(--color-text-muted)]">
                {errorMsg}
              </p>
              <button
                onClick={onClose}
                className="mt-2 px-4 py-1.5 rounded-md bg-gray-100 text-[13px] text-[var(--color-text)] hover:bg-gray-200"
              >
                Close
              </button>
            </div>
          )}

          {step === "preview" && parseResult && (
            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-green-50 border border-green-200 text-[12px] text-green-700 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                File parsed successfully — ready to import.
              </div>
              <div className="space-y-2 text-[13px]">
                <PreviewRow
                  label="Format"
                  value={
                    FORMAT_LABELS[parseResult.format] || parseResult.format
                  }
                />
                <PreviewRow
                  label="SKUs detected"
                  value={parseResult.skuCount.toLocaleString()}
                />
                <PreviewRow
                  label="Demand columns"
                  value={parseResult.demandCols.length.toLocaleString()}
                />
                <PreviewRow
                  label="Total data rows"
                  value={parseResult.rowCount.toLocaleString()}
                />
              </div>
              <p className="text-[12px] text-[var(--color-text-muted)]">
                Importing will replace the current demand dataset for this
                session. The default data can be restored by clicking
                &quot;Clear uploaded data&quot;.
              </p>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={onClose}
                  className="flex-1 px-4 py-2 rounded-md border border-[var(--color-border)] text-[13px] hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={onConfirm}
                  className="flex-1 px-4 py-2 rounded-md bg-[var(--nexfeed-primary)] text-white text-[13px] font-medium hover:opacity-90"
                  data-testid="button-upload-confirm"
                >
                  Import Data
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewRow({ label, value }) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--color-border)] pb-1.5">
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <span className="font-medium text-[var(--color-text)]">{value}</span>
    </div>
  );
}

// ── Section header ─────────────────────────────────────────────────────────────
function SectionHeader({ title, sub }) {
  return (
    <div className="pt-2">
      <h2 className="text-[16px] font-semibold text-gray-900">{title}</h2>
      {sub && <p className="text-[12px] text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Monthly seasonality matrix ─────────────────────────────────────────────────
function MonthlyMatrix({ rows, onRender }) {
  useEffect(() => {
    if (onRender) onRender(rows?.length ?? 0);
  }, [rows]);
  if (!rows || rows.length === 0) return null;
  return (
    <div className="overflow-auto max-h-[65vh]">
      <table className="w-full text-[11px] border-collapse">
        <thead className="sticky top-0 z-10 bg-[var(--color-bg-secondary)]">
          <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
            <th className="px-3 py-2 border-b border-[var(--color-border)] whitespace-nowrap min-w-[90px]">
              FG Code
            </th>
            <th className="px-3 py-2 border-b border-[var(--color-border)] min-w-[160px]">
              Item Description
            </th>
            {MONTH_SHORT.map((m) => (
              <th
                key={m}
                className="px-2 py-2 border-b border-[var(--color-border)] text-center w-[52px]"
              >
                {m}
              </th>
            ))}
            <th className="px-3 py-2 border-b border-[var(--color-border)] text-center whitespace-nowrap min-w-[110px]">
              Total Annual (MT)
            </th>
            <th className="px-3 py-2 border-b border-[var(--color-border)] min-w-[160px]">
              Insight
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const rowMax = Math.max(...r.pcts);
            return (
              <tr
                key={r.fg}
                className="border-b border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)]"
                data-testid={`row-demand-matrix-${r.fg}`}
              >
                <td className="matrix-info-cell px-3 py-1.5 whitespace-nowrap bg-gray-100">
                  {r.fg}
                </td>
                <td
                  className="matrix-info-cell px-3 py-1.5 max-w-[200px] truncate bg-gray-100"
                  title={r.name}
                >
                  {r.name}
                </td>
                {r.pcts.map((pct, i) => {
                  const rawMt = r.monthly[i];
                  const tip =
                    rawMt > 0
                      ? `${fmt(rawMt)} MT (${fmt(pct, 1)}% of annual demand)`
                      : "No demand";
                  return (
                    <td
                      key={i}
                      className="heatmap-cell px-1 py-1.5 text-center tabular-nums transition-colors"
                      style={heatmapStyle(pct, rowMax)}
                      title={tip}
                      data-testid={`cell-demand-${r.fg}-${MONTH_SHORT[i]}`}
                    >
                      {pct > 0 ? (
                        `${fmt(pct, 1)}%`
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                  );
                })}
                <td className="px-3 py-1.5 text-center tabular-nums font-medium">
                  {fmt(r.annualTotal)}
                </td>
                <td className="px-3 py-1.5">
                  <InsightBadge label={r.insight} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="text-center text-[11px] text-[var(--color-text-muted)] py-2 border-t border-[var(--color-border)]">
        {rows.length} SKU{rows.length !== 1 ? "s" : ""} · Hover a cell to see
        raw MT value · Colour intensity reflects share of annual demand
      </div>
    </div>
  );
}

// ── Demand table: funnel icon (matches Orders table CSS) ───────────────────────
function DemandFilterIcon() {
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

function DemandTextFilter({ label, activeFilter, onApply, onClear, onClose }) {
  const [text, setText] = useState(activeFilter?.text || "");
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <>
      <div className="filter-dropdown-header">
        <span className="filter-dropdown-title">Filter: {label}</span>
        <button className="filter-close-btn" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="filter-text-input-container">
        <input
          ref={ref}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onApply({ text });
              onClose();
            }
          }}
          placeholder={`Search ${label}…`}
          className="filter-text-input"
        />
      </div>
      <div className="filter-dropdown-footer">
        <button
          className="filter-clear-btn"
          onClick={() => {
            onClear();
            onClose();
          }}
        >
          Clear
        </button>
        <button
          className="filter-apply-btn"
          onClick={() => {
            onApply({ text });
            onClose();
          }}
        >
          Apply
        </button>
      </div>
    </>
  );
}

function DemandRangeFilter({ label, activeFilter, onApply, onClear, onClose }) {
  const [min, setMin] = useState(
    activeFilter?.min != null ? String(activeFilter.min) : "",
  );
  const [max, setMax] = useState(
    activeFilter?.max != null ? String(activeFilter.max) : "",
  );
  return (
    <>
      <div className="filter-dropdown-header">
        <span className="filter-dropdown-title">Filter: {label}</span>
        <button className="filter-close-btn" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="filter-range-inputs">
        <div className="filter-range-field">
          <label>Min</label>
          <input
            type="number"
            value={min}
            onChange={(e) => setMin(e.target.value)}
            placeholder="Min"
            className="filter-number-input"
            autoFocus
          />
        </div>
        <span className="filter-range-separator">—</span>
        <div className="filter-range-field">
          <label>Max</label>
          <input
            type="number"
            value={max}
            onChange={(e) => setMax(e.target.value)}
            placeholder="Max"
            className="filter-number-input"
          />
        </div>
      </div>
      <div className="filter-dropdown-footer">
        <button
          className="filter-clear-btn"
          onClick={() => {
            onClear();
            onClose();
          }}
        >
          Clear
        </button>
        <button
          className="filter-apply-btn"
          onClick={() => {
            onApply({
              min: min !== "" ? parseFloat(min) : null,
              max: max !== "" ? parseFloat(max) : null,
            });
            onClose();
          }}
        >
          Apply
        </button>
      </div>
    </>
  );
}

function DemandMultiFilter({
  label,
  options,
  activeFilter,
  onApply,
  onClear,
  onClose,
}) {
  const [selected, setSelected] = useState(
    () => new Set(activeFilter?.values || []),
  );
  const [srch, setSrch] = useState("");
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const visible = options.filter((o) =>
    o.toLowerCase().includes(srch.toLowerCase()),
  );
  function toggle(v) {
    const n = new Set(selected);
    n.has(v) ? n.delete(v) : n.add(v);
    setSelected(n);
  }
  return (
    <>
      <div className="filter-dropdown-header">
        <span className="filter-dropdown-title">Filter: {label}</span>
        <button className="filter-close-btn" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="filter-search">
        <input
          ref={ref}
          type="text"
          value={srch}
          onChange={(e) => setSrch(e.target.value)}
          placeholder="Search…"
          className="filter-search-input"
        />
      </div>
      <div className="filter-actions">
        <button
          className="filter-action-btn"
          onClick={() => setSelected(new Set(options))}
        >
          Select all
        </button>
        <button
          className="filter-action-btn"
          onClick={() => setSelected(new Set())}
        >
          Deselect all
        </button>
      </div>
      <div className="filter-options-list">
        {visible.map((v) => (
          <label key={v} className="filter-option">
            <input
              type="checkbox"
              checked={selected.has(v)}
              onChange={() => toggle(v)}
            />
            <span>{v}</span>
          </label>
        ))}
      </div>
      <div className="filter-dropdown-footer">
        <button
          className="filter-clear-btn"
          onClick={() => {
            onClear();
            onClose();
          }}
        >
          Clear
        </button>
        <button
          className="filter-apply-btn"
          onClick={() => {
            onApply({ values: Array.from(selected) });
            onClose();
          }}
        >
          Apply
        </button>
      </div>
    </>
  );
}

function DemandColFilterDropdown({
  colKey,
  config,
  activeFilter,
  position,
  onApply,
  onClear,
  onClose,
}) {
  const ref = useRef(null);
  useEffect(() => {
    function onMouseDown(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [onClose]);
  const style = {
    position: "fixed",
    left: Math.min(position.x, window.innerWidth - 280),
    top: Math.min(position.y + 4, window.innerHeight - 420),
    zIndex: 10000,
  };
  let content = null;
  if (config.type === "text-search")
    content = (
      <DemandTextFilter
        label={config.label}
        activeFilter={activeFilter}
        onApply={onApply}
        onClear={onClear}
        onClose={onClose}
      />
    );
  else if (config.type === "number-range")
    content = (
      <DemandRangeFilter
        label={config.label}
        activeFilter={activeFilter}
        onApply={onApply}
        onClear={onClear}
        onClose={onClose}
      />
    );
  else if (config.type === "multi-select")
    content = (
      <DemandMultiFilter
        label={config.label}
        options={config.options}
        activeFilter={activeFilter}
        onApply={onApply}
        onClear={onClear}
        onClose={onClose}
      />
    );
  if (!content) return null;
  return createPortal(
    <div
      ref={ref}
      className="filter-dropdown demand-filter-dropdown"
      style={style}
    >
      {content}
    </div>,
    document.body,
  );
}

// ── Column filter configs + helpers ────────────────────────────────────────────
const STATUS_OPTIONS = [
  "Covered",
  "Exceeds demand",
  "Near target",
  "Below target",
  "Large gap",
  "No fulfillment yet",
  "No benchmark",
];
const DEMAND_FILTER_COLS = {
  fgCode: { type: "text-search", label: "FG Code" },
  itemDesc: { type: "text-search", label: "Item Description" },
  period: { type: "text-search", label: "Period" },
  demand: { type: "number-range", label: "Demand (MT)" },
  fulfilled: { type: "number-range", label: "Done (MT)" },
  pipeline: { type: "number-range", label: "Plotted (MT)" },
  gap: { type: "number-range", label: "Gap (MT)" },
  coverage: { type: "number-range", label: "Completion (%)" },
  status: { type: "multi-select", label: "Status", options: STATUS_OPTIONS },
};
function _demandRowStr(r, col, grain) {
  switch (col) {
    case "fgCode":
      return r.fg || "";
    case "itemDesc":
      return r.name || "";
    case "period":
      return periodLabel(r.period, grain);
    case "status":
      return r.insightLabel || "";
    default:
      return "";
  }
}
function _demandRowNum(r, col) {
  switch (col) {
    case "demand":
      return r.demand ?? 0;
    case "fulfilled":
      return r.fulfilled ?? 0;
    case "pipeline":
      return r.pipeline ?? 0;
    case "gap":
      return r.gap ?? 0;
    case "coverage":
      return r.coverage ?? 0;
    default:
      return 0;
  }
}
function _isColFilterActive(f) {
  if (!f) return false;
  if (f.text) return true;
  if (f.values && f.values.length > 0) return true;
  if (f.min != null || f.max != null) return true;
  return false;
}

// ── Flat table ─────────────────────────────────────────────────────────────────
// ── Smart Demand forecast ─────────────────────────────────────────────────
// Weighted-average with recency bias + modest trend adjustment.
// allRows: [period, fg, qty][]  (full multi-year dataset, not filtered)
function calculateSmartDemand(fg, period, grain, allRows) {
  const fgRecords = allRows.filter(([, f]) => f === fg);
  if (fgRecords.length === 0) return 0;

  let candidates;
  if (grain === "monthly" && period.length >= 7) {
    const targetMonth = period.slice(5, 7);
    const sameMonth = fgRecords.filter(([p]) => p.slice(5, 7) === targetMonth);
    candidates = sameMonth.length >= 1 ? sameMonth : fgRecords;
  } else if (grain === "quarterly" && period.length >= 6) {
    const targetQ = period.slice(5);
    const sameQ = fgRecords.filter(([p]) => p.slice(5) === targetQ);
    candidates = sameQ.length >= 1 ? sameQ : fgRecords;
  } else {
    candidates = fgRecords;
  }

  candidates = [...candidates].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  );
  const n = candidates.length;
  if (n === 0) return 0;
  if (n === 1) return Math.max(0, candidates[0][2]);

  // Linearly increasing weights so most-recent year has highest influence
  const totalWeight = (n * (n + 1)) / 2;
  let weightedSum = 0;
  for (let i = 0; i < n; i++) {
    weightedSum += ((i + 1) / totalWeight) * candidates[i][2];
  }

  // Modest trend adjustment (≥3 data points only, capped at ±20%)
  if (n >= 3) {
    const half = Math.floor(n / 2);
    const avgOld =
      candidates.slice(0, half).reduce((s, [, , q]) => s + q, 0) / half;
    const avgNew =
      candidates.slice(n - half).reduce((s, [, , q]) => s + q, 0) / half;
    if (avgOld > 0) {
      const trend = Math.max(-0.2, Math.min(0.2, (avgNew - avgOld) / avgOld));
      weightedSum *= 1 + trend * 0.5;
    }
  }

  return Math.max(0, weightedSum);
}

function FlatTable({ rows, grain, kbRecords = [], allRows = [], smartDemandAiMap = null, smartDemandAiLoading = false, onRegenerateSmartDemand, onRender }) {
  const kbByCode = useMemo(() => {
    const m = {};
    for (const r of kbRecords) {
      if (r.fg_material_code) m[String(r.fg_material_code).trim()] = r;
    }
    return m;
  }, [kbRecords]);
  const [colFilters, setColFilters] = useState({});
  const [openDrop, setOpenDrop] = useState(null); // { col, x, y }
  const [sort, setSort] = useState({ col: "gap", dir: "desc" });
  const [demoModal, setDemoModal] = useState(null); // { fg, name, volumeToProcess }
  const [successToast, setSuccessToast] = useState(false);

  useEffect(() => {
    console.debug("[Demand Table Header Filter UI]", {
      filterMode: "funnel_icon",
      enabledColumns: [
        "fgCode",
        "itemDescription",
        "period",
        "demandMT",
        "doneMT",
        "plottedMT",
        "gapMT",
        "coveragePct",
        "status",
      ],
    });
  }, []);

  useEffect(() => {
    if (onRender) onRender(rows.length);
  }, [rows]);

  const openFilter = (col, e) => {
    e.stopPropagation();
    if (openDrop?.col === col) {
      setOpenDrop(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    setOpenDrop({ col, x: rect.left, y: rect.bottom });
  };
  const applyFilter = (col, f) =>
    setColFilters((prev) => ({ ...prev, [col]: f }));
  const clearFilter = (col) =>
    setColFilters((prev) => {
      const n = { ...prev };
      delete n[col];
      return n;
    });
  const toggleSort = (col) =>
    setSort((prev) =>
      prev.col === col
        ? { col, dir: prev.dir === "desc" ? "asc" : "desc" }
        : { col, dir: "desc" },
    );

  const filtered = useMemo(() => {
    const active = Object.entries(colFilters).filter(([, f]) =>
      _isColFilterActive(f),
    );
    if (active.length === 0) return rows;
    return rows.filter((r) => {
      for (const [col, f] of active) {
        const cfg = DEMAND_FILTER_COLS[col];
        if (!cfg) continue;
        if (cfg.type === "text-search") {
          if (
            f.text &&
            !_demandRowStr(r, col, grain)
              .toLowerCase()
              .includes(f.text.toLowerCase())
          )
            return false;
        } else if (cfg.type === "number-range") {
          const n = _demandRowNum(r, col);
          if (f.min != null && n < f.min) return false;
          if (f.max != null && n > f.max) return false;
        } else if (cfg.type === "multi-select") {
          if (
            f.values &&
            f.values.length > 0 &&
            !f.values.includes(_demandRowStr(r, col, grain))
          )
            return false;
        }
      }
      return true;
    });
  }, [rows, colFilters, grain]);

  const getSortVal = (r, col) => {
    if (
      col === "daily" ||
      col === "onHand" ||
      col === "capacity" ||
      col === "daysCovered" ||
      col === "leadTime"
    ) {
      return deriveOpsMetrics(r)[col];
    }
    if (col === "threshold") {
      const { leadTime } = deriveOpsMetrics(r);
      return leadTime != null ? leadTime + 12 : null;
    }
    if (col === "reorder") {
      const { daysCovered, leadTime } = deriveOpsMetrics(r);
      const threshold = leadTime != null ? leadTime + 12 : null;
      if (daysCovered == null || threshold == null) return null;
      return daysCovered <= threshold / 24 ? 1 : 0; // 1=Yes(higher), 0=No(lower)
    }
    if (col === "volumeToProcess") {
      const { daily } = deriveOpsMetrics(r);
      return daily > 0 ? daily * 5 : null;
    }
    if (col === "smartDemand") {
      return smartDemandAiMap?.get(`${r.fg}__${r.period}`) ?? 0;
    }
    return r[col];
  };

  const visible = useMemo(() => {
    if (!sort.col) return filtered;
    return [...filtered].sort((a, b) => {
      const va =
        getSortVal(a, sort.col) ?? (sort.dir === "asc" ? Infinity : -Infinity);
      const vb =
        getSortVal(b, sort.col) ?? (sort.dir === "asc" ? Infinity : -Infinity);
      return sort.dir === "asc" ? va - vb : vb - va;
    });
  }, [filtered, sort]);

  const FBtn = ({ col }) => {
    const active = _isColFilterActive(colFilters[col]);
    return (
      <button
        className={`filter-icon-btn${active ? " active" : ""}`}
        style={{ marginLeft: 4, flexShrink: 0 }}
        onClick={(e) => openFilter(col, e)}
        data-testid={`filter-btn-${col}`}
      >
        <DemandFilterIcon />
      </button>
    );
  };

  const SortIcon = ({ col }) => {
    if (sort.col !== col)
      return (
        <span className="ml-1 text-gray-300 select-none text-[10px]">⇅</span>
      );
    return (
      <span
        className="ml-1 select-none text-[10px]"
        style={{ color: "var(--nexfeed-primary)" }}
      >
        {sort.dir === "asc" ? "↑" : "↓"}
      </span>
    );
  };

  // Sticky column widths — must match exactly between <th> and <td>
  const W_FG = 130; // px — wide enough for 13-digit FG codes at 10px font
  const W_DESC = 220; // px — Item Description column width

  const thBase =
    "px-3 py-2 border-b border-[var(--color-border)] text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] whitespace-nowrap bg-white";
  const thT = thBase;
  const thC = `${thBase} text-center`;

  // Sticky header cells — gray-50 shading; z-30 keeps them above body sticky cells
  const thSticky1 =
    "th-sticky-col px-3 py-2 border-b border-[var(--color-border)] text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] whitespace-nowrap bg-gray-50 sticky left-0 z-30";
  const thSticky2 =
    "th-sticky-col px-3 py-2 border-b border-[var(--color-border)] text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] whitespace-nowrap bg-gray-50 sticky z-30";

  // Sticky body cells — td-sticky-col class lets CSS keep them opaque in dark mode
  const tdSticky1 =
    "td-sticky-col px-3 py-2 text-[10px] sticky left-0 z-10 bg-gray-50 border-r border-[var(--color-border)] overflow-hidden whitespace-nowrap";
  const tdSticky2 =
    "td-sticky-col px-3 py-2 sticky z-10 bg-gray-50 border-r border-[var(--color-border)] overflow-hidden";

  // Coloured header styles
  const thBlue = { backgroundColor: "#eff6ff", color: "#1d4ed8" };
  const thRed = { backgroundColor: "#fef2f2", color: "#b91c1c" };
  const thGreen = { backgroundColor: "#f0fdf4", color: "#15803d" };
  const thAmber = { backgroundColor: "#fffbeb", color: "#b45309" };


  return (
    <div className="overflow-auto max-h-[65vh]">
      <table className="text-[11px] border-separate border-spacing-0">
        <thead className="sticky top-0 z-20">
          <tr>
            {/* ── Frozen columns ── */}
            <th className={thSticky1} style={{ minWidth: W_FG, width: W_FG }}>
              <span className="flex items-center gap-0.5">
                FG Code
                <FBtn col="fgCode" />
              </span>
            </th>
            <th
              className={thSticky2}
              style={{ minWidth: W_DESC, width: W_DESC, left: W_FG }}
            >
              <span className="flex items-center gap-0.5">
                Item Description
                <FBtn col="itemDesc" />
              </span>
            </th>
            {/* ── Scrollable columns ── */}
            <th className={thC}>
              <span className="flex items-center justify-center gap-0.5">
                Date
                <FBtn col="period" />
              </span>
            </th>
            <th className={thC}>
              <span
                className="flex items-center justify-center gap-0.5 cursor-pointer select-none hover:text-[var(--color-text)]"
                onClick={() => toggleSort("capacity")}
              >
                Capacity (MT/hr)
                <SortIcon col="capacity" />
              </span>
            </th>
            <th className={`${thC} th-accent-blue`} style={thBlue}>
              <span className="flex items-center justify-center gap-0.5">
                <span
                  className="cursor-pointer select-none"
                  onClick={() => toggleSort("demand")}
                >
                  Historical Demand (MT)
                  <SortIcon col="demand" />
                </span>
                <FBtn col="demand" />
              </span>
            </th>
            <th
              className={`${thC} th-accent-blue`}
              style={{ backgroundColor: "#eef2ff", color: "#4338ca" }}
              title="AI-weighted forecast using all available historical years for this SKU"
            >
              <span className="flex items-center justify-center gap-1">
                {onRegenerateSmartDemand && (
                  <button
                    data-testid="button-regenerate-smart-demand"
                    onClick={(e) => { e.stopPropagation(); onRegenerateSmartDemand(); }}
                    disabled={smartDemandAiLoading}
                    title="Regenerate Smart Demand forecasts from AI (bypasses cache)"
                    className="p-0.5 rounded text-indigo-400 hover:text-indigo-600 hover:bg-indigo-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <RefreshCw style={{ width: 11, height: 11 }} className={smartDemandAiLoading ? "animate-spin" : ""} />
                  </button>
                )}
                <span
                  className="flex items-center justify-center gap-0.5 cursor-pointer select-none"
                  onClick={() => toggleSort("smartDemand")}
                >
                  Smart Demand (MT)
                  <SortIcon col="smartDemand" />
                </span>
              </span>
            </th>
            <th className={thC} style={{ color: "#1d4ed8" }} title="Historical Demand ÷ 30 days">
              <span
                className="flex items-center justify-center gap-0.5 cursor-pointer select-none"
                onClick={() => toggleSort("daily")}
              >
                Daily Demand (MT)
                <SortIcon col="daily" />
              </span>
            </th>
            <th className={thC}>
              <span className="flex items-center justify-center gap-0.5">
                <span
                  className="cursor-pointer select-none hover:text-[var(--color-text)]"
                  onClick={() => toggleSort("fulfilled")}
                >
                  Delivered to Date
                  <SortIcon col="fulfilled" />
                </span>
                <FBtn col="fulfilled" />
              </span>
            </th>
            <th className={thC}>
              <span className="flex items-center justify-center gap-0.5">
                <span
                  className="cursor-pointer select-none hover:text-[var(--color-text)]"
                  onClick={() => toggleSort("pipeline")}
                >
                  Lined-up (MT)
                  <SortIcon col="pipeline" />
                </span>
                <FBtn col="pipeline" />
              </span>
            </th>
            <th className={thC} title="Delivered to Date + Lined-up (MT)">
              <span
                className="flex items-center justify-center gap-0.5 cursor-pointer select-none hover:text-[var(--color-text)]"
                onClick={() => toggleSort("onHand")}
              >
                On-hand (MT)
                <SortIcon col="onHand" />
              </span>
            </th>
            <th className={`${thC} th-accent-red`} style={thRed} title="max(0, Historical Demand − On-hand)">
              <span className="flex items-center justify-center gap-0.5">
                <span
                  className="cursor-pointer select-none"
                  onClick={() => toggleSort("gap")}
                >
                  To be accounted for
                  <SortIcon col="gap" />
                </span>
                <FBtn col="gap" />
              </span>
            </th>
            <th className={thC} title="On-hand ÷ Daily Demand">
              <span
                className="flex items-center justify-center gap-0.5 cursor-pointer select-none hover:text-[var(--color-text)]"
                onClick={() => toggleSort("daysCovered")}
              >
                Days Covered
                <SortIcon col="daysCovered" />
              </span>
            </th>
            <th className={thC} title="Daily Demand ÷ Capacity (MT/hr)">
              <span
                className="flex items-center justify-center gap-0.5 cursor-pointer select-none hover:text-[var(--color-text)]"
                onClick={() => toggleSort("leadTime")}
              >
                Lead Time (hr)
                <SortIcon col="leadTime" />
              </span>
            </th>
            <th className={thC} title="Lead Time + 12 hrs (safety buffer)">
              <span
                className="flex items-center justify-center gap-0.5 cursor-pointer select-none hover:text-[var(--color-text)]"
                onClick={() => toggleSort("threshold")}
              >
                Threshold (hr)
                <SortIcon col="threshold" />
              </span>
            </th>
            <th className={`${thC} th-accent-amber`} style={thAmber} title="Yes when Days Covered ≤ Threshold ÷ 24">
              <span
                className="flex items-center justify-center gap-0.5 cursor-pointer select-none"
                onClick={() => toggleSort("reorder")}
              >
                Re-order
                <SortIcon col="reorder" />
              </span>
            </th>
            <th className={`${thC} th-accent-blue`} style={thBlue} title="Daily Demand × 5 days">
              <span
                className="flex items-center justify-center gap-0.5 cursor-pointer select-none"
                onClick={() => toggleSort("volumeToProcess")}
              >
                Volume to Process (MT)
                <SortIcon col="volumeToProcess" />
              </span>
            </th>
            <th className={`${thC} th-accent-green`} style={thGreen} title="(Delivered to Date + Lined-up) ÷ Historical Demand × 100">
              <span className="flex items-center justify-center gap-0.5">
                <span
                  className="cursor-pointer select-none"
                  onClick={() => toggleSort("coverage")}
                >
                  Completion (%)
                  <SortIcon col="coverage" />
                </span>
                <FBtn col="coverage" />
              </span>
            </th>
            <th className={thT}>
              <span className="flex items-center gap-0.5">
                Status
                <FBtn col="status" />
              </span>
            </th>
            <th className={thC}>
              <span className="flex items-center justify-center gap-0.5">
                Action
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.slice(0, 500).map((r, i) => {
            const m = deriveOpsMetrics(r);
            return (
              <tr
                key={`${r.fg}-${r.period}-${i}`}
                className="demand-data-row border-b border-[var(--color-border)]"
                data-testid={`row-demand-${r.fg}-${r.period}`}
              >
                {/* ── Frozen cells ── */}
                <td
                  className={tdSticky1}
                  style={{ minWidth: W_FG, width: W_FG }}
                >
                  {r.fg}
                </td>
                <td
                  className={tdSticky2}
                  style={{ minWidth: W_DESC, width: W_DESC, left: W_FG }}
                >
                  {r.name}
                </td>
                {/* ── Scrollable cells ── */}
                <td className="px-3 py-2 text-center whitespace-nowrap">
                  {periodLabel(r.period, grain)}
                </td>
                <td
                  className="px-3 py-2 text-center tabular-nums text-gray-400"
                  data-testid={`cell-capacity-${r.fg}-${r.period}`}
                >
                  {fmt(m.capacity, 0)}
                </td>
                <td className="px-3 py-2 text-center tabular-nums">
                  {fmt(r.demand)}
                </td>
                <td
                  className="px-3 py-2 text-center tabular-nums"
                  style={{ color: "#4338ca" }}
                  data-testid={`cell-smartdemand-${r.fg}-${r.period}`}
                >
                  {smartDemandAiLoading ? (
                    <span className="text-indigo-300 tracking-widest">···</span>
                  ) : (() => {
                    const sd = smartDemandAiMap?.get(`${r.fg}__${r.period}`);
                    return sd != null && sd > 0 ? (
                      fmt(sd)
                    ) : (
                      <span className="text-gray-300">—</span>
                    );
                  })()}
                </td>
                <td
                  className="px-3 py-2 text-center tabular-nums"
                  data-testid={`cell-daily-${r.fg}-${r.period}`}
                  title={`Daily Demand: ${fmt(Number(r.demand), 1)} ÷ 30 days`}
                >
                  {m.daily > 0 ? (
                    fmt(m.daily, 2)
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-center tabular-nums text-green-700">
                  {r.fulfilled > 0 ? (
                    fmt(r.fulfilled)
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-center tabular-nums text-blue-700">
                  {r.pipeline > 0 ? (
                    fmt(r.pipeline)
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                <td
                  className="px-3 py-2 text-center tabular-nums"
                  data-testid={`cell-onhand-${r.fg}-${r.period}`}
                  title={`On-hand: ${fmt(Number(r.fulfilled), 1)} (Delivered) + ${fmt(Number(r.pipeline), 1)} (Lined-up)`}
                >
                  {m.onHand > 0 ? (
                    fmt(m.onHand)
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                <td
                  className="px-3 py-2 text-center tabular-nums"
                  title={`To be accounted for: max(0, ${fmt(Number(r.demand), 1)} − ${fmt(m.onHand, 1)})`}
                >
                  {r.gap > 0 ? (
                    <span className="text-red-600 font-medium">
                      {fmt(r.gap)}
                    </span>
                  ) : (
                    <span className="text-green-600">—</span>
                  )}
                </td>
                <td
                  className="px-3 py-2 text-center tabular-nums"
                  data-testid={`cell-dayscovered-${r.fg}-${r.period}`}
                  title={m.daily > 0 ? `Days Covered: ${fmt(m.onHand, 1)} ÷ ${fmt(m.daily, 1)} daily` : undefined}
                >
                  {m.daysCovered == null ? (
                    <span className="text-gray-300">—</span>
                  ) : (
                    fmt(m.daysCovered, 1)
                  )}
                </td>
                <td
                  className="px-3 py-2 text-center tabular-nums"
                  data-testid={`cell-leadtime-${r.fg}-${r.period}`}
                  title={m.capacity > 0 ? `Lead Time: ${fmt(m.daily, 1)} daily ÷ ${fmt(m.capacity, 0)} MT/hr` : undefined}
                >
                  {m.leadTime == null ? (
                    <span className="text-gray-300">—</span>
                  ) : (
                    fmt(m.leadTime, 2)
                  )}
                </td>
                {/* ── Threshold / Re-order / Volume to Process ── */}
                {(() => {
                  const threshold = m.leadTime != null ? m.leadTime + 12 : null;
                  const reorder =
                    m.daysCovered != null && threshold != null
                      ? m.daysCovered <= threshold / 24
                      : null;
                  const volumeToProcess = m.daily > 0 ? m.daily * 5 : null;
                  return (
                    <>
                      <td
                        className="px-3 py-2 text-center tabular-nums"
                        title={m.leadTime != null ? `Threshold: ${fmt(m.leadTime, 1)} hr lead time + 12 hr buffer` : undefined}
                      >
                        {threshold == null ? (
                          <span className="text-gray-300">—</span>
                        ) : (
                          fmt(threshold, 2)
                        )}
                      </td>
                      <td
                        className="px-3 py-2 text-center"
                        title={m.daysCovered != null && threshold != null ? `Re-order: Days Covered (${fmt(m.daysCovered, 1)}) ≤ Threshold in days (${fmt(threshold / 24, 2)})?` : undefined}
                      >
                        {reorder === null ? (
                          <span className="text-gray-300">—</span>
                        ) : reorder ? (
                          <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-700 border border-red-200">
                            Yes
                          </span>
                        ) : (
                          <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700 border border-green-200">
                            No
                          </span>
                        )}
                      </td>
                      <td
                        className="px-3 py-2 text-center tabular-nums"
                        title={m.daily > 0 ? `Volume to Process: ${fmt(m.daily, 1)} daily × 5 days` : undefined}
                      >
                        {volumeToProcess == null ? (
                          <span className="text-gray-300">—</span>
                        ) : (
                          fmt(volumeToProcess, 2)
                        )}
                      </td>
                      <td
                        className="px-3 py-2 text-center tabular-nums"
                        title={Number(r.demand) > 0 ? `Completion: (${fmt(Number(r.fulfilled), 1)} + ${fmt(Number(r.pipeline), 1)}) ÷ ${fmt(Number(r.demand), 1)} × 100` : undefined}
                      >
                        {r.coverage == null ? "—" : `${fmt(r.coverage, 0)}%`}
                      </td>
                      <td className="px-3 py-2">
                        <InsightBadge label={r.insightLabel} cls={r.insightCls} />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          disabled={!reorder}
                          onClick={() =>
                            reorder &&
                            setDemoModal({
                              fg: r.fg,
                              name: r.name,
                              volumeToProcess:
                                volumeToProcess != null && volumeToProcess > 0
                                  ? String(Number(volumeToProcess.toFixed(2)))
                                  : "",
                              product: kbByCode[String(r.fg).trim()] || null,
                            })
                          }
                          className={`px-2 py-1 rounded text-[10px] font-medium transition-colors whitespace-nowrap ${
                            reorder
                              ? "bg-[var(--nexfeed-primary)] text-white hover:opacity-90 cursor-pointer"
                              : "bg-gray-100 text-gray-400 cursor-not-allowed"
                          }`}
                          data-testid={`btn-create-order-${r.fg}-${r.period}`}
                        >
                          Create Order
                        </button>
                      </td>
                    </>
                  );
                })()}
              </tr>
            );
          })}
        </tbody>
      </table>
      {openDrop && DEMAND_FILTER_COLS[openDrop.col] && (
        <DemandColFilterDropdown
          colKey={openDrop.col}
          config={DEMAND_FILTER_COLS[openDrop.col]}
          activeFilter={colFilters[openDrop.col]}
          position={{ x: openDrop.x, y: openDrop.y }}
          onApply={(f) => {
            applyFilter(openDrop.col, f);
            setOpenDrop(null);
          }}
          onClear={() => {
            clearFilter(openDrop.col);
            setOpenDrop(null);
          }}
          onClose={() => setOpenDrop(null)}
        />
      )}
      {visible.length === 0 && rows.length > 0 && (
        <div className="text-center text-[12px] text-[var(--color-text-muted)] py-8 italic">
          No rows match the current column filters.
        </div>
      )}
      {visible.length > 500 && (
        <div className="text-center text-[11px] text-[var(--color-text-muted)] py-2 italic">
          Showing first 500 of {fmt(visible.length, 0)} rows — narrow filters to
          see more.
        </div>
      )}
      {demoModal && (
        <DemoOrderModal
          data={demoModal}
          onClose={() => setDemoModal(null)}
          onSubmitSuccess={() => {
            setDemoModal(null);
            setSuccessToast(true);
            setTimeout(() => setSuccessToast(false), 3000);
          }}
        />
      )}
      {successToast && (
        <div className="fixed bottom-6 right-6 z-[60] flex items-center gap-2.5 bg-gray-900 text-white px-4 py-3 rounded-lg shadow-xl text-[12px] font-medium animate-in slide-in-from-bottom-2">
          <span className="text-green-400 text-[15px]">✓</span>
          Demo order submitted — not saved to any order table.
        </div>
      )}
    </div>
  );
}

// ── Demo Create-Order Modal (mirrors AddOrderDialog, demo-only — no DB write) ─
const DEMO_BATCH_SIZE_COL = {
  'Line 1': 'batch_size_fm1', 'Line 2': 'batch_size_fm1',
  'Line 3': 'batch_size_fm2', 'Line 4': 'batch_size_fm2',
  'Line 5': 'batch_size_pmx',
  'Line 6': 'batch_size_fm3', 'Line 7': 'batch_size_fm3',
};
const DEMO_RUN_RATE_COL = {
  'Line 1': 'line_1_run_rate', 'Line 2': 'line_2_run_rate',
  'Line 3': 'line_3_run_rate', 'Line 4': 'line_4_run_rate',
  'Line 5': 'line_5_run_rate',
  'Line 6': 'line_6_run_rate', 'Line 7': 'line_7_run_rate',
};
const DEMO_ALL_LINES = ['Line 1', 'Line 2', 'Line 3', 'Line 4', 'Line 5', 'Line 6', 'Line 7'];
const DEMO_IS = {
  width: '100%', height: 40, padding: '0 12px', border: '1px solid #d1d5db',
  borderRadius: 6, fontSize: 14, color: '#2e343a', outline: 'none', background: 'white',
  boxSizing: 'border-box',
};
const DEMO_RO = {
  height: 40, padding: '0 12px', border: '1px solid #e5e7eb', borderRadius: 6,
  display: 'flex', alignItems: 'center', background: 'var(--color-bg-tertiary, #f9fafb)',
};

function DemoSection({ title, children }) {
  return (
    <div style={{ border: '1px solid #f3f4f6', borderRadius: 8, padding: 16 }}>
      <h3 style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>{title}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
    </div>
  );
}

function DemoField({ label, required, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>
        {label}{required && <span style={{ color: '#f87171', marginLeft: 2 }}>*</span>}
      </label>
      {children}
    </div>
  );
}

function validate7D(val) {
  if (!val) return '';
  return /^\d{7}$/.test(val) ? '' : 'Must be exactly 7 digits';
}

function DemoOrderModal({ data, onClose, onSubmitSuccess }) {
  const product = data.product || null;

  const [fpr, setFpr] = useState(() => {
    const d = new Date();
    return `${String(d.getDate()).padStart(2,'0')}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getFullYear()).slice(-2)}`;
  });
  const [volume, setVolume] = useState(data.volumeToProcess || "");
  const [line, setLine] = useState('');
  const [availType, setAvailType] = useState('');
  const [availDate, setAvailDate] = useState('');
  const [customAvail, setCustomAvail] = useState('');
  const [fg, setFg] = useState('');
  const [sfg, setSfg] = useState('');
  const [pmx, setPmx] = useState('');
  const [fgError, setFgError] = useState('');
  const [sfgError, setSfgError] = useState('');
  const [pmxError, setPmxError] = useState('');

  // Auto-select best line based on product run rates
  useEffect(() => {
    if (!product) return;
    const rates = {};
    for (const [l, col] of Object.entries(DEMO_RUN_RATE_COL)) {
      const v = parseFloat(product[col]);
      if (v > 0) rates[l] = v;
    }
    const best = Object.entries(rates).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (best) setLine(best);
  }, [product]);

  // Clear PMX when not Line 5
  useEffect(() => { if (line !== 'Line 5') { setPmx(''); setPmxError(''); } }, [line]);

  const runRateInfo = useMemo(() => {
    if (!product) return {};
    const r = {};
    for (const [l, col] of Object.entries(DEMO_RUN_RATE_COL)) {
      const v = parseFloat(product[col]);
      if (v > 0) r[l] = v;
    }
    return r;
  }, [product]);

  const batchSize = useMemo(() => {
    if (!product || !line) return null;
    const key = DEMO_BATCH_SIZE_COL[line];
    if (!key) return null;
    const val = product[key];
    return (val != null && val !== '') ? parseFloat(val) : null;
  }, [product, line]);

  const vol = parseFloat(volume) || 0;
  const bs = batchSize || 4;
  const batches = vol > 0 ? Math.ceil(vol / bs) : 0;
  const runRate = runRateInfo[line] ?? null;
  const prodTime = vol > 0 && runRate ? (vol / runRate) : null;
  const changeover = product?.changeover != null && product.changeover !== ''
    ? (parseFloat(product.changeover) || 0.17)
    : (product ? 0.17 : null);

  const availValue = (() => {
    if (availType === 'date') return availDate || null;
    if (availType === 'prio replenish') return 'prio replenish';
    if (availType === 'safety stocks') return 'safety stocks';
    if (availType === 'for re-order') return 'for re-order';
    if (availType === 'custom') return customAvail || null;
    return null;
  })();

  const isComplete = !!(data.name && vol > 0 && line && availValue);

  // Lines with any run rate for this product
  const linesWithRate = Object.keys(runRateInfo);
  const allWithRate = Object.entries(runRateInfo).sort((a, b) => b[1] - a[1]);
  const bestRate = allWithRate[0]?.[1];
  const bestLines = allWithRate.filter(([, r]) => r === bestRate).map(([l]) => l);

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="dialog-demo-create-order"
    >
      <div
        style={{ background: 'white', borderRadius: 12, boxShadow: '0 24px 64px rgba(0,0,0,0.18)', width: '100%', maxWidth: 600, maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '22px 28px 16px', borderBottom: '1px solid #f3f4f6', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1a1a1a', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Plus style={{ width: 18, height: 18, color: 'var(--nexfeed-primary)' }} />
                Add New Order
              </h2>
              <p style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>Manually create a new production order</p>
            </div>
            <button onClick={onClose} style={{ color: '#9ca3af', cursor: 'pointer', background: 'none', border: 'none', padding: 4 }} data-testid="btn-demo-modal-close">
              <X style={{ width: 16, height: 16 }} />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Demo disclaimer */}
          <div style={{ padding: '10px 14px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <AlertCircle style={{ width: 14, height: 14, color: '#d97706', marginTop: 1, flexShrink: 0 }} />
            <p style={{ fontSize: 12, color: '#92400e', fontWeight: 500, margin: 0, lineHeight: 1.4 }}>
              Demo only — this order will not be saved.
            </p>
          </div>

          {/* ORDER DETAILS */}
          <DemoSection title="Order Details">
            <DemoField label="FPR">
              <input type="text" style={DEMO_IS} value={fpr} onChange={e => setFpr(e.target.value)} data-testid="input-demo-fpr" />
            </DemoField>

            <DemoField label="Item Description" required>
              <div style={{ position: 'relative' }}>
                <div style={{ ...DEMO_IS, display: 'flex', alignItems: 'center', background: 'var(--color-bg-tertiary, #f9fafb)', paddingRight: 32, overflow: 'hidden' }} title={data.name}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.name}</span>
                </div>
              </div>
            </DemoField>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <DemoField label="Material Code (FG)">
                <div style={{ ...DEMO_RO, background: 'var(--color-bg-tertiary, #f9fafb)' }}>
                  <span style={{ fontSize: 14, color: '#2e343a' }}>{data.fg}</span>
                </div>
              </DemoField>
              <DemoField label="Form">
                <div style={DEMO_RO}>
                  {product?.form
                    ? <span style={{ fontSize: 14, color: '#2e343a' }}>{product.form}</span>
                    : <span style={{ fontSize: 14, color: '#9ca3af', fontStyle: 'italic' }}>Auto-populated</span>
                  }
                </div>
              </DemoField>
            </div>
          </DemoSection>

          {/* PRODUCTION PARAMETERS */}
          <DemoSection title="Production Parameters">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', rowGap: 16, columnGap: 16 }}>
              {/* Volume */}
              <div>
                <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>
                  Volume (MT)<span style={{ color: '#f87171', marginLeft: 2 }}>*</span>
                </label>
                <input type="number" min="0" step="any" style={DEMO_IS} placeholder="Enter volume..." value={volume} onChange={e => setVolume(e.target.value)} data-testid="input-demo-volume" />
              </div>
              {/* Batch Size */}
              <div>
                <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Batch Size</label>
                <div style={DEMO_RO}>
                  {batchSize != null ? <span style={{ fontSize: 14, color: '#1a1a1a' }}>{batchSize.toFixed(2)}</span> : null}
                </div>
              </div>
              {/* Batches */}
              <div>
                <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Batches</label>
                <div style={DEMO_RO}>
                  {batches > 0 ? <span style={{ fontSize: 14, color: '#1a1a1a' }}>{batches}</span> : null}
                </div>
              </div>
              {/* Production Time */}
              <div>
                <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Production Time</label>
                <div style={DEMO_RO}>
                  {prodTime != null
                    ? <span style={{ fontSize: 14, color: '#1a1a1a' }}>{prodTime.toFixed(2)} hrs</span>
                    : (vol > 0 && line ? <span style={{ fontSize: 14, color: '#9ca3af' }}>—</span> : null)}
                </div>
              </div>
              {/* Changeover */}
              <div>
                <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Changeover</label>
                <div style={DEMO_RO}>
                  {changeover != null ? <span style={{ fontSize: 14, color: '#1a1a1a' }}>{changeover} hrs</span> : null}
                </div>
              </div>
              {/* Run Rate */}
              <div>
                <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Run Rate</label>
                <div style={DEMO_RO}>
                  {runRate != null
                    ? <span style={{ fontSize: 14, color: '#1a1a1a' }}>{runRate.toFixed(2)} MT/hr</span>
                    : (line ? <span style={{ fontSize: 14, color: '#9ca3af' }}>—</span> : null)}
                </div>
              </div>
            </div>
          </DemoSection>

          {/* SCHEDULING */}
          <DemoSection title="Scheduling">
            <DemoField label="Line" required>
              <select
                style={{ ...DEMO_IS, appearance: 'auto' }}
                value={line}
                onChange={e => setLine(e.target.value)}
                data-testid="select-demo-line"
              >
                <option value="">Select line...</option>
                {DEMO_ALL_LINES.map(l => <option key={l} value={l}>{l}</option>)}
              </select>

              {/* Line recommendation box */}
              {product && allWithRate.length > 0 && (
                <div style={{ marginTop: 8, background: line && bestLines.includes(line) ? '#eff6ff' : '#f9fafb', border: `1px solid ${line && bestLines.includes(line) ? '#bfdbfe' : '#e5e7eb'}`, borderRadius: 8, padding: '10px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12, color: '#3b82f6' }}>ℹ</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#1e40af' }}>
                      Recommended: {bestLines.join(' / ')} (rate: {(60 / bestRate).toFixed(2)} min/batch)
                    </span>
                    {line && bestLines.includes(line) && (
                      <span style={{ fontSize: 11, color: '#16a34a', marginLeft: 2 }}>✓</span>
                    )}
                  </div>
                  {allWithRate.length > bestLines.length && (
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3 }}>
                      Also available: {allWithRate.filter(([l]) => !bestLines.includes(l)).slice(0, 3).map(([l, r]) => `${l} (${(60/r).toFixed(2)} min/batch)`).join(', ')}
                    </div>
                  )}
                </div>
              )}
              {product && linesWithRate.length === 0 && (
                <div style={{ marginTop: 8, background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#92400e' }}>
                  No production history found on any line. Run rate will need to be manually configured.
                </div>
              )}
            </DemoField>

            <DemoField label="Availability" required>
              <select
                style={{ ...DEMO_IS, appearance: 'auto' }}
                value={availType}
                onChange={e => setAvailType(e.target.value)}
                data-testid="select-demo-avail"
              >
                <option value="">Select type...</option>
                <option value="date">Set specific date...</option>
                <option value="prio replenish">Prio replenish</option>
                <option value="safety stocks">Safety stocks</option>
                <option value="for re-order">For re-order</option>
                <option value="custom">Custom text...</option>
              </select>
              {availType === 'date' && (
                <input type="date" min={new Date().toISOString().slice(0,10)} style={{ ...DEMO_IS, marginTop: 8 }} value={availDate} onChange={e => setAvailDate(e.target.value)} data-testid="input-demo-avail-date" />
              )}
              {availType === 'custom' && (
                <input type="text" style={{ ...DEMO_IS, marginTop: 8 }} placeholder="Enter custom availability..." value={customAvail} onChange={e => setCustomAvail(e.target.value)} data-testid="input-demo-avail-custom" />
              )}
            </DemoField>
          </DemoSection>

          {/* PLANNED ORDERS */}
          <DemoSection title="Planned Orders (Optional)">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Finished Goods (FG)</label>
                <input
                  type="text" maxLength={7}
                  style={{ ...DEMO_IS, borderColor: fgError ? '#e53935' : '#d1d5db' }}
                  placeholder="Enter 7 digits"
                  value={fg}
                  onChange={e => { setFg(e.target.value); setFgError(validate7D(e.target.value)); }}
                  data-testid="input-demo-fg"
                />
                {fgError && <div style={{ fontSize: 10, color: '#e53935', fontStyle: 'italic', marginTop: 3 }}>{fgError}</div>}
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Semi-Finished Goods (SFG)</label>
                <input
                  type="text" maxLength={7}
                  style={{ ...DEMO_IS, borderColor: sfgError ? '#e53935' : '#d1d5db' }}
                  placeholder="Enter 7 digits"
                  value={sfg}
                  onChange={e => { setSfg(e.target.value); setSfgError(validate7D(e.target.value)); }}
                  data-testid="input-demo-sfg"
                />
                {sfgError && <div style={{ fontSize: 10, color: '#e53935', fontStyle: 'italic', marginTop: 3 }}>{sfgError}</div>}
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 5 }}>Powermix (PMX)</label>
                <input
                  type="text" maxLength={7}
                  disabled={line !== 'Line 5'}
                  title={line !== 'Line 5' ? 'Powermix is only applicable for Line 5' : undefined}
                  style={{
                    ...DEMO_IS,
                    background: line !== 'Line 5' ? '#f3f4f6' : 'white',
                    borderColor: pmxError ? '#e53935' : (line !== 'Line 5' ? '#e5e7eb' : '#d1d5db'),
                    color: line !== 'Line 5' ? '#d1d5db' : '#2e343a',
                    cursor: line !== 'Line 5' ? 'not-allowed' : 'text',
                    fontStyle: line !== 'Line 5' ? 'italic' : 'normal',
                  }}
                  placeholder={line !== 'Line 5' ? 'Line 5 only' : 'Enter 7 digits'}
                  value={pmx}
                  onChange={e => { setPmx(e.target.value); setPmxError(validate7D(e.target.value)); }}
                  data-testid="input-demo-pmx"
                />
                {pmxError && <div style={{ fontSize: 10, color: '#e53935', fontStyle: 'italic', marginTop: 3 }}>{pmxError}</div>}
              </div>
            </div>
          </DemoSection>
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 28px', borderTop: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, flexShrink: 0, background: 'white' }}>
          <button
            onClick={onClose}
            style={{ height: 40, padding: '0 20px', fontSize: 14, fontWeight: 600, borderRadius: 6, border: '1px solid #d1d5db', background: 'white', color: '#1a1a1a', cursor: 'pointer' }}
            data-testid="btn-demo-cancel"
          >
            Cancel
          </button>
          <button
            onClick={isComplete ? onSubmitSuccess : undefined}
            disabled={!isComplete}
            style={{
              height: 40, padding: '0 20px', fontSize: 14, fontWeight: 600, borderRadius: 6, border: 'none',
              background: isComplete ? 'var(--nexfeed-primary)' : '#f3f4f6',
              color: isComplete ? 'white' : '#d1d5db',
              cursor: isComplete ? 'pointer' : 'not-allowed',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
            data-testid="btn-demo-submit"
          >
            <Plus style={{ width: 14, height: 14 }} />
            Add Order
          </button>
        </div>
      </div>
    </div>
  );
}

function InsightBadge({ label, cls }) {
  const defaultCls = "bg-blue-50 text-blue-700 border border-blue-200";
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${cls || defaultCls}`}
    >
      {label}
    </span>
  );
}

function KpiCard({
  icon: Icon,
  iconBg = "bg-blue-50",
  iconColor = "text-blue-600",
  label,
  value,
  sub,
  testId,
}) {
  return (
    <Card className="border-0 shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-[12px] text-gray-500 mb-1">{label}</p>
            <p
              className="text-[24px] font-bold text-gray-900 truncate leading-tight"
              data-testid={testId}
            >
              {value}
            </p>
            {sub ? (
              <p className="text-[12px] text-gray-500 mt-0.5 truncate">{sub}</p>
            ) : null}
          </div>
          {Icon && (
            <div className={`ml-3 shrink-0 p-2.5 rounded-xl ${iconBg}`}>
              <Icon className={`h-6 w-6 ${iconColor}`} />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
