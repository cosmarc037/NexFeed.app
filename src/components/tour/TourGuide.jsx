import React, { useState, useEffect, useRef, useCallback } from "react";

/* ─── Tour step definitions ─────────────────────────────────────────────────── */

const OVERVIEW_TOUR_STEPS = [
  {
    target: '[data-tour="overview-insights"]',
    title: "Smart Production Insight",
    description:
      "AI-generated insights about your overall production. Click to expand and see optimization suggestions, potential issues, and recommendations.",
    position: "bottom",
  },
  {
    target: '[data-tour="overview-metrics"]',
    title: "Overview Metrics",
    description:
      "Quick summary of your production across all feedmills — total orders, active orders, completed orders, and urgent orders requiring attention.",
    position: "bottom",
  },
  {
    target: '[data-tour="overview-line-monitoring"]',
    title: "Line Status Monitoring",
    description:
      "Monitor all feedmills and production lines at a glance. See volume, run rates, and capacity utilization for each line.",
    position: "bottom",
  },
  {
    target: '[data-tour="overview-month-export"]',
    title: "Month & Export",
    description:
      'Select a month to view production data for that period. Click "Export Report" to download a PDF or Excel summary of the production overview.',
    position: "bottom",
  },
  {
    target: '[data-tour="overview-feedmill-cards"]',
    title: "Feedmill Cards",
    description:
      "Each card represents a feedmill with its lines. See total volume, run rate per line, progress bars for capacity, and category breakdown showing Completed, In Progress, On Hold, Cancelled, and Scheduled volumes.",
    position: "top",
  },
  {
    target: '[data-tour="overview-shutdown"]',
    title: "Shutdown Simulation",
    description:
      "Simulate a line shutdown to see the impact on production. Useful for planning maintenance — shows which orders would be delayed and by how much.",
    position: "top",
  },
];

const ORDERS_TOUR_STEPS = [
  {
    target: '[data-tour="orders-feedmill-tabs"]',
    title: "Feedmill Tabs",
    description:
      "Switch between feedmills. FM1 (Lines 1-2), FM2 (Lines 3-4), FM3 (Lines 6-7), Powermix (Line 5). Each feedmill has its own production queue.",
    position: "bottom",
  },
  {
    target: '[data-tour="orders-line-tabs"]',
    title: "Line Tabs",
    description:
      'View orders per line or all lines together. Each line has its own queue sorted by priority. The "All" tab shows all lines stacked — search filters across all of them.',
    position: "bottom",
  },
  {
    target: '[data-tour="orders-search"]',
    title: "Search & Filters",
    description:
      "Search across all lines by item name, material code, FPR, category, status, or any field. Use filters to narrow results further.",
    position: "bottom",
  },
  {
    target: '[data-tour="orders-metrics"]',
    title: "Metrics at a Glance",
    description:
      "Real-time counts of total orders, active orders, urgent orders, and orders lacking details that need attention.",
    position: "bottom",
  },
  {
    target: '[data-tour="orders-insights"]',
    title: "Production Insights",
    description:
      "Insights about your production schedule. Expand to see optimization suggestions and potential issues.",
    position: "bottom",
  },
  {
    target: '[data-tour="orders-alerts"]',
    title: "Alerts & Reminders",
    description:
      "Important notifications about upcoming deadlines, stock alerts, and scheduling conflicts that need your attention.",
    position: "bottom",
  },
  {
    target: '[data-tour="orders-add-order"]',
    title: "Add New Order",
    description:
      "Create a production order. Enter a material code and the Master Data auto-fills product details like description, form, batch size, and run rate.",
    position: "bottom",
  },
  {
    target: '[data-tour="orders-header-details"]',
    title: "Order Details",
    description:
      "Core order information — priority number, FPR, planned orders, material codes (FG and SFG), and item description with category.",
    position: "bottom",
  },
  {
    target: '[data-tour="orders-header-operator"]',
    title: "Order Status",
    description:
      "Set the order lifecycle status — Plotted, Planned, Hold, Cut, In Production, On-going, Done, or Cancel PO. Status controls what can be moved and auto-sequenced.",
    position: "bottom",
  },
  {
    target: '[data-tour="orders-header-scheduling"]',
    title: "Scheduling",
    description:
      "Set start date, start time, view availability date and completion date. Non-dated orders get dates from N10D stock data.",
    position: "bottom",
  },
  {
    target: '[data-tour="orders-header-product-insights"]',
    title: "Product Insights",
    description:
      "Stock status summaries auto-generated from N10D data. Click ✨ to enhance with AI-powered actionable recommendations.",
    position: "bottom",
  },
  {
    target: '[data-tour="orders-auto-sequence"]',
    title: "Auto-Sequence",
    description:
      "Automatically sort movable orders by availability dates. Critical orders go first. Locked orders (Done, In Production, Planned) stay in place.",
    position: "left",
  },
  {
    target: '[data-tour="orders-smart-combine"]',
    title: "Smart Combine",
    description:
      "Find and combine orders with matching product details (material code, form, batch size, line, SCADA). Reduces changeover time and improves efficiency.",
    position: "left",
  },
  {
    target: '[data-tour="chat-bubble"]',
    title: "Smart Assistant",
    description:
      "Your AI production planning assistant. Ask about orders, stock levels, line capacity, or execute actions like combining orders — all from chat.",
    position: "left",
  },
];

