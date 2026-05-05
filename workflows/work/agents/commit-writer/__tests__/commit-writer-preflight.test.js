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

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
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
