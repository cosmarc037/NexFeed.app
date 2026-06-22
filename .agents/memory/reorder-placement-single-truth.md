---
name: Re-order placement single source of truth
description: Why the Fulfillment-Demo re-order insertion priority must be computed once and applied verbatim, not re-derived at apply time.
---

# Re-order placement: one final priority, applied verbatim

The "Suggested Re-order" approval flow showed one priority in the modal but
inserted at a different one (a recurring +1 drift). The cause: the displayed
priority and the applied priority were two independent computations that drifted.

**Rule:** the AI placement step computes ONE final priority (`targetPrioritySeq`),
already including the source-dependency clamp (a re-order must land after its
source order). The modal display, the impact-analysis narrative, and the apply
step all read that same value. The apply step does NOT re-derive priority from the
slot index or re-apply its own clamp — it commits the reviewed value verbatim.

**Why:** the source order is excluded from the lineup, which creates a gap in
priority_seq numbering, so a slot index (insertPosition) and the real priority_seq
diverge. Any second computation (e.g. `max(slotPrio, sourcePrio+1)` at apply time)
re-introduces the off-by-one. Users explicitly review the priority/shift count, so
the committed result must match what was shown — "do not recalculate after confirm."

**How to apply:**
- Keep the source-dependency clamp folded into the placement's final priority, not
  in the apply layer.
- Derive the shift count the same way on both sides: count orders with
  priority_seq >= final priority (over the source-excluded lineup).
- An apply-time floor (priority must exceed source priority) is acceptable ONLY as
  a no-op safety net for stale reviews; it must not change the value in the normal
  reviewed flow.
- A stale reviewed placement (lineup changed after the modal opened) is the one
  case where verbatim apply can be wrong; the floor protects the hard constraint,
  but a re-review gate would be the fuller fix if this becomes a real problem.
