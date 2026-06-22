# NexFeed — Complete Application Context

> Exhaustive reference for the NexFeed feed-mill production planning dashboard. Intended to onboard an AI prompt-helper with full knowledge of every page, tab, feature, business rule, file, and data flow.

---

## 0. High-Level Summary

**NexFeed** is a single-page React application that plans, schedules, and tracks production orders across three feed mills and one Powermix line at an animal-feed plant.

- **Frontend:** React 18 + Vite + Tailwind + Radix UI (shadcn), React Router v6, TanStack Query v5, lucide-react icons.
- **Backend:** Express (`server.js`, ~1500 LOC) exposing a generic entity REST API plus AI/PDF/Excel helpers.
- **Database:** PostgreSQL (created via `initTables()` in `server.js`). Falls back to in-memory mode if `DATABASE_URL` is absent.
- **AI:** Azure OpenAI (`gpt-4.1-mini` deployment at `nexfeed-ai.cognitiveservices.azure.com`) called server-side, key in `VITE_AZURE_OPENAI_KEY`.
- **Auth:** Local "no-auth" admin mode via `src/lib/AuthContext.jsx` and `UserNotRegisteredError.jsx`. Replaces the original Base44 SDK.

### Routing & shell
- `src/App.jsx` — sets up `AuthProvider`, `QueryClientProvider`, `BrowserRouter`, `Toaster`. Pages are auto-registered through `src/pages.config.js` (only `Dashboard` is currently exposed; everything else lives inside it as views).
- `src/Layout.jsx` — wraps every page with `Sidebar` + `Header`.
- `src/pages/Dashboard.jsx` (~7,760 LOC) — the **monolithic shell**. Owns `activeSection`, `activeSubSection`, `activeFeedmill` state, fetches all orders + master data via TanStack Query, runs scheduling cascade logic, and conditionally renders the correct sub-view.

### Navigation map (Sidebar — `src/components/layout/Sidebar.jsx`)
```
Dashboard          (collapsible)
 ├─ Overview                       activeSection="overview"
 ├─ Analytics                      activeSection="analytics"
 └─ Monitoring                     activeSection="demand"   (SKU/demand monitoring)
Orders             (collapsible, badge = order count per FM)
 ├─ All Feedmills                  activeSection="orders",   activeFeedmill="ALL_FM"
 ├─ Feedmill 1   (Line 1, Line 2)  activeFeedmill="FM1"
 ├─ Feedmill 2   (Line 3, Line 4)  activeFeedmill="FM2"
 ├─ Feedmill 3   (Line 6, Line 7)  activeFeedmill="FM3"
 └─ Powermix     (Line 5)          activeFeedmill="PMX"
Configurations     (collapsible)
 ├─ Order History                  activeSubSection="order_history"
 ├─ Changeover Rules               activeSubSection="changeover_rules"
 ├─ Powermix Split                 activeSubSection="powermix_split_rules"
 ├─ Master Data                    activeSubSection="knowledge_base"
 └─ Future Dispatches              activeSubSection="next_10_days"
```

The single render switch lives in `Dashboard.jsx` around lines 6895–7050. There is also a hidden `activeSection="planned"` branch (line 6971) used internally for planned-orders filtering.

---

## 1. Dashboard Section

### 1.1 Overview (`src/components/overview/OverviewDashboard.jsx`, 1,831 LOC)

**Purpose:** the daily "what's happening right now" plant cockpit.

**Layout (top to bottom):**
1. **Header row** — date selector, "Generate Shift Report" PDF button, "Feedmill Shutdown Analysis" AI button.
2. **KPI tiles** — Total Active Orders, Total Volume (MT), Completed Today, On-Going Now, Average Changeover.
3. **Per-line production bars** — one card per line (Line 1–7 except 5 grouped under Powermix) showing:
   - Currently producing order (FPR / material code / item description / running volume).
   - Progress bar (% complete based on `start_time` → `end_time` vs now).
   - Next order queued up.
   - Day's completed volume.
