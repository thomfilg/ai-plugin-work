/**
 * Tests for resolve-plugin-root-hook.js (PreToolUse Bash hook)
 * Auto-resolves ${CLAUDE_PLUGIN_ROOT} in Bash commands.
 *
 * Run with: node --test hooks/__tests__/resolve-plugin-root-hook.test.js
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'resolve-plugin-root-hook.js');

// Track temp dirs for cleanup
const TEMP_DIRS = [];
function makeFixturePluginsBase() {
  // Builds a parent plugins-base dir containing marketplaces/work-workflow/workflows/work
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-base-'));
  TEMP_DIRS.push(base);
  fs.mkdirSync(path.join(base, 'marketplaces', 'work-workflow', 'workflows', 'work'), {
    recursive: true,
  });
  return base;
}
function makeFixtureLeafPlugin() {
  // Builds a leaf plugin dir that directly contains workflows/work
  const leaf = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-leaf-'));
  TEMP_DIRS.push(leaf);
  fs.mkdirSync(path.join(leaf, 'workflows', 'work'), { recursive: true });
  return leaf;
}
// Shared real-leaf fixture used as the default CLAUDE_PLUGIN_ROOT for tests
// that don't override it. resolvePluginRoot() requires the env path to actually
// contain workflows/work, so a real directory is needed in place of a fake path.
const DEFAULT_ROOT = makeFixtureLeafPlugin();

after(() => {
  for (const d of TEMP_DIRS) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch (_) {}
  }
});

function runHook(input, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: DEFAULT_ROOT, ...env },
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
    assert.ok(stderr.includes(DEFAULT_ROOT));
    assert.ok(stderr.includes(`node ${DEFAULT_ROOT}/hooks/work-orchestrator.js test`));
  });

  it('should BLOCK when command contains $CLAUDE_PLUGIN_ROOT (no braces)', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'node $CLAUDE_PLUGIN_ROOT/hooks/test.js' },
    });
    assert.strictEqual(code, 2);
    assert.ok(stderr.includes(`node ${DEFAULT_ROOT}/hooks/test.js`));
  });

  it('command without CLAUDE_PLUGIN_ROOT is allowed through unchanged', async () => {
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
      stderr.includes(`node ${DEFAULT_ROOT}/lib/engine.js && node ${DEFAULT_ROOT}/hooks/test.js`)
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

  it('escaped reference is left alone', async () => {
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

  it('env var set to parent plugins-base directory is resolved to the marketplace subdir', async () => {
    // env var = parent plugins-base dir; hook must probe down to marketplaces/work-workflow
    const pluginsBase = makeFixturePluginsBase();
    const expectedLeaf = path.join(pluginsBase, 'marketplaces', 'work-workflow');
    const { code, stderr } = await runHook(
      { tool_input: { command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/test.js' } },
      { CLAUDE_PLUGIN_ROOT: pluginsBase }
    );
    assert.strictEqual(code, 2);
    assert.ok(
      stderr.includes(expectedLeaf),
      `expected stderr to include leaf marketplace path ${expectedLeaf}, got:\n${stderr}`
    );
    // Should NOT use the bare parent plugins-base path as the rewrite root
    assert.ok(
      !stderr.includes(`node ${pluginsBase}/hooks/test.js`),
      `hook must not rewrite to bare parent plugins-base dir, got:\n${stderr}`
    );
  });

  it('env var set to leaf plugin directory is honoured as-is', async () => {
    // env var = leaf plugin dir already containing workflows/work → use as-is
    const leaf = makeFixtureLeafPlugin();
    const { code, stderr } = await runHook(
      { tool_input: { command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/test.js' } },
      { CLAUDE_PLUGIN_ROOT: leaf }
    );
    assert.strictEqual(code, 2);
    assert.ok(
      stderr.includes(`node ${leaf}/hooks/test.js`),
      `expected stderr to contain leaf path verbatim, got:\n${stderr}`
    );
  });

  it('env var unset falls back to __dirname probing', async () => {
    // env var unset → must fall back via resolvePluginRoot(__dirname, 3) probing
    const { code, stderr } = await runHook(
      { tool_input: { command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/test.js' } },
      { CLAUDE_PLUGIN_ROOT: '' }
    );
    assert.strictEqual(code, 2);
    // Resolved root must point at the actual plugin dir containing workflows/work
    const match = stderr.match(/node (\S+)\/hooks\/test\.js/);
    assert.ok(match, `expected rewritten command in stderr, got:\n${stderr}`);
    const resolvedRoot = match[1];
    assert.ok(
      fs.existsSync(path.join(resolvedRoot, 'workflows', 'work')),
      `expected resolved root ${resolvedRoot} to contain workflows/work`
    );
  });
});
