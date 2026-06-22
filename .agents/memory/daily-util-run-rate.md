---
name: Daily utilization run-rate source
description: computeDailyUtilization must use order.run_rate not LINE_RUN_RATES constant or it overstates hours for lines where per-order rate ≠ line default.
---

## Rule
`computeDailyUtilization` must compute `prodHours = volume / order.run_rate` (falling back to `getLineRunRate(line)` only when `order.run_rate` is absent). Never use the stored `production_hours` field — it is stale (set at DB load time, before combining or re-routing).

**Why:** `LINE_RUN_RATES["Line 7"] = 10` MT/hr, but actual Line 7 orders run at ~19.4 MT/hr from KB data. Using the constant inflates every order's hours by ~94%, making 29.78 hrs appear as 49.2 hrs and creating phantom calendar days that don't exist in the actual schedule.

**How to apply:** The same formula is used in three places in `aiSequenceStrategies.js` (`computeStandardUtil`, `computeAIUtil`, `computeDailyUtilization`). If either of the first two is ever refactored, apply the same `order.run_rate` priority there too.
