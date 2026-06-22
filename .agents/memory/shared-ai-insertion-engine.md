---
name: Shared AI insertion engine
description: How Add/Divert/Cut/Re-order share one AI insertion-placement engine, and the two invariants that keep reviewed == applied.
---

# Shared AI insertion engine (Add / Divert / Cut / Re-order)

All four order actions get their AI-recommended insertion slot from ONE engine in
`src/services/azureAI.js`: `generateInsertionPlacement(action, order, lineup, context)`
which calls `resolveInsertionPlacement` (clamp + chrono-correction). Action-specific
rules are expressed purely as `context` inputs (`minInsertPos`, `minTargetPrioritySeq`,
`lineName`, `constraintNote`) — NOT as separate code paths.

## Invariant 1 — lineup must mirror the apply layer
**Rule:** the dialog's `buildXLineup()` MUST use the exact same filter + sort + source
array as the Dashboard apply handler's lineup. Otherwise the reviewed `insertPosition`
maps to a different committed slot.
**Why:** the apply layer renumbers `priority_seq` by array order, so the *slot* (array
index), not the priority value, decides the final position. A mismatched lineup silently
shifts the order by one.
**The single source of truth for visual rank is `OrderTable` `activeRankMap`**: it ranks
non-completed/non-cancelled/non-child orders INCLUDING done, by priority_seq order. Every
lineup (dialog AI, rule fallback, apply) must mirror that filter exactly, or the reviewed
Prio won't equal the table Prio.
**How to apply:**
- Divert: dialog `buildDivertLineup` + rule `buildCalcs`/`computeDivertInsertionPosition`
  ↔ apply lineup MUST all use the table filter: exclude the diverted order, children
  (parent_id), and completed/cancel_po — **INCLUDE done** (the table counts it).
- Divert apply does NOT steal a slot's priority_seq and shift `>=` it. Instead it
  **resequences the whole target line to contiguous priority_seq (1..N)** after splicing
  the order at the reviewed 1-based slot. **Why:** priority_seq is not unique/contiguous —
  Powermix generated/linked orders are created with no priority_seq and collapse to the
  column default (e.g. all 1.000); under those ties, slot-steal+shift counted ALL tied
  orders and the diverted order landed at the wrong Prio (modal said 2, table showed 7).
  Resequencing makes visual rank == priority_seq == reviewed slot regardless of ties/gaps,
  and self-heals the line. `ordersShifted` in the engine is position-based (`n-(pos-1)`),
  not priority_seq-based, for the same tie-robustness.
- Cut: dialog `buildCutLineup` (INCLUDES the order being cut = Portion 1) ↔ apply
  `lineOrders` from `orders` (status !== cancel_po/completed). Both pass `allOrders={orders}`.
  Portion 2 constraint: `minInsertPos = portion1Idx + 2` (strictly after Portion 1, not
  forced immediately after); apply re-splices Portion 2 at `insertPosition-1` then renumbers.

## Invariant 2 — stale-response guard on every async placement
**Rule:** every dialog that re-fetches placement on user input (Divert on line change,
Cut on Portion-1 edit) needs a monotonic `placementReqRef` token; only the latest request
may set `aiPlacement`/loading. Bump the token at the START of the handler so even
becoming-invalid input invalidates an in-flight request.
**Why:** without it a slow earlier response overwrites the recommendation for the choice
the user is now looking at → reviewed != applied. (Caught in code review.)

## Debug logs (all three required per action)
`[AI Insertion Recommendation]` (dialog, on fetch), `[AI Insertion Action Constraints]`
and `[AI Insertion Final Apply Consistency]` (Dashboard apply). The consistency log
compares reviewed vs applied slot/priority; constraints log asserts the per-action rule.

Demo vs live is automatic: dialogs receive whichever `orders` the demo-aware Dashboard
hands them, so the same engine + apply code serves both.
