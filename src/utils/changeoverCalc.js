// Shared changeover calculation utilities — single source of truth for both
// the live scheduling engine (Dashboard) and the AI sequencing engine
// (aiSequenceStrategies). All callers MUST pass the live `changeoverRules`
// configuration (from the Changeover Rules tab / localStorage) so that any
// edits the user makes are reflected immediately in AI prompts and heuristics.

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

// Returns the ADDITIONAL changeover hours that stack on top of the base
// changeover when `currentOrder` is followed by `followingOrder`. The
// breakdown array enumerates which rules contributed (used for tooltips).
//
// Used by Dashboard's `applyChangeoverEnrichment` to compute per-order
// `_changeoverTotal = base + additional` for the active sequence.
export function calculateAdditionalChangeover(currentOrder, followingOrder, rules) {
  const fm = LINE_TO_FM[currentOrder?.feedmill_line];
  if (!fm) return { total: 0, breakdown: [] };

  const curColor = normalizeColor(currentOrder?.color);
  const nxtColor = normalizeColor(followingOrder?.color);
  const curDiam = parseFloat(currentOrder?.diameter) || 0;
  const nxtDiam = parseFloat(followingOrder?.diameter) || 0;
  const curCat = normalizeCategory(currentOrder?.category);
  const nxtCat = normalizeCategory(followingOrder?.category);

  let totalAdd = 0;
  const breakdown = [];
  const ruleMap = buildRuleMap(rules);

  // Diameter change
  if (curDiam > 0 && nxtDiam > 0 && curDiam !== nxtDiam) {
    const r = ruleMap["diameter_change"] || ruleMap["diameter"];
    const v = ruleValue(r, fm);
    if (v > 0) {
      totalAdd += v;
      breakdown.push({ rule: r.title || "Change Pellet Diameter", reason: r.reason || "Change Die", value: v });
    }
  }

  // Color: yellow ↔ brown
  const YELLOW_BROWN = ["yellow", "brown", "yellow/brown", "brown/yellow"];
  if (
    YELLOW_BROWN.includes(curColor) &&
    YELLOW_BROWN.includes(nxtColor) &&
    curColor !== nxtColor
  ) {
    const r = ruleMap["color_yellow_brown"] || ruleMap["yellow_brown"];
    const v = ruleValue(r, fm);
    if (v > 0) {
      totalAdd += v;
      breakdown.push({ rule: r.title || "Color: Yellow ↔ Brown", reason: r.reason || "Cleaning", value: v });
    }
  }

  // Color: red → any (other than red)
  if (curColor === "red" && nxtColor !== "red") {
    const r = ruleMap["color_red_out"] || ruleMap["red_to_any"];
    const v = ruleValue(r, fm);
    if (v > 0) {
      totalAdd += v;
      breakdown.push({ rule: r.title || "Color: Red → Any", reason: r.reason || "Flushing and Cleaning", value: v });
    }
  }

  // Color: green → any (other than green)
  if (curColor === "green" && nxtColor !== "green") {
    const r = ruleMap["color_green_out"] || ruleMap["green_to_any"];
    const v = ruleValue(r, fm);
    if (v > 0) {
      totalAdd += v;
      breakdown.push({ rule: r.title || "Color: Green → Any", reason: r.reason || "Flushing and Cleaning", value: v });
    }
  }

  // Color: any (other than red/green) → red or green
  if (
    curColor !== nxtColor &&
    (nxtColor === "red" || nxtColor === "green") &&
    curColor !== "red" &&
    curColor !== "green"
  ) {
    const r = ruleMap["color_to_red_green"] || ruleMap["any_to_red_green"];
    const v = ruleValue(r, fm);
    if (v > 0) {
      totalAdd += v;
      breakdown.push({ rule: r.title || "Color: Any → Red/Green", reason: r.reason || "Cleaning", value: v });
    }
  }

  // Category change
  if (curCat && nxtCat && curCat !== nxtCat) {
    const r = ruleMap["category"] || ruleMap["category_change"];
    const v = ruleValue(r, fm);
    if (v > 0) {
      totalAdd += v;
      breakdown.push({ rule: r.title || "Category Change", reason: r.reason || "Cleaning", value: v });
    }
  }

  return { total: parseFloat(totalAdd.toFixed(3)), breakdown };
}

// Returns the TOTAL changeover (base + additional) for transitioning from
// `fromOrder` to `toOrder`. Used by AI sequencing heuristics to evaluate
// "what would the changeover cost be if I placed B right after A?"
//
// Base changeover is per-order and lives on `toOrder.changeover_time`
// (master-data field). The additional cost is rule-driven and feedmill-
// specific via `calculateAdditionalChangeover`.
export function calculateChangeoverBetween(fromOrder, toOrder, rules) {
  if (!fromOrder || !toOrder) return 0;
  const base = parseFloat(toOrder.changeover_time ?? fromOrder.changeover_time ?? 0.17) || 0;
  const { total: additional } = calculateAdditionalChangeover(fromOrder, toOrder, rules || []);
  return parseFloat((base + additional).toFixed(3));
}

