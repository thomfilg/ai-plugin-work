/**
 * Tests for commit-writer-preflight.js (PreToolUse hook for Task tool).
 *
 * Blocks commit-writer from spawning if there are no staged changes
 * or if quality checks fail. Uses spawn-based testing.
 *
 * Note: Tests that require git operations (staged changes check, quality
 * checks) are difficult to test via spawn without a real git repo, so
 * we focus on the routing logic: non-Task tools exit 0, non-commit-writer
 * subagent_type exits 0, malformed input exits 2.
 *
 * Run: node --test workflows/work/agents/commit-writer/__tests__/commit-writer-preflight.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execSync } = require('child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('fs');
const os = require('os');
const path = require('path');

const HOOK_PATH = path.join(__dirname, '..', 'commit-writer-preflight.js');

function runHook(input) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    proc.on('error', reject);
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

function runHookRaw(rawString) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    proc.on('error', reject);
    if (rawString) {
      proc.stdin.write(rawString);
    }
    proc.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Non-Task tools should exit 0 (pass through)
// ---------------------------------------------------------------------------

describe('commit-writer-preflight — non-Task tools exit 0', () => {
  for (const tool of ['Read', 'Bash', 'Grep', 'Glob', 'Write', 'Edit']) {
    it(`allows ${tool} tool`, async () => {
      const { code } = await runHook({ tool_name: tool, tool_input: {} });
      assert.strictEqual(code, 0);
    });
  }
});

// ---------------------------------------------------------------------------
// Non-commit-writer subagent_type should exit 0
// ---------------------------------------------------------------------------

describe('commit-writer-preflight — non-commit-writer agents exit 0', () => {
  it('allows Task with subagent_type "some-other-agent"', async () => {
    const { code } = await runHook({
      tool_name: 'Task',
      tool_input: { subagent_type: 'some-other-agent' },
    });
    assert.strictEqual(code, 0);
  });

  it('allows Task with subagent_type "developer-nodejs-tdd"', async () => {
    const { code } = await runHook({
      tool_name: 'Task',
      tool_input: { subagent_type: 'developer-nodejs-tdd' },
    });
    assert.strictEqual(code, 0);
  });

  it('allows Task with empty subagent_type', async () => {
    const { code } = await runHook({
      tool_name: 'Task',
      tool_input: { subagent_type: '' },
    });
    assert.strictEqual(code, 0);
  });

  it('allows Task with missing subagent_type', async () => {
    const { code } = await runHook({
      tool_name: 'Task',
      tool_input: {},
    });
    assert.strictEqual(code, 0);
  });
});

// ---------------------------------------------------------------------------
// Malformed input should exit 2
// ---------------------------------------------------------------------------

describe('commit-writer-preflight — malformed input exit 2', () => {
  it('exits 2 on malformed JSON', async () => {
    const { code, stderr } = await runHookRaw('{not valid json');
    assert.strictEqual(code, 2);
    assert.match(stderr, /COMMIT-WRITER PREFLIGHT/);
    assert.match(stderr, /Failed to parse/);
  });
});

// ---------------------------------------------------------------------------
// Staged changes check (requires temp git repo)
// ---------------------------------------------------------------------------

describe('commit-writer-preflight — staged changes check', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'cw-preflight-'));
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
    // Create an initial commit so HEAD exists
    writeFileSync(path.join(tmpDir, 'init.txt'), 'init');
    execSync('git add init.txt', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "initial"', { cwd: tmpDir, stdio: 'pipe' });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runHookWithCwd(input, cwd) {
    return new Promise((resolve, reject) => {
      const proc = spawn('node', [HOOK_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        cwd,
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => {
        stdout += d.toString();
      });
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('close', (code) => {
        resolve({ code, stdout, stderr });
      });
      proc.on('error', reject);
      proc.stdin.write(JSON.stringify(input));
      proc.stdin.end();
    });
  }

  it('exits 2 with "No staged changes" when nothing is staged', async () => {
    const { code, stderr } = await runHookWithCwd(
      {
        tool_name: 'Task',
        tool_input: { subagent_type: 'commit-writer' },
        cwd: tmpDir,
      },
      tmpDir
    );
    assert.strictEqual(code, 2);
    assert.match(stderr, /No staged changes/);
  });

  it('does not exit 2 with "No staged changes" when files are staged', async () => {
    // Create and stage a new file
    writeFileSync(path.join(tmpDir, 'staged.txt'), 'content');
    execSync('git add staged.txt', { cwd: tmpDir, stdio: 'pipe' });

    const { code, stderr } = await runHookWithCwd(
      {
        tool_name: 'Task',
        tool_input: { subagent_type: 'commit-writer' },
        cwd: tmpDir,
      },
      tmpDir
    );
    // Should NOT be blocked for "No staged changes" — may still fail on quality checks
    // but the "No staged changes" gate should have been passed
    if (code === 2) {
      assert.doesNotMatch(stderr, /No staged changes/);
    }
  });
});