const ANALYTICS_TOUR_STEPS = [
  {
    target: '[data-tour="analytics-metrics"]',
    title: "Key Metrics",
    description:
      "High-level production KPIs — total volume across all orders, average order size, completed count, and total order count.",
    position: "bottom",
  },
  {
    target: '[data-tour="analytics-charts"]',
    title: "Charts & Visualizations",
    description:
      "Visual breakdowns of your production data — volume by category, order distribution across lines, and top ordered items. Helps identify trends and imbalances at a glance.",
    position: "bottom",
  },
  {
    target: '[data-tour="analytics-smart-insight"]',
    title: "Smart Insights",
    description:
      "Analysis of your production data with actionable recommendations — which lines to rebalance, which products to prioritize, and optimization opportunities.",
    position: "top",
  },
];

const ORDER_HISTORY_TOUR_STEPS = [
  {
    target: '[data-tour="history-completed-tab"]',
    title: "Completed Orders",
    description:
      "View all orders that have been marked as Done and rotated out of the active production queue. These are your finished production records.",
    position: "bottom",
  },
  {
    target: '[data-tour="history-cancelled-tab"]',
    title: "Cancelled Orders",
    description:
      "View all orders that were cancelled. These orders were removed from production and archived here for reference.",
    position: "bottom",
  },
  {
    target: '[data-tour="history-line-tabs"]',
    title: "Filter by Line",
    description:
      "Filter historical orders by production line. View all lines at once or focus on a specific line's history.",
    position: "bottom",
  },
  {
    target: '[data-tour="history-table"]',
    title: "Order History Table",
    description:
      "Detailed table of archived orders showing all order details, production parameters, and completion information. Use this to review past production performance.",
    position: "top",
  },
];

