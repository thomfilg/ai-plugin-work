const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'follow-up-pr-comments.js');

/**
 * Helper: run the script with args and env overrides.
 * Returns { status, stdout, stderr }.
 */
function run(args, envOverrides = {}, opts = {}) {
  const env = { ...process.env, ...envOverrides };
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
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

/**
 * Create a temp dir with a follow-up-comments.json state file.
 * Returns { tmpDir, stateFile, accountabilityFile, cleanup }.
 */
function createTempState(stateData) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fup-comments-'));
  const ticketDir = path.join(tmpDir, 'GH-276');
  fs.mkdirSync(ticketDir, { recursive: true });
  const stateFile = path.join(ticketDir, 'follow-up-comments.json');
  const accountabilityFile = path.join(ticketDir, 'review-accountability.json');
  if (stateData) {
    fs.writeFileSync(stateFile, JSON.stringify(stateData, null, 2));
  }
  return {
    tmpDir,
    ticketDir,
    stateFile,
    accountabilityFile,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/** Standard env overrides so the script finds the right task dir */
function envFor(tmpDir) {
  return {
    TASKS_BASE: tmpDir,
    TICKET_PROVIDER: 'github',
  };
}

/** cwd for child process — must contain GH-276 so getCurrentTaskId() resolves */
function cwdFor(ctx) {
  return ctx.ticketDir; // e.g., /tmp/fup-comments-xxx/GH-276
}

/** Build a sample state object with given comments */
function makeState(comments, overrides = {}) {
  return {
    snapshotAt: '2026-04-24T12:00:00Z',
    prNumber: 25,
    repo: 'owner/repo',
    strictCommentCount: comments.length,
    comments,
    ...overrides,
  };
}

/** Build a single comment entry */
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

// ── Arg Parsing ──────────────────────────────────────────────────────────────

describe('follow-up-pr-comments CLI', () => {
  describe('arg parsing', () => {
    it('exits 2 with usage help when called with no args', () => {
      const result = run([]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /usage/i);
    });

    it('exits 2 for unknown subcommand', () => {
      const result = run(['--unknown-command']);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /unknown/i);
    });

    it('exits 2 when --snapshot is called without --pr', () => {
      const result = run(['--snapshot']);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /--pr/i);
    });
  });

  // ── --next-comment ────────────────────────────────────────────────────────

  describe('--next-comment', () => {
    let ctx;
    afterEach(() => ctx?.cleanup());

    it('exits 1 when no snapshot exists', () => {
      ctx = createTempState(null);
      const result = run(['--next-comment'], envFor(ctx.tmpDir), { cwd: cwdFor(ctx) });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /snapshot/i);
    });

    it('returns highest-priority unsolved comment first', () => {
      const comments = [
        makeComment({ id: 1, priority: 'low', body: 'Low prio' }),
        makeComment({ id: 2, priority: 'high', body: 'High prio' }),
        makeComment({ id: 3, priority: 'medium', body: 'Medium prio' }),
      ];
      ctx = createTempState(makeState(comments));
      const result = run(['--next-comment'], envFor(ctx.tmpDir), { cwd: cwdFor(ctx) });
      assert.equal(result.status, 0);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.id, 2);
      assert.equal(parsed.priority, 'high');
      assert.equal(parsed.author, 'copilot-pull-request-reviewer');
      assert.equal(parsed.body, 'High prio');
    });

    it('returns done:true when all comments are solved or skipped', () => {
      const comments = [
        makeComment({ id: 1, status: 'solved' }),
        makeComment({ id: 2, status: 'skipped' }),
      ];
      ctx = createTempState(makeState(comments));
      const result = run(['--next-comment'], envFor(ctx.tmpDir), { cwd: cwdFor(ctx) });
      assert.equal(result.status, 0);
      const parsed = JSON.parse(result.stdout);
      assert.deepEqual(parsed, { done: true });
    });

    it('includes id, author, body, path, line, priority in response', () => {
      const comments = [
        makeComment({
          id: 42,
          author: 'reviewer',
          body: 'Fix this',
          path: 'src/a.js',
          line: 10,
          priority: 'high',
        }),
      ];
      ctx = createTempState(makeState(comments));
      const result = run(['--next-comment'], envFor(ctx.tmpDir), { cwd: cwdFor(ctx) });
      assert.equal(result.status, 0);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.id, 42);
      assert.equal(parsed.author, 'reviewer');
      assert.equal(parsed.body, 'Fix this');
      assert.equal(parsed.path, 'src/a.js');
      assert.equal(parsed.line, 10);
      assert.equal(parsed.priority, 'high');
      // codeContext may be null if file doesn't exist, which is fine
      assert.ok('codeContext' in parsed);
    });

    it('skips already-solved comments and returns next unsolved', () => {
      const comments = [
        makeComment({ id: 1, priority: 'high', status: 'solved' }),
        makeComment({ id: 2, priority: 'medium' }),
      ];
      ctx = createTempState(makeState(comments));
      const result = run(['--next-comment'], envFor(ctx.tmpDir), { cwd: cwdFor(ctx) });
      assert.equal(result.status, 0);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.id, 2);
    });
  });

  // ── --solve-comment ───────────────────────────────────────────────────────

  describe('--solve-comment', () => {
    let ctx;
    afterEach(() => ctx?.cleanup());

    it('marks comment as solved and writes accountability', () => {
      const comments = [
        makeComment({ id: 100, author: 'reviewer', body: 'Fix error handling', path: 'src/a.js' }),
      ];
      ctx = createTempState(makeState(comments));
      const result = run(
        ['--solve-comment', '100', 'abc1234', 'Fixed error handling'],
        envFor(ctx.tmpDir),
        { cwd: cwdFor(ctx) }
      );
      assert.equal(result.status, 0);

      // Verify state file updated
      const state = JSON.parse(fs.readFileSync(ctx.stateFile, 'utf8'));
      const comment = state.comments.find((c) => c.id === 100);
      assert.equal(comment.status, 'solved');
      assert.equal(comment.commitSha, 'abc1234');
      assert.equal(comment.resolution, 'Fixed error handling');

      // Verify accountability file created
      assert.ok(fs.existsSync(ctx.accountabilityFile));
      const accountability = JSON.parse(fs.readFileSync(ctx.accountabilityFile, 'utf8'));
      assert.ok(Array.isArray(accountability));
      assert.equal(accountability.length, 1);
      assert.equal(accountability[0].disposition, 'addressed');
      assert.equal(accountability[0].id, 100);
      assert.equal(accountability[0].author, 'reviewer');
      assert.equal(accountability[0].path, 'src/a.js');
      assert.ok(accountability[0].reason.length > 0);
    });

    it('exits 1 for unknown comment ID', () => {
      const comments = [makeComment({ id: 100 })];
      ctx = createTempState(makeState(comments));
      const result = run(['--solve-comment', '999', 'abc1234', 'Fix'], envFor(ctx.tmpDir), {
        cwd: cwdFor(ctx),
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /not found/i);
    });

    it('validates commitSha format (hex 7-40 chars)', () => {
      const comments = [makeComment({ id: 100 })];
      ctx = createTempState(makeState(comments));
      const result = run(['--solve-comment', '100', 'short', 'Fix'], envFor(ctx.tmpDir), {
        cwd: cwdFor(ctx),
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /commit/i);
    });

    it('truncates description to 500 chars', () => {
      const comments = [makeComment({ id: 100 })];
      ctx = createTempState(makeState(comments));
      const longDesc = 'x'.repeat(600);
      const result = run(['--solve-comment', '100', 'abc1234def0', longDesc], envFor(ctx.tmpDir), {
        cwd: cwdFor(ctx),
      });
      assert.equal(result.status, 0);

      const state = JSON.parse(fs.readFileSync(ctx.stateFile, 'utf8'));
      assert.equal(state.comments[0].resolution.length, 500);
    });
  });

  // ── --skip-comment ────────────────────────────────────────────────────────

  describe('--skip-comment', () => {
    let ctx;
    afterEach(() => ctx?.cleanup());

    it('marks comment as skipped with acknowledged disposition', () => {
      const comments = [
        makeComment({ id: 200, author: 'reviewer', body: 'Nitpick', path: 'src/b.js' }),
      ];
      ctx = createTempState(makeState(comments));
      const result = run(['--skip-comment', '200', 'Non-blocking nitpick'], envFor(ctx.tmpDir), {
        cwd: cwdFor(ctx),
      });
      assert.equal(result.status, 0);

      const state = JSON.parse(fs.readFileSync(ctx.stateFile, 'utf8'));
      const comment = state.comments.find((c) => c.id === 200);
      assert.equal(comment.status, 'skipped');
      assert.equal(comment.resolution, 'Non-blocking nitpick');

      const accountability = JSON.parse(fs.readFileSync(ctx.accountabilityFile, 'utf8'));
      assert.equal(accountability.length, 1);
      assert.equal(accountability[0].disposition, 'acknowledged');
      assert.equal(accountability[0].reason, 'Non-blocking nitpick');
    });

    it('exits 1 for unknown comment ID', () => {
      const comments = [makeComment({ id: 200 })];
      ctx = createTempState(makeState(comments));
      const result = run(['--skip-comment', '999', 'Reason'], envFor(ctx.tmpDir), {
        cwd: cwdFor(ctx),
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /not found/i);
    });

    it('truncates reason to 500 chars', () => {
      const comments = [makeComment({ id: 200 })];
      ctx = createTempState(makeState(comments));
      const longReason = 'y'.repeat(600);
      const result = run(['--skip-comment', '200', longReason], envFor(ctx.tmpDir), {
        cwd: cwdFor(ctx),
      });
      assert.equal(result.status, 0);

      const state = JSON.parse(fs.readFileSync(ctx.stateFile, 'utf8'));
      assert.equal(state.comments[0].resolution.length, 500);
    });
  });

  // ── --status ──────────────────────────────────────────────────────────────

  describe('--status', () => {
    let ctx;
    afterEach(() => ctx?.cleanup());

    it('returns accurate counts for mixed states', () => {
      const comments = [
        makeComment({ id: 1, status: 'solved' }),
        makeComment({ id: 2, status: 'solved' }),
        makeComment({ id: 3, status: 'skipped' }),
        makeComment({ id: 4, status: 'unsolved' }),
        makeComment({ id: 5, status: 'unsolved' }),
      ];
      ctx = createTempState(makeState(comments));
      const result = run(['--status'], envFor(ctx.tmpDir), { cwd: cwdFor(ctx) });
      assert.equal(result.status, 0);
      const parsed = JSON.parse(result.stdout);
      assert.deepEqual(parsed, {
        total: 5,
        solved: 2,
        skipped: 1,
        remaining: 2,
        strictCommentCount: 5,
      });
    });

    it('returns zeros when no snapshot exists', () => {
      ctx = createTempState(null);
      const result = run(['--status'], envFor(ctx.tmpDir), { cwd: cwdFor(ctx) });
      assert.equal(result.status, 0);
      const parsed = JSON.parse(result.stdout);
      assert.deepEqual(parsed, {
        total: 0,
        solved: 0,
        skipped: 0,
        remaining: 0,
        strictCommentCount: 0,
      });
    });
  });

  // ── Full lifecycle ────────────────────────────────────────────────────────

  describe('full lifecycle (solve + skip loop)', () => {
    let ctx;
    afterEach(() => ctx?.cleanup());

    it('produces valid accountability after solving/skipping all comments', () => {
      const comments = [
        makeComment({
          id: 1,
          priority: 'high',
          author: 'bot',
          body: 'Fix auth',
          path: 'src/auth.js',
        }),
        makeComment({
          id: 2,
          priority: 'medium',
          author: 'human',
          body: 'Style issue',
          path: 'src/style.js',
        }),
        makeComment({
          id: 3,
          priority: 'low',
          author: 'bot',
          body: 'Nitpick',
          path: 'src/util.js',
        }),
      ];
      ctx = createTempState(makeState(comments));
      const env = envFor(ctx.tmpDir);
      const cwd = { cwd: cwdFor(ctx) };

      // Get first (high priority)
      let result = run(['--next-comment'], env, cwd);
      assert.equal(result.status, 0);
      let next = JSON.parse(result.stdout);
      assert.equal(next.id, 1);

      // Solve it
      result = run(['--solve-comment', '1', 'aabbccdd', 'Fixed auth'], env, cwd);
      assert.equal(result.status, 0);

      // Get next (medium priority)
      result = run(['--next-comment'], env, cwd);
      next = JSON.parse(result.stdout);
      assert.equal(next.id, 2);

      // Skip it
      result = run(['--skip-comment', '2', 'Conflicts with user intent'], env, cwd);
      assert.equal(result.status, 0);

      // Get next (low priority)
      result = run(['--next-comment'], env, cwd);
      next = JSON.parse(result.stdout);
      assert.equal(next.id, 3);

      // Solve it
      result = run(['--solve-comment', '3', 'ddeeff00', 'Fixed nitpick'], env, cwd);
      assert.equal(result.status, 0);

      // Next should be done
      result = run(['--next-comment'], env, cwd);
      next = JSON.parse(result.stdout);
      assert.deepEqual(next, { done: true });

      // Status check
      result = run(['--status'], env, cwd);
      const status = JSON.parse(result.stdout);
      assert.equal(status.total, 3);
      assert.equal(status.solved, 2);
      assert.equal(status.skipped, 1);
      assert.equal(status.remaining, 0);

      // Accountability is valid for verify gate
      const accountability = JSON.parse(fs.readFileSync(ctx.accountabilityFile, 'utf8'));
      assert.equal(accountability.length, 3);
      assert.ok(accountability.length >= status.strictCommentCount);

      // Every entry has required fields
      for (const entry of accountability) {
        assert.ok(['addressed', 'acknowledged', 'outdated'].includes(entry.disposition));
        assert.ok(entry.reason && entry.reason.length > 0);
        assert.ok(entry.id != null);
        assert.ok(entry.author);
        assert.ok('path' in entry);
        assert.ok('comment' in entry);
      }

      // Check dispositions match
      const solved = accountability.find((e) => e.id === 1);
      assert.equal(solved.disposition, 'addressed');
      const skipped = accountability.find((e) => e.id === 2);
      assert.equal(skipped.disposition, 'acknowledged');
    });
  });

  // ── Input validation ──────────────────────────────────────────────────────

  describe('input validation', () => {
    let ctx;
    afterEach(() => ctx?.cleanup());

    it('accepts string review IDs (e.g. PRR_kwDO...) for --solve-comment', () => {
      const comments = [makeComment({ id: 'PRR_kwDO123' })];
      ctx = createTempState(makeState(comments));
      const result = run(
        ['--solve-comment', 'PRR_kwDO123', 'abc1234def0', 'Fix'],
        envFor(ctx.tmpDir),
        { cwd: cwdFor(ctx) }
      );
      assert.equal(result.status, 0);
    });

    it('accepts string review IDs for --skip-comment', () => {
      const comments = [makeComment({ id: 'PRR_kwDO456' })];
      ctx = createTempState(makeState(comments));
      const result = run(['--skip-comment', 'PRR_kwDO456', 'Low priority'], envFor(ctx.tmpDir), {
        cwd: cwdFor(ctx),
      });
      assert.equal(result.status, 0);
    });

    it('rejects empty commentId for --solve-comment', () => {
      const comments = [makeComment({ id: 100 })];
      ctx = createTempState(makeState(comments));
      const result = run(['--solve-comment', '', 'abc1234', 'Fix'], envFor(ctx.tmpDir), {
        cwd: cwdFor(ctx),
      });
      assert.equal(result.status, 1);
    });

    it('exits 2 when --solve-comment has missing args', () => {
      const result = run(['--solve-comment', '100']);
      assert.equal(result.status, 2);
    });

    it('exits 2 when --skip-comment has missing reason', () => {
      const result = run(['--skip-comment', '100']);
      assert.equal(result.status, 2);
    });
  });
});
