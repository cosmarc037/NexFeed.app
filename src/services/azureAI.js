import { getProductStatus } from '@/utils/statusUtils';

const AI_BASE = '/api/ai';

async function postAI(endpoint, body) {
  const res = await fetch(`${AI_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'AI request failed');
  }
  return res.json();
}

export async function suggestStartDateTime(orderData) {
  const availDate = orderData.target_avail_date;
  if (!availDate || isNaN(Date.parse(availDate))) {
    return { startDate: '', startTime: '' };
  }

  const systemPrompt = `You are a feed production scheduling assistant. Suggest a Start Date and Start Time for a production order by working backwards from the Avail Date (deadline).

Guidelines:
- Small orders (<50 MT): Start 1-2 days before Avail Date
- Medium orders (50-200 MT): Start 2-3 days before
- Large orders (>200 MT): Start 3-5 days before
- Default Start Time: 08:00 AM unless order specifics suggest otherwise
- Consider Production Hours and Changeover Time when calculating
- Skip weekends if possible

Respond ONLY with valid JSON: {"startDate": "YYYY-MM-DD", "startTime": "HH:MM AM/PM"}`;

  const userPrompt = `Order details:
- Suggested Volume: ${orderData.suggestedVolume || orderData.total_volume_mt} MT
- Batch Size: ${orderData.batch_size || 'N/A'}
- Number of Batches: ${orderData.numBatches || 'N/A'}
- Production Hours: ${orderData.production_hours || 'N/A'}
- Changeover Time: ${orderData.changeover_time || 0.17}
- Run Rate: ${orderData.run_rate || 'N/A'}
- Avail Date (deadline): ${availDate}
- Feedmill Line: ${orderData.feedmill_line || 'N/A'}`;

  try {
    const { content } = await postAI('suggest-start', { systemPrompt, userPrompt, maxTokens: 150 });
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return { startDate: parsed.startDate || '', startTime: parsed.startTime || '08:00 AM' };
    }
    return { startDate: '', startTime: '08:00 AM' };
  } catch {
    return { startDate: '', startTime: '' };
  }
}

export async function generateN10DSummary(records, sapOrders = []) {
  if (!records || records.length === 0) return null;

  // ── 1. PRE-CALCULATE EVERYTHING IN THE APP ──────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const fmtDate = (dateStr) => {
    if (!dateStr) return null;
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    } catch { return dateStr; }
  };

  // ── Helper: parse daily_values from stored record ────────────────────────
  const parseDV = (dv) => {
    if (!dv) return [];
    try { return typeof dv === 'string' ? JSON.parse(dv) : dv || []; } catch { return []; }
  };


  // ── Avail date (when cumulative first exceeds inventory) ──────────────────
  const computeAvailDate = (dfl, inv, daily_values) => {
    if (dfl >= inv) return today.toISOString().slice(0, 10);
    const dvArr = parseDV(daily_values);
    let cum = dfl;
    for (let i = 0; i < dvArr.length; i++) {
      cum += parseFloat(dvArr[i].value) || 0;
      if (cum >= inv) return dvArr[i].date;
    }
    return null;
  };

  const enriched = records.map(r => {
    const inv = parseFloat(r.inventory) || 0;
    const dfl = parseFloat(r.due_for_loading) || 0;
    // DFL = required amount to produce; Inventory = current stock
    // DFL > Inventory → urgent; DFL < Inventory → stock covers requirement
    const bufferPct = inv > 0 ? Math.round(((inv - dfl) / inv) * 100) : null;
    const status4 = getProductStatus(dfl, inv, r.daily_values, null, today);
    const availDate = computeAvailDate(dfl, inv, r.daily_values);

    let daysUntilAvail = null;
    if (availDate) {
      try {
        const ad = new Date(availDate); ad.setHours(0, 0, 0, 0);
        daysUntilAvail = Math.round((ad - today) / (1000 * 60 * 60 * 24));
      } catch {}
    }

    return {
      name: r.item_description,
      inv,
      dfl,
      bufferPct,
      status4,
      availDate,
      daysUntilAvail,
      availDateStr: fmtDate(availDate),
    };
  });

  const critical    = enriched.filter(p => p.status4 === 'Critical').sort((a, b) => (b.dfl / (b.inv || 1)) - (a.dfl / (a.inv || 1)));
  const urgentList  = enriched.filter(p => p.status4 === 'Urgent').sort((a, b) => (a.daysUntilAvail ?? 999) - (b.daysUntilAvail ?? 999));
  const monitorList = enriched.filter(p => p.status4 === 'Monitor').sort((a, b) => (a.daysUntilAvail ?? 999) - (b.daysUntilAvail ?? 999));
  const sufficient  = enriched.filter(p => p.status4 === 'Sufficient');

  const needsProd = enriched.filter(p => p.status4 !== 'Sufficient');

  const totalDeficit = enriched.reduce((sum, p) => {
    const d = p.dfl - p.inv;
    return d > 0 ? sum + d : sum;
  }, 0);

  const sapMatchedCodes = new Set((sapOrders || []).map(o => o.material_code).filter(Boolean));
  const matched = records.filter(r => sapMatchedCodes.has(r.material_code)).length;

  // Format one product line for the data block
  const fmtProd = (p) => {
    const dateNote = p.availDateStr
      ? `Avail: ${p.availDateStr}${p.daysUntilAvail !== null ? ` (in ${p.daysUntilAvail} day${p.daysUntilAvail !== 1 ? 's' : ''})` : ''}`
      : 'No breach in 10-day window';
    const buf = p.bufferPct !== null ? `${p.bufferPct}%` : 'N/A';
    return `- ${p.name}: ${dateNote}. Required (DFL): ${p.dfl} MT | Current Stock (Inv): ${p.inv} MT | Buffer: ${buf}`;
  };

  // ── 2. SYSTEM PROMPT — FORMATTING RULES ONLY ────────────────────────────
  const systemPrompt = `You are a feed production scheduling assistant writing a safety stock briefing note.

MOST IMPORTANT RULE — TOPIC HEADINGS MUST BE ON THEIR OWN LINE:
DO THIS:
📊 **Overview**
In total, we have 20 products...

DO NOT DO THIS:
📊 **Overview** In total, we have 20 products...

FORMATTING RULES:
- Topic headings use emoji + bold: 📊 **Overview** — ALWAYS on its own line
- Separate every topic with --- on its own line
- Write flowing narrative prose — products mentioned naturally in sentences
- Bold product names: **Product Name**
- Include all data inline: "with 127.8 MT demand against 376.4 MT inventory (66% buffer)"
- Do NOT recalculate buffer, target dates, or categories — use ONLY provided data
- Do NOT skip any product listed in the data
- Do NOT use bullet points (•) for individual products
- Do NOT include material codes
- Skip sections with zero products
- Only bold: topic heading text and product names

TONE: Concise, professional. A planner reads this in 20 seconds and knows exactly what to act on.`;

  // ── 3. USER PROMPT — ALL PRE-CALCULATED DATA ────────────────────────────
  const userPrompt = `Generate a safety stock narrative using ONLY the pre-calculated data below.

KEY DEFINITIONS:
- DFL (Due for Loading) = required MT to produce/load — higher DFL vs Inventory = more urgent
- Inventory = current available stock
- DFL > Inventory → Critical (needs production NOW)
- Avail = date when cumulative demand exceeds current stock (the breach date)

STATUS LEVELS: Critical (DFL already exceeds Inventory) → Urgent (breach within 3 days) → Monitor (breach within 4-10 days) → Sufficient (no breach in 10 days)

=== PRE-CALCULATED DATA ===

OVERVIEW:
- Total products: ${records.length}
- Needs production: ${needsProd.length} (Critical: ${critical.length}, Urgent: ${urgentList.length}, Monitor: ${monitorList.length})
- Stock sufficient: ${sufficient.length}
- Total deficit: ~${totalDeficit.toFixed(0)} MT
- SAP matched: ${matched} of ${records.length}

${critical.length > 0 ? `CRITICAL — DFL already exceeds Inventory (🔴 Critical — produce immediately):
${critical.map(p => fmtProd(p)).join('\n')}` : 'CRITICAL: (none — skip 🔴 section)'}

${urgentList.length > 0 ? `URGENT — breach within 3 days (🟠 Urgent — schedule now):
${urgentList.map(p => fmtProd(p)).join('\n')}` : 'URGENT: (none — skip 🟠 section)'}

${monitorList.length > 0 ? `MONITOR — breach within 4-10 days (🟡 Monitor — plan ahead):
${monitorList.map(p => fmtProd(p)).join('\n')}` : 'MONITOR: (none — skip 🟡 section)'}

${sufficient.length > 0 ? `SUFFICIENT — no breach in 10-day window (🟢 Stock Sufficient):
${sufficient.map(p => `- ${p.name}: Required (DFL): ${p.dfl} MT | Current Stock: ${p.inv} MT`).join('\n')}` : 'SUFFICIENT: (none — skip 🟢 section)'}

=== GENERATE NARRATIVE ===

Write the narrative now. Topics in order: 📊 Overview → 🔴 Critical → 🟠 Urgent → 🟡 Monitor → 🟢 Stock Sufficient → ✅ SAP Order Match
Separate each topic with ---
Each heading on its own line.`;

  // ── 4. POST-PROCESS — FORCE LINE BREAK AFTER HEADINGS ───────────────────
  function forceHeadingLineBreaks(text) {
    const headings = ['Overview', 'Critical', 'Urgent', 'Monitor', 'Stock Sufficient', 'SAP Order Match'];
    headings.forEach(h => {
      text = text.replace(new RegExp(`(\\*\\*${h}\\*\\*)[ \\t]+(?!\\n)`, 'g'), '$1\n');
      text = text.replace(new RegExp(`(${h})[ \\t]+(?!\\n)`, 'g'), '$1\n');
    });
    return text;
  }

  try {
    const { content } = await postAI('recommendations', { systemPrompt, userPrompt, maxTokens: 1100 });
    return content ? forceHeadingLineBreaks(content) : null;
  } catch {
    return null;
  }
}

export async function generateSmartRecommendations(ordersInView, context = {}) {
  if (!ordersInView || ordersInView.length === 0) {
    return '';
  }

  const now = new Date();
  const twoDays = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

  const urgent = ordersInView.filter(o => {
    if (!o.target_avail_date || o.status === 'completed') return false;
    try { const d = new Date(o.target_avail_date); return d <= twoDays && d >= now; } catch { return false; }
  });

  const materialGroups = {};
  ordersInView.forEach(o => {
    if (o.material_code && !['completed', 'cancel_po'].includes(o.status)) {
      if (!materialGroups[o.material_code]) materialGroups[o.material_code] = [];
      materialGroups[o.material_code].push(o);
    }
  });
  const combinable = Object.entries(materialGroups)
    .filter(([_, group]) => group.length >= 2)
    .map(([code, group]) => `Material Code ${code}: ${group.length} orders (${group.map(o => `${o.item_description || 'N/A'} ${o.total_volume_mt}MT`).join(', ')})`)
    .join('; ');

  const lineGroups = {};
  ordersInView.forEach(o => {
    if (o.feedmill_line) lineGroups[o.feedmill_line] = (lineGroups[o.feedmill_line] || 0) + 1;
  });

  const systemPrompt = `You are a feed production scheduling assistant for NexFeed. Provide 2-3 short numbered recommendations for the planner. Each should be one sentence, specific, and reference real order numbers, item names, or volumes. Keep it concise. Do not use markdown formatting — no asterisks, no bold (**), no italic (*), no hashes, no bullet dashes. Plain text only.`;

  const userPrompt = `Section: ${context.activeSection || 'orders'} / ${context.activeSubSection || 'all'}
Feedmill: ${context.activeFeedmill || 'All'}
Visible orders: ${ordersInView.length}
Urgent (due within 2 days): ${urgent.length}
Lines: ${Object.entries(lineGroups).map(([l,c]) => `${l}: ${c}`).join(', ') || 'N/A'}
Combine candidates: ${combinable || 'None'}

Orders (first 15):
${ordersInView.slice(0, 15).map((o, i) => `- #${i+1} ${o.item_description || o.material_code} | FPR: ${o.fpr || 'N/A'} | ${o.total_volume_mt || 0} MT | Status: ${o.status} | Line: ${o.feedmill_line || 'unassigned'} | Target: ${o.target_avail_date || 'N/A'} | Material: ${o.material_code}`).join('\n')}`;

  try {
    const { content } = await postAI('recommendations', { systemPrompt, userPrompt, maxTokens: 400 });
    return content;
  } catch {
    return '';
  }
}

export async function generateSmartAlerts(allOrders, alertsSummary) {
  if (!alertsSummary || alertsSummary.length === 0) return '';

  const systemPrompt = `You are a feed production scheduling assistant. Based on the active alerts below, provide 2-3 concise, actionable recommendations for the production planner. Be direct and practical. Keep it under 80 words. Do not use markdown — no asterisks, no bold, no bullet dashes, no hashes. Plain text only.`;

  const userPrompt = alertsSummary.map(a => `- ${a.title}: ${a.description}`).join('\n');

  try {
    const { content } = await postAI('alerts', { systemPrompt, userPrompt, maxTokens: 300 });
    return content;
  } catch {
    return '';
  }
}

export async function generateOverviewSummary(allOrders, lineCapacities = {}) {
  if (!allOrders || allOrders.length === 0) return 'No orders available. Upload SAP planned orders to see a production summary.';

  const totalOrders = allOrders.length;
  const inProd = allOrders.filter(o => o.status === 'in_production').length;
  const completed = allOrders.filter(o => o.status === 'completed').length;
  const planned = allOrders.filter(o => ['normal', 'plotted', 'cut', 'combined'].includes(o.status)).length;
  const cancelled = allOrders.filter(o => o.status === 'cancel_po').length;
  const now = new Date();
  const twoDays = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  const urgent = allOrders.filter(o => {
    if (!o.target_avail_date || o.status === 'completed') return false;
    try { const d = new Date(o.target_avail_date); return d <= twoDays && d >= now; } catch { return false; }
  }).length;

  const capSummary = Object.entries(lineCapacities)
    .map(([line, data]) => `${line}: ${data.current?.toFixed(0) || 0}/${data.max || 1000} MT`)
    .join(', ');

  const systemPrompt = `You are a production scheduling assistant. Provide a brief, natural language summary (2-3 sentences) of the current production status. Be concise, professional, and highlight key concerns. Do not use markdown — no asterisks, no bold, no bullet dashes, no hashes. Plain text only.`;

  const userPrompt = `- Total orders: ${totalOrders}
- In production: ${inProd}
- Completed: ${completed}
- Planned/Pending: ${planned}
- Cancelled: ${cancelled}
- Urgent (due in 2 days): ${urgent}
- Line capacities: ${capSummary || 'No data'}`;

  try {
    const { content } = await postAI('overview', { systemPrompt, userPrompt, maxTokens: 300 });
    return content;
  } catch {
    return 'Unable to generate summary at this time.';
  }
}

export async function generateAnalyticsInsights(analyticsData) {
  const systemPrompt = `You are a production analytics expert. Based on this feed production data, provide 3-4 brief, actionable insights. Focus on optimization opportunities and demand patterns. Do not use markdown — no asterisks, no bold, no bullet dashes, no hashes. Write in plain text sentences, separated by newlines.`;

  const userPrompt = `- Categories: ${JSON.stringify(analyticsData.categoryData?.slice(0, 5) || [])}
- Top items: ${JSON.stringify(analyticsData.topItems || [])}
- Lines distribution: ${JSON.stringify(analyticsData.lineData || [])}
- Total volume: ${analyticsData.totalVolume || 0} MT
- Total orders: ${analyticsData.totalOrders || 0}
- Completed: ${analyticsData.completed || 0}
- Form types: ${JSON.stringify(analyticsData.formData || [])}`;

  try {
    const { content } = await postAI('analytics', { systemPrompt, userPrompt, maxTokens: 400 });
    return content;
  } catch {
    return 'Unable to generate insights at this time.';
  }
}

export async function generateChartInsight(chartType, chartData) {
  const prompts = {
    volumeByCategory: {
      system: `You are a feed production analytics expert. Analyze the volume distribution by product category and provide 2-3 concise, actionable insights. Focus on demand concentration, category balance, and production planning implications. Keep it under 60 words.`,
      user: (data) => `Volume by Category data (MT):\n${JSON.stringify(data.categoryData || [])}\nTotal volume: ${data.totalVolume || 0} MT\nTotal orders: ${data.totalOrders || 0}`
    },
    ordersByLine: {
      system: `You are a feed production analytics expert. Analyze the order distribution across feedmill lines and provide 2-3 concise, actionable insights. Focus on workload balance, potential bottlenecks, and line allocation optimization. Keep it under 60 words.`,
      user: (data) => `Orders by Feedmill Line:\n${JSON.stringify(data.lineData || [])}\nTotal orders: ${data.totalOrders || 0}`
    },
    topItems: {
      system: `You are a feed production analytics expert. Analyze the top ordered items and provide 2-3 concise, actionable insights. Focus on demand patterns, inventory implications, and production prioritization. Keep it under 60 words.`,
      user: (data) => `Top 5 Most Ordered Items:\n${JSON.stringify(data.topItems || [])}\nTotal orders: ${data.totalOrders || 0}`
    },
    formDistribution: {
      system: `You are a feed production analytics expert. Analyze the form type distribution (e.g., pellet, mash, crumble) and provide 2-3 concise, actionable insights. Focus on equipment utilization, changeover optimization, and demand trends. Keep it under 60 words.`,
      user: (data) => `Form Type Distribution:\n${JSON.stringify(data.formData || [])}\nTotal orders: ${data.totalOrders || 0}`
    },
    lineUtilization: {
      system: `You are a feed production analytics expert. Analyze the line utilization percentages and provide 2-3 concise, actionable insights. Focus on capacity optimization, underutilized lines, and scheduling efficiency. Keep it under 60 words.`,
      user: (data) => `Line Utilization (%):\n${JSON.stringify(data.lineUtilData || [])}\nCapacity per line: ${data.lineCapacity || 30} orders`
    }
  };

  const config = prompts[chartType];
  if (!config) return 'No insight available for this chart type.';

  try {
    const { content } = await postAI('analytics', {
      systemPrompt: config.system,
      userPrompt: config.user(chartData),
      maxTokens: 250
    });
    return content;
  } catch {
    return 'Unable to generate insight at this time.';
  }
}

export async function chatWithAssistant(messageHistory, currentAppState = {}) {
  const ordersContext = `
Current production data:
- Total orders: ${currentAppState.totalOrders || 0}
- In production: ${currentAppState.inProduction || 0}
- Completed: ${currentAppState.completed || 0}
- Planned: ${currentAppState.planned || 0}
- Cancelled: ${currentAppState.cancelled || 0}
- Categories: ${currentAppState.categories || 'N/A'}
- Feedmill Lines: ${currentAppState.feedmillLines || 'N/A'}
- Total Volume: ${currentAppState.totalVolume || 0} MT
- Urgent orders: ${currentAppState.urgentOrders || 0}
`;

  const messages = [
    {
      role: 'system',
      content: `You are NexFeed Smart Assistant, a helpful assistant for feed production scheduling. You have access to the following production data:\n\n${ordersContext}\n\nYou can answer questions about current order status, provide scheduling recommendations, explain urgent/flagged orders, summarize production state and line capacity, and assist with app feature queries. Be concise and helpful.`
    },
    ...messageHistory,
  ];

  const { content } = await postAI('chat', { messages, maxTokens: 600 });
  return content;
}

export async function generateCutInsights(order, portion1, portion2, allOrders) {
  const batchSize   = parseFloat(order.batch_size ?? 1);
  const runRate     = parseFloat(order.run_rate ?? 0);
  const changeover  = parseFloat(order.changeover_time ?? 0.17);
  const totalVolume = parseFloat(order.volume_override ?? order.total_volume_mt ?? 0);
  const line        = order.feedmill_line || 'N/A';
  const form        = order.form || 'N/A';
  const priority    = order.priority_seq ?? '?';

  const EPS = 0.001;
  const p1Batches    = batchSize > 0 ? portion1 / batchSize : 0;
  const p2Batches    = batchSize > 0 ? portion2 / batchSize : 0;
  const totalBatches = batchSize > 0 ? totalVolume / batchSize : 0;
  const p1Hours      = runRate > 0 ? portion1 / runRate : 0;
  const p2Hours      = runRate > 0 ? portion2 / runRate : 0;
  const totalHours   = runRate > 0 ? totalVolume / runRate : 0;
  const changeoverMin = Math.round(changeover * 60);

  const p1Aligned = batchSize > 0 ? Math.abs(Math.round(p1Batches) * batchSize - portion1) < EPS : true;
  const p2Aligned = batchSize > 0 ? Math.abs(Math.round(p2Batches) * batchSize - portion2) < EPS : true;

  const lineOrders = (allOrders || [])
    .filter(o => o.feedmill_line === line && o.id !== order.id && o.status !== 'cancel_po' && o.status !== 'completed')
    .sort((a, b) => (a.priority_seq ?? 999) - (b.priority_seq ?? 999));

  const neighbours = lineOrders.slice(0, 8)
    .map(o => `  Prio ${o.priority_seq ?? '?'}: FPR ${o.fpr} — "${o.item_description}" | ${parseFloat(o.volume_override ?? o.total_volume_mt ?? 0)} MT | Form: ${o.form || 'N/A'} | Completion: ${o.target_completion_date || 'N/A'}`);

  const validSplits = [];
  if (batchSize > 0) {
    for (let b1 = 1; b1 < totalBatches; b1++) {
      const v1 = b1 * batchSize;
      const v2 = totalVolume - v1;
      if (v2 > 0 && Math.abs(Math.round(v2 / batchSize) * batchSize - v2) < EPS) {
        validSplits.push(`  • ${v1} MT + ${v2} MT (${b1} + ${Math.round(v2 / batchSize)} batches)`);
      }
    }
  }

  const systemPrompt = `You are a production planning advisor for a feed mill. Write 2-3 concise, professional insights about this order split. No headers, no bullet-point lists, no formal structure. Just plain paragraphs — each starting with an emoji. Clear and easy to understand.

Pick the most relevant insights based on the data:
1. ✅ or ⚠ — Batch validation: Does the split align with the batch size? If yes, confirm cleanly. If not, recommend the nearest valid split. Use actual numbers.
2. 💡 — Placement recommendation: Where should Portion 2 be placed on the line? Reference specific FPR numbers and product names. Prioritize same-form placement to avoid changeover.
3. 📅 — Schedule impact: Include only if a start date or availability date is set. Note estimated completion times. For priority replenishment orders, recommend running Portion 1 first.

Keep total under 120 words. Professional tone. Direct and specific. Use the actual numbers provided — never invent data.`;

  const userPrompt = `ORDER BEING CUT:
  FPR: ${order.fpr} | Line: ${line} | Form: ${form} | Priority: Prio ${priority}
  Item: ${order.item_description || 'N/A'}
  Total volume: ${totalVolume} MT (${totalBatches.toFixed(0)} batches total)
  Batch size: ${batchSize.toFixed(2)} | Run rate: ${runRate} MT/hr | Changeover: ${changeover} hr (${changeoverMin} min)
  Start date: ${order.start_date ? order.start_date + ' ' + (order.start_time || '') : 'Not set'}
  Completion date: ${order.target_completion_date || 'Not set'}
  Availability: ${order.target_avail_date || 'Not set'}

CUT SPLIT:
  Portion 1: ${portion1} MT → ${p1Batches.toFixed(2)} batches → ~${p1Hours.toFixed(2)} hrs  [Batch aligned: ${p1Aligned ? 'YES' : 'NO'}]
  Portion 2: ${portion2} MT → ${p2Batches.toFixed(2)} batches → ~${p2Hours.toFixed(2)} hrs  [Batch aligned: ${p2Aligned ? 'YES' : 'NO'}]
  Original total run time: ~${totalHours.toFixed(2)} hrs
  Split combined time: ~${(p1Hours + p2Hours + changeover).toFixed(2)} hrs (extra ${changeover} hr / ${changeoverMin} min changeover)

VALID BATCH-ALIGNED SPLITS:
${validSplits.slice(0, 5).join('\n') || '  (No batch size constraint)'}

LINE ORDERS on ${line} (${lineOrders.length} active orders):
${neighbours.join('\n') || '  None'}`;

  try {
    const { content } = await postAI('recommendations', { systemPrompt, userPrompt, maxTokens: 900 });
    return content;
  } catch {
    return '';
  }
}

function isValidAvailDate(v) {
  return v && !isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}/.test(v);
}

// Statuses that stay locked in position during auto-sequence re-sort.
// (completed and cancel_po are already filtered out before preSortOrders is called)
// Hard-locked: anchored at their indices unconditionally (cannot be bumped by Critical)
const PRESORT_HARD_LOCKED = new Set([
  'in_production',
  'ongoing_batching',
  'ongoing_pelleting',
  'ongoing_bagging',
]);
// Soft-locked: normally anchored, but Critical movable orders can bump them to next available slot
const PRESORT_LOCKED_STATUSES = new Set([
  ...PRESORT_HARD_LOCKED,
  'planned',
]);

export function preSortOrders(orders, inferredTargetMap = {}) {
  // ONE unified chronological sort — no bucket separation by source.
  // Locked statuses (in_production, ongoing_*, planned) stay at their original
  // index positions. Movable orders are sorted chronologically and fill gaps.

  const STATUS_ORDER = { Critical: 0, Urgent: 1, Monitor: 2, Sufficient: 3 };
  const _todayForSort = new Date(); _todayForSort.setHours(0, 0, 0, 0);

  // ── Step 1: Split hard-locked vs planned (soft-locked) vs movable ────────
  // Hard-locked: in_production, ongoing_* — always anchored, never bumped
  // Planned: anchored by default, but Critical movable orders can bump them
  const hardLockedByIndex = {};  // idx → order (never moved)
  const plannedByIndex = {};     // idx → order (can be bumped by Critical)
  const movableOrders = [];

  orders.forEach((o, idx) => {
    if (PRESORT_HARD_LOCKED.has(o.status)) {
      hardLockedByIndex[idx] = o;
    } else if (o.status === 'planned') {
      plannedByIndex[idx] = o;
    } else {
      movableOrders.push(o);
    }
  });

  // ── Step 2: Assign effective dates to movable orders ─────────────────────
  const withDate = [];
  const noDate = [];

  for (const o of movableOrders) {
    const inf = inferredTargetMap[o.material_code];

    const isHardDeadline = isValidAvailDate(o.target_avail_date)
      && !(o.avail_date_source === 'auto_sequence' && inf?.status === 'Sufficient');

    let effectiveDate = null;
    let n10dStatus = null;
    let dflToInvRatio = 0;

    if (isHardDeadline) {
      effectiveDate = new Date(o.target_avail_date);
      dflToInvRatio = -1;
    } else if (inf?.status === 'Critical') {
      effectiveDate = new Date(_todayForSort);
      n10dStatus = 'Critical';
      const dfl = parseFloat(inf.dueForLoading) || 0;
      const inv = parseFloat(inf.inventory) || 0;
      dflToInvRatio = inv > 0 ? dfl / inv : Infinity;
    } else if ((inf?.status === 'Urgent' || inf?.status === 'Monitor') && inf?.targetDate) {
      effectiveDate = new Date(inf.targetDate);
      n10dStatus = inf.status;
      const dfl = parseFloat(inf.dueForLoading) || 0;
      const inv = parseFloat(inf.inventory) || 0;
      dflToInvRatio = inv > 0 ? dfl / inv : Infinity;
    } else if (inf?.status === 'Sufficient' && inf?.targetDate) {
      effectiveDate = new Date(inf.targetDate);
      n10dStatus = 'Sufficient';
      const dfl = parseFloat(inf.dueForLoading) || 0;
      const inv = parseFloat(inf.inventory) || 0;
      dflToInvRatio = inv > 0 ? dfl / inv : 0;
    }

    if (effectiveDate) {
      withDate.push({ ...o, _effectiveDate: effectiveDate, _n10dStatus: n10dStatus, _dflToInvRatio: dflToInvRatio, _isHardDeadline: isHardDeadline });
    } else {
      noDate.push(o);
    }
  }

  // ── Step 3: Sort movable orders — Critical ALWAYS first, then chronological ─
  // Critical orders take absolute priority over any date-based order.
  // Among Critical: highest DFL/Inventory ratio first (deepest deficit wins).
  // Non-Critical: sorted chronologically, then by urgency, then volume.
  withDate.sort((a, b) => {
    const isCritA = a._n10dStatus === 'Critical';
    const isCritB = b._n10dStatus === 'Critical';
    // Critical beats non-Critical unconditionally
    if (isCritA && !isCritB) return -1;
    if (!isCritA && isCritB) return 1;
    // Both Critical — highest DFL/Inventory ratio first
    if (isCritA && isCritB) {
      const rA = a._dflToInvRatio ?? 0;
      const rB = b._dflToInvRatio ?? 0;
      if (Math.abs(rA - rB) > 0.001) return rB - rA;
      // Ratio tie — higher volume first
      const va = parseFloat((a.volume_override ?? a.total_volume_mt) || 0);
      const vb = parseFloat((b.volume_override ?? b.total_volume_mt) || 0);
      return vb - va;
    }
    // Neither Critical — chronological by effective date
    const diff = a._effectiveDate - b._effectiveDate;
    if (diff !== 0) return diff;
    const stA = STATUS_ORDER[a._n10dStatus] ?? 2;
    const stB = STATUS_ORDER[b._n10dStatus] ?? 2;
    if (stA !== stB) return stA - stB;
    const rA = a._dflToInvRatio ?? 0;
    const rB = b._dflToInvRatio ?? 0;
    if (Math.abs(rA - rB) > 0.001) return rB - rA;
    const va = parseFloat((a.volume_override ?? a.total_volume_mt) || 0);
    const vb = parseFloat((b.volume_override ?? b.total_volume_mt) || 0);
    return vb - va;
  });

  noDate.sort((a, b) => (a.priority_seq ?? 999) - (b.priority_seq ?? 999));

  const sortedMovable = [...withDate, ...noDate];

  // ── Step 4: Merge — Critical overrides Planned, hard-locked always anchored ─
  const totalSlots = orders.length;
  const result = new Array(totalSlots).fill(null);

  // 4a. Anchor hard-locked orders at their exact indices (never bumped)
  Object.entries(hardLockedByIndex).forEach(([idx, o]) => {
    result[parseInt(idx)] = o;
  });

  // 4b. All available (non-hard-locked) slots
  const availableSlots = [];
  for (let i = 0; i < totalSlots; i++) {
    if (result[i] === null) availableSlots.push(i);
  }

  // 4c. Identify Critical vs non-Critical movable orders
  const criticalMovable = sortedMovable.filter(o => o._n10dStatus === 'Critical');
  const nonCriticalMovable = sortedMovable.filter(o => o._n10dStatus !== 'Critical');

  // 4d. Critical orders fill the first N available slots (may displace Planned)
  let critIdx = 0;
  for (const slot of availableSlots) {
    if (critIdx >= criticalMovable.length) break;
    result[slot] = criticalMovable[critIdx++];
  }

  // 4e. Place Planned orders — at original slot if still free, else nearest available
  for (const [idx, plannedOrder] of Object.entries(plannedByIndex)) {
    const originalSlot = parseInt(idx);
    if (result[originalSlot] === null) {
      result[originalSlot] = plannedOrder;
    } else {
      // Slot taken by Critical — find nearest available slot at or after original
      const nearestForward = availableSlots.find(s => s >= originalSlot && result[s] === null);
      if (nearestForward !== undefined) {
        result[nearestForward] = plannedOrder;
      } else {
        // Fall back to any available slot
        const anySlot = availableSlots.find(s => result[s] === null);
        if (anySlot !== undefined) result[anySlot] = plannedOrder;
      }
    }
  }

  // 4f. Fill remaining slots with non-Critical movable orders
  let nonCritIdx = 0;
  for (let i = 0; i < totalSlots; i++) {
    if (result[i] === null && nonCritIdx < nonCriticalMovable.length) {
      result[i] = nonCriticalMovable[nonCritIdx++];
    }
  }

  return result.filter(o => o !== null);
}

export async function autoSequenceOrders(orders, feedmillName, lineName, inferredTargetMap = {}) {
  if (!orders || orders.length < 2) {
    return { error: 'At least 2 orders are needed for auto-sequencing.' };
  }

  const sortedOrders = preSortOrders(orders, inferredTargetMap);

  // Categorize each order: A=actual avail date, B=inferred target (incl. Critical), C=gap filler, D=stock sufficient
  const categorize = (o) => {
    const inf = inferredTargetMap[o.material_code];
    // Hard deadline only if NOT a Sufficient N10D-derived date written by auto-sequence
    const isHardDeadline = isValidAvailDate(o.target_avail_date)
      && !(o.avail_date_source === 'auto_sequence' && inf?.status === 'Sufficient');
    if (isHardDeadline) return 'A';
    if (inf?.status === 'Sufficient') return 'D';
    if (inf?.status === 'Critical' || inf?.status === 'Urgent' || inf?.status === 'Monitor') return 'B';
    return 'C';
  };

  const catCounts = { A: 0, B: 0, C: 0, D: 0 };
  sortedOrders.forEach(o => { catCounts[categorize(o)]++; });

  const hasStockData = Object.keys(inferredTargetMap).length > 0;

  const noStockDataNote = !hasStockData
    ? `\n\nNOTE: No Next 10 Days stock data is available for this line. Non-dated orders are treated as gap fillers with no date constraint. Consider uploading the "Next 10 Days" file for smarter prioritization.`
    : '';

  const systemPrompt = `You are NexFeed's AI scheduling optimizer for feed mill production. You calculate start times and completion dates for a pre-ordered production sequence.

CRITICAL — SEQUENCE IS FIXED:
The orders below are already sorted in the required sequence. You MUST assign proposedPrio 1, 2, 3... in EXACTLY the order they appear. Do NOT reorder.

Your only job is to:
1. Calculate startDate, startTime, and estimatedCompletion for each order in the given order.
2. Assign the correct status based on the order's category (see below).
3. Set moved=true if an order's position changed from its current Prio.

ORDER CATEGORIES:
- Category A: Actual avail date (hard deadline) — HIGHEST priority.
- Category B: Inferred target date from Next 10 Days stock data (soft deadline) — interleaved with A by date.
- Category C: Non-dated, no stock target — gap fillers placed between dated/targeted orders.
- Category D: Stock Sufficient — already has enough inventory; LOWEST priority.

SCHEDULING RULES:
- Schedule starts at ${new Date().toISOString().slice(0,10)} 08:00.
- Each order's Start = previous order's Completion (completion includes changeover time).
- Category A (actual avail date): status=green if completion ≤ AvailDate, status=red if completion > AvailDate.
- Category B (inferred target): status=blue if completion ≤ InferredTarget, status=amber if completion > InferredTarget.
- Category C (gap filler): status=grey.
- Category D (stock sufficient): status=lightgrey.

SEQUENCE ORDER (fixed — do not change):
ALL orders are pre-sorted in ONE single chronological list by effective date — no grouping by source.
- Cat A: effective date = actual avail date (hard deadline)
- Cat B: effective date = inferred stock target date from N10D (Critical = today)
- Cat D: effective date = last day of N10D 10-day window (Sufficient = stock covers demand for now)
- Cat C: no effective date — gap fillers placed AFTER all dated/targeted orders
Cat A, B, and D orders are ALL sorted together chronologically. A Sufficient order due Apr 9 appears BEFORE a hard-deadline order due Apr 11.${noStockDataNote}

RESPONSE FORMAT — respond ONLY with valid JSON:
{
  "proposedSequence": [
    {
      "id": <order_id>,
      "proposedPrio": <1-based position in the order listed below>,
      "startDate": "YYYY-MM-DD",
      "startTime": "HH:MM",
      "estimatedCompletion": "YYYY-MM-DD HH:MM",
      "status": "green|blue|yellow|amber|red|grey|lightgrey",
      "moved": true|false
    }
  ],
  "summary": {
    "totalOrders": <n>,
    "datedOrders": <n>,
    "stockTargeted": <n>,
    "gapFillersPlaced": <n>,
    "stockSufficient": <n>,
    "conflicts": <n>,
    "tradeoffs": <n>
  },
  "insights": [
    "Write a single plain-English paragraph explaining the overall sequencing logic. DO NOT use category codes (Cat A/B/C/D), color names (blue/amber/green/lightgrey), or technical terms like 'inferred target'. Use actual product names, FPR numbers, and friendly date formats (e.g. March 22, not 2026-03-22). Be conversational and actionable — like a planner briefing a colleague. When two orders share the same stock target date, explain which goes first and WHY — reference the fulfillment percentage and gap percentage (e.g. 'Gallimax is placed before Elite XP because its warehouse fulfillment is only 20% — 80% of production still needs to happen — vs. Elite XP at 45% fulfilled')."
  ]
}

Status meanings:
- green: Category A — completes on or before actual avail date ✅
- yellow: Category A — tight fit, near actual deadline
- red: Category A — will miss actual avail date 🔴
- blue: Category B — completes on or before inferred stock target date 📊
- amber: Category B — will miss inferred stock target date ⚠
- grey: Category C — no date, no target (gap filler)
- lightgrey: Category D — stock sufficient, lowest priority`;

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

  const orderLines = sortedOrders.map((o, i) => {
    const cat = categorize(o);
    const inf = inferredTargetMap[o.material_code];
    const vol = o.volume_override || o.total_volume_mt || 0;
    const availLabel = isValidAvailDate(o.target_avail_date) ? o.target_avail_date : (o.target_avail_date || 'NONE');
    let stockInfo = '';
    if (cat === 'B') {
      const dfl = parseFloat(inf.dueForLoading) || 0;
      const inv = parseFloat(inf.inventory) || 0;
      const dflToInvPct = inv > 0 ? ((dfl / inv) * 100).toFixed(1) : 'N/A';
      const urgent = inf.status === 'Critical' ? 'CRITICAL' : dfl / inv > 0.7 ? 'HIGH' : 'NORMAL';
      // Critical products: DFL >= Inv → breach is today (no future targetDate)
      const inferredTarget = inf.status === 'Critical' ? todayStr : (inf.targetDate || todayStr);
      stockInfo = ` | InferredTarget:${inferredTarget} | Required(DFL):${dfl.toFixed(1)}MT | Stock(Inv):${inv.toFixed(1)}MT | DFL/Inv:${dflToInvPct}% | Urgency:${urgent}${inf.note ? ' (⚠ unlikely in 10d)' : ''}`;
    } else if (cat === 'D') {
      stockInfo = ' | StockSufficient:true';
    }
    return `Seq:${i+1} | Cat:${cat} | ID:${o.id} | FPR:${o.fpr || '-'} | "${(o.item_description || '').substring(0, 40)}" | Vol:${vol}MT | ProdHrs:${o.production_hours || 0} | CO:${o.changeover_time ?? 0.17} | AvailDate:${availLabel}${stockInfo} | CurrentPrio:${o.priority_seq ?? i+1} | Start:${o.start_date || '-'} ${o.start_time || '-'}`;
  }).join('\n');

  const userPrompt = `Calculate timing for ${feedmillName} — ${lineName}.

Today: ${todayStr} | Schedule start: ${todayStr} 08:00
Orders: ${sortedOrders.length} total | Cat A (actual dated): ${catCounts.A} | Cat B (stock-targeted): ${catCounts.B} | Cat C (gap fillers): ${catCounts.C} | Cat D (stock sufficient): ${catCounts.D}

PRE-SORTED SEQUENCE (assign proposedPrio 1,2,3... in THIS EXACT ORDER):
${orderLines}

Calculate start/completion for each order in the order shown. Assign the correct status per the category rules. Return ONLY the JSON response.`;

  try {
    const { content } = await postAI('auto-sequence', { systemPrompt, userPrompt, maxTokens: 4000 });
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return { error: 'Could not parse AI response.' };

    let parsed;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      const repaired = repairTruncatedJson(match[0]);
      if (repaired) { parsed = repaired; }
      else return { error: 'AI response was truncated. Please try again.' };
    }

    // ── Override proposedPrio with deterministic pre-sort order ──────────────
    // The AI may shuffle sequence numbers; we must guarantee the final order
    // matches: dated (earliest→latest, same date → larger vol) → prio replenish
    // → safety stocks → other non-dated, each group in original relative order.
    // We keep AI timing data (startDate, startTime, estimatedCompletion, status)
    // but re-assign proposedPrio 1…N based on sortedOrders.
    if (parsed.proposedSequence && Array.isArray(parsed.proposedSequence)) {
      // Build a lookup: id → AI-provided timing fields
      const aiTimingById = {};
      parsed.proposedSequence.forEach(entry => {
        aiTimingById[String(entry.id)] = entry;
      });

      // Rebuild proposedSequence in effective-date order (the pre-sorted order)
      parsed.proposedSequence = sortedOrders.map((order, idx) => {
        const aiEntry = aiTimingById[String(order.id)] || {};
        const cat = categorize(order);
        const defaultStatus = cat === 'A' ? 'green' : cat === 'B' ? 'blue' : cat === 'D' ? 'lightgrey' : 'grey';
        return {
          id: order.id,
          proposedPrio: idx + 1,                     // deterministic — never from AI
          startDate: aiEntry.startDate || null,
          startTime: aiEntry.startTime || null,
          estimatedCompletion: aiEntry.estimatedCompletion || null,
          status: aiEntry.status || defaultStatus,
          moved: (order.priority_seq ?? (idx + 1)) !== (idx + 1),
          _category: cat,
        };
      });
    }

    // Inject no-stock-data note into insights if no N10D data uploaded
    if (!hasStockData) {
      if (!parsed.insights) parsed.insights = [];
      parsed.insights.unshift('📊 No stock level data available. Upload the "Next 10 Days" file in Configurations for smarter prioritization of prio replenish and safety stock orders.');
    }

    // Ensure summary includes stock category counts
    if (parsed.summary) {
      parsed.summary.stockTargeted = catCounts.B;
      parsed.summary.stockSufficient = catCounts.D;
    }

    return parsed;
  } catch (err) {
    return { error: err.message || 'Auto-sequence analysis failed.' };
  }
}

export async function generateSequenceInsights(simRows, feedmillName, lineName, excludedOrders = []) {
  if (!simRows || simRows.length === 0) return [];

  function fmtFriendlyDate(d) {
    if (!d) return null;
    try {
      const date = new Date(d);
      if (isNaN(date.getTime())) return d;
      return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    } catch { return d; }
  }

  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const orderLines = simRows.map((row, i) => {
    const vol = row.volume_override || row.total_volume_mt || 0;
    const availLabel = row.target_avail_date
      ? (/^\d{4}-\d{2}-\d{2}/.test(row.target_avail_date) ? fmtFriendlyDate(row.target_avail_date) : row.target_avail_date)
      : 'No deadline';
    const targetDateLabel = row._inferredTargetDate ? `Stock target date: ${fmtFriendlyDate(row._inferredTargetDate)}` : '';
    const stockStatus = row._category === 'D' ? 'Stock sufficient (warehouse inventory covers demand)' :
                        row._category === 'B' ? 'Needs production (warehouse stock running low)' :
                        row._category === 'A' ? 'Hard deadline (actual availability date set)' : 'No deadline (gap filler)';
    const completion = row._simCompletionStr || 'Not yet calculated (no start date set)';
    const timing = row._simStatus === 'red' ? 'AT RISK — will miss deadline' :
                   row._simStatus === 'amber' ? 'TIGHT — may be close to deadline' :
                   row._simStatus === 'green' ? 'ON TRACK — will meet deadline' :
                   row._simStatus === 'blue' ? 'ON TRACK — will meet stock target date' : 'No deadline constraint';
    const plannedNote = row.status === 'planned' ? ' | LOCKED — planner-decided position, not auto-sorted' : '';
    return `Prio ${row._simPrio ?? (i + 1)}: "${row.item_description || 'Unknown'}" | FPR: ${row.fpr || '-'} | ${vol} MT | Prod hours: ${row.production_hours || 0}h | Changeover: ${row.changeover_time ?? 0.17}h | ${stockStatus}${targetDateLabel ? ` | ${targetDateLabel}` : ''} | Avail date: ${availLabel} | Est. completion: ${completion} | Timing: ${timing}${plannedNote}`;
  }).join('\n');

  const excludedSummary = excludedOrders.length > 0
    ? excludedOrders.map((o, i) => {
        const realPrio = o._realPrio ?? (i + 1);
        const st = (o.status || 'unknown').replace(/_/g, ' ');
        return `Priority ${realPrio}: ${o.item_description || 'Unknown'} (${st})`;
      }).join(', ')
    : 'None';

  const plannedOrders = simRows.filter(r => r.status === 'planned');
  const plannedSummary = plannedOrders.length > 0
    ? plannedOrders.map(r => `${r.item_description} (locked at Priority ${r._simPrio})`).join(', ')
    : 'None';

  const systemPrompt = `You are a production planning advisor for a feed mill. Analyze the auto-sequence result below and write a comprehensive, human-friendly analysis for the production planner.

CRITICAL RULES — read carefully:
- DO NOT use category codes (Cat A, Cat B, Cat C, Cat D) — users don't know what these mean.
- DO NOT use color names (marked blue, marked amber, marked green, lightgrey) — never reference UI colors.
- DO NOT use technical terms like "inferred target", "inferred date" — say "stock target date" or "needed-by date based on warehouse demand".
- DO NOT use ISO date formats (2026-03-22) — always use friendly formats (March 22, Mar 22).
- DO use actual product names and FPR numbers from the data.
- DO be conversational and actionable — write like a colleague briefing a planner.
- MENTION excluded orders briefly (they are already in progress or completed, so not part of the sequence).
- MENTION Planned orders and explain they are locked at specific priorities by the planner's decision.
- EXPLAIN that the remaining orders were sorted chronologically by their availability/stock-target dates.

Write exactly 6 sections with these headings (include the emoji):
📋 Sequence Rationale
⚡ Production Impact
⏱ Time Savings
📅 Deadline Compliance
⚠ Risks to Watch
💡 What to Do Next

Each section should be 3-6 sentences or bullet points. Reference specific product names, FPR numbers, volumes, and dates from the data. Be specific and practical.`;

  const userPrompt = `Feedmill: ${feedmillName} | Line: ${lineName} | Today: ${today}
Total orders in sequence: ${simRows.length}
Orders excluded from sequencing (already in progress or completed): ${excludedSummary}
Planned orders locked at positions: ${plannedSummary}

Order sequence:
${orderLines}

Generate the 6-section analysis. Remember: no category codes, no color references, no ISO dates, no "inferred" terminology.`;

  try {
    const { content } = await postAI('recommendations', { systemPrompt, userPrompt, maxTokens: 1200 });
    // Split by the topic headings to get separate sections
    const sections = content.split(/(?=📋|⚡|⏱|📅|⚠|💡)/).map(s => s.trim()).filter(Boolean);
    return sections.length > 0 ? sections : [content];
  } catch {
    return [];
  }
}

// ── App-side calculation helpers (AI never calculates these) ─────────────────

function _parseISODate(val) {
  if (!val || typeof val !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(val)) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function _fmtDate(val) {
  const d = _parseISODate(val);
  if (!d) return val || 'none';
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

/**
 * Calculates the 1-based insertion priority for a new order among activeOrders
 * (already sorted by priority_seq asc).
 *
 * Rules:
 *  - Dated new order: scan through active orders; stop at the first order whose
 *    date is LATER than the new date (insert before it) OR at the first
 *    non-dated order (dated orders always come before non-dated ones).
 *  - Non-dated new order: insert right after the last dated order (before
 *    any existing non-dated orders) — i.e. at the bottom of active orders.
 */
function _calcInsertionPosition(newAvailDate, activeOrders) {
  const newDate = _parseISODate(newAvailDate);

  if (newDate) {
    // DATED new order — find the first order that should come AFTER it
    for (let i = 0; i < activeOrders.length; i++) {
      const o = activeOrders[i];
      const orderDate = _parseISODate(o.target_avail_date);

      // First non-dated order reached → new dated order goes before it
      if (!orderDate) {
        return {
          index: i,
          prio: i + 1,
          before: o,
          after: activeOrders[i - 1] || null,
          reason: 'after_last_dated_before_nondated',
        };
      }

      // First dated order that is strictly later → insert before it
      if (orderDate > newDate) {
        return {
          index: i,
          prio: i + 1,
          before: o,
          after: activeOrders[i - 1] || null,
          reason: 'chronological',
        };
      }
    }

    // New order's date is >= all existing dated orders; append at end of list
    return {
      index: activeOrders.length,
      prio: activeOrders.length + 1,
      before: null,
      after: activeOrders[activeOrders.length - 1] || null,
      reason: 'after_all_orders',
    };
  }

  // NON-DATED new order → place at the very bottom
  return {
    index: activeOrders.length,
    prio: activeOrders.length + 1,
    before: null,
    after: activeOrders[activeOrders.length - 1] || null,
    reason: 'non_dated_bottom',
  };
}

function _calcDownstream(activeOrders, insertIndex) {
  return activeOrders.slice(insertIndex).map((o, i) => ({
    product: o.item_description,
    availDate: _fmtDate(o.target_avail_date),
    oldPrio: insertIndex + 1 + i,
    newPrio: insertIndex + 2 + i,
  }));
}

function _calcRisk(activeOrders, insertIndex, totalAddedHrs) {
  const hasAnyStart = activeOrders.some(o => o.start_date);
  const risky = [];
  const safe  = [];

  for (let i = insertIndex; i < activeOrders.length; i++) {
    const o = activeOrders[i];
    const deadline = _parseISODate(o.target_avail_date);
    if (!deadline || !o.target_completion_date) continue;

    const curComp = new Date(o.target_completion_date);
    const newComp = new Date(curComp.getTime() + totalAddedHrs * 3_600_000);

    if (newComp > deadline) {
      const overH = ((newComp - deadline) / 3_600_000).toFixed(1);
      risky.push(
        `"${o.item_description}" (Prio ${insertIndex + 2 + (i - insertIndex)}): ` +
        `completion ${_fmtDate(o.target_completion_date)} → ` +
        `${newComp.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} — ` +
        `deadline ${_fmtDate(o.target_avail_date)} — EXCEEDS by ${overH}h`
      );
    } else {
      const bufH = ((deadline - newComp) / 3_600_000).toFixed(1);
      safe.push(`"${o.item_description}": ${bufH}h buffer remaining`);
    }
  }

  return { hasAnyStart, risky, safe };
}

export async function generateOrderImpactAnalysis(newOrder, existingOrders) {
  // ── Step 1: Filter and sort active orders for this line ───────────────────
  const activeOrders = (existingOrders || [])
    .filter(o =>
      o.feedmill_line === newOrder.feedmill_line &&
      o.status !== 'completed' &&
      o.status !== 'cancel_po'
    )
    .sort((a, b) => (a.priority_seq ?? 999) - (b.priority_seq ?? 999));

  // ── Step 2: APP calculates insertion position ─────────────────────────────
  const insertion = _calcInsertionPosition(newOrder.target_avail_date, activeOrders);

  // ── Step 3: APP calculates downstream shifts ──────────────────────────────
  const downstream = _calcDownstream(activeOrders, insertion.index);
  const downstreamText = downstream.slice(0, 12).map(s =>
    `• "${s.product}" (${s.availDate}): Prio ${s.oldPrio} → Prio ${s.newPrio}`
  ).join('\n');

  // ── Step 4: APP calculates production time ────────────────────────────────
  const prodHrs    = parseFloat(newOrder.production_hours) || 0;
  const changeover = 0.17;
  const totalAdded = prodHrs + changeover;

  // ── Step 5: APP calculates deadline risk ──────────────────────────────────
  const { hasAnyStart, risky, safe } = _calcRisk(activeOrders, insertion.index, totalAdded);

  let riskText;
  if (risky.length > 0) {
    riskText = `AT-RISK ORDERS (${risky.length}):\n${risky.join('\n')}`;
  } else if (!hasAnyStart) {
    riskText = `No start dates are set — completion dates cannot be calculated. Risk is indeterminate until a start date is configured for the line.`;
  } else {
    riskText = `NO RISK: Adding ${totalAdded.toFixed(2)}h does not push any downstream order past its deadline.` +
      (safe.length ? `\n${safe.slice(0, 2).join('; ')}` : '');
  }

  // ── Step 6: Schedule context (read-only for AI — do NOT recalculate) ───────
  const scheduleCtx = activeOrders.length
    ? activeOrders.map((o, i) =>
        `Prio ${i + 1}: "${o.item_description}" | ` +
        `Avail:${_fmtDate(o.target_avail_date)} | ` +
        `${parseFloat(o.volume_override ?? o.total_volume_mt) || 0}MT | ` +
        `Start:${o.start_date || 'not set'} | ` +
        `Completion:${o.target_completion_date || 'not set'}`
      ).join('\n')
    : '(No existing active orders on this line)';

  // ── Step 7: AI generates ONLY the narrative ───────────────────────────────
  const insertionDesc = (() => {
    if (insertion.after && insertion.before) {
      return `placed at Priority ${insertion.prio}, after "${insertion.after.item_description}" and before "${insertion.before.item_description}"`;
    } else if (insertion.after) {
      return `placed at Priority ${insertion.prio} at the bottom of the schedule, after "${insertion.after.item_description}"`;
    } else if (insertion.before) {
      return `placed at Priority ${insertion.prio} at the top of the schedule, before "${insertion.before.item_description}"`;
    }
    return `placed at Priority ${insertion.prio}`;
  })();

  const systemPrompt = `You are a feed production scheduling expert. Write a clean, professional impact analysis narrative.

CRITICAL RULES:
1. Write in complete, clear sentences — no raw field names, no variable names, no code labels
2. Do NOT output text like "Reason: non_dated_bottom" — embed all data naturally in sentences
3. Do NOT echo back raw data labels like "PRE-CALCULATED" or "CURRENT SCHEDULE"
4. Priorities are whole integers only (1, 2, 3…) — never fractional
5. Format all dates as "Month D, YYYY" (e.g. "March 22, 2026") — never YYYY-MM-DD
6. Use only product names — never show material codes
7. Keep each section to 2–3 sentences. Blank line between sections.

FORMAT — each section MUST follow this exact pattern:
  emoji **Section Header Label:**
  (blank line)
  Content text here. More content. End with period.

Use these exact section headers (emoji first, then bold label with colon):
📍 **Insertion Position:**
⏱ **Production Impact:**
⚠ **Downstream Effects:**
📅 **Deadline Risk:**

PUNCTUATION RULES:
- Colon (:) after every label (e.g. "Production time:", "Changeover:")
- Comma (,) in lists (e.g. "Priority 2, between X and Y")
- Em-dash (—) for asides (e.g. "0.40 hours — totaling...")
- Period (.) at end of every sentence
- No bullet points in Impact Analysis — prose only`;

  const userPrompt = `NEW ORDER:
Product: ${newOrder.item_description}
Volume: ${parseFloat(newOrder.total_volume_mt) || 0} MT
Line: ${newOrder.feedmill_line}
Available Date: ${_fmtDate(newOrder.target_avail_date)}
Production Time: ${prodHrs.toFixed(2)} hrs
Changeover: ${changeover} hrs
Total time added to line: ${totalAdded.toFixed(2)} hrs

INSERTION POSITION (write naturally — do not echo raw labels):
This order will be ${insertionDesc}.
${downstream.length} existing orders will shift down by one position.

DOWNSTREAM SHIFTS (first ${Math.min(downstream.length, 12)} shown):
${downstreamText || 'No orders shift.'}${downstream.length > 12 ? `\n...and ${downstream.length - 12} more orders also shift.` : ''}

RISK ASSESSMENT:
${riskText}

CURRENT SCHEDULE ON ${newOrder.feedmill_line} (for context only):
${scheduleCtx}`;

  const data = await postAI('recommendations', { systemPrompt, userPrompt, maxTokens: 650 });
  return data.content || 'Impact analysis unavailable.';
}

function repairTruncatedJson(raw) {
  try {
    // Try to close any open arrays/objects by tracking bracket depth
    let str = raw.trimEnd();
    // Remove trailing incomplete key/value (last unterminated string or partial object)
    // Strip trailing comma + incomplete fragment before closing
    str = str.replace(/,\s*\{[^}]*$/, '');  // remove last incomplete object
    str = str.replace(/,\s*"[^"]*$/, '');    // remove last incomplete string value
    str = str.replace(/,\s*$/, '');           // remove trailing comma

    // Count open braces/brackets and close them
    const opens = [];
    for (const ch of str) {
      if (ch === '{' || ch === '[') opens.push(ch);
      else if (ch === '}') { if (opens[opens.length-1] === '{') opens.pop(); }
      else if (ch === ']') { if (opens[opens.length-1] === '[') opens.pop(); }
    }
    // Close in reverse
    for (let i = opens.length - 1; i >= 0; i--) {
      str += opens[i] === '{' ? '}' : ']';
    }

    return JSON.parse(str);
  } catch {
    return null;
  }
}

export async function generateReportInsight(breakdown, monthName, year, monthOrders) {
  if (!breakdown) return '';
  const CATS = ['completed', 'in_progress', 'scheduled', 'on_hold', 'cancelled'];
  const overall = { completed: 0, in_progress: 0, scheduled: 0, on_hold: 0, cancelled: 0, total: 0 };
  Object.values(breakdown).forEach(fm => {
    CATS.forEach(c => { overall[c] += fm[c] || 0; });
    overall.total += fm.total || 0;
  });
  const pct = (v) => overall.total > 0 ? ((v / overall.total) * 100).toFixed(1) : '0.0';
  const fmt = (v) => (v || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });

  const fmSummary = Object.entries(breakdown)
    .map(([fm, d]) => {
      const fmPct = overall.total > 0 ? ((d.total / overall.total) * 100).toFixed(1) : '0.0';
      return `${fm}: ${fmt(d.total)} MT (${fmPct}% of total). Completed: ${fmt(d.completed)} MT, In Progress: ${fmt(d.in_progress)} MT, Scheduled: ${fmt(d.scheduled)} MT, On Hold: ${fmt(d.on_hold)} MT, Cancelled: ${fmt(d.cancelled)} MT.`;
    }).join('\n');

  const systemPrompt = `You are a professional feed production analyst generating a concise insight for a monthly production PDF report. Use flowing paragraphs for the overview, utilization, and completion sections. Use bullet points (starting with "- ") for Attention Areas and Recommendations. Use exactly the emoji headings shown. Keep each section to 2-3 sentences or bullets. Be specific with the provided numbers. Do not use markdown asterisks or bold markers.`;

  const userPrompt = `Generate a production insight for ${monthName} ${year} using exactly these section headers (include the emoji):

📊 Production Overview
⚖ Feedmill Utilization
📈 Completion Rate
⚠ Attention Areas
💡 Recommendations

DATA (use these numbers exactly):
Total Orders: ${monthOrders?.length || 0}
Total Volume: ${fmt(overall.total)} MT
Completed: ${fmt(overall.completed)} MT (${pct(overall.completed)}%)
In Progress: ${fmt(overall.in_progress)} MT (${pct(overall.in_progress)}%)
Scheduled: ${fmt(overall.scheduled)} MT (${pct(overall.scheduled)}%)
On Hold: ${fmt(overall.on_hold)} MT (${pct(overall.on_hold)}%)
Cancelled: ${fmt(overall.cancelled)} MT (${pct(overall.cancelled)}%)

Feedmill Breakdown:
${fmSummary}`;

  try {
    const { content } = await postAI('report_insight', { systemPrompt, userPrompt, maxTokens: 700 });
    return content;
  } catch {
    return 'Unable to generate insight at this time.';
  }
}

export async function generateDiversionImpact(order, selectedLine, calculations) {
  const fmt = v => v != null ? Number(v).toFixed(2) : 'N/A';

  const systemPrompt = `You are a production scheduling assistant generating a brief impact analysis for diverting a production order. Use exactly the 4 topic headings with their emoji. Keep each section to 1-2 sentences. Be specific with the numbers provided. Do not use markdown bold markers or asterisks.`;

  const userPrompt = `Generate an impact analysis for diverting this order. Use ONLY the pre-calculated data below.

ORDER:
Product: ${order.item_description || order.itemDescription || ''}
Volume: ${order.total_volume_mt || order.volume || 0} MT
Original Line: ${order.feedmill_line || order.line || ''} (SHUTDOWN)
Target Line: ${selectedLine.line}
Target Rate: ${selectedLine.rate} MT/hr
Original Rate: ${fmt(calculations.originalRate)} MT/hr
New Production Time: ${fmt(calculations.newProductionTime)} hrs
Original Production Time: ${fmt(calculations.originalProductionTime)} hrs
Insertion Position: Priority ${calculations.insertPosition}
Orders Shifted on Target Line: ${calculations.ordersShifted}

📍 Insertion Position:
Where the order will be placed on the target line.

⏱ Production Impact:
Compare original vs new production time. Note if faster or slower.

⚠ Downstream Effects:
How many orders shift on the target line.

📅 Deadline Risk:
Any deadline concerns based on the data.`;

  try {
    const { content } = await postAI('recommendations', { systemPrompt, userPrompt, maxTokens: 350 });
    return content;
  } catch {
    return 'Unable to generate impact analysis at this time.';
  }
}

// ── Per-product AI insights keyed by material_code ───────────────────────────
// Called after N10D upload and Re-apply. Returns { [material_code]: string }.
export async function generateProductInsights(n10dRecords, allOrders = []) {
  const insightMap = {};

  const _today = new Date(); _today.setHours(0, 0, 0, 0);
  const _parseDV = (dv) => {
    if (!dv) return [];
    try { return typeof dv === 'string' ? JSON.parse(dv) : (dv || []); } catch { return []; }
  };
  const _fmtFull = (d) => {
    if (!d) return null;
    try { return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); } catch { return null; }
  };
  const _parseInsights = (content, map) => {
    if (!content) return;
    // Collect multi-line insights: lines starting with [code]: start a new entry;
    // continuation lines (no [code]: prefix) append to the previous entry.
    let currentCode = null;
    content.split('\n').forEach(line => {
      const m = line.match(/^\[?(\w+)\]?:\s*(.+)/);
      if (m) {
        currentCode = m[1].trim();
        map[currentCode] = m[2].trim();
      } else if (currentCode && line.trim()) {
        map[currentCode] = (map[currentCode] || '') + ' ' + line.trim();
      }
    });
  };

  // ── PART A: N10D products ──────────────────────────────────────────────────
  const enriched = (n10dRecords || []).map(r => {
    const dfl = parseFloat(r.due_for_loading) || 0;
    const inv = parseFloat(r.inventory) || 0;
    const bufferPct = inv > 0 ? (((inv - dfl) / inv) * 100).toFixed(1) : '-100.0';
    const dvArr = _parseDV(r.daily_values);
    let status = 'Sufficient';
    let completionDate = null;
    let availDate = null;
    let daysUntilBreach = null;
    let totalDemand = 0, daysWithDemand = 0;

    dvArr.forEach(dv => {
      const v = parseFloat(dv.value) || 0;
      if (v > 0) { totalDemand += v; daysWithDemand++; }
    });
    const avgDailyDemand = daysWithDemand > 0 ? (totalDemand / daysWithDemand).toFixed(1) : null;

    if (dfl >= inv) {
      status = 'Critical';
      availDate = _today.toISOString().slice(0, 10);
      daysUntilBreach = 0;
    } else {
      let cum = dfl;
      for (let i = 0; i < dvArr.length; i++) {
        cum += parseFloat(dvArr[i].value) || 0;
        if (cum >= inv) {
          completionDate = i > 0 ? dvArr[i - 1].date : null;
          availDate = dvArr[i].date;
          daysUntilBreach = Math.ceil((new Date(availDate) - _today) / 86400000);
          status = daysUntilBreach <= 3 ? 'Urgent' : daysUntilBreach <= 10 ? 'Monitor' : 'Sufficient';
          break;
        }
      }
    }
    return {
      material_code: r.material_code,
      item_description: r.item_description || '',
      dfl, inv, bufferPct, status, daysUntilBreach, avgDailyDemand,
      completionStr: completionDate ? _fmtFull(completionDate) : null,
      availStr: availDate ? _fmtFull(availDate) : null,
    };
  });

  if (enriched.length > 0) {
    const productLines = enriched.map(p =>
      `[${p.material_code}] ${p.item_description}\n` +
      `DFL: ${p.dfl} MT | Inventory: ${p.inv} MT | Status: ${p.status} | Buffer: ${p.bufferPct}%\n` +
      `Completion: ${p.completionStr || 'N/A'} | Avail: ${p.availStr || 'N/A'}\n` +
      `Days until stockout: ${p.daysUntilBreach !== null ? p.daysUntilBreach : 'N/A (no breach in 10 days)'}\n` +
      `Daily avg demand: ${p.avgDailyDemand !== null ? p.avgDailyDemand + ' MT' : 'N/A'}`
    ).join('\n\n');

    const sysA = `You are a production planning advisor for a feed manufacturing plant. Generate a helpful 3-5 sentence production insight for each product.

RULES:
- Do NOT just restate the data. Provide actionable advice.
- Tell the planner WHEN to act, WHAT to do, and WHY.
- Include how many days remain before stockout.
- Mention risk level in plain language.
- Suggest specific actions based on the status.
- Use full month names (e.g., "April 5, 2026").
- Be direct and practical — write as if advising a colleague.
- Output each insight on a SINGLE LINE — no line breaks within an insight.

TONE PER STATUS:
Critical: Urgent. State deficit clearly. Recommend producing NOW or within 24 hours. Warn about consequences of delay.
Urgent: Firm. State exactly how many days remain. Recommend scheduling within 1-2 days. Mention last safe production date.
Monitor: Advisory. State the window (X days). Recommend planning within the coming week. Note buffer is shrinking.
Sufficient: Reassuring. Confirm stock covers demand. State how long inventory will last. Recommend routine monitoring only.`;

    const usrA = `Generate insights for these products. Output one per line: [material_code]: [3-5 sentence insight on a single line]\n\n${productLines}`;

    // Part A AI call — errors propagate to caller (no silent fallback for N10D products)
    const { content: contentA } = await postAI('recommendations', { systemPrompt: sysA, userPrompt: usrA, maxTokens: 2500 });
    _parseInsights(contentA, insightMap);

    // Template fallback ONLY for N10D products the AI didn't return a line for
    enriched.forEach(p => {
      if (!insightMap[String(p.material_code)]) {
        insightMap[String(p.material_code)] = _productInsightTemplate(p);
      }
    });
  }

  // ── PART B: Dated MTO orders without N10D data ────────────────────────────
  const n10dCodes = new Set(enriched.map(p => String(p.material_code)));
  const datedOrders = (allOrders || []).filter(o => {
    const code = String(o.material_code_fg || o.material_code || '');
    const av = String(o.avail_date || o.target_avail_date || '').toLowerCase().trim();
    return code && !n10dCodes.has(code) && av && av !== 'prio replenish' && av !== 'prio_replenish' && av !== 'safety stocks' && /\d/.test(av);
  });

  if (datedOrders.length > 0) {
    const orderLines = datedOrders.map(o => {
      const av = o.avail_date || o.target_avail_date || '';
      const deadline = av ? new Date(av) : null;
      const daysLeft = deadline && !isNaN(deadline) ? Math.ceil((deadline - _today) / 86400000) : null;
      const completionD = deadline && !isNaN(deadline) ? _fmtFull(new Date(deadline.getTime() - 86400000)) : null;
      return (
        `[${o.material_code_fg || o.material_code}] ${o.item_description || ''}\n` +
        `Volume: ${o.volume_override || o.total_volume_mt || 0} MT | Line: ${o.feedmill_line || 'unassigned'}\n` +
        `Deadline (Avail Date): ${av ? _fmtFull(av) : 'N/A'} | Expected Completion: ${completionD || 'N/A'}\n` +
        `Production Time: ${o.production_hours || 'N/A'} hrs | Changeover: ${o.changeover_time || 'N/A'} hrs\n` +
        `Days remaining: ${daysLeft !== null ? daysLeft : 'Unknown'} | Status: ${o.status || 'N/A'}`
      );
    }).join('\n\n');

    const sysB = `You are a production planning advisor for a feed manufacturing plant. Generate a helpful 3-5 sentence production insight for each Make-to-Order (MTO) order with a specific deadline.

RULES:
- Focus on whether the order is on track to meet its deadline.
- Calculate backward from deadline: when must production START.
- Mention days remaining until the deadline.
- Recommend specific actions if the deadline is at risk.
- Use full month names. Be direct and practical.
- Output each insight on a SINGLE LINE — no line breaks within an insight.

TONE:
< 2 days: Urgent. State production must start immediately.
2-5 days: Firm. Schedule production soon, confirm estimated completion vs deadline.
> 5 days: Reassuring. On track, suggest optimal start date.`;

    const usrB = `Generate insights for these MTO orders. Output one per line: [material_code]: [3-5 sentence insight on a single line]\n\n${orderLines}`;

    // Part B AI call — errors propagate to caller (no silent fallback for dated MTO orders)
    const { content: contentB } = await postAI('recommendations', { systemPrompt: sysB, userPrompt: usrB, maxTokens: 1800 });
    _parseInsights(contentB, insightMap);
  }

  // ── PART C: All remaining orders — template fallback ─────────────────────
  (allOrders || []).forEach(o => {
    const code = String(o.material_code_fg || o.material_code || '');
    if (code && !insightMap[code]) {
      insightMap[code] = `This order is scheduled for ${o.volume_override || o.total_volume_mt || 0} MT on ${o.feedmill_line || 'an unassigned line'}. No stock level data available from Next 10 Days.`;
    }
  });

  return insightMap;
}

function _productInsightTemplate(p) {
  const buf = p.bufferPct;
  const days = p.daysUntilBreach;
  const avg = p.avgDailyDemand ? ` Daily average demand is ${p.avgDailyDemand} MT.` : '';
  if (p.status === 'Critical') {
    const deficit = (Number(p.dfl) - Number(p.inv)).toFixed(1);
    return `Immediate production is required. Current inventory (${Number(p.inv).toFixed(1)} MT) has already fallen below the required demand (${Number(p.dfl).toFixed(1)} MT), creating a ${deficit} MT deficit. Every hour of delay risks stockout and potential delivery failures.${avg} Prioritize this product on the next available line and consider bumping lower-priority orders if necessary.`;
  }
  if (p.status === 'Urgent') {
    return `Stock will run out by ${p.availStr || 'within 3 days'} — only ${days !== null ? days : 'a few'} days remaining. Production must be scheduled no later than ${p.completionStr || 'immediately'} to avoid a shortfall. The current buffer of ${buf}% is thin and will erode quickly.${avg} Check line availability for the earliest possible slot.`;
  }
  if (p.status === 'Monitor') {
    return `Demand is projected to exceed inventory by ${p.availStr || 'within 10 days'}, giving approximately ${days !== null ? days : 'several'} days to schedule production. The ${buf}% buffer provides a window, but stock is steadily being consumed.${avg} Plan to begin production within the coming week to stay ahead of the curve.`;
  }
  return `No immediate production action needed. Current inventory (${Number(p.inv).toFixed(1)} MT) comfortably exceeds demand (${Number(p.dfl).toFixed(1)} MT) with a ${buf}% buffer that will last well beyond the 10-day window.${avg} Continue routine monitoring and focus production resources on higher-priority products.`;
}

// ── PHASE 1: Template lines — instant, no AI ──────────────────────────────────
// Returns { [material_code]: { template: string (no emoji), templateEmoji: string (with emoji) } }
export function buildInsightTemplates(n10dRecords, allOrders) {
  const templateMap = {};
  const today = new Date(); today.setHours(0, 0, 0, 0);

  const _parseDV = (dv) => {
    if (!dv) return [];
    try { return typeof dv === 'string' ? JSON.parse(dv) : (dv || []); } catch { return []; }
  };
  const _fmtFull = (d) => {
    if (!d) return null;
    try { return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); } catch { return null; }
  };
  const _makePair = (text, emoji) => ({ template: text, templateEmoji: emoji + text });

  const n10dCodes = new Set();

  (n10dRecords || []).forEach(r => {
    const code = String(r.material_code || '');
    if (!code) return;
    n10dCodes.add(code);

    const dfl = parseFloat(r.due_for_loading) || 0;
    const inv = parseFloat(r.inventory) || 0;
    const bufferPct = inv > 0 ? (((inv - dfl) / inv) * 100).toFixed(1) : '-100.0';
    const dvArr = _parseDV(r.daily_values);

    let status = 'Sufficient';
    let availDate = null;
    let completionDate = null;

    if (dfl >= inv) {
      status = 'Critical';
    } else {
      let cum = dfl;
      for (let i = 0; i < dvArr.length; i++) {
        cum += parseFloat(dvArr[i].value) || 0;
        if (cum >= inv) {
          availDate = dvArr[i].date;
          completionDate = i > 0 ? dvArr[i - 1].date : null;
          const days = Math.ceil((new Date(availDate) - today) / 86400000);
          status = days <= 3 ? 'Urgent' : days <= 10 ? 'Monitor' : 'Sufficient';
          break;
        }
      }
    }

    const availStr = _fmtFull(availDate);
    const compStr = _fmtFull(completionDate);

    let text;
    switch (status) {
      case 'Critical': {
        const deficit = (dfl - inv).toFixed(1);
        text = `This product is on Critical. Current inventory (${inv.toFixed(1)} MT) has already fallen below the required demand (${dfl.toFixed(1)} MT), creating a ${deficit} MT deficit. Immediate production is needed to prevent stockout.`;
        templateMap[code] = _makePair(text, '⚠ ');
        break;
      }
      case 'Urgent':
        text = `This product is on Urgent. Demand will exceed inventory by ${availStr}${compStr ? `, with ${compStr} as the last safe production date` : ''}. The ${bufferPct}% buffer is thin and will erode quickly — production should be scheduled within 1-2 days.`;
        templateMap[code] = _makePair(text, '⚠ ');
        break;
      case 'Monitor':
        text = `This product is on Monitor. Demand will exceed inventory by ${availStr}${compStr ? `, with ${compStr} as the last safe production date` : ''}. The ${bufferPct}% buffer provides a window — production should be planned within the coming week.`;
        templateMap[code] = _makePair(text, '📋 ');
        break;
      default:
        text = `This product is on Sufficient. Current inventory (${inv.toFixed(1)} MT) comfortably covers the required demand (${dfl.toFixed(1)} MT) with a ${bufferPct}% buffer. No immediate production action is needed.`;
        templateMap[code] = _makePair(text, '✅ ');
    }
  });

  (allOrders || []).forEach(o => {
    const code = String(o.material_code_fg || o.material_code || '');
    if (!code || n10dCodes.has(code) || templateMap[code]) return;

    const av = String(o.avail_date || o.target_avail_date || '').toLowerCase().trim();
    const isDated = av && av !== 'prio replenish' && av !== 'prio_replenish' && av !== 'safety stocks' && /\d/.test(av);

    if (isDated) {
      const rawDate = o.avail_date || o.target_avail_date;
      const deadline = new Date(rawDate);
      const daysLeft = !isNaN(deadline) ? Math.ceil((deadline - today) / 86400000) : null;
      const prodTime = o.production_hours ? Number(o.production_hours).toFixed(2) : 'N/A';
      const text = `This order has a deadline of ${_fmtFull(rawDate)} — ${daysLeft !== null ? daysLeft : 'Unknown'} days remaining. Estimated production time is ${prodTime} hours.`;
      templateMap[code] = _makePair(text, '📅 ');
    } else {
      const vol = o.volume_override || o.total_volume_mt || 0;
      const lineName = o.feedmill_line || 'an unassigned line';
      const text = `No stock level data available from Next 10 Days. This order is scheduled for ${vol} MT on ${lineName}.`;
      templateMap[code] = { template: text, templateEmoji: text };
    }
  });

  return templateMap;
}

// ── PHASE 2: AI advisory sentences — async ───────────────────────────────────
// Returns { [material_code]: aiText } — only the AI advisory part (no template).
// Errors propagate to caller; no silent fallback for N10D products or dated MTO orders.
export async function generateProductAIInsights(n10dRecords, allOrders) {
  const aiMap = {};

  const _today = new Date(); _today.setHours(0, 0, 0, 0);
  const _parseDV = (dv) => {
    if (!dv) return [];
    try { return typeof dv === 'string' ? JSON.parse(dv) : (dv || []); } catch { return []; }
  };
  const _fmtFull = (d) => {
    if (!d) return null;
    try { return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); } catch { return null; }
  };
  // Parse JSON response: {"code": "advisory text", ...}
  // Falls back to line-based parsing if JSON fails.
  const _parseAI = (content, map) => {
    if (!content) return;
    // Try JSON first (most reliable)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        Object.entries(parsed).forEach(([code, text]) => {
          if (code && text) map[String(code).trim()] = String(text).trim();
        });
        return;
      } catch { /* fall through to line parser */ }
    }
    // Fallback: line-based — handles codes with hyphens, dots, slashes
    let currentCode = null;
    content.split('\n').forEach(line => {
      const m = line.match(/^\[?([^\]\s:]+)\]?:\s*(.+)/);
      if (m) {
        currentCode = m[1].trim();
        map[currentCode] = m[2].trim();
      } else if (currentCode && line.trim()) {
        map[currentCode] = (map[currentCode] || '') + ' ' + line.trim();
      }
    });
  };

  const _chunkArray = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  // ── Part A: N10D products ───────────────────────────────────────────────────
  const enriched = (n10dRecords || []).map(r => {
    const dfl = parseFloat(r.due_for_loading) || 0;
    const inv = parseFloat(r.inventory) || 0;
    const bufferPct = inv > 0 ? (((inv - dfl) / inv) * 100).toFixed(1) : '-100.0';
    const dvArr = _parseDV(r.daily_values);
    let status = 'Sufficient';
    let completionDate = null;
    let availDate = null;
    let daysUntilBreach = null;
    let totalDemand = 0, daysWithDemand = 0;

    dvArr.forEach(dv => {
      const v = parseFloat(dv.value) || 0;
      if (v > 0) { totalDemand += v; daysWithDemand++; }
    });
    const avgDailyDemand = daysWithDemand > 0 ? (totalDemand / daysWithDemand).toFixed(1) : null;

    if (dfl >= inv) {
      status = 'Critical';
      availDate = _today.toISOString().slice(0, 10);
      daysUntilBreach = 0;
    } else {
      let cum = dfl;
      for (let i = 0; i < dvArr.length; i++) {
        cum += parseFloat(dvArr[i].value) || 0;
        if (cum >= inv) {
          completionDate = i > 0 ? dvArr[i - 1].date : null;
          availDate = dvArr[i].date;
          daysUntilBreach = Math.ceil((new Date(availDate) - _today) / 86400000);
          status = daysUntilBreach <= 3 ? 'Urgent' : daysUntilBreach <= 10 ? 'Monitor' : 'Sufficient';
          break;
        }
      }
    }
    return {
      material_code: r.material_code,
      item_description: r.item_description || '',
      dfl, inv, bufferPct, status, daysUntilBreach, avgDailyDemand,
      completionStr: completionDate ? _fmtFull(completionDate) : null,
      availStr: availDate ? _fmtFull(availDate) : null,
    };
  });

  if (enriched.length > 0) {
    const sysA = `You are a production planning advisor for a feed manufacturing plant. Generate a helpful 3-5 sentence production insight for each product.

RULES:
- Do NOT just restate the data. Provide actionable advice.
- Tell the planner WHEN to act, WHAT to do, and WHY.
- Include how many days remain before stockout.
- Mention risk level in plain language.
- Suggest specific actions based on the status.
- Use full month names (e.g., "April 5, 2026").
- Be direct and practical — write as if advising a colleague.
- Do NOT include the status header line — only write advisory sentences.
- Output each insight on a SINGLE LINE — no line breaks within an insight.

TONE PER STATUS:
Critical: Urgent. State deficit clearly. Recommend producing NOW or within 24 hours. Warn about consequences of delay. Mention bumping lower-priority orders.
Urgent: Firm. State exactly how many days remain. Recommend scheduling within 1-2 days. Mention last safe production date. Suggest checking line availability.
Monitor: Advisory. State the window (X days). Recommend planning within the coming week. Note buffer is shrinking. Suggest monitoring daily demand.
Sufficient: Reassuring. Confirm stock covers demand. State how long inventory will last. Recommend routine monitoring only.

OUTPUT FORMAT: Return ONLY a valid JSON object — no markdown, no explanation — like this:
{"material_code_1": "advisory text", "material_code_2": "advisory text"}`;

    const chunks = _chunkArray(enriched, 8);
    for (const chunk of chunks) {
      const productLines = chunk.map(p =>
        `material_code: ${p.material_code}\n` +
        `description: ${p.item_description}\n` +
        `DFL: ${p.dfl} MT | Inventory: ${p.inv} MT | Status: ${p.status} | Buffer: ${p.bufferPct}%\n` +
        `Completion: ${p.completionStr || 'N/A'} | Avail: ${p.availStr || 'N/A'}\n` +
        `Days until stockout: ${p.daysUntilBreach !== null ? p.daysUntilBreach : 'N/A (no breach in 10 days)'}\n` +
        `Daily avg demand: ${p.avgDailyDemand !== null ? p.avgDailyDemand + ' MT' : 'N/A'}`
      ).join('\n---\n');
      const usrA = `Generate advisory insights for these products. Return ONLY a JSON object where each key is the exact material_code and each value is a 3-5 sentence advisory.\n\n${productLines}`;
      const { content: contentA } = await postAI('recommendations', { systemPrompt: sysA, userPrompt: usrA, maxTokens: 2000 });
      _parseAI(contentA, aiMap);
    }
  }

  // ── Part B: Dated MTO orders without N10D data ────────────────────────────
  const n10dCodes = new Set(enriched.map(p => String(p.material_code)));
  const datedOrders = (allOrders || []).filter(o => {
    const code = String(o.material_code_fg || o.material_code || '');
    const av = String(o.avail_date || o.target_avail_date || '').toLowerCase().trim();
    return code && !n10dCodes.has(code) && av && av !== 'prio replenish' && av !== 'prio_replenish' && av !== 'safety stocks' && /\d/.test(av);
  });

  if (datedOrders.length > 0) {
    const sysB = `You are a production planning advisor for a feed manufacturing plant. Generate a helpful 3-5 sentence production insight for each Make-to-Order (MTO) order with a specific deadline.

RULES:
- Focus on whether the order is on track to meet its deadline.
- Calculate backward from deadline: when must production START.
- Mention days remaining until the deadline.
- Recommend specific actions if the deadline is at risk.
- Use full month names. Be direct and practical.
- Do NOT include the deadline header line — only write advisory sentences.
- Output each insight on a SINGLE LINE — no line breaks within an insight.

TONE:
< 2 days: Urgent. State production must start immediately. Warn about consequences.
2-5 days: Firm. Schedule production soon. Confirm estimated completion vs deadline. Recommend reserving a slot.
> 5 days: Reassuring. On track. Suggest optimal start date. Note can be sequenced after more urgent orders.

OUTPUT FORMAT: Return ONLY a valid JSON object — no markdown, no explanation — like this:
{"material_code_1": "advisory text", "material_code_2": "advisory text"}`;

    const chunksB = _chunkArray(datedOrders, 8);
    for (const chunk of chunksB) {
      const orderLines = chunk.map(o => {
        const code = o.material_code_fg || o.material_code;
        const av = o.avail_date || o.target_avail_date || '';
        const deadline = av ? new Date(av) : null;
        const daysLeft = deadline && !isNaN(deadline) ? Math.ceil((deadline - _today) / 86400000) : null;
        const completionD = deadline && !isNaN(deadline) ? _fmtFull(new Date(deadline.getTime() - 86400000)) : null;
        return (
          `material_code: ${code}\n` +
          `description: ${o.item_description || ''}\n` +
          `Volume: ${o.volume_override || o.total_volume_mt || 0} MT | Line: ${o.feedmill_line || 'unassigned'}\n` +
          `Deadline (Avail Date): ${av ? _fmtFull(av) : 'N/A'} | Expected Completion: ${completionD || 'N/A'}\n` +
          `Production Time: ${o.production_hours || 'N/A'} hrs | Changeover: ${o.changeover_time || 'N/A'} hrs\n` +
          `Days remaining: ${daysLeft !== null ? daysLeft : 'Unknown'} | Status: ${o.status || 'N/A'}`
        );
      }).join('\n---\n');
      const usrB = `Generate advisory insights for these MTO orders. Return ONLY a JSON object where each key is the exact material_code and each value is a 3-5 sentence advisory.\n\n${orderLines}`;
      const { content: contentB } = await postAI('recommendations', { systemPrompt: sysB, userPrompt: usrB, maxTokens: 2000 });
      _parseAI(contentB, aiMap);
    }
  }

  return aiMap;
}
