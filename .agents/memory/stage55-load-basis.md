---
name: Stage 5.5 rebalance load basis
description: How the plant-wide AI load-rebalance (Stage 5.5) must measure per-line load, and why it must mirror the summary table exactly.
---

# Stage 5.5 rebalance load basis

The Stage 5.5 "Plant-Wide AI Load Rebalance" per-line load metric
(`computeLineQueueHours` in `src/services/plantRebalanceAI.js`) must be a
byte-for-byte mirror of the plant summary table's "Total Hrs" column. Both now go
through the shared `src/utils/lineHours.js` helper — `computeLineQueueHours` sums
`orderProductionHours + orderChangeoverHours`, and `calculateLineHoursBreakdown`
(Dashboard) delegates to `lineHoursBreakdown`. The per-order production basis is
`effVol ÷ own run_rate` (Mash → 0; stored only when `production_hours_manual && >0`),
**plus** `_changeoverTotal ?? changeover_time ?? 0` once per order. See
production-time-display-parity for why stored `production_hours` must NOT be summed.

- **Changeover added once.** `_changeoverTotal` is the FINAL row changeover (not
  additional-only); adding base+total double-counts.
- Feed it the **Stage-5 post-placement (pre-5.5) snapshot** — i.e.
  `result.sequencedByLine`, whose orders already carry `production_hours` +
  `_changeoverTotal` set by `applyPreviewChangeovers` during
  `plantLevelCombineAndPlace`. Do NOT feed the "Pre-Determined Line" Total Hrs
  shown at the very beginning — that is a stale beginning-state value, further
  processed before reaching Stage 5.5.

**Why:** the original metric used flat `MT ÷ LINE_RUN_RATES` with NO changeover,
so the AI judged a line "overloaded" on a basis the summary table never showed,
producing diversions (e.g. Line 7 → Line 6) that looked wrong to the user.

**How to apply:** if you ever touch the Stage 5.5 load metric, re-mirror
`calculateLineHoursBreakdown`. If that table's basis changes, change this in
lockstep.

**Anti-overshoot guard (RESOLVED):** `applyDiversions` now enforces a
no-regression rule. Each diversion is evaluated **sequentially against the
running post-prior-move state**: it computes the two affected lines' load
(`orderLoadHours = orderProductionHours + orderChangeoverHours`, same lineHours
basis) and **rejects** the move when
`max(afterFrom, afterTo) > max(fromBefore, toBefore) + REGRESSION_TOLERANCE_HOURS`
(0.01h). Rejected moves go to a returned `skippedDiversions[]`
(carrying `beforeMaxHours`/`afterMaxHours`) surfaced in the trace; both callers
(Dashboard live path, server.js trace) destructure it (backward-compatible).
**Why no MTO carve-out:** a genuine MTO-protection move relieves the heaviest
line and does not create a worse destination peak, so it passes naturally;
allowing a move that *does* create a worse peak under an MTO label would just
reintroduce the overshoot bug. Checking only the two affected lines is complete —
all other line arrays are untouched by that candidate, so they cannot regress.
**Limitation:** the guard is exact only on the current load model — it does not
simulate destination-specific run-rate changes or new adjacency changeovers after
a move. If future work recomputes those on diversion, extend the simulation.
