'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

// ─── Mock gh-exec at require level ─────────────────────────────────────────
// Replace the gh-exec module with a programmable mock BEFORE any
// follow-up-pr.js code loads. Each test sets mockGhResponses to control
// what gh commands return.

let mockGhResponses = [];
let mockGhCallLog = [];

const ghExecPath = require.resolve('../../work/scripts/gh-exec.js');
const mockGhExec = {
  ghExec(ghArgs) {
    const args = typeof ghArgs === 'string' ? ghArgs.split(/\s+/) : ghArgs;
    const cmd = args.join(' ');
    mockGhCallLog.push(cmd);

    for (const mock of mockGhResponses) {
      if (mock.match(cmd)) {
        if (mock.error) throw new Error(mock.error);
        return mock.response;
      }
    }
    // Default: return empty object
    return {};
  },
};

// Inject mock before any require of follow-up-pr.js
require.cache[ghExecPath] = {
  id: ghExecPath,
  filename: ghExecPath,
  loaded: true,
  exports: mockGhExec,
};

// Also mock execSync for git commands
const childProcess = require('child_process');
const originalExecSync = childProcess.execSync;
const originalExecFileSync = childProcess.execFileSync;

// ─── PR Info & Check Fixtures ──────────────────────────────────────────────

function prInfoFixture(overrides = {}) {
  return {
    number: 42,
    title: 'feat: test feature',
    headRefName: 'feat/test',
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    url: 'https://github.com/test/repo/pull/42',
    ...overrides,
  };
}

function checksFixture(checks) {
  return checks.map((c) => ({
    name: c.name,
    bucket: c.bucket || 'pass',
    state:
      c.state || (c.bucket === 'pass' ? 'SUCCESS' : c.bucket === 'pending' ? 'PENDING' : 'FAILURE'),
    link: null,
    workflow: { name: c.name },
  }));
}

function reviewsFixture(reviews = []) {
  return { reviews };
}

// ─── Build mock response set for a CI state ────────────────────────────────

function buildMockResponses(opts = {}) {
  const {
    checks = [],
    reviews = [],
    pendingBots = [],
    mergeable = 'MERGEABLE',
    mergeStateStatus = 'BLOCKED',
    statusCheckRollup = [],
  } = opts;

  const prInfo = prInfoFixture({ mergeable, mergeStateStatus });
  const prFields = `pr view 42 --json number,title,headRefName,state,mergeable,mergeStateStatus,url`;

  return [
    { match: (cmd) => cmd.includes('pr view') && cmd.includes('number,title'), response: prInfo },
    {
      match: (cmd) => cmd.includes('pr checks') && cmd.includes('--json'),
      response: checksFixture(checks),
    },
    { match: (cmd) => cmd.includes('pr checks') && cmd.includes('--required'), response: [] },
    {
      match: (cmd) => cmd.includes('pr view') && cmd.includes('statusCheckRollup'),
      response: {
        statusCheckRollup: statusCheckRollup.length
          ? statusCheckRollup
          : checks.map((c) => ({
              name: c.name,
              status: c.state || 'COMPLETED',
              conclusion:
                c.bucket === 'pass' ? 'SUCCESS' : c.bucket === 'pending' ? null : 'FAILURE',
            })),
      },
    },
    {
      match: (cmd) => cmd.includes('pr view') && cmd.includes('reviews'),
      response: { reviews, statusCheckRollup: [] },
    },
    { match: (cmd) => cmd.includes('repo view'), response: { nameWithOwner: 'test/repo' } },
    {
      match: (cmd) => cmd.includes('requested_reviewers'),
      response: { users: pendingBots.map((b) => ({ login: b })) },
    },
    {
      match: (cmd) => cmd.includes('pr view') && cmd.includes('commits'),
      response: { commits: [{ oid: 'abc123' }] },
    },
  ];
}

// ─── Import triage step handler ────────────────────────────────────────────

const triageHandlers = Object.create(null);
require('../lib/steps/triage')(function (name, fn) {
  triageHandlers[name] = fn;
});
const triage = triageHandlers['triage'];

// ─── Import monitor step handler ───────────────────────────────────────────

