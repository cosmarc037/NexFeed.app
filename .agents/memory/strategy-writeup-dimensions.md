---
name: Strategy-card writeup dimensions (header + narrative)
description: How the Plant Auto-Sequence strategy-card header title and narrative decide which AI-effected dimensions to surface, and why they must share one gate.
---

The strategy-card "writeup" (header title + italic narrative) must surface ONLY changes the AI sequencing actually effected, measured from real data — never invented. Four dimensions can appear: MTS advancement, changeover, profitability (margin front-loading), velocity (volatile-demand front-loading).

**Rule:** header and narrative read from ONE shared `flexRefinement` computation (front/back-half concentration over the Flexible orders only — same filter that excludes MTO + Critical/Urgent/Monitor). Never compute the same signal twice in two places, or the title and body will silently disagree.

**Gates:**
- profitability (margin): front-half avg `_margin` > back-half avg * 1.1, both halves having positive margin data.
- velocity: front-half avg volatility > back-half + 0.3, scoring Erratic=2 / Less Stable=1 / Stable=0 — AND only when margin did NOT already explain the front-loading (`!marginFrontLoaded`). Velocity is a secondary tiebreaker, so it must defer to margin.

**Why:** velocity & margin front-loading are often side effects of the same reorder; crediting both double-counts and over-claims. Mutual exclusivity keeps attribution honest.

**Wording trap:** the velocity score lumps Less Stable with Erratic, so the gate can fire with zero Erratic orders. Never say "erratic" in the surfaced text on the strength of that gate alone — say "less-stable / volatile demand" instead, or it's a factually false claim.

**How to apply:** any new writeup dimension goes through the shared gate, defers correctly to higher-priority dimensions, and its wording must be true for the weakest data that can trip its threshold. `_margin` (aiSequenceStrategies stamp) and `_velocity` (sequencePreCompute stamp; 'Stable'|'Less Stable'|'Erratic'|null) missing → score 0 → no false clause. Note: `buildNarrative()` is NOT called for AI strategies (their body = `utilizationInsight` + appended profit/velocity notes), so deterministic body notes must be appended at the insight-join, not added inside buildNarrative.