const N10D_TOUR_STEPS = [
  {
    target: '[data-tour="n10d-upload"]',
    title: "Upload Next 10 Days",
    description:
      "Upload your daily stock level data (Excel file). This data drives production prioritization by analyzing inventory levels against demand forecasts for the next 10 days.",
    position: "bottom",
  },
  {
    target: '[data-tour="n10d-reapply"]',
    title: "Re-apply to Existing Orders",
    description:
      "After uploading new N10D data, click this to refresh all order availability dates, stock status icons, product insights, and Summary column across the app.",
    position: "bottom",
  },
  {
    target: '[data-tour="n10d-search"]',
    title: "Search Products",
    description:
      "Search for specific products by material code, description, or category to quickly find their stock status.",
    position: "bottom",
  },
  {
    target: '[data-tour="n10d-header-product"]',
    title: "Product Details",
    description:
      "Material code, category, item description, and Due for Loading (DFL) — the total demand volume for each product.",
    position: "bottom",
  },
  {
    target: '[data-tour="n10d-header-days"]',
    title: "Next 10 Days Demand",
    description:
      "Daily demand breakdown. Red-highlighted cells indicate where cumulative demand exceeds available inventory. Hover over any cell to see cumulative demand vs inventory.",
    position: "bottom",
  },
  {
    target: '[data-tour="n10d-header-tracking"]',
    title: "Tracking",
    description:
      "Inventory level, balance to produce, completion and availability dates, and product status — Critical (red), Urgent (orange), Monitor (yellow), or Sufficient (green).",
    position: "bottom",
  },
  {
    target: '[data-tour="n10d-safety-insights"]',
    title: "Safety Stock Insights",
    description:
      "AI-generated analysis of stock levels. Categorizes products by urgency — Critical products need immediate production, Urgent within 1-3 days, Monitor within the week, and Sufficient products are well-stocked.",
    position: "top",
  },
  {
    target: '[data-tour="n10d-history"]',
    title: "Upload History",
    description:
      "Track all N10D file uploads. View which file is currently active, revert to previous uploads, or download past versions.",
    position: "top",
  },
];

const KNOWLEDGE_BASE_TOUR_STEPS = [
  {
    target: '[data-tour="kb-upload"]',
    title: "Upload Master Data",
    description:
      "Upload your master product data Excel file containing material codes, batch sizes, run rates, and formulations. This data auto-populates when creating new orders.",
    position: "bottom",
  },
  {
    target: '[data-tour="kb-reapply"]',
    title: "Re-apply to Orders",
    description:
      "After editing the Master Data, click this to update all existing orders with the latest product data.",
    position: "bottom",
  },
  {
    target: '[data-tour="kb-edit-mode"]',
    title: "Edit Mode",
    description:
      "Toggle edit mode to manually modify cells. Edited cells are highlighted in yellow. Duplicate material codes are highlighted in red. Click Save to create a history entry.",
    position: "bottom",
  },
  {
    target: '[data-tour="kb-table"]',
    title: "Product Data Table",
    description:
      "Master product data including material codes, descriptions, forms, batch sizes per feedmill, and production run rates per line.",
    position: "top",
  },
  {
    target: '[data-tour="kb-history"]',
    title: "History",
    description:
      "Track all changes — file uploads, manual edits, and reverts. Each entry stores a complete snapshot. Revert to any previous version or download any version as Excel.",
    position: "top",
  },
];

const CONFIGURATIONS_TOUR_STEPS = [
  {
    target: '[data-tour="config-page"]',
    title: "Configurations",
    description:
      "Manage production order configurations, feedmill settings, line parameters, and operational settings for the scheduling system.",
    position: "bottom",
  },
];

