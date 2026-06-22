/**
 * Tests for cost-report.js (GH-311 Task 4)
 *
 * Pure, zero-side-effect rollup + pricing math + markdown renderer.
 * Covers rollupUsage (4.1), estimateCostUsd (4.2), renderCostReport (4.3).
 * Uses node:test + node:assert/strict.
 * Run: node --test workflows/work/__tests__/cost-report.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Lazy-load so the test file collects (no load-time crash) before the source
// module exists; tests fail on behavior/assertion instead.
function loadModule() {
  try {
    return require(path.join(__dirname, '..', 'lib', 'cost-report'));
  } catch {
    return {};
  }
}
const { rollupUsage, estimateCostUsd, renderCostReport } = loadModule();

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Mirrors the kind:'usage' row shape written by work-actions.appendUsage().
function usageRow(step, agentType, totalTokens, toolUses, durationMs) {
  return {
    kind: 'usage',
    timestamp: '2026-06-22T00:00:00.000Z',
    step,
    agentType,
    totalTokens,
    toolUses,
    durationMs,
  };
}

const PRICING = { 'claude-opus-4': { usdPer1MTokens: 15 } };

// ─── 4.1 rollupUsage ────────────────────────────────────────────────────────

describe('rollupUsage', () => {
  it('aggregates two steps and two agent types correctly', () => {
    const records = [
      usageRow('implement', 'developer-nodejs-tdd', 1000, 5, 2000),
      usageRow('implement', 'code-reviewer', 500, 2, 1000),
      usageRow('check', 'developer-nodejs-tdd', 250, 1, 500),
    ];

    const result = rollupUsage(records);

    // byStep
    assert.deepEqual(result.byStep.implement, {
      tokens: 1500,
      toolUses: 7,
      durationMs: 3000,
    });
    assert.deepEqual(result.byStep.check, {
      tokens: 250,
      toolUses: 1,
      durationMs: 500,
    });

    // byAgent
    assert.deepEqual(result.byAgent['developer-nodejs-tdd'], {
      tokens: 1250,
      toolUses: 6,
    });
    assert.deepEqual(result.byAgent['code-reviewer'], {
      tokens: 500,
      toolUses: 2,
    });
  });

  it('totals equal the sum across all records', () => {
    const records = [
      usageRow('implement', 'a', 1000, 5, 2000),
      usageRow('implement', 'b', 500, 2, 1000),
      usageRow('check', 'a', 250, 1, 500),
    ];

    const { totals } = rollupUsage(records);

    assert.equal(totals.tokens, 1750);
    assert.equal(totals.toolUses, 8);
    assert.equal(totals.durationMs, 3500);
  });

  it('tolerates an empty array with empty maps and zero totals', () => {
    const result = rollupUsage([]);

    assert.deepEqual(result.byStep, {});
    assert.deepEqual(result.byAgent, {});
    assert.deepEqual(result.totals, { tokens: 0, toolUses: 0, durationMs: 0 });
  });
});

// ─── 4.2 estimateCostUsd ──────────────────────────────────────────────────────

describe('estimateCostUsd', () => {
  it('scales USD per 1M tokens for a known model', () => {
    // 2,000,000 tokens @ $15/1M = $30
    assert.equal(estimateCostUsd(2_000_000, 'claude-opus-4', PRICING), 30);
    // 500,000 tokens @ $15/1M = $7.5
    assert.equal(estimateCostUsd(500_000, 'claude-opus-4', PRICING), 7.5);
  });

  it('changes the figure when the configured rate changes', () => {
    const cheap = estimateCostUsd(1_000_000, 'm', { m: { usdPer1MTokens: 3 } });
    const pricey = estimateCostUsd(1_000_000, 'm', { m: { usdPer1MTokens: 30 } });

    assert.equal(cheap, 3);
    assert.equal(pricey, 30);
    assert.notEqual(cheap, pricey);
  });

  it('returns 0 for an unknown model without throwing', () => {
    assert.doesNotThrow(() => estimateCostUsd(1_000_000, 'nope', PRICING));
    assert.equal(estimateCostUsd(1_000_000, 'nope', PRICING), 0);
    assert.equal(estimateCostUsd(1_000_000, 'opus', undefined), 0);
  });
});

// ─── 4.3 renderCostReport ─────────────────────────────────────────────────────

describe('renderCostReport', () => {
  const usageRecords = [
    usageRow('implement', 'developer-nodejs-tdd', 1_000_000, 5, 2000),
    usageRow('implement', 'code-reviewer', 500_000, 2, 1000),
    usageRow('check', 'developer-nodejs-tdd', 250_000, 1, 500),
  ];
  const stepDurations = { implement: '1m 30s', check: '45s' };

  function render() {
    return renderCostReport({
      ticket: 'GH-311',
      usageRecords,
      stepDurations,
      model: 'claude-opus-4',
      pricingTable: PRICING,
    });
  }

  it('emits a grand-total header with totals and an estimated USD figure', () => {
    const md = render();

    assert.match(md, /GH-311/);
    // total tokens = 1,750,000
    assert.match(md, /1[,_]?750[,_]?000|1750000/);
    // total tool_uses = 8
    assert.match(md, /\b8\b/);
    // estimated USD: 1.75M @ $15/1M = $26.25
    assert.match(md, /26\.25/);
  });

  it('labels the cost figure "estimated" (never billed accuracy)', () => {
    assert.match(render(), /estimated/i);
  });

  it('renders a per-step table with each step duration', () => {
    const md = render();

    assert.match(md, /implement/);
    assert.match(md, /check/);
    // durations from stepDurations are surfaced
    assert.match(md, /1m 30s/);
    assert.match(md, /45s/);
  });

  it('renders a per-agent table with each agent type', () => {
    const md = render();

    assert.match(md, /developer-nodejs-tdd/);
    assert.match(md, /code-reviewer/);
  });

  it('highlights the most expensive step/agent as a bottleneck', () => {
    const md = render();

    // implement is the most expensive step (1.5M tokens)
    assert.match(md, /bottleneck/i);
    assert.match(md, /implement/);
  });

  it('renders zero-row tables for empty usage without throwing', () => {
    let md;
    assert.doesNotThrow(() => {
      md = renderCostReport({
        ticket: 'GH-311',
        usageRecords: [],
        stepDurations: {},
        model: 'claude-opus-4',
        pricingTable: PRICING,
      });
    });
    assert.equal(typeof md, 'string');
    assert.match(md, /estimated/i);
  });
});
