# NexFeed — App Rules, Calculations & Business Logic

**Last Updated:** 2026-05-27  
**Verified against codebase at:** commit in progress

This document is the single source of truth for every business rule, threshold, formula, and behavioral logic in the NexFeed application. It is intended for onboarding, QA, and future development reference.

---

## Table of Contents

1. [Stock Status (Urgency Levels)](#1-stock-status-urgency-levels)
2. [Changeover Rules & Calculation](#2-changeover-rules--calculation)
3. [Scheduling Cascade & Completion Date Logic](#3-scheduling-cascade--completion-date-logic)
4. [Order Readiness](#4-order-readiness)
5. [HA (Hand-Additives) Batch Count](#5-ha-hand-additives-batch-count)
6. [Avail Date Inference (from SAP Remarks)](#6-avail-date-inference-from-sap-remarks)
7. [Minimum MT Thresholds (Combining Orders)](#7-minimum-mt-thresholds-combining-orders)
8. [Combining Orders Logic](#8-combining-orders-logic)
9. [AI Sequencing Recommendation Badge](#9-ai-sequencing-recommendation-badge)
10. [Powermix (Line 5) Special Handling](#10-powermix-line-5-special-handling)
11. [Run Rate Source](#11-run-rate-source)
12. [Key Behavioral Rules (Gotchas)](#12-key-behavioral-rules-gotchas)

---

## 1. Stock Status (Urgency Levels)

**Single source of truth:** `src/utils/statusUtils.js → getProductStatus()`

| Status | Rule |
|---|---|
| **Critical** | `DFL ≥ Inventory` — demand already equals or exceeds stock; no daily projection needed |
| **Urgent** | Cumulative demand (`DFL` + daily values) breaches inventory within **≤ 3 days** |
| **Monitor** | Breach occurs within **4–10 days** |
| **Sufficient** | No breach within the 10-day window, OR no daily data available |

**Sort order (highest → lowest urgency):**

| Status | Sort Index |
|---|---|
| Critical | 0 |
| Urgent | 1 |
| Monitor | 2 |
| Sufficient | 3 |

**Defined in:** `src/utils/statusUtils.js → STATUS_ORDER`

**Behavioral details:**

- If the daily data array is empty, status defaults to **Sufficient** immediately (no breach check performed).
- "Days to breach" is calculated as `Math.ceil((breachDate - today) / 86400000)` — ceiling rounding, both dates midnight-normalized.
- The function accepts two daily-data input formats:
  - **Format A:** `[{ key, date }]` — N10D UI column format; values read from `product[col.key]`.
  - **Format B:** `[{ date, value }]` or a JSON string of the same — DB record format.
- `dfl` and `inventory` values are parsed through `parseFloat()`; invalid or missing values default to `0`.

---

## 2. Changeover Rules & Calculation

**Single source of truth:** `src/utils/changeoverCalc.js`

### Line → Feedmill Mapping

| Lines | Feedmill Key |
|---|---|
| Line 1, Line 2 | `fm1` |
| Line 3, Line 4 | `fm2` |
| Line 6, Line 7 | `fm3` |
| Line 5 (Powermix) | `null` — no changeover rules apply |

**Defined in:** `src/utils/changeoverCalc.js → LINE_TO_FM`

### Cleaning Rules (triggered by transitions)

| Rule ID | Trigger |
|---|---|
| `color_yellow_brown` | Both colors are in `{yellow, brown, yellow/brown, brown/yellow}` AND they differ |
| `color_red_out` | Current color is `red`, next is **not** `red` |
| `color_green_out` | Current color is `green`, next is **not** `green` |
| `color_to_red_green` | Next is `red` or `green`, current is not `red` or `green` |
| `category` | `current.category ≠ next.category` (case-insensitive comparison) |

Colors are normalized via `.trim().toLowerCase()` before comparison.

### Change Die Rule

- Rule ID: `diameter_change`
- Triggers when `current.diameter ≠ next.diameter` AND **both** diameters are `> 0`.
- Symmetric — direction does not matter (3mm→4mm costs the same as 4mm→3mm).

### Default Fallback Rule Values

Used when no configuration is saved. Source: `src/utils/changeoverCalc.js → getFallbackChangeoverRules()`

| Rule | FM1 | FM2 | FM3 |
|---|---|---|---|
| Diameter change | 1.50 hr | 1.00 hr | 1.00 hr |
| Yellow ↔ Brown | 0.33 hr | 0.33 hr | 0.33 hr |
| Red → Any | 1.00 hr | 1.00 hr | 1.00 hr |
| Green → Any | 1.00 hr | 1.00 hr | 1.00 hr |
| Any → Red/Green | 0.50 hr | 0.50 hr | 0.50 hr |
| Category change | 0.33 hr | 0.33 hr | 0.33 hr |

### Changeover Formula (Non-Cumulative Model)

```
If no cleaning AND no diameter change  →  Base changeover only (default 0.17 hr)
If cleaning only                       →  Highest triggered cleaning value  (base dropped)
If diameter change only                →  Change Die value  (base dropped)
If both cleaning + diameter change     →  Highest cleaning value + Change Die value  (base dropped)
```

> Multiple cleaning rules that fire simultaneously are **never summed** — only the single highest-valued rule is used.

The base changeover (0.17 hr by default, 0.33 hr if `form === 'C'`) is only applied when **neither** a cleaning rule nor a die-change rule fires.

**Key functions:**

- `calculateAdditionalChangeover(currentOrder, followingOrder, rules)` — returns the full breakdown object including `total`, `cleaning`, `changeDie`, `triggeredCleaningRules`, `breakdown`.
- `calculateChangeoverBetween(fromOrder, toOrder, rules)` — returns the final changeover hours as a single number.

### Worked Example (FM1)

- Swine · Yellow · 3mm → Poultry · Red · 4mm
  - Cleaning candidates: `Any → Red` (0.50 hr) and `Category change` (0.33 hr)
  - Select highest cleaning = **0.50 hr**
  - Die change: 3mm → 4mm = **1.50 hr**
  - **Total = 0.50 + 1.50 = 2.00 hr**

### Direction Matters

- `Red → Any` costs 1.00 hr (expensive outgoing); `Any → Red` costs only 0.50 hr
- `Green → Any` costs 1.00 hr (expensive outgoing); `Any → Green` costs only 0.50 hr
- Diameter change is **symmetric** — cost is the same in both directions

---

## 3. Scheduling Cascade & Completion Date Logic

**Source:** `src/pages/Dashboard.jsx → applyDisplayCascade()` and `applyChangeoverEnrichment()`

### Core Formula

```
OrderN.Start Time     = OrderN-1.Completion DateTime + OrderN-1._changeoverTotal (hours)
OrderN.Completion     = OrderN.Start Time + (Volume ÷ Run Rate)
```

- Production hours = `volume / run_rate` only — changeover time is NOT included in production hours; it is added separately in the cascade.
- Effective volume uses `volume_override` if set; otherwise `Math.ceil(total_volume_mt / batch_size) * batch_size`.

### Cascade Behavior

- **Start Date/Time never cascades** — only Completion Date cascades downstream.
- A **user-set Start Date/Time** overrides the cascade chain for that order; all subsequent orders in the line are anchored from that manual start.
- Orders marked **Done** (`completed`) are **frozen** in the cascade — their completion time is fixed and feeds into the next order's start, but they themselves are not recomputed.
- Orders with `target_completion_manual = true` are also frozen in the cascade.

### Changeover Enrichment

Done and cancelled (`cancel_po`) orders use `frozen_changeover` if stored; otherwise the value is computed dynamically from the next order on the same line. The `_changeoverTotal` field is populated on every order before the cascade runs.

### At-Risk Rule (5:00 PM Cutoff)

An order is flagged **At Risk** if its projected completion time exceeds **17:00** on its `target_avail_date`, even if it technically completes before midnight that day.

- Only applies when the order's avail date is **today** — future-dated orders are excluded from this check.
- This rule is implemented in `src/services/aiSequenceStrategies.js → computeAtRiskOrders()`.

---

## 4. Order Readiness

**Source:** `src/components/utils/orderUtils.jsx → checkReadiness()`

### Required Fields for Readiness

All three must be satisfied:

| Field | Condition |
|---|---|
| `fpr` | Non-empty string |
| `material_code` | Non-empty string |
| `total_volume_mt` | Numeric value `> 0` |

### HA Batch Match

`ha_available` (manually confirmed count) must equal `Math.ceil(total_volume_mt / batch_size)`.

- Default `batch_size` = **4 MT** (overridden by KB data per line — see Section 5).

### Readiness Tiers

| Tier | Condition | Ready? |
|---|---|---|
| Tier 1 | Missing one or more required fields (`fpr`, `material_code`, or `total_volume_mt ≤ 0`) | No |
| Tier 2 | Required fields present, but `ha_available ≠ Math.ceil(total_volume_mt / batch_size)` | No |
| Tier 3 | All required fields present AND HA batch count matches | **Yes** |

> Note: `getReadinessTier()` is referenced in the task spec but is not present as a standalone export in `orderUtils.jsx` at time of writing. Tier logic is inlined within `checkReadiness()`.

---

## 5. HA (Hand-Additives) Batch Count

**Source:** `src/components/utils/orderUtils.jsx → calculateBatches()` and `calculateBags()`

### Batch Count Formula

```
Batches = Math.ceil(total_volume_mt / batch_size)
```

- Default `batch_size` = **4 MT**
- Batch size is line-specific and pulled from KB data:

| Line | KB Column |
|---|---|
| Line 1, Line 2 | `batch_size_fm1` |
| Line 3, Line 4 | `batch_size_fm2` |
| Line 5 (Powermix) | `batch_size_pmx` |
| Line 6, Line 7 | `batch_size_fm3` |

**Defined in:** `src/components/utils/orderUtils.jsx → BATCH_SIZE_COL_MAP`

### Bags Formula

```
Bags = Math.round((total_volume_mt / 50) * 1000)
```

**Defined in:** `src/components/utils/orderUtils.jsx → calculateBags()`

### Key distinction

- `ha_available` is the **manually confirmed** count entered by the user.
- The calculated batch count from volume ÷ batch size is the **expected** count.
- Readiness (Tier 2) requires these two values to match exactly.

---

## 6. Avail Date Inference (from SAP Remarks)

**Two implementations exist — they use different year-inference logic:**

### Implementation A — `src/components/utils/orderUtils.jsx → parseTargetDate()`

- Parses `Remarks` field for the pattern: `TLD | Jan 03` or bare `Jan 03`.
- **Year inference:** If the parsed date (using the current year) is in the past relative to today, the year is bumped to the next calendar year.
- If the Remarks field cannot be parsed as a date (e.g., `"prio replenish"`), the **original string is returned as-is**.

### Implementation B — `src/pages/Dashboard.jsx → parseTargetDate()` (inlined)

- Same Remarks pattern matching.
- **Year inference (FPR-based):** Uses the first 6 digits of the FPR (`YYMMDD`) to extract a reference year and month.
  - If `targetMonth ≥ fprMonth` → use `fprYear`
  - If `targetMonth < fprMonth` → use `fprYear + 1`
- This is the version used during SAP upload processing, as it has more context (the FPR is available alongside the Remarks).

### Common behavior (both)

- Month abbreviations supported: `Jan`, `Feb`, `Mar`, `Apr`, `Jun`, `Jul`, `Aug`, `Sep`, `Oct`, `Nov`, `Dec` (full names also accepted).
- Returned format: `YYYY-MM-DD` ISO string, or the original remarks string if unparseable.
- If the inferred date is significantly in the past or future, a warning is surfaced to the user in the UI.

---

## 7. Minimum MT Thresholds (Combining Orders)

**Source:** `src/components/utils/orderUtils.jsx → MIN_MT_THRESHOLDS`

| Line | Minimum MT |
|---|---|
| Line 1, Line 2 | 40 MT |
| Line 3, Line 4 | 20 MT |
| Line 5 (Powermix) | 0 MT (exempt) |
| Line 6, Line 7 | 20 MT |

Helper function: `getMinMT(feedmillLine)` — returns the threshold for a given line, defaulting to `0` if the line is unknown.

---

## 8. Combining Orders Logic

**Source:** `src/components/orders/SmartCombinePanel.jsx`

### Volume Calculation

- Combined volume = sum of **raw** `total_volume_mt` values (or `volume_override` if set) of constituent orders.
- Batch ceiling is applied to the **final combined sum only**: `Math.ceil(combinedBasisVolume / batch_size) * batch_size` — never to each order individually.

### Order Selection

- Strategies select from orders within the same feedmill group (e.g., all FM1 orders sharing the same material). The code does not enforce positional adjacency as a hard constraint — strategies are built by date-sorting, greedy conflict simulation, or pair selection (see Strategy Types below).

### Strategy Types

| Strategy ID | Label | Description |
|---|---|---|
| `max` | Max Consolidation | Combines all orders in the group into one run |
| `urgency` | Urgency Split | Combines the most urgent orders (smallest avail date spread); requires ≥ 2 dated orders with a spread of ≥ 2 days |
| `safe` | Conflict-Free | Greedy inclusion — adds orders one by one as long as no downstream scheduling conflict is introduced |
| `pair` | Best Pair | Combines the two orders with the closest avail dates (only generated when group has ≥ 3 orders) |

### Strategy Scoring (Stars: 1–4)

- Conflicting strategies are **hard-capped at 2 stars** (1 star if more than 1 conflict).
- Conflict-free strategies receive 3–4 stars based on:
  - **Consolidation %** (`active.length / allGroupOrders.length`): ≥ 100% → +2 pts; ≥ 60% → +1 pt
  - **Date variance** (spread of `target_avail_date` across combined orders): < 1 day → +2 pts; < 4 days → +1 pt
  - Sum ≥ 3 → 4 stars, otherwise 3 stars.
- **Best tag:** Only conflict-free strategies are eligible. The highest-starred conflict-free strategy is flagged `recommended = true`.

**Defined in:** `SmartCombinePanel.jsx → scoreStrategy()` and `generateStrategies()`

---

## 9. AI Sequencing Recommendation Badge

**Source:** `src/services/aiSequenceStrategies.js → determineLineRecommendation()`

The strategy with the highest weighted composite score across five dimensions receives the `isAIRecommended = true` badge. Standard Sequence (`rule_based`) is **never** eligible for the badge.

| Dimension | Weight | Score Direction |
|---|---|---|
| Daily Utilization (`utilizationDelta`) | **30%** | Higher utilization delta → higher score |
| Time Saved (`timeSavedDeltaHours`) | **25%** | More hours saved vs. Standard → higher score |
| Changeover Total (`totalChangeoverHours`) | **20%** | Lower total changeover → higher score |
| MTS Adjusted (`mtsAdjusted`) | **15%** | **More** MTS orders repositioned → higher score (`mtsScore = mtsAdjusted / maxMTS`) |
| Orders At Risk (`ordersAtRisk`) | **10%** | Fewer at-risk orders → higher score |

### Normalization (exact formula)

Each dimension is normalized to `0.0–1.0`:

| Dimension | Formula | Tie behavior (all candidates equal) |
|---|---|---|
| Utilization | `(value - min) / range`; `range = max(0.0001, max - min)` | All score `0.0` (numerator is 0) |
| Time Saved | `(maxTS - value) / tsDelta`; `tsDelta = max(0.0001, maxTS - minTS)` | All score `0.0` |
| Changeover | `(maxCO - value) / coDelta`; `coDelta = max(0.0001, maxCO - minCO)` | All score `0.0` |
| MTS Adjusted | `value / max(all values, 1)` | `1.0` if all tied at > 0; `0.0` if all at 0 |
| Orders At Risk | `1 - (value / max(all values, 1))` | `0.0` if all tied at > 0; `1.0` if all at 0 |

> Note: A comment in the source code states "when all candidates tie on a dimension every one gets 0.5" — this is **inaccurate**. The `0.5` fallback branches in the code are dead code for Utilization, Time Saved, and Changeover (their deltas are always ≥ 0.0001 via `Math.max`). Actual tie behavior is as shown above.

- Final composite score = weighted sum of normalized dimension scores.
- The strategy with the highest composite score is flagged `isAIRecommended = true`.

### Eligibility

- Only `ai_option_1` and `ai_option_2` are evaluated — never `rule_based`.
- A strategy is excluded if `aiFailed = true` or `metrics` is absent.

---

## 10. Powermix (Line 5) Special Handling

**Sources:** `src/utils/changeoverCalc.js`, `src/components/utils/orderUtils.jsx`

- Powermix (`Line 5`) maps to `null` in `LINE_TO_FM` — it is **not governed** by changeover rules.
- `calculateAdditionalChangeover()` returns `{ total: 0, usedBaseOnly: false }` when the line maps to `null`. Because `usedBaseOnly` is `false`, `calculateChangeoverBetween()` uses `result.total` (which is `0`) rather than the base value. **Net effect: Powermix transition cost is always `0` hours**, not base.
- Batch size column: `batch_size_pmx` (from KB data).
- Minimum MT threshold: **0 MT** — exempt from volume minimums when combining.
- Powermix-specific fields (`pmx`, `sfgpmx`) are shown/hidden conditionally in the order form.

---

## 11. Run Rate Source

**Source:** `src/components/utils/orderUtils.jsx → RUN_RATE_COL_MAP`

Run rate is pulled from the Knowledge Base (KB) per individual line:

| Line | KB Column |
|---|---|
| Line 1 | `line_1_run_rate` |
| Line 2 | `line_2_run_rate` |
| Line 3 | `line_3_run_rate` |
| Line 4 | `line_4_run_rate` |
| Line 5 | `line_5_run_rate` |
| Line 6 | `line_6_run_rate` |
| Line 7 | `line_7_run_rate` |

The run rate is applied via `applyKBToOrder()` when KB data is matched to an order by `fg_material_code`.

**Default fallback run rates used in AI sequencing strategy calculations** (when KB run rate is unavailable at estimation time):

| Lines | Default Rate |
|---|---|
| Line 1, Line 2 | 20 MT/hr |
| Line 3, Line 4, Line 5, Line 6, Line 7 | 10 MT/hr |

**Defined in:** `src/services/aiSequenceStrategies.js → LINE_RUN_RATES`

---

## 12. Key Behavioral Rules (Gotchas)

| Rule | Detail |
|---|---|
| **Start Date/Time never cascades** | Only Completion Date cascades downstream. Start Date is always either manually set or anchored from the previous order's completion. |
| **Done orders are frozen** | An order marked Done is fixed in the cascade. Its completion time feeds the next order's start but is not recalculated itself. |
| **User-set Start Date/Time overrides cascade** | Setting a manual Start Date/Time breaks the cascade chain at that order; all subsequent orders re-anchor from that point. |
| **Avail Date year inference can warn** | If the inferred Avail Date is significantly in the past or future relative to today, the UI surfaces a warning to the user. |
| **HA batch count is always recalculated on the fly** | `ha_available` is the manually confirmed value. The expected count (`Math.ceil(volume / batch_size)`) is always recomputed from current volume and batch size — never stored as the truth. |
| **Base changeover is dropped when rules fire** | Base (0.17 hr or 0.33 hr for Form C) is only used when no cleaning rule and no die-change fires. If any rule fires, the base is completely replaced. |
| **Last active order has zero changeover** | The final active order in each line group gets `_changeoverTotal = 0` — there is no outgoing changeover with no following order. |
| **Multiple cleaning rules never sum** | When multiple cleaning rules fire on the same transition, only the single highest-valued rule is used. |
| **MTO avail dates are contractual** | Orders with an ISO `target_avail_date` that is not N10D-sourced (`avail_date_source !== 'auto_sequence'` and `date_source !== 'n10d'`) are treated as MTO — the AI sequencing engine must not change their avail date. |
| **Urgent orders only count as At Risk if confirmed by timing simulation** | An Urgent order whose production completes before its avail date is NOT counted as at risk — the deadline must actually be missed in the sequential timing simulation. |
