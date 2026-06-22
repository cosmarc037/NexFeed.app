---
name: AI completion-floor / modal timing parity
description: Four-layer fix for AI suggesting dates earlier than realistic completion. Code-side enforcement is the definitive layer; prompt context is advisory only.
---

## The problem
The AI must never suggest an avail/suggested date earlier than an order's realistic
completion. Production is a CONTINUOUS wall clock — each order starts when the prior
one finishes, runs prod+changeover hours, crosses midnight freely (e.g. 14.85h
starting 8:30 PM finishes 11:41 AM next day; 16.5h starting PHT 8 AM Jun 6 finishes
PHT ~12:40 AM Jun 7).

## Four required fixes (all applied)

### Fix 1 — Prompt context: modal-faithful completion DATE-TIMEs
`buildLineStrategyPrompt` injects completion DATE-TIMEs per order, computed by
replicating the modal's timing engine so the AI's floor matches what the modal
later badges:
- `_actualStart()` mirrors `getOrderActualStart` (incl. manual start-flag gating:
  `_userSetStartDate`/`_userSetStartTime`, `start_date_manual`, `start_time_manual`
  for non-first rows; first row: start_datetime > start_date@its-time > PHT 8 AM today).
- `_modalProdHours()` mirrors `calcOrderEnd`: displayVolume ÷ `run_rate`, with
  manual-hours / mash exception. `_displayVolume()` mirrors `getOrderVolumeDisplayState`
  (volume_override, else batch-ceiling of total_volume_mt).
- `_modalChangeover()`: `_changeoverTotal ?? _effectiveChangeover ?? changeover_time`.
- PHT math via `_combineDT`/`_phtTimeOf`/`_fmtPHT` mirrors modal helpers.
The prompt also has a hard rule block and STEP 5 self-validation. Do NOT rely on
prompt alone — the AI routinely ignores these instructions.

### Fix 2 — enforceCompletionFeasibility() must run in PURE_AI branch
The function exists and works, but was only called in the non-pure-AI `else` branch
(~line 6191). Since `PURE_AI_SEQUENCING=true` always takes the other path, the
validator NEVER ran. Added call inside `if (PURE_AI_SEQUENCING)` block after the
position sort.
**If PURE_AI_SEQUENCING default ever changes, audit both branches.**

### Fix 3 — toISO inside enforceCompletionFeasibility must use PHT, not UTC
The local `toISO` helper used `d.getDate()` (server local = UTC on Replit). Orders
completing between UTC 4 PM and UTC midnight are on the **next** PHT calendar day,
but `getDate()` returns the UTC date — one day too early. So completionISO ≤
candidateDate passed incorrectly and the floor silently skipped.
**Fix:** `const toISO = (d) => _toLocalISO(d)` — this adds `_PHT_MS` (8h) and
extracts via `toISOString().substring(0,10)`, giving the true PHT date.

### Fix 4 — enforceCompletionFeasibility must use order.run_rate, not line default
**Root cause of persistent "delay risk" badge after Fixes 1-3.**
`enforceCompletionFeasibility` computed production hours as:
  `parseFloat(order.production_hours) || vol / getLineRunRate(line)`
If `production_hours` is null (common — the modal recomputes it fresh each render,
it is not reliably stored), it fell back to `vol / lineDefaultRate`. But the modal
uses `vol / order.run_rate` (the order's own rate). When the order rate (e.g. 8 MT/h)
is much lower than the line default (e.g. 20 MT/h), the server computed 132/20 = 6.6h
instead of 132/8 = 16.5h — making the order appear to complete well within the
suggested day, so the floor never fired, and the badge kept showing.
**Fix:** prefer `order.run_rate || order._displayRunRate` before the line fallback:
  `const orderRunRate = parseFloat(order.run_rate || order._displayRunRate || 0) || runRate;`
  `const prodHrs = (orderRunRate > 0 ? vol / orderRunRate : 0) || parseFloat(order.production_hours) || 0;`
Also: volume now uses the modal's batch-ceiling formula (ceiling to batch_size multiples)
instead of the raw field chain.

## If you ever touch this area
- Cursor init in `enforceCompletionFeasibility`: use
  `new Date(\`${_toLocalISO(new Date())}T00:00:00.000Z\`)` (PHT 8 AM today), not
  `setHours(8,0,0,0)` (UTC 8 AM = PHT 4 PM on Replit).
- Production hours in `enforceCompletionFeasibility`: ALWAYS use `order.run_rate`
  first (not line default). `production_hours` is not reliably stored; the modal
  recomputes it from `vol / run_rate` every render. Use the same formula here.
- If modal's start/volume/run-rate/changeover logic changes, update both the
  prompt-builder replicas (`_actualStart`, `_modalProdHours`, `_displayVolume`,
  `_modalChangeover`) AND the `enforceCompletionFeasibility` loop.
