/**
 * SINGLE SOURCE OF TRUTH — Product Stock Status
 *
 * This is THE ONLY function that determines stock status in the entire app.
 * Every component, service, and utility MUST use this function.
 * Never duplicate this logic elsewhere.
 *
 * RULES:
 *  Critical  — DFL >= Inventory (demand already exceeds stock)
 *  Urgent    — cumulative demand breaches inventory within 3 days
 *  Monitor   — cumulative demand breaches inventory within 4–10 days
 *  Sufficient— never breaches within 10 days (stock covers all demand)
 *
 * EXAMPLES:
 *  DFL 24.0, Inv 0.7  → 24.0 >= 0.7 → 'Critical'
 *  DFL 92.3, Inv 310.6 → never breaches → 'Sufficient'
 *
 * @param {number} dfl - Due for Loading (required demand)
 * @param {number} inventory - Current available stock
 * @param {Array} dailyColumnsOrValues
 *   One of two formats:
 *     A) Array of {key, date} (N10D UI column format) — requires `product` param
 *     B) Array of {date, value} OR a JSON string thereof (DB record format)
 * @param {Object|null} product
 *   When using format A, pass the product row so values are read as product[col.key].
 *   When using format B (or no daily data), pass null.
 * @param {Date} today - Current date (default: new Date())
 * @returns {'Critical'|'Urgent'|'Monitor'|'Sufficient'}
 */
export function getProductStatus(
  dfl,
  inventory,
  dailyColumnsOrValues = [],
  product = null,
  today = new Date()
) {
  const dflNum = parseFloat(dfl) || 0;
  const invNum = parseFloat(inventory) || 0;

  // CRITICAL: demand already equals or exceeds stock — production needed immediately
  if (dflNum >= invNum) return 'Critical';

  // Normalise daily values into [{date, value}] regardless of input format
  let dvArr = [];

  if (Array.isArray(dailyColumnsOrValues) && dailyColumnsOrValues.length > 0) {
    const first = dailyColumnsOrValues[0];
    if (product !== null && first && typeof first.key === 'string') {
      // Format A: dailyColumns = [{key, date}], values read from product[key]
      dvArr = dailyColumnsOrValues.map((col) => ({
        date: col.date,
        value: parseFloat(product[col.key]) || 0,
      }));
    } else {
      // Format B: already [{date, value}] objects
      dvArr = dailyColumnsOrValues;
    }
  } else if (typeof dailyColumnsOrValues === 'string') {
    // Format B variant: JSON string from DB
    try {
      dvArr = JSON.parse(dailyColumnsOrValues) || [];
    } catch {
      dvArr = [];
    }
  }

  if (dvArr.length === 0) return 'Sufficient';

  const todayClean = new Date(today);
  todayClean.setHours(0, 0, 0, 0);

  let cum = dflNum;
  for (const dv of dvArr) {
    cum += parseFloat(dv.value) || 0;
    if (cum >= invNum) {
      const breachDate = new Date(dv.date);
      breachDate.setHours(0, 0, 0, 0);
      const days = Math.ceil((breachDate - todayClean) / 86400000);
      if (days <= 3) return 'Urgent';
      if (days <= 10) return 'Monitor';
      return 'Sufficient';
    }
  }

  return 'Sufficient';
}

/**
 * STATUS ORDER for sorting (lowest index = highest urgency)
 */
export const STATUS_ORDER = { Critical: 0, Urgent: 1, Monitor: 2, Sufficient: 3 };
