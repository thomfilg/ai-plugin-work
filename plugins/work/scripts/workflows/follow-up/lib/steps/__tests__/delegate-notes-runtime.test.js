/**
 * Dual-runtime tests for the follow-up delegate emitters' notes (WP-08):
 * fix-ci and fix-reviews route their delegate note through the vocab token.
 *
 * Claude characterization: the note is byte-identical to the pre-vocabulary
 * HEAD literal. Codex: the note says "execute inline" (C1). The fix-reviews
 * harness stubs follow-up-pr-comments.js; the fix-ci harness uses a
 * nonexistent worktree cwd so every `gh` spawn fails instantly offline.
 *
 * Run: node --test scripts/workflows/follow-up/lib/steps/__tests__/delegate-notes-runtime.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resetRuntimeCache } = require('../../../../lib/runtime');

const handlers = Object.create(null);
function registerStep(name, fn) {
  handlers[name] = fn;
}
require('../fix-ci')(registerStep);
require('../fix-reviews')(registerStep);

const CLAUDE_NOTE = 'Pass the prompt directly to the agent.';
const CODEX_NOTE = 'Execute the prompt inline in this session.';

// Stub follow-up-pr-comments.js: one unsolved comment, deterministic status.
const STUB_COMMENTS_SCRIPT = [
  "'use strict';",
  'const arg = process.argv[2];',
  "if (arg === '--status') {",
  '  process.stdout.write(JSON.stringify({ remaining: 1, total: 1, solved: 0, skipped: 0 }));',
  "} else if (arg === '--next-comment') {",
  '  process.stdout.write(',
  "    JSON.stringify({ id: 'c1', path: 'a.js', line: 3, body: 'Fix the thing' })",
  '  );',
  '}',
  'process.exit(0);',
].join('\n');

let stubDir;
const savedRuntime = {};

beforeEach(() => {
  savedRuntime.AGENT_RUNTIME = process.env.AGENT_RUNTIME;
  delete process.env.AGENT_RUNTIME;
  resetRuntimeCache();
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-notes-rt-'));
  fs.writeFileSync(path.join(stubDir, 'follow-up-pr-comments.js'), STUB_COMMENTS_SCRIPT);
});

afterEach(() => {
  if (savedRuntime.AGENT_RUNTIME === undefined) delete process.env.AGENT_RUNTIME;
  else process.env.AGENT_RUNTIME = savedRuntime.AGENT_RUNTIME;
  resetRuntimeCache();
  fs.rmSync(stubDir, { recursive: true, force: true });
});

function pin(runtime) {
  process.env.AGENT_RUNTIME = runtime;
  resetRuntimeCache();
}

function runFixCi() {
  const state = {
    ticketId: 'GH-1',
    prNumber: 7,
    attempt: 1,
    dispatched: null,
    failureCategory: 'ci_failure',
    lastMonitorResult: { output: '' },
    _ciFailedJobs: [],
    _ciStatusLine: '',
    _ciStatusDetail: '',
  };
  // Nonexistent cwd → every gh spawn throws ENOENT immediately (no network).
  return handlers['fix-ci'](state, { worktreeDir: path.join(stubDir, 'no-such-worktree') });
}

function runFixReviews() {
  const state = {
    ticketId: 'GH-1',
    prNumber: 7,
    attempt: 0,
    dispatched: null,
    _reviewSnapshotDone: true,
  };
  return handlers['fix-reviews'](state, { workScriptsDir: stubDir, worktreeDir: stubDir });
}

describe('fix-ci delegate note', () => {
  it('claude: byte-identical to HEAD', () => {
    pin('claude');
    const r = runFixCi();
    assert.equal(r.delegate.type, 'task');
    assert.equal(r.delegate.note, CLAUDE_NOTE);
  });

  it('codex: says execute inline', () => {
    pin('codex');
    const r = runFixCi();
    assert.equal(r.delegate.note, CODEX_NOTE);
  });
});

describe('fix-reviews delegate note', () => {
  it('claude: byte-identical to HEAD', () => {
    pin('claude');
    const r = runFixReviews();
    assert.equal(r.delegate.type, 'task');
    assert.equal(r.delegate.note, CLAUDE_NOTE);
  });

  it('codex: says execute inline', () => {
    pin('codex');
    const r = runFixReviews();
    assert.equal(r.delegate.note, CODEX_NOTE);
  });
});
