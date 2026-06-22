// Shared changeover calculation utilities — single source of truth for both
// the live scheduling engine (Dashboard) and the AI sequencing engine
// (aiSequenceStrategies). All callers MUST pass the live `changeoverRules`
// configuration (from the Changeover Rules tab / localStorage) so that any
// edits the user makes are reflected immediately in AI prompts and heuristics.
//
// ── NEW CALCULATION MODEL ─────────────────────────────────────────────────
// Changeover is NO LONGER fully cumulative. The formula is:
//
//   If no cleaning rule fires AND no diameter change:
//     → use Base changeover only
//
//   If cleaning fires but no diameter change:
//     → use highest triggered cleaning value only  (base is dropped)
//
//   If diameter change fires but no cleaning:
//     → use Change Die value only  (base is dropped)
//
//   If both cleaning and diameter change fire:
//     → highest cleaning value + Change Die  (base is dropped)
//
// "Cleaning" covers: Yellow↔Brown, Red→Any, Green→Any, Any→Red/Green,
//                    Category change.
// "Change Die"  covers: pellet diameter change.
// Multiple cleaning rules that fire simultaneously are NOT summed — only the
// highest-valued cleaning rule is used.
// ─────────────────────────────────────────────────────────────────────────

// Production line → feedmill mapping. Powermix (Line 5) is intentionally null
// because it isn't governed by changeover rules.
export const LINE_TO_FM = {
  "Line 1": "fm1",
  "Line 2": "fm1",
  "Line 3": "fm2",
  "Line 4": "fm2",
  "Line 5": null,
  "Line 6": "fm3",
  "Line 7": "fm3",
};

export function normalizeColor(c) {
  return (c || "").trim().toLowerCase();
}

export function normalizeCategory(c) {
  return (c || "").trim().toLowerCase();
}

export function normalizeDiameter(d) {
  return String(d || "").replace(/\s+/g, "").toLowerCase();
}

// Diameter ("Change Die") is the single most expensive changeover dimension
// (~1.0–1.5 hr vs 0.17 hr base). These helpers give every sequencer ONE shared
// definition of "same die" so diameter-streak preservation behaves identically
// across the standard sequence (plantCombinePlace) and the AI passes
// (sequencePostProcess).
export function getDiameterKey(order) {
  return normalizeDiameter(order?.diameter);
}

export function sameDiameter(a, b) {
  const da = getDiameterKey(a);
  const db = getDiameterKey(b);
  // An unknown diameter on either side is NOT a match — never fabricate a
  // die-streak across orders whose diameter we cannot confirm.
  return da !== "" && da === db;
}

export function getFmKey(order) {
  return LINE_TO_FM[order?.feedmill_line] || null;
}

// Lookup table builder — supports both `type` and `id` aliases per rule so
// older saved configs keep working.
function buildRuleMap(rules) {
  const map = {};
  for (const r of rules || []) {
    if (r?.type) map[r.type] = r;
    if (r?.id) map[r.id] = r;
  }
  return map;
}

function ruleValue(rule, fmKey) {
  if (!rule || !fmKey) return 0;
  const v = parseFloat(rule.values?.[fmKey]);
  return Number.isFinite(v) ? v : 0;
}

