# NexFeed: Production Schedule

A React/Vite feed mill production scheduling dashboard for managing and tracking production orders across Feedmill 1, Feedmill 2, Feedmill 3, and Powermix lines.

## Architecture

- **Frontend**: React 18 + Vite, Tailwind CSS, Radix UI components
- **Backend**: Express.js server (`server.js`) serving as both API and Vite dev server host
- **Database**: PostgreSQL (Replit built-in) via `pg` package
- **AI**: Azure OpenAI (GPT-4o-mini) via `VITE_AZURE_OPENAI_KEY` environment variable

## Running the App

```bash
npm run dev
```

This starts the Express server on port 5000, which also serves the Vite dev frontend with hot module replacement.

## Key Files

- `server.js` — Express backend with REST API for entities + Vite middleware
- `src/api/base44Client.js` — API client (replaces Base44 SDK, calls local REST endpoints)
- `src/lib/AuthContext.jsx` — Auth context (no-auth mode, all users treated as local admin)
- `src/pages/Dashboard.jsx` — Main dashboard page
- `src/components/orders/` — Order management components
- `src/components/chat/AIChatbot.jsx` — AI chatbot (uses Azure OpenAI directly)

## Database Tables

- `orders` — Production orders (FPR, material codes, volumes, scheduling, status)
- `knowledge_base` — Product knowledge base (run rates, batch sizes, materials)
- `knowledge_base_uploads` — Upload session tracking
- `cell_comments` — User comments per order cell (order_id, column_name, comment_text, author, timestamps)
- `row_highlights` — Row color highlights per order (order_id, color: 'violet'|'green'|'orange')

## Environment Variables

- `DATABASE_URL` — PostgreSQL connection string (auto-set by Replit)
- `VITE_AZURE_OPENAI_KEY` — Azure OpenAI API key for AI features (optional)

## Key Features

