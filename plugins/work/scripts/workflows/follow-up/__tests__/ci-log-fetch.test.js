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
    buildChildEnv() {
      return { ...process.env };
    },
  },
};

// Mock child_process BEFORE monitor.js loads (it destructures execFileSync).
const childProcess = require('child_process');
const _origExecSync = childProcess.execSync;
const _origExecFileSync = childProcess.execFileSync;

// Default mock: returns empty by default; tests override apiOutForCheckRuns.
let apiOutForCheckRuns = '';
childProcess.execFileSync = function (file, args, opts) {
  if (file === 'git' && Array.isArray(args) && args[0] === 'rev-parse') {
    return 'deadbeefcafe0000\n';
  }
  if (file === 'gh' && Array.isArray(args) && args[0] === 'api') {
    // Return canned `check-runs` jq output (tab-separated name<TAB>url lines).
    return apiOutForCheckRuns;
  }
  if (file === 'git' && Array.isArray(args) && args[0] === 'fetch') {
    return '';
  }
  if (file === 'git' && Array.isArray(args) && args[0] === 'merge-base') {
    return 'deadbeefcafe0000\n';
  }
  return '';
};

childProcess.execSync = function (cmd, opts) {
  if (typeof cmd === 'string' && cmd.includes('git rev-parse HEAD')) return 'abc1234567890\n';
  if (typeof cmd === 'string' && cmd.includes('git diff --name-only')) return '';
  if (typeof cmd === 'string' && cmd.includes('git branch --show-current')) return 'feat/test\n';
  return '';
};

// Clear follow-up-pr.js + monitor.js cache so they pick up mocks
const followUpPrPath = require.resolve('../../work/scripts/follow-up-pr.js');
delete require.cache[followUpPrPath];
const monitorPath = require.resolve('../lib/steps/monitor');
delete require.cache[monitorPath];

// ─── Import monitor step ───────────────────────────────────────────────────

const monitorHandlers = Object.create(null);
require('../lib/steps/monitor')(function (name, fn) {
  monitorHandlers[name] = fn;
});
const monitor = monitorHandlers['monitor'];

// ─── Mock setup helper ─────────────────────────────────────────────────────
// Returns failed checks via the `pr checks` mock. The key insight: gh's `pr
// checks --json` produces entries with a `link` field, and follow-up-pr.js's
// checkCI() renames that to `url` in its returned `ci.failed[]` entries.

