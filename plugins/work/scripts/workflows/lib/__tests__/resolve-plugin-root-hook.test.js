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
const {
  resolvePluginRoot,
  resolvePluginRootHonouringEnv,
} = require('../../work/lib/resolve-plugin-root');

// Track temp dirs for cleanup
const TEMP_DIRS = [];

/**
 * Build a realistic cache install fixture mirroring the real on-disk layout:
 *   <tmp>/cache/work-workflow/work-workflow/3.20.2/workflows/work
 * Returns { base, pluginRoot } where pluginRoot is the leaf containing workflows/work.
 */
function makeFixtureCacheInstall() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-install-'));
  TEMP_DIRS.push(base);
  const pluginRoot = path.join(base, 'cache', 'work-workflow', 'work-workflow', '3.20.2');
  fs.mkdirSync(path.join(pluginRoot, 'workflows', 'work'), { recursive: true });
  return { base, pluginRoot };
}

/**
 * Build a realistic marketplace install fixture mirroring the real layout:
 *   <tmp>/marketplaces/work-workflow/plugins/work/workflows/work
 * Returns { base, marketplaceDir, pluginRoot }:
 *   base           = parent plugins-base dir (CLAUDE_PLUGIN_ROOT parent shape)
 *   marketplaceDir = <base>/marketplaces/work-workflow (leaf shape env)
 *   pluginRoot     = <base>/marketplaces/work-workflow/plugins/work (expected resolution)
 */
function makeFixtureMarketplaceInstall() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-install-'));
  TEMP_DIRS.push(base);
  const marketplaceDir = path.join(base, 'marketplaces', 'work-workflow');
  const pluginRoot = path.join(marketplaceDir, 'plugins', 'work');
  fs.mkdirSync(path.join(pluginRoot, 'workflows', 'work'), { recursive: true });
  return { base, marketplaceDir, pluginRoot };
}

/**
 * Build a parent plugins-base dir containing the cache-style parent layout
 * (marketplaces/work-workflow/workflows/work) — preserved cache-parent shape.
 */
function makeFixturePluginsBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-base-'));
  TEMP_DIRS.push(base);
  fs.mkdirSync(path.join(base, 'marketplaces', 'work-workflow', 'workflows', 'work'), {
    recursive: true,
  });
  return base;
}

/**
 * Build a leaf plugin dir that directly contains workflows/work (cache-leaf shape).
 */
