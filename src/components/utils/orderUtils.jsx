// Minimum MT thresholds per feedmill line
// Minimum MT thresholds keyed by individual line (as stored on orders)
// FM1 = Line 1, Line 2 → 40 MT minimum
// FM2 = Line 3, Line 4 → 20 MT minimum
// FM3 = Line 6, Line 7 → 20 MT minimum
// PMX = Line 5 → 0 MT (exempt)
export const MIN_MT_THRESHOLDS = {
  'Line 1': 40,
  'Line 2': 40,
  'Line 3': 20,
  'Line 4': 20,
  'Line 5': 0,  // Powermix — exempt
  'Line 6': 20,
  'Line 7': 20,
  // Also support feedmill group names for flexibility
  'Feedmill Line 1': 40,
  'Feedmill Line 2': 20,
  'Feedmill Line 3': 20,
  'Powermix Line': 0,
};

// Human-readable feedmill group name for a line
export function getFeedmillGroupName(feedmillLine) {
  if (!feedmillLine) return feedmillLine;
  const map = {
    'Line 1': 'Feedmill Line 1', 'Line 2': 'Feedmill Line 1',
    'Line 3': 'Feedmill Line 2', 'Line 4': 'Feedmill Line 2',
    'Line 6': 'Feedmill Line 3', 'Line 7': 'Feedmill Line 3',
    'Line 5': 'Powermix Line',
  };
  return map[feedmillLine] || feedmillLine;
}

// Get the minimum MT threshold for a given feedmill line
export function getMinMT(feedmillLine) {
  if (!feedmillLine) return 0;
  return MIN_MT_THRESHOLDS[feedmillLine] ?? 0;
}

// Parse date from SAP Remarks field
export function parseTargetDate(remarks) {
  if (!remarks) return null;
  
  // Pattern: "TLD | Jan 03" or similar
  const datePattern = /(?:TLD\s*\|\s*)?([A-Za-z]+)\s+(\d{1,2})/i;
  const match = remarks.match(datePattern);
  
  if (match) {
    const monthStr = match[1];
    const day = parseInt(match[2]);
    
    const months = {
      january: 0, february: 1, march: 2, april: 3,
      may: 4, june: 5, july: 6, august: 7,
      september: 8, october: 9, november: 10, december: 11,
      jan: 0, feb: 1, mar: 2, apr: 3,
      jun: 5, jul: 6, aug: 7,
      sep: 8, oct: 9, nov: 10, dec: 11,
    };

    const key = monthStr.toLowerCase();
    const month = months[key] ?? months[key.slice(0, 3)];
    if (month !== undefined) {
      const now = new Date();
      let year = now.getFullYear();
      
      // If the date seems to be in the past (e.g., parsed month < current month and day is past),
      // assume next year
      const parsedDate = new Date(year, month, day);
      if (parsedDate < now) {
        year += 1;
      }
      
      return new Date(year, month, day).toISOString().split('T')[0];
    }
  }
  
  // Return original remarks if not a valid date (e.g., "prio replenish")
  return remarks;
}

// Map feedmill line to tab
export function getFeedmillTab(feedmillLine) {
  if (!feedmillLine) return 'all';
  
  const line = feedmillLine.toLowerCase();
  
  if (line.includes('1') || line.includes('2')) return 'FM1';
  if (line.includes('3') || line.includes('4')) return 'FM2';
  if (line.includes('6') || line.includes('7')) return 'FM3';
  if (line.includes('5')) return 'PMX';
  
  return 'all';
}

// Filter orders by feedmill tab
export function filterByFeedmillTab(orders, tab) {
  if (tab === 'all') return orders;
  
  const lineMap = {
    'FM1': ['Line 1', 'Line 2'],
    'FM2': ['Line 3', 'Line 4'],
    'FM3': ['Line 6', 'Line 7'],
    'PMX': ['Line 5']
  };
  
  const validLines = lineMap[tab] || [];
  return orders.filter(order => validLines.includes(order.feedmill_line));
}

// Maps feedmill line → KB batch size column (covers all tabs: FM1, FM2, FM3, PMX)
export const BATCH_SIZE_COL_MAP = {
  'Line 1': 'batch_size_fm1',
  'Line 2': 'batch_size_fm1',
  'Line 3': 'batch_size_fm2',
  'Line 4': 'batch_size_fm2',
  'Line 5': 'batch_size_pmx',
  'Line 6': 'batch_size_fm3',
  'Line 7': 'batch_size_fm3',
};

// Maps feedmill line → KB run rate column (covers all lines)
export const RUN_RATE_COL_MAP = {
  'Line 1': 'line_1_run_rate',
  'Line 2': 'line_2_run_rate',
  'Line 3': 'line_3_run_rate',
  'Line 4': 'line_4_run_rate',
  'Line 5': 'line_5_run_rate',
  'Line 6': 'line_6_run_rate',
  'Line 7': 'line_7_run_rate',
};

/**
 * Apply KB data to a parsed/existing order.
 * Works for ALL feedmill tabs (FM1, FM2, FM3, PMX).
 * Returns the merged order object (does not mutate).
 */
