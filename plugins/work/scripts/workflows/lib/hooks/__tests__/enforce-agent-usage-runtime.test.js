'use strict';

/**
 * Dual-runtime block texts for enforce-agent-usage.js (WP-07): claude keeps
 * the literal Task({...}) guidance byte-identical; codex renders
 * inline-persona guidance (design C1 — no Task tool there). The rules
 * themselves fire identically on both runtimes (Bash/mcp__ tool names are
 * shared vocabulary).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const HOOK_PATH = path.resolve(__dirname, '..', 'enforce-agent-usage.js');

function runHook(payload, env = {}) {
  const merged = { ...process.env, ...env };
  for (const key of [
    'AGENT_RUNTIME',
    'AGENT_SESSION_ID',
    'CODEX_THREAD_ID',
    'PLUGIN_ROOT',
    'CLAUDE_CURRENT_AGENT',
    'CLAUDE_AGENT_TYPE',
  ]) {
    if (!(key in env)) delete merged[key];
  }
  const r = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
    env: merged,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const PR_CREATE_PAYLOAD = {
  session_id: 's-1',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'gh pr create --title "x" --body "y"' },
};

describe('enforce-agent-usage — per-runtime block texts', () => {
  it('claude: PR-creation block keeps the Task guidance literal (characterization)', () => {
    const r = runHook(PR_CREATE_PAYLOAD, { AGENT_RUNTIME: 'claude' });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /BLOCKED: PR Creation requires agent!/);
    assert.match(r.stderr, /Use Task tool with subagent_type="pr-generator"/);
  });

  it('codex: PR-creation block renders inline-persona guidance', () => {
    const r = runHook({ ...PR_CREATE_PAYLOAD, turn_id: 't-1' }, { AGENT_RUNTIME: 'codex' });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /BLOCKED: PR Creation requires agent!/);
    assert.match(r.stderr, /\[work:codex-degraded\] subagent 'pr-generator' runs INLINE/);
    assert.match(r.stderr, /agents\/pr-generator\.md/);
    assert.doesNotMatch(r.stderr, /Use Task tool/);
  });

  it('codex: the raw git-commit rule keeps its runtime-neutral script guidance', () => {
    const r = runHook(
      {
        session_id: 's-1',
        turn_id: 't-1',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "feat: x"' },
      },
      { AGENT_RUNTIME: 'codex' }
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /commit-and-push\.js/);
    assert.doesNotMatch(r.stderr, /codex-degraded/);
  });

  it('payload agent_type satisfies a rule on codex (payload-first identity)', () => {
    const r = runHook(
      { ...PR_CREATE_PAYLOAD, turn_id: 't-1', agent_type: 'pr-generator' },
      { AGENT_RUNTIME: 'codex' }
    );
    assert.equal(r.code, 0);
  });
});
