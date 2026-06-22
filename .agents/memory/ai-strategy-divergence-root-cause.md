---
name: AI two-strategy identical-sequence root cause
description: Why the two AI Auto-Sequence cards sometimes show different objectives but identical order sequences, and where in the pipeline divergence is (not) lost.
---

# AI Auto-Sequence: two cards, identical sequence — root cause

**Verdict (verified against live data, 56 orders across 7 lines):** divergence is lost
at the *raw Azure response* stage (S1/S2), specifically at the **flexible-order
subsequence** level — NOT in any downstream parse / store / render / apply stage.
Parsing, storage (`ai_option_1.orders` vs `ai_option_2.orders`), and apply all faithfully
carry through whatever Azure produced.

## Mechanism
Only "flexible" orders can be reordered; urgent / MTO / date-locked orders are pinned to
fixed positions. When the reorderable set is tiny or Azure simply repeats itself, both
objectives ("group by cluster" vs "advance high-profit") yield the **same flexible
ordering**, so the two visible sequences are identical even though the objective TEXT differs.

Observed: lines with ≤2 flexible orders (or where Azure repeats) collapse; lines with
5+ genuinely-distinct flexible orderings stay distinct.
- Collapsed lines: flexible-seq identical at the *Diversity Check* log → stored identical
  → opt2 correctly flagged `isLowDistinction=true` ("Near-duplicate of the first AI strategy").
- Working lines: flexible-seq differs at raw stage → stored distinct.

The pipeline already mitigates: on detecting identical it re-calls Azure once more
(2 Azure calls vs 1 on healthy lines) and falls back to `_buildProfitVolumeSequence`;
when even that can't differentiate a tiny flexible set, opt2 is flagged low-distinction.
So the flagging behaviour is correct — the UX complaint (two different objective headers
over one identical sequence) is the real issue, to be addressed in the pipeline redesign.

**Why:** future work must target the *prompt / flexible-set construction* (give Azure a
larger or differently-constrained reorderable set, or suppress the second card when the
flexible set is too small to diverge), NOT the parse/store/render/apply layers — those are proven faithful.

## Reproduction harness (Node + Vite SSR, no browser)
Browser e2e can't sustain the ~60–120s plant generation; drive the real module directly:
- `vite.createServer` then `vite.ssrLoadModule('/src/services/aiSequenceStrategies.js')`
  to load the *real* `generateLineStrategies` against live `/api/entities` data.
- **SSR-realm gotcha:** `fetch` and `console.debug` resolve in Vite's SSR realm, NOT the
  code_execution sandbox global. Patching `globalThis.fetch` in the sandbox does nothing.
  Fix: create a tiny temp module *inside* `src/services/` that patches `globalThis.fetch`
  (rewrite relative `/api/...` → `http://localhost:5000/...`) and `console.debug` in its own
  body, then re-exports `generateLineStrategies`. `ssrLoadModule` it so patches land in the
  correct realm. azureAI posts to relative `/api/ai/auto-sequence` (server.js route exists).
