---
name: Diameter-streak preservation
description: How same-diameter (die) contiguity is layered under exact-cluster grouping in both Standard and AI sequencers, and the late-set gating rule.
---

Die change (diameter) is the costliest changeover (FM1 1.50h, FM2/FM3 1.00h vs category 0.33h, color 0.33–1.00h). Sequencers prefer keeping same-diameter orders contiguous, breaking a streak only when a hard constraint forces it. This is a SEPARATE layer UNDERNEATH the exact category|color|diameter clusters — it must never split an exact cluster (those drive the C1/C2 labels).

**Standard sequence (rule_based) slack gate — the critical rule:**
The slack-aware diameter regroup must gate moves on the late-order *ID set*, NOT an aggregate late *count*. A count gate wrongly accepts a swap that makes order A late while making order B on-time (count unchanged) → violates "never make an order late". Reject any trial whose late-set contains an ID that was on-time in the baseline.

**Why:** count-only gating silently introduced new late orders. The objective is per-order: no order may newly miss its deadline.

**How to apply:** any future regroup/optimizer pass that claims "no order made late" must compare baseline vs trial late-ID sets, not counts. The slack sim runs BEFORE changeovers are applied, so it uses the same flat ~0.17h fallback the conflict resolver uses — keep the two on the same sim or their slack judgments diverge.

**AI path:** prompt promotes diameter to first-priority changeover rule + a separate "DIAMETER BLOCKS" listing (exact-cluster C1/C2 list stays unchanged). Deterministic layer emits whole exact-cluster runs grouped by diameter (never splitting a cluster); gap-fill die guard treats a day already running the same diameter as die-compatible, not just exact-cluster match.

**Shared definition:** getDiameterKey/sameDiameter in changeoverCalc.js give every sequencer one "same die" definition; unknown diameter on either side is never a match (never fabricate a streak across unknowns).

**MTS-advancement vs die-streak — the break lives in the date view, not the production order:**
When the AI deterministic path advances Flexible (MTS) orders to compress underloaded days, the die break the user actually sees is in the *effective `(suggested_date, position)` view* (the daily-utilization + resolved-rank display), which can DIVERGE from the contiguous production sequence. So a diameter-contiguous `constrainedSeq` is NOT sufficient — every step that assigns dates must preserve contiguity. Three layers must all agree, and a hard deadline (ceiling = anchor/avail for firm tiers, safe_window_end for flex, verbatim for MTO, avail for mash) ALWAYS wins over streak preservation:
1. Flexible-block emission must *continue the head's trailing diameter first* — use the diameter of the LAST known-diameter order in `head` (production-position order), never a latest-effAvail heuristic (ties pick the wrong diameter). A mixed-diameter hard head (e.g. urgent 4mm + urgent 3mm same day) makes exactly one reappearance unavoidable; continuing the tail diameter minimises it.
2. Flexible date assignment must stay MONOTONIC along the diameter-grouped sequence (floor each flex order's capacity search at the previous flex order's date). Without this, a large order bumped to a later day lets a smaller different-diameter order back-fill the earlier day and re-break the streak in the date view even though production order is clean. Floor is skipped when it would exceed the order's own ceiling (deadline wins).
3. Gap-fill advance guard rejects any move that makes a known diameter reappear after a different one (additive — can only prevent breaks).

**Why:** utilization/compression and die-streak optimised independently disagree because they read different orderings (date-view vs production-order). **How to apply:** any future change to flexible advancement/compression must be validated in the `(date, position)` view, and must keep all three layers' contiguity invariants; validate deterministically by driving `buildStrategyFromSequence` through Vite's `ssrLoadModule` (the services use extensionless imports that bare Node can't resolve).
