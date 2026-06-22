---
name: SAP upload missing-line fallback
description: How blank Feedmill Line in SAP upload is auto-assigned; Line 5 is MX-only; pelleting lines use KB applicability then queue time.
---

# SAP upload missing-line fallback

When an uploaded SAP order has a blank Feedmill Line, the app auto-assigns
it instead of saving it as `__none__` (which left it unscheduled).

## Decision tree (inserted before `byLine` grouping in `handleUpload`)

1. **MX / Mix form** → assign directly to **Line 5**, no queue calc.
2. **Non-MX, exactly 1 applicable pelleting KB line** → direct assign.
3. **Non-MX, multiple applicable pelleting KB lines** → lowest queue time
   among those applicable lines only.
4. **Non-MX, no KB history** → lowest queue time across all FM1–FM3 lines
   (Lines 1, 2, 3, 4, 6, 7).

`PELLETING_LINES_FALLBACK = ["Line 1","Line 2","Line 3","Line 4","Line 6","Line 7"]`
— Line 5 is never in the non-MX candidate pool.

## Staged queue-time basis (critical)

Queue-time for missing-line orders must reflect the **just-placed** upload
load, not just the pre-existing DB state. Correct approach:

1. Split `parsedWithKB` into `validLineOrders` and `missingLineOrders` upfront.
2. `existingLineMT` = MT from active orders already in the DB.
3. `uploadedLineMT` = pre-populated with the MT of `validLineOrders` from the
   current batch (Stage 1 placement), then accumulates auto-assigned MT within
   the missing-line loop (Stage 2).
4. Queue time per line = `(existingLineMT[line] + uploadedLineMT[line]) / runRate`.

This ensures first-time uploads also stage correctly: valid-line orders are
"placed" in the queue-time model before missing-line orders are evaluated.

**Why:** Without pre-populating from valid-line orders, all missing-line orders
in a large upload see an empty or stale queue and may pile onto the same line.

## Post-assignment steps
- Re-apply `BATCH_SIZE_COL`/`RUN_RATE_COL` KB fields for the assigned line.
- Recompute `production_hours` (non-manual, non-Mash).
- Line 5 auto-assigned: mirror `sap_sfg1 → pmx` (same as explicit Line 5 handler).
- Set `_autoAssignedLine = true`, `_autoAssignedLineSource = 'missing_feedmill_line_fallback'`.
- `uploadedLineMT` accumulates within-batch auto-assigned volumes so successive
  missing-line orders spread across lines rather than all landing on the same one.

**Why:** Existing-line orders (feedmill_line non-blank) are skipped by `continue`,
so this block never alters explicitly-assigned orders.

**How to apply:** Any new upload feature that adds orders must ensure `feedmill_line`
is set before the `byLine` grouping step, or those orders will land in `__none__`
and be unscheduled.