const monitorHandlers = Object.create(null);
require('../lib/steps/monitor')(function (name, fn) {
  monitorHandlers[name] = fn;
});
const monitor = monitorHandlers['monitor'];

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('CI progression with mocked gh', () => {
  let tmpDir;
  let ctx;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fu2-ci-'));
    fs.mkdirSync(path.join(tmpDir, 'GH-123'), { recursive: true });
    ctx = {
      tasksDir: path.join(tmpDir, 'GH-123'),
      worktreeDir: tmpDir,
      TASKS_BASE: tmpDir,
      workScriptsDir: path.resolve(__dirname, '..', '..', 'work', 'scripts'),
    };
    mockGhCallLog = [];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mockGhResponses = [];
  });

  describe('Scenario 1: 3 pipelines → all green', () => {
    it('triage routes PENDING to monitor', () => {
      const state = {
        ticketId: 'GH-123',
        currentStep: 'triage',
        lastMonitorResult: {
          exitCode: 1,
          output:
            'CI: PENDING (3 running, 0 passed)\n  ⏳ shard 1 — running\n  ⏳ shard 2 — running\n  ⏳ shard 3 — running\nReviews: CLEAR',
        },
        failureCategory: null,
      };
      triage(state, {});
      assert.equal(state.currentStep, 'monitor');
    });

    it('triage routes PASSED to report', () => {
      const state = {
        ticketId: 'GH-123',
        currentStep: 'triage',
        lastMonitorResult: {
          exitCode: 1,
          output:
            'CI: PASSED (all 3 checks)\n  ✓ shard 1 — passed\n  ✓ shard 2 — passed\n  ✓ shard 3 — passed\nReviews: CLEAR',
        },
        failureCategory: null,
      };
      triage(state, {});
      assert.equal(state.currentStep, 'report');
    });

    it('progressive: PENDING → PENDING → PENDING → PASSED', () => {
      const outputs = [
        'CI: PENDING (3 running, 0 passed)\nReviews: CLEAR',
        'CI: PENDING (2 running, 1 passed)\nReviews: CLEAR',
        'CI: PENDING (1 running, 2 passed)\nReviews: CLEAR',
        'CI: PASSED (all 3 checks)\nReviews: CLEAR',
      ];

      for (let i = 0; i < outputs.length; i++) {
        const state = {
          ticketId: 'GH-123',
          currentStep: 'triage',
          lastMonitorResult: { exitCode: 1, output: outputs[i] },
          failureCategory: null,
        };
        triage(state, {});
        if (i < 3) {
          assert.equal(state.currentStep, 'monitor', `step ${i}: should loop back`);
        } else {
          assert.equal(state.currentStep, 'report', `step ${i}: should complete`);
        }
      }
    });
  });

  describe('Scenario 2: 3 pipelines → 2 green + 1 neutral', () => {
    it('CANCELLED without merge block goes to report', () => {
      const state = {
        ticketId: 'GH-123',
        currentStep: 'triage',
        lastMonitorResult: {
          exitCode: 1,
          output:
            'CI: CANCELLED (1 cancelled, 2 passed)\n  ⊘ Compare Runtime — cancelled\n  ✓ shard 1 — passed\n  ✓ shard 2 — passed\nReviews: CLEAR',
        },
        failureCategory: null,
      };
      triage(state, {});
      assert.equal(state.currentStep, 'report');
      assert.equal(state.failureCategory, null);
    });

    it('progressive: PENDING × 3 → CANCELLED (non-blocking)', () => {
      const outputs = [
        'CI: PENDING (3 running)\nReviews: CLEAR',
        'CI: PENDING (2 running, 1 passed)\nReviews: CLEAR',
        'CI: PENDING (1 running, 2 passed)\nReviews: CLEAR',
        'CI: CANCELLED (1 cancelled, 2 passed)\nReviews: CLEAR',
      ];

      const expected = ['monitor', 'monitor', 'monitor', 'report'];
      for (let i = 0; i < outputs.length; i++) {
        const state = {
          ticketId: 'GH-123',
          currentStep: 'triage',
          lastMonitorResult: { exitCode: 1, output: outputs[i] },
          failureCategory: null,
        };
        triage(state, {});
        assert.equal(state.currentStep, expected[i], `step ${i}`);
      }
    });
  });

  describe('Scenario 3: 3 pipelines → 2 green + 1 neutral + merge conflict', () => {
    it('conflict detected after CI finishes', () => {
      const state = {
        ticketId: 'GH-123',
        currentStep: 'triage',
        lastMonitorResult: {
          exitCode: 1,
          output:
            'CI: CANCELLED (1 cancelled, 2 passed)\nReviews: CLEAR\nThis branch cannot be merged — merge conflict',
        },
        failureCategory: null,
      };
      triage(state, {});
      assert.equal(state.currentStep, 'fix-ci');
      assert.equal(state.failureCategory, 'conflict');
    });

    it('progressive: PENDING × 3 → CANCELLED + conflict', () => {
      const outputs = [
        'CI: PENDING (3 running)\nReviews: CLEAR',
        'CI: PENDING (2 running, 1 passed)\nReviews: CLEAR',
        'CI: PENDING (1 running, 2 passed)\nReviews: CLEAR',
        'CI: CANCELLED (1 cancelled, 2 passed)\nReviews: CLEAR\nmerge conflict detected',
      ];

      const expected = [
        { step: 'monitor', cat: null },
        { step: 'monitor', cat: null },
        { step: 'monitor', cat: null },
        { step: 'fix-ci', cat: 'conflict' },
      ];

      for (let i = 0; i < outputs.length; i++) {
        const state = {
          ticketId: 'GH-123',
          currentStep: 'triage',
          lastMonitorResult: { exitCode: 1, output: outputs[i] },
          failureCategory: null,
        };
        triage(state, {});
        assert.equal(state.currentStep, expected[i].step, `step ${i}: currentStep`);
        assert.equal(state.failureCategory, expected[i].cat, `step ${i}: failureCategory`);
      }
    });
  });
});
