import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/* ─── Duration Calculator ───────────────────────────────────────────────── */
function getNotificationDuration(type, message) {
  const baseDurations = { success: 3000, info: 4000, warning: 6000, error: 8000 };
  const maxDurations  = { success: 5000, info: 7000, warning: 10000, error: 15000 };
  const base = baseDurations[type] ?? 4000;
  const max  = maxDurations[type]  ?? 10000;
  const len  = (message || "").length;
  const extra = len > 80 ? Math.ceil((len - 80) / 50) * 1000 : 0;
  return Math.min(base + extra, max);
}

/* ─── Global bridge ─────────────────────────────────────────────────────── */
let _addNotification = null;

function pushNotification(type, message, opts = {}) {
  const title       = opts.title ?? null;
  const description = opts.description ?? null;
  const fullText    = [message, description].filter(Boolean).join(" ");
  const duration    = getNotificationDuration(type, fullText);
  _addNotification?.({
    id: `${Date.now()}-${Math.random()}`,
    type,
    message,
    title,
    description,
    duration,
  });
}

export const toast = {
  success: (msg, opts) => pushNotification("success", msg, opts ?? {}),
  error:   (msg, opts) => pushNotification("error",   msg, opts ?? {}),
  warning: (msg, opts) => pushNotification("warning", msg, opts ?? {}),
  info:    (msg, opts) => pushNotification("info",    msg, opts ?? {}),
};

/* ─── Single Notification ───────────────────────────────────────────────── */
const ICONS   = { success: "✓", info: "ℹ", warning: "⚠", error: "✕" };
const COLORS  = {
  success: { bg: "#f0fdf4", border: "#bbf7d0", icon: "#16a34a", progress: "#16a34a" },
  info:    { bg: "#eff6ff", border: "#bfdbfe", icon: "#2563eb", progress: "#2563eb" },
  warning: { bg: "#fffbeb", border: "#fde68a", icon: "#b45309", progress: "#d97706" },
  error:   { bg: "#fef2f2", border: "#fecaca", icon: "#dc2626", progress: "#dc2626" },
};

function NotificationItem({ notif, onDismiss }) {
  const { id, type, message, title, description, duration } = notif;
  const style     = COLORS[type] ?? COLORS.info;
  const [exiting, setExiting] = useState(false);
  const timerRef  = useRef(null);
  const startRef  = useRef(null);
  const remainRef = useRef(duration);

  const dismiss = () => {
    clearTimeout(timerRef.current);
    setExiting(true);
    setTimeout(() => onDismiss(id), 300);
  };

  const startTimer = (ms) => {
    clearTimeout(timerRef.current);
    startRef.current = Date.now();
    timerRef.current = setTimeout(dismiss, ms);
  };

  useEffect(() => {
    startTimer(duration);
    return () => clearTimeout(timerRef.current);
  }, []);

  const handleMouseEnter = () => {
    const elapsed = Date.now() - (startRef.current ?? Date.now());
    remainRef.current = Math.max(0, remainRef.current - elapsed);
    clearTimeout(timerRef.current);
  };

  const handleMouseLeave = () => {
    startTimer(Math.max(remainRef.current, 2000));
  };

  const displayTitle = title ?? (description ? message : null);
  const displayBody  = description ?? message;

  return (
    <div
      className={`nf-item nf-${type}${exiting ? " nf-exiting" : ""}`}
      style={{ background: style.bg, borderColor: style.border }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="nf-content">
        <span className="nf-icon" style={{ color: style.icon }}>
          {ICONS[type]}
        </span>
        <div className="nf-text">
          {displayTitle && <div className="nf-title">{displayTitle}</div>}
          <div className="nf-body">{displayBody}</div>
        </div>
        <button className="nf-close" onClick={dismiss} aria-label="Dismiss">✕</button>
      </div>
      <div
        className="nf-progress"
        style={{
          background: style.progress,
          animationDuration: `${duration}ms`,
        }}
      />
    </div>
  );
}

/* ─── Container ─────────────────────────────────────────────────────────── */
export function NotificationContainer() {
  const [items, setItems] = useState([]);

  useEffect(() => {
    _addNotification = (notif) =>
      setItems((prev) => [...prev, notif]);
    return () => { _addNotification = null; };
  }, []);

  const dismiss = (id) =>
    setItems((prev) => prev.filter((n) => n.id !== id));

  if (items.length === 0) return null;

  return createPortal(
    <div className="nf-container">
      {items.map((n) => (
        <NotificationItem key={n.id} notif={n} onDismiss={dismiss} />
      ))}
    </div>,
    document.body
  );
}