4. **Status breakdown donut/bar** — counts by status: `Plotted`, `Planned`, `Cut`, `On-going`, `Done`, `Combined with other PO`, `Cancelled`.
5. **Smart Insights panel** — per-chart AI commentary (calls `POST /api/ai/overview`).
6. **Feedmill Shutdown Analysis modal** — what-if: "If FM2 goes down for 6 hours, what's the cascade impact?" Sends order list to `/api/ai/recommendations`.

**Data sources:** `Order` entity (filtered to non-cancelled), `KnowledgeBase` for run-rate lookups (`LINE_TO_RR_KEY` map in `server.js:762`).

**Dependencies:** `applyDisplayCascade()` (Dashboard.jsx ~ line 420) for live start/end times; `changeoverCalc.js` for per-transition changeover hours; `formatters.js` for MT↔bags conversion.

### 1.2 Analytics (`src/components/analytics/AnalyticsDashboard.jsx`)

**Purpose:** historical / trend view of production performance.

**Charts (Recharts):**
- Throughput (MT/day) per feed mill, last N days.
- Completion adherence (orders completed on time vs late).
- Changeover hours per day, stacked by reason (diameter, color, category).
- (Hidden) **Line Utilization** — wrapped in `{false && ...}`; deliberately hidden in the current UI.

**Filters:** date range, feed mill, line.

**Smart Insights:** `POST /api/ai/analytics` produces a per-chart short commentary.

### 1.3 Monitoring — Demand Profile (`src/components/demand/DemandProfile.jsx`, 2,431 LOC)

The "SKU Monitoring" page — visualises historical SKU demand and how active production is closing the gap.

**Filter card (5 columns):** Search SKU (span 2) · Year · Month · Upload Demand Data button · (5th column reused). When demand is sourced from order history, a subtle badge "Demand sourced from order history" appears below the filter row.

**KPI cards (4):** Total Demand, Delivered to Date, Pipeline (active orders for the period), Gap.

**Monthly Demand Profile heatmap:** 12-month grid per FG showing volume distribution and annual total. The FG Code and Item Description columns are shaded `#f3f4f6`; Total Annual (MT) column is centered.

**Detailed Demand View (matrix table):**
- Per-FG row with month columns showing Historical Demand (MT) and Delivered to Date (year-agnostic match).
- Same light-gray shading on the description columns; heatmap cells exempted.

**Time Grain filter:** internally supports `monthly` / `quarterly` / `yearly` / `daily` but the UI control is hidden — locked to monthly.

**Data sources (priority order):**
1. **Uploaded dataset** (XLSX/JSON via `demandUploadParser.js`, in-memory state `uploadedDataset`).
2. **Static JSON** under `public/data/demand_monthly.json`, `demand_quarterly.json`, `demand_yearly.json`, `demand_daily_<year>.json`.
3. **Order history fallback** — `buildDemandFromOrderHistory(orders)` (DemandProfile.jsx:90) — new behaviour as of Task #11. Aggregates `done`/`completed` orders by `fg_code × YYYY-MM` of `end_date`, with timezone-safe ISO-prefix parsing. Used when no upload is active and either the JSON file is missing or has no rows for the selected year (monthly grain only). The Year filter is auto-expanded to include any year present in done-order history.

**Delivered to Date** uses the year-agnostic `matchEndDateToPeriod` (lines ~109–135) and stays unchanged from order-history fallback.

**AI Demand Insights:** an expandable panel that calls Azure OpenAI for narrative analysis of the demand matrix.

---

## 2. Orders Section

### 2.1 Shared: `OrderTable.jsx` (7,605 LOC)

The core grid used by All Feedmills, FM1, FM2, FM3, and Powermix. Differences between views are driven by `activeFeedmill` and per-line filtering.

**Standard columns** (varies slightly per view):
- **#** — visual sequence index.
- **FPR / Planned Order ID** (`planned_order_id`).
- **Material Code** + **Item Description**.
- **Volume (MT)** — `volume_override ?? total_volume_mt`, editable inline.
- **Readiness** — tiered icon:
  - Tier 1 (red) Missing Critical: no `material_code_fg`, no volume, etc.
  - Tier 2 (amber) Missing HA / Prod Order.
  - Tier 3 (green) Ready.
  Computed by `getReadinessTier`; the tooltip enumerates exactly what is missing.
