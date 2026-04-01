import { createPortal } from "react-dom";
import { getInsightParts } from "@/utils/insightCache";

// ── Shared product tooltip for N10D and Auto-Sequence preview ─────────────────

// Center tooltip horizontally in viewport, prefer above the row then below
export function getTooltipPosition(
  rowElement,
  tooltipWidth = 480,
  tooltipHeight = 260,
) {
  const rowRect = rowElement.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pad = 16;

  // Center horizontally relative to the element
  let x = rowRect.left + rowRect.width / 2 - tooltipWidth / 2;

  // Prefer above the row
  let y = rowRect.top - tooltipHeight - 8;
  if (y < pad) y = rowRect.bottom + 8; // try below
  if (y + tooltipHeight + pad > vh) y = (vh - tooltipHeight) / 2; // center vertically

  // Clamp horizontal
  if (x < pad) x = pad;
  if (x + tooltipWidth + pad > vw) x = vw - tooltipWidth - pad;

  return { x, y };
}

export function generateProductInsight({
  dfl,
  inv,
  buffer,
  status,
  completionDate,
  availDate,
  materialCode,
}) {
  // Check template cache first (template only — no AI text in tooltip)
  if (materialCode) {
    const cached = getInsightParts(materialCode)?.templateEmoji;
    if (cached) return cached;
  }
  // Template fallback
  const dflFmt = Number(dfl).toFixed(1);
  const invFmt = Number(inv).toFixed(1);
  const bufFmt = parseFloat(buffer).toFixed(1);
  switch (status) {
    case "Critical":
      return `This product is Critical — the required volume (${dflFmt} MT DFL) already exceeds current inventory (${invFmt} MT). Immediate production is needed to prevent a stockout.`;
    case "Urgent":
      return `This product is Urgent. Cumulative demand will breach inventory by ${availDate || "the breach date"}, leaving only a ${bufFmt}% buffer. Production must be scheduled immediately to avoid a shortfall.`;
    case "Monitor":
      return `This product is on Monitor. Demand will exceed inventory by ${availDate || "the breach date"}${completionDate ? `, with ${completionDate} as the last safe production date` : ""}. The ${bufFmt}% buffer provides a window — production should be planned within the coming week.`;
    case "Sufficient":
      return `This product has sufficient stock. Current inventory (${invFmt} MT) comfortably covers the required demand window. No immediate production action is required.`;
    default:
      return "No insight available for this product.";
  }
}

export function ProductTooltipPanel({ data, position }) {
  if (!data) return null;
  const ratioNum = parseFloat(data.ratio);
  const bufferNum = parseFloat(data.buffer);
  const ratioColor =
    ratioNum > 1.0 ? "#fca5a5" : ratioNum > 0.8 ? "#fde047" : "#86efac";
  const bufferColor =
    bufferNum < 0 ? "#fca5a5" : bufferNum < 20 ? "#fde047" : "#86efac";
  const statusColor =
    {
      Critical: "#fca5a5",
      Urgent: "#fdba74",
      Monitor: "#fde047",
      Sufficient: "#86efac",
    }[data.status] || "#fff";
  const lbl = { fontSize: 11, fontWeight: 400, color: "rgba(255,255,255,0.5)" };
  const val = { fontSize: 11, fontWeight: 600, color: "#ffffff" };
  const insight = generateProductInsight(data);

  const el = (
    <div
      style={{
        position: "fixed",
        left: position.x,
        top: position.y,
        background: "#1a1a1a",
        color: "#ffffff",
        borderRadius: 10,
        boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
        minWidth: 480,
        maxWidth: 560,
        zIndex: 99999,
        pointerEvents: "none",
        animation: "n10dTipFade 0.15s ease",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <style>{`@keyframes n10dTipFade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid rgba(255,255,255,0.1)",
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        {data.name}
      </div>
      <div style={{ display: "flex", flexDirection: "row" }}>
        <div
          style={{
            flex: 1,
            padding: "12px 16px",
            borderRight: "1px solid rgba(255,255,255,0.1)",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "100px 1fr",
              rowGap: 4,
            }}
          >
            <span style={lbl}>DFL:</span>
            <span style={val}>{Number(data.dfl).toFixed(1)} MT</span>
            <span style={lbl}>Inventory:</span>
            <span style={val}>{Number(data.inv).toFixed(1)} MT</span>
            <span style={lbl}>Ratio:</span>
            <span style={{ ...val, color: ratioColor }}>{data.ratio}</span>
            <span style={lbl}>Buffer:</span>
            <span style={{ ...val, color: bufferColor }}>{data.buffer}%</span>
            <span style={lbl}>Status:</span>
            <span style={{ ...val, color: statusColor }}>{data.status}</span>
            <div
              style={{
                gridColumn: "1 / -1",
                borderTop: "1px solid rgba(255,255,255,0.08)",
                margin: "5px 0",
              }}
            />
            <span style={lbl}>Completion:</span>
            <span style={val}>{data.completionDate || "—"}</span>
            <span style={lbl}>Avail:</span>
            <span style={val}>{data.availDate || "—"}</span>
          </div>
        </div>
        <div style={{ flex: 1, padding: "12px 16px" }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "rgba(255,255,255,0.85)",
              marginBottom: 6,
            }}
          >
            Summary
          </div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 400,
              color: "rgba(255,255,255,0.7)",
              lineHeight: 1.65,
              maxHeight: 130,
              overflow: "hidden",
            }}
          >
            {insight}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(el, document.body);
}
