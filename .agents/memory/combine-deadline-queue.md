---
name: Combine deadline guard queue context
description: Why _wouldCombineMissDeadline must use linePlacedMT (not lineTotalMT) for its queue-hours argument, and how the two dicts differ.
---

# Combine deadline guard queue context

## Rule
`_wouldCombineMissDeadline(groupOrders, lineQueueHours)` must receive
`linePlacedMT[line] / runRate` as `lineQueueHours` — NOT `lineTotalMT[line] / runRate`.

**Why:** `lineTotalMT` is initialised to the *entire pre-existing line load* and only
grows. For the tightest-deadline order (processed first by the urgency sort),
`lineTotalMT` reflects every other order on the line, making the guard think there
are hours of queue before the combined order can even start. This silently blocked
valid same-material combines (e.g. Jun 10 + Jun 12, same material, 120 MT ≤ 200 MT cap).

`linePlacedMT` starts at 0 and increments only as the algorithm *commits* orders:

| Event | lineTotalMT | linePlacedMT |
|---|---|---|
| Init | full line load | 0 |
| Combined order placed | += finalCombinedVolume | += finalCombinedVolume |
| Single order placed | += orderVolume | += orderVolume |
| Single order removed from src | -= orderVolume | unchanged |

## How to apply
- `_baseLineQueueHours` (Phase 2 loop): `(linePlacedMT[_baseOrderLine] || 0) / _baseLineRr`
- `_l5QueueHours` (Line 5 pre-pass): `(linePlacedMT["Line 5"] || 0) / _l5Rr`
- On Line 5 combine commit: `linePlacedMT["Line 5"] += totalMT`
- On combined placement: `linePlacedMT[destinationLine] += finalCombinedVolume`
- On single placement: `linePlacedMT[bestLine] += orderVolume`
- `lineTotalMT` is unchanged — still used exclusively for load-aware line scoring.
