---
name: Changeover model consistency (risk vs metric)
description: Every per-order changeover simulation in aiSequenceStrategies.js must use the same "rules fire → total only, else base only" model, or the no-regression risk guard silently breaks.
---

# Changeover model must be identical across every per-order simulation

There are several places in `src/services/aiSequenceStrategies.js` that walk an
order list and compute per-order changeover to build a wall-clock timeline or a
changeover total:

- `calculateTotalChangeoverTime` — the canonical/source-of-truth model.
- `computeAtRiskOrders` — drives the delay-risk count + the no-regression guard.
- the utilization-distribution loop (display hours per avail bucket).

**The rule:** for an active order with a following active order, when changeover
rules fire use the rules **total only** — base is DROPPED; when no rules fire use
**base only**. NEVER base + total. (`calculateAdditionalChangeover` returns a
`usedBaseOnly` flag that encodes exactly this choice.)

**Why:** these functions drifted. `computeAtRiskOrders` used `base + additional`
while `calculateTotalChangeoverTime` used `usedBaseOnly ? base : total`. The risk
timeline therefore over-counted changeover and disagreed with the changeover
metric. That broke the "AI strategy may never add delay risk beyond Standard"
safeguard: candidates were accepted / repaired under a different timing model
than the one shown on the cards.

**How to apply:** any time you add or edit a per-order changeover walk, copy the
exact branch from `calculateTotalChangeoverTime` (done/frozen handling +
`usedBaseOnly ? base : total`). If you change the model in one place, change it
in all of them in lockstep. Risk helpers that wrap `computeAtRiskOrders`
(e.g. `_riskCountFor`) should fail CLOSED (return `Infinity`) on error so the
divergence search / no-regression guard can never silently accept unsafe data.
