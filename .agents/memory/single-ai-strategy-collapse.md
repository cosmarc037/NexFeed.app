---
name: Single-AI-strategy collapse
description: When the second AI Auto-Sequence option is not a materially different OUTCOME, drop it and show one AI strategy + Standard + an explanation banner. Standard always stays. No risk regression vs Standard.
---

# AI Auto-Sequence: collapse to a single AI strategy

A line shows TWO AI strategy cards ONLY when the second is a genuinely distinct
scheduling **outcome** vs the first — measured on the resulting schedule, not the
title/narrative. Axes (`areStrategyOutcomesMateriallyDifferent`): sequence/dates,
total changeover (>0.25h), avg utilization (>1.0%), at-risk count or severity,
profit-advancement index (margin-weighted mean position, ≥1.5 slots). If none
differ → drop `ai_option_2` and surface `lineStrategies.singleStrategyReason`.

**Standard (`rule_based`) is never dropped** — it is the always-present baseline.

**Order of operations in `generateLineStrategies`:**
1. Build opt1/opt2, then a multi-axis divergence search (changeover-min →
   profit/volume → risk-min EDF) tries to replace a non-distinct opt2 with a
   distinct, no-regression alternative.
2. Metric stamping.
3. No-regression risk guard runs BEFORE the collapse decision.
4. Collapse decision compares the post-guard outcomes.

**Why guard before collapse:** the collapse comparator reads the post-repair
risk/util/CO metrics, so risk repair must already be applied or the comparison
runs against stale (pre-repair) numbers.

**No-regression invariant:** an AI option may NEVER have more at-risk orders than
Standard. `_repairRiskRegression` first tries an EDF rebuild, else clamps the
option to Standard's own sequence (zero regression by construction). Shared
unavoidable risk that Standard also carries is acceptable.

**How to apply:** any consumer of a line's strategies must treat `ai_option_2`
as nullable — use `.filter(Boolean)` for lists and `|| rule_based` fallbacks in
apply/refresh paths (live + demo share the same path via `isDemo`).
`determineLineRecommendation` already filters falsy candidates.
