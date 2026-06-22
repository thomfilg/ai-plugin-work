/**
 * Unit tests for the reports step module.
 *
 * Run: node --test scripts/workflows/work/steps/__tests__/reports.test.js
 */

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { STEPS } = require('../../step-registry');

function makeAdd() {
  const entries = [];
  const add = (step, action, command, reason, extra) => {
    entries.push({ step, action, command, reason, ...(extra || {}) });
  };
  return { add, entries };
}

function makeCtx(overrides = {}) {
  return {
    STEPS,
    ticket: 'GH-395',
    t: 'GH-395',
    tasksDir: '/tmp/tasks/GH-395',
    ...overrides,
  };
}

describe('reports step', () => {
  let reportsStep;
  before(() => {
    reportsStep = require(path.join(__dirname, '..', 'reports.js'));
  });

  it('exports a function', () => {
    assert.equal(typeof reportsStep, 'function');
  });

  describe('cost-report.md emission', () => {
    let tmpBase;
    let prevTasksBase;
    let appendUsage;

    beforeEach(() => {
      tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-cost-'));
      prevTasksBase = process.env.TASKS_BASE;
      process.env.TASKS_BASE = tmpBase;
      // Re-require work-actions fresh so it binds the temp TASKS_BASE.
      delete require.cache[require.resolve('../../lib/work-actions')];
      ({ appendUsage } = require('../../lib/work-actions'));
    });

    afterEach(() => {
      if (prevTasksBase === undefined) delete process.env.TASKS_BASE;
      else process.env.TASKS_BASE = prevTasksBase;
      fs.rmSync(tmpBase, { recursive: true, force: true });
      delete require.cache[require.resolve('../../lib/work-actions')];
    });

    it('queues a cost-report.md write with grand-total, per-step and per-agent content', () => {
      const ticket = 'GH-700';
      const tasksDir = path.join(tmpBase, ticket);
      fs.mkdirSync(tasksDir, { recursive: true });

      appendUsage(ticket, {
        step: 'implement',
        agentType: 'developer-nodejs-tdd',
        totalTokens: 120000,
        toolUses: 40,
        durationMs: 60000,
      });
      appendUsage(ticket, {
        step: 'check',
        agentType: 'code-checker',
        totalTokens: 30000,
        toolUses: 10,
        durationMs: 15000,
      });

      const { add, entries } = makeAdd();
      reportsStep(add, {}, makeCtx({ ticket, t: ticket, tasksDir }));

      const entry = entries.find((e) => {
        const blob = `${e.command || ''} ${e.agentPrompt || ''} ${e.content || ''}`;
        return blob.includes('cost-report.md');
      });
      assert.ok(entry, `expected a queued action referencing cost-report.md, got: ${JSON.stringify(entries)}`);
      assert.equal(entry.step, STEPS.reports);
      assert.equal(entry.action, 'RUN');

      const payload = `${entry.command || ''} ${entry.agentPrompt || ''} ${entry.content || ''}`;
      // Grand-total header (GH-311 R8)
      assert.ok(payload.includes('Grand total'), `expected grand-total header, got: ${payload}`);
      // Per-step + per-agent tables (R4)
      assert.ok(payload.includes('Per-step'), `expected per-step table, got: ${payload}`);
      assert.ok(payload.includes('Per-agent'), `expected per-agent table, got: ${payload}`);
      // Per-agent rows carry the dispatched agent types
      assert.ok(payload.includes('developer-nodejs-tdd'), `expected developer-nodejs-tdd agent row, got: ${payload}`);
      assert.ok(payload.includes('code-checker'), `expected code-checker agent row, got: ${payload}`);
      // Per-step rows carry the steps + analyzeActions duration column (R5)
      assert.ok(payload.includes('implement'), `expected implement step row, got: ${payload}`);
      assert.ok(payload.includes('Duration'), `expected a duration column, got: ${payload}`);
    });

    it('no longer queues the trivial ls *.check.md command', () => {
      const ticket = 'GH-701';
      const tasksDir = path.join(tmpBase, ticket);
      fs.mkdirSync(tasksDir, { recursive: true });
      appendUsage(ticket, {
        step: 'implement',
        agentType: 'developer-nodejs-tdd',
        totalTokens: 1000,
        toolUses: 1,
        durationMs: 1000,
      });

      const { add, entries } = makeAdd();
      reportsStep(add, {}, makeCtx({ ticket, t: ticket, tasksDir }));

      const lsOnly = entries.find((e) => {
        const p = e.agentPrompt || '';
        return p.includes('*.check.md') && !p.includes('cost-report.md');
      });
      assert.equal(lsOnly, undefined, 'reports step should no longer queue the bare ls *.check.md command');
    });

    it('honors WORK_PRICING set as an env var (parsed table → non-zero USD)', () => {
      // GH-311 regression: reports.js previously read WORK_PRICING through
      // get-config's raw `process.env[key]`, so an env-var override arrived as
      // a JSON *string*, Object.keys() yielded character indices, and every
      // cost figure rendered $0.00. Reading the parsed table from config.js
      // fixes it. 2,000,000 tokens * $15/1M = $30.00.
      const ticket = 'GH-703';
      const tasksDir = path.join(tmpBase, ticket);
      fs.mkdirSync(tasksDir, { recursive: true });

      appendUsage(ticket, {
        step: 'implement',
        agentType: 'developer-nodejs-tdd',
        totalTokens: 2000000,
        toolUses: 10,
        durationMs: 60000,
      });

      const prevPricing = process.env.WORK_PRICING;
      process.env.WORK_PRICING = JSON.stringify({ 'env-model': { usdPer1MTokens: 15 } });
      // config.js evaluates WORK_PRICING in an IIFE at require time, and
      // reports.js binds it at require time — bust both so they re-read the env.
      delete require.cache[require.resolve('../../../lib/config')];
      delete require.cache[require.resolve('../reports.js')];
      try {
        const reportsFresh = require('../reports.js');
        const { add, entries } = makeAdd();
        reportsFresh(add, {}, makeCtx({ ticket, t: ticket, tasksDir }));

        const entry = entries.find((e) => {
          const blob = `${e.command || ''} ${e.agentPrompt || ''} ${e.content || ''}`;
          return blob.includes('cost-report.md');
        });
        assert.ok(entry, `expected a queued cost-report.md write, got: ${JSON.stringify(entries)}`);
        const payload = `${entry.command || ''} ${entry.agentPrompt || ''} ${entry.content || ''}`;
        assert.ok(
          payload.includes('$30.00'),
          `expected non-zero USD ($30.00) from env-var WORK_PRICING, got: ${payload}`
        );
      } finally {
        if (prevPricing === undefined) delete process.env.WORK_PRICING;
        else process.env.WORK_PRICING = prevPricing;
        delete require.cache[require.resolve('../../../lib/config')];
        delete require.cache[require.resolve('../reports.js')];
      }
    });

    it('degrades gracefully: still emits cost-report.md when there are no usage rows', () => {
      const ticket = 'GH-702';
      const tasksDir = path.join(tmpBase, ticket);
      fs.mkdirSync(tasksDir, { recursive: true });

      const { add, entries } = makeAdd();
      assert.doesNotThrow(() => {
        reportsStep(add, {}, makeCtx({ ticket, t: ticket, tasksDir }));
      });

      const entry = entries.find((e) => {
        const blob = `${e.command || ''} ${e.agentPrompt || ''} ${e.content || ''}`;
        return blob.includes('cost-report.md');
      });
      assert.ok(entry, `expected a cost-report.md write even with no usage rows, got: ${JSON.stringify(entries)}`);
      const payload = `${entry.command || ''} ${entry.agentPrompt || ''} ${entry.content || ''}`;
      assert.ok(payload.includes('Grand total'), `expected grand-total header in zero-usage report, got: ${payload}`);
    });
  });
});