const FULL_APP_TOUR_STEPS = [
  // === SIDEBAR ===
  {
    target: '[data-tour="sidebar-overview"]',
    title: "Overview",
    description:
      "Bird's-eye view of all feedmills and lines. See production volumes, capacity utilization, and category breakdowns.",
    position: "right",
    page: "overview",
  },
  {
    target: '[data-tour="sidebar-orders"]',
    title: "Orders",
    description:
      "Your main workspace for managing production orders. View, create, edit, sequence, and combine orders across all lines.",
    position: "right",
    page: "orders",
  },
  {
    target: '[data-tour="sidebar-analytics"]',
    title: "Analytics",
    description:
      "Production analytics with charts, KPIs, and AI-powered insights for data-driven planning decisions.",
    position: "right",
    page: "analytics",
  },
  {
    target: '[data-tour="sidebar-order-history"]',
    title: "Order History",
    description:
      "Archive of completed and cancelled orders. Track production history across all lines.",
    position: "right",
    page: "orderHistory",
  },
  {
    target: '[data-tour="sidebar-master-data"]',
    title: "Master Data",
    description:
      "Master product data — material codes, batch sizes, run rates. Auto-populates order details and drives production calculations.",
    position: "right",
    page: "knowledgeBase",
  },
  {
    target: '[data-tour="sidebar-n10d"]',
    title: "Next 10 Days",
    description:
      "Daily stock level data for production prioritization. Analyzes inventory vs demand and flags Critical, Urgent, Monitor, and Sufficient products.",
    position: "right",
    page: "n10d",
  },
  // === OVERVIEW PAGE HIGHLIGHTS ===
  {
    target: '[data-tour="overview-feedmill-cards"]',
    title: "Feedmill Overview Cards",
    description:
      "Each feedmill card shows total volume, line-level progress, run rates, and category breakdown. FM1 has Lines 1-2, FM2 has Lines 3-4, FM3 has Lines 6-7, Powermix has Line 5.",
    position: "top",
    page: "overview",
  },
  // === ORDERS PAGE HIGHLIGHTS ===
  {
    target: '[data-tour="orders-feedmill-tabs"]',
    title: "Feedmill & Line Navigation",
    description:
      'Switch between feedmills and lines. The "All" tab shows all lines for a feedmill. Each line has its own sortable production queue.',
    position: "bottom",
    page: "orders",
  },
  {
    target: '[data-tour="orders-auto-sequence"]',
    title: "Auto-Sequence",
    description:
      "One-click intelligent sorting — Critical orders first, then chronological by availability date. Locked orders stay in place.",
    position: "left",
    page: "orders",
  },
  // === N10D HIGHLIGHTS ===
  {
    target: '[data-tour="n10d-upload"]',
    title: "Stock Level Data",
    description:
      "Upload daily stock data to drive production prioritization. The system analyzes 10-day demand against inventory to determine urgency.",
    position: "bottom",
    page: "n10d",
  },
  // === KB HIGHLIGHTS ===
  {
    target: '[data-tour="kb-table"]',
    title: "Master Data",
    description:
      "Master product data that auto-populates orders. Edit cells directly, track changes with history, and download any version.",
    position: "top",
    page: "knowledgeBase",
  },
  // === CHAT ===
  {
    target: '[data-tour="chat-bubble"]',
    title: "Smart Assistant",
    description:
      "AI-powered chat assistant for production planning. Ask questions, get analysis, or execute actions — all through conversation.",
    position: "left",
  },
];

function getPageTourSteps(currentPage) {
  switch (currentPage) {
    case "overview":
      return OVERVIEW_TOUR_STEPS;
    case "orders":
      return ORDERS_TOUR_STEPS;
    case "analytics":
      return ANALYTICS_TOUR_STEPS;
    case "orderHistory":
      return ORDER_HISTORY_TOUR_STEPS;
    case "n10d":
      return N10D_TOUR_STEPS;
    case "knowledgeBase":
      return KNOWLEDGE_BASE_TOUR_STEPS;
    case "configurations":
      return CONFIGURATIONS_TOUR_STEPS;
    default:
      return ORDERS_TOUR_STEPS;
  }
}

/* ─── Page navigation helper ────────────────────────────────────────────────── */

function navigateToPage(pageName, onNavigate) {
  switch (pageName) {
    case "overview":
      onNavigate("overview", null);
      break;
    case "orders":
      onNavigate("orders", "all");
      break;
    case "analytics":
      onNavigate("analytics", null);
      break;
    case "orderHistory":
      onNavigate("configurations", "order_history");
      break;
    case "knowledgeBase":
      onNavigate("configurations", "knowledge_base");
      break;
    case "n10d":
      onNavigate("configurations", "next_10_days");
      break;
    case "configurations":
      onNavigate("configurations", null);
      break;
    default:
      break;
  }
}

/* ─── Tooltip position calculator ──────────────────────────────────────────── */