function makeFixtureLeafPlugin() {
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

  it('cache-install behaviour is preserved (parent shape): env at parent plugins-base resolves to marketplaces/work-workflow', async () => {
    // cache-install behaviour preserved (parent shape): env at parent base,
    // marketplaces/work-workflow/workflows/work exists → return marketplace dir.
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
    assert.ok(
      !stderr.includes(`node ${pluginsBase}/hooks/test.js`),
      `hook must not rewrite to bare parent plugins-base dir, got:\n${stderr}`
    );
  });

  it('cache-install behaviour is preserved (leaf shape): env at leaf plugin dir is honoured as-is', async () => {
    // cache-install behaviour preserved (leaf shape): env points at a dir that
    // already contains workflows/work → use verbatim.
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

  it('cache install fixture mirrors real layout cache/work-workflow/<ver>/workflows/work', async () => {
    // Realistic fixture path mirrors ~/.claude/plugins/cache/work-workflow/work-workflow/3.20.2.
    const { pluginRoot } = makeFixtureCacheInstall();
    assert.ok(
      fs.existsSync(path.join(pluginRoot, 'workflows', 'work')),
      `expected cache install fixture pluginRoot ${pluginRoot} to contain workflows/work`
    );
    // resolvePluginRoot with env pointing at the cache-leaf must return it verbatim.
    const prev = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    try {
      assert.strictEqual(resolvePluginRoot(), pluginRoot);
    } finally {
      process.env.CLAUDE_PLUGIN_ROOT = prev;
    }
  });

  it('env unset falls back to __dirname probing', async () => {
    const { code, stderr } = await runHook(
      { tool_input: { command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/test.js' } },
      { CLAUDE_PLUGIN_ROOT: '' }
    );
    assert.strictEqual(code, 2);
    const match = stderr.match(/node (\S+)\/hooks\/test\.js/);
    assert.ok(match, `expected rewritten command in stderr, got:\n${stderr}`);
    const resolvedRoot = match[1];
    assert.ok(
      fs.existsSync(path.join(resolvedRoot, 'workflows', 'work')),
      `expected resolved root ${resolvedRoot} to contain workflows/work`
    );
  });

  it('env set to unrelated path falls through without false match: resolvePluginRoot returns null; honouring wrapper returns env verbatim', () => {
    // Unrelated path (no workflows/work anywhere under it) → resolvePluginRoot
    // returns null; resolvePluginRootHonouringEnv returns env verbatim.
    const unrelated = fs.mkdtempSync(path.join(os.tmpdir(), 'unrelated-'));
    TEMP_DIRS.push(unrelated);
    const prev = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = unrelated;
    try {
      assert.strictEqual(resolvePluginRoot(), null);
      assert.strictEqual(resolvePluginRootHonouringEnv(), path.resolve(unrelated));
    } finally {
      process.env.CLAUDE_PLUGIN_ROOT = prev;
    }
  });

  it('env var points at marketplace parent plugins-base dir resolves to marketplaces/work-workflow/plugins/work leaf', () => {
    // AC1: parent-base marketplace shape — env at <tmp> parent base, real layout
    // <tmp>/marketplaces/work-workflow/plugins/work/workflows/work exists →
    // resolvePluginRoot must return <tmp>/marketplaces/work-workflow/plugins/work.
    const { base, pluginRoot } = makeFixtureMarketplaceInstall();
    const prev = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = base;
    try {
      assert.strictEqual(resolvePluginRoot(), pluginRoot);
    } finally {
      process.env.CLAUDE_PLUGIN_ROOT = prev;
    }
  });

  it('env var points at marketplace leaf (work-workflow dir) resolves to plugins/work subdir leaf', () => {
    // AC2: leaf marketplace shape — env at <tmp>/marketplaces/work-workflow,
    // <env>/plugins/work/workflows/work exists → return <env>/plugins/work.
    const { marketplaceDir, pluginRoot } = makeFixtureMarketplaceInstall();
    const prev = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = marketplaceDir;
    try {
      assert.strictEqual(resolvePluginRoot(), pluginRoot);
    } finally {
      process.env.CLAUDE_PLUGIN_ROOT = prev;
    }
  });

  it('PreToolUse Bash hook rewrites ${CLAUDE_PLUGIN_ROOT} using the marketplace install path (parent-base env value)', async () => {
    // AC6: hook spawned with env=parent base on a real marketplace fixture
    // must rewrite ${CLAUDE_PLUGIN_ROOT} to the plugins/work leaf.
    const { base, pluginRoot } = makeFixtureMarketplaceInstall();
    const { code, stderr } = await runHook(
      { tool_input: { command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/test.js' } },
      { CLAUDE_PLUGIN_ROOT: base }
    );
    assert.strictEqual(code, 2);
    assert.ok(
      stderr.includes(`node ${pluginRoot}/hooks/test.js`),
      `expected hook to rewrite to marketplace pluginRoot ${pluginRoot}, got:\n${stderr}`
    );
    assert.ok(
      !stderr.includes(`node ${base}/hooks/test.js`),
      `hook must not rewrite to bare parent plugins-base dir, got:\n${stderr}`
    );
  });

  it('PreToolUse Bash hook honours the marketplace leaf env value and rewrites to plugins/work leaf', async () => {
    // AC7: hook spawned with env=marketplace leaf must rewrite to plugins/work.
    const { marketplaceDir, pluginRoot } = makeFixtureMarketplaceInstall();
    const { code, stderr } = await runHook(
      { tool_input: { command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/test.js' } },
      { CLAUDE_PLUGIN_ROOT: marketplaceDir }
    );
    assert.strictEqual(code, 2);
    assert.ok(
      stderr.includes(`node ${pluginRoot}/hooks/test.js`),
      `expected hook to rewrite to plugins/work leaf ${pluginRoot}, got:\n${stderr}`
    );
    assert.ok(
      !stderr.includes(`node ${marketplaceDir}/hooks/test.js`),
      `hook must not rewrite to bare marketplace dir, got:\n${stderr}`
    );
  });
});