- **Status dropdown** — `StatusDropdown.jsx`. Status transitions: `Plotted → Planned → Cut → On-going → Done`. Other statuses: `Combined with other PO`, `Cancelled`.
- **Start Date / Start Time** — user can override; never cascades.
- **End Date / End Time / Completion** — cascades downstream when changed.
- **Avail Date** (`target_avail_date`) — when the FG is needed for dispatch. Year inference shows a warning badge if the inferred date is unrealistically far in past/future.
- **Changeover** — `_changeoverTotal` = base + additional (from `calculateAdditionalChangeover`). Tooltip shows the breakdown (which rules fired).
- **HA Info / Prod Order #** — auxiliary planning info.
- **Remarks** (`RemarksCell.jsx`) — free-text per order.
- **Row highlight color** — user-selectable, persisted via `/api/row-highlights`.
- **Cell comments** — per-(order, column) comment popover (`CellCommentPopover.jsx`), `/api/cell-comments`.

**Row actions / context menu** (`OrderContextMenu.jsx`):
- Edit, Cancel (with reason), Cut, Combine, Uncombine, Divert (to another line), Restore, Mark Done, Revert to Production, Merge Back, Produce as Independent, Min-volume check.

**Drag and drop:** reordering with conflict detection (`OrderTable.jsx:553`) — drop is rejected if it violates chronological `target_avail_date` order.

**Top-bar tools (above table):**
- **Search/filter** — `OrderTableFilters.jsx` + `SearchFilter.jsx`.
- **Add Order** — `AddOrderDialog.jsx`.
- **Upload** — `UploadModal.jsx` (XLSX/JSON ingest of new orders).
- **Auto-Sequence buttons** — three modal variants:
  - `AutoSequenceModal.jsx` (legacy/generic).
  - `FeedmillAutoSequenceModal.jsx` (per-feedmill optimisation).
  - `LineAutoSequenceModal.jsx` (single line).
  - `PlantAutoSequenceModal.jsx` (whole plant, cross-FM moves).
  - `UploadAutoSequenceModal.jsx` (suggest sequence at ingest time).
  - Strategies (`src/services/aiSequenceStrategies.js`): Profit Optimized, Lead Time, Balanced.
- **Export** — `ExportButton.jsx` (XLSX/PDF download).
- **Smart Combine panel** — `SmartCombinePanel.jsx` (hidden behind `SHOW_SMART_COMBINE_PANEL` flag, only in `orders` / `planned` views).
- **Smart Recommendations** — `SmartRecommendations.jsx` driven by `/api/ai/recommendations`.
- **Insight Alerts panel** — `InsightAlertsPanel.jsx` driven by `/api/ai/alerts`.
- **Key Metrics strip** — `KeyMetrics.jsx`.

**Scheduling cascade** (`applyDisplayCascade`, Dashboard.jsx ~420):
- Iterates each line's active orders in sequence.
- For each order: `start_time = previousOrder.end_time + previousOrder._changeoverTotal`, `end_time = start_time + (volume / run_rate)`.
- **Start Date/Time never cascade** — only Completion (end_time) does.
- User-set Start overrides freeze the chain at that point.
- Orders with status `Done` are **frozen** (use their actual end_timestamp as the cascade anchor for the next order).

**Conflict detection:** when a user drags or auto-sequence proposes a reorder, the system checks that resulting `end_time` ≤ `target_avail_date` for each order; otherwise the row is flagged.

### 2.2 All Feedmills view
- One consolidated table with rows from every line. Sorting/filtering options include FM and line.
- Useful for cross-FM moves and global auto-sequence.

### 2.3 Feedmill 1 (Lines 1 & 2), Feedmill 2 (Lines 3 & 4), Feedmill 3 (Lines 6 & 7)
- Use `FeedmillTabs.jsx` to switch between the two lines belonging to that FM.
- Same `OrderTable` but pre-filtered.
- "Auto-Sequence Feedmill" optimises only within those two lines.

