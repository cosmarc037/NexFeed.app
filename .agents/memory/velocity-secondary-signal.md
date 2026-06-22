---
name: Velocity as secondary AI sequencing signal
description: How demand "velocity" (Stable/Less Stable/Erratic) is threaded into AI Auto-Sequence and why it can never override hard priorities.
---

# Velocity as secondary AI sequencing signal

## What velocity is
Velocity = demand-stability class derived from the coefficient of variation
(std ÷ mean) of a material's day 1–10 N10D demand: CV ≤ 0.5 Stable, ≤ 1.0
Less Stable, else Erratic. It is computed once from N10D records and carried on
each `inferredTargetMap[material]` entry, then joined onto orders in
`computeLineContext`.

## Rule: velocity is prompt-level guidance ONLY, never a hard control
The AI prompt treats velocity as a tiebreaker among *Flexible* orders (Erratic →
Less Stable → Stable). It must not move Critical/Urgent/Monitor/MTO orders.

**Why this is safe even if the AI ignores the instruction:** Stage 3
(`buildStrategyFromSequence`) re-applies the deterministic tier sort
(urgency_rank / dates / MTO immutability) to the AI's raw sequence. So velocity
can only reorder orders *within* a tier — it can never displace a hard-priority
order. There is no code path where velocity becomes a hard constraint.

**How to apply:** when adding any new "soft" AI signal (profit, velocity, etc.),
put it in the prompt as a tiebreaker and rely on the Stage 3 tier re-sort as the
safeguard — do NOT add it to the deterministic placement rules. Keep it a true
tiebreaker so it doesn't break the Strategy-1-vs-Strategy-2 divergence
requirement either.

## Parity caveat
`_classifyVelocity` (Dashboard) and the Next10DaysManager table compute the same
CV/thresholds but from slightly different inputs (first-10 daily_values vs
rendered date columns). Identical for normal payloads; could drift if
daily_values ordering/shape changes — keep the two formulas in sync.
