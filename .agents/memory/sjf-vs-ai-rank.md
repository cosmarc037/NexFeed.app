---
name: SJF overrides AI strategy rank
description: Why two AI auto-sequence strategy cards could show different reasoning but identical After sequences, and the two-layer fix.
---

# SJF overrides AI strategy rank (identical After sequences)

## Symptom
Two AI auto-sequence strategy cards display genuinely different reasoning,
objectives, and names, yet the "After" preview shows an identical order
sequence for both. Reasoning and displayed sequence become internally
inconsistent.

## Root cause (Layer 1)
`buildStrategyFromSequence` (`src/services/sequencePostProcess.js`) tier-sorts
the AI's returned ID array. Within the same tier + same `effAvail` date it
applied **SJF (shortest-job-first)** — sorting by estimated hours ascending.
Because production hours scale with volume, and most flexible orders on a line
share today's `effAvail`, SJF re-sorted every flexible order by size ascending,
**overwriting whatever rank the AI returned**. Both strategies therefore
collapsed onto the same SJF ordering regardless of their distinct objectives.

**Fix:** for the Flexible tier (tier=4) defer directly to AI rank; keep SJF
only for constrained tiers 0-3 (Critical/Urgent/Monitor/MTO) where deadline
throughput genuinely needs shorter-jobs-first.

## Root cause (Layer 2 — the AI itself)
Even with Layer 1 fixed, the LLM sometimes emits two different reasoning blobs
but the **same `sequence` array** (classic lazy-LLM failure). Prompt divergence
rules + the retry addendum reduce this but don't guarantee it.

**Fix:** a deterministic divergence safety net in `runAttempt`
(`src/services/aiSequenceStrategies.js`). When the two applied options are NOT
`areStrategiesMeaningfullyDifferent`, Strategy 2 is rebuilt from its own stated
objective via `_buildProfitVolumeSequence(ctx)` (flexible orders sorted by
profit% DESC → volume_mt DESC), passed back through
`buildStrategyFromSequence` + `applyLineAIStrategy`, and adopted **only if** the
rebuild is actually distinct from Strategy 1.

## Why this is safe vs the PURE_AI principle
`PURE_AI_SEQUENCING=true` means the AI's rank is normally authoritative with no
deterministic refinement. The safety net is a narrowly-bounded **failure-case
exception**: it fires only when the AI demonstrably failed to differentiate two
opposing-objective strategies. When the AI already produced a distinct ordering,
nothing is overridden.

## How to apply / guardrails
- Both layers rely on `buildStrategyFromSequence` re-applying the constraint
  tiers, so Critical/MTO/Urgent/Monitor placement is never violated even when
  `_buildProfitVolumeSequence` reorders flexible orders.
- Missing `profit_score`/`volume_mt` fall back to `?? 0` — keep that, NaN in the
  comparator destabilizes the sort.
- The diversity-check debug log reports `strategy1FlexibleSeq` /
  `strategy2FlexibleSeq` / `sequencesMeaningfullyDistinct` — use it to confirm
  divergence after a Re-analyze (HMR does NOT re-run the AI; user must click
  Re-analyze).
