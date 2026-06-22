---
name: Line 5 (Powermix) chronological display sort
description: Why/how Line 5 is re-ordered by Avail Date in enrichedOrders, and the constraints that keep it from corrupting the cascade.
---

The main production table sorts every line by `priority_seq`. Other lines look
chronological because their `priority_seq` already aligns with Avail Date, but
Line 5 (Powermix) `priority_seq` is driven by source-order relationships, so it
can fall out of Avail-Date order.

Fix lives inside the `enrichedOrders` useMemo (Dashboard.jsx), right after
`result` is finalized and before the line-grouping loop. It re-orders Line 5's
planned lead rows by ascending `target_avail_date || original_avail_date`,
**permuting them only among the `priority_seq` slots they already occupy**.

**Why permute-in-slots instead of assigning fresh 1..N:**
- Keeps the exact set of `priority_seq` values unchanged → no collisions with
  other rows, no change to cascade structure beyond the intended reorder.
- Combined sub-orders (`parent_id` set) have NULL `priority_seq` and are left
  untouched. If they were given mid-sequence slots, `applyDisplayCascade` would
  inject their volume into the line cascade and wrongly push later orders' dates
  out (the combined lead already carries the combined volume).
- Frozen rows (running/done/cancelled) keep their slots so in-progress work
  isn't reshuffled. Use the same status set as `EXCLUDED_FROM_AUTOSEQ`
  (`completed`, `cancel_po`, `in_production`, `ongoing_batching/pelleting/bagging`)
  plus legacy display labels.

**How to apply / gotchas:**
- It is display-only derivation (no DB write). It feeds the display sort, the
  cascade, and conflict/overflow detection because all of those read
  `enrichedOrders`. Stable tiebreak on existing `priority_seq` → idempotent.
- `feedmill_line` is stored as `"Line 5"` (space, capital L) in this DB — NOT
  `line_5`. Match it by normalizing (lowercase, strip spaces/_/-) to `line5`,
  not a naive regex, so legacy variants still match.
- Side effect: manual drag-reorder on Line 5 won't persist — the avail-date
  derivation reasserts on next render. This is the user's explicitly chosen
  behavior ("automatically keep Line 5 sorted by Avail Date").
