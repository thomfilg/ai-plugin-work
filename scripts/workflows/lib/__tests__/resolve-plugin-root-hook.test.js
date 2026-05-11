/**
 * Tests for resolve-plugin-root-hook.js (PreToolUse Bash hook)
 * Auto-resolves ${CLAUDE_PLUGIN_ROOT} in Bash commands.
 *
 * Run with: node --test hooks/__tests__/resolve-plugin-root-hook.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'resolve-plugin-root-hook.js');
const FAKE_ROOT = '/fake/plugin/root';

function runHook(input, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: FAKE_ROOT, ...env },
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

describe('resolve-plugin-root-hook', () => {
  it('should BLOCK when command contains ${CLAUDE_PLUGIN_ROOT}', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/work-orchestrator.js test' },
    });
    assert.strictEqual(code, 2);
    assert.ok(stderr.includes(FAKE_ROOT));
    assert.ok(stderr.includes(`node ${FAKE_ROOT}/hooks/work-orchestrator.js test`));
  });

  it('should BLOCK when command contains $CLAUDE_PLUGIN_ROOT (no braces)', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'node $CLAUDE_PLUGIN_ROOT/hooks/test.js' },
    });
    assert.strictEqual(code, 2);
    assert.ok(stderr.includes(`node ${FAKE_ROOT}/hooks/test.js`));
  });

  it('should ALLOW commands without CLAUDE_PLUGIN_ROOT', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'ls -la' },
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '');
  });

  it('should ALLOW commands with other env vars', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'echo ${HOME}/test' },
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '');
  });

  it('should resolve multiple occurrences in one command', async () => {
    const { code, stderr } = await runHook({
      tool_input: {
        command:
          'node ${CLAUDE_PLUGIN_ROOT}/lib/engine.js && node ${CLAUDE_PLUGIN_ROOT}/hooks/test.js',
      },
    });
    assert.strictEqual(code, 2);
    assert.ok(
      stderr.includes(`node ${FAKE_ROOT}/lib/engine.js && node ${FAKE_ROOT}/hooks/test.js`)
    );
  });

  it('should handle empty command gracefully', async () => {
    const { code } = await runHook({
      tool_input: { command: '' },
    });
    assert.strictEqual(code, 0);
  });

  it('should handle missing tool_input gracefully', async () => {
    const { code } = await runHook({});
    assert.strictEqual(code, 0);
  });

  it('should fallback to __dirname when CLAUDE_PLUGIN_ROOT is not set', async () => {
    const expectedRoot = path.join(__dirname, '..', '..', '..');
    const { code, stderr } = await runHook(
      { tool_input: { command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/test.js' } },
      { CLAUDE_PLUGIN_ROOT: '' }
    );
    assert.strictEqual(code, 2);
    assert.ok(stderr.includes(expectedRoot));
  });

  it('should include resolved path in stderr message', async () => {
    const { stderr } = await runHook({
      tool_input: { command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/test.js' },
    });
    assert.ok(stderr.includes(`CLAUDE_PLUGIN_ROOT resolved`));
    assert.ok(stderr.includes('Run this instead'));
  });

  it('should ALLOW commands with similar var names (no false positive)', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'echo $CLAUDE_PLUGIN_ROOT_DIR/test' },
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '');
  });

  it('should ALLOW escaped \\$CLAUDE_PLUGIN_ROOT (not rewrite)', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'grep \\$CLAUDE_PLUGIN_ROOT file.txt' },
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '');
  });

  it('should ALLOW escaped \\${CLAUDE_PLUGIN_ROOT} with braces', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'echo \\${CLAUDE_PLUGIN_ROOT}' },
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '');
  });

  it('should handle $ special sequences in PLUGIN_ROOT path safely', async () => {
    const { code, stderr } = await runHook(
      { tool_input: { command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/test.js' } },
      { CLAUDE_PLUGIN_ROOT: '/path/with/$pecial/chars' }
    );
    assert.strictEqual(code, 2);
    assert.ok(stderr.includes('/path/with/$pecial/chars'));
  });
});
