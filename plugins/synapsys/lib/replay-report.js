'use strict';

/**
 * synapsys-replay — report renderers (extracted from the CLI script to keep
 * the main entrypoint under the 400-line quality cap).
 *
 * Public surface (re-exported by scripts/synapsys-replay.js):
 *   - renderJson(agg, suggestions, meta)
 *   - renderReport(agg, suggestions, meta)
 */

// Cost model constants (R17): per SKILL.md the judge spends ~500 input + ~5
// output tokens PER FIRED UPS MATCH (i.e. per judged item, not per batched
// API call). Haiku 4.5 pricing: $1.00 / 1M input, $5.00 / 1M output.
const INPUT_PRICE_PER_TOKEN = 1e-6;
const OUTPUT_PRICE_PER_TOKEN = 5e-6;
const INPUT_TOKENS_PER_ITEM = 500;
const OUTPUT_TOKENS_PER_ITEM = 5;
const COST_PER_JUDGED_ITEM =
  INPUT_TOKENS_PER_ITEM * INPUT_PRICE_PER_TOKEN + OUTPUT_TOKENS_PER_ITEM * OUTPUT_PRICE_PER_TOKEN;

/**
 * Render the aggregated report as machine-readable JSON (R9, G6).
 *
 * Spec §Security — `ANTHROPIC_API_KEY` is never included in output; this
 * function only serialises the inputs it is handed (no env access).
 */
/**
 * Order memory names by descending fp_rate (nulls last), with `fires`
 * descending as a tiebreaker and name ascending as a final stable key.
 * README + SKILL.md promise the report is "ranked by false-positive rate."
 */
function compareByName(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareMemories(agg, a, b) {
  const fa = agg[a].fp_rate;
  const fb = agg[b].fp_rate;
  const aNull = fa == null;
  const bNull = fb == null;
  if (aNull !== bNull) return aNull ? 1 : -1;
  if (!aNull && fa !== fb) return fb - fa;
  if (agg[b].fires !== agg[a].fires) return agg[b].fires - agg[a].fires;
  return compareByName(a, b);
}

function sortMemoryNames(agg) {
  return Object.keys(agg).sort((a, b) => compareMemories(agg, a, b));
}

function memoryToJson(name, m) {
  return {
    name,
    fires: m.fires,
    relevant: m.relevant,
    irrelevant: m.irrelevant,
    judge_failed: m.judge_failed,
    fp_rate: m.fp_rate,
    sample_matches: m.sample_matches,
  };
}

function pickString(meta, key) {
  return meta && typeof meta[key] === 'string' ? meta[key] : '';
}

function pickNumber(meta, key) {
  return meta && typeof meta[key] === 'number' ? meta[key] : 0;
}

function buildJsonMeta(meta) {
  return {
    store: pickString(meta, 'store'),
    window: pickString(meta, 'window'),
    events_total: pickNumber(meta, 'events_total'),
    events_ups: pickNumber(meta, 'events_ups'),
    events_ptu: pickNumber(meta, 'events_ptu'),
    judge_calls: pickNumber(meta, 'judgeCalls'),
    items_judged: pickNumber(meta, 'itemsJudged'),
    extrapolated: !!(meta && meta.extrapolated),
  };
}

function renderJson(agg, suggestions, meta) {
  const memories = sortMemoryNames(agg).map((name) => memoryToJson(name, agg[name]));
  const payload = {
    memories,
    suggestions: Array.isArray(suggestions) ? suggestions : [],
    ...buildJsonMeta(meta),
  };
  return JSON.stringify(payload, null, 2);
}

function renderHeaderLine(m) {
  return (
    `store=${m.store || ''} window=${m.window || ''} events=${m.events_total || 0} ` +
    `UPS=${m.events_ups || 0} PTU=${m.events_ptu || 0}`
  );
}

function renderTableHeader() {
  return (
    'Memory'.padEnd(30) +
    'Fires'.padStart(7) +
    'Relevant'.padStart(10) +
    'FP%'.padStart(8) +
    '  Sample matches'
  );
}

function formatRelevant(value) {
  return value === null || value === undefined ? '—' : String(value);
}

function formatFpPct(value) {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

function renderMemoryRow(name, e) {
  const samples = (e.sample_matches || []).slice(0, 3).join(', ');
  return (
    name.padEnd(30) +
    String(e.fires).padStart(7) +
    formatRelevant(e.relevant).padStart(10) +
    formatFpPct(e.fp_rate).padStart(8) +
    '  ' +
    samples
  );
}

function renderSuggestionsBlock(suggestions) {
  const sugs = Array.isArray(suggestions) ? suggestions : [];
  if (sugs.length === 0) return ['  (none)'];
  return sugs.map(
    (s) => `  - ${s.memory}: tighten short arms [${(s.candidates || []).join(', ')}]`
  );
}

function renderCostFooter(itemsJudged, judgeCalls) {
  const cost = COST_PER_JUDGED_ITEM * itemsJudged;
  return [
    '',
    `est. cost ≈ $${cost.toFixed(4)} (${itemsJudged} items judged across ${judgeCalls} batched API calls)`,
  ];
}

/**
 * Render the human-readable report (R11). Includes header, per-memory table
 * rows, Suggestions section, and cost footer when `meta.judgeCalls > 0` (R17).
 */
function renderReport(agg, suggestions, meta) {
  const m = meta || {};
  const lines = [renderHeaderLine(m)];
  if (m.extrapolated) {
    // SKILL.md: report is annotated with `extrapolated` when `--max-judges`
    // causes sampling. Surface a header note so users know fp_rate numbers
    // are based on a sample, not the full fired-matches population.
    lines.push('note: fp_rate values are extrapolated from a sample (--max-judges cap reached).');
  }
  lines.push('', renderTableHeader());
  for (const name of sortMemoryNames(agg)) {
    lines.push(renderMemoryRow(name, agg[name]));
  }
  lines.push('', 'Suggestions:');
  lines.push(...renderSuggestionsBlock(suggestions));
  if (m.judgeCalls && m.judgeCalls > 0) {
    // Prefer explicit `itemsJudged` from the pipeline; fall back to judgeCalls
    // for callers that haven't been updated (back-compat). The cost formula
    // is per-judged-item, NOT per batched API call (see SKILL.md).
    const itemsJudged =
      typeof m.itemsJudged === 'number' && m.itemsJudged >= 0 ? m.itemsJudged : m.judgeCalls;
    lines.push(...renderCostFooter(itemsJudged, m.judgeCalls));
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  renderJson,
  renderReport,
};
