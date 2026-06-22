import * as XLSX from "xlsx";

const MONTH_SHORT_TO_NUM = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_FULL_TO_NUM = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const REQUIRED_COL_LOWER = [
  "fg material code",
  "fg item description",
  "sfg1 material code",
  "sfg item description",
];

// Parse a column header into { month, year } or null if not a demand column.
// Supports:
//   "January 2025"  (new primary format — full month + space + 4-digit year)
//   "Jan-2021"       (legacy format — short month + dash + 4-digit year)
function parseDemandColumn(header) {
  const h = header.trim();

  // "January 2025" / "FEBRUARY 2026" etc.
  const fullMonthYear = h.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (fullMonthYear) {
    const month = MONTH_FULL_TO_NUM[fullMonthYear[1].toLowerCase()];
    const year = parseInt(fullMonthYear[2], 10);
    if (month && year) return { month, year };
  }

  // "Jan-2021" / "DEC-2025" etc. (legacy)
  const shortMonthYear = h.match(/^([A-Za-z]{3})-(\d{4})$/);
  if (shortMonthYear) {
    const month = MONTH_SHORT_TO_NUM[shortMonthYear[1].toLowerCase()];
    const year = parseInt(shortMonthYear[2], 10);
    if (month && year) return { month, year };
  }

  return null;
}

export async function parseFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(ws, { defval: "" });

        if (!json.length) {
          reject(new Error("The file appears to be empty")); return;
        }

        const rawHeaders = Object.keys(json[0]);
        const lowerHeaders = rawHeaders.map((h) => h.trim().toLowerCase());

        const missing = REQUIRED_COL_LOWER.filter(
          (c) => !lowerHeaders.includes(c)
        ).map((c) =>
          c.split(" ").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")
        );
        if (missing.length) {
          reject(new Error(`Missing required columns: ${missing.join(", ")}`)); return;
        }

        // Detect demand columns — any header that parses as a month+year
        const demandCols = rawHeaders.filter((h) => parseDemandColumn(h) !== null);

        if (demandCols.length < 1) {
          reject(new Error(
            'No demand columns found. Expected columns like "January 2025" or "Jan-2025".'
          )); return;
        }

        let invalidValueCount = 0;
        for (const row of json) {
          for (const col of demandCols) {
            const v = row[col];
            if (v !== "" && v !== null && v !== undefined && isNaN(Number(v)))
              invalidValueCount++;
          }
        }

        const fgCodeKey = rawHeaders.find(
          (h) => h.trim().toLowerCase() === "fg material code"
        );
        const fgNameKey = rawHeaders.find(
          (h) => h.trim().toLowerCase() === "fg item description"
        );
        const skuSet = new Set();
        for (const row of json) {
          const fg = String(row[fgCodeKey] || "").trim();
          if (fg) skuSet.add(fg);
        }

        console.debug("[Demand Upload File Detected]", {
          fileName: file.name,
          detectedFormat: "wide_monthly",
          rowCount: json.length,
          demandColCount: demandCols.length,
        });
        console.debug("[Demand Upload Validation]", {
          missingColumns: [],
          invalidValueCount,
          canImport: true,
        });

        resolve({
          format: "wide_monthly",
          json,
          demandCols,
          fgCodeKey,
          fgNameKey,
          rowCount: json.length,
          skuCount: skuSet.size,
        });
      } catch (err) {
        reject(new Error("Failed to parse file: " + err.message));
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

export function normalizeData(parseResult) {
  const { json, demandCols, fgCodeKey, fgNameKey } = parseResult;

  const fgs = {};
  const rawRows = [];

  for (const row of json) {
    const fg = String(row[fgCodeKey] || "").trim();
    const fgName = String(row[fgNameKey] || "").trim();
    if (!fg) continue;
    fgs[fg] = fgName;

    for (const col of demandCols) {
      const qty = Number(row[col]) || 0;
      if (!qty) continue;

      const parsed = parseDemandColumn(col);
      if (!parsed) continue;
      const { month, year } = parsed;

      rawRows.push({ fg, year, month, qty });
    }
  }

  const skuCount = Object.keys(fgs).length;
  const periodCount = new Set(rawRows.map((r) => `${r.year}-${r.month}`)).size;

  console.debug("[Demand Upload Parse Result]", {
    skuCount,
    normalizedRowCount: rawRows.length,
    periodCount,
  });

  return { fgs, rawRows, skuCount, periodCount };
}