function calcTooltipPos(targetRect, preferred) {
  const W = 340;
  const H = 240;
  const GAP = 16;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top, left;

  switch (preferred) {
    case "top":
      top = targetRect.top - H - GAP;
      left = targetRect.left + targetRect.width / 2 - W / 2;
      break;
    case "right":
      top = targetRect.top + targetRect.height / 2 - H / 2;
      left = targetRect.right + GAP;
      break;
    case "left":
      top = targetRect.top + targetRect.height / 2 - H / 2;
      left = targetRect.left - W - GAP;
      break;
    default: // bottom
      top = targetRect.bottom + GAP;
      left = targetRect.left + targetRect.width / 2 - W / 2;
  }

  // Clamp to viewport
  if (left < 16) left = 16;
  if (left + W > vw - 16) left = vw - W - 16;
  if (top < 16) top = 16;
  if (top + H > vh - 16) {
    top = targetRect.top - H - GAP;
    if (top < 16) top = 16;
  }

  return { position: "fixed", top: `${top}px`, left: `${left}px`, zIndex: 10002 };
}

/* ─── TourTooltip ───────────────────────────────────────────────────────────── */

function TourTooltip({ step, stepIndex, totalSteps, onNext, onPrev, onSkip, posStyle }) {
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === totalSteps - 1;

  return (
    <div className="tour-tooltip" style={posStyle}>
      <div className="tour-tooltip-header">
        <h4 className="tour-tooltip-title">{step.title}</h4>
        <button className="tour-tooltip-skip" onClick={onSkip}>
          Skip Tour
        </button>
      </div>
      <div className="tour-tooltip-body">
        <p>{step.description}</p>
      </div>
      <div className="tour-tooltip-footer">
        <span className="tour-tooltip-counter">
          Step {stepIndex + 1} of {totalSteps}
        </span>
        <div className="tour-tooltip-actions">
          {!isFirst && (
            <button className="tour-btn-back" onClick={onPrev}>
              Back
            </button>
          )}
          <button className="tour-btn-next" onClick={onNext} data-testid="button-tour-next">
            {isLast ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── TourOverlay ───────────────────────────────────────────────────────────── */

function TourOverlay({ step, stepIndex, totalSteps, onNext, onPrev, onSkip }) {
  const [targetRect, setTargetRect] = useState(null);
  const [tooltipPos, setTooltipPos] = useState(null);
  const PAD = 8;

  useEffect(() => {
    let cancelled = false;

    function measureTarget() {
      if (!step?.target) {
        setTargetRect(null);
        setTooltipPos(null);
        return;
      }
      const el = document.querySelector(step.target);
      if (!el) {
        setTargetRect(null);
        setTooltipPos({
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 10002,
        });
        return;
      }
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => {
        if (cancelled) return;
        const rect = el.getBoundingClientRect();
        setTargetRect(rect);
        setTooltipPos(calcTooltipPos(rect, step.position || "bottom"));
      }, 350);
    }

    measureTarget();
    return () => { cancelled = true; };
  }, [step]);

  useEffect(() => {
    function handleKey(e) {
      if (e.key === "ArrowRight" || e.key === "Enter") onNext();
      else if (e.key === "ArrowLeft") onPrev();
      else if (e.key === "Escape") onSkip();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onNext, onPrev, onSkip]);

  const highlightStyle = targetRect
    ? {
        position: "fixed",
        top: targetRect.top - PAD,
        left: targetRect.left - PAD,
        width: targetRect.width + PAD * 2,
        height: targetRect.height + PAD * 2,
        borderRadius: 8,
        boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.55)",
        zIndex: 10001,
        pointerEvents: "none",
        transition: "all 0.25s ease",
        outline: "2px solid rgba(253, 81, 8, 0.7)",
        outlineOffset: 1,
      }
    : null;

  return (
    <>
      {!targetRect && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            zIndex: 10000,
          }}
          onClick={onSkip}
        />
      )}
      {highlightStyle && <div style={highlightStyle} />}
      {tooltipPos && (
        <TourTooltip
          step={step}
          stepIndex={stepIndex}
          totalSteps={totalSteps}
          onNext={onNext}
          onPrev={onPrev}
          onSkip={onSkip}
          posStyle={tooltipPos}
        />
      )}
    </>
  );
}

