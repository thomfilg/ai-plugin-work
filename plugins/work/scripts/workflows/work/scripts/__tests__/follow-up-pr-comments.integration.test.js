/**
 * Integration tests for follow-up-pr-comments helper exports.
 *
 * Task 1 (GH-537): `solveLocally` / `skipLocally` are extracted helpers shared
 * by the legacy CLI handlers and (in later tasks) the new flag aliases. These
 * tests exercise the exported helpers end-to-end against a real on-disk
 * follow-up-comments.json state file.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const SCRIPT_PATH = path.join(__dirname, '..', 'follow-up-pr-comments.js');

/**
 * Spawn the CLI script with args. Returns { status, stdout, stderr }.
 */
function runCli(args, envOverrides = {}, opts = {}) {
  const env = { ...process.env, ...envOverrides };
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: opts.cwd,
      timeout: 10000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: (err.stdout || '').toString(),
      stderr: (err.stderr || '').toString(),
    };
  }
}

function createTempState(stateData) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fup-comments-int-'));
  const ticketDir = path.join(tmpDir, 'GH-276');
  fs.mkdirSync(ticketDir, { recursive: true });
  const stateFile = path.join(ticketDir, 'follow-up-comments.json');
  if (stateData) {
    fs.writeFileSync(stateFile, JSON.stringify(stateData, null, 2));
  }
  // Snapshot env so test cleanup can restore it after the test body has
  // exercised the in-process helpers (which need TASKS_BASE/WORK_TICKET_ID
  // set during the call, not just during require()).
  const prevTasksBase = process.env.TASKS_BASE;
  const prevProvider = process.env.TICKET_PROVIDER;
  const prevTicketId = process.env.WORK_TICKET_ID;
  return {
    tmpDir,
    ticketDir,
    stateFile,
    cleanup: () => {
      if (prevTasksBase === undefined) delete process.env.TASKS_BASE;
      else process.env.TASKS_BASE = prevTasksBase;
      if (prevProvider === undefined) delete process.env.TICKET_PROVIDER;
      else process.env.TICKET_PROVIDER = prevProvider;
      if (prevTicketId === undefined) delete process.env.WORK_TICKET_ID;
      else process.env.WORK_TICKET_ID = prevTicketId;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function makeComment(overrides = {}) {
  return {
    id: 100,
    hash: 'abc123def456',
    author: 'copilot-pull-request-reviewer',
    body: 'Consider adding error handling here',
    path: 'src/handler.js',
    line: 42,
    original_line: 40,
    priority: 'medium',
    status: 'unsolved',
    commitSha: null,
    resolution: null,
    ...overrides,
  };
}

function makeState(comments) {
  return {
    snapshotAt: '2026-04-24T12:00:00Z',
    prNumber: 25,
    repo: 'owner/repo',
    strictCommentCount: comments.length,
    comments,
  };
}

/**
 * Require the module fresh with TASKS_BASE and WORK_TICKET_ID pointed at our
 * fixture so loadState() / saveState() target the temp dir rather than the
 * real repo. Env is left set after this returns — the caller's cleanup()
 * (registered by createTempState) restores it after the test body runs.
 *
 * Note: we set WORK_TICKET_ID explicitly because the test runner is itself
 * spawned from a real git worktree (branch GH-NNN-...), and getCurrentTaskId()
 * prefers `git branch --show-current` over cwd. Without the override the
 * in-process helpers would resolve a ticket dir that doesn't match the temp
 * fixture.
 */
function freshRequire(ticketDir, tmpDir) {
  delete require.cache[SCRIPT_PATH];
  process.env.TASKS_BASE = tmpDir;
  process.env.TICKET_PROVIDER = 'github';
  process.env.WORK_TICKET_ID = 'GH-276';
  return require(SCRIPT_PATH);
}

describe('follow-up-pr-comments helpers (Task 1 integration)', () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  it('solveLocally writes status="solved" to the snapshot JSON', () => {
    ctx = createTempState(makeState([makeComment({ id: 100 })]));
    const mod = freshRequire(ctx.ticketDir, ctx.tmpDir);
    const result = mod.solveLocally(100, 'abc1234', 'fixed null check');
    assert.deepEqual(result, { solved: 100, commitSha: 'abc1234' });

    const after = JSON.parse(fs.readFileSync(ctx.stateFile, 'utf8'));
    const comment = after.comments.find((c) => c.id === 100);
    assert.equal(comment.status, 'solved');
    assert.equal(comment.commitSha, 'abc1234');
    assert.equal(comment.resolution, 'fixed null check');
  });

  it('skipLocally writes status="skipped" to the snapshot JSON', () => {
    ctx = createTempState(makeState([makeComment({ id: 200 })]));
    const mod = freshRequire(ctx.ticketDir, ctx.tmpDir);
    const result = mod.skipLocally(200, 'Out of scope');
    assert.deepEqual(result, { skipped: 200 });

    const after = JSON.parse(fs.readFileSync(ctx.stateFile, 'utf8'));
    const comment = after.comments.find((c) => c.id === 200);
    assert.equal(comment.status, 'skipped');
    assert.equal(comment.resolution, 'Out of scope');
  });

  it('solveLocally throws NO_SNAPSHOT when no snapshot file exists', () => {
    ctx = createTempState(null);
    const mod = freshRequire(ctx.ticketDir, ctx.tmpDir);
    assert.throws(() => mod.solveLocally(100, 'abc1234', 'desc'), /No snapshot/);
  });

  it('skipLocally throws COMMENT_NOT_FOUND for unknown comment id', () => {
    ctx = createTempState(makeState([makeComment({ id: 100 })]));
    const mod = freshRequire(ctx.ticketDir, ctx.tmpDir);
    assert.throws(() => mod.skipLocally(999, 'reason'), /not found/);
  });
});

// ── Task 2 — new flag aliases ───────────────────────────────────────────────

describe('follow-up-pr-comments CLI (Task 2 new flags)', () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  it('New flag --mark-locally-solved marks comment solved without warnings', () => {
    ctx = createTempState(makeState([makeComment({ id: 100 })]));
    const result = runCli(
      ['--mark-locally-solved', '100', 'abc1234', 'fixed null check'],
      { TASKS_BASE: ctx.tmpDir, TICKET_PROVIDER: 'github' },
      { cwd: ctx.ticketDir }
    );
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}`);
    assert.equal(result.stderr, '', `expected empty stderr, got: ${result.stderr}`);

    const after = JSON.parse(fs.readFileSync(ctx.stateFile, 'utf8'));
    const comment = after.comments.find((c) => c.id === 100);
    assert.equal(comment.status, 'solved');
    assert.equal(comment.commitSha, 'abc1234');
    assert.equal(comment.resolution, 'fixed null check');
  });

  it('New flag --mark-locally-skipped marks comment skipped without warnings', () => {
    ctx = createTempState(makeState([makeComment({ id: 200 })]));
    const result = runCli(
      ['--mark-locally-skipped', '200', 'Out of scope'],
      { TASKS_BASE: ctx.tmpDir, TICKET_PROVIDER: 'github' },
      { cwd: ctx.ticketDir }
    );
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}`);
    assert.equal(result.stderr, '', `expected empty stderr, got: ${result.stderr}`);

    const after = JSON.parse(fs.readFileSync(ctx.stateFile, 'utf8'));
    const comment = after.comments.find((c) => c.id === 200);
    assert.equal(comment.status, 'skipped');
    assert.equal(comment.resolution, 'Out of scope');
  });

  it('--mark-locally-solved exits 2 when missing args', () => {
    const result = runCli(['--mark-locally-solved', '100']);
    assert.equal(result.status, 2);
  });

  it('--mark-locally-skipped exits 2 when missing reason', () => {
    const result = runCli(['--mark-locally-skipped', '200']);
    assert.equal(result.status, 2);
  });
});
