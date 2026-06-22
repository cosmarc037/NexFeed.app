---
name: Auto-Sequence AI Rank vs Final Rank provenance
description: How plant-level Auto-Sequence tracks the AI's suggested rank vs the final applied position, and the live-vs-stamped pitfall.
---

# AI Rank vs Final Rank (plant-level Auto-Sequence)

The plant-level path (`PlantAutoSequenceModal` + `handlePlantLevelAutoSequence` +
`aiSequenceStrategies.generateLineStrategies`/`applyLineAIStrategy`) captures the
AI's *suggested* ordering and compares it to the *final* applied ordering.

- **AI Rank** is captured from the raw AI `orderArr` in `applyLineAIStrategy`
  BEFORE any deterministic refinement (`executeAIStrategyForLine`, safe-window
  clamp, chronological re-sort, cluster/feasibility passes). Keyed by stable
  entity id into `_aiRankById`. Stamped as `o._aiRank`. This is stable and safe
  to read later.
- **Final Rank** must be the **live preview position** (`idx+1` of the rendered
  array), NOT a stamped value.

**Why:** the stamped `o._finalRank` is frozen at strategy-generation time. After
the user drag-reorders / uncombines / edits rows in the modal, the rendered
order changes but `_finalRank` does not — so showing `_finalRank` misattributes
AI-vs-final differences. Treat `_finalRank` as generation-time debug metadata
only.

**How to apply:** in the modal transparency table, compute `finalRank = idx+1`
and `adjusted = aiRank != null && aiRank !== finalRank` live from the same
`enriched` array the After table renders. Standard (rule_based) rows have
`_aiRank = null`; AI-strategy rows are flagged `_isAIStrategyRow = true` so a
null AI rank under an AI strategy reads as "AI omitted this entity" rather than
"Standard sequence".

Adjustment reasons are classified by `_classifyRankAdjustment(o)` from stable
order properties (MTO / Critical / Urgent / Monitor / `_isCombined` / powermix
source-or-generated / else deterministic refinement) — these stay valid after
user edits.

Debug logs for this feature: `[Auto-Sequence AI Structured Ranking]`,
`[Auto-Sequence AI vs Final Rank]`, `[Auto-Sequence Constraint-Aware AI Context]`,
`[Auto-Sequence Preview Dataset Consistency]`.
