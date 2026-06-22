import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { MessageSquare, History, ArrowRightLeft, Undo2, XCircle, Zap } from "lucide-react";

const HIGHLIGHT_COLORS = [
  { key: null, label: "No highlight", bg: "#ffffff", border: "#d1d5db" },
  { key: "violet", label: "Violet", bg: "#7c3aed", border: "#7c3aed" },
  { key: "green", label: "Green", bg: "#16a34a", border: "#16a34a" },
  { key: "orange", label: "Orange", bg: "#ea580c", border: "#ea580c" },
];

export default function OrderContextMenu({
  x,
  y,
  order,
  columnLabel,
  currentHighlight,
  onHighlight,
  onComment,
  onViewHistory,
  onDivert,
  onRevert,
  isDivertable,
  isReverted,
  onCancelReorder = null,
  onMashShutdownDivert = null,
  mashShutdownLines = null,
  onClose,
}) {
  const menuRef = useRef(null);
  const isDark = document.documentElement.classList.contains("nexfeed-dark");

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const menuW = 220;
  const menuH = 180;
  const left = Math.min(x, vw - menuW - 8);
  const top = Math.min(y, vh - menuH - 8);

  const hoverBg = isDark ? "rgba(255,255,255,0.07)" : "#f3f4f6";
  const dividerColor = isDark ? "rgba(255,255,255,0.08)" : "#f0f0f0";

  const btnStyle = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "7px 14px",
    background: "none",
    border: "none",
    cursor: "pointer",
    fontSize: 13,
    color: "var(--color-text)",
    textAlign: "left",
  };

  return createPortal(
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        left,
        top,
        zIndex: 10000,
        width: menuW,
        background: "var(--color-bg-secondary)",
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
        padding: "6px 0",
        fontSize: 13,
        userSelect: "none",
      }}
    >
      <div
        style={{
          padding: "6px 14px 8px",
          borderBottom: `1px solid ${dividerColor}`,
          marginBottom: 4,
        }}
      >
        <div
          style={{
            fontWeight: 600,
            fontSize: 12,
            color: "var(--color-text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {order.item_description || "Order"}
        </div>
        {columnLabel && columnLabel !== "row" && (
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>
            {columnLabel}
          </div>
        )}
      </div>

      <div style={{ padding: "4px 14px 8px" }}>
        <div
          style={{
            fontSize: 11,
            color: "var(--color-text-secondary)",
            marginBottom: 7,
            fontWeight: 500,
          }}
        >
          Row Color
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {HIGHLIGHT_COLORS.map(({ key, label, bg, border }) => (
            <button
              key={String(key)}
              title={label}
              onClick={() => {
                onHighlight(key);
                onClose();
              }}
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                background: bg,
                border: `2px solid ${border}`,
                cursor: "pointer",
                outline:
                  currentHighlight === key ? "2px solid #3b82f6" : "none",
                outlineOffset: 2,
                flexShrink: 0,
                boxShadow: "0 1px 3px rgba(0,0,0,0.18)",
              }}
            />
          ))}
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${dividerColor}`, marginTop: 2 }} />

      <button
        onClick={() => {
          onComment();
          onClose();
        }}
        style={btnStyle}
        onMouseEnter={(e) => (e.currentTarget.style.background = hoverBg)}
        onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
        data-testid="ctx-menu-comment"
      >
        <MessageSquare style={{ width: 14, height: 14, color: "var(--color-text-secondary)" }} />
        Leave a comment
      </button>

      <button
        onClick={() => {
          onViewHistory();
          onClose();
        }}
        style={btnStyle}
        onMouseEnter={(e) => (e.currentTarget.style.background = hoverBg)}
        onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
        data-testid="ctx-menu-history"
      >
        <History style={{ width: 14, height: 14, color: "var(--color-text-secondary)" }} />
        View order history
      </button>

      {(isDivertable || isReverted || onMashShutdownDivert) && (
        <div style={{ borderTop: `1px solid ${dividerColor}`, marginTop: 2 }} />
      )}

      {isDivertable && (
        <button
          onClick={() => {
            onDivert && onDivert();
            onClose();
          }}
          style={{ ...btnStyle, color: isDark ? "#fbbf24" : "#b45309" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = isDark ? "rgba(251,191,36,0.1)" : "#fffbeb")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
          data-testid="ctx-menu-divert"
        >
          <ArrowRightLeft style={{ width: 14, height: 14, color: isDark ? "#fbbf24" : "#d97706" }} />
          Divert order to another line
        </button>
      )}

      {isReverted && (
        <button
          onClick={() => {
            onRevert && onRevert();
            onClose();
          }}
          style={{ ...btnStyle, color: isDark ? "#4ade80" : "#15803d" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = isDark ? "rgba(74,222,128,0.1)" : "#f0fdf4")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
          data-testid="ctx-menu-revert"
        >
          <Undo2 style={{ width: 14, height: 14, color: isDark ? "#4ade80" : "#16a34a" }} />
          Revert to original line
        </button>
      )}

      {onMashShutdownDivert && (
        <button
          onClick={() => {
            onMashShutdownDivert();
            onClose();
          }}
          style={{ ...btnStyle, color: isDark ? "#fbbf24" : "#b45309" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = isDark ? "rgba(251,191,36,0.1)" : "#fffbeb")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
          data-testid="ctx-menu-mash-shutdown-divert"
        >
          <Zap style={{ width: 14, height: 14, color: isDark ? "#fbbf24" : "#d97706" }} />
          {mashShutdownLines?.length === 1 ? `Divert Mash to ${mashShutdownLines[0]}` : 'Divert Mash to shutdown line'}
        </button>
      )}

      {onCancelReorder && (
        <>
          <div style={{ borderTop: `1px solid ${dividerColor}`, marginTop: 2 }} />
          <button
            onClick={() => {
              onCancelReorder && onCancelReorder();
              onClose();
            }}
            style={{ ...btnStyle, color: isDark ? "#f87171" : "#b91c1c" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = isDark ? "rgba(248,113,113,0.1)" : "#fef2f2")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
            data-testid="ctx-menu-cancel-reorder"
          >
            <XCircle style={{ width: 14, height: 14, color: isDark ? "#f87171" : "#dc2626" }} />
            Cancel Re-order
          </button>
        </>
      )}
    </div>,
    document.body
  );
}
