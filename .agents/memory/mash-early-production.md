---
name: Mash early-production allowance
description: Why mash (form 'M') orders are scheduled before their avail/target date and what must stay in sync across the AI sequencing passes.
---

# Mash early-production allowance (AI Auto-Sequence)

Mash products (form `'M'`, occasionally `"Mash"`) must be produced EARLY — within
`[max(today+2, avail − MASH_ALLOWANCE_DAYS), avail]` — for BOTH MTO and MTS, and
NEVER later than their avail/target date. This deliberately OVERRIDES the
otherwise-immutable MTO "verbatim avail date" contract, but only for mash.

**Why:** client requirement — mash has no pellet die and is wanted on hand ahead
of its date as a production buffer. Producing on-time-or-late defeats the purpose.

**How to apply (the non-obvious part):** the date is set once in
`resolveSuggestedDate` (mash branch placed BEFORE the `isMTO` branch so mash MTO
isn't pinned), but the AI sequencing engine has several LATER passes that mutate
`_aiSuggestedDate` and key off `isMTO`/`isProtectedOrder`/`isCritical` — they all
needed a mash carve-out or mash would drift past avail:
- `isProtectedOrder` must include `isMash` (keeps capacity-packing off mash).
- `enforceCompletionFeasibility` forward-bump guard must exclude mash.
- `applyGapFillingPass` candidate filter must exclude mash.
- A final invariant clamp in `applyLineAIStrategy` (after gap-fill, before the
  final re-sort) re-clamps every mash date into `[floor, avail]` as
  defense-in-depth.
**Lesson:** any new pass that moves `_aiSuggestedDate` must treat mash as a
date-protected class, or re-verify the final clamp still runs after it.

**Overdue edge case:** when `avail < today+2` the window inverts. Producing
before a past date is impossible, so the only correct behavior is "earliest
feasible" (today+2). The "never later than avail" rule cannot hold once avail is
itself in the past — this is intentional, not a bug. Handled identically in both
`resolveSuggestedDate` (overdue branch → today+2) and the final clamp.

Allowance window size lives in the module constant `MASH_ALLOWANCE_DAYS` (currently 3 — "avail/target + 3 days in advance" per manager; grep the constant for the live value).
The per-line prompt (`buildLineStrategyPrompt`) exposes `is_mash` +
`mash_earliest_date` and a RULE-1 mash carve-out so the AI proposes early dates;
the deterministic clamp enforces it regardless of what the AI returns.