### 2.4 Powermix (Line 5)
- Has additional fields: `pmx`, `sfgpmx`, **diameter**, batch sizing (2 or 4), `is_powermix_generated`, `powermix_source_order_id`, `powermix_rule_id`, `powermix_split_subtext`, `prod_remarks`.
- Powermix is **NOT** governed by changeover rules (`LINE_TO_FM["Line 5"] = null`).
- Driven by the **Powermix Split Rules** (configurable — see §3.3). Each rule splits a parent FG's volume into one or more SFG (semi-finished good) batches that run on Line 5 or are diverted to FM lines.
- `POST /api/powermix/apply-all` and `/api/powermix/sync-source/:sourceId` regenerate child orders when source orders change.

### 2.5 Combining orders
- `CutCombineModal.jsx`, `MergeBackDialog.jsx`, `UncombineOrderDialog.jsx`, `ProduceAsIndependentDialog.jsx`.
- Combined orders are **always contiguous** in the sequence.
- Per-line volume limits apply.
- Status `Combined with other PO` keeps the child's history but suppresses it from active production (it feeds the parent's run).
- "Pre-combine" columns (`pre_combine_status`, `pre_combine_line`, `pre_combine_prio`, `pre_combine_partner_id`, `pre_combine_original_volume`) remember the original state so Uncombine can restore it.

---

## 3. Configurations Section

