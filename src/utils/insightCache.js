import { useState, useEffect } from 'react';

// Each entry: { template: string (no emoji), templateEmoji: string (with emoji), ai: string|null, combined: string }
// combined = templateEmoji + '\n\n' + ai  (used by tooltips via getInsight())
// order table uses template (no emoji) via getInsightParts()
let _cache = {};
let _loading = false;
let _error = false;
const _listeners = new Set();

function _notify() {
  _listeners.forEach(fn => fn());
}

// Full replace — for Re-apply / legacy callers that pass { [code]: string }
export function setInsights(map) {
  const next = {};
  Object.entries(map || {}).forEach(([code, val]) => {
    if (val && typeof val === 'object') {
      const { template, templateEmoji, ai } = val;
      const combined = ai ? (templateEmoji || template) + '\n\n' + ai : (templateEmoji || template);
      next[String(code)] = { template: template || '', templateEmoji: templateEmoji || template || '', ai: ai || null, combined };
    } else {
      next[String(code)] = { template: val, templateEmoji: val, ai: null, combined: val };
    }
  });
  _cache = next;
  _loading = false;
  _error = false;
  _notify();
}

// Phase 1: set template-only entries immediately (before AI responds)
// Accepts { [code]: { template, templateEmoji } } from buildInsightTemplates
// or { [code]: string } for backward compat
export function setTemplateInsights(map) {
  const next = {};
  Object.entries(map || {}).forEach(([code, val]) => {
    if (val && typeof val === 'object') {
      const { template, templateEmoji } = val;
      next[String(code)] = { template: template || '', templateEmoji: templateEmoji || template || '', ai: null, combined: templateEmoji || template || '' };
    } else {
      next[String(code)] = { template: val, templateEmoji: val, ai: null, combined: val };
    }
  });
  _cache = next;
  _notify();
}

// Phase 2: merge AI advisory text into existing entries
// combined = templateEmoji + '\n\n' + aiText
export function updateAIInsights(aiMap) {
  Object.entries(aiMap || {}).forEach(([code, aiText]) => {
    const k = String(code).trim();
    if (_cache[k]) {
      _cache[k] = {
        ..._cache[k],
        ai: aiText,
        combined: (_cache[k].templateEmoji || _cache[k].template) + '\n\n' + aiText,
      };
    } else {
      _cache[k] = { template: aiText, templateEmoji: aiText, ai: null, combined: aiText };
    }
  });
  _notify();
}

// Returns combined string (emoji version — for tooltips, backward-compatible)
export function getInsight(code) {
  if (!code) return null;
  const entry = _cache[String(code)];
  return entry ? entry.combined : null;
}

// Returns { template, templateEmoji, ai, combined } or null
// Order table uses .template (no emoji); tooltips use combined via getInsight()
export function getInsightParts(code) {
  if (!code) return null;
  return _cache[String(code)] || null;
}

export function hasInsights() {
  return Object.keys(_cache).length > 0;
}

export function setInsightLoading(v) {
  _loading = Boolean(v);
  if (v) _error = false;
  _notify();
}

export function setInsightError(v) {
  _error = Boolean(v);
  _loading = false;
  _notify();
}

export function isInsightLoading() {
  return _loading;
}

export function isInsightError() {
  return _error;
}

export function useInsightCacheUpdates() {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump(v => v + 1);
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
  }, []);
}
