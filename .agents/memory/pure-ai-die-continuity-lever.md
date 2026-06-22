---
name: PURE_AI die-continuity lever
description: Where production adjacency/changeover is actually decided in PURE_AI sequencing mode
---

In PURE_AI mode the FINAL production adjacency (and therefore total changeover /
die-change time) follows `_aiPosition`, which comes from `constrainedSeq` built in
`buildStrategyFromSequence` **Step 1** (`sequencePostProcess.js`). The downstream
Step-3 gap-fill ONLY relabels `suggested_date` — it does NOT reorder production.

**Why:** A natural-but-wrong assumption (and an earlier plan) treated the gap-fill
as the die-grouping lever. It is not. Any change meant to control changeover /
keep make-to-stock (Flexible) orders clustered must act on the flexible-tier
ordering in Step 1 (e.g. the "Step 1b" cluster regroup), not on the gap-fill.

**How to apply:** When asked to influence changeover, die continuity, or how MTS
orders cluster vs. advance, edit the Step-1 flexible ordering in
`buildStrategyFromSequence`. Use Step-3 only for calendar-date placement. Deadlines
stay safe regardless because Step-2 schedules against each order's ceiling
(`safe_window_end`/`effAvail`). The regroup applies to BOTH AI strategies, so they
may converge — existing strategy-collapse logic drops the duplicate card.