// Returns an object describing the new non-cumulative changeover calculation
// for transitioning from `currentOrder` to `followingOrder`.
//
// Shape returned:
// {
//   total: number,           // final changeover hours
//   usedBaseOnly: boolean,   // true when no cleaning / no die change fired
//   cleaning: {              // highest triggered cleaning rule (or null)
//     rule, title, reason, value
//   } | null,
//   changeDie: {             // die-change component (or null)
//     rule, title, reason, value
//   } | null,
//   triggeredCleaningRules: [{ title, reason, value }],  // all that fired
//   breakdown: [{ rule, reason, value }],  // UI tooltip entries
// }
//
// Used by Dashboard's `applyChangeoverEnrichment` and by AI heuristics.
export function calculateAdditionalChangeover(currentOrder, followingOrder, rules) {
  const fm = LINE_TO_FM[currentOrder?.feedmill_line];
  if (!fm) {
    return {
      total: 0, usedBaseOnly: false,
      cleaning: null, changeDie: null,
      triggeredCleaningRules: [], breakdown: [],
    };
  }

  const curColor = normalizeColor(currentOrder?.color);
  const nxtColor = normalizeColor(followingOrder?.color);
  const curDiam  = parseFloat(currentOrder?.diameter)  || 0;
  const nxtDiam  = parseFloat(followingOrder?.diameter) || 0;
  const curCat   = normalizeCategory(currentOrder?.category);
  const nxtCat   = normalizeCategory(followingOrder?.category);

  const ruleMap = buildRuleMap(rules);

  // ── 1. Collect all triggered CLEANING rules ───────────────────────────
  const triggeredCleaning = [];

  // Yellow ↔ Brown
  const YELLOW_BROWN = ["yellow", "brown", "yellow/brown", "brown/yellow"];
  if (
    YELLOW_BROWN.includes(curColor) &&
    YELLOW_BROWN.includes(nxtColor) &&
    curColor !== nxtColor
  ) {
    const r = ruleMap["color_yellow_brown"] || ruleMap["yellow_brown"];
    const v = ruleValue(r, fm);
    if (v > 0) triggeredCleaning.push({ rule: r, title: r.title || "Color: Yellow ↔ Brown", reason: r.reason || "Cleaning", value: v });
  }

  // Red → Any (other than red)
  if (curColor === "red" && nxtColor !== "red") {
    const r = ruleMap["color_red_out"] || ruleMap["red_to_any"];
    const v = ruleValue(r, fm);
    if (v > 0) triggeredCleaning.push({ rule: r, title: r.title || "Color: Red → Any", reason: r.reason || "Flushing and Cleaning", value: v });
  }

  // Green → Any (other than green)
  if (curColor === "green" && nxtColor !== "green") {
    const r = ruleMap["color_green_out"] || ruleMap["green_to_any"];
    const v = ruleValue(r, fm);
    if (v > 0) triggeredCleaning.push({ rule: r, title: r.title || "Color: Green → Any", reason: r.reason || "Flushing and Cleaning", value: v });
  }

  // Any → Red or Green
  if (
    curColor !== nxtColor &&
    (nxtColor === "red" || nxtColor === "green") &&
    curColor !== "red" &&
    curColor !== "green"
  ) {
    const r = ruleMap["color_to_red_green"] || ruleMap["any_to_red_green"];
    const v = ruleValue(r, fm);
    if (v > 0) triggeredCleaning.push({ rule: r, title: r.title || "Color: Any → Red/Green", reason: r.reason || "Cleaning", value: v });
  }

  // Category change
  if (curCat && nxtCat && curCat !== nxtCat) {
    const r = ruleMap["category"] || ruleMap["category_change"];
    const v = ruleValue(r, fm);
    if (v > 0) triggeredCleaning.push({ rule: r, title: r.title || "Category Change", reason: r.reason || "Cleaning", value: v });
  }

  // ── 2. Select the HIGHEST cleaning rule only ──────────────────────────
  let selectedCleaning = null;
  if (triggeredCleaning.length > 0) {
    selectedCleaning = triggeredCleaning.reduce((best, c) => c.value > best.value ? c : best, triggeredCleaning[0]);
  }

  console.debug('[Changeover Cleaning Rule Selection]', {
    triggeredCleaningRules: triggeredCleaning.map(c => ({ title: c.title, value: c.value })),
    selectedHighestCleaningRule: selectedCleaning?.title ?? null,
    selectedHighestCleaningValue: selectedCleaning?.value ?? 0,
  });

  // ── 3. Check CHANGE DIE (diameter) ───────────────────────────────────
  let changeDie = null;
  if (curDiam > 0 && nxtDiam > 0 && curDiam !== nxtDiam) {
    const r = ruleMap["diameter_change"] || ruleMap["diameter"];
    const v = ruleValue(r, fm);
    if (v > 0) {
      changeDie = {
        rule: r,
        title: r.title || "Change Die",
        reason: r.reason || `Change Die (${curDiam}mm → ${nxtDiam}mm)`,
        value: v,
      };
    }
  }

  // ── 4. Apply new formula ──────────────────────────────────────────────
  // Base is NOT added on top of cleaning or change die — it is used ONLY
  // when neither cleaning nor die-change fires.
  const cleaningValue  = selectedCleaning?.value ?? 0;
  const changeDieValue = changeDie?.value ?? 0;
  const hasAnything    = cleaningValue > 0 || changeDieValue > 0;
  const total          = hasAnything ? parseFloat((cleaningValue + changeDieValue).toFixed(3)) : 0;

  // Build tooltip breakdown entries — include ALL triggered cleaning rules so
  // the UI can show context, but mark which one is actually used (selected).
  const breakdown = [];
  for (const c of triggeredCleaning) {
    breakdown.push({
      rule: c.title,
      reason: c.reason,
      value: c.value,
      selected: selectedCleaning ? c === selectedCleaning : false,
      type: "cleaning",
    });
  }
  if (changeDie) {
    breakdown.push({ rule: changeDie.title, reason: changeDie.reason, value: changeDie.value, selected: true, type: "die" });
  }

  console.debug('[Changeover Tooltip Breakdown]', {
    selectedCleaningRule: selectedCleaning?.title ?? null,
    changeDieApplied: !!changeDie,
    totalChangeover: total,
    breakdownMode: hasAnything ? 'cleaning_plus_change_die' : 'base_only',
  });

  return {
    total,
    usedBaseOnly: !hasAnything,
    cleaning: selectedCleaning,
    changeDie,
    triggeredCleaningRules: triggeredCleaning,
    breakdown,
  };
}

