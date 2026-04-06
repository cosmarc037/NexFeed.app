import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { MessageSquare, History, ArrowRightLeft, Undo2 } from "lucide-react";

const HIGHLIGHT_COLORS = [
  { key: null, label: "No highlight", bg: "transparent", border: "#d1d5db" },
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
  onClose,
}) {
  const menuRef = useRef(null);

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
    color: "#374151",
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
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.13)",
        padding: "6px 0",
        fontSize: 13,
        userSelect: "none",
      }}
    >
      <div
        style={{
          padding: "6px 14px 8px",
          borderBottom: "1px solid #f0f0f0",
          marginBottom: 4,
        }}
      >
        <div
          style={{
            fontWeight: 600,
            fontSize: 12,
            color: "#374151",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {order.item_description || "Order"}
        </div>
        {columnLabel && columnLabel !== "row" && (
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
            {columnLabel}
          </div>
        )}
      </div>

      <div style={{ padding: "4px 14px 8px" }}>
        <div
          style={{
            fontSize: 11,
            color: "#6b7280",
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
                boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
              }}
            />
          ))}
        </div>
      </div>

      <div style={{ borderTop: "1px solid #f0f0f0", marginTop: 2 }} />

      <button
        onClick={() => {
          onComment();
          onClose();
        }}
        style={btnStyle}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = "#f3f4f6")
        }
        onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
        data-testid="ctx-menu-comment"
      >
        <MessageSquare style={{ width: 14, height: 14, color: "#6b7280" }} />
        Leave a comment
      </button>

      <button
        onClick={() => {
          onViewHistory();
          onClose();
        }}
        style={btnStyle}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = "#f3f4f6")
        }
        onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
        data-testid="ctx-menu-history"
      >
        <History style={{ width: 14, height: 14, color: "#6b7280" }} />
        View order history
      </button>

      {(isDivertable || isReverted) && (
        <div style={{ borderTop: "1px solid #f0f0f0", marginTop: 2 }} />
      )}

      {isDivertable && (
        <button
          onClick={() => {
            onDivert && onDivert();
            onClose();
          }}
          style={{ ...btnStyle, color: '#b45309' }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#fffbeb")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
          data-testid="ctx-menu-divert"
        >
          <ArrowRightLeft style={{ width: 14, height: 14, color: '#d97706' }} />
          Divert order to another line
        </button>
      )}

      {isReverted && (
        <button
          onClick={() => {
            onRevert && onRevert();
            onClose();
          }}
          style={{ ...btnStyle, color: '#15803d' }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#f0fdf4")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
          data-testid="ctx-menu-revert"
        >
          <Undo2 style={{ width: 14, height: 14, color: '#16a34a' }} />
          Revert to original line
        </button>
      )}
    </div>,
    document.body
  );
}
