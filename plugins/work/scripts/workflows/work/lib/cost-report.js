/**
 * cost-report.js (GH-311 Task 4)
 *
 * Pure, zero-side-effect helpers that turn `kind:'usage'` rows (see
 * work-actions.appendUsage) into a cost/duration rollup, an estimated USD
 * figure, and a markdown report.
 *
 * CommonJS, zero runtime dependencies. Pricing math and markdown are
 * hand-rolled (no SDK / external lib). The USD figure is always labelled
 * "estimated" — it never claims billed accuracy.
 */

/**
 * Aggregate usage rows by step and by agent, plus grand totals.
 *
 * @param {Array<{step: string, agentType: string, totalTokens: number,
 *   toolUses: number, durationMs: number}>} usageRecords
 * @returns {{
 *   byStep: Object<string, {tokens: number, toolUses: number, durationMs: number}>,
 *   byAgent: Object<string, {tokens: number, toolUses: number}>,
 *   totals: {tokens: number, toolUses: number, durationMs: number}
 * }} Empty maps and zero totals for an empty array.
 */
function rollupUsage(usageRecords) {
  const byStep = {};
  const byAgent = {};
  const totals = { tokens: 0, toolUses: 0, durationMs: 0 };

  for (const r of usageRecords || []) {
    const tokens = num(r.totalTokens);
    const toolUses = num(r.toolUses);
    const durationMs = num(r.durationMs);

    const step = (byStep[r.step] ||= { tokens: 0, toolUses: 0, durationMs: 0 });
    accumulate(step, tokens, toolUses, durationMs);

    const agent = (byAgent[r.agentType] ||= { tokens: 0, toolUses: 0 });
    accumulate(agent, tokens, toolUses);

    totals.tokens += tokens;
    totals.toolUses += toolUses;
    totals.durationMs += durationMs;
  }

  return { byStep, byAgent, totals };
}

/**
 * Add a record's figures into an existing bucket. `durationMs` is optional so
 * the same accumulator serves both the per-step (duration-tracking) and
 * per-agent (token/tool-use only) passes without altering either bucket shape.
 */
function accumulate(bucket, tokens, toolUses, durationMs) {
  bucket.tokens += tokens;
  bucket.toolUses += toolUses;
  if (durationMs !== undefined) bucket.durationMs += durationMs;
}

/**
 * Estimate USD cost as `totalTokens / 1_000_000 * usdPer1MTokens`.
 *
 * The rate unit is USD per 1,000,000 tokens. Returns `0` for an unknown model
 * (or a missing/invalid pricing table) and never throws.
 *
 * @param {number} totalTokens
 * @param {string} model
 * @param {Object<string, {usdPer1MTokens: number}>} pricingTable
 * @returns {number} Estimated USD; `0` when the model is not priced.
 */
function estimateCostUsd(totalTokens, model, pricingTable) {
  const entry = pricingTable && pricingTable[model];
  if (!entry || typeof entry.usdPer1MTokens !== 'number') return 0;
  return (num(totalTokens) / 1_000_000) * entry.usdPer1MTokens;
}

/**
 * Render a markdown cost report: grand-total header, per-step table (with
 * wall-clock durations from `stepDurations`), per-agent table, and a
 * bottleneck highlight for the most expensive step/agent. Empty usage renders
 * zero-row tables without throwing.
 *
 * @param {{
 *   ticket: string,
 *   usageRecords: Array,
 *   stepDurations: Object<string, string>,
 *   model: string,
 *   pricingTable: Object
 * }} params
 * @returns {string} Markdown.
 */
function renderCostReport({ ticket, usageRecords, stepDurations, model, pricingTable }) {
  const durations = stepDurations || {};
  const { byStep, byAgent, totals } = rollupUsage(usageRecords);
  const totalUsd = estimateCostUsd(totals.tokens, model, pricingTable);

  const lines = [];
  lines.push(`# Cost Report — ${ticket}`);
  lines.push('');
  lines.push('## Grand total (estimated)');
  lines.push('');
  lines.push(
    markdownTable(
      ['Total tokens', 'Total tool_uses', 'Total duration', 'Estimated USD'],
      [
        [
          fmtNum(totals.tokens),
          fmtNum(totals.toolUses),
          fmtMs(totals.durationMs),
          `$${fmtUsd(totalUsd)} (estimated)`,
        ],
      ]
    )
  );

  lines.push('');
  lines.push('## Per-step breakdown');
  lines.push('');
  lines.push(
    markdownTable(
      ['Step', 'Tokens', 'Tool uses', 'Duration', 'Estimated USD'],
      Object.keys(byStep).map((step) => [
        step,
        fmtNum(byStep[step].tokens),
        fmtNum(byStep[step].toolUses),
        durations[step] || fmtMs(byStep[step].durationMs),
        `$${fmtUsd(estimateCostUsd(byStep[step].tokens, model, pricingTable))}`,
      ])
    )
  );

  lines.push('');
  lines.push('## Per-agent breakdown');
  lines.push('');
  lines.push(
    markdownTable(
      ['Agent', 'Tokens', 'Tool uses', 'Estimated USD'],
      Object.keys(byAgent).map((agent) => [
        agent,
        fmtNum(byAgent[agent].tokens),
        fmtNum(byAgent[agent].toolUses),
        `$${fmtUsd(estimateCostUsd(byAgent[agent].tokens, model, pricingTable))}`,
      ])
    )
  );

  const topStep = mostExpensive(byStep);
  const topAgent = mostExpensive(byAgent);
  lines.push('');
  lines.push('## Bottleneck');
  lines.push('');
  lines.push(`- Most expensive step: ${topStep ? `\`${topStep}\`` : 'n/a'}`);
  lines.push(`- Most expensive agent: ${topAgent ? `\`${topAgent}\`` : 'n/a'}`);
  lines.push('');

  return lines.join('\n');
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Coerce to a finite number; NaN/undefined → 0. */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Group label (step/agent) with the highest token total, or null if empty. */
function mostExpensive(buckets) {
  let top = null;
  let max = -Infinity;
  for (const key of Object.keys(buckets)) {
    if (buckets[key].tokens > max) {
      max = buckets[key].tokens;
      top = key;
    }
  }
  return top;
}

function fmtNum(n) {
  return num(n).toLocaleString('en-US');
}

function fmtUsd(n) {
  return num(n).toFixed(2);
}

function fmtMs(ms) {
  const totalSec = Math.round(num(ms) / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Render a pipe-delimited markdown table; zero rows still emits the header. */
function markdownTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

module.exports = {
  rollupUsage,
  estimateCostUsd,
  renderCostReport,
};
