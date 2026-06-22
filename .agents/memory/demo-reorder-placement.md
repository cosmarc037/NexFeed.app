---
name: Demo re-order placement parity
description: Why the Fulfillment (Demo) "Approve Re-order" modal and the apply handler produce the same insertion position and avail date.
---

# Demo re-order placement parity

The Approve Re-order modal computes a per-line placement (insertion position +
recommended avail date) that the apply handler must commit verbatim. Two facts
keep modal == applied:

1. **Insertion position (targetPrioritySeq) is deterministic.** The modal's
   lineup builder and the apply path's lineup builder filter the same way (same
   line, exclude the source order/parents/completed/cancel_po) and both sort by
   `priority_seq`. The modal reads from the cascaded/scheduled orders while the
   apply path reads from the raw demo orders, but the display cascade only
   recomputes dates — it never reassigns `priority_seq`. So both sorted lineups
   have identical `priority_seq` ordering → identical computed insertion seq.

2. **Avail date is floored once, upstream.** `generateReorderPlacement` already
   clamps its `aiAvailDate` to be no earlier than the source order's avail date
   (a replenishment cannot be ready before the order it replenishes). The modal
   displays that floored date, so the apply handler does not need a second clamp.

**Why:** earlier iterations had off-by-one drift from a second clamp in the
apply layer and from showing an unfloored date in the modal. Folding the clamp
into the single upstream function removed the drift.

**How to apply:** if you ever change the lineup filter/sort, the avail-date
floor, or move `priority_seq` reassignment into the display cascade, you must
re-verify both builders still agree. Cross-line picks additionally lift the
source-dependency clamp (`sourceOrderPrioritySeq = 0` when target != source).
