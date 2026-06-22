---
name: Load-aware AI sequencing
description: How the plant-level Auto-Sequence AI is told day-by-day capacity so it places flexible orders on underloaded days itself, and why prompt and gap-fill must agree on the threshold.
---

# Load-aware AI sequencing (plant-level Auto-Sequence)

The AI prompt (`buildLineStrategyPrompt`) and the deterministic gap-fill pass
(`applyGapFillingPass`) must agree on the SAME capacity model, or the AI keeps
proposing dates the gap-fill pass then moves — which surfaces as AI-vs-Final
drift in the transparency table.

**The rule:** the capacity numbers shown to the AI and the numbers gap-fill acts
on are one source of truth — module constants `DAY_CAPACITY_HOURS` (24) and
`UNDERLOADED_THRESHOLD_HOURS` (12). Gap-fill's secondary-MTS threshold is still
16 (less aggressive when MTS isn't primary). If you tune the day capacity or the
underloaded threshold, change the constant — never hardcode it in one place only.

**Why:** the whole point of load-awareness is that the AI places flexible orders
on underloaded days up front so refinement has little left to correct. If the AI
were told a different threshold than gap-fill uses, it would "balance" to the
wrong target and drift would not shrink.

**How to apply / gotchas:**
- The day-load profile in the prompt is the PRELIMINARY profile (bucketed by
  `current_avail_date`, hours = production + changeover). The AI has not re-placed
  orders yet — this is acceptable per spec (a planning hint, not a final sim).
- The load-aware prompt RULE is scoped to `is_flexible` orders only and is
  explicitly subordinate to all hard constraints (mash/MTO/Critical/Urgent/
  Monitor/completion-feasibility). Keep it that way — it must never override.
- `lockedCapacityByDay` is empty at prompt time: in-production orders are frozen
  at the front and are NOT in `lineOrders`, so no locked capacity is visible there.
- Three temporary debug logs exist (spec-mandated): `[Auto-Sequence AI Load
  Context]`, `[Auto-Sequence AI Underloaded-Day Placement]`,
  `[Auto-Sequence AI vs Gap-Fill Drift]`. Safe to remove after validation.
- Scope is plant-level only; Line/Feedmill paths were intentionally excluded.
