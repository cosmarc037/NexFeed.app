---
name: Production-time display parity
description: Why OrderTable must recompute production hours from effective volume / run rate instead of trusting stored production_hours.
---

# Production-time display parity

The displayed **Production Time** for an order must equal *batch-ceiling-adjusted
(displayed) volume ÷ displayed run rate*. Three places compute it and they must agree:

- `calcProductionHours` (Dashboard.jsx cascade) — uses `getEffVolume` (ceil(raw/bs)*bs) / `run_rate`.
- `calcOrderEnd` (PlantAutoSequenceModal.jsx) — uses `getOrderVolumeDisplayState().displayVolume` / `run_rate`.
- OrderTable.jsx production-time cell (`effectiveProdHours`).

**Rule:** OrderTable must NOT prefer the stored `order.production_hours` for normal
orders — recompute `effVol / effectiveRunRate`. Preserve stored hours only when
manual (`production_hours_manual === true`) or Mash (`form === 'M'`), and only when
`> 0` (mirror `calcOrderEnd`'s predicate exactly). Fall back to stored only when no
valid run rate.

**Why:** Generated (Powermix-split) orders persist `production_hours` computed at
generation time from the **raw** pre-batch-ceiling volume (e.g. 111.36 MT), while the
volume column shows the ceiling-rounded value (e.g. 116 MT). Preferring the stored
value made the cell show 5.77 hrs while 116/19.30 = 6.01, so the user's manual
vol÷rate check disagreed with the UI.

**How to apply:** Any new surface that displays production hours should derive it from
the displayed volume and run rate, not the stored column, except for manual/Mash.

## Per-Line LOAD hours have ONE source of truth (`src/utils/lineHours.js`)

The Plant Auto-Sequence **Per-Line Summary "Total Hrs"** column, the **per-order
detail rows**, and the **Stage 5.5 AI load metric** must all use the *same* per-order
production-hours basis: `effVol ÷ own run_rate` (Mash `form 'M'` → 0; stored value only
when `production_hours_manual === true && > 0`). `lineHours.js` (`orderProductionHours`
/ `lineHoursBreakdown`) is that single helper; `calculateLineHoursBreakdown`
(Dashboard) and `computeLineQueueHours` (Stage 5.5) both delegate to it.

**Why:** summing the **stored** `production_hours` diverges from the detail rows on
combined orders — on merge the stored value is set from the pre-combine pieces / a
generic line rate, not the combined effVol ÷ the combined order's own (often slower)
rate. Seen both directions in one run: combined non-mash *undercounts*, combined mash
*overcounts* (standalone mash is null, but a combine left a nonzero stored value).

**Two non-obvious traps:**
1. **Mash predicate:** the detail-row "use stored" guard must key on
   `production_hours_manual` ONLY, never `|| form === 'M'`. Editing any order's hours
   sets the manual flag (incl. mash), so genuinely-manual mash is still preserved;
   keeping `|| form==='M'` instead made *auto/combine-generated* mash echo a stale
   stored value, breaking column == rows.
2. **Stage 5.5 snapshot staleness:** `plantCombinePlace` snapshots `perLineSummary`
   *before* Stage 5.5 `applyDiversions` moves orders across lines, so afterHours/
   afterMT/afterCount lag the diverted lines and the column stops equalling the rows
   even with the formula correct. After `applyDiversions`, rebuild the summary's
   `after*` fields over the post-diversion lineup (`rebuildSummaryAfterFields`) in
   *every* caller (Dashboard apply path **and** the trace replica) or they drift.

**How to apply:** any new surface showing production/line-load hours must go through
`lineHours.js`; never re-sum stored `production_hours`. If a code path mutates line
membership after the summary is built, re-derive the summary's after-fields there.