// Returns the TOTAL changeover hours for transitioning from `fromOrder` to
// `toOrder` using the new non-cumulative model.
//
// New formula:
//   • If neither cleaning nor change-die fires  → base only
//   • If cleaning only                          → highest cleaning value
//   • If change-die only                        → change-die value
//   • If both                                   → highest cleaning + change-die
//   (base is NOT added on top of cleaning/die)
export function calculateChangeoverBetween(fromOrder, toOrder, rules) {
  if (!fromOrder || !toOrder) return 0;

  const base = parseFloat(toOrder.changeover_time ?? fromOrder.changeover_time ?? 0.17) || 0;
  const result = calculateAdditionalChangeover(fromOrder, toOrder, rules || []);

  const fm = LINE_TO_FM[fromOrder?.feedmill_line];
  const total = result.usedBaseOnly ? base : result.total;

  console.debug('[Changeover Calculation - New Model]', {
    line: fromOrder?.feedmill_line,
    feedmill: fm,
    orderA: {
      color: normalizeColor(fromOrder?.color),
      category: normalizeCategory(fromOrder?.category),
      diameter: parseFloat(fromOrder?.diameter) || 0,
    },
    orderB: {
      color: normalizeColor(toOrder?.color),
      category: normalizeCategory(toOrder?.category),
      diameter: parseFloat(toOrder?.diameter) || 0,
    },
    baseChangeover: base,
    triggeredCleaningRules: result.triggeredCleaningRules.map(c => ({ title: c.title, value: c.value })),
    selectedCleaningRule: result.cleaning?.title ?? null,
    selectedCleaningValue: result.cleaning?.value ?? 0,
    changeDieApplied: !!result.changeDie,
    changeDieValue: result.changeDie?.value ?? 0,
    usedBaseOnly: result.usedBaseOnly,
    totalChangeover: total,
  });

  return parseFloat(total.toFixed(3));
}

