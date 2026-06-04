const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'bootstrap-branch.js');

/**
 * Spawn the bootstrap-branch.js helper as a subprocess and return
 * { stdout, stderr, status }. Env starts from a clean slate (no
 * inherited BRANCH_PREFIX / BRANCH_NAME_REGEX / TICKET_PROVIDER) so
 * each test owns its config surface.
 */
function runResult(args, env = {}) {
  // Start from process.env but strip every var the helper consults so
  // tests do not inherit ambient .envrc values from the dev shell.
  const merged = { ...process.env };
  for (const key of ['BRANCH_PREFIX', 'BRANCH_NAME_REGEX', 'TICKET_PROVIDER']) {
    delete merged[key];
  }
  Object.assign(merged, env);
  // Treat empty-string overrides as "explicitly empty" — keep them as ''.
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf-8',
      env: merged,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
      status: err.status ?? 1,
    };
  }
}

describe('bootstrap-branch.js — Task 1 (CLI contract + resolver)', () => {
  describe('Linear gitBranchName is used verbatim when present and provider is Linear', () => {
    it('returns --git-branch-name value verbatim on stdout with exit 0 when TICKET_PROVIDER=linear', () => {
      const result = runResult(
        [
          '--ticket-id', 'ECHO-4454',
          '--summary', 'Fix Foo Bar',
          '--git-branch-name', 'feature/echo-4454-foo',
        ],
        { TICKET_PROVIDER: 'linear' },
      );
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
      assert.equal(result.stdout.trim(), 'feature/echo-4454-foo');
      // stdout must contain only the resolved name (no trailing diagnostics)
      assert.equal(result.stdout.replace(/\n$/, ''), 'feature/echo-4454-foo');
    });
  });

  describe('Fallback constructs <BRANCH_PREFIX><TICKET-ID>-<kebab-summary> when gitBranchName is absent', () => {
    it('with BRANCH_PREFIX=feature/ produces feature/echo-4454-fix-foo-bar (ticket-ID lowercased)', () => {
      const result = runResult(
        ['--ticket-id', 'ECHO-4454', '--summary', 'Fix Foo Bar'],
        { BRANCH_PREFIX: 'feature/' },
      );
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
      assert.equal(result.stdout.trim(), 'feature/echo-4454-fix-foo-bar');
    });
  });

  describe('Fallback works with empty BRANCH_PREFIX for backward compatibility', () => {
    it('with empty BRANCH_PREFIX produces echo-4454-fix-foo-bar', () => {
      const result = runResult(
        ['--ticket-id', 'ECHO-4454', '--summary', 'Fix Foo Bar'],
        { BRANCH_PREFIX: '' },
      );
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
      assert.equal(result.stdout.trim(), 'echo-4454-fix-foo-bar');
    });
  });

  describe('CLI argument validation', () => {
    it('exits 1 with stderr explaining the missing flag when --ticket-id is absent', () => {
      const result = runResult(['--summary', 'Fix Foo Bar']);
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
      assert.match(result.stderr, /--ticket-id/, `expected stderr to mention --ticket-id, got: ${result.stderr}`);
    });
  });
});

describe('bootstrap-branch.js — Task 2 (BRANCH_NAME_REGEX gate + safety + prefix suggestion)', () => {
  describe('Helper aborts BEFORE git worktree add when name fails BRANCH_NAME_REGEX', () => {
    it('(a) BRANCH_NAME_REGEX=^(feature|fix)/.+$ rejects echo-4454-foo with stderr containing name and regex', () => {
      const result = runResult(
        ['--ticket-id', 'ECHO-4454', '--summary', 'Foo'],
        { BRANCH_NAME_REGEX: '^(feature|fix)/.+$' },
      );
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}. stderr: ${result.stderr}`);
      assert.match(result.stderr, /echo-4454-foo/, `expected stderr to mention offending name, got: ${result.stderr}`);
      assert.match(result.stderr, /\^\(feature\|fix\)\/\.\+\$/, `expected stderr to mention regex source, got: ${result.stderr}`);
    });

    it('(e) regex mismatch + BRANCH_PREFIX would have matched: stderr suggests setting BRANCH_PREFIX', () => {
      const result = runResult(
        ['--ticket-id', 'ECHO-4454', '--summary', 'Foo'],
        { BRANCH_NAME_REGEX: '^feature/.+$', BRANCH_PREFIX: 'feature/' },
      );
      // With BRANCH_PREFIX set the name is already feature/echo-4454-foo → would pass.
      // To exercise the suggestion path, BRANCH_PREFIX is configured but the test
      // simulates the mismatch case where prepending the configured prefix would help.
      // The implementation must compute: if regex.test(prefix + name) === true, suggest it.
      // Here we invert: set regex requiring feature/ and BRANCH_PREFIX empty but configured
      // via a separate run.
      // Re-run with empty prefix to actually trigger suggestion:
      const r2 = runResult(
        ['--ticket-id', 'ECHO-4454', '--summary', 'Foo'],
        { BRANCH_NAME_REGEX: '^feature/.+$', BRANCH_PREFIX: '' },
      );
      assert.equal(r2.status, 1, `expected exit 1, got ${r2.status}`);
      // Suggestion line per AC 1.2.1(e):
      assert.match(r2.stderr, /BRANCH_PREFIX/, `expected suggestion mentioning BRANCH_PREFIX, got: ${r2.stderr}`);
      // Also verify the first run (which would have passed) actually does pass:
      assert.equal(result.status, 0, `expected exit 0 when prefix already matches, got ${result.status}. stderr: ${result.stderr}`);
    });
  });

  describe('Validation is skipped when BRANCH_NAME_REGEX is unset', () => {
    it('(b) unset BRANCH_NAME_REGEX resolves echo-4454-foo with exit 0 (backward compat)', () => {
      const result = runResult(
        ['--ticket-id', 'ECHO-4454', '--summary', 'Foo'],
        {},
      );
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
      assert.equal(result.stdout.trim(), 'echo-4454-foo');
    });

    it('(d) safety regex blocks shell metacharacters even when BRANCH_NAME_REGEX is unset', () => {
      // Pass a Linear gitBranchName containing a shell metachar; with TICKET_PROVIDER=linear
      // it would be used verbatim, so safety regex must still reject it.
      const result = runResult(
        ['--ticket-id', 'ECHO-4454', '--summary', 'Foo', '--git-branch-name', 'feature/bad;name'],
        { TICKET_PROVIDER: 'linear' },
      );
      assert.equal(result.status, 1, `expected exit 1 (shell metachar), got ${result.status}. stderr: ${result.stderr}`);
    });
  });

  describe('Linear gitBranchName that violates BRANCH_NAME_REGEX causes fail-fast abort', () => {
    it('(c) --git-branch-name=bad name! with BRANCH_NAME_REGEX=^feature/.+$ exits 1 (regex wins over Linear)', () => {
      const result = runResult(
        ['--ticket-id', 'ECHO-4454', '--summary', 'Foo', '--git-branch-name', 'bad name!'],
        { TICKET_PROVIDER: 'linear', BRANCH_NAME_REGEX: '^feature/.+$' },
      );
      assert.equal(result.status, 1, `expected exit 1 (regex wins), got ${result.status}. stderr: ${result.stderr}`);
    });
  });
});
