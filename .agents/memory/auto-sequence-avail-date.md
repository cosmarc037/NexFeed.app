---
name: Auto-sequence avail-date source of truth
description: Why per-line Auto-Sequence preview, persisted write, and chronological sort must share one effective avail date.
---

# Auto-Sequence avail date: single source of truth

The per-line Auto-Sequence flow (AutoSequenceModal.jsx preview → Dashboard.jsx
`handleApplySequence`) must show the SAME avail date in the preview, persist that
same value to `target_avail_date`, and sort the applied schedule on that same value.

**Rule:** compute each row's effective avail date ONCE (`effectiveAvailRaw(row)` in
AutoSequenceModal.jsx) and feed it to all three: the preview cell, the apply
snapshot (`appliedAvailDate`), and the sort key (`_resolveAppliedAvailMs`).

**Why:** the AI service (azureAI.js) assigns `_category` on the proposed sequence
and the modal's `buildRows` uses `o._category ||` — so the AI category WINS, but
`_inferredTargetDate` is recomputed by the modal from its own `inferredTargetMap`.
A row can therefore be category B/D with a NULL inferred date. When display, write,
and sort each re-derived the date through their own category fallbacks they
diverged (preview ≠ applied), and the chrono sort keyed off a different value than
what was persisted, so it appeared not to reorder.

**Also:** only mark `avail_date_source='auto_sequence'` (and write
`target_avail_date`/`last_target_date`) when a *placeable* value exists — a real
ISO date or the `'stock_sufficient'` sentinel. Tagging a B/D row auto_sequence
WITHOUT writing a date corrupts future runs, because `isHardDeadline` treats any
`avail_date_source==='auto_sequence'` order as N10D-sourced (never a hard deadline)
regardless of its stored date.

**How to apply:** if you touch avail-date logic in either file, keep the three
consumers reading from `effectiveAvailRaw`/`appliedAvailDate`. Don't reintroduce
per-site category ternaries. Note Category A preview avail edits are still
preview-only (apply never persists A's date) — a known, separate limitation.
