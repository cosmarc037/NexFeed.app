import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X, Send, Pencil, Trash2, Check, XCircle } from "lucide-react";
import { format } from "date-fns";

export default function CellCommentPopover({
  x,
  y,
  order,
  columnName,
  columnLabel,
  onClose,
  onPresenceChange,
  workspace = "live",
}) {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const popoverRef = useRef(null);
  const inputRef = useRef(null);

  const isDark = document.documentElement.classList.contains("nexfeed-dark");
  const dividerColor = isDark ? "rgba(255,255,255,0.08)" : "#f0f0f0";
  const inputBg = isDark ? "var(--color-bg-tertiary)" : "#ffffff";
  const inputColor = isDark ? "var(--color-text)" : "#1f2937";
  const inputBorder = isDark ? "rgba(255,255,255,0.12)" : "#d1d5db";

  useEffect(() => {
    loadComments();
  }, [order.id, columnName, workspace]);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    const handleClick = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target))
        onClose();
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
    }, 120);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  useEffect(() => {
    if (!loading) inputRef.current?.focus();
  }, [loading]);

  async function loadComments() {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/cell-comments?orderId=${encodeURIComponent(order.id)}&columnName=${encodeURIComponent(columnName)}&workspace=${encodeURIComponent(workspace)}`
      );
      if (res.ok) setComments(await res.json());
    } catch {}
    setLoading(false);
  }

  async function addComment() {
    if (!text.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/cell-comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          order_id: order.id,
          column_name: columnName,
          comment_text: text.trim(),
          workspace,
        }),
      });
      if (res.ok) {
        const c = await res.json();
        setComments((prev) => [...prev, c]);
        setText("");
        onPresenceChange?.(order.id, columnName, true);
      }
    } catch {}
    setSaving(false);
  }

  async function updateComment(id) {
    if (!editText.trim()) return;
    try {
      const res = await fetch(`/api/cell-comments/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment_text: editText.trim() }),
      });
      if (res.ok) {
        const updated = await res.json();
        setComments((prev) => prev.map((c) => (c.id === id ? updated : c)));
        setEditingId(null);
      }
    } catch {}
  }

  async function deleteComment(id) {
    try {
      await fetch(`/api/cell-comments/${id}`, { method: "DELETE" });
      const next = comments.filter((c) => c.id !== id);
      setComments(next);
      if (next.length === 0) onPresenceChange?.(order.id, columnName, false);
    } catch {}
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const popW = 320;
  const popH = 420;
  const left = Math.min(x, vw - popW - 12);
  const top = Math.min(y, vh - popH - 12);

  const displayLabel = columnLabel && columnLabel !== "row" ? columnLabel : null;

  const sendActiveBg = "var(--nexfeed-primary)";
  const sendInactiveBg = isDark ? "#374151" : "#e5e7eb";
  const sendInactiveColor = isDark ? "#6b7280" : "#9ca3af";

  return createPortal(
    <div
      ref={popoverRef}
      style={{
        position: "fixed",
        left,
        top,
        zIndex: 10001,
        width: popW,
        background: "var(--color-bg-secondary)",
        border: "1px solid var(--color-border)",
        borderRadius: 10,
        boxShadow: "0 12px 36px rgba(0,0,0,0.22)",
        display: "flex",
        flexDirection: "column",
        maxHeight: popH,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "10px 14px 8px",
          borderBottom: `1px solid ${dividerColor}`,
          gap: 8,
          flexShrink: 0,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              fontSize: 13,
              color: "var(--color-text)",
            }}
          >
            💬{" "}
            {displayLabel ? `Comment on ${displayLabel}` : "Comments"}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--color-text-secondary)",
              marginTop: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {order.item_description || order.fpr || "Order"}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--color-text-secondary)",
            padding: 2,
            borderRadius: 4,
            display: "flex",
          }}
          data-testid="btn-close-comment-popover"
        >
          <X style={{ width: 14, height: 14 }} />
        </button>
      </div>

      {/* Comments list */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "8px 14px",
          minHeight: 0,
        }}
      >
        {loading && (
          <div
            style={{
              fontSize: 12,
              color: "var(--color-text-secondary)",
              textAlign: "center",
              padding: "20px 0",
            }}
          >
            Loading...
          </div>
        )}
        {!loading && comments.length === 0 && (
          <div
            style={{
              fontSize: 12,
              color: "var(--color-text-secondary)",
              textAlign: "center",
              padding: "20px 0",
            }}
          >
            No comments yet. Add one below.
          </div>
        )}
        {!loading &&
          comments.map((c) => (
            <div
              key={c.id}
              style={{
                marginBottom: 10,
                padding: "8px 10px",
                background: "var(--color-bg-tertiary)",
                borderRadius: 6,
                border: "1px solid var(--color-border)",
              }}
            >
              <div
                style={{ display: "flex", alignItems: "flex-start", gap: 6 }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  {editingId === c.id ? (
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      style={{
                        width: "100%",
                        fontSize: 12,
                        border: `1px solid ${inputBorder}`,
                        borderRadius: 4,
                        padding: "4px 6px",
                        resize: "vertical",
                        minHeight: 60,
                        fontFamily: "inherit",
                        outline: "none",
                        boxSizing: "border-box",
                        background: inputBg,
                        color: inputColor,
                      }}
                      autoFocus
                    />
                  ) : (
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--color-text)",
                        lineHeight: "1.5",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {c.comment_text}
                    </div>
                  )}
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--color-text-secondary)",
                      marginTop: 4,
                    }}
                  >
                    {c.author}
                    {c.created_at
                      ? ` · ${format(new Date(c.created_at), "MMM d, h:mm a")}`
                      : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                  {editingId === c.id ? (
                    <>
                      <button
                        onClick={() => updateComment(c.id)}
                        title="Save"
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "#16a34a",
                          padding: 3,
                          borderRadius: 3,
                          display: "flex",
                        }}
                      >
                        <Check style={{ width: 12, height: 12 }} />
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        title="Cancel"
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--color-text-secondary)",
                          padding: 3,
                          borderRadius: 3,
                          display: "flex",
                        }}
                      >
                        <XCircle style={{ width: 12, height: 12 }} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => {
                          setEditingId(c.id);
                          setEditText(c.comment_text);
                        }}
                        title="Edit"
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--color-text-secondary)",
                          padding: 3,
                          borderRadius: 3,
                          display: "flex",
                        }}
                      >
                        <Pencil style={{ width: 12, height: 12 }} />
                      </button>
                      <button
                        onClick={() => deleteComment(c.id)}
                        title="Delete"
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "#ef4444",
                          padding: 3,
                          borderRadius: 3,
                          display: "flex",
                        }}
                      >
                        <Trash2 style={{ width: 12, height: 12 }} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
      </div>

      {/* Input area */}
      <div
        style={{
          borderTop: `1px solid ${dividerColor}`,
          padding: "8px 14px",
          display: "flex",
          gap: 6,
          alignItems: "flex-end",
          flexShrink: 0,
        }}
      >
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              addComment();
            }
          }}
          placeholder="Add a comment… (Enter to send)"
          rows={2}
          style={{
            flex: 1,
            fontSize: 12,
            border: `1px solid ${inputBorder}`,
            borderRadius: 6,
            padding: "6px 8px",
            resize: "none",
            fontFamily: "inherit",
            outline: "none",
            lineHeight: "1.4",
            background: inputBg,
            color: inputColor,
          }}
          data-testid="input-new-comment"
        />
        <button
          onClick={addComment}
          disabled={!text.trim() || saving}
          style={{
            background: text.trim() ? sendActiveBg : sendInactiveBg,
            border: "none",
            borderRadius: 6,
            padding: "0 10px",
            cursor: text.trim() ? "pointer" : "default",
            color: text.trim() ? "#fff" : sendInactiveColor,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            height: 34,
          }}
          data-testid="btn-send-comment"
        >
          <Send style={{ width: 13, height: 13 }} />
        </button>
      </div>
    </div>,
    document.body
  );
}
