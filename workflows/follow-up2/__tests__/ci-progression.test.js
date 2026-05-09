'use strict';

// Skip delays in tests
process.env.FOLLOW_UP2_NO_DELAY = '1';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Mock ghExec BEFORE any follow-up-pr.js loads ──────────────────────────

let ghMockResponses = {};

const ghExecPath = require.resolve('../../work/scripts/gh-exec.js');
require.cache[ghExecPath] = {
  id: ghExecPath,
  filename: ghExecPath,
  loaded: true,
  exports: {
    ghExec(ghArgs, opts = {}) {
      const args = typeof ghArgs === 'string' ? ghArgs.split(/\s+/) : ghArgs;
      const cmd = args.join(' ');

      for (const [pattern, response] of Object.entries(ghMockResponses)) {
        if (cmd.includes(pattern)) {
          if (response instanceof Error) throw response;
          return typeof response === 'function' ? response(cmd) : response;
        }
      }
      return opts.json === false ? '' : {};
    },
  },
};

// Mock git commands used by follow-up-pr.js
const childProcess = require('child_process');
const _origExecSync = childProcess.execSync;
childProcess.execSync = function (cmd, opts) {
  if (typeof cmd === 'string' && cmd.includes('git rev-parse HEAD')) return 'abc1234567890\n';
  if (typeof cmd === 'string' && cmd.includes('git diff --name-only')) return '';
  if (typeof cmd === 'string' && cmd.includes('git branch --show-current')) return 'feat/test\n';
  return _origExecSync.call(this, cmd, opts);
};

// Clear follow-up-pr.js cache so it picks up mock
const followUpPrPath = require.resolve('../../work/scripts/follow-up-pr.js');
delete require.cache[followUpPrPath];

// ─── Import step handlers ──────────────────────────────────────────────────

const monitorHandlers = Object.create(null);
require('../lib/steps/monitor')(function (name, fn) {
  monitorHandlers[name] = fn;
});
const monitor = monitorHandlers['monitor'];

const triageHandlers = Object.create(null);
require('../lib/steps/triage')(function (name, fn) {
  triageHandlers[name] = fn;
});
const triage = triageHandlers['triage'];

// ─── Mock setup helper ─────────────────────────────────────────────────────

