---
name: Within-date CO micro-reorder
description: How the intra-day changeover sort works in pure-AI mode and why it exists.
---

## The rule
After the AI's position sort in pure-AI mode (`applyLineAIStrategy`, ~line 5917), run `_applyWithinDateChangeoverSort(ordersAfter, changeoverRules)` to cluster non-protected flexible orders within each same-date bucket by greedy nearest-neighbor changeover minimization.

**Why:** In pure-AI mode the AI assigns dates (MTS advancement) but leaves intra-day ordering at arbitrary AI positions. Same-date flexible orders that share compatible material/color/diameter were not adjacent → Time-saved showed 0.00 hr even when the AI said changeover reduction was secondary.

**How to apply:**
- Applied to EVERY strategy (not just CO-primary), since it's a free improvement that never changes `_aiSuggestedDate`
- Protected orders (`isProtectedOrder` = MTO / Mash / Critical / Urgent / Monitor) keep their relative positions within the bucket
- Logs `[Within-Date CO Micro-Reorder]` with before/after changeover totals and IMPROVED / NEUTRAL verdict
- The same pattern should be applied if a new AI sequencing path is added (e.g. plant-wide strategies using `applyPlantwideAIStrategy`)

**Note:** Deterministic post-generation summary "enrichment" patches were removed — AI strategy text (changeover/MTS/profitability summaries) is now used verbatim. Measured-fact alignment is achieved by making the AI compute its own `computed_impact` block and run a `self_consistency_audit` before writing the narrative, not by appending facts after the fact.
