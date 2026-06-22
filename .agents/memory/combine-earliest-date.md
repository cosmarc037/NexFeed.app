---
name: Combine earliest-date override
description: Why combined orders must always use the earliest hard avail date among sub-orders, and how MTO vs MTS controlling type affects the combined order's date behaviour.
---

# Combine earliest-date override

## Rule
After the combined `baseOrder` is constructed (both Phase 2/3 main loop and
Line 5 pre-pass), a date resolution step overrides `target_avail_date` with
the earliest hard avail date among all sub-orders.

**Why:** The canonical lead order is selected by urgency tier first, then date.
A Critical-tier order with a later date can become lead, leaving the combined
order with a later date than the tightest deadline in the group.

## How to apply

1. Filter sub-orders for hard dates: real ISO `target_avail_date`, NOT
   `avail_date_source === 'auto_sequence'` and NOT `date_source === 'n10d'`.
2. Sort ascending → first entry is the "controlling order".
3. `baseOrder.target_avail_date = earliest controlling date`.
4. If controlling order is MTO: set `baseOrder.category = 'MTO'`, clear
   `avail_date_source` so it is not treated as AI-moveable.
5. If controlling order is MTS: leave category as-is; store
   `baseOrder._combinedEarliestHardDate` so AI clamp passes can enforce
   it as a ceiling on suggested dates.

## Physical deadline guard is separate
`_wouldCombineMissDeadline` stays unchanged — it blocks combines that
physically cannot finish before the earliest deadline (queue + production
hours). Date difference alone does NOT block combining; only feasibility does.

## Scope
Both Phase 2/3 main combine loop and Line 5 pre-pass must apply this
override. Line 5 pre-pass builds `lead5` by largest-volume selection, not
earliest date, so it is equally susceptible to carrying the wrong date.
