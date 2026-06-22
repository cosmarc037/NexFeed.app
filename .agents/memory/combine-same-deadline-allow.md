---
name: Same-deadline combines always allowed
description: Why _wouldCombineMissDeadline must never block a combine when every member shares the identical hard deadline.
---

# Same-deadline combines always allowed

## Rule
In `_wouldCombineMissDeadline` (Dashboard.jsx plant auto-sequence), after computing
`earliestDeadlineMs`, if **every** member carries the *same* hard deadline AND no member
is deadline-less (`!hasNonDeadlineMember && deadlineMsList.every(ms => ms === earliestDeadlineMs)`),
return `false` (allow the combine) BEFORE the finish-vs-deadline check.

**Why:** This engine only ever combines same-material + same-formula orders. The guard's
purpose is to stop *less-urgent* volume from delaying an *earlier-deadline* order. When all
members share one deadline, combining cannot make that deadline harder to meet than producing
them separately would — it only removes a changeover. The old guard treated EVERY ISO
`target_avail_date` as hard (in this data `avail_date_source`/`date_source` are always null and
`category` is a product family, never `'MTO'`, so the n10d/MTO exclusions never fire), so two
same-product orders both dated *today* were blocked because the merged block "can't finish by
EOD" — even though not combining doesn't help (both must run today anyway).

**How to apply:**
- Represent each member by its REAL leaf orders: if it expands (`original_order_ids` children or
  `_combinedFrom` subs), check ONLY the leaves, never the lead shell date — otherwise a lead's
  non-ISO shell date sets `hasNonDeadlineMember` and falsely suppresses the same-deadline allow.
- The risky mix (a member with a later/no deadline added to an earlier-deadline order) still runs
  the original `queue + combinedProdHours > hoursUntilDeadline` check and can still block.
- `target_avail_date` is a TEXT column: it holds either an ISO date OR a reason string
  ("safety stocks", "prio replenishment"). Non-ISO values are treated as no hard deadline.
