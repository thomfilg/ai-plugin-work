'use strict';

/**
 * WP-07 / design C10: codex installs drop the `workflows -> scripts/workflows`
 * git symlink from the plugin cache, so runtime path builds through it break
 * there. enforce-dev-commands.js must point at the canonical real path on
 * codex when the historical path is missing; on claude the historical
 * (env-verbatim) path stays byte-identical. quality-check.js's
 * BUNDLED_DEV_CHECK must resolve to a file that actually exists.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'enforce-dev-commands.js');
const FAKE_ROOT = '/fake/plugin/root';

function runHook(env = {}) {
  const merged = { ...process.env, CLAUDE_PLUGIN_ROOT: FAKE_ROOT, ...env };
  for (const key of ['AGENT_RUNTIME', 'AGENT_SESSION_ID', 'CODEX_THREAD_ID', 'PLUGIN_ROOT']) {
    if (!(key in env)) delete merged[key];
  }
  const r = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ tool_input: { command: 'pnpm lint' } }),
    encoding: 'utf8',
    timeout: 15000,
    env: merged,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('enforce-dev-commands — dev-check.sh path per runtime (C10)', () => {
  it('claude: keeps the CLAUDE_PLUGIN_ROOT-derived path VERBATIM (characterization)', () => {
    const r = runHook({ AGENT_RUNTIME: 'claude' });
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes(`${FAKE_ROOT}/workflows/lib/scripts/dev-check/dev-check.sh`));
  });

  it('codex: falls back to the canonical real path when the symlinked path is missing', () => {
    const r = runHook({ AGENT_RUNTIME: 'codex' });
    assert.equal(r.code, 2);
    assert.ok(!r.stderr.includes(FAKE_ROOT), 'must not print the dead env-derived path');
    const canonical = path.resolve(__dirname, '..', 'scripts', 'dev-check', 'dev-check.sh');
    assert.ok(r.stderr.includes(canonical));
    assert.equal(fs.existsSync(canonical), true, 'canonical fallback must exist on disk');
  });
});

describe('quality-check — BUNDLED_DEV_CHECK resolves to a real file', () => {
  it('exists on disk in this checkout (symlinked or canonical)', () => {
    const { BUNDLED_DEV_CHECK } = require(path.resolve(__dirname, '..', 'quality-check.js'));
    assert.equal(fs.existsSync(BUNDLED_DEV_CHECK), true);
  });
});