### 3.1 Order History (`OrderHistoryModal.jsx` + `OrderHistoryViewer.jsx`)
- **Purpose:** audit log of every status change, edit, deletion, and a restore mechanism.
- **Filters:** date range, status, line, search by FPR / material code.
- **Restore:** cancelled orders can be reactivated via `RestoreOrderDialog.jsx` (reapplies its previous status).
- **Frozen state:** completed orders display the `frozen_changeover` + `frozen_changeover_breakdown` captured at completion (so historical changeover doesn't drift if rules change later).

### 3.2 Changeover Rules (`src/pages/ChangeoverRulesPage.jsx`)
- UI to edit the values that feed `src/utils/changeoverCalc.js`.
- **Rules (per FM1/FM2/FM3):**
  | Rule | Type | Trigger | Default (hrs) |
  | --- | --- | --- | --- |
  | Change Pellet Diameter | `diameter_change` | curDiam ≠ nxtDiam | FM1 1.50, FM2 1.00, FM3 1.00 |
  | Color Yellow ↔ Brown | `color_yellow_brown` | within {yellow, brown} | 0.33 |
  | Color Red → Any | `color_red_out` | DIRECTIONAL outgoing | 1.00 |
  | Color Green → Any | `color_green_out` | DIRECTIONAL outgoing | 1.00 |
  | Color Any → Red/Green | `color_to_red_green` | DIRECTIONAL incoming | 0.50 |
  | Category change | `category_change` | curCat ≠ nxtCat (e.g. Swine → Poultry) | 0.33 |
- Persisted in localStorage (with a fallback hard-coded in `getFallbackChangeoverRules()`).
- **Important rule semantics:** values **stack** — one transition can trigger multiple rules and they add together. Color rules are directional.
- **Single source of truth:** `changeoverCalc.js` is consumed both by `applyChangeoverEnrichment` (Dashboard) and by the AI sequencing service (`aiSequenceStrategies.js`), which calls `buildDynamicChangeoverPromptSection` so the prompt always reflects the user's live rules.

### 3.3 Powermix Split (`PowermixSplitRulesPage.jsx`)
- **Purpose:** define how a Powermix-bound FG is broken into one or more SFG production runs.
- **Schema (`powermix_split_rules` table):**
  - `fg_code`, `fg_description`
  - `sfg_material_code`, `sfg_description`
  - `target_line` (Line 5 or a feed-mill line)
  - `percentage` (split share of parent volume)
  - `batch_size` (2 or 4)
  - `is_active`, `remarks`, timestamps
- Seeded with 6 default rules at first run (`POWERMIX_SEED_RULES` in `server.js:30`). Batch sizes are corrected to {2, 4} via `BATCH_CORRECTIONS`.
- CRUD endpoints: `GET/POST /api/powermix-split-rules`, `PUT/DELETE /api/powermix-split-rules/:id`.
- Applying rules: `POST /api/powermix/apply-all` re-scans every active Powermix order and regenerates child orders; `POST /api/powermix/sync-source/:sourceId` does it for one source.
- Generated child orders carry `is_powermix_generated=true` and reference back to the source via `powermix_source_order_id`.

### 3.4 Master Data (`KnowledgeBaseManager.jsx`)
- **Purpose:** CRUD over the `knowledge_base` table — per-FG metadata used by scheduling and AI.
- **Fields:** material code, description, **category** (e.g. Swine/Poultry), **color**, **diameter**, **changeover** (base hrs override), **run rate per line** (`LINE_TO_RR_KEY` map: e.g. `rr_l1`, `rr_l2`, …), `packaging` (sacks/tags), `pricing_php`, `margin`.
- **Upload:** `KnowledgeBaseUpload` entity stores history of master-data uploads. Each upload may contain a `snapshot_json` so a prior version can be diffed.
- Used by run-rate computations (cascade), changeover enrichment (color/diameter/category), AI prompts.

### 3.5 Future Dispatches / N10D (`Next10DaysManager.jsx`)
- **Purpose:** ingest the next-10-days dispatch plan from logistics to set `target_avail_date` and `priority_seq` for FG codes.
- **Tables:** `next_10_days_records`, `next_10_days_uploads`.
- **Behaviour after upload:**
  - Matches records to active orders by `material_code_fg`.
  - For each match, may set `n10d_update_available = true` and stash `n10d_update_new_date` so the planner can review/accept the change in `PendingRevertDialog.jsx`-style UX rather than silently overwriting.
  - Tracks `last_n10d_update` timestamp per order, plus `date_source`, `inferred_target_date`, `inferred_target_label`, `has_manual_override`, `manual_edit_date`.
- Feeds the SKU Monitoring "Pipeline" KPI and the demand-vs-plan reconciliation.

---

## 4. AI Subsystem

### 4.1 Server endpoints (all `POST`, all backed by Azure OpenAI `gpt-4.1-mini`)
| Endpoint | Used by |
| --- | --- |
| `/api/ai/chat` | `AIChatbot.jsx` |
| `/api/ai/recommendations` | `SmartRecommendations.jsx`, Shutdown Analysis |
| `/api/ai/alerts` | `InsightAlertsPanel.jsx` |
| `/api/ai/overview` | Overview Smart Insights |
| `/api/ai/analytics` | Analytics Smart Insights |
| `/api/ai/report_insight` | Shift Report PDF commentary |
| `/api/ai/auto-sequence` | Auto-Sequence modals |
| `/api/ai/suggest-start` | "Suggest start time" helpers |

### 4.2 `src/services/azureAI.js`
Thin client around the server endpoints; handles streaming, prompt templating, fallbacks.

### 4.3 `src/services/aiSequenceStrategies.js`
- Strategies: **Profit Optimized** (margin × volume), **Lead Time** (earliest avail dates first), **Balanced** (changeover-minimised).
- Constructs prompts using `buildDynamicChangeoverPromptSection(rules, lineKey)` so the AI always sees current changeover rules, including per-line nuances.
- Returns a proposed sequence which is then validated and shown in the auto-sequence modal for the user to accept/reject before mutating orders.

### 4.4 `AIChatbot.jsx` (`src/components/chat/AIChatbot.jsx`, 554 LOC)
- Floating chat panel available on every view.
- Sends current orders, knowledge base, and N10D records (filtered to current view) as context.
- Supports streaming responses, conversation history (in-memory), and action shortcuts (e.g. "auto-sequence FM2").

---

## 5. Backend (`server.js`, 1,498 LOC)

### 5.1 Generic entity API
- Entities registered in `TABLE_MAP`:
  - `Order` → `orders`
  - `KnowledgeBase` → `knowledge_base`
  - `KnowledgeBaseUpload` → `knowledge_base_uploads`
  - `Next10DaysRecord` → `next_10_days_records`
  - `Next10DaysUpload` → `next_10_days_uploads`
- Routes (mounted ~line 398–698):
  - `GET    /api/entities/:entity` — list with `?sort=` and `?<col>=val` filters.
  - `POST   /api/entities/:entity` — create.
  - `POST   /api/entities/:entity/bulk` — bulk insert.
  - `PUT    /api/entities/:entity/:id` — update.
  - `DELETE /api/entities/:entity/:id` — delete one.
  - `DELETE /api/entities/:entity` — bulk delete.
- Column whitelisting via `getTableColumns()` + `filterToValidColumns()` so unknown JSON keys are dropped instead of erroring.
- `toSnakeCase()` and `stringifyJsonFields()` ease frontend interop.

### 5.2 Specialised routes
- `GET  /api/health` — liveness.
- `GET /POST/PUT/DELETE /api/cell-comments[...]` — per-(order, column) comments.
- `GET /POST /api/row-highlights` — colour by order_id.
- `GET /POST/PUT/DELETE /api/powermix-split-rules[...]`.
- `POST /api/powermix/apply-all` and `/api/powermix/sync-source/:sourceId`.
- `POST /api/integrations/core/extract-data` — generic XLSX/CSV extractor.
- `POST /api/ai/*` — see §4.1.
- `GET /api/apps/public/prod/public-settings/by-id/:appId` — shim from the original Base44 SDK.

### 5.3 Database schema (PostgreSQL)
Created/migrated in `initTables()` (~line 130–250). Key tables:

**orders** (extensive, see ALTER TABLE statements):
- Identity: `id`, `planned_order_id`, `material_code`, `material_code_fg`, `item_description`.
- Volume: `total_volume_mt`, `volume_override`.
- Scheduling: `feedmill_line`, `priority_seq`, `start_date`, `start_time`, `end_date`, `end_time`, `target_avail_date`, `done_timestamp`.
- Changeover: `changeover_time` (base, default 0.17 hr), `frozen_changeover`, `frozen_changeover_breakdown`, `changeover_frozen_at`.
- Properties: `color`, `category`, `diameter`, `sacks`, `tags`, `prod_remarks`.
- Status: `status` plus pre-combine snapshot columns (`pre_combine_status`, `pre_combine_line`, `pre_combine_prio`, `pre_combine_partner_id`, `pre_combine_original_volume`).
- N10D: `last_n10d_update`, `n10d_update_available`, `n10d_update_new_date`, `date_source`, `inferred_target_date`, `inferred_target_label`, `has_manual_override`, `manual_edit_date`.
- Powermix lineage: `is_powermix_generated`, `powermix_source_order_id`, `powermix_rule_id`, `powermix_split_subtext`.
- Misc: `color` (row highlight), `diversion_data` JSONB.

**knowledge_base** — master FG data plus `category`, `color`, `changeover`, `pricing_php`, `margin`.

**knowledge_base_uploads** — `snapshot_json` for version history.

**next_10_days_records / next_10_days_uploads** — N10D imports.

**cell_comments** — `(order_id, column_name, comment_text, author, created_at, updated_at)`.

**row_highlights** — `(order_id PK, color)`.

**powermix_split_rules** — fields documented in §3.3.

### 5.4 Memory mode
If `DATABASE_URL` is unset, `USE_MEMORY=true` and the app runs without a real DB — schema creation is skipped. Used for ephemeral local previews; data won't persist.

### 5.5 Frontend API client (`src/api/base44Client.js`)
Wraps `fetch` against `/api/entities/:entity` with the legacy Base44 method names (`Order.list`, `Order.create`, etc.) so the rest of the app didn't need to be rewritten.

---

## 6. Authentication (`src/lib/AuthContext.jsx`)
- **Mode:** local admin / no-auth — every visitor is treated as the planner user.
- Provides `useAuth()` hook returning `{ isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin }`.
- `UserNotRegisteredError.jsx` is the only failure UI (rarely used in this mode).

---

## 7. Key Utilities

### `src/utils/changeoverCalc.js` (259 LOC)
Authoritative changeover engine. Exports:
- `LINE_TO_FM` — line→feedmill mapping.
- `normalizeColor`, `normalizeCategory`, `normalizeDiameter`, `getFmKey`.
- `calculateAdditionalChangeover(curr, next, rules)` — returns `{ total, breakdown[] }`.
- `calculateChangeoverBetween(from, to, rules)` — base + additional.
- `buildDynamicChangeoverPromptSection(rules, lineKey?)` — produces the AI-prompt block describing live rules (including a per-line section when `lineKey` is given).
- `getFallbackChangeoverRules()` — defensive fallback only.

### `src/components/utils/formatters.js`
Unit conversion (MT ↔ bags ↔ batches), time/date formatting, percentage helpers.

### `src/components/utils/orderUtils.jsx`
Status-class mapping, readiness tier classifier, shared volume helpers.

### `src/components/demand/demandUploadParser.js`
Parses XLSX/JSON for the Demand Profile upload modal. Produces the same `{ fgs, rawRows }` shape consumed by `buildCompactFromUploaded`.

### `src/lib/query-client.js`
TanStack Query client with a default `fetcher` and 30 s `staleTime`.

### `src/lib/NavigationTracker.jsx`
Lightweight pageview tracker for analytics on the navigation events.

---

## 8. Cross-Cutting Features

### 8.1 Tour Guide (`src/components/tour/TourGuide.jsx`)
- Step-through onboarding tour. Hooks into sidebar items via `data-tour="..."` attributes.

### 8.2 Cell Comments
- Click a small icon on any cell to attach a comment. Persisted via `/api/cell-comments`. Multiple comments per cell allowed (author + timestamp).
- A presence endpoint (`/api/cell-comments/presence?orderIds=...`) returns which cells have comments for badging.

### 8.3 Row Highlights
- Colour-pick per row, persisted via `/api/row-highlights`. Survives reloads.

### 8.4 Shift Report PDF
- Triggered from the Overview "Generate Shift Report" button. Server uses `puppeteer`/`pdfkit` (depending on install) and pipes back a streamed PDF with AI commentary from `/api/ai/report_insight`.

### 8.5 Excel Upload Pipeline
- `UploadModal.jsx` ingests XLSX of new planned orders.
- `Next10DaysManager.jsx` ingests dispatch schedules.
- `KnowledgeBaseManager.jsx` ingests master data.
- All three ultimately POST to `/api/integrations/core/extract-data` for parsing, then to the relevant `/api/entities/...` bulk insert.

### 8.6 Settings / Defaults stored in localStorage
- Changeover rules (so they survive without a backend table).
- Sidebar collapse state.
- Tour completion flag.

---

## 9. Important Business Rules / Gotchas

1. **Start Date/Time never cascade.** Only Completion (end_time) cascades downstream.
2. **User-set Start overrides** freeze the chain at that point — subsequent orders cascade from the override, not from the prior order's end time.
3. **Orders marked `Done` are frozen in the cascade** (their actual `done_timestamp` is the anchor for the next order's `start_time`).
4. **Combining is always contiguous** and obeys per-line volume limits; child orders move to status `Combined with other PO`.
5. **Powermix (Line 5) is exempt from changeover rules** (`LINE_TO_FM["Line 5"] = null`). Changeover calculations skip it entirely.
6. **Changeover values stack** — diameter + color + category penalties can all fire on one transition and add together.
7. **Color rules are directional** — `Red → Any` ≠ `Any → Red`.
8. **`frozen_changeover_breakdown`** is captured the moment an order completes so the audit log shows what was actually paid, even if rules later change. A corrective migration in `initTables()` un-back-fills any rows wrongly populated with just the base value.
9. **N10D updates don't auto-apply** — they raise `n10d_update_available=true` so the planner can review.
10. **Avail Date year inference** shows a warning if the inferred date is significantly past/future.
11. **Demand source priority** (Detailed Demand View): uploaded XLSX/JSON > static JSON file > done-order history fallback (monthly only, strict `YYYY-MM` matching). Delivered-to-Date uses year-agnostic matching independently.
12. **Powermix Split Rules apply on a Powermix order's lifecycle:** changing the source order calls `/api/powermix/sync-source/:sourceId` to regenerate children with correct percentages and batch sizes.
13. **Time Grain filter on Demand is hidden** — monthly only in current UI.
14. **Line Utilization chart on Analytics is hidden** behind `{false && ...}` — intentional, do not remove.

---

## 10. File Map (most relevant)

```
server.js                                 Express backend + DB migrations + AI proxy
src/App.jsx                               Router + providers
src/Layout.jsx                            Sidebar + Header shell
src/pages.config.js                       Auto-registered pages (only Dashboard)
src/pages/Dashboard.jsx                   Main app shell, view switcher, scheduling cascade
src/pages/ChangeoverRulesPage.jsx         Editor for changeover rule values
src/lib/AuthContext.jsx                   Local admin auth
src/lib/query-client.js                   TanStack Query setup
src/lib/NavigationTracker.jsx             Pageview tracking
src/api/base44Client.js                   Entity API client (legacy Base44 surface)
src/components/layout/Header.jsx
src/components/layout/Sidebar.jsx         3 collapsible sections, line badges
src/components/overview/OverviewDashboard.jsx
src/components/analytics/AnalyticsDashboard.jsx
src/components/demand/DemandProfile.jsx   SKU monitoring page (2,431 LOC)
src/components/demand/demandUploadParser.js
src/components/orders/OrderTable.jsx      Core grid (7,605 LOC)
src/components/orders/AddOrderDialog.jsx
src/components/orders/UploadModal.jsx
src/components/orders/AutoSequenceModal.jsx
src/components/orders/FeedmillAutoSequenceModal.jsx
src/components/orders/LineAutoSequenceModal.jsx
src/components/orders/PlantAutoSequenceModal.jsx
src/components/orders/UploadAutoSequenceModal.jsx
src/components/orders/CutCombineModal.jsx
src/components/orders/CutOrderDialog.jsx
src/components/orders/MergeBackDialog.jsx
src/components/orders/UncombineOrderDialog.jsx
src/components/orders/DivertOrderDialog.jsx
src/components/orders/CancelOrderDialog.jsx
src/components/orders/RestoreOrderDialog.jsx
src/components/orders/PendingRevertDialog.jsx
src/components/orders/ProduceAsIndependentDialog.jsx
src/components/orders/ReasonDialog.jsx
src/components/orders/ConfirmDialog.jsx
src/components/orders/MinVolumeCheckDialog.jsx
src/components/orders/OrderContextMenu.jsx
src/components/orders/OrderHistoryModal.jsx
src/components/orders/OrderHistoryViewer.jsx
src/components/orders/OrderTableFilters.jsx
src/components/orders/SearchFilter.jsx
src/components/orders/FeedmillTabs.jsx
src/components/orders/PlannedOrdersContent.jsx
src/components/orders/PowermixSplitRulesPage.jsx
src/components/orders/Next10DaysManager.jsx
src/components/orders/KnowledgeBaseManager.jsx
src/components/orders/KeyMetrics.jsx
src/components/orders/AlertsSection.jsx
src/components/orders/InsightAlertsPanel.jsx
src/components/orders/SmartRecommendations.jsx
src/components/orders/SmartCombinePanel.jsx
src/components/orders/ExportButton.jsx
src/components/orders/CellCommentPopover.jsx
src/components/orders/RemarksCell.jsx
src/components/orders/StatusDropdown.jsx
src/components/chat/AIChatbot.jsx
src/components/tour/TourGuide.jsx
src/components/UserNotRegisteredError.jsx
src/components/utils/formatters.js
src/components/utils/orderUtils.jsx
src/services/azureAI.js
src/services/aiSequenceStrategies.js
src/utils/changeoverCalc.js               SINGLE SOURCE OF TRUTH for changeover logic
public/data/demand_monthly.json           Static demand benchmark (fallback)
public/data/demand_quarterly.json
public/data/demand_yearly.json
public/data/demand_daily_<year>.json
```

---

## 11. Environment Variables

| Var | Purpose | Where |
| --- | --- | --- |
| `DATABASE_URL` | Postgres connection (auto-set by Replit). Absent → in-memory mode. | `server.js` |
| `VITE_AZURE_OPENAI_KEY` | Azure OpenAI API key. | server.js (AI endpoints) |
| `PORT` | Server port (default 5000). | `server.js:1474` |

Azure config constants (server.js:1289–1292):
- Endpoint: `https://nexfeed-ai.cognitiveservices.azure.com`
- Deployment: `gpt-4.1-mini`
- API version: `2024-12-01-preview`

---

## 12. Running

```bash
npm run dev          # Vite + Express, single port 5000
```

The "Start application" workflow in Replit runs this automatically.

---

_Last regenerated: 2026-05-20. After major feature additions (new pages, new statuses, schema changes, new AI endpoints, navigation re-orgs), regenerate this document so the AI prompt-helper stays in sync._
