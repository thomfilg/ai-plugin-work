/**
 * Tests for enforce-review-accountability.js hook (PreToolUse)
 *
 * Validates that the hook no longer requires the `file` field in
 * review-accountability.json entries — only `disposition` and `reason`
 * are required.
 *
 * Run with: node --test workflows/work/hooks/__tests__/enforce-review-accountability.test.js
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'enforce-review-accountability.js');

/**
 * Sets up a temp directory with:
 * - A fake .git/HEAD referencing the ticket ID
 * - A fake `gh` script on PATH that returns PR data with N comments
 * - A TASKS_BASE with optional review-accountability.json
 *
 * Returns { cwd, tasksBase, ticketDir, binDir, cleanup }
 */
function createFixture(ticketId, { commentCount = 1, accountability = null } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'era-test-'));

  // Fake .git/HEAD
  const gitDir = path.join(base, '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), `ref: refs/heads/${ticketId}-fix-something\n`);

  // Fake gh script that returns PR number and comment count
  const binDir = path.join(base, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const ghScript = path.join(binDir, 'gh');
  fs.writeFileSync(
    ghScript,
    `#!/bin/sh
case "$*" in
  *"pr view"*)
    echo '{"number": 42}'
    ;;
  *"api"*)
    echo '${commentCount}'
    ;;
  *)
    echo '{}'
    ;;
esac
`
  );
  fs.chmodSync(ghScript, 0o755);

  // TASKS_BASE with optional accountability file
  const tasksBase = path.join(base, 'tasks');
  const ticketDir = path.join(tasksBase, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });

  if (accountability !== null) {
    fs.writeFileSync(
      path.join(ticketDir, 'review-accountability.json'),
      JSON.stringify(accountability, null, 2)
    );
  }

  return {
    cwd: base,
    tasksBase,
    ticketDir,
    binDir,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

/**
 * Run the hook with given stdin input, cwd, and env overrides.
 * Returns { code, stderr, stdout }.
 */
function runHook(input, { cwd, envOverrides = {} } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...envOverrides },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => resolve({ code, stderr, stdout }));
    proc.on('error', reject);
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

const FOLLOW_UP_INPUT = {
  tool_name: 'Bash',
  tool_input: { command: 'node workflows/work/scripts/follow-up-pr.js' },
};

describe('enforce-review-accountability: file field not required', () => {
  const cleanups = [];
  after(() => cleanups.forEach((fn) => fn()));

  it('should ALLOW entries with disposition+reason but no file field (exit 0)', async () => {
    const fixture = createFixture('GH-285', {
      commentCount: 1,
      accountability: [{ disposition: 'addressed', reason: 'Fixed in commit abc123' }],
    });
    cleanups.push(fixture.cleanup);

    const { code, stderr } = await runHook(FOLLOW_UP_INPUT, {
      cwd: fixture.cwd,
      envOverrides: {
        TASKS_BASE: fixture.tasksBase,
        PATH: `${fixture.binDir}:${process.env.PATH}`,
      },
    });

    assert.strictEqual(
      code,
      0,
      `Expected exit 0 (allow) for entry without file field, got ${code}. stderr: ${stderr}`
    );
  });

  it('should still BLOCK entries missing disposition (exit 2)', async () => {
    const fixture = createFixture('GH-285', {
      commentCount: 1,
      accountability: [{ reason: 'some reason but no disposition' }],
    });
    cleanups.push(fixture.cleanup);

    const { code, stderr } = await runHook(FOLLOW_UP_INPUT, {
      cwd: fixture.cwd,
      envOverrides: {
        TASKS_BASE: fixture.tasksBase,
        PATH: `${fixture.binDir}:${process.env.PATH}`,
      },
    });

    assert.strictEqual(code, 2, `Expected exit 2 (block) for missing disposition, got ${code}`);
    assert.ok(stderr.includes('missing required fields'), 'Should mention missing required fields');
  });

  it('should still BLOCK entries missing reason (exit 2)', async () => {
    const fixture = createFixture('GH-285', {
      commentCount: 1,
      accountability: [{ disposition: 'addressed' }],
    });
    cleanups.push(fixture.cleanup);

    const { code, stderr } = await runHook(FOLLOW_UP_INPUT, {
      cwd: fixture.cwd,
      envOverrides: {
        TASKS_BASE: fixture.tasksBase,
        PATH: `${fixture.binDir}:${process.env.PATH}`,
      },
    });

    assert.strictEqual(code, 2, `Expected exit 2 (block) for missing reason, got ${code}`);
    assert.ok(stderr.includes('missing required fields'), 'Should mention missing required fields');
  });

  it('should ALLOW entries that include file field alongside disposition+reason (exit 0)', async () => {
    const fixture = createFixture('GH-285', {
      commentCount: 1,
      accountability: [{ file: 'src/index.js', disposition: 'outdated', reason: 'Code removed' }],
    });
    cleanups.push(fixture.cleanup);

    const { code, stderr } = await runHook(FOLLOW_UP_INPUT, {
      cwd: fixture.cwd,
      envOverrides: {
        TASKS_BASE: fixture.tasksBase,
        PATH: `${fixture.binDir}:${process.env.PATH}`,
      },
    });

    assert.strictEqual(
      code,
      0,
      `Expected exit 0 (allow) for entry with file field present, got ${code}. stderr: ${stderr}`
    );
  });

  it('should show (disposition, reason) in error message, not (file, disposition, reason)', async () => {
    const fixture = createFixture('GH-285', {
      commentCount: 1,
      accountability: [
        { file: 'src/index.js' }, // has file but missing disposition + reason
      ],
    });
    cleanups.push(fixture.cleanup);

    const { code, stderr } = await runHook(FOLLOW_UP_INPUT, {
      cwd: fixture.cwd,
      envOverrides: {
        TASKS_BASE: fixture.tasksBase,
        PATH: `${fixture.binDir}:${process.env.PATH}`,
      },
    });

    assert.strictEqual(code, 2, `Expected exit 2 (block), got ${code}`);
    assert.ok(
      stderr.includes('(disposition, reason)'),
      `Error message should list "(disposition, reason)" but got: ${stderr}`
    );
    assert.ok(
      !stderr.includes('(file, disposition, reason)'),
      `Error message should NOT list "(file, disposition, reason)" but got: ${stderr}`
    );
  });

  it('should not show file or line fields in schema documentation', async () => {
    const fixture = createFixture('GH-285', {
      commentCount: 1,
      accountability: null, // no file → triggers schema docs output
    });
    cleanups.push(fixture.cleanup);

    const { code, stderr } = await runHook(FOLLOW_UP_INPUT, {
      cwd: fixture.cwd,
      envOverrides: {
        TASKS_BASE: fixture.tasksBase,
        PATH: `${fixture.binDir}:${process.env.PATH}`,
      },
    });

    assert.strictEqual(code, 2, 'Should block when no accountability file exists');
    assert.ok(
      !stderr.includes('"file"'),
      `Schema docs should not mention "file" field but got: ${stderr}`
    );
    assert.ok(
      !stderr.includes('"line"'),
      `Schema docs should not mention "line" field but got: ${stderr}`
    );
  });
});