// Builds a human-readable description of the LIVE changeover rules for
// inclusion in the AI prompt. Replaces the previous hardcoded matrix so the
// AI reasons with the user's actual configuration. When `lineKey` is given
// (e.g. "Line 3"), the section explicitly tells the AI which FM column to
// use for THIS line so it doesn't have to mentally re-map.
export function buildDynamicChangeoverPromptSection(rules, lineKey = null) {
  const ruleMap = buildRuleMap(rules || []);
  const fmRow = (rule) => {
    if (!rule) return "n/a (rule not configured)";
    return `FM1: ${ruleValue(rule, "fm1").toFixed(2)} hr | FM2: ${ruleValue(rule, "fm2").toFixed(2)} hr | FM3: ${ruleValue(rule, "fm3").toFixed(2)} hr`;
  };

  const diameter   = ruleMap["diameter_change"]    || ruleMap["diameter"];
  const yellowBrn  = ruleMap["color_yellow_brown"] || ruleMap["yellow_brown"];
  const redOut     = ruleMap["color_red_out"]      || ruleMap["red_to_any"];
  const greenOut   = ruleMap["color_green_out"]    || ruleMap["green_to_any"];
  const anyToRG    = ruleMap["color_to_red_green"] || ruleMap["any_to_red_green"];
  const category   = ruleMap["category"]           || ruleMap["category_change"];

  // Per-line FM resolution + line-specific values block. When the AI is
  // analysing a specific line we give it the resolved column up-front so it
  // optimises against the EXACT values that will be measured against it,
  // not a generic FM1/2/3 matrix it has to interpret.
  const fmKey = lineKey ? LINE_TO_FM[lineKey] : null;
  const fmKeyUpper = fmKey ? fmKey.toUpperCase() : null;
  const lineSpecificBlock = (() => {
    if (!lineKey) return "";
    if (lineKey === "Line 5" || !fmKey) {
      return `\n\nFOR ${lineKey} (THIS LINE):
  • Powermix is NOT governed by changeover rules. Adjacent transition cost is base only (no additional penalties stack).\n`;
    }
    const v = (rule) => rule ? ruleValue(rule, fmKey).toFixed(2) : "n/a";
    return `\n\nFOR ${lineKey} (THIS LINE) — use the ${fmKeyUpper} column for every penalty below:
  • Diameter change                       = ${v(diameter)} hr
  • Color: Yellow ↔ Brown                  = ${v(yellowBrn)} hr
  • Color: Red → Any (other than Red)      = ${v(redOut)} hr      ⚠ EXPENSIVE
  • Color: Green → Any (other than Green)  = ${v(greenOut)} hr    ⚠ EXPENSIVE
  • Color: Any → Red or Green              = ${v(anyToRG)} hr
  • Category change                        = ${v(category)} hr

  WORKED STACKING EXAMPLE for ${lineKey}:
    A swine order with red 4mm pellets followed by a poultry order with yellow 3mm
    pellets triggers FOUR rules at once and they ADD UP:
       diameter (${v(diameter)}) + Red → Any (${v(redOut)}) + Any → Yellow (0.00, not red/green)
                                     + category change (${v(category)})
       = ${(parseFloat(v(diameter)) + parseFloat(v(redOut)) + parseFloat(v(category))).toFixed(2)} hr ADDITIONAL on top of base.
    Choosing the next order to share AS MANY fields as possible (same color, same diameter,
    same category) is how you keep total changeover low.

  DIRECTION MATTERS for ${lineKey}:
    • Red → Any costs ${v(redOut)} hr but Any → Red costs only ${v(anyToRG)} hr — the direction
      of a red transition changes its cost, so where red falls in the sequence affects the total.
    • Same logic for green: Green → Any (${v(greenOut)}) vs Any → Green (${v(anyToRG)}).
    • Diameter change is symmetric (4mm→3mm and 3mm→4mm both cost ${v(diameter)} hr).\n`;
  })();

  return `LIVE CHANGEOVER RULES (from app configuration — feedmill-specific):

Base changeover (per order):  uses each order's changeover_hours value above (default 0.17 hr)

Additional changeover when consecutive orders differ — values STACK (multiple rules can fire on the same transition and they ADD together):
  • Diameter change (e.g. 3mm ↔ 4mm)
        ${fmRow(diameter)}
  • Color: Yellow ↔ Brown
        ${fmRow(yellowBrn)}
  • Color: Red → Any (other than Red)         (flushing required — DIRECTIONAL, expensive outgoing)
        ${fmRow(redOut)}
  • Color: Green → Any (other than Green)     (flushing required — DIRECTIONAL, expensive outgoing)
        ${fmRow(greenOut)}
  • Color: Any → Red or Green                  (cleaning required — DIRECTIONAL, cheaper incoming)
        ${fmRow(anyToRG)}
  • Category change (e.g. Swine → Poultry)
        ${fmRow(category)}

Feedmill assignment:  Line 1, Line 2 → FM1   |   Line 3, Line 4 → FM2   |   Line 6, Line 7 → FM3
                      Line 5 (Powermix) is not governed by these rules.${lineSpecificBlock}

GOAL: minimise TOTAL changeover hours across the entire production run by
choosing adjacencies that trigger the FEWEST and CHEAPEST rules. Use the EXACT
values above (not generic estimates) when reasoning about savings — these
reflect the user's current configuration. Remember:
  1. Penalties STACK — one transition can trigger 2-4 rules at once.
  2. Color rules are DIRECTIONAL — Red → X is more expensive than X → Red.
  3. A "minor" 0.33 hr category penalty repeated 5 times is 1.65 hr lost; consolidate.`;
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