// Builds a human-readable description of the LIVE changeover rules for
// inclusion in the AI prompt — now reflecting the new non-cumulative model.
export function buildDynamicChangeoverPromptSection(rules, lineKey = null) {
  const ruleMap = buildRuleMap(rules || []);
  const fmRow = (rule) => {
    if (!rule) return "n/a (rule not configured)";
    return `FM1: ${ruleValue(rule, "fm1").toFixed(2)} hr | FM2: ${ruleValue(rule, "fm2").toFixed(2)} hr | FM3: ${ruleValue(rule, "fm3").toFixed(2)} hr`;
  };

  const diameter  = ruleMap["diameter_change"]    || ruleMap["diameter"];
  const yellowBrn = ruleMap["color_yellow_brown"] || ruleMap["yellow_brown"];
  const redOut    = ruleMap["color_red_out"]      || ruleMap["red_to_any"];
  const greenOut  = ruleMap["color_green_out"]    || ruleMap["green_to_any"];
  const anyToRG   = ruleMap["color_to_red_green"] || ruleMap["any_to_red_green"];
  const category  = ruleMap["category"]           || ruleMap["category_change"];

  const fmKey = lineKey ? LINE_TO_FM[lineKey] : null;
  const fmKeyUpper = fmKey ? fmKey.toUpperCase() : null;

  const lineSpecificBlock = (() => {
    if (!lineKey) return "";
    if (lineKey === "Line 5" || !fmKey) {
      return `\n\nFOR ${lineKey} (THIS LINE):
  • Powermix is NOT governed by changeover rules. Transition cost = base only (no cleaning or die-change penalties).\n`;
    }
    const v = (rule) => rule ? ruleValue(rule, fmKey).toFixed(2) : "n/a";
    return `\n\nFOR ${lineKey} (THIS LINE) — use the ${fmKeyUpper} column for every value below:

  CHANGE DIE (pellet diameter change):
    • e.g. 3mm → 4mm  = ${v(diameter)} hr   ← standalone component (symmetric)

  CLEANING rules (use the HIGHEST triggered value only — do NOT sum them):
    • Yellow ↔ Brown         = ${v(yellowBrn)} hr
    • Red → Any              = ${v(redOut)} hr   ⚠ highest cleaning rule in most sequences
    • Green → Any            = ${v(greenOut)} hr  ⚠ highest cleaning rule in most sequences
    • Any → Red or Green     = ${v(anyToRG)} hr
    • Category change        = ${v(category)} hr

  FORMULA for ${lineKey}:
    1. No cleaning, no die change  → use Base changeover only (e.g. 0.17 hr)
    2. Cleaning only               → highest cleaning value (base dropped)
    3. Die change only             → die value (base dropped)
    4. Both cleaning + die change  → highest cleaning + die value (base dropped)

  WORKED EXAMPLE for ${lineKey}:
    Swine · Yellow · 3mm  →  Poultry · Red · 4mm
      Cleaning triggered: Any→Red (${v(anyToRG)}) and Category change (${v(category)})
      → select highest cleaning = ${Math.max(parseFloat(v(anyToRG)), parseFloat(v(category))).toFixed(2)} hr
      Die change triggered: 3mm→4mm = ${v(diameter)} hr
      Total = ${Math.max(parseFloat(v(anyToRG)), parseFloat(v(category))).toFixed(2)} + ${v(diameter)} = ${(Math.max(parseFloat(v(anyToRG)), parseFloat(v(category))) + parseFloat(v(diameter))).toFixed(2)} hr

  DIRECTION MATTERS for ${lineKey}:
    • Red → Any costs ${v(redOut)} hr (cleaning); Any → Red costs only ${v(anyToRG)} hr
    • Green → Any costs ${v(greenOut)} hr; Any → Green costs only ${v(anyToRG)} hr
    • Diameter change is symmetric (3mm→4mm and 4mm→3mm both cost ${v(diameter)} hr)\n`;
  })();

  return `LIVE CHANGEOVER RULES (from app configuration — feedmill-specific):

NEW NON-CUMULATIVE MODEL — do NOT sum all triggered rules together.
Formula:
  • No cleaning and no die change  →  Base changeover only  (e.g. 0.17 hr per order)
  • Cleaning only                  →  highest triggered cleaning value  (base is dropped)
  • Die change (diameter) only     →  Change Die value  (base is dropped)
  • Both cleaning + die change     →  highest cleaning  +  Change Die  (base is dropped)

CHANGE DIE — pellet diameter changes:
  • Diameter change (e.g. 3mm ↔ 4mm)   [symmetric, triggers as one component]
        ${fmRow(diameter)}

CLEANING rules — color/category transitions (select HIGHEST value only, never sum):
  • Yellow ↔ Brown
        ${fmRow(yellowBrn)}
  • Red → Any (other than Red)          ⚠ DIRECTIONAL — expensive outgoing
        ${fmRow(redOut)}
  • Green → Any (other than Green)      ⚠ DIRECTIONAL — expensive outgoing
        ${fmRow(greenOut)}
  • Any → Red or Green                  DIRECTIONAL — cheaper incoming
        ${fmRow(anyToRG)}
  • Category change (e.g. Swine → Poultry)
        ${fmRow(category)}

Feedmill assignment:  Line 1, 2 → FM1  |  Line 3, 4 → FM2  |  Line 6, 7 → FM3
                      Line 5 (Powermix) is not governed by these rules.${lineSpecificBlock}

EXAMPLES (FM1):
  A. Yellow→Red, same diameter, same category:
     cleaning = Any→Red (0.50 hr)  |  die = none  →  total = 0.50 hr
  B. Red→Yellow, 4mm→3mm, same category:
     cleaning = Red→Any (1.00 hr)  |  die = 1.50 hr  →  total = 2.50 hr
  C. Same color, same diameter, same category:
     no cleaning, no die  →  base only = 0.17 hr
  D. Yellow→Red, 3mm→4mm, Swine→Poultry:
     cleaning candidates: Any→Red (0.50) + Category (0.33) → highest = 0.50
     die = 1.50 hr  →  total = 0.50 + 1.50 = 2.00 hr

GOAL: minimise TOTAL changeover by choosing adjacencies that avoid cleaning
and die-change triggers.
Remember (in priority order):
  1. DIAMETER FIRST — a die change (diameter) is the single most expensive
     transition. Keep same-diameter orders contiguous as the TOP changeover
     priority; only break a diameter streak when a hard constraint (deadline,
     urgency tier, MTO / safe-window) forces it. Within one diameter run, order
     by color then category to minimise cleaning.
  2. Only the HIGHEST cleaning rule applies per transition — place the cheap
     cleaning transition before the expensive one rather than after. A single
     red-to-any or green-to-any transition is the dominant cleaning cost — group
     those orders together to limit flushing runs.
  3. Color direction matters: leaving red/green costs more than entering it.`;
}

// Last-resort fallback so AI logic never silently breaks if rules are
// missing. Mirrors the defaults from src/pages/ChangeoverRulesPage.jsx.
// Callers SHOULD pass live rules; this is purely defensive.
export function getFallbackChangeoverRules() {
  console.warn("[changeoverCalc] No changeover rules provided — using fallback defaults");
  return [
    { id: "diameter_change",   type: "diameter",            values: { fm1: 1.50, fm2: 1.00, fm3: 1.00 } },
    { id: "yellow_brown",      type: "color_yellow_brown",  values: { fm1: 0.33, fm2: 0.33, fm3: 0.33 } },
    { id: "red_to_any",        type: "color_red_out",       values: { fm1: 1.00, fm2: 1.00, fm3: 1.00 } },
    { id: "green_to_any",      type: "color_green_out",     values: { fm1: 1.00, fm2: 1.00, fm3: 1.00 } },
    { id: "any_to_red_green",  type: "color_to_red_green",  values: { fm1: 0.50, fm2: 0.50, fm3: 0.50 } },
    { id: "category_change",   type: "category",            values: { fm1: 0.33, fm2: 0.33, fm3: 0.33 } },
  ];
}
