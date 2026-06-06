'use strict';

// Skip delays in tests
process.env.FOLLOW_UP2_NO_DELAY = '1';

/**
 * Task 6.1 (RED): report.js must render an `infra-stuck` diagnostic bundle
 * when state.failureCategory === 'infra-stuck'.
 *
 * The bundle includes a "## Infra-stuck after 3 retries" header, and a
 * formatted line per state.infraRetry.attempts[i] containing attemptNumber,
 * timestamp, runId, signals, and retryMethod. RunIds appear as
 * https://github.com/<owner>/<repo>/actions/runs/<runId> URLs.
 *
 * These tests fail until the branch and the rendering exist.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const handlers = Object.create(null);
function registerStep(name, fn) {
  handlers[name] = fn;
}
require('../lib/steps/report')(registerStep);
const report = handlers['report'];

function makeCtx() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-report-infra-stuck-'));
  return { tmp, ctx: { tasksDir: tmp } };
}

function makeInfraStuckState(overrides) {
  return {
    ticketId: 'GH-508',
    prNumber: 999,
    currentStep: 'report',
    attempt: 3,
    failureCategory: 'infra-stuck',
    repoOwner: 'thomfilg',
    repoName: 'claude-plugin-work',
    infraRetry: {
      count: 3,
      attempts: [
        {
          attemptNumber: 1,
          timestamp: '2026-06-03T10:00:00.000Z',
          runId: '111111',
          signals: ['signal1', 'signal2'],
          retryMethod: 'rerun-failed',
        },
        {
          attemptNumber: 2,
          timestamp: '2026-06-03T10:05:00.000Z',
          runId: '222222',
          signals: ['signal3'],
          retryMethod: 'empty-commit',
        },
        {
          attemptNumber: 3,
          timestamp: '2026-06-03T10:10:00.000Z',
          runId: '333333',
          signals: ['signal4'],
          retryMethod: 'rerun-failed',
        },
      ],
    },
    lastMonitorResult: {
      exitCode: 1,
      output: 'CI: FAILED\nReviews: CLEAR',
    },
    ...overrides,
  };
}

describe('report step: infra-stuck diagnostic bundle (Task 6.1)', () => {
  it('renders the "Infra-stuck after 3 retries" header when failureCategory=infra-stuck', () => {
    const { tmp, ctx } = makeCtx();
    try {
      const state = makeInfraStuckState();
      const result = report(state, ctx);
      assert.ok(result, 'report must return an instruction for infra-stuck');
      const text = JSON.stringify(result);
      assert.match(text, /Infra-stuck after 3 retries/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('includes every attempt timestamp, runId, and signals list', () => {
    const { tmp, ctx } = makeCtx();
    try {
      const state = makeInfraStuckState();
      const result = report(state, ctx);
      const text = JSON.stringify(result);
      for (const a of state.infraRetry.attempts) {
        assert.match(
          text,
          new RegExp(String(a.runId)),
          `expected runId ${a.runId} in report output`
        );
        assert.match(
          text,
          new RegExp(a.timestamp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          `expected timestamp ${a.timestamp} in report output`
        );
        for (const sig of a.signals) {
          assert.match(text, new RegExp(sig), `expected signal ${sig} in report output`);
        }
        assert.match(
          text,
          new RegExp(`attemptNumber.*${a.attemptNumber}|#${a.attemptNumber}|attempt ${a.attemptNumber}`),
          `expected attemptNumber ${a.attemptNumber} reference in report output`
        );
        assert.match(
          text,
          new RegExp(a.retryMethod),
          `expected retryMethod ${a.retryMethod} in report output`
        );
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('renders github.com/.../actions/runs/<runId> URLs for each attempt', () => {
    const { tmp, ctx } = makeCtx();
    try {
      const state = makeInfraStuckState();
      const result = report(state, ctx);
      const text = JSON.stringify(result);
      for (const a of state.infraRetry.attempts) {
        const re = new RegExp(`https:\\/\\/github\\.com\\/[^\\s"]+\\/actions\\/runs\\/${a.runId}`);
        assert.match(text, re, `expected GitHub Actions run URL for runId ${a.runId}`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does NOT mark state.status=complete when surfacing infra-stuck', () => {
    const { tmp, ctx } = makeCtx();
    try {
      const state = makeInfraStuckState();
      report(state, ctx);
      assert.notEqual(
        state.status,
        'complete',
        'infra-stuck must require manual intervention, not auto-complete'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
