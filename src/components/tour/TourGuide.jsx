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
      "Simulate a line or feedmill shutdown to see the impact on production — which orders would be delayed and by how much. A snapshot taken at shutdown time protects already-locked orders (Done, In Production, On-going) from being shifted when you resume.",
    position: "top",
  },
];

// Orders tour is context-aware: the visible UI differs per feedmill / line tab
// (All Feedmills hides line tabs, Powermix has no Auto-Sequence/Optimize button,
// per-feedmill tabs use the "Optimize" button instead of "Auto-Sequence").
function getOrdersTourSteps(activeFeedmill, activeLine) {
  const isAllFeedmills = activeFeedmill === "ALL_FM";
  const isPmx = activeFeedmill === "PMX";
  const isPerFeedmill = !isAllFeedmills && !isPmx; // FM1 / FM2 / FM3
  const isAllTab = !activeLine || activeLine === "all";

  const feedmillFullName =
    activeFeedmill === "FM1" ? "Feedmill 1"
    : activeFeedmill === "FM2" ? "Feedmill 2"
    : activeFeedmill === "FM3" ? "Feedmill 3"
    : activeFeedmill;

  const steps = [
    {
      target: '[data-tour="orders-feedmill-tabs"]',
      title: "Feedmill Tabs",
      description:
        'Switch between feedmills. The first tab — "All Feedmills" — stacks every line from FM1 (Lines 1-2), FM2 (Lines 3-4), FM3 (Lines 6-7) and Powermix (Line 5) into a single combined view; the other tabs scope you to one feedmill.',
      position: "bottom",
    },
  ];

  // Line tabs only exist for FM1/FM2/FM3 — ALL_FM has no line tab strip,
  // and PMX has a single line (Line 5) so the strip is empty.
  if (isPerFeedmill) {
    steps.push({
      target: '[data-tour="orders-line-tabs"]',
      title: "Line Tabs",
      description:
        `View orders per line or all lines for ${feedmillFullName}. Each line has its own queue sorted by priority. The "All" tab stacks both lines — search filters across both.`,
      position: "bottom",
    });
  }

  steps.push(
    {
      target: '[data-tour="orders-search"]',
      title: "Search & Filters",
      description:
        "Search across all visible orders by item name, material code, FPR, category, status, or any field. Use filters to narrow results further.",
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
        "Set the order lifecycle status — Plotted, Planned, Hold, Cut, In Production, On-going, Done, or Cancel PO. Status controls what can be moved and auto-sequenced. Flow-sequence guard: you can't roll an order back to Plotted or Planned once a downstream order on the same line is already On-going.",
      position: "bottom",
    },
    {
      target: '[data-tour="orders-header-scheduling"]',
      title: "Scheduling",
      description:
        "Set start date, start time, view availability date and completion date. Non-dated orders get dates from Future Dispatches stock data. An amber ⚠ next to Start Date/Time means your manual start doesn't line up with the previous order's completion — hover it to see the gap or overlap.",
      position: "bottom",
    },
    {
      target: '[data-tour="orders-header-product-insights"]',
      title: "Product Insights",
      description:
        "Stock status summaries auto-generated from Future Dispatches data. Click ✨ to enhance with AI-powered actionable recommendations.",
      position: "bottom",
    },
  );

  // Auto-Sequence / Optimize button only exists on certain views:
  //   - ALL_FM: "Auto-Sequence (All)" — plant-wide
  //   - FM1/FM2/FM3 + all tab: "Optimize Feedmill X"
  //   - FM1/FM2/FM3 + specific line: "Optimize Line Y"
  //   - PMX: button is hidden entirely (no step)
  if (isAllFeedmills) {
    steps.push({
      target: '[data-tour="orders-auto-sequence"]',
      title: "Auto-Sequence (All)",
      description:
        "Plant-wide intelligent re-sequencing across every feedmill and line. Combines, moves, and sorts orders globally to minimize changeover and meet availability dates. Locked orders (Done, In Production, Planned) stay in place.",
      position: "left",
    });
  } else if (isPerFeedmill) {
    if (isAllTab) {
      steps.push({
        target: '[data-tour="orders-auto-sequence"]',
        title: `Optimize ${feedmillFullName}`,
        description:
          `Optimize utilization across ${feedmillFullName}'s lines — find and move orders between the lines in this feedmill, then re-sequence the result by availability date. Locked orders stay in place.`,
        position: "left",
      });
    } else {
      steps.push({
        target: '[data-tour="orders-auto-sequence"]',
        title: `Optimize ${activeLine}`,
        description:
          `Optimize ${activeLine} utilization — find and pull in orders from other lines that fit, then re-sequence ${activeLine} by availability date. Critical orders go first; locked orders stay put.`,
        position: "left",
      });
    }
  }
  // PMX: no Auto-Sequence / Optimize step

  steps.push({
    target: '[data-tour="chat-bubble"]',
    title: "Smart Assistant",
    description:
      "Your AI production planning assistant. Ask about orders, stock levels, line capacity, or execute actions — all from chat.",
    position: "left",
  });

  return steps;
}

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
    target: '[data-tour="future-dispatches-upload"]',
    title: "Upload Future Dispatches",
    description:
      "Upload your dispatch forecast data (Excel file). This data drives production prioritization by analyzing inventory levels against demand forecasts.",
    position: "bottom",
  },
  {
    target: '[data-tour="future-dispatches-reapply"]',
    title: "Re-apply to Existing Orders",
    description:
      "After uploading new Future Dispatches data, click this to refresh all order availability dates, stock status icons, product insights, and Summary column across the app.",
    position: "bottom",
  },
  {
    target: '[data-tour="future-dispatches-search"]',
    title: "Search Products",
    description:
      "Search for specific products by material code, description, or category to quickly find their stock status.",
    position: "bottom",
  },
  {
    target: '[data-tour="future-dispatches-header-product"]',
    title: "Product Details",
    description:
      "Material code, category, item description, and Due for Loading (DFL) — the total demand volume for each product.",
    position: "bottom",
  },
  {
    target: '[data-tour="future-dispatches-header-days"]',
    title: "Dispatch Forecast",
    description:
      "Daily demand breakdown. Red-highlighted cells indicate where cumulative demand exceeds available inventory. Hover over any cell to see details.",
    position: "bottom",
  },
  {
    target: '[data-tour="future-dispatches-header-tracking"]',
    title: "Tracking",
    description:
      "Inventory level, balance to produce, completion and availability dates, and product status — Critical (red), Urgent (orange), Monitor (yellow), or Sufficient (green).",
    position: "bottom",
  },
  {
    target: '[data-tour="future-dispatches-safety-insights"]',
    title: "Safety Stock Insights",
    description:
      "AI-generated analysis of stock levels. Categorizes products by urgency — Critical products need immediate production, Urgent within 1-3 days, Monitor within the week, and Sufficient products are well-stocked.",
    position: "top",
  },
  {
    target: '[data-tour="future-dispatches-history"]',
    title: "Upload History",
    description:
      "Track all Future Dispatches file uploads. View which file is currently active, revert to previous uploads, or download past versions.",
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
    target: '[data-tour="kb-download-template"]',
    title: "Download Template",
    description:
      "Download a blank Excel template pre-formatted with all required columns — material codes, batch sizes, run rates, and more. Fill it in and upload to get started quickly.",
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

const CHANGEOVER_RULES_TOUR_STEPS = [
  {
    target: '[data-tour="changeover-rules-header"]',
    title: "Changeover Rules",
    description:
      "Configure additional changeover times that the scheduler adds between consecutive orders. Edits here flow into every cascade calculation — both manual scheduling and AI auto-sequencing — so save changes when you're ready to recalculate.",
    position: "bottom",
  },
  {
    target: '[data-tour="changeover-rules-description"]',
    title: "How the Rules Stack",
    description:
      "The extra time is determined by the next order's properties versus the previous one. If multiple conditions apply (e.g. diameter changes AND category changes), the additions stack. Powermix (Line 5) is exempt — these rules don't apply there.",
    position: "bottom",
  },
  {
    target: '[data-tour="changeover-rules-cards"]',
    title: "Rule Cards",
    description:
      "Each card is one transition type — pellet diameter change, color transitions (yellow↔brown, red→any, green→any, any→red/green), and category change. The FM1 / FM2 / FM3 fields let you set a different cost per feedmill, in hours. Powermix has no field because Line 5 isn't governed by these rules.",
    position: "top",
  },
];

const POWERMIX_SPLIT_TOUR_STEPS = [
  {
    target: '[data-tour="powermix-split-header"]',
    title: "Powermix Split Rules",
    description:
      "Define rules that auto-generate a linked order on another line whenever a qualifying FG is scheduled on Line 5 (Powermix) or Line 7. Use Add Rule to create a new mapping, or Apply Rules Now to re-evaluate every existing Line 5 / Line 7 order against the active rules.",
    position: "bottom",
  },
  {
    target: '[data-tour="powermix-split-search"]',
    title: "Search Rules",
    description:
      "Filter the rule list by FG code, item description, or target line. The counter on the right shows how many rules match versus the total configured.",
    position: "bottom",
  },
  {
    target: '[data-tour="powermix-split-table"]',
    title: "Rule Configuration",
    description:
      "Each row maps one FG → SFG / SFG1 source on a Source Line (5 or 7) to a Target Line. The % Split sets the generated quantity (rounded up to Batch Size — note this Batch Size overrides Master Data for source orders on Line 5/7). Toggle Active to enable/disable a rule without deleting it.",
    position: "top",
  },
  {
    target: '[data-tour="powermix-split-how-it-works"]',
    title: "How Splits Are Generated",
    description:
      "Linked orders are created automatically on upload and whenever you click Apply Rules Now. Line 5 sources carry FG + SFG1 forward; Line 7 sources carry FG + SFG. Deactivating a rule cancels its generated orders on the next apply.",
    position: "top",
  },
];

const DEMAND_TOUR_STEPS = [
  {
    target: '[data-tour="demand-smart-insights"]',
    title: "Smart Demand Insights",
    description:
      "AI-generated commentary on the selected period — seasonal patterns, anomalies, and re-order priorities. Expand to read the analysis or hit Refresh to regenerate.",
    position: "bottom",
  },
  {
    target: '[data-tour="demand-filters"]',
    title: "Search & Time Filters",
    description:
      "Filter SKUs and pick the historical period to benchmark against. By default the Year shows the last fully-completed calendar year (the current year is still in progress, so its data is partial). Upload Demand Data or Download Template to manage your dataset.",
    position: "bottom",
  },
  {
    target: '[data-tour="demand-kpi-cards"]',
    title: "Headline Metrics",
    description:
      "Quick read on the selected period — SKUs in view, how many need a re-order, how many are covered or exceed demand, total on-hand volume, and total historical demand benchmark.",
    position: "bottom",
  },
  {
    target: '[data-tour="demand-detailed-view"]',
    title: "Detailed Demand View",
    description:
      "Per-SKU comparison of historical demand vs. delivered (Done) and on-hand orders, with remaining volume and completion %. Sorted by Accounted-For so the most-covered SKUs surface first.",
    position: "top",
  },
  {
    target: '[data-tour="demand-monthly-profile"]',
    title: "Monthly Demand Profile",
    description:
      "Seasonal pattern per SKU — each cell shows that month's share of annual demand, with heatmap intensity highlighting peak months at a glance.",
    position: "top",
  },
];

// Full App tour: mirrors each page's "This Page Only" tour. For every section we
// (1) highlight the sidebar entry (and navigate to the page), then (2) walk
// through the key page-level anchors so the full tour stays aligned with the
// dedicated per-page tours.
const FULL_APP_TOUR_STEPS = [
  // ─── DASHBOARD (intro) ──────────────────────────────────────────────────────
  {
    target: '[data-tour="sidebar-dashboard"]',
    title: "Dashboard",
    description:
      "Your production dashboard. Contains Overview for monitoring feedmill status, Analytics for charts and KPIs, and SKU Monitoring for demand patterns.",
    position: "right",
  },

  // ─── OVERVIEW ───────────────────────────────────────────────────────────────
  {
    target: '[data-tour="sidebar-overview"]',
    title: "Dashboard — Overview",
    description:
      "Bird's-eye view of all feedmills and lines. See production volumes, capacity utilization, category breakdowns, and run shutdown simulations.",
    position: "right",
    page: "overview",
  },
  {
    target: '[data-tour="overview-feedmill-cards"]',
    title: "Feedmill Overview Cards",
    description:
      "Each card shows total volume, line-level progress, run rates, and category breakdown. FM1 has Lines 1-2, FM2 has Lines 3-4, FM3 has Lines 6-7, Powermix has Line 5.",
    position: "top",
    page: "overview",
  },

  // ─── ANALYTICS ──────────────────────────────────────────────────────────────
  {
    target: '[data-tour="sidebar-analytics"]',
    title: "Dashboard — Analytics",
    description:
      "Production analytics with key metric cards, visual charts (volume by category, orders by line, top items), and smart insights for data-driven planning.",
    position: "right",
    page: "analytics",
  },
  {
    target: '[data-tour="analytics-charts"]',
    title: "Charts & Visualizations",
    description:
      "Visual breakdowns of your production data — volume by category, order distribution across lines, and top ordered items. Helps identify trends and imbalances at a glance.",
    position: "bottom",
    page: "analytics",
  },
  {
    target: '[data-tour="analytics-smart-insight"]',
    title: "Smart Insights",
    description:
      "Analysis of your production data with actionable recommendations — which lines to rebalance, which products to prioritize, and optimization opportunities.",
    position: "top",
    page: "analytics",
  },

  // ─── SKU MONITORING (DEMAND) ────────────────────────────────────────────────
  {
    target: '[data-tour="sidebar-demand"]',
    title: "Dashboard — SKU Monitoring",
    description:
      "Historical demand patterns per SKU with supply coverage from current orders. Year defaults to the last fully-completed calendar year so benchmarks aren't skewed by the in-progress year.",
    position: "right",
    page: "demand",
  },
  {
    target: '[data-tour="demand-filters"]',
    title: "Search & Time Filters",
    description:
      "Filter SKUs and pick the historical period to benchmark against. Upload Demand Data or download the template from here.",
    position: "bottom",
    page: "demand",
  },
  {
    target: '[data-tour="demand-kpi-cards"]',
    title: "Headline Metrics",
    description:
      "Quick read on the selected period — SKUs in view, how many need a re-order, how many are covered, total on-hand volume, and total historical demand benchmark.",
    position: "bottom",
    page: "demand",
  },
  {
    target: '[data-tour="demand-detailed-view"]',
    title: "Detailed Demand View",
    description:
      "Per-SKU comparison of historical demand vs. delivered (Done) and on-hand orders, with remaining volume and completion %.",
    position: "top",
    page: "demand",
  },

  // ─── ORDERS ─────────────────────────────────────────────────────────────────
  {
    target: '[data-tour="sidebar-orders"]',
    title: "Orders",
    description:
      "Your main workspace for managing production orders. View, create, edit, and sequence orders across all feedmills and lines.",
    position: "right",
    page: "orders",
  },
  {
    target: '[data-tour="orders-feedmill-tabs"]',
    title: "Feedmill Tabs",
    description:
      'Switch between feedmills. "All Feedmills" stacks every line from FM1, FM2, FM3 and Powermix into one combined view; the other tabs scope you to one feedmill.',
    position: "bottom",
    page: "orders",
  },
  {
    target: '[data-tour="orders-search"]',
    title: "Search & Filters",
    description:
      "Search across all visible orders by item name, material code, FPR, category, status, or any field. Use filters to narrow further.",
    position: "bottom",
    page: "orders",
  },
  {
    target: '[data-tour="orders-metrics"]',
    title: "Metrics at a Glance",
    description:
      "Real-time counts of total, active, urgent, and incomplete orders that need attention.",
    position: "bottom",
    page: "orders",
  },
  {
    target: '[data-tour="orders-add-order"]',
    title: "Add New Order",
    description:
      "Create a production order. Enter a material code and Master Data auto-fills product details — description, form, batch size, run rate.",
    position: "bottom",
    page: "orders",
  },
  {
    target: '[data-tour="orders-auto-sequence"]',
    title: "Auto-Sequence (All)",
    description:
      "Plant-wide intelligent re-sequencing across every feedmill and line. Per-feedmill tabs replace this with Optimize Feedmill / Optimize Line. Locked orders (Done, In Production, Planned) stay in place.",
    position: "left",
    page: "orders",
  },

  // ─── ORDER HISTORY ──────────────────────────────────────────────────────────
  {
    target: '[data-tour="sidebar-order-history"]',
    title: "Order History",
    description:
      "Archive of completed and cancelled orders. Track production history across all lines.",
    position: "right",
    page: "orderHistory",
  },
  {
    target: '[data-tour="history-completed-tab"]',
    title: "Completed vs. Cancelled",
    description:
      "Toggle between completed (Done) orders and cancelled orders. Filter the archive further by production line.",
    position: "bottom",
    page: "orderHistory",
  },
  {
    target: '[data-tour="history-table"]',
    title: "Order History Table",
    description:
      "Detailed table of archived orders with all order details and completion info. Use this to review past production performance.",
    position: "top",
    page: "orderHistory",
  },

  // ─── CHANGEOVER RULES ───────────────────────────────────────────────────────
  {
    target: '[data-tour="sidebar-changeover-rules"]',
    title: "Changeover Rules",
    description:
      "Configure additional changeover times for product transitions — diameter, color, and category changes. These rules add time when consecutive orders differ in these properties.",
    position: "right",
    page: "changeoverRules",
  },
  {
    target: '[data-tour="changeover-rules-description"]',
    title: "How the Rules Stack",
    description:
      "Extra time is determined by the next order's properties vs. the previous one. Multiple conditions stack. Powermix (Line 5) is exempt.",
    position: "bottom",
    page: "changeoverRules",
  },
  {
    target: '[data-tour="changeover-rules-cards"]',
    title: "Rule Cards",
    description:
      "Each card is one transition type. FM1 / FM2 / FM3 fields let you set a different cost per feedmill in hours. Save Changes to apply across the scheduler.",
    position: "top",
    page: "changeoverRules",
  },

  // ─── POWERMIX SPLIT ─────────────────────────────────────────────────────────
  {
    target: '[data-tour="sidebar-powermix-split-rules"]',
    title: "Powermix Split Rules",
    description:
      "Auto-generate linked orders on another line whenever a qualifying FG is scheduled on Line 5 (Powermix) or Line 7.",
    position: "right",
    page: "powermixSplit",
  },
  {
    target: '[data-tour="powermix-split-table"]',
    title: "Rule Configuration",
    description:
      "Each row maps one FG → SFG / SFG1 on a Source Line (5 or 7) to a Target Line. % Split + Batch Size determine the generated quantity. Toggle Active to enable/disable a rule.",
    position: "top",
    page: "powermixSplit",
  },
  {
    target: '[data-tour="powermix-split-how-it-works"]',
    title: "How Splits Are Generated",
    description:
      "Linked orders are created automatically on upload and when you click Apply Rules Now. Deactivating a rule cancels its generated orders on the next apply.",
    position: "top",
    page: "powermixSplit",
  },

  // ─── MASTER DATA ────────────────────────────────────────────────────────────
  {
    target: '[data-tour="sidebar-master-data"]',
    title: "Master Data",
    description:
      "Master product data — material codes, batch sizes, run rates. Auto-populates new orders and drives production calculations.",
    position: "right",
    page: "knowledgeBase",
  },
  {
    target: '[data-tour="kb-edit-mode"]',
    title: "Edit Mode",
    description:
      "Toggle edit mode to manually modify cells. Edited cells are highlighted in yellow; duplicate material codes are flagged in red. Save creates a history entry.",
    position: "bottom",
    page: "knowledgeBase",
  },
  {
    target: '[data-tour="kb-table"]',
    title: "Product Data Table",
    description:
      "Material codes, descriptions, forms, batch sizes per feedmill, and run rates per line. Edit directly, track changes, and download any version.",
    position: "top",
    page: "knowledgeBase",
  },

  // ─── FUTURE DISPATCHES ──────────────────────────────────────────────────────
  {
    target: '[data-tour="sidebar-future-dispatches"]',
    title: "Future Dispatches",
    description:
      "Upload dispatch forecast data to drive production prioritization. The system analyzes demand against inventory and flags Critical, Urgent, Monitor, and Sufficient products.",
    position: "right",
    page: "n10d",
  },
  {
    target: '[data-tour="future-dispatches-upload"]',
    title: "Upload Future Dispatches",
    description:
      "Upload your dispatch forecast Excel file. After uploading, use Re-apply to refresh availability dates and stock status across every order.",
    position: "bottom",
    page: "n10d",
  },
  {
    target: '[data-tour="future-dispatches-safety-insights"]',
    title: "Safety Stock Insights",
    description:
      "AI-generated stock analysis grouping products by urgency — Critical (immediate), Urgent (1-3 days), Monitor (within the week), and Sufficient.",
    position: "top",
    page: "n10d",
  },

  // ─── CHAT ───────────────────────────────────────────────────────────────────
  {
    target: '[data-tour="chat-bubble"]',
    title: "Smart Assistant",
    description:
      "AI-powered chat assistant for production planning. Ask questions, get analysis, or execute actions — all through conversation.",
    position: "left",
  },
];

function getPageTourSteps(currentPage, ctx = {}) {
  switch (currentPage) {
    case "overview":
      return OVERVIEW_TOUR_STEPS;
    case "orders":
      return getOrdersTourSteps(ctx.activeFeedmill, ctx.activeLine);
    case "analytics":
      return ANALYTICS_TOUR_STEPS;
    case "demand":
      return DEMAND_TOUR_STEPS;
    case "orderHistory":
      return ORDER_HISTORY_TOUR_STEPS;
    case "changeoverRules":
      return CHANGEOVER_RULES_TOUR_STEPS;
    case "powermixSplit":
      return POWERMIX_SPLIT_TOUR_STEPS;
    case "n10d":
      return N10D_TOUR_STEPS;
    case "knowledgeBase":
      return KNOWLEDGE_BASE_TOUR_STEPS;
    case "configurations":
      return CONFIGURATIONS_TOUR_STEPS;
    default:
      return getOrdersTourSteps(ctx.activeFeedmill, ctx.activeLine);
  }
}

/* ─── Page navigation helper ────────────────────────────────────────────────── */

function navigateToPage(pageName, onNavigate) {
  switch (pageName) {
    case "overview":
      onNavigate("overview", null);
      break;
    case "orders":
      // Force All Feedmills view so all data-tour anchors (auto-sequence,
      // search, metrics, add-order) are guaranteed to exist for the full tour.
      onNavigate("orders", "all", "ALL_FM");
      break;
    case "analytics":
      onNavigate("analytics", null);
      break;
    case "demand":
      onNavigate("demand", null);
      break;
    case "orderHistory":
      onNavigate("configurations", "order_history");
      break;
    case "changeoverRules":
      onNavigate("configurations", "changeover_rules");
      break;
    case "powermixSplit":
      onNavigate("configurations", "powermix_split_rules");
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

export default function TourGuide({ isMenuOpen, onMenuClose, currentPage, activeFeedmill, activeLine, onNavigate }) {
  const [isTouring, setIsTouring] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [steps, setSteps] = useState([]);
  const navigatingRef = useRef(false);

  function startTour(type) {
    onMenuClose();
    const tourSteps =
      type === "full"
        ? FULL_APP_TOUR_STEPS
        : getPageTourSteps(currentPage, { activeFeedmill, activeLine });
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
