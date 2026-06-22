---
name: Parallel per-line AI sequencing
description: generateSequenceStrategies runs all lines in parallel — rationale, retry ownership, and proxy-budget constraint.
---

## Rule
`generateSequenceStrategies` (aiSequenceStrategies.js) fans out all lines via `Promise.all`, not a sequential `for` loop. The plant-wide fan-out is gated by a shared client-side concurrency limiter, and retry is owned by the client, not the server.

**Why:** Running lines sequentially would block later lines for minutes whenever an early line is slow. Parallel fan-out resolves all slow lines concurrently. But unbounded parallelism (7 lines × strategy + insight calls each) floods Azure and *causes* the timeouts — so a shared limiter caps in-flight calls.

**How to apply:**
- **Proxy budget is the hard constraint.** Replit's proxy kills any single HTTP request at ~60 s. Therefore `/api/ai/auto-sequence` must do EXACTLY ONE Azure attempt per request (server `maxAttempts:1`, `timeoutMs` well under 60 s). Never let the server retry inside one request — that stacks past the budget and orphans the client (`request aborted` / `Failed to fetch`).
- **The client is the sole retry owner.** `callSequenceStrategyAI` does one graceful retry (short backoff) on transient failures (timeout / network / 5xx / 429); each retry is a *fresh* request with a fresh proxy budget. Do not also enable server retries on this path — that re-creates retry multiplication (up to 4 Azure calls per logical request).
- **Cap concurrency, don't remove it.** A shared limiter (small N, e.g. 4) gates every `callSequenceStrategyAI`. Acquire/release must be in `try/finally` so a throw never leaks a slot. Make the queued acquire and the retry backoff abort-aware so user cancellation doesn't run queued work.
- **AbortError must propagate** through `Promise.all` so user-cancellation isn't swallowed; keep the upfront `if (signal?.aborted) throw` guard before fan-out.
- If a deadline-bounded helper *does* allow in-request retries elsewhere, enforce the deadline *hard*: cap each attempt's timeout to remaining budget, don't just check it before sleeping.