function setGhMocks(opts = {}) {
  const {
    prState = 'OPEN',
    mergeable = 'MERGEABLE',
    mergeStateStatus = 'BLOCKED',
    checks = [],
    reviews = [],
    pendingBots = [],
  } = opts;

  // Order matters: most specific patterns first (reviews,statusCheckRollup before statusCheckRollup)
  ghMockResponses = {
    'number,title': {
      number: 42,
      title: 'feat: test',
      headRefName: 'feat/test',
      state: prState,
      mergeable,
      mergeStateStatus,
      url: 'https://github.com/test/repo/pull/42',
    },
    'pr checks': checks.map((c) => ({
      name: c.name,
      bucket: c.bucket,
      state: c.state || '',
      link: null,
      workflow: { name: c.name },
    })),
    '--required': [],
    requested_reviewers: { users: pendingBots.map((b) => ({ login: b })) },
    'reviews,statusCheckRollup': { reviews, statusCheckRollup: [] },
    '--json reviews': { reviews, statusCheckRollup: [] },
    statusCheckRollup: {
      statusCheckRollup: checks.map((c) => ({
        name: c.name,
        status: c.bucket === 'pending' ? 'IN_PROGRESS' : 'COMPLETED',
        conclusion:
          c.bucket === 'pass'
            ? 'SUCCESS'
            : c.bucket === 'fail'
              ? 'FAILURE'
              : c.bucket === 'cancel'
                ? 'CANCELLED'
                : null,
      })),
      reviews: [],
    },
    'repo view': { nameWithOwner: 'test/repo' },
    commits: { commits: [{ oid: 'abc123' }] },
    'comments?per_page': [],
    graphql: { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } },
    '--paginate': '0',
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('CI progression with mocked gh calls', () => {
  let tmpDir, ctx;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fu2-ci-'));
    fs.mkdirSync(path.join(tmpDir, 'GH-123'), { recursive: true });
    ctx = {
      tasksDir: path.join(tmpDir, 'GH-123'),
      worktreeDir: tmpDir,
      TASKS_BASE: tmpDir,
      workScriptsDir: path.resolve(__dirname, '..', '..', 'work', 'scripts'),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    ghMockResponses = {};
    delete require.cache[followUpPrPath];
  });

  describe('Scenario 1: all checks pass', () => {
    it('monitor → exitCode 0 → report', () => {
      setGhMocks({
        checks: [
          { name: 'Test (Node 20)', bucket: 'pass' },
          { name: 'Test (Node 22)', bucket: 'pass' },
          { name: 'GitGuardian', bucket: 'pass' },
        ],
      });

      const state = {
        ticketId: 'GH-123',
        currentStep: 'monitor',
        prNumber: 42,
        attempt: 1,
        maxAttempts: 40,
      };
      monitor(state, ctx);

      assert.equal(state.lastMonitorResult.exitCode, 0);
      assert.equal(state.currentStep, 'report');
    });
  });

  describe('Scenario 2: CI pending', () => {
    it('monitor → exitCode 1, triage → monitor (loop back)', () => {
      setGhMocks({
        checks: [
          { name: 'Test (Node 20)', bucket: 'pass' },
          { name: 'E2E shard 1', bucket: 'pending' },
          { name: 'E2E shard 2', bucket: 'pending' },
        ],
      });

      const state = {
        ticketId: 'GH-123',
        currentStep: 'monitor',
        prNumber: 42,
        attempt: 1,
        maxAttempts: 40,
      };
      monitor(state, ctx);
      assert.equal(state.lastMonitorResult.exitCode, 1);

      state.currentStep = 'triage';
      triage(state, {});
      assert.equal(state.currentStep, 'monitor');
    });
  });

  describe('Scenario 3: CI failing', () => {
    it('monitor → exitCode 1, triage → fix-ci', () => {
      setGhMocks({
        checks: [
          { name: 'Test (Node 20)', bucket: 'fail' },
          { name: 'Test (Node 22)', bucket: 'pass' },
        ],
      });

      const state = {
        ticketId: 'GH-123',
        currentStep: 'monitor',
        prNumber: 42,
        attempt: 1,
        maxAttempts: 40,
        failureCategory: null,
      };
      monitor(state, ctx);
      assert.equal(state.lastMonitorResult.exitCode, 1);

      state.currentStep = 'triage';
      triage(state, {});
      assert.equal(state.failureCategory, 'ci_failure');
      assert.equal(state.currentStep, 'fix-ci');
    });
  });

  describe('Scenario 4: blocking reviews', () => {
    it('CI pass + blocking review → triage → fix-reviews', () => {
      setGhMocks({
        checks: [{ name: 'Test', bucket: 'pass' }],
        reviews: [
          {
            author: { login: 'cursor[bot]' },
            body: '**High Severity**',
            state: 'CHANGES_REQUESTED',
          },
        ],
      });

      const state = {
        ticketId: 'GH-123',
        currentStep: 'monitor',
        prNumber: 42,
        attempt: 1,
        maxAttempts: 40,
        failureCategory: null,
      };
      monitor(state, ctx);
      assert.equal(state.lastMonitorResult.exitCode, 1);

      state.currentStep = 'triage';
      triage(state, {});
      assert.equal(state.failureCategory, 'reviews');
      assert.equal(state.currentStep, 'fix-reviews');
    });
  });

  describe('Scenario 5: PR merged', () => {
    it('merged → exitCode 0 → report', () => {
      setGhMocks({ prState: 'MERGED' });

      const state = {
        ticketId: 'GH-123',
        currentStep: 'monitor',
        prNumber: 42,
        attempt: 1,
        maxAttempts: 40,
      };
      monitor(state, ctx);
      assert.equal(state.lastMonitorResult.exitCode, 0);
      assert.equal(state.currentStep, 'report');
    });
  });

  describe('Scenario 6: pending checks + failure → fail fast', () => {
    it('2 pending + 1 fail → triage → fix-ci (does not wait for pending)', () => {
      setGhMocks({
        checks: [
          { name: 'Cursor Bugbot', bucket: 'pending' },
          { name: 'E2E shard 1', bucket: 'pending' },
          { name: 'Unit Tests', bucket: 'fail' },
        ],
      });

      const state = {
        ticketId: 'GH-123',
        currentStep: 'monitor',
        prNumber: 42,
        attempt: 1,
        maxAttempts: 40,
        failureCategory: null,
      };
      monitor(state, ctx);
      assert.equal(state.lastMonitorResult.exitCode, 1);

      state.currentStep = 'triage';
      triage(state, {});
      assert.equal(state.failureCategory, 'ci_failure');
      assert.equal(state.currentStep, 'fix-ci');
    });
  });

  describe('Scenario 7: bot still reviewing', () => {
    it('pending bot detected in output → triage loops to monitor', () => {
      // Mock produces "Awaiting bot reviews" in formatReport when pendingBots present
      // But getReviews' REST→fallback heuristic requires CI checks still running
      // to detect pending bots. Adding a pending CI check triggers the fallback.
      setGhMocks({
        checks: [
          { name: 'Test', bucket: 'pass' },
          { name: 'Cursor Bugbot', bucket: 'pending' },
        ],
        pendingBots: ['cursor-ai[bot]'],
      });

      const state = {
        ticketId: 'GH-123',
        currentStep: 'monitor',
        prNumber: 42,
        attempt: 1,
        maxAttempts: 40,
        failureCategory: null,
      };
      monitor(state, ctx);

      // CI pending → exitCode 1 (pending check makes CI not "passing")
      assert.equal(state.lastMonitorResult.exitCode, 1);

      state.currentStep = 'triage';
      triage(state, {});
      // Triage sees CI: PENDING → loops to monitor
      assert.equal(state.currentStep, 'monitor');
    });
  });
});