- **Readiness Column**: 3-tier icons (Red XCircle = missing critical, Orange AlertTriangle = HA incomplete, Green CheckCircle2 = ready). Positioned between Prio and FPR columns. Hovering shows detailed tooltip listing specific missing fields. Avail Date is NOT part of the readiness check — orders with non-date avail values (prio replenish, safety stocks, for sched) are not penalized.
- **Volume Override**: Lock/unlock mechanism on Volume cell. Override stores as `volume_override` field. Cascades to batches, bags, production hours, completion date. Warns if not a batch-size multiple.
- **Completion Date Override**: Lock/unlock mechanism. Manual override sets `target_completion_manual: true`, preventing auto-recalculation. Revert resets to auto-calculated and recascades.
- **End Date**: Editable only when order status is `completed` (Done).
- **Decimal Formatting**: Volume/Batches/Bags/BatchSize = whole numbers; Prod Hours/Changeover/RunRate = 2 decimal places. Shared formatters in `src/components/utils/formatters.js`.
- **Prod Remark**: NOT mapped from SAP upload — starts blank, user-editable.
- **SAP SFG1**: SAP file "SFG1" column stored in `sap_sfg1` DB field for Lines 1-4, mapped to `pmx` for Line 5. Production Order SFG1 starts blank and is user-editable.
- **Avail Date Year Inference**: FPR-based year logic — if target month >= FPR month, same year; if earlier, next year. Warnings shown (⚠) if inferred date is >6 months from FPR date or >3 months in the past.
- **Drag & Drop**: Row-level dragging — grab cursor on empty row space, I-beam cursor on text (text is selectable for copying). Clicking text cancels drag, clicking empty space or grip handle initiates drag. Interactive elements (buttons, dropdowns, inputs) also cancel drag. Combined groups move as a block when lead row is dragged.
- **SAP Upload — Blank Scheduling**: Upload preserves SAP file row order per line. All uploaded orders have blank Start Date, Start Time, and Completion Date (no auto-scheduling on upload). Priority_seq assigned sequentially by file order within each line. Blank cells show italic grey placeholders ("Set start date", "Set start time", "Set completion").
- **Scheduling — Completion-Only Cascade**: Start Date/Time NEVER cascade — they are always manual. Only Completion Date cascades. Rules: (1) If order has user-set Start Date/Time → Completion = Start + Production Hours. (2) If order has no Start Date/Time but previous order has a Completion → Completion = Prev Completion + Changeover + Production Hours (Start Date/Time cells stay blank with placeholders). (3) If no Start Date/Time and no previous Completion → Completion stays blank. (4) User-set Start Date/Time overrides the cascade chain — downstream orders cascade from this order's Completion. Completed ("Done") orders are frozen but feed into downstream cascade. Conflict detection uses stored `target_completion_date` from orders. Conflicts: `scheduling_conflict` (red = completion > avail date EOD), `gap_overflow` (yellow = non-dated exceeds gap).
- **Auto-Sequence**: AI-powered optimal sequencing via Azure OpenAI. Button in toolbar (Sparkles icon, orange outline). Priority rules: (1) dated orders as anchors sorted by Avail Date, (2) fill time before first anchor with non-dated, (3) fill gaps between dated orders, (4) remaining non-dated at end. Interactive full-screen simulation table modal (`AutoSequenceModal.jsx`) with drag-and-drop reordering, real-time cascade recalculation, left-border color indicators (green/yellow/red/grey), collapsible AI Insights, summary bar. Buttons: Apply to Schedule (with confirmation dialog), Reset to AI Suggestion, Cancel. Frontend service: `autoSequenceOrders()` in `src/services/azureAI.js`.
- **Combined Row Tinting**: Lead combined rows use bg-[#c8e0ed] (darker blue), child combined rows use bg-[#e0f2f8] (lighter blue). Child FPR Notes (prod_remarks) are editable; children keep their original notes on combine (no combine note appended to children).
- **Order History Tabs**: Order History has two primary tabs: Completed Orders and Cancelled Orders. Each tab has line filter sub-tabs (All, Line 1–7) with count badges. Cancelled tab shows extra columns: Cancellation Reason, Cancelled Date, Cancelled By.
- **Cancel PO**: Single `cancel_po` status for ALL cancellations (user-triggered AND SAP upload). User path: "Cancel PO" in status dropdown opens `CancelOrderDialog.jsx` with required reason dropdown (Client request, Material unavailable, Scheduling conflict, Duplicate order, Quality issue, Management decision, Other) + optional notes (required if "Other"). SAP path: Upload reads "PO Status" column; if "Cancelled" (case-insensitive), auto-sets `cancel_po`. On cancel: system-generated `cancel_note` is set (format: "Cancelled: [Reason] — [Date Time]") — `prod_remarks` is NOT modified. History entry added. DB columns: `cancelled_date`, `cancelled_time`, `cancel_reason`, `cancel_notes` (user freeform), `cancelled_by`, `cancel_note` (system-generated, displayed in red). Cancel PO rows in active table: greyed out (bg #f5f5f5, opacity 0.7), non-draggable, excluded from cascade/conflict detection/auto-sequence. In Order History Cancelled tab: full OrderTable with normal styling (no grey/opacity), cancel reason/notes/by shown under Item Description, cancelled date shown in End Date column.
- **Cancel Note Display**: The `cancel_note` field (system-generated) is displayed in red (#e53935) below regular `prod_remarks` in the FPR Notes cell. In the edit popover, only `prod_remarks` is editable; `cancel_note` appears as read-only red text in a highlighted box. In CSV export, both are combined into a single "FPR Notes" column.
- **Un-Cancel / Restore**: Cancelled orders retain an active status dropdown. Selecting any non-cancel status opens `RestoreOrderDialog.jsx` with order details (Line, FPR, Item, Volume, Availability), new status badge, and green "Confirm Restore" button. SAP-cancelled orders show an amber warning about SAP sync. On restore: status changes, `cancel_note` cleared to null, cancel fields cleared (cancelled_date/time/reason/notes/by → null), `prod_remarks` preserved untouched, order placed at end of active orders (next priority_seq), history entry added, cascade recalculated for the line. Restored orders are independent (no auto-rejoin of combined groups).
- **Powermix (Line 5)**: Additional fields `pmx` (Planned Order) and `sfgpmx` (Production Order). Headers show "FG | SFG | PMX" and "FG1 | SFG1 | SFGPMX" on PMX tab only. All Planned/Production Order cells show raw values without prefix labels; hover tooltips show labeled breakdown (FG: xxx, SFG: xxx, etc.).
- **History Column**: Renamed from "Actions" to "History", center-aligned header and content.
- **Per-Chart Smart Insights**: Each analytics chart has its own AI-powered insight with independent Generate/Refresh button.
- **AI Chatbot**: New Chat button with session reset, Azure OpenAI GPT-4o-mini via backend endpoints.
- **Smart Combine Panel**: Right-side slide-out panel (`src/components/orders/SmartCombinePanel.jsx`) that identifies groups of orders eligible for combining (same Material Code FG + Feedmill Line + Form + Batch Size + Category). Combined groups are ALWAYS contiguous — lead row is immediately followed by all children, no non-group orders in between. Card header: "[Item Description] | Combine Group [#]". Shared details: Material Code (FG), Category, Form, Line, Batch Size (2dp). Order rows use 3-column layout: Col1 (left) = FPR/FG/SFG/PMX identifiers, Col2 (center) = Production Hours + Completion Date/Time, Col3 (right) = Volume (bold) + Avail Date (grey if valid date, orange #fd5108 if non-date) + "Avail Date" label. Production hours formatted as "X hours Y min" (≥1hr) or "Y min" (<1hr). Features: conflict detection, approval flow with confirmation dialog, auto-generated lead row (FPR=YYMMDD), child rows with vertical connector and blue tint, un-combine on lead status change (no auto-notes added to FPR Notes, only History), status sync from lead to children. Per-line combine volume limits: Line 1/2 = 20 MT, Line 3/4 = 10 MT, Line 6/7 = 10 MT, Line 5 = no limit. Orders exceeding limit excluded from recommendations with expandable info banner. Manual combine blocked with error message if volume exceeds limit. DB columns: `volume_override`, `original_order_ids` (jsonb), `original_orders_snapshot` (jsonb), `parent_id`. New/existing order badges: green "NEW ORDER" badge for orders from latest upload, grey "EXISTING ORDER" for pre-existing. Filter tabs: [All Recommendations] [New + Existing Only] [New Orders Only]. `newFprValues` prop from Dashboard tracks FPRs from latest upload. **Enhanced AI Insights**: Three insight sections per card: (1) 📊 Combined Production Summary — combined volume, batch size, recalculated batch count, total bags, production time; (2) ⏱ Scheduling Impact — lead order time vs combined time, current/new completion, avail date comparison with safe/tight/conflict scenarios + downstream delay notes; (3) 💡 Gap Recommendation — if dated orders have large avail date gaps and non-dated orders could fill them, recommends NOT combining (with fitting orders list). When gap recommendation is active: Approve → "Approve Anyway" (orange outline), Dismiss → "Dismiss — Keep Separate" (green filled). Override logging in prod_remarks: "Combined despite AI recommendation to keep separate".
- **Right-Click Context Menu**: Right-clicking any row in the order table opens a portal-based context menu (`OrderContextMenu.jsx`) with: (1) Row color picker — 4 options (none, violet, green, orange) stored in `row_highlights` DB table and persisted across sessions, applied as a left border + subtle background tint on the `<tr>`; (2) "Leave a comment" — opens `CellCommentPopover.jsx`, a portal popover for viewing/adding/editing/deleting comments stored in `cell_comments` DB table keyed by order_id + column_name; (3) "View order history" — opens the existing OrderHistoryModal. Comment presence is fetched on table mount and shown as a small orange dot in the readiness cell for rows that have comments. Column context detected via `data-col-key` HTML attribute on specific cells (e.g., item_desc).
- **All Tab — Separate Tables Per Line**: On the "All" tab for multi-line feedmills (FM1/FM2/FM3), orders are displayed in separate tables stacked vertically — one per line. Each table has a section header with ClipboardList icon, line name (bold), and order count badge. Single-line feedmills (PMX) remain as a single table. Each table has independent drag-and-drop reordering scoped to that line's orders.
- **Column Alignment**: Batch Size, Batches, Bags are center-aligned (header + cell values). All other columns (FPR, Planned/Production Order, Material Code SFG/FG, Item Description, Form, Threads) are left-aligned.
- **Time Format**: All time displays use 12-hour format with AM/PM (e.g., "08:00 AM"). `formatTime12()` centralized in `src/components/utils/formatters.js`. Used in OrderTable, ExportButton, and throughout.
- **Start Time Editor**: Custom 12-hour editor with HH:MM text inputs + AM/PM toggle buttons (orange active, grey inactive). Validates hours 01-12 (00→12, >12→12), minutes 00-59. Stores internally as 24-hour format. Clock icon at top-right triggers edit mode.
- **Start Date Cell**: Calendar icon at top-right corner triggers date picker edit mode. Matches lock icon placement pattern from Volume/Completion cells. "Clear" button (red) appears when date is set, allowing user to clear start date and cascade blank downstream.
- **Status "Done" — Completion Date Styling**: When order status is `completed`, the Completion Date cell shows the value greyed out (color #c0c7d0, italic, opacity 0.6). Lock/calendar icons hidden. The order's completion date is frozen in the cascade but its value feeds as start for the next order.
- **Smart Combine — Changeover Savings**: Production Summary cards show "Production Time (separate)" vs "Production Time (combined)" with changeover savings section: changeovers eliminated count, duration, total saved. Green checkmark + total time saved when positive. Formula: separateTime = sum of individual prod hours + (N-1) × changeover; combinedTime = combined volume / run rate.
- **Combined Group Status Control**: ONLY the lead order's status is editable. Child orders show a read-only status badge with a lock icon (🔒) and tooltip "Status controlled by lead order (FPR: [X])". Lead's dropdown is restricted to: Uncombine | Hold | In production | On-going batching | On-going pelleting | On-going bagging | Done. Plotted, Cut, Cancel PO are hidden from the lead dropdown. "Uncombine" option (grey) triggers the UncombineOrderDialog. Status changes on lead auto-sync to all children. Blue tint (#c8e0ed lead / #e0f2f8 child) is retained across ALL status changes (persists for in_production, hold, done in active table). Blue tint is removed only: (1) after confirmed Uncombine, or (2) in Order History view (suppressCombinedTint=true). Lead/Child detection uses `original_order_ids?.length` (not status==='combined') so detection persists across status changes. In Order History tab: "Child" badge renamed to "Sub". UncombineOrderDialog shows: line, group name, lead FPR+volume, order count, combined volume, order table with role/FPR/volume (with original if overridden), amber warning box listing all consequences. Confirm Uncombine resets ALL orders to Plotted, clears parent_id/original_order_ids on all, triggers cascade recalculation.

## Migration Notes

Migrated from Base44 platform to Replit:
- Base44 SDK replaced with custom REST API client + Express backend
- Base44 authentication replaced with local no-auth context
- Base44 entity storage replaced with Replit PostgreSQL
- Base44 Vite plugin removed; standard `@vitejs/plugin-react` used