function setGhMocks(opts = {}) {
  const { checks = [], prState = 'OPEN' } = opts;

  ghMockResponses = {
    'number,title': {
      number: 42,
      title: 'feat: test',
      headRefName: 'feat/test',
      state: prState,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      url: 'https://github.com/test/repo/pull/42',
    },
    'pr checks': checks.map((c) => ({
      name: c.name,
      bucket: c.bucket,
      state: c.state || '',
      // checkCI() reads `link` and exposes it as `url` in ci.failed[].
      link: c.link || null,
      workflow: { name: c.name },
    })),
    '--required': [],
    requested_reviewers: { users: [] },
    'reviews,statusCheckRollup': { reviews: [], statusCheckRollup: [] },
    '--json reviews': { reviews: [], statusCheckRollup: [] },
    statusCheckRollup: { statusCheckRollup: [], reviews: [] },
    'repo view': { nameWithOwner: 'test/repo' },
    commits: { commits: [{ oid: 'abc123' }] },
    'comments?per_page': [],
    graphql: { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } },
    '--paginate': '0',
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('monitor CI log fetch — j.url field + broadened conclusion filter', () => {
  let tmpDir, ctx;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fu2-ci-log-'));
    fs.mkdirSync(path.join(tmpDir, 'GH-999'), { recursive: true });
    ctx = {
      tasksDir: path.join(tmpDir, 'GH-999'),
      worktreeDir: tmpDir,
      TASKS_BASE: tmpDir,
      workScriptsDir: path.resolve(__dirname, '..', '..', 'work', 'scripts'),
    };
    apiOutForCheckRuns = '';
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    ghMockResponses = {};
    delete require.cache[followUpPrPath];
  });

  it('extracts runId from j.url field (the field checkCI() actually populates)', () => {
    setGhMocks({
      checks: [
        {
          name: 'Run E2E Tests',
          bucket: 'fail',
          link: 'https://github.com/test/repo/actions/runs/123456789/job/987',
        },
      ],
    });

    const state = {
      ticketId: 'GH-999',
      currentStep: 'monitor',
      prNumber: 42,
      attempt: 1,
      maxAttempts: 40,
    };
    monitor(state, ctx);

    assert.ok(Array.isArray(state._ciFailedJobs), '_ciFailedJobs should be set');
    assert.equal(state._ciFailedJobs.length, 1);
    assert.equal(state._ciFailedJobs[0].name, 'Run E2E Tests');
    // Before fix: runId was null because monitor read j.link instead of j.url.
    assert.equal(
      state._ciFailedJobs[0].runId,
      '123456789',
      'runId should come from j.url (not j.link) in ci.failed entries'
    );
  });

  it('backward-compat: still works for synthetic entries that only have link (no url)', () => {
    // Simulate the legacy/hypothetical shape directly by calling the monitor
    // and verifying the OR fallback. We need to bypass checkCI()'s rename, so
    // we patch follow-up-pr.js's checkCI in require cache.
    const fakeCheckCi = {
      status: 'failing',
      passed: [],
      running: [],
      failed: [
        {
          name: 'Legacy Job',
          // Only `link` populated, `url` undefined — exercises the `|| j.link` arm.
          link: 'https://github.com/test/repo/actions/runs/555000111/job/1',
        },
      ],
      neutral: [],
      cancelled: [],
      totalChecks: 1,
      requiredCheckNames: null,
    };

    // Re-require monitor with patched follow-up-pr so checkCI returns our shape.
    delete require.cache[followUpPrPath];
    delete require.cache[monitorPath];
    require.cache[followUpPrPath] = {
      id: followUpPrPath,
      filename: followUpPrPath,
      loaded: true,
      exports: {
        getPRInfo: () => ({
          number: 42,
          title: 't',
          state: 'OPEN',
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'BLOCKED',
          url: 'https://github.com/test/repo/pull/42',
        }),
        checkCI: () => fakeCheckCi,
        getReviews: () => ({ blocking: [], passing: [], pending: [], pendingBots: [] }),
        formatReport: () => '',
        determineExitCode: () => 1,
      },
    };
    const handlers2 = Object.create(null);
    require('../lib/steps/monitor')(function (name, fn) {
      handlers2[name] = fn;
    });
    const monitor2 = handlers2['monitor'];

    const state = {
      ticketId: 'GH-999',
      currentStep: 'monitor',
      prNumber: 42,
      attempt: 1,
      maxAttempts: 40,
    };
    monitor2(state, ctx);

    assert.equal(state._ciFailedJobs.length, 1);
    assert.equal(
      state._ciFailedJobs[0].runId,
      '555000111',
      'backward-compat: j.link should still resolve when j.url is absent'
    );

    // Cleanup so other tests get fresh cache
    delete require.cache[followUpPrPath];
    delete require.cache[monitorPath];
  });

  it('API resolver fallback: returns runId targets for conclusion: "timed_out"', () => {
    // Failed check with no URL → forces resolver path
    setGhMocks({
      checks: [{ name: 'Run E2E Tests', bucket: 'fail', link: null }],
    });
    apiOutForCheckRuns =
      'Run E2E Tests\thttps://github.com/test/repo/actions/runs/777111222/job/3\n';

    // Fresh require so it sees the latest follow-up-pr mock
    delete require.cache[followUpPrPath];
    delete require.cache[monitorPath];
    const handlers3 = Object.create(null);
    require('../lib/steps/monitor')(function (name, fn) {
      handlers3[name] = fn;
    });
    const monitor3 = handlers3['monitor'];

    const state = {
      ticketId: 'GH-999',
      currentStep: 'monitor',
      prNumber: 42,
      attempt: 1,
      maxAttempts: 40,
    };
    monitor3(state, ctx);

    assert.equal(state._ciFailedJobs.length, 1);
    assert.equal(
      state._ciFailedJobs[0].runId,
      '777111222',
      'resolver should set runId from check-runs API output (timed_out class)'
    );

    delete require.cache[followUpPrPath];
    delete require.cache[monitorPath];
  });

  it('API resolver fallback: returns runId targets for conclusion: "cancelled"', () => {
    setGhMocks({
      checks: [{ name: 'Run Lint', bucket: 'fail', link: null }],
    });
    apiOutForCheckRuns =
      'Run Lint\thttps://github.com/test/repo/actions/runs/888222333/job/4\n';

    delete require.cache[followUpPrPath];
    delete require.cache[monitorPath];
    const handlers4 = Object.create(null);
    require('../lib/steps/monitor')(function (name, fn) {
      handlers4[name] = fn;
    });
    const monitor4 = handlers4['monitor'];

    const state = {
      ticketId: 'GH-999',
      currentStep: 'monitor',
      prNumber: 42,
      attempt: 1,
      maxAttempts: 40,
    };
    monitor4(state, ctx);

    assert.equal(state._ciFailedJobs.length, 1);
    assert.equal(
      state._ciFailedJobs[0].runId,
      '888222333',
      'resolver should set runId from check-runs API output (cancelled class)'
    );

    delete require.cache[followUpPrPath];
    delete require.cache[monitorPath];
  });
});

// Restore child_process at process exit
process.on('exit', () => {
  childProcess.execSync = _origExecSync;
  childProcess.execFileSync = _origExecFileSync;
});
