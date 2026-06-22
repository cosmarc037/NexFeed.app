---
name: Pure-AI date-aware ranking
description: Final sort model for pure-AI Auto-Sequence — AI rank is final, AI owns coherence via STEP 5 self-validation.
---

# Pure-AI date-aware ranking

## Current sort model
`_aiPosition ASC` only — no deterministic post-processing of any kind.

The AI is the sole authority for both rank and suggested_date. No rule-based sort
is applied after the AI responds. The AI must self-validate date/rank coherence
before returning its JSON (enforced via STEP 5 in the prompt).

**Why:** User explicitly requires zero deterministic refinement. The sort is not
"enforcing the AI's own intentions" — it is a rule-based override and must not exist.

## STEP 5 — Mandatory self-validation (in prompt)
The prompt instructs the AI to walk its final array before returning:
  - Track latestDateSeen as it scans index 0 → end
  - If entry[i].suggested_date < latestDateSeen → STOP and fix (move entry earlier OR change its date)
  - Only return when the walk completes with zero contradictions
This is the ONLY mechanism for date/rank coherence — it is AI-owned, not frontend-owned.

## Sort history (what was tried and why each was rejected)
1. `_aiPosition ASC` — pure AI rank (original)
2. `suggestedDate ASC → _aiPosition ASC` — date-first; rejected: user said no rule-based refinement
3. `_aiPosition ASC → suggestedDate ASC` — AI rank primary, date tiebreaker; rejected: still rule-based
4. Back to `_aiPosition ASC` — with strengthened STEP 5 prompt for AI to self-correct

## Transparency table columns (current)
Final Rank | Strategy Rank | Suggested Date | Order ID | Item | Current Line | Proposed Line | Moved? | Repositioned? | Reason

- **Strategy Rank** = `_aiRank` (AI-owned)
- **Suggested Date** = `_aiSuggestedDate` (AI-owned)
- **Final Rank** = `idx+1` after pure AI rank sort (= Strategy Rank for consistent AI output)
- **Date Rank REMOVED** — was frontend-computed
- **Repositioned?** = true when strategyRank ≠ finalRank (only differs if AI assigned duplicate ranks)
