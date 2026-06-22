---
name: Plant auto-sequence scalability
description: Durable transport/orchestration decisions that keep Plant-Level Auto-Sequence reliable as order/line counts grow.
---

# Plant auto-sequence scalability

These are PURE-AI-safe (transport/orchestration/data-fetch) decisions only — never
add deterministic refinement of the AI's semantic ordering.

## AI output tokens must scale with order count
Both the strategy call and the row-insight call must size `maxTokens` from the
number of orders being sequenced, not a fixed cap.
**Why:** a fixed output cap silently truncates the JSON once a line/plant has
enough orders, and the parse failure surfaces to users as "AI Unavailable" — it
looks like an outage but is really truncation. Keep a floor (so small calls stay
fast) and a ceiling below the model's hard output limit (so latency stays bounded).
**How to apply:** any new AI call that returns per-order JSON needs the same
order-count-scaled token formula; if you add fields per order, the multiplier must grow too.

## Insights load lazily, never as an upfront burst
Row-level insights are generated on-demand when a strategy card is viewed (the
modal already owns a spinner path). Do NOT reintroduce an upfront
"enrich all lines × all strategies" pass.
**Why:** the old upfront enrich fired ~3N AI calls with no concurrency limit the
moment strategies returned, dominating latency and starving the user-facing
strategy calls. Lazy + a priority-aware limiter (strategy calls outrank insight
calls) keeps the cards fast and cuts total call volume dramatically.
**How to apply:** route every non-interactive/secondary AI call through the
shared limiter at low priority; reserve high priority for what the user is waiting on.

## Don't narrow the planning order load
Server-side status filtering on the entity list is opt-in and backward-compatible.
The active sequencing/cascade input must still load completed orders.
**Why:** completed orders feed the cascade (start/completion chaining), so
filtering them out of the planning load would corrupt downstream dates.
