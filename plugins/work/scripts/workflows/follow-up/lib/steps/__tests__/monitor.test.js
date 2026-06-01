'use strict';

// monitor.test.js — tests for plugins/work/scripts/workflows/follow-up/lib/steps/monitor.js
//
// Organization (helper-by-helper):
//   - Task 1: load-bearing comment presence (RED gate for GH-459 Task 1)
//   - Task 2 pure helpers: extractConflictFiles, computeExitCode, buildInitialFailedJobs
//   - Task 2 shell-out helpers: detectLocalConflict, refreshPrUntilKnown, resolveMissingRunIds
//
// The Task 1 tests read monitor.js as source text and assert that each
// of the four load-bearing rationale phrases appears within ±10 lines of the
// helper it documents.
//
// The Task 2 tests exercise the six named helpers via `require('../monitor').__test__`.
// Shell-out helpers stub `child_process` via `require.cache` substitution; each test
// restores the original module after running.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MONITOR_PATH = path.resolve(__dirname, '..', 'monitor.js');
const SOURCE = fs.readFileSync(MONITOR_PATH, 'utf8');
const LINES = SOURCE.split('\n');

// ---------------------------------------------------------------------------
// Source-text helpers (Task 1)
// ---------------------------------------------------------------------------

/**
 * Find the 1-based line number of the line declaring `function <name>(`.
 */
function findHelperLine(name) {
  const re = new RegExp(`function\\s+${name}\\s*\\(`);
  for (let i = 0; i < LINES.length; i++) {
    if (re.test(LINES[i])) return i + 1;
  }
  return -1;
}

/**
 * Returns true if `pattern` (RegExp) matches a *comment line* within ±10 lines
 * of the named helper's declaration.
 */