/* ─── TourSelectionMenu ─────────────────────────────────────────────────────── */

function TourSelectionMenu({ onSelect, onClose }) {
  return (
    <div className="tour-menu-overlay" onClick={onClose}>
      <div className="tour-menu" onClick={(e) => e.stopPropagation()}>
        <div className="tour-menu-header">
          <h3>Choose a Tour</h3>
          <button className="tour-menu-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="tour-menu-options">
          <button className="tour-menu-option" onClick={() => onSelect("full")} data-testid="button-tour-full">
            <div className="tour-option-icon">🏭</div>
            <div className="tour-option-info">
              <span className="tour-option-title">Full App Tour</span>
              <span className="tour-option-desc">
                Complete walkthrough of all features and pages
              </span>
            </div>
          </button>
          <button className="tour-menu-option" onClick={() => onSelect("page")} data-testid="button-tour-page">
            <div className="tour-option-icon">📄</div>
            <div className="tour-option-info">
              <span className="tour-option-title">This Page Only</span>
              <span className="tour-option-desc">
                Quick tour of the current page you're on
              </span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── TourGuide (main export) ───────────────────────────────────────────────── */

export default function TourGuide({ isMenuOpen, onMenuClose, currentPage, onNavigate }) {
  const [isTouring, setIsTouring] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [steps, setSteps] = useState([]);
  const navigatingRef = useRef(false);

  function startTour(type) {
    onMenuClose();
    const tourSteps =
      type === "full" ? FULL_APP_TOUR_STEPS : getPageTourSteps(currentPage);
    setSteps(tourSteps);
    setStepIndex(0);
    setIsTouring(true);
  }

  const endTour = useCallback(() => {
    setIsTouring(false);
    setStepIndex(0);
    setSteps([]);
    navigatingRef.current = false;
  }, []);

  const currentStep = steps[stepIndex] || null;

  // Handle page navigation when full tour crosses pages
  useEffect(() => {
    if (!isTouring || !currentStep) return;
    if (!currentStep.page) return;
    if (navigatingRef.current) return;
    navigatingRef.current = true;
    navigateToPage(currentStep.page, onNavigate);
    const t = setTimeout(() => { navigatingRef.current = false; }, 700);
    return () => clearTimeout(t);
  }, [isTouring, currentStep, onNavigate]);

  const handleNext = useCallback(async () => {
    const nextIndex = stepIndex + 1;
    if (nextIndex >= steps.length) {
      endTour();
      return;
    }
    const nextStep = steps[nextIndex];
    // Navigate if needed
    if (nextStep.page) {
      navigateToPage(nextStep.page, onNavigate);
      // Wait for page to render
      await new Promise((r) => setTimeout(r, 600));
      // Wait for element to appear
      let retries = 0;
      while (retries < 10) {
        if (document.querySelector(nextStep.target)) break;
        await new Promise((r) => setTimeout(r, 200));
        retries++;
      }
    }
    setStepIndex(nextIndex);
  }, [stepIndex, steps, endTour, onNavigate]);

  const handlePrev = useCallback(async () => {
    const prevIndex = stepIndex - 1;
    if (prevIndex < 0) return;
    const prevStep = steps[prevIndex];
    if (prevStep.page) {
      navigateToPage(prevStep.page, onNavigate);
      await new Promise((r) => setTimeout(r, 600));
      let retries = 0;
      while (retries < 10) {
        if (document.querySelector(prevStep.target)) break;
        await new Promise((r) => setTimeout(r, 200));
        retries++;
      }
    }
    setStepIndex(prevIndex);
  }, [stepIndex, steps, onNavigate]);

  return (
    <>
      {isMenuOpen && !isTouring && (
        <TourSelectionMenu onSelect={startTour} onClose={onMenuClose} />
      )}
      {isTouring && currentStep && (
        <TourOverlay
          step={currentStep}
          stepIndex={stepIndex}
          totalSteps={steps.length}
          onNext={handleNext}
          onPrev={handlePrev}
          onSkip={endTour}
        />
      )}
    </>
  );
}
