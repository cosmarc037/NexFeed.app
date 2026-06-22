---
name: Completion-time line scoring
description: Plant Auto-Sequence line picker must weigh each order's own run-time, not just queue time, or it inflates the net production-hours metric.
---

# Completion-time line scoring

`_scoreLineForOrder` (the Plant Auto-Sequence line picker in `plantLevelCombineAndPlace`, `src/pages/Dashboard.jsx`) scores candidate lines as:

```
score = queueHrs + (RUN_RATE_WEIGHT * ownProdHrs) + dieChangePenalty - clusterBonus
   ownProdHrs = placementVolume / getProductRunRateOnLine(order, line)   (fallback: line default rate)
```

**Why:** Scoring on queue time alone makes an idle slow line (10 MT/hr) always beat a moderately-loaded fast line (20 MT/hr), so orders get diverted onto slower lines and the "Net Hours Change (Production Time)" figure in the Per-Line Summary balloons (was +19.20 hr). The own-production-hours term makes the score completion-time aware (Shortest-Completion-Time at W=1): a slow line only wins when the fast line's backlog is long enough that the slow line still finishes the order sooner.

**How to apply:**
- All terms are in **hours** — keep any new term unit-consistent or the weighting breaks.
- The scorer needs the *actual placement volume*: combine path passes `finalCombinedVolume`, single-order path passes `orderVolume`. Don't score the bare lead order's volume on the combine path.
- `RUN_RATE_WEIGHT` (W) is the single tuning knob: 1 = balanced; >1 biases harder toward fast lines (more hours saved, small fast-line congestion risk).
- This only reorders preference among *already-eligible* lines — it must never bypass deadline guards, shutdown exclusion, Line 5 Powermix line-lock, planned-line lock, or `canProduceOnLine`.
- Caveat: `getProductRunRateOnLine` matches on FG/material_code, but generated PMX orders are eligibility-gated on `kb_sfg_material_code`; for generated orders the own-hours term often falls back to the line default rate. Acceptable (PMX source orders are line-locked anyway), but a known fidelity gap if revisited.