function phraseNearHelper(helperName, pattern) {
  const lineNo = findHelperLine(helperName);
  assert.notEqual(lineNo, -1, `helper ${helperName} not found in monitor.js`);
  const start = Math.max(0, lineNo - 1 - 10);
  const end = Math.min(LINES.length, lineNo - 1 + 11);
  for (let i = start; i < end; i++) {
    const line = LINES[i];
    const trimmed = line.trim();
    const isComment =
      trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
    if (isComment && pattern.test(line)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Module loader (Task 2)
// ---------------------------------------------------------------------------

const CHILD_PROCESS_ID = require.resolve('child_process');
const MONITOR_ID = require.resolve('../monitor.js');

function freshLoadMonitor() {
  delete require.cache[MONITOR_ID];
  return require('../monitor.js');
}

function withStubbedChildProcess(stub, fn) {
  const originalCp = require.cache[CHILD_PROCESS_ID];
  const stubModule = { exports: stub };
  require.cache[CHILD_PROCESS_ID] = stubModule;
  delete require.cache[MONITOR_ID];
  try {
    const monitor = require('../monitor.js');
    return fn(monitor);
  } finally {
    if (originalCp) require.cache[CHILD_PROCESS_ID] = originalCp;
    else delete require.cache[CHILD_PROCESS_ID];
    delete require.cache[MONITOR_ID];
  }
}

// ---------------------------------------------------------------------------
// Task 1 tests
// ---------------------------------------------------------------------------

describe('monitor.js retains the four load-bearing comments', () => {
  it('UNKNOWN-mergeable retry rationale lives near refreshPrUntilKnown', () => {
    assert.ok(
      phraseNearHelper('refreshPrUntilKnown', /UNKNOWN/),
      'expected /UNKNOWN/ comment within ±10 lines of refreshPrUntilKnown'
    );
  });

  it('merge-tree local authority rationale lives near detectLocalConflict', () => {
    assert.ok(
      phraseNearHelper('detectLocalConflict', /merge-tree/),
      'expected /merge-tree/ comment within ±10 lines of detectLocalConflict'
    );
  });

  it('j.url || j.link ordering rationale lives near buildInitialFailedJobs', () => {
    assert.ok(
      phraseNearHelper('buildInitialFailedJobs', /j\.url \|\| j\.link/),
      'expected /j.url || j.link/ comment within ±10 lines of buildInitialFailedJobs'
    );
  });

  it('matrix parent vs shard pending-vs-failed rationale lives near hasFailedJobs', () => {
    assert.ok(
      phraseNearHelper('hasFailedJobs', /matrix/),
      'expected /matrix/ comment within ±10 lines of hasFailedJobs'
    );
  });
});

// ---------------------------------------------------------------------------
// Task 2.1 — __test__ export shape
// ---------------------------------------------------------------------------

describe('monitor.js exposes helpers via __test__ export', () => {
  it('exposes all six named helpers as functions', () => {
    const monitor = freshLoadMonitor();
    assert.ok(monitor.__test__, 'expected monitor.__test__ to exist');
    const expected = [
      'detectLocalConflict',
      'extractConflictFiles',
      'refreshPrUntilKnown',
      'computeExitCode',
      'resolveMissingRunIds',
      'buildInitialFailedJobs',
    ];
    for (const name of expected) {
      assert.equal(
        typeof monitor.__test__[name],
        'function',
        `expected monitor.__test__.${name} to be a function`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Task 2.2 — pure helpers
// ---------------------------------------------------------------------------

describe('extractConflictFiles parses both line forms and dedupes', () => {
  it('parses CONFLICT and Auto-merging lines, dedupes, caps at max', () => {
    const monitor = freshLoadMonitor();
    const { extractConflictFiles } = monitor.__test__;
    const tree = [
      'CONFLICT (content): Merge conflict in a.js',
      'Auto-merging b.js',
      'Auto-merging b.js',
    ].join('\n');
    assert.deepEqual(extractConflictFiles(tree, 3), ['a.js', 'b.js']);
  });
});

describe('computeExitCode truth table', () => {
  it('returns 0 only when ciOk && reviewsOk && mergeOk; 1 otherwise', () => {
    const monitor = freshLoadMonitor();
    const { computeExitCode } = monitor.__test__;

    const ciOkVariants = [
      { status: 'passing' }, // ciOk true
      { status: 'failing' }, // ciOk false
    ];
    const reviewsOkVariants = [
      { hasBlocking: false, pendingBots: [] }, // reviewsOk true
      { hasBlocking: true, blocking: [{}], pendingBots: [] }, // reviewsOk false
    ];
    const mergeOkVariants = [
      { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }, // mergeOk true
      { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, // mergeOk false
    ];

    for (const ci of ciOkVariants) {
      for (const reviews of reviewsOkVariants) {
        for (const prInfo of mergeOkVariants) {
          const ciOk = ci.status === 'passing';
          const reviewsOk = !reviews.hasBlocking;
          const mergeOk = prInfo.mergeable !== 'CONFLICTING';
          const expected = ciOk && reviewsOk && mergeOk ? 0 : 1;
          assert.equal(
            computeExitCode(prInfo, ci, reviews),
            expected,
            `ci=${ci.status} reviewsOk=${reviewsOk} mergeOk=${mergeOk}`
          );
        }
      }
    }
  });

  it('treats no-checks as ciOk', () => {
    const monitor = freshLoadMonitor();
    const { computeExitCode } = monitor.__test__;
    assert.equal(
      computeExitCode(
        { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
        { status: 'no-checks' },
        { hasBlocking: false, pendingBots: [] }
      ),
      0
    );
  });

  it('returns 1 when there are pendingBots', () => {
    const monitor = freshLoadMonitor();
    const { computeExitCode } = monitor.__test__;
    assert.equal(
      computeExitCode(
        { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
        { status: 'passing' },
        { hasBlocking: false, pendingBots: ['copilot'] }
      ),
      1
    );
  });
});

describe('buildInitialFailedJobs', () => {
  it('prefers j.url over j.link', () => {
    const monitor = freshLoadMonitor();
    const { buildInitialFailedJobs } = monitor.__test__;
    const out = buildInitialFailedJobs({
      failed: [{ name: 'a', url: 'https://x/runs/111', link: 'https://x/runs/222' }],
    });
    assert.deepEqual(out, [{ name: 'a', runId: '111' }]);
  });

  it('falls back to j.link when url missing', () => {
    const monitor = freshLoadMonitor();
    const { buildInitialFailedJobs } = monitor.__test__;
    const out = buildInitialFailedJobs({
      failed: [{ name: 'a', link: 'https://x/runs/222' }],
    });
    assert.deepEqual(out, [{ name: 'a', runId: '222' }]);
  });
});

// ---------------------------------------------------------------------------
// Task 2.3 — shell-out helpers (stubbed child_process)
// ---------------------------------------------------------------------------

describe('detectLocalConflict', () => {
  afterEach(() => {
    delete require.cache[MONITOR_ID];
  });

  it('trusts API when fetch fails — returns conflicting:false', () => {
    const stub = {
      execFileSync: (cmd, args) => {
        if (args && args[0] === 'fetch') throw new Error('network down');
        return '';
      },
      spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
    };
    withStubbedChildProcess(stub, (monitor) => {
      const out = monitor.__test__.detectLocalConflict('main', '/tmp/wt');
      assert.deepEqual(out, { conflicting: false, files: [] });
    });
  });

  it('signals conflict via exit code alone (no marker)', () => {
    const stub = {
      execFileSync: (cmd, args) => {
        if (args && args[0] === 'fetch') return '';
        if (args && args[0] === 'merge-base') return 'abc123\n';
        return '';
      },
      spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
    };
    withStubbedChildProcess(stub, (monitor) => {
      const out = monitor.__test__.detectLocalConflict('main', '/tmp/wt');
      assert.equal(out.conflicting, true);
      assert.deepEqual(out.files, []);
    });
  });

  it('signals conflict via marker alone (exit 0 with CONFLICT line)', () => {
    const stub = {
      execFileSync: (cmd, args) => {
        if (args && args[0] === 'fetch') return '';
        if (args && args[0] === 'merge-base') return 'abc123\n';
        return '';
      },
      spawnSync: () => ({
        status: 0,
        stdout: 'CONFLICT (content): Merge conflict in path/to/file.js\n',
        stderr: '',
      }),
    };
    withStubbedChildProcess(stub, (monitor) => {
      const out = monitor.__test__.detectLocalConflict('main', '/tmp/wt');
      assert.equal(out.conflicting, true);
      assert.deepEqual(out.files, ['path/to/file.js']);
    });
  });

  it('caps conflict file list at 3', () => {
    const stub = {
      execFileSync: (cmd, args) => {
        if (args && args[0] === 'fetch') return '';
        if (args && args[0] === 'merge-base') return 'abc123\n';
        return '';
      },
      spawnSync: () => ({
        status: 0,
        stdout: [
          'CONFLICT (content): Merge conflict in a.js',
          'CONFLICT (content): Merge conflict in b.js',
          'Auto-merging c.js',
          'CONFLICT (content): Merge conflict in d.js',
          'Auto-merging e.js',
        ].join('\n'),
        stderr: '',
      }),
    };
    withStubbedChildProcess(stub, (monitor) => {
      const out = monitor.__test__.detectLocalConflict('main', '/tmp/wt');
      assert.equal(out.conflicting, true);
      assert.equal(out.files.length, 3);
    });
  });
});

describe('refreshPrUntilKnown', () => {
  it('is bounded at 3 retries when getPRInfo always returns UNKNOWN', () => {
    const monitor = freshLoadMonitor();
    const { refreshPrUntilKnown } = monitor.__test__;
    let calls = 0;
    const getPRInfo = () => {
      calls++;
      return { mergeable: 'UNKNOWN' };
    };
    const result = refreshPrUntilKnown(getPRInfo, 42, { mergeable: 'UNKNOWN' });
    assert.equal(result.retries, 3);
    assert.equal(calls, 3);
    assert.equal(result.prInfo.mergeable, 'UNKNOWN');
  });

  it('exits early on throw and returns the last prInfo seen', () => {
    const monitor = freshLoadMonitor();
    const { refreshPrUntilKnown } = monitor.__test__;
    const initial = { mergeable: 'UNKNOWN', id: 'initial' };
    let calls = 0;
    const getPRInfo = () => {
      calls++;
      throw new Error('boom');
    };
    const result = refreshPrUntilKnown(getPRInfo, 42, initial);
    assert.equal(result.retries, 1);
    assert.equal(calls, 1);
    assert.equal(result.prInfo, initial);
  });
});

describe('resolveMissingRunIds', () => {
  afterEach(() => {
    delete require.cache[MONITOR_ID];
  });

  it('normalizes names with [tag] suffix when resolving runId', () => {
    const apiOut = '🧪 Run Integration Tests\thttps://github.com/o/r/actions/runs/12345\n';
    const stub = {
      execFileSync: (cmd, args) => {
        if (args && args[0] === 'rev-parse') return 'deadbeef\n';
        if (args && args[0] === 'api') return apiOut;
        return '';
      },
      spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
    };
    withStubbedChildProcess(stub, (monitor) => {
      const failed = [{ name: '🧪 Run Integration Tests [tests]', runId: null }];
      monitor.__test__.resolveMissingRunIds(failed, '/tmp/wt');
      assert.equal(failed[0].runId, '12345');
    });
  });

  it('jq filter catches non-failure conclusions (timed_out, cancelled, action_required, stale, startup_failure)', () => {
    let jqArg = '';
    const stub = {
      execFileSync: (cmd, args) => {
        if (args && args[0] === 'rev-parse') return 'deadbeef\n';
        if (args && args[0] === 'api') {
          const jqIdx = args.indexOf('--jq');
          if (jqIdx !== -1) jqArg = args[jqIdx + 1];
          return '';
        }
        return '';
      },
      spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
    };
    withStubbedChildProcess(stub, (monitor) => {
      const failed = [{ name: 'job', runId: null }];
      monitor.__test__.resolveMissingRunIds(failed, '/tmp/wt');
    });
    for (const token of ['timed_out', 'cancelled', 'action_required', 'stale', 'startup_failure']) {
      assert.ok(jqArg.includes(token), `expected --jq filter to include ${token}`);
    }
  });
});