export function applyKBToOrder(order, kbEntry) {
  if (!kbEntry) return order;
  const updates = {};
  if (kbEntry.form) updates.form = kbEntry.form;
  if (kbEntry.sfg1_material_code) updates.kb_sfg_material_code = kbEntry.sfg1_material_code;
  const bsKey = BATCH_SIZE_COL_MAP[order.feedmill_line];
  if (bsKey && kbEntry[bsKey] != null && kbEntry[bsKey] !== '') updates.batch_size = kbEntry[bsKey];
  const rrKey = RUN_RATE_COL_MAP[order.feedmill_line];
  if (rrKey && kbEntry[rrKey] != null && kbEntry[rrKey] !== '') updates.run_rate = kbEntry[rrKey];
  if (kbEntry.thread) updates.threads = kbEntry.thread;
  const sacksCode = kbEntry.sacks_material_code;
  const sacksDesc = kbEntry.sacks_item_description;
  if (sacksCode || sacksDesc) updates.sacks = [sacksCode, sacksDesc].filter(Boolean).join(' - ');
  const tagsCode = kbEntry.tags_material_code;
  const tagsDesc = kbEntry.tags_item_description;
  if (tagsCode || tagsDesc) updates.tags = [tagsCode, tagsDesc].filter(Boolean).join(' - ');
  return { ...order, ...updates };
}

/**
 * Build a fast lookup map from KB records: fg_material_code → KB row.
 */
export function buildKBMap(kbRecords) {
  const map = {};
  for (const r of kbRecords || []) {
    if (r.fg_material_code) map[String(r.fg_material_code).trim()] = r;
  }
  return map;
}

// Calculate number of bags
export function calculateBags(totalVolumeMT) {
  return totalVolumeMT ? Math.round((totalVolumeMT / 50) * 1000) : 0;
}

// Calculate number of batches
export function calculateBatches(totalVolumeMT, batchSize = 4) {
  return batchSize ? Math.ceil(totalVolumeMT / batchSize) : 0;
}

// Check if order is ready for production
export function checkReadiness(order) {
  const numBatches = calculateBatches(order.total_volume_mt, order.batch_size || 4);
  
  const hasRequiredFields = 
    order.fpr && 
    order.material_code && 
    order.total_volume_mt > 0;
  
  const haMatches = order.ha_available === numBatches;
  
  return hasRequiredFields && haMatches;
}

// Sort orders by target date (ascending, nulls at end)
export function sortByTargetDate(orders) {
  return [...orders].sort((a, b) => {
    const dateA = a.target_avail_date ? new Date(a.target_avail_date) : null;
    const dateB = b.target_avail_date ? new Date(b.target_avail_date) : null;
    
    if (!dateA && !dateB) return 0;
    if (!dateA || isNaN(dateA.getTime())) return 1;
    if (!dateB || isNaN(dateB.getTime())) return -1;
    
    return dateA - dateB;
  });
}

// Parse SAP Excel data to order format
export function parseSAPOrder(row, index) {
  const targetDate = parseTargetDate(row.Remarks || row.remarks);
  
  return {
    fpr: String(row.FPR || row.fpr || ''),
    material_code: String(row['Material Code'] || row.material_code || ''),
    item_description: row['Item Description'] || row.item_description || '',
    category: row.Category || row.category || '',
    feedmill_line: row['Feedmill Line'] || row.feedmill_line || '',
    total_volume_mt: parseFloat(row['Metric Ton'] || row.metric_ton || row.total_volume_mt || 0),
    form: '',
    batch_size: 4,
    target_avail_date: targetDate,
    start_date: null,
    start_time: null,
    production_hours: null,
    changeover_time: 0.17,
    run_rate: null,
    ha_available: null,
    formula_version: '',
    prod_version: '',
    fg: String(row.FG || row.fg || ''),
    sfg: String(row.SFG || row.sfg || ''),
    sfg1: String(row.SFG1 || row.sfg1 || ''),
    ha_prep_form_issuance: '',
    remarks: row.Remarks || row.remarks || '',
    prod_remarks: row['Prod Remarks'] || row.prod_remarks || row['Prod remarks'] || '',
    priority_seq: row['Prio. Seq.'] || row['Seq.'] || row.priority_seq || null,
    po_status: row['PO STATUS'] || row['PO Status'] || row['po status'] || '',
    status: 'normal'
  };
}

// Generate AI suggestions for order fields
export async function generateAISuggestions(order, invokeAI) {
  try {
    const response = await invokeAI({
      prompt: `For a feed production order with:
- Total Volume: ${order.total_volume_mt} MT
- Batch Size: ${order.batch_size || 4}
- Changeover Time: ${order.changeover_time || 0.17} hours

Suggest reasonable values for:
1. Production Hours (based on volume and typical feed mill operations)
2. Run Rate (MT per hour)
3. Start Time (suggest 08:00 AM for morning shift)

Return JSON only.`,
      response_json_schema: {
        type: 'object',
        properties: {
          production_hours: { type: 'number' },
          run_rate: { type: 'number' },
          start_time: { type: 'string' }
        }
      }
    });
    
    return response;
  } catch (error) {
    console.error('Error generating AI suggestions:', error);
    return {
      production_hours: Math.ceil(order.total_volume_mt / 10),
      run_rate: 10,
      start_time: '08:00 AM'
    };
  }
}