/*
 * plantCombinePlace.js — shared factory for the plant-wide pre-AI
 * combine + line-balance step.
 *
 * The implementation is the verbatim `plantLevelCombineAndPlace` that used to
 * live inside Dashboard.jsx. It is wrapped in a factory so the exact same logic
 * can be driven from two places without duplication:
 *   1. Dashboard.jsx — builds `deps` from its component scope (unchanged behavior).
 *   2. The instrumented, read-only auto-sequence trace endpoint in server.js —
 *      builds equivalent `deps` server-side so Stage 2 of the trace reflects the
 *      REAL pre-AI step, not an approximation.
 *
 * All external symbols the function closes over are injected via `deps` so the
 * function body itself is untouched.
 */
import { getDiameterKey } from "../utils/changeoverCalc";

export function makePlantLevelCombineAndPlace(deps) {
  const {
    PLANT_ALL_LINES,
    PLANT_RUN_RATE_COL,
    PLANT_LINE_TO_FM_LABEL,
    PLANT_MAX_COMBINE_MT,
    getLineRunRate,
    normalizeLine,
    isLineShutdown,
    getShutdownReason,
    inferredTargetMap,
    getOrderVolumeMT,
    calculateEffectiveLineTotalMT,
    calculateLineHoursBreakdown,
    calculateQueueTimeHours,
    getCombinationBasisVolume,
    adjustVolumeToBatchCeiling,
    calcProductionHours,
    applyPreviewChangeovers,
    pmxSplitRules,
  } = deps;

  const plantLevelCombineAndPlace = (activeOrders, kbList, coRules) => {
    // ─── helpers ───────────────────────────────────────────────────────────────
    const EXCLUDED_STATUSES = new Set([
      "Done", "Cancel PO", "In Production", "On-going",
      "completed", "cancel_po",
      "in_production", "ongoing_batching", "ongoing_pelleting", "ongoing_bagging",
    ]);

    // ─── shutdown exclusion ────────────────────────────────────────────────────
    // Shutdown lines (line-level OR parent feedmill) are excluded from:
    //   - serving as a destination for moves or combined orders
    //   - serving as a source line for the cross-line combine scan
    //   - rebalancing onto them
    // Orders whose CURRENT line is shutdown are left untouched (they were
    // either diverted away manually or are awaiting diversion). The preview
    // still shows them under their original line with a shutdown banner.
    const SHUTDOWN_LINES = new Set(PLANT_ALL_LINES.filter(l => isLineShutdown(l)));
    const ACTIVE_PLANT_LINES = PLANT_ALL_LINES.filter(l => !SHUTDOWN_LINES.has(l));
    console.debug('[Auto-Sequence Shutdown Exclusion]', {
      allLines: PLANT_ALL_LINES,
      shutdownLines: [...SHUTDOWN_LINES],
      activeLines: ACTIVE_PLANT_LINES,
      shutdownReasonByLine: [...SHUTDOWN_LINES].reduce((acc, l) => {
        acc[l] = getShutdownReason(l) || 'shutdown';
        return acc;
      }, {}),
      excludedAsDestination: [...SHUTDOWN_LINES],
      allowedAsSource: [...SHUTDOWN_LINES],
    });

    const canProduceOnLine = (order, line) => {
      const isGen = order.is_powermix_generated === true || order.is_powermix_generated === 'true';
      if (isGen) {
        const normalizedLine = normalizeLine(line);
        const rrKey = PLANT_RUN_RATE_COL[normalizedLine];
        // order.sfg is the SFG planned-order number, not the material code — use kb_sfg_material_code.
        const sfgCode = String(order.kb_sfg_material_code || '').trim();
        const entry = sfgCode ? kbList.find(r => String(r.fg_material_code || '').trim() === sfgCode) : null;
        const runRate = entry && rrKey ? parseFloat(entry[rrKey] || 0) : 0;
        console.debug('[Generated Order Run-Rate Lookup]', {
          orderId: order.id,
          isGeneratedOrder: true,
          orderSfgMaterialCode: sfgCode,
          masterDataMatchField: 'fg_material_code',
          matchedMasterDataRecord: entry ? { fg_material_code: entry.fg_material_code, [rrKey]: entry[rrKey] } : null,
          candidateLine: normalizedLine,
          candidateLineRunRate: runRate,
          eligibleForCrossLineMove: runRate > 0,
        });
        return runRate > 0;
      }
      const normalizedLine = normalizeLine(line);
      const rrKey = PLANT_RUN_RATE_COL[normalizedLine];
      const fgCode = String(order.material_code_fg || order.material_code || '').trim();
      const entry = fgCode ? kbList.find(r => String(r.fg_material_code || '').trim() === fgCode) : null;
      const runRate = entry && rrKey ? parseFloat(entry[rrKey] || 0) : 0;
      console.debug('[Normal Order Run-Rate Lookup]', {
        orderId: order.id,
        isGeneratedOrder: false,
        orderFgMaterialCode: fgCode,
        masterDataMatchField: 'fg_material_code',
        matchedMasterDataRecord: entry ? { fg_material_code: entry.fg_material_code, [rrKey]: entry[rrKey] } : null,
        candidateLine: normalizedLine,
        candidateLineRunRate: runRate,
        eligibleForCrossLineMove: runRate > 0,
      });
      return runRate > 0;
    };

    const getProductRunRateOnLine = (order, line) => {
      const materialCode = String(order.material_code_fg || order.material_code || "").trim();
      const rrKey = PLANT_RUN_RATE_COL[line];
      if (!rrKey || !materialCode) return 0;
      const entry = kbList.find(r => String(r.fg_material_code || "").trim() === materialCode);
      return parseFloat(entry?.[rrKey] || 0) || 0;
    };

    // ─── sort result within each line — reuse the same preSortOrders from azureAI ──
    // This gives us identical N10D categorization + Critical-first logic as per-line
    // auto-sequence, and enriches each order with _effectiveDate / _n10dStatus metadata.

    // ─── build eligible + originalByLine snapshot ──────────────────────────────
    const eligible = activeOrders
      .filter(o => !EXCLUDED_STATUSES.has(o.status) && o.feedmill_line)
      .map(o => ({ ...o, feedmill_line: normalizeLine(o.feedmill_line) }));

    const originalByLine = {};
    PLANT_ALL_LINES.forEach(line => {
      originalByLine[line] = eligible
        .filter(o => o.feedmill_line === line)
        .filter(o => !o.parent_id) // top-level only: leads + standalones (same scope as After table)
        .sort((a, b) => (a.priority_seq || 9999) - (b.priority_seq || 9999));
    });

    // ─── working state ─────────────────────────────────────────────────────────
    const lineOrdersMap = {};
    PLANT_ALL_LINES.forEach(line => {
      lineOrdersMap[line] = eligible
        .filter(o => o.feedmill_line === line)
        .sort((a, b) => (a.priority_seq || 9999) - (b.priority_seq || 9999))
        .map(o => ({
          ...o,
          _originalLine: o.feedmill_line,
          _isPlanned: o.status === "Planned" || o.status === "planned",
          _processed: false,
        }));
    });

    const lineTotalMT = {};
    PLANT_ALL_LINES.forEach(line => {
      lineTotalMT[line] = calculateEffectiveLineTotalMT(lineOrdersMap[line]);
    });

    // Tracks MT the algorithm has *committed* on each line so far (starts at 0).
    // Used as the queue-context for _wouldCombineMissDeadline so that orders
    // processed early (tightest deadline, minimal real queue ahead of them) get
    // an accurate near-zero wait estimate rather than the full pre-existing line
    // load held in lineTotalMT (which is used only for load-aware scoring).
    const linePlacedMT = {};
    PLANT_ALL_LINES.forEach(line => { linePlacedMT[line] = 0; });

    console.log("=== PLANT AUTO-SEQUENCE (ORDER-BY-ORDER) ===");
    PLANT_ALL_LINES.forEach(line => {
      const rr = getLineRunRate(line);
      console.log(`  ${line}: ${lineTotalMT[line].toFixed(1)} MT ÷ ${rr} MT/hr = ${rr > 0 ? (lineTotalMT[line] / rr).toFixed(2) : "∞"} hrs`);
    });

    const placementLog = [];
    const processedIds = new Set();
    const baseChangeover = 0.17;

    // ── Hard deadline guard ───────────────────────────────────────────────────
    // Returns true if combining the given group of orders would cause any
    // hard-deadline sub-order to miss its deadline.
    // "Hard deadline" = a stored ISO target_avail_date that is NOT auto_sequence-
    // or n10d-sourced (i.e. a real planner-entered or MTO date).
    //
    // IMPORTANT — same-deadline combines are always allowed. This engine only ever
    // combines same-material + same-formula orders. When every member of the group
    // shares the *same* hard deadline (and no deadline-less / less-urgent member is
    // adding extra volume), merging them can never make that shared deadline any
    // harder to meet than producing the same orders separately would — it only
    // removes a changeover. The guard therefore only blocks the genuinely risky
    // case: pulling less-urgent volume (a later or no deadline) into an order that
    // has an earlier hard deadline, which could push the urgent order past its date.
    //
    // lineQueueHours — the queue already on the relevant line in hours (caller
    //   supplies the context-appropriate value: Line 5 queue for the L5 pre-pass,
    //   the base order's current line queue for the Phase 2 loop).
    const _wouldCombineMissDeadline = (groupOrders, lineQueueHours) => {
      const now = Date.now();
      let earliestDeadlineMs = null;
      const deadlineMsList = [];       // every hard deadline found in the group
      let hasNonDeadlineMember = false; // a member with no hard deadline (adds volume, no urgency)

      // Check a single order record's hard deadline and update earliestDeadlineMs.
      const _checkOrderDeadline = (o) => {
        const v = o.target_avail_date;
        const isISO = !!v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) && !isNaN(Date.parse(v));
        const isN10DSourced = o.avail_date_source === 'auto_sequence' || o.date_source === 'n10d';
        if (isISO && !isN10DSourced) {
          // End-of-day in PHT (UTC+8) = UTC 15:59:59 on the same calendar date
          const dlMs = new Date(`${String(v).substring(0, 10)}T15:59:59.999Z`).getTime();
          deadlineMsList.push(dlMs);
          if (earliestDeadlineMs === null || dlMs < earliestDeadlineMs) earliestDeadlineMs = dlMs;
        } else {
          hasNonDeadlineMember = true;
        }
      };

      for (const o of groupOrders) {
        // Represent each member by its REAL leaf orders. An existing combined
        // lead's own shell target_avail_date may be a non-ISO/derived value that
        // does not reflect its children — checking the shell would wrongly set
        // hasNonDeadlineMember and suppress the same-deadline allowance below.
        // So when a member expands, check ONLY its leaves; otherwise check itself.
        const isExistingLead = Array.isArray(o.original_order_ids) && o.original_order_ids.length > 0;
        const children = isExistingLead
          ? eligible.filter(c => String(c.parent_id) === String(o.id))
          : [];
        // Line 5 pre-pass combined leads carry their original sub-orders in _combinedFrom.
        const subs = Array.isArray(o._combinedFrom) ? o._combinedFrom : [];
        if (children.length > 0) {
          for (const child of children) _checkOrderDeadline(child);
        } else if (subs.length > 0) {
          for (const sub of subs) _checkOrderDeadline(sub);
        } else {
          _checkOrderDeadline(o);
        }
      }

      if (earliestDeadlineMs === null) return false; // no hard deadline — allow combine

      // Same-deadline safety: every member carries the identical hard deadline and
      // none is deadline-less, so combining cannot worsen that shared deadline.
      const allShareSameDeadline =
        !hasNonDeadlineMember && deadlineMsList.every(ms => ms === earliestDeadlineMs);
      if (allShareSameDeadline) return false;

      const hoursUntilDeadline = (earliestDeadlineMs - now) / 3600000;
      if (hoursUntilDeadline <= 0) return true; // deadline already passed — don't combine
      const combinedProdHours = groupOrders.reduce((s, o) => s + (parseFloat(o.production_hours) || 0), 0);
      const queueHours = isFinite(lineQueueHours) && lineQueueHours >= 0 ? lineQueueHours : 0;
      const estimatedFinishHours = queueHours + combinedProdHours;
      return estimatedFinishHours > hoursUntilDeadline;
    };

    // ── Composite line-score for destination selection ────────────────────────
    // Lower score = better destination. Three additive components:
    //
    //   score = queueHrs + dieChangePenalty − clusterBonus
    //
    // queueHrs        — primary capacity-balance signal (evenly distributes load)
    // dieChangePenalty — if a majority of existing orders on this line have a
    //                    different diameter, placing this order there would likely
    //                    create a die change. We look up the actual cost from
    //                    coRules (diameter_change rule per FM), fall back to 1.0 h.
    //                    Implements the spec directive: "avoid creating the die
    //                    change in the first place by intelligently grouping
    //                    compatible orders or assigning them to another eligible
    //                    feedmill line."
    // clusterBonus    — reward lines whose existing orders mostly share the same
    //                    color + category (compatible material cluster → cheaper
    //                    changeovers when this order is inserted later).
    // Weight (W) applied to the order's own-production-hours term in line
    // scoring. W = 1 makes scoring a balanced Shortest-Completion-Time rule:
    // each order prefers the line that finishes it soonest. Raise above 1 to
    // bias harder toward faster lines (more hours saved, small congestion risk).
    const RUN_RATE_WEIGHT = 1;

    const _scoreLineForOrder = (line, ord, placementVolume = 0) => {
      const curMT  = lineTotalMT[line] || 0;
      const rr     = getLineRunRate(line);
      const queueHrs = rr > 0 ? curMT / rr : Infinity;

      // Own-production-hours term: how many production hours THIS order will
      // burn if placed on this line. Uses the per-product run rate from Master
      // Data (getProductRunRateOnLine), falling back to the line default rate
      // when the KB has no entry. Including this makes the score completion-time
      // aware so an idle slow line no longer beats a faster line purely on queue
      // time — directly reducing run-rate-disadvantageous cross-line diversion.
      const vol = parseFloat(placementVolume) || 0;
      const prodRr = getProductRunRateOnLine(ord, line) || rr;
      const ownProdHrs = (vol > 0 && prodRr > 0) ? vol / prodRr : 0;

      const existingOrders = lineOrdersMap[line] || [];
      const orderDiam  = parseFloat(ord.diameter) || 0;
      const orderColor = (ord.color    || '').toLowerCase().trim();
      const orderCat   = (ord.category || '').toLowerCase().trim();

      // Die change penalty: majority of orders on this line have a different
      // diameter → placing the order here is very likely to produce a die change.
      let dieChangePenalty = 0;
      if (orderDiam > 0 && existingOrders.length > 0) {
        const diffCount = existingOrders.filter(o => {
          const d = parseFloat(o.diameter) || 0;
          return d > 0 && d !== orderDiam;
        }).length;
        if (diffCount > existingOrders.length / 2) {
          const fm    = PLANT_LINE_TO_FM_LABEL[line] || '';
          const fmKey = fm === 'FM1' ? 'fm1' : fm === 'FM2' ? 'fm2' : fm === 'FM3' ? 'fm3' : null;
          const dieRule = fmKey && coRules
            ? coRules.find(r => r.type === 'diameter_change' || r.id === 'diameter_change')
            : null;
          dieChangePenalty = (dieRule && fmKey)
            ? (parseFloat(dieRule.values?.[fmKey]) || 1.0)
            : 1.0;
        }
      }

      // Cluster continuity bonus: majority of existing orders on this line share
      // the same color + category as the incoming order → compatible cluster,
      // fewer/cheaper changeovers when the order is inserted.
      let clusterBonus = 0;
      if (existingOrders.length > 0 && orderColor && orderCat) {
        const compatCount = existingOrders.filter(o =>
          (o.color    || '').toLowerCase().trim() === orderColor &&
          (o.category || '').toLowerCase().trim() === orderCat
        ).length;
        if (compatCount > existingOrders.length / 2) {
          clusterBonus = baseChangeover; // saves ≈1 base changeover (0.17 h)
        }
      }

      return queueHrs + (RUN_RATE_WEIGHT * ownProdHrs) + dieChangePenalty - clusterBonus;
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // PRE-PASS: Line 5 (Powermix) same-line source-order combine
    // ─────────────────────────────────────────────────────────────────────────
    // Line 5 source orders are line-locked (they never participate in cross-line
    // movement). However, they CAN combine with other compatible Line 5 source
    // orders to reduce changeovers on Line 5 itself. This pass runs BEFORE the
    // main loop so the combined leads are already in lineOrdersMap["Line 5"]
    // when the main loop processes them (and immediately marks them as processed
    // because _isPowermixSourceOrder is true — keeping them fixed to Line 5).
    // ─────────────────────────────────────────────────────────────────────────
    {
      const EXCLUDED_LINE5 = new Set(["completed", "cancel_po", "in_production", "ongoing_batching", "ongoing_pelleting", "ongoing_bagging"]);
      const _isGenOrder = (o) => o.is_powermix_generated === true || o.is_powermix_generated === 'true';
      const line5Orders = (lineOrdersMap["Line 5"] || []).filter(o =>
        !EXCLUDED_LINE5.has(o.status) &&
        !o.parent_id &&
        !_isGenOrder(o)
      );

      // Group by material_code + formula_version (same groupKey as combineOnLine)
      const groups5 = {};
      for (const o of line5Orders) {
        const k = `${String(o.material_code || "").trim()}__${String(o.formula_version || "").trim()}`;
        if (!groups5[k]) groups5[k] = [];
        groups5[k].push(o);
      }

      const line5Combined = [];
      const line5ProcessedIds = new Set();

      for (const grp of Object.values(groups5)) {
        if (grp.length < 2) continue;

        // Classify each order: all should be source (non-generated), but guard anyway
        const genSubGrp = grp.filter(_isGenOrder);
        const srcSubGrp = grp.filter(o => !_isGenOrder(o));

        // Log guardrail check for every generated+source pair found (should be empty
        // in this pre-pass since we only enter with source orders, but guard defensively)
        for (const gen of genSubGrp) {
          for (const src of srcSubGrp) {
            console.debug('[Line 5 Generated/Source Guardrail]', {
              line: 5,
              orderAId: gen.id,
              orderBId: src.id,
              orderAType: 'generated',
              orderBType: 'source',
              blockedReason: 'generated_and_source_orders_cannot_combine',
            });
          }
        }

        // If the group mixes generated and source, only combine within same class.
        // For Line 5 source-only combine, we operate solely on srcSubGrp.
        const combineGroup = srcSubGrp.length >= 2 ? srcSubGrp : null;
        if (!combineGroup) continue;

        // Log eligibility for each pair in the group
        for (let ai = 0; ai < combineGroup.length; ai++) {
          for (let bi = ai + 1; bi < combineGroup.length; bi++) {
            const orderA = combineGroup[ai];
            const orderB = combineGroup[bi];
            const eligible5 = !_isGenOrder(orderA) && !_isGenOrder(orderB);
            console.debug('[Line 5 Source Combine Check]', {
              line: 5,
              orderAId: orderA.id,
              orderBId: orderB.id,
              orderAType: 'source',
              orderBType: 'source',
              sameLine: true,
              eligibleForLine5SourceCombine: eligible5,
            });
          }
        }

        const totalMT = combineGroup.reduce((s, o) => s + (parseFloat(o.total_volume_mt) || 0), 0);
        const withinCap = totalMT <= PLANT_MAX_COMBINE_MT;

        if (!withinCap) {
          console.debug('[Line 5 Source Combine Cap Exceeded]', {
            line: 5,
            totalMT,
            capMT: PLANT_MAX_COMBINE_MT,
            combined: false,
          });
          continue;
        }

        // Deadline guard: skip combine if any sub-order has a hard avail date
        // that would be missed by the combined group's estimated completion time.
        // Use Line 5's own queue time — these orders are line-locked here.
        const _l5Rr = getLineRunRate("Line 5");
        const _l5QueueHours = _l5Rr > 0 ? (linePlacedMT["Line 5"] || 0) / _l5Rr : 0;
        if (_wouldCombineMissDeadline(combineGroup, _l5QueueHours)) {
          console.debug('[Line 5 Source Combine Deadline Block]', {
            line: 5,
            orderIds: combineGroup.map(o => o.id),
            totalMT,
            line5QueueHours: _l5QueueHours,
            reason: 'hard_deadline_would_be_missed_by_combined_schedule',
            combined: false,
          });
          continue;
        }

        const sorted5 = [...combineGroup].sort((a, b) => (parseFloat(b.total_volume_mt) || 0) - (parseFloat(a.total_volume_mt) || 0));
        const lead5 = { ...sorted5[0] };
        lead5.total_volume_mt = totalMT.toFixed(1);
        lead5.production_hours = (combineGroup.reduce((s, o) => s + (parseFloat(o.production_hours) || 0), 0)).toFixed(2);
        lead5._isCombined = true;
        lead5._combinedFrom = combineGroup.map(o => ({
          id: o.id, line: 'Line 5', fpr: o.fpr,
          volume: parseFloat(o.total_volume_mt) || 0, item_description: o.item_description,
          form: o.form, material_code_fg: o.material_code, material_code: o.material_code,
          fg: o.fg, sfg: o.sfg, batch_size: o.batch_size,
          production_time: o.production_hours, target_avail_date: o.target_avail_date, category: o.category,
        }));
        lead5._combinedFromLines = ['Line 5'];

        // Earliest-date override for Line 5 combined orders — same rule as the
        // main combine loop: combined order inherits the tightest hard deadline.
        {
          const _isHardL5 = (o) => {
            const v = o.target_avail_date;
            return !!v && /^\d{4}-\d{2}-\d{2}/.test(String(v)) && !isNaN(Date.parse(v))
              && o.avail_date_source !== 'auto_sequence' && o.date_source !== 'n10d';
          };
          const hardSubs5 = combineGroup.filter(_isHardL5).sort((a, b) =>
            String(a.target_avail_date).substring(0, 10) < String(b.target_avail_date).substring(0, 10) ? -1 : 1
          );
          const ctrl5 = hardSubs5[0];
          if (ctrl5) {
            const earliest5 = String(ctrl5.target_avail_date).substring(0, 10);
            lead5.target_avail_date = earliest5;
            lead5._combinedEarliestHardDate = earliest5;
            if (ctrl5.category === 'MTO') {
              lead5.category = 'MTO';
              if (lead5.avail_date_source === 'auto_sequence') lead5.avail_date_source = null;
            }
          }
        }

        const combinedOrderIds = combineGroup.map(o => o.id);
        console.debug('[Line 5 Source Combine Result]', {
          line: 5,
          combinedOrderIds,
          totalCombinedVolume: totalMT,
          withinCap,
          combined: true,
        });

        const changeoversSaved = combineGroup.length - 1;
        placementLog.push({
          type: 'combined', product: lead5.item_description,
          materialCode: lead5.material_code, ordersCount: combineGroup.length,
          totalVolume: totalMT, toLine: 'Line 5',
          fromLines: ['Line 5'],
          changeoversSaved, timeSaved: changeoversSaved * 0.17,
          individualVolumes: combineGroup.map(o => ({ fromLine: 'Line 5', volume: parseFloat(o.total_volume_mt) || 0 })),
          lineScores: [{ line: 'Line 5', runRate: 10, totalMTBefore: 0, queueTimeBefore: 0, totalMTAfter: totalMT, queueTimeAfter: 0 }],
          bestLineReason: { line: 'Line 5', queueTime: 0, totalMTBefore: 0, totalMTAfter: totalMT },
        });

        combineGroup.forEach(o => line5ProcessedIds.add(o.id));
        line5Combined.push(lead5);
        linePlacedMT["Line 5"] = (linePlacedMT["Line 5"] || 0) + totalMT;
      }

      // Rebuild lineOrdersMap["Line 5"]: replace combined source orders with their lead,
      // keeping all uncombined orders and non-source orders in original order.
      if (line5Combined.length > 0) {
        const combined5Ids = new Set(line5Combined.flatMap(lead => (lead._combinedFrom || []).map(c => c.id)));
        const remaining5 = (lineOrdersMap["Line 5"] || []).filter(o => !combined5Ids.has(o.id));
        lineOrdersMap["Line 5"] = [...line5Combined, ...remaining5].sort((a, b) =>
          (a.priority_seq || 9999) - (b.priority_seq || 9999)
        );
      }
    }
    // ─── End Line 5 source-order same-line combine pre-pass ──────────────────

    // ═══════════════════════════════════════════════════════════════════════════
    // MAIN LOOP — Line 1 Prio 1 → Line 7 last prio, order by order
    // ═══════════════════════════════════════════════════════════════════════════
    // Per-line role log: shutdown lines are NOT valid destinations, but their
    // eligible orders ARE allowed as source candidates that may be relocated
    // onto active lines by the normal cross-line movement / combine logic.
    PLANT_ALL_LINES.forEach((ln) => {
      const isSd = SHUTDOWN_LINES.has(ln);
      console.debug('[Auto-Sequence Shutdown Line Role]', {
        lineId: ln,
        lineName: ln,
        shutdownActive: isSd,
        allowedAsDestination: !isSd,
        allowedAsSource: true,
      });
    });

    for (const line of PLANT_ALL_LINES) {
      const lineOrders = [...(lineOrdersMap[line] || [])]; // snapshot before mutations

      for (const order of lineOrders) {
        if (order._processed || processedIds.has(order.id)) continue;
        if (order.parent_id) continue; // skip children of existing combined orders — handled via their lead

        // Detect if the base order is itself an existing combined lead
        const baseIsExistingLead = Array.isArray(order.original_order_ids) && order.original_order_ids.length > 0;
        const baseChildren = baseIsExistingLead
          ? eligible.filter(c => String(c.parent_id) === String(order.id))
          : [];
        const orderVolume = baseIsExistingLead && baseChildren.length > 0
          ? baseChildren.reduce((s, c) => s + getOrderVolumeMT(c), 0)
          : getOrderVolumeMT(order);
        const isGeneratedPmxOrder = order.is_powermix_generated === true || order.is_powermix_generated === 'true';
        // Generated orders match on SFG material code; normal orders match on FG material code.
        // Generated orders: use kb_sfg_material_code (resolved SFG material code, e.g. 3000000000248).
        // order.sfg is the SFG planned-order number — not a material code, do not use for matching.
        const orderMaterialCode = isGeneratedPmxOrder
          ? String(order.kb_sfg_material_code || order.material_code || "").trim()
          : String(order.material_code_fg || order.material_code || "").trim();
        const orderFormulaVersion = String(order.formula_version || "").trim();

        if (!orderMaterialCode) {
          order._processed = true;
          processedIds.add(order.id);
          continue;
        }
        // Generated orders now participate in cross-line auto-sequencing.
        // No early skip — run-rate eligibility and non-overlap checks are applied below.

        // Powermix source orders (Line 5 all, Line 7 with active rule) are line-locked.
        if (order._isPowermixSourceOrder) {
          const _srcAssignedLine = normalizeLine(order.feedmill_line || order._originalLine);
          console.debug('[AutoSequence Powermix Source Order Guard]', {
            orderId: order.id,
            isPowermixSourceOrder: true,
            assignedLine: _srcAssignedLine,
            includedInCrossLineMovePool: false,
            includedInCrossLineCombinePool: false,
            blockedBecauseLineLocked: true,
          });
          order._processed = true;
          processedIds.add(order.id);
          continue;
        }

        // ── PHASE 1: Find matchable orders across ALL lines ──────────────────
        // Shutdown lines may contribute SOURCE candidates (the order can be
        // combined onto an active destination). Destination selection still
        // excludes shutdown lines via ACTIVE_PLANT_LINES below.
        const matches = [];
        for (const scanLine of PLANT_ALL_LINES) {
          for (const candidate of (lineOrdersMap[scanLine] || [])) {
            if (candidate.id === order.id) continue;
            if (candidate._processed || processedIds.has(candidate.id)) continue;
            if (EXCLUDED_STATUSES.has(candidate.status)) continue;
            if (candidate.parent_id) continue; // skip children — only match leads or single orders
            if (candidate._isPowermixSourceOrder) continue; // powermix source orders are line-locked
            const cIsGeneratedPmx = candidate.is_powermix_generated === true || candidate.is_powermix_generated === 'true';
            // ── Hard guardrail: generated orders and source orders are different
            // order classes and must NEVER be combined regardless of line, material
            // code, or any other matching criteria.
            if (cIsGeneratedPmx !== isGeneratedPmxOrder) {
              const orderAType = isGeneratedPmxOrder ? 'generated' : 'source';
              const orderBType = cIsGeneratedPmx ? 'generated' : 'source';
              console.debug('[Combine Guardrail - Generated vs Source]', {
                orderAId: order.id,
                orderBId: candidate.id,
                orderAType,
                orderBType,
                isGeneratedSourceMix: true,
                canCombine: false,
                blockedReason: 'generated_and_source_orders_cannot_combine',
              });
              console.debug('[Powermix Generated/Source Guardrail]', {
                orderAType,
                orderBType,
                directMixedCombineBlocked:
                  (orderAType === 'generated' && orderBType === 'source') ||
                  (orderAType === 'source' && orderBType === 'generated'),
              });
              console.debug('[Combine Eligibility Scan]', {
                orderAId: order.id,
                orderBId: candidate.id,
                sameLine: normalizeLine(order.feedmill_line || order._originalLine) === normalizeLine(candidate.feedmill_line || candidate._originalLine),
                sameSequenceArea: false,
                generatedSourceRelationshipDetected: true,
                blockedByGeneratedSourceGuardrail: true,
              });
              continue;
            }
            // Generated orders use SFG material code for combination matching; normal orders use FG
            const cMat = cIsGeneratedPmx
              ? String(candidate.kb_sfg_material_code || candidate.material_code || "").trim()
              : String(candidate.material_code_fg || candidate.material_code || "").trim();
            const cFv = String(candidate.formula_version || "").trim();
            if (isGeneratedPmxOrder) {
              console.debug('[Generated Order Combination Check]', {
                orderAId: order.id,
                orderBId: candidate.id,
                sfgMaterialCodeA: orderMaterialCode,
                sfgMaterialCodeB: cMat,
                fgMaterialCodeA: order.material_code_fg || order.material_code,
                fgMaterialCodeB: candidate.material_code_fg || candidate.material_code,
                canCombine: cMat === orderMaterialCode,
                combinationBasis: 'SFG material code',
              });
            }
            if (cMat !== orderMaterialCode) continue;
            if (cFv !== orderFormulaVersion) continue;
            const cLine = normalizeLine(candidate.feedmill_line || candidate._originalLine);
            // Detect existing combined lead — use real children's volume sum
            const cIsExistingLead = Array.isArray(candidate.original_order_ids) && candidate.original_order_ids.length > 0;
            let cVol;
            if (cIsExistingLead) {
              const cChildren = eligible.filter(c => String(c.parent_id) === String(candidate.id));
              cVol = cChildren.length > 0
                ? cChildren.reduce((s, c) => s + getOrderVolumeMT(c), 0)
                : getOrderVolumeMT(candidate);
            } else {
              cVol = getOrderVolumeMT(candidate);
            }
            matches.push({
              order: candidate,
              volume: cVol,
              line: cLine,
              isPlanned: candidate._isPlanned,
              runRate: getProductRunRateOnLine(candidate, cLine),
              isExistingLead: cIsExistingLead,
            });
          }
        }
        // Sort: lower MT first; same MT → higher run rate wins
        matches.sort((a, b) => {
          const vd = a.volume - b.volume;
          if (Math.abs(vd) > 0.01) return vd;
          return (b.runRate || 0) - (a.runRate || 0);
        });

        // ── PHASE 2: Greedy combine up to 200 MT cap ────────────────────────
        // Compute the base order's current line queue hours once for the guard.
        // Using the base line is the correct conservative context: we don't yet
        // know the destination line, but the combined order will land somewhere
        // at least as loaded as the base order's current line (destination
        // scoring picks the least-loaded line, which could be better, but the
        // base line gives a realistic lower-bound on how much queue is waiting).
        const _baseOrderLine = normalizeLine(order.feedmill_line || order._originalLine);
        const _baseLineRr = getLineRunRate(_baseOrderLine);
        const _baseLineQueueHours = _baseLineRr > 0 ? (linePlacedMT[_baseOrderLine] || 0) / _baseLineRr : 0;

        const combinedMatches = [];
        let totalVolume = orderVolume;
        for (const m of matches) {
          const candidateCombinedVolumeMT = totalVolume + m.volume;
          const combinationAllowed = candidateCombinedVolumeMT <= PLANT_MAX_COMBINE_MT;
          console.debug('[Order Combine Cap Check]', { combineCapMT: PLANT_MAX_COMBINE_MT, candidateCombinedVolumeMT, withinCap: combinationAllowed });
          console.debug('[Order Combine Cap Validation]', { previousCapMT: 180, newCapMT: PLANT_MAX_COMBINE_MT, combinationAllowed });
          if (!combinationAllowed) continue;
          // Deadline guard: block combine if any hard-deadline order in the
          // proposed group (base + accumulated so far + this candidate) would
          // miss its deadline given the base order's current line queue context.
          const proposedGroup = [order, ...combinedMatches.map(cm => cm.order), m.order];
          if (_wouldCombineMissDeadline(proposedGroup, _baseLineQueueHours)) {
            console.debug('[Order Combine Deadline Block]', {
              baseOrderId: order.id,
              candidateOrderId: m.order.id,
              candidateCombinedVolumeMT,
              baseOrderLine: _baseOrderLine,
              baseLineQueueHours: _baseLineQueueHours,
              reason: 'hard_deadline_would_be_missed_by_combined_schedule',
              combined: false,
            });
            continue;
          }
          combinedMatches.push(m);
          totalVolume += m.volume;
        }

        if (combinedMatches.length > 0) {
          // ── PHASE 3: Place combined order ──────────────────────────────────
          // Expand any existing combined leads (base or matched) to their real children
          const oldLeadIdsToDelete = [];

          const _expandToRealSubs = (matchEntry, isBase) => {
            const src = isBase ? order : matchEntry.order;
            const srcVol = isBase ? orderVolume : matchEntry.volume;
            const srcLine = isBase
              ? normalizeLine(order.feedmill_line || order._originalLine)
              : matchEntry.line;
            const isLead = isBase ? baseIsExistingLead : matchEntry.isExistingLead;
            if (isLead) {
              oldLeadIdsToDelete.push(src.id);
              const kids = eligible.filter(c => String(c.parent_id) === String(src.id));
              if (kids.length > 0) {
                return kids.map(k => ({
                  order: k,
                  volume: getOrderVolumeMT(k), // consistent with lineTotalMT init
                  line: normalizeLine(k.feedmill_line || k._originalLine || srcLine),
                }));
              }
              // No children found — fall back to treating the lead as a single order
              return [{ order: src, volume: srcVol, line: srcLine }];
            }
            return [{ order: src, volume: srcVol, line: srcLine }];
          };

          const allSubOrders = [
            ..._expandToRealSubs(null, true),
            ...combinedMatches.flatMap(m => _expandToRealSubs(m, false)),
          ];

          // ── Select canonical lead order ────────────────────────────────────
          // The lead order is the single canonical reference for the combined
          // entity's avail date, urgency status, and sequencing rank context.
          // Priority tier: Critical(0) → Urgent(1) → Monitor(2) → Flexible(3).
          // Tie-break within tier: earliest target_avail_date → largest volume.
          // This prevents sub-order date leakage where an arbitrary first-visited
          // order with an early date pulls the combined entity forward incorrectly.
          const _LEAD_STATUS_TIER = { Critical: 0, Urgent: 1, Monitor: 2 };
          const leadSub = allSubOrders.reduce((best, sub) => {
            const oTier = _LEAD_STATUS_TIER[sub.order._n10dStatus] ?? 3;
            const bTier = _LEAD_STATUS_TIER[best.order._n10dStatus] ?? 3;
            if (oTier !== bTier) return oTier < bTier ? sub : best;
            const oDate = String(sub.order.target_avail_date || '9999-99-99').substring(0, 10);
            const bDate = String(best.order.target_avail_date || '9999-99-99').substring(0, 10);
            if (oDate !== bDate) return oDate < bDate ? sub : best;
            return sub.volume >= best.volume ? sub : best;
          }, allSubOrders[0]);

          // Compute combination basis: override for user-adjusted, raw for all others.
          // Batch ceiling is applied only ONCE to the final combined sum.
          const batchSzCombine = parseFloat(leadSub.order.batch_size) || 1;
          const combinedBasisVolume = Number(
            allSubOrders.reduce((sum, sub) => {
              const { basisVolume } = getCombinationBasisVolume(sub.order);
              return sum + basisVolume;
            }, 0).toFixed(2)
          );
          const finalCombinedVolume = adjustVolumeToBatchCeiling(combinedBasisVolume, batchSzCombine);

          // Remove old leads from lineOrdersMap so they don't get processed as regular orders
          for (const oldLeadId of oldLeadIdsToDelete) {
            for (const sl of PLANT_ALL_LINES) {
              lineOrdersMap[sl] = (lineOrdersMap[sl] || []).filter(o => o.id !== oldLeadId);
            }
            processedIds.add(oldLeadId);
          }

          // Lock to Planned order's line if any sub-order is Planned.
          // EXCEPTION: if the planned sub-order's line is shutdown, do not
          // honor the lock — shutdown lines must never be a destination. Fall
          // back to normal active-line destination scoring below.
          const plannedSub = allSubOrders.find(s => s.order._isPlanned);
          const plannedLockBlockedByShutdown = !!plannedSub && SHUTDOWN_LINES.has(plannedSub.line);
          if (plannedLockBlockedByShutdown) {
            console.debug('[Auto-Sequence Shutdown Line Block]', {
              line: plannedSub.line,
              phase: 'planned_lock_override',
              action: 'reject_shutdown_destination_lock',
              orderId: order.id,
              plannedSubOrderId: plannedSub.order.id,
              reason: getShutdownReason(plannedSub.line) || 'shutdown',
            });
          }
          let destinationLine = (plannedSub && !plannedLockBlockedByShutdown) ? plannedSub.line : null;
          const wasLockedByPlanned = !!plannedSub && !plannedLockBlockedByShutdown;

          // Snapshot the true pre-combine MT for all lines BEFORE removing sub-orders.
          // lineScores (used for destination selection) will be computed from the
          // post-removal state, which is correct for choosing the best destination.
          // But the AI prompt needs the pre-removal state to accurately describe
          // what was on each line before the combination happened.
          const preCombineMTSnapshot = {};
          for (const sl of PLANT_ALL_LINES) {
            preCombineMTSnapshot[sl] = lineTotalMT[sl] || 0;
          }

          // Remove ALL sub-orders from their lines
          allSubOrders.forEach(sub => {
            lineTotalMT[sub.line] = (lineTotalMT[sub.line] || 0) - sub.volume;
            lineOrdersMap[sub.line] = (lineOrdersMap[sub.line] || []).filter(o => o.id !== sub.order.id);
            sub.order._processed = true;
            processedIds.add(sub.order.id);
          });

          // Queue-time placement if not locked
          let lineScores = [];
          if (!wasLockedByPlanned) {
            const eligibleLines = ACTIVE_PLANT_LINES.filter(l => canProduceOnLine(order, l));
            if (eligibleLines.length === 0) {
              // No active eligible destination — fall back to original line ONLY if it's active.
              const origLine = normalizeLine(order.feedmill_line || order._originalLine);
              if (SHUTDOWN_LINES.has(origLine)) {
                // Hard guard: never assign a shutdown line as a destination, even as a fallback.
                // Pick any active plant line as last resort; if none exist, skip placement entirely.
                const lastResort = ACTIVE_PLANT_LINES[0] || null;
                console.debug('[Auto-Sequence Shutdown Line Block]', {
                  line: origLine,
                  phase: 'combine_destination_fallback',
                  action: lastResort ? 'reroute_off_shutdown' : 'skip_no_active_line',
                  orderId: order.id,
                  reason: getShutdownReason(origLine) || 'shutdown',
                  rerouteTo: lastResort,
                });
                if (!lastResort) {
                  // No active line anywhere in the plant — mark processed and skip this combine.
                  allSubOrders.forEach(sub => {
                    sub.order._processed = true;
                    processedIds.add(sub.order.id);
                  });
                  continue;
                }
                destinationLine = lastResort;
              } else {
                destinationLine = origLine;
              }
            } else {
              lineScores = eligibleLines.map(l => {
                const curMT = lineTotalMT[l] || 0;
                const rr = getLineRunRate(l);
                const ln = parseInt(l.match(/\d+/)?.[0] || "99");
                return {
                  line: l,
                  feedmill: PLANT_LINE_TO_FM_LABEL[l] || l,
                  runRate: rr,
                  totalMTBefore: parseFloat(curMT.toFixed(1)),
                  queueTimeBefore: rr > 0 ? curMT / rr : Infinity,
                  lineNumber: ln,
                  _compositeScore: _scoreLineForOrder(l, order, finalCombinedVolume),
                };
              });
              lineScores.sort((a, b) => {
                const d = a._compositeScore - b._compositeScore;
                if (Math.abs(d) > 0.001) return d;
                return a.lineNumber - b.lineNumber;
              });
              destinationLine = lineScores[0].line;
            }
          }

          // Build combined order object — use the canonical lead order as the basis
          // so its avail date, _n10dStatus, and metadata drive sequencing rather
          // than whichever order the loop happened to visit first.
          const baseOrder = { ...JSON.parse(JSON.stringify(leadSub.order)) };
          baseOrder._combinedLeadOrderId = String(leadSub.order.id);
          const combinedRunRate = getLineRunRate(destinationLine);
          baseOrder.volume_override = null; // never inherit stale per-order override
          baseOrder.total_volume_mt = combinedBasisVolume.toFixed(1);
          baseOrder.volume = finalCombinedVolume;
          baseOrder.production_hours = combinedRunRate > 0
            ? (finalCombinedVolume / combinedRunRate).toFixed(2)
            : '0.00';
          baseOrder.feedmill_line = destinationLine;
          baseOrder.line = destinationLine;
          baseOrder._isCombined = true;
          baseOrder._oldLeadIdsToDelete = oldLeadIdsToDelete;
          baseOrder._combined_basis_volume = combinedBasisVolume;
          baseOrder._combined_effective_volume = finalCombinedVolume;
          baseOrder._combine_basis_breakdown = allSubOrders.map(sub => {
            const result = getCombinationBasisVolume(sub.order);
            return {
              order_id: sub.order.id,
              basisType: result.basisType,
              rawVolume: result.rawVolume,
              batchSize: result.batchSize,
              usedVolume: result.basisVolume,
            };
          });
          baseOrder._combinedFrom = allSubOrders.map(s => ({
            id: s.order.id,
            line: s.line,
            fpr: s.order.fpr,
            volume: s.volume,
            total_volume_mt: s.volume,
            volume_override: s.order.volume_override ?? null,
            item_description: s.order.item_description,
            form: s.order.form,
            material_code_fg: s.order.material_code_fg || s.order.material_code,
            material_code: s.order.material_code || s.order.material_code_fg,
            fg: s.order.fg,
            sfg: s.order.sfg,
            batch_size: s.order.batch_size,
            batches: s.order.batch_size && parseFloat(s.order.batch_size) > 0
              ? Math.ceil(s.volume / parseFloat(s.order.batch_size))
              : null,
            production_time: s.order.production_hours,
            target_avail_date: s.order.target_avail_date,
            category: s.order.category,
          }));
          baseOrder._combinedFromLines = [...new Set(allSubOrders.map(s => s.line))];
          baseOrder._originalLine = normalizeLine(order.feedmill_line || order._originalLine);
          baseOrder._plantMovement = baseOrder._originalLine === destinationLine ? "same" : "new_to_line";
          baseOrder._movedFromLine = baseOrder._originalLine !== destinationLine ? baseOrder._originalLine : null;
          baseOrder.batches = batchSzCombine > 0 ? Math.ceil(finalCombinedVolume / batchSzCombine) : 0;

          // ── Earliest controlling date for the combined order ─────────────────
          // Combined orders must use the earliest hard avail date among ALL sub-
          // orders, regardless of which sub-order was selected as canonical lead
          // (lead selection is driven by urgency tier, not exclusively by date).
          // A difference in avail dates must NOT block a combination — the merged
          // order simply commits to the tightest (earliest) deadline.
          const _isHardAvailDate = (o) => {
            const v = o.target_avail_date;
            return !!v
              && /^\d{4}-\d{2}-\d{2}/.test(String(v))
              && !isNaN(Date.parse(v))
              && o.avail_date_source !== 'auto_sequence'
              && o.date_source !== 'n10d';
          };
          const _allSubOrderObjs = allSubOrders.map(s => s.order);
          const _hardDateSubs = _allSubOrderObjs.filter(_isHardAvailDate).sort((a, b) =>
            String(a.target_avail_date).substring(0, 10) < String(b.target_avail_date).substring(0, 10) ? -1 : 1
          );
          const _controllingOrder   = _hardDateSubs[0] || leadSub.order;
          const earliestControllingDate = _isHardAvailDate(_controllingOrder)
            ? String(_controllingOrder.target_avail_date).substring(0, 10)
            : null;
          const controllingOrderType = _controllingOrder.category === 'MTO' ? 'MTO' : 'MTS';

          if (earliestControllingDate) {
            // Commit the tightest deadline as the combined order's date.
            baseOrder.target_avail_date = earliestControllingDate;
            if (controllingOrderType === 'MTO') {
              // Preserve MTO hard-date nature: clear auto_sequence source so the
              // combined order is not mistaken for an AI-moveable MTS date.
              baseOrder.category = 'MTO';
              if (baseOrder.avail_date_source === 'auto_sequence') {
                baseOrder.avail_date_source = null;
              }
            }
            // Store for AI clamp passes: MTS-controlled combined orders may still
            // receive AI suggested dates but must not exceed this ceiling.
            baseOrder._combinedEarliestHardDate = earliestControllingDate;
          }

          // Debug logging ──────────────────────────────────────────────────────
          const _combineCandidateIds = allSubOrders.map(s => String(s.order.id));
          const _componentDates = allSubOrders.map(s => ({
            id:         String(s.order.id),
            date:       s.order.target_avail_date || null,
            category:   s.order.category || null,
            isHardDate: _isHardAvailDate(s.order),
          }));

          console.debug('[Combination Earliest Date Resolution]', {
            combineCandidateIds: _combineCandidateIds,
            componentDates: _componentDates,
            earliestControllingDate,
            controllingOrderType,
          });

          console.debug('[Combination Mixed MTO MTS Handling]', {
            combineCandidateIds: _combineCandidateIds,
            hasMTO: _allSubOrderObjs.some(o => o.category === 'MTO'),
            hasMTS: _allSubOrderObjs.some(o => o.category !== 'MTO'),
            earliestControllingDate,
            combinedOrderDateBehavior: controllingOrderType === 'MTO'
              ? 'fixed_date'
              : 'mts_ai_suggested_date_allowed_with_ceiling',
          });

          const _hasDifferentDates = new Set(
            allSubOrders.map(s => String(s.order.target_avail_date || '').substring(0, 10))
          ).size > 1;
          if (_hasDifferentDates) {
            console.debug('[Combination Date Mismatch No Longer Blocking]', {
              combineCandidateIds: _combineCandidateIds,
              differentDatesDetected: true,
              blockedBecauseOfDateMismatch: false,
            });
          }
          // ── End earliest controlling date ────────────────────────────────────

          console.debug('[Combine Basis]', {
            combineOrderIds: allSubOrders.map(o => o.order.id),
            breakdown: baseOrder._combine_basis_breakdown,
            combinedBasisVolume,
            batchSize: batchSzCombine,
            finalCombinedVolume,
          });

          // ── Combined Order Sequencing Basis log (req §DEBUG) ──────────────
          console.debug('[Combined Order Sequencing Basis]', {
            combinedEntityId: String(baseOrder.id),
            leadOrderId: String(leadSub.order.id),
            subOrderIds: allSubOrders.map(s => String(s.order.id)),
            canonicalBasis: 'lead_order',
            leadOrderAvailDate: String(leadSub.order.target_avail_date || ''),
            leadOrderStatus: String(leadSub.order._n10dStatus || ''),
            subOrderAvailDates: allSubOrders.map(s => ({
              id: String(s.order.id),
              date: String(s.order.target_avail_date || ''),
              status: String(s.order._n10dStatus || ''),
            })),
            usedAvailDateForSequencing: String(leadSub.order.target_avail_date || ''),
          });

          // Final destination guard — shutdown lines must never receive
          // placements regardless of which path picked the destinationLine.
          if (SHUTDOWN_LINES.has(destinationLine)) {
            const safeFallback = ACTIVE_PLANT_LINES.find(l => canProduceOnLine(order, l)) || ACTIVE_PLANT_LINES[0];
            console.debug('[Auto-Sequence Shutdown Line Block]', {
              line: destinationLine,
              phase: 'combine_placement_guard',
              action: safeFallback ? 'reroute_off_shutdown' : 'skip_no_active_line',
              orderId: order.id,
              reason: getShutdownReason(destinationLine) || 'shutdown',
              rerouteTo: safeFallback,
            });
            if (!safeFallback) {
              // No active line to place onto — abort this combine placement.
              continue;
            }
            destinationLine = safeFallback;
            baseOrder.feedmill_line = destinationLine;
            baseOrder.line = destinationLine;
            baseOrder._plantMovement = baseOrder._originalLine === destinationLine ? "same" : "new_to_line";
            baseOrder._movedFromLine = baseOrder._originalLine !== destinationLine ? baseOrder._originalLine : null;
          }

          // Place on destination line
          lineTotalMT[destinationLine] = (lineTotalMT[destinationLine] || 0) + finalCombinedVolume;
          linePlacedMT[destinationLine] = (linePlacedMT[destinationLine] || 0) + finalCombinedVolume;
          if (!lineOrdersMap[destinationLine]) lineOrdersMap[destinationLine] = [];
          lineOrdersMap[destinationLine].push(baseOrder);

          // Enrich scores with after-placement values
          const enrichedScores = lineScores.map(ls => ({
            ...ls,
            totalMTAfter: parseFloat((lineTotalMT[ls.line] || 0).toFixed(1)),
            queueTimeAfter: parseFloat((ls.runRate > 0 ? (lineTotalMT[ls.line] || 0) / ls.runRate : 0).toFixed(2)),
          }));
          const bestScore = enrichedScores.find(ls => ls.line === destinationLine) || enrichedScores[0];
          const changeoversSaved = allSubOrders.length - 1;
          const fromLines = [...new Set(allSubOrders.map(s => s.line))];

          console.log(`  [Combined] ${order.item_description} (${allSubOrders.length} orders, basis ${combinedBasisVolume.toFixed(1)} MT → effective ${finalCombinedVolume.toFixed(1)} MT) → ${destinationLine}${wasLockedByPlanned ? " [Planned lock]" : ""}`);

          // Compute eligibility for the combined product (use the lead order's master-data eligibility).
          // When wasLockedByPlanned is true, destination was forced by a Planned order, NOT chosen
          // for master-data eligibility — so suppress onlyTargetEligible to avoid misleading insights.
          const combinedEligibleLines = ACTIVE_PLANT_LINES.filter(l => canProduceOnLine(order, l));
          const combinedOnlyTargetEligible =
            !wasLockedByPlanned &&
            combinedEligibleLines.length === 1 &&
            combinedEligibleLines[0] === destinationLine;

          placementLog.push({
            type: "combined",
            eligibleLines: combinedEligibleLines,
            onlyTargetEligible: combinedOnlyTargetEligible,
            product: order.item_description || order.material_code,
            materialCode: order.material_code_fg || order.material_code,
            ordersCount: allSubOrders.length,
            fromLines,
            toLine: destinationLine,
            totalVolume: finalCombinedVolume,
            wasLockedByPlanned,
            individualVolumes: allSubOrders.map(s => ({
              id: s.order.id,
              name: s.order.item_description,
              volume: s.volume,
              fromLine: s.line,
              fpr: s.order.fpr,
            })),
            lineScores: enrichedScores,
            bestLineReason: bestScore ? {
              line: destinationLine,
              feedmill: PLANT_LINE_TO_FM_LABEL[destinationLine] || destinationLine,
              runRate: bestScore.runRate || 0,
              queueTime: parseFloat((bestScore.queueTimeBefore || 0).toFixed(2)),
              totalMTBefore: bestScore.totalMTBefore || 0,
              totalMTAfter: bestScore.totalMTAfter || 0,
              queueTimeAfter: parseFloat((bestScore.queueTimeAfter || 0).toFixed(2)),
            } : {
              line: destinationLine,
              feedmill: PLANT_LINE_TO_FM_LABEL[destinationLine] || destinationLine,
              runRate: getLineRunRate(destinationLine),
              queueTime: 0,
              totalMTBefore: 0,
              totalMTAfter: totalVolume,
              queueTimeAfter: parseFloat((totalVolume / getLineRunRate(destinationLine)).toFixed(2)),
            },
            changeoversSaved,
            baseChangeover,
            timeSaved: parseFloat((changeoversSaved * baseChangeover).toFixed(2)),
            // True pre-combine line loads — used by the AI prompt for accurate "before" reporting.
            // lineScores.totalMTBefore is computed post-removal (needed for destination selection)
            // so it shows 0 for combine-in-place. preCombineMTByLine holds the real pre-action state.
            preCombineMTByLine: preCombineMTSnapshot,
          });

          continue; // next order
        }

        // ── No match — evaluate single order placement ──────────────────────

        // If the base order is an existing combined lead with no new combine partners,
        // remove its children from lineOrdersMap so they don't appear as standalone rows.
        // Restore _isCombined/_combinedFrom so the After table renders it as a combined group.
        if (baseIsExistingLead && baseChildren.length > 0) {
          for (const child of baseChildren) {
            const childLine = normalizeLine(child.feedmill_line || line);
            lineOrdersMap[childLine] = (lineOrdersMap[childLine] || []).filter(o => o.id !== child.id);
            processedIds.add(child.id);
          }
          order._isCombined = true;
          order._combinedFrom = baseChildren.map(c => ({
            id: c.id,
            fpr: c.fpr,
            volume: getOrderVolumeMT(c),
            total_volume_mt: getOrderVolumeMT(c),
            volume_override: c.volume_override ?? null,
            line: normalizeLine(c.feedmill_line || line),
            item_description: c.item_description,
            material_code_fg: c.material_code_fg,
            material_code: c.material_code,
            form: c.form,
            category: c.category,
            fg: c.fg,
            sfg: c.sfg,
            production_time: c.production_hours,
            batch_size: c.batch_size,
            batches: c.batches,
            status: c.status,
            target_avail_date: c.target_avail_date,
          }));
        }

        // Planned orders stay on their line — never move them solo
        if (order._isPlanned) {
          order._processed = true;
          processedIds.add(order.id);
          continue;
        }

        // Powermix source orders (Line 5 all, Line 7 with active rule) are line-locked.
        if (order._isPowermixSourceOrder) {
          const assignedLine = normalizeLine(order.feedmill_line || order._originalLine);
          console.debug('[AutoSequence Powermix Source Order Line Lock]', {
            orderId: order.id,
            isPowermixSourceOrder: true,
            assignedLine,
            consideredForCrossLineMove: false,
            allowedToMoveCrossLine: false,
          });
          order._processed = true;
          processedIds.add(order.id);
          continue;
        }

        const currentLine = normalizeLine(order.feedmill_line || order._originalLine);
        // For generated orders: also enforce non-overlap with another generated order
        // from the same source on the candidate line.
        const _genSourceId = isGeneratedPmxOrder ? String(order.powermix_source_order_id || '') : '';
        const eligibleLines = ACTIVE_PLANT_LINES.filter(l => {
          const passedRunRateGate = canProduceOnLine(order, l);
          if (!passedRunRateGate) {
            if (isGeneratedPmxOrder) {
              console.debug('[Generated Order Cross-Line Gate Result]', {
                orderId: order.id,
                sourceLine: currentLine,
                candidateLine: l,
                passedRunRateGate: false,
                blockedByOverlap: false,
                finalEligibleForScoring: false,
              });
            }
            return false;
          }
          if (isGeneratedPmxOrder) {
            const wouldOverlap = _genSourceId && (lineOrdersMap[l] || []).some(o =>
              o.id !== order.id &&
              (o.is_powermix_generated === true || o.is_powermix_generated === 'true') &&
              String(o.powermix_source_order_id || '') === _genSourceId
            );
            console.debug('[Generated Order Cross-Line Gate Result]', {
              orderId: order.id,
              sourceLine: currentLine,
              candidateLine: l,
              passedRunRateGate: true,
              blockedByOverlap: wouldOverlap,
              finalEligibleForScoring: !wouldOverlap,
            });
            if (wouldOverlap) return false;
          }
          return true;
        });

        // If this order currently sits on a shutdown line, log its movement
        // evaluation per the new shutdown-line-as-source rule.
        if (SHUTDOWN_LINES.has(currentLine)) {
          console.debug('[Shutdown-Line Order Movement Evaluation]', {
            orderId: order.id,
            currentLine,
            currentLineShutdownActive: true,
            eligibleForMoveEvaluation: eligibleLines.length > 0,
            candidateActiveLines: eligibleLines,
            moveApplied: eligibleLines.length > 0 && !eligibleLines.includes(currentLine),
          });
        }

        if (eligibleLines.length === 0) {
          order._processed = true;
          processedIds.add(order.id);
          continue;
        }

        // Capture source line state BEFORE removing the order — this is the true "before move" load
        const sourceRunRate = getLineRunRate(currentLine);
        const sourceBeforeMT = parseFloat(((lineTotalMT[currentLine] || 0)).toFixed(2));
        const sourceAfterMT = parseFloat((Math.max(0, sourceBeforeMT - orderVolume)).toFixed(2));
        const sourceBeforeQueue = calculateQueueTimeHours(sourceBeforeMT, sourceRunRate);
        const sourceAfterQueue = calculateQueueTimeHours(sourceAfterMT, sourceRunRate);

        // Remove from current line
        lineTotalMT[currentLine] = (lineTotalMT[currentLine] || 0) - orderVolume;
        lineOrdersMap[currentLine] = (lineOrdersMap[currentLine] || []).filter(o => o.id !== order.id);

        // Build candidate scores from the post-removal state of each line
        // (correct for all destination lines; source line not included as its own destination)
        const singleScores = eligibleLines.map(l => {
          const curMT = lineTotalMT[l] || 0;
          const rr = getLineRunRate(l);
          const ln = parseInt(l.match(/\d+/)?.[0] || "99");
          return {
            line: l,
            feedmill: PLANT_LINE_TO_FM_LABEL[l] || l,
            runRate: rr,
            totalMTBefore: parseFloat(curMT.toFixed(1)),
            queueTimeBefore: rr > 0 ? curMT / rr : Infinity,
            lineNumber: ln,
            _compositeScore: _scoreLineForOrder(l, order, orderVolume),
          };
        });
        singleScores.sort((a, b) => {
          const d = a._compositeScore - b._compositeScore;
          if (Math.abs(d) > 0.001) return d;
          return a.lineNumber - b.lineNumber;
        });
        const bestLine = singleScores[0].line;

        order.feedmill_line = bestLine;
        order.line = bestLine;
        order._plantMovement = currentLine === bestLine ? "same" : "new_to_line";
        order._movedFromLine = currentLine !== bestLine ? currentLine : null;
        order._processed = true;
        processedIds.add(order.id);

        lineTotalMT[bestLine] = (lineTotalMT[bestLine] || 0) + orderVolume;
        linePlacedMT[bestLine] = (linePlacedMT[bestLine] || 0) + orderVolume;
        if (!lineOrdersMap[bestLine]) lineOrdersMap[bestLine] = [];
        lineOrdersMap[bestLine].push(order);

        if (bestLine !== currentLine) {
          const enrichedSingle = singleScores.map(ls => ({
            ...ls,
            totalMTAfter: parseFloat((lineTotalMT[ls.line] || 0).toFixed(1)),
            queueTimeAfter: parseFloat((ls.runRate > 0 ? (lineTotalMT[ls.line] || 0) / ls.runRate : 0).toFixed(2)),
          }));
          const movedBest = enrichedSingle.find(ls => ls.line === bestLine) || enrichedSingle[0];

          console.log(`  [Moved] ${order.item_description} (${orderVolume} MT) ${currentLine} → ${bestLine}`);

          if (isGeneratedPmxOrder) {
            console.debug('[Generated Order Auto-Sequence Move]', {
              orderId: order.id,
              originalAssignedLine: currentLine,
              movedToLine: bestLine,
              moveReason: 'Historical run-rate eligibility and non-overlap validation passed',
            });
          }

          console.debug('[Queue Time Calculation]', {
            sourceLine: currentLine,
            destinationLine: bestLine,
            movedOrderId: order.id,
            movedMT: orderVolume,
            sourceBeforeMT,
            sourceAfterMT,
            destinationBeforeMT: movedBest?.totalMTBefore || 0,
            destinationAfterMT: movedBest?.totalMTAfter || 0,
            sourceRunRate,
            destinationRunRate: getLineRunRate(bestLine),
            sourceBeforeQueue,
            sourceAfterQueue,
            destinationBeforeQueue: parseFloat((movedBest?.queueTimeBefore || 0).toFixed(2)),
            destinationAfterQueue: parseFloat((movedBest?.queueTimeAfter || 0).toFixed(2)),
            sourceOrderCount: (lineOrdersMap[currentLine] || []).length,
            destinationOrderCount: (lineOrdersMap[bestLine] || []).length,
          });

          const onlyTargetEligible =
            eligibleLines.length === 1 && eligibleLines[0] === bestLine;
          const sourceEligible = eligibleLines.includes(currentLine);

          placementLog.push({
            type: "moved",
            order: order.item_description || order.material_code,
            product: order.item_description || order.material_code,
            volume: orderVolume,
            fromLine: currentLine,
            toLine: bestLine,
            fpr: order.fpr,
            lineScores: enrichedSingle,
            eligibleLines,
            onlyTargetEligible,
            sourceEligible,
            bestLineReason: {
              line: bestLine,
              feedmill: PLANT_LINE_TO_FM_LABEL[bestLine] || bestLine,
              runRate: movedBest?.runRate || 0,
              queueTime: parseFloat((movedBest?.queueTimeBefore || 0).toFixed(2)),
              totalMTBefore: movedBest?.totalMTBefore || 0,
              totalMTAfter: movedBest?.totalMTAfter || 0,
              queueTimeAfter: parseFloat((movedBest?.queueTimeAfter || 0).toFixed(2)),
            },
            fromLineReason: {
              line: currentLine,
              runRate: sourceRunRate,
              totalMTBefore: sourceBeforeMT,
              totalMTAfter: sourceAfterMT,
              queueTime: sourceBeforeQueue,
              queueTimeAfter: sourceAfterQueue,
            },
          });
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // POST-PASS: Mirror generated-order combines back to linked Powermix source orders
    // ─────────────────────────────────────────────────────────────────────────────
    // When generated orders combine into a lead, the corresponding Powermix
    // source orders (Line 5 or Line 7, linked via powermix_source_order_id)
    // must mirror that grouping. This mirrored source-side combine BYPASSES the
    // normal PLANT_MAX_COMBINE_MT cap because it is a structural reflection of
    // a validly-combined generated group, not an independent combine.
    // ─────────────────────────────────────────────────────────────────────────────
    {
      const _isGen = (o) => o.is_powermix_generated === true || o.is_powermix_generated === 'true';

      // id → full order from the eligible pool (includes both source and generated)
      const orderById = new Map();
      for (const o of eligible) orderById.set(String(o.id), o);

      // Collect every combined lead currently in lineOrdersMap (any line)
      const allLeads = [];
      for (const ln of PLANT_ALL_LINES) {
        for (const o of (lineOrdersMap[ln] || [])) {
          if (o._isCombined && Array.isArray(o._combinedFrom) && o._combinedFrom.length > 1) {
            allLeads.push({ lead: o, line: ln });
          }
        }
      }

      for (const { lead: genLead } of allLeads) {
        // Resolve each child to the real order to inspect its powermix flags
        const childIds = (genLead._combinedFrom || []).map(c => String(c.id));
        const childOrders = childIds.map(id => orderById.get(id)).filter(Boolean);
        const generatedChildren = childOrders.filter(_isGen);
        if (generatedChildren.length < 2) continue; // not a generated-side combine

        // Defense in depth: mixed groups should never reach here
        const hasSource = childOrders.some(o => o._isPowermixSourceOrder || !_isGen(o));
        if (hasSource) {
          console.debug('[Powermix Generated/Source Guardrail]', {
            orderAType: 'generated',
            orderBType: 'source',
            directMixedCombineBlocked: true,
            context: 'mirror_postpass_mixed_group_skipped',
            generatedLeadId: genLead.id,
          });
          continue;
        }

        // Find the linked Powermix source orders via powermix_source_order_id
        const linkedSourceIds = generatedChildren
          .map(o => String(o.powermix_source_order_id || ''))
          .filter(Boolean);
        const linkedSourceIdSet = new Set(linkedSourceIds);
        const linkedSources = [...linkedSourceIdSet]
          .map(id => orderById.get(id))
          .filter(Boolean);
        if (linkedSources.length < 2) {
          // Only one (or zero) distinct linked source — nothing structural to
          // mirror. Log for visibility so misconfigured powermix_source_order_id
          // links surface during auto-sequence.
          console.debug('[Powermix Combine Mirror]', {
            generatedGroupId: genLead.id,
            sourceLine: null,
            generatedOrdersCombined: true,
            mirroredSourceCombineApplied: false,
            reason: 'fewer_than_2_distinct_linked_sources',
            distinctLinkedSourceCount: linkedSources.length,
          });
          continue;
        }

        // All linked sources must live on a single source line (Line 5 or Line 7)
        const srcLines = [...new Set(linkedSources.map(s =>
          normalizeLine(s.feedmill_line || s._originalLine)
        ))];
        if (srcLines.length !== 1) continue;
        const sourceLine = srcLines[0];
        if (sourceLine !== 'Line 5' && sourceLine !== 'Line 7') continue;

        // If the source side is ALREADY combined exactly as the gen-side group
        // (matching child set), no work needed — just log "already mirrored".
        const existingMirror = (lineOrdersMap[sourceLine] || []).find(o => {
          if (!o._isCombined || !Array.isArray(o._combinedFrom)) return false;
          const cset = new Set(o._combinedFrom.map(c => String(c.id)));
          if (cset.size !== linkedSourceIdSet.size) return false;
          for (const id of linkedSourceIdSet) if (!cset.has(id)) return false;
          return true;
        });
        if (existingMirror) {
          console.debug('[Powermix Combine Mirror]', {
            generatedGroupId: genLead.id,
            sourceGroupId: existingMirror.id,
            sourceLine,
            generatedOrdersCombined: true,
            mirroredSourceCombineApplied: false,
            reason: 'already_mirrored_by_prepass',
          });
          continue;
        }

        // Dissolve any partial source-side combined leads that overlap (e.g.,
        // the Line 5 source pre-pass grouped a subset that differs from the
        // gen-side group).
        const partialLeads = (lineOrdersMap[sourceLine] || []).filter(o =>
          o._isCombined &&
          Array.isArray(o._combinedFrom) &&
          o._combinedFrom.some(c => linkedSourceIdSet.has(String(c.id)))
        );
        if (partialLeads.length > 0) {
          const partialLeadIds = new Set(partialLeads.map(l => String(l.id)));
          // Drop partial leads
          lineOrdersMap[sourceLine] = (lineOrdersMap[sourceLine] || [])
            .filter(o => !partialLeadIds.has(String(o.id)));
          // Re-add any of their children that are NOT in our linkedSources set,
          // so they remain visible as standalone rows on the source line.
          for (const pl of partialLeads) {
            for (const child of (pl._combinedFrom || [])) {
              if (linkedSourceIdSet.has(String(child.id))) continue;
              const real = orderById.get(String(child.id));
              if (real && !(lineOrdersMap[sourceLine] || []).some(o => String(o.id) === String(real.id))) {
                lineOrdersMap[sourceLine].push(real);
              }
            }
          }
        }

        // Drop standalone linked source rows from the source line (they become children)
        lineOrdersMap[sourceLine] = (lineOrdersMap[sourceLine] || [])
          .filter(o => !linkedSourceIdSet.has(String(o.id)));

        // Build the mirror source lead — bypasses the normal cap by design
        const sortedSrc = [...linkedSources].sort((a, b) =>
          (parseFloat(b.total_volume_mt) || 0) - (parseFloat(a.total_volume_mt) || 0)
        );
        const mirrorLead = { ...sortedSrc[0] };
        const totalSrcMT = linkedSources.reduce(
          (s, o) => s + (parseFloat(o.total_volume_mt) || 0), 0
        );
        mirrorLead.total_volume_mt = totalSrcMT.toFixed(1);
        mirrorLead.production_hours = linkedSources
          .reduce((s, o) => s + (parseFloat(o.production_hours) || 0), 0)
          .toFixed(2);
        mirrorLead._isCombined = true;
        mirrorLead._isPowermixMirrorCombine = true;
        mirrorLead._mirroredFromGeneratedLeadId = genLead.id;
        mirrorLead._combinedFrom = linkedSources.map(o => ({
          id: o.id,
          line: sourceLine,
          fpr: o.fpr,
          volume: parseFloat(o.total_volume_mt) || 0,
          total_volume_mt: parseFloat(o.total_volume_mt) || 0,
          volume_override: o.volume_override ?? null,
          item_description: o.item_description,
          form: o.form,
          material_code_fg: o.material_code_fg || o.material_code,
          material_code: o.material_code || o.material_code_fg,
          fg: o.fg,
          sfg: o.sfg,
          batch_size: o.batch_size,
          production_time: o.production_hours,
          target_avail_date: o.target_avail_date,
          category: o.category,
        }));
        mirrorLead._combinedFromLines = [sourceLine];
        mirrorLead.feedmill_line = sourceLine;
        mirrorLead.line = sourceLine;
        mirrorLead._originalLine = sourceLine;
        mirrorLead._plantMovement = 'same';

        console.debug('[Powermix Mirror Combine Cap Exception]', {
          sourceGroupId: mirrorLead.id,
          mirroredSourceCombinedVolume: totalSrcMT,
          standardCapMT: PLANT_MAX_COMBINE_MT,
          capExceeded: totalSrcMT > PLANT_MAX_COMBINE_MT,
          allowedBecauseMirroredPowermixSourceCombine: true,
        });

        if (!lineOrdersMap[sourceLine]) lineOrdersMap[sourceLine] = [];
        lineOrdersMap[sourceLine].push(mirrorLead);

        console.debug('[Powermix Combine Mirror]', {
          generatedGroupId: genLead.id,
          sourceGroupId: mirrorLead.id,
          sourceLine,
          generatedOrdersCombined: true,
          mirroredSourceCombineApplied: true,
          linkedSourceCount: linkedSources.length,
          mirroredSourceVolumeMT: totalSrcMT,
          dissolvedPartialLeadIds: partialLeads.map(l => l.id),
        });

        placementLog.push({
          type: 'combined',
          product: mirrorLead.item_description,
          materialCode: mirrorLead.material_code,
          ordersCount: linkedSources.length,
          totalVolume: totalSrcMT,
          toLine: sourceLine,
          fromLines: [sourceLine],
          changeoversSaved: linkedSources.length - 1,
          timeSaved: (linkedSources.length - 1) * 0.17,
          individualVolumes: linkedSources.map(o => ({
            fromLine: sourceLine,
            volume: parseFloat(o.total_volume_mt) || 0,
            fpr: o.fpr,
          })),
          lineScores: [{
            line: sourceLine,
            runRate: getLineRunRate(sourceLine),
            totalMTBefore: 0,
            queueTimeBefore: 0,
            totalMTAfter: totalSrcMT,
            queueTimeAfter: 0,
          }],
          bestLineReason: { line: sourceLine, queueTime: 0, totalMTBefore: 0, totalMTAfter: totalSrcMT },
          _isPowermixMirror: true,
          mirroredFromGeneratedLeadId: genLead.id,
        });
      }
    }
    // ─── End Powermix source-side mirror combine post-pass ───────────────────

    // ── Sort each line's final orders chronologically — ALL orders, no planned-lock ──
    // Planned orders participate in the same date-based sort; they are NOT pinned to top.
    // Sort tiers:
    //   0 — Critical (no avail date, N10D=Critical) — top, by DFL/Inv ratio desc
    //   1 — Any order with an effective date (hard avail OR inferred) — sorted by date asc
    //   2 — No date signal at all — bottom
    // Dates from any source (target_avail_date or N10D inferred) are treated equally —
    // Apr 19 from N10D always sorts before Apr 20 from hard avail date.
    const _pcIsRealISO = (v) => !!v && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v));
    const plantChronologicalSort = (lineOrders) => {
      const enriched = lineOrders.map(o => {
        const _isGenOrder = o.is_powermix_generated === true || o.is_powermix_generated === 'true';
        const _genFgCode = _isGenOrder && o.powermix_rule_id
          ? (pmxSplitRules?.find(r => String(r.id) === String(o.powermix_rule_id))?.fg_code || null)
          : null;
        const inf = inferredTargetMap?.[o.material_code] || inferredTargetMap?.[o.material_code_fg]
          || (_genFgCode ? inferredTargetMap?.[_genFgCode] : null);
        // Dates from auto-sequence or N10D are re-evaluated from latest N10D data — not hard deadlines
        const _pcIsN10DSourced = o.avail_date_source === 'auto_sequence' || o.date_source === 'n10d';
        const isHardDeadline = _pcIsRealISO(o.target_avail_date) && !_pcIsN10DSourced;
        let sortTier = 2; // no date
        let effectiveDate = null;
        let dflToInvRatio = 0;
        let n10dStatus = inf?.status || null;

        if (inf?.status === 'Critical' && !isHardDeadline) {
          // Critical with no hard avail date → absolute top
          sortTier = 0;
          effectiveDate = null;
          const dfl = parseFloat(inf.dueForLoading) || 0;
          const inv = parseFloat(inf.inventory) || 0;
          dflToInvRatio = inv > 0 ? dfl / inv : Infinity;
        } else {
          // All other orders: hard avail date takes priority; N10D date is only a fallback
          // This matches sequencePreCompute.js and ensures planners see the real deadline.
          if (isHardDeadline) {
            effectiveDate = new Date(o.target_avail_date);
          } else if (inf?.targetDate && _pcIsRealISO(inf.targetDate)) {
            effectiveDate = new Date(inf.targetDate);
          }
          sortTier = effectiveDate ? 1 : 2;
        }

        return { ...o, _sortTier: sortTier, _effectiveDate: effectiveDate, _n10dStatus: n10dStatus, _dflToInvRatio: dflToInvRatio };
      });

      enriched.sort((a, b) => {
        if (a._sortTier !== b._sortTier) return a._sortTier - b._sortTier;
        // Tier 0 — Critical: highest DFL/Inv ratio first
        if (a._sortTier === 0) return (b._dflToInvRatio ?? 0) - (a._dflToInvRatio ?? 0);
        // Tier 1 — all dated orders: strictly chronological regardless of date source
        if (a._effectiveDate && b._effectiveDate) return a._effectiveDate - b._effectiveDate;
        if (a._effectiveDate) return -1;
        if (b._effectiveDate) return 1;
        return 0;
      });

      enriched.forEach((o, i) => {
        o.prio = i + 1;
        o.priority_seq = i + 1;
      });
      return enriched;
    };

    const sequencedByLine = {};
    PLANT_ALL_LINES.forEach(line => {
      sequencedByLine[line] = plantChronologicalSort(lineOrdersMap[line] || []);
    });

    // ── Greedy conflict resolver + annotation ─────────────────────────────────
    // 1. Runs cascade simulation on each line's sorted sequence.
    // 2. When a deadline conflict is found, moves the "blocking" order (no
    //    deadline or later deadline than the conflicting order) to after the
    //    conflicting order, then re-simulates — up to 30 passes.
    // 3. Annotates the final sequence with _simEstCompletion / _scheduleConflict
    //    so the After table can still warn about genuinely unsolvable conflicts.
    const _simIsRealISO = (v) => !!v && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v));
    // PHT = UTC+8: midnight UTC of a date = 8 AM PHT of that date.
    const _PHT_MS = 8 * 3600_000;
    const _toPHTDateStr = (d) => new Date(d.getTime() + _PHT_MS).toISOString().substring(0, 10);
    const _parseSimDate = (dateStr, timeStr) => {
      if (!dateStr) return null;
      const dateOnly = String(dateStr).substring(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return null;
      const tp = String(timeStr || '08:00').match(/(\d+):(\d+)\s*(am|pm)?/i);
      if (!tp) return null;
      let h = parseInt(tp[1]), m = parseInt(tp[2]);
      if (tp[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
      if (tp[3]?.toLowerCase() === 'am' && h === 12) h = 0;
      // PHT 8 AM = UTC midnight; PHT h:m = UTC midnight + (h-8)h + m min
      const base = new Date(`${dateOnly}T00:00:00.000Z`);
      return new Date(base.getTime() + (h - 8) * 3600_000 + m * 60_000);
    };

    // PHT 8:00 AM today
    const _todayPHT = _toPHTDateStr(new Date());
    const todaySimStart = new Date(`${_todayPHT}T00:00:00.000Z`);

    // Runs a forward simulation on a sequence; returns annotated copy of results.
    const runLineSim = (seq) => {
      let rolling = null;
      return seq.map(order => {
        if (order.status === 'In Production' || order.status === 'On-going') {
          if (order.target_completion_date) {
            const parts = order.target_completion_date.split(' ');
            const ex = _parseSimDate(parts[0], parts[1]);
            if (ex) rolling = ex;
          }
          return { order, simEnd: rolling, conflict: false };
        }
        const ph = calcProductionHours(order) ?? 0;
        const co = parseFloat(order._changeoverTotal ?? order.changeover_time ?? 0.17);
        let simStart;
        if (order.start_date && order.start_time) {
          simStart = _parseSimDate(order.start_date, order.start_time);
        } else if (rolling) {
          simStart = new Date(rolling.getTime() + co * 3600000);
        } else {
          simStart = new Date(todaySimStart);
        }
        const simEnd = simStart ? new Date(simStart.getTime() + ph * 3600000) : null;
        let conflict = false;
        if (simEnd && _simIsRealISO(order.target_avail_date)) {
          // PHT 23:59:59 = UTC 15:59:59 of the same date (UTC+8 − 8h = UTC, 23:59−8h = 15:59)
          const dl = new Date(`${String(order.target_avail_date).substring(0, 10)}T15:59:59.999Z`);
          conflict = simEnd > dl;
        }
        if (simEnd) rolling = simEnd;
        return { order, simEnd, conflict };
      });
    };

    // Greedy optimizer: tries to move blocking orders after conflicting ones.
    const resolveLineConflicts = (lineSeq) => {
      const isLocked = (o) => o.status === 'In Production' || o.status === 'On-going';
      const locked = lineSeq.filter(isLocked);
      let mutable = lineSeq.filter(o => !isLocked(o));
      const MAX_PASSES = 30;

      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const simResults = runLineSim([...locked, ...mutable]);
        // First conflict in the full sequence
        const firstConflictIdx = simResults.findIndex(r => r.conflict);
        if (firstConflictIdx === -1) break; // All clear

        const conflictOrder = simResults[firstConflictIdx].order;
        const conflictDL = new Date(conflictOrder.target_avail_date);
        conflictDL.setHours(23, 59, 59, 999);

        // Find the conflicting order's position inside mutable
        const mutIdx = mutable.indexOf(conflictOrder);
        if (mutIdx <= 0) break; // Nothing before it that we can move

        // Find the closest moveable order before it:
        // moveable = no deadline OR deadline strictly later than the conflicting order's deadline
        let moveIdx = -1;
        for (let j = mutIdx - 1; j >= 0; j--) {
          const o = mutable[j];
          if (isLocked(o)) continue;
          const hasDeadline = _simIsRealISO(o.target_avail_date);
          if (!hasDeadline) { moveIdx = j; break; }
          const oDL = new Date(o.target_avail_date);
          if (oDL > conflictDL) { moveIdx = j; break; }
        }
        if (moveIdx === -1) break; // Nothing moveable — genuine capacity issue

        // Move mutable[moveIdx] to just after mutIdx
        // After splice(moveIdx,1) the array shrinks by 1, so mutIdx becomes mutIdx-1,
        // and inserting at mutIdx places the element directly after the conflict order.
        const [moved] = mutable.splice(moveIdx, 1);
        mutable.splice(mutIdx, 0, moved);
      }

      return [...locked, ...mutable];
    };

    // Set of order IDs that complete past their hard deadline in a given seq.
    // We track IDs (not just a count) so the regroup gate can reject any move
    // that makes a NEW order late — a pure count gate would wrongly allow a swap
    // that makes order A late while making order B on-time (count unchanged).
    const _simLateIds = (seq) => {
      const s = new Set();
      for (const r of runLineSim(seq)) {
        if (r.conflict && r.order?.id != null) s.add(r.order.id);
      }
      return s;
    };

    // ── Slack-aware diameter-streak regrouping ────────────────────────────────
    // A die (diameter) change is the single most expensive changeover, so pull
    // later same-diameter orders forward to sit adjacent — but ONLY when doing so
    // never makes any order miss its deadline (gated by _simLateCount, the same
    // flat-changeover sim resolveLineConflicts uses, so the two layers stay
    // consistent). Pinned orders (In Production / On-going, and tier-0 Critical
    // with no hard date) keep their leading position and are never reordered.
    // Line 5 (Powermix) is excluded — its orders are line-locked and combined
    // separately. Within a diameter run the existing chronological (EDF) order is
    // preserved; only cross-streak adjacency changes.
    const regroupByDiameter = (lineKey, lineSeq) => {
      if (lineKey === "Line 5") return lineSeq;
      if (!Array.isArray(lineSeq) || lineSeq.length < 3) return lineSeq;
      const isLocked = (o) => o.status === 'In Production' || o.status === 'On-going';
      const isPinned = (o) => isLocked(o) || o._sortTier === 0;
      const pinned = lineSeq.filter(isPinned);
      const pool = lineSeq.filter(o => !isPinned(o));
      if (pool.length < 2) return lineSeq;

      const baselineLateIds = _simLateIds(lineSeq);
      const result = [];
      const used = new Array(pool.length).fill(false);

      for (let i = 0; i < pool.length; i++) {
        if (used[i]) continue;
        result.push(pool[i]);
        used[i] = true;
        const dia = getDiameterKey(pool[i]);
        if (!dia) continue;
        // Greedily pull each later same-diameter order up next to this run,
        // accepting the move only if it makes NO new order late. A trial is
        // rejected when any of its late orders was on-time in the baseline —
        // this guarantees the regroup never pushes an order past its deadline,
        // even if it would coincidentally rescue a different order.
        for (let j = i + 1; j < pool.length; j++) {
          if (used[j]) continue;
          if (getDiameterKey(pool[j]) !== dia) continue;
          const remaining = [];
          for (let k = 0; k < pool.length; k++) {
            if (!used[k] && k !== j) remaining.push(pool[k]);
          }
          const trial = [...pinned, ...result, pool[j], ...remaining];
          const trialLateIds = _simLateIds(trial);
          let introducesNewLate = false;
          for (const id of trialLateIds) {
            if (!baselineLateIds.has(id)) { introducesNewLate = true; break; }
          }
          if (!introducesNewLate) {
            result.push(pool[j]);
            used[j] = true;
          }
        }
      }
      return [...pinned, ...result];
    };

    // Apply diameter regroup → optimizer, then annotate the final sequence
    PLANT_ALL_LINES.forEach(line => {
      const regrouped = regroupByDiameter(line, sequencedByLine[line] || []);
      const optimized = resolveLineConflicts(regrouped);
      // Re-stamp sequence numbers after regroup + conflict resolution so prio /
      // priority_seq reflect the final order shown to the planner.
      optimized.forEach((o, i) => {
        o.prio = i + 1;
        o.priority_seq = i + 1;
      });
      sequencedByLine[line] = optimized;

      // Annotation pass: mark remaining conflicts (genuinely unsolvable by re-order)
      const simResults = runLineSim(optimized);
      simResults.forEach(({ order, simEnd, conflict }) => {
        order._simEstCompletion = simEnd;
        order._scheduleConflict = conflict;
      });
    });

    // ── Apply preview-style changeovers to both before/after arrays ───────────
    // originalByLine orders come from enrichedOrders (KB-enriched only, no
    // _changeoverTotal). sequencedByLine orders also carry no correct sequence-
    // aware changeover. applyPreviewChangeovers sets _changeoverTotal on each
    // row based on the actual next-order in that line's sorted list — exactly
    // matching what PlantLineTab shows in its table rows.
    PLANT_ALL_LINES.forEach(line => {
      const before = originalByLine[line];
      const after = sequencedByLine[line];
      if (before?.length) applyPreviewChangeovers(before, coRules);
      if (after?.length)  applyPreviewChangeovers(after, coRules);
      console.debug('[Preview Changeover Check]', {
        line,
        before: (before || []).map(o => ({ orderId: o.id, displayedChangeover: parseFloat(o._changeoverTotal ?? 0) })),
        beforeTotalChangeover: parseFloat(((before || []).reduce((s, o) => s + (parseFloat(o._changeoverTotal ?? 0) || 0), 0)).toFixed(2)),
        after: (after || []).map(o => ({ orderId: o.id, displayedChangeover: parseFloat(o._changeoverTotal ?? 0) })),
        afterTotalChangeover: parseFloat(((after || []).reduce((s, o) => s + (parseFloat(o._changeoverTotal ?? 0) || 0), 0)).toFixed(2)),
      });
    });

    // ── Summary stats ──────────────────────────────────────────────────────────
    const perLineSummary = PLANT_ALL_LINES.map(line => {
      const before = originalByLine[line] || [];
      const after = sequencedByLine[line] || [];
      const beforeMT = calculateEffectiveLineTotalMT(before);
      const afterMT = calculateEffectiveLineTotalMT(after);
      const runRate = getLineRunRate(line);
      const beforeHours = calculateLineHoursBreakdown(before);
      const afterHours = calculateLineHoursBreakdown(after);
      const newOrders = after.filter(o => o._plantMovement === "new_to_line").length;
      const removedOrders = before.filter(o =>
        !after.some(a => a.id === o.id && !a._isCombined) &&
        !after.some(a => a._isCombined && a._combinedFrom?.some(c => c.id === o.id))
      ).length;
      return {
        line,
        feedmill: PLANT_LINE_TO_FM_LABEL[line] || line,
        runRate,
        beforeCount: before.length,
        afterCount: after.length,
        beforeMT: beforeMT.toFixed(1),
        afterMT: afterMT.toFixed(1),
        beforeHours,
        afterHours,
        hoursDiff: Number((afterHours.totalHours - beforeHours.totalHours).toFixed(2)),
        newOrders,
        removedOrders,
      };
    });

    const totalOrdersBefore = PLANT_ALL_LINES.reduce((s, l) => s + (originalByLine[l] || []).length, 0);
    const totalOrdersAfter = PLANT_ALL_LINES.reduce((s, l) => s + (sequencedByLine[l] || []).length, 0);
    const ordersCombined = PLANT_ALL_LINES.reduce((s, l) => s + (sequencedByLine[l] || []).filter(o => o._isCombined).length, 0);
    const ordersMovedBetweenLines = PLANT_ALL_LINES.reduce(
      (s, l) => s + (sequencedByLine[l] || []).filter(o => o._plantMovement === "new_to_line").length, 0
    );

    const linesAffectedSet = new Set();
    placementLog.forEach(entry => {
      const isCrossLine = entry.type === "combined"
        ? (entry.fromLines || []).some(l => l !== entry.toLine)
        : entry.fromLine && entry.fromLine !== entry.toLine;
      if (isCrossLine) {
        if (entry.type === "combined") {
          (entry.fromLines || []).forEach(l => linesAffectedSet.add(l));
        } else {
          linesAffectedSet.add(entry.fromLine);
        }
        linesAffectedSet.add(entry.toLine);
      }
    });

    return {
      originalByLine,
      sequencedByLine,
      placementLog,
      summaryStats: {
        totalOrdersBefore,
        totalOrdersAfter,
        ordersCombined,
        ordersMovedBetweenLines,
        linesAffected: linesAffectedSet.size,
        perLineSummary,
      },
    };
  };

  return plantLevelCombineAndPlace;
}
