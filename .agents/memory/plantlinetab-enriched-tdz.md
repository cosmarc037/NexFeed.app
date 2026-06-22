---
name: PlantLineTab enriched TDZ
description: const enriched is declared ~line 2379 in PlantLineTab; any inline expression above that line that references enriched crashes with "Cannot access before initialization".
---

## Rule
In `PlantAutoSequenceModal.jsx › PlantLineTab`, `const enriched` is declared around line 2379 (derived from `localOrders`). Any inline `const` or expression placed **before** that declaration that references `enriched` will throw:

```
ReferenceError: Cannot access 'enriched' before initialization
```

This causes a blank white screen on every render (including tab switches) because React has no error boundary by default.

**Why:** JavaScript `const`/`let` are hoisted to block top but stay in the temporal dead zone until execution reaches the declaration. PlantLineTab has hooks, state, and effects declared above line 2379 — any of them touching `enriched` inline will TDZ.

**How to apply:**
- When adding a fingerprint/memoization key that needs to track the sequence, use `localOrders` (available from the start) instead of `enriched`. `_aiRank` is already on raw `localOrders` objects — enrichment only adds `_profitScore`, `_movement`, `_dateChange`.
- The `useEffect` body references (`enriched.length`, `enriched.map(...)`) are safe because effect callbacks run *after* render — by then `enriched` is initialized.
- Only *inline synchronous expressions* (outside any callback) before line 2379 are dangerous.
- A global `ErrorBoundary` in `main.jsx` now catches this and displays the stack trace instead of a blank page.
