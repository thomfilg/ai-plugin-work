/**
 * Tests for factories/runtime/payload.js — CanonicalHookEvent normalization
 * over BOTH runtime fixture sets (tests/fixtures/runtime/{claude,codex}).
 * Codex fixtures are checked-in live probe captures (probe P3/P4/P5 shapes).
 *
 * Run: node --test factories/runtime/__tests__/payload.spec.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeHookPayload, isSubagentContext } = require('../payload');

const FIXTURES = path.join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'runtime');

function fixture(runtime, name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, runtime, `${name}.json`), 'utf8'));
}

function normalize(runtime, name, opts = {}) {
  return normalizeHookPayload(fixture(runtime, name), { runtime, ...opts });
}

describe('normalizeHookPayload — codex fixtures (probe captures)', () => {
  it('pre-bash: shell kind, command surfaced, codex identity fields', () => {
    const evt = normalize('codex', 'pre-bash');
    assert.equal(evt.runtime, 'codex');
    assert.equal(evt.event, 'PreToolUse');
    assert.equal(evt.toolKind, 'shell');
    assert.match(evt.shellCommand, /CLAUDE_PLUGIN_ROOT/);
    assert.deepEqual(evt.writeTargets, []);
    assert.ok(evt.sessionId);
    assert.ok(evt.turnId);
    assert.equal(evt.permissionMode, 'bypassPermissions');
    assert.match(evt.transcriptPath, /rollout-.*\.jsonl$/);
  });

  it('post-bash: string tool_response passes through; no exit code on codex Bash', () => {
    const evt = normalize('codex', 'post-bash');
    assert.equal(evt.toolResponseText, 'VAR-UNSET\n');
    assert.equal(evt.toolExitCode, null);
  });

  it('pre-apply-patch: write kind with parsed patch targets (no file_path field)', () => {
    const evt = normalize('codex', 'pre-apply-patch');
    assert.equal(evt.toolKind, 'write');
    assert.equal(evt.rawToolName, 'apply_patch');
    assert.deepEqual(evt.writeTargets, [{ path: 'created-by-patch.txt', op: 'create', ok: true }]);
  });

  it('post-apply-patch: exit code parsed from the string response (probe P4)', () => {
    const evt = normalize('codex', 'post-apply-patch');
    assert.match(evt.toolResponseText, /^Exit code: 0/);
    assert.equal(evt.toolExitCode, 0);
  });

  it('post-view-image: LIST-shaped tool_response normalizes to "" with raw kept', () => {
    const evt = normalize('codex', 'post-view-image');
    assert.equal(evt.toolResponseText, '');
    assert.ok(Array.isArray(evt.native.tool_response));
  });

  it('post-update-plan: flat tool name, plan kind, string response', () => {
    const evt = normalize('codex', 'post-update-plan');
    assert.equal(evt.toolKind, 'plan');
    assert.equal(evt.toolResponseText, 'Plan updated');
  });

  it('pre-read-mcp-resource: flat codex read tool', () => {
    const evt = normalize('codex', 'pre-read-mcp-resource');
    assert.equal(evt.toolKind, 'read');
    assert.equal(evt.shellCommand, null);
  });

  it('user-prompt-submit: prompt surfaced', () => {
    const evt = normalize('codex', 'user-prompt-submit');
    assert.equal(evt.event, 'UserPromptSubmit');
    assert.equal(evt.prompt, '/work GH-123 continue the implementation');
  });

  it('stop: last_assistant_message and stop_hook_active surfaced', () => {
    const evt = normalize('codex', 'stop');
    assert.equal(evt.stopHookActive, false);
    assert.match(evt.lastAssistantText, /ready for review/i);
  });

  it('session-start: source surfaced, no turn id', () => {
    const evt = normalize('codex', 'session-start');
    assert.equal(evt.source, 'startup');
    assert.equal(evt.turnId, null);
  });

  it('subagent-stop: agent identity surfaced; isSubagentContext true', () => {
    const evt = normalize('codex', 'subagent-stop');
    assert.equal(evt.agent.type, 'developer-nodejs-tdd');
    assert.ok(evt.agent.id);
    assert.equal(isSubagentContext(evt), true);
  });

  it('main-session codex events are not subagent contexts', () => {
    assert.equal(isSubagentContext(normalize('codex', 'pre-bash')), false);
  });
});

describe('normalizeHookPayload — claude fixtures (byte-compat surface)', () => {
  it('pre-bash: shell kind', () => {
    const evt = normalize('claude', 'pre-bash');
    assert.equal(evt.runtime, 'claude');
    assert.equal(evt.toolKind, 'shell');
    assert.equal(evt.shellCommand, 'echo VAR-UNSET');
  });

  it('post-bash: {stdout, stderr} object joins to text; no exit code', () => {
    const evt = normalize('claude', 'post-bash');
    assert.equal(evt.toolResponseText, 'VAR-UNSET\n');
    assert.equal(evt.toolExitCode, null);
  });

  it('pre-write: create target from file_path', () => {
    const evt = normalize('claude', 'pre-write');
    assert.deepEqual(evt.writeTargets, [
      { path: '/tmp/claude-fixture-repo/notes.txt', op: 'create', ok: true },
    ]);
  });

  it('pre-edit: modify target', () => {
    const evt = normalize('claude', 'pre-edit');
    assert.deepEqual(evt.writeTargets, [
      { path: '/tmp/claude-fixture-repo/.claude/settings.json', op: 'modify', ok: true },
    ]);
  });

  it('pre-task: agent kind', () => {
    assert.equal(normalize('claude', 'pre-task').toolKind, 'agent');
  });

  it('pre-todowrite: plan kind', () => {
    assert.equal(normalize('claude', 'pre-todowrite').toolKind, 'plan');
  });

  it('user-prompt-submit / stop / session-start basics', () => {
    assert.equal(
      normalize('claude', 'user-prompt-submit').prompt,
      '/work GH-123 continue the implementation'
    );
    assert.equal(normalize('claude', 'stop').stopHookActive, false);
    assert.equal(normalize('claude', 'session-start').source, 'startup');
  });

  it('subagent-stop: /subagents/ transcript path marks subagent context', () => {
    const evt = normalize('claude', 'subagent-stop');
    assert.equal(isSubagentContext(evt), true);
    assert.equal(isSubagentContext(normalize('claude', 'stop')), false);
  });

  // GH-696: claude payloads fired inside a subagent can carry agent identity
  // in the RAW payload without a /subagents/ transcript path.
  it('claude native agent_type/agent_id in the raw payload marks subagent context (GH-696)', () => {
    const byType = normalizeHookPayload(
      { tool_name: 'Bash', transcript_path: '/tmp/t.jsonl', agent_type: 'pr-generator' },
      { runtime: 'claude' }
    );
    assert.equal(isSubagentContext(byType), true);
    const byId = normalizeHookPayload(
      { tool_name: 'Bash', transcript_path: '/tmp/t.jsonl', agent_id: 'agent-42' },
      { runtime: 'claude' }
    );
    assert.equal(isSubagentContext(byId), true);
  });

  // GH-696 scoping pin: never read env-folded evt.agent.type — CLAUDE_AGENT_TYPE
  // leaks via tmux global env and would permanently mute a main session.
  it('claude env-folded CLAUDE_AGENT_TYPE alone is NOT a subagent context (GH-696)', () => {
    process.env.CLAUDE_AGENT_TYPE = 'developer-nodejs-tdd';
    try {
      const evt = normalizeHookPayload(
        { tool_name: 'Bash', transcript_path: '/tmp/t.jsonl' },
        { runtime: 'claude' }
      );
      assert.equal(evt.agent.type, 'developer-nodejs-tdd'); // env fold still surfaces it
      assert.equal(isSubagentContext(evt), false);
    } finally {
      delete process.env.CLAUDE_AGENT_TYPE;
    }
  });

  // GH-696 (PR #718): CLAUDE_CURRENT_AGENT is the SAME tmux global-env leak
  // class — an env-only signal must never mute auto-advance in a main session.
  // Subagent identity comes from the raw payload or the /subagents/ transcript
  // path, never from the process environment.
  it('claude env CLAUDE_CURRENT_AGENT alone is NOT a subagent context (GH-696)', () => {
    process.env.CLAUDE_CURRENT_AGENT = 'pr-generator';
    try {
      const evt = normalizeHookPayload(
        { tool_name: 'Bash', transcript_path: '/tmp/t.jsonl' },
        { runtime: 'claude' }
      );
      assert.equal(isSubagentContext(evt), false);
    } finally {
      delete process.env.CLAUDE_CURRENT_AGENT;
    }
  });

  it('claude env CLAUDE_CURRENT_AGENT plus native payload identity IS a subagent context', () => {
    process.env.CLAUDE_CURRENT_AGENT = 'pr-generator';
    try {
      const evt = normalizeHookPayload(
        { tool_name: 'Bash', transcript_path: '/tmp/t.jsonl', agent_type: 'pr-generator' },
        { runtime: 'claude' }
      );
      assert.equal(isSubagentContext(evt), true);
    } finally {
      delete process.env.CLAUDE_CURRENT_AGENT;
    }
  });
});

describe('normalizeHookPayload — defensive shapes', () => {
  it('opts.event and CLAUDE_HOOK_TYPE fallbacks resolve the event', () => {
    assert.equal(normalizeHookPayload({}, { event: 'Stop' }).event, 'Stop');
    process.env.CLAUDE_HOOK_TYPE = 'PreToolUse';
    try {
      assert.equal(normalizeHookPayload({}).event, 'PreToolUse');
    } finally {
      delete process.env.CLAUDE_HOOK_TYPE;
    }
  });

  it('object tool_response without stdout/stderr stringifies', () => {
    const evt = normalizeHookPayload(
      { tool_name: 'mcp__x__y', tool_response: { ok: true } },
      { runtime: 'claude', event: 'PostToolUse' }
    );
    assert.equal(evt.toolKind, 'mcp');
    assert.equal(evt.toolResponseText, '{"ok":true}');
  });

  it('non-object payloads normalize to a safe empty event', () => {
    const evt = normalizeHookPayload(null, { runtime: 'codex' });
    assert.equal(evt.rawToolName, null);
    assert.deepEqual(evt.writeTargets, []);
    assert.equal(evt.prompt, null);
  });

  it('numeric-string exit codes coerce (locked posttool read order)', () => {
    const evt = normalizeHookPayload(
      { tool_name: 'Bash', tool_response: { stdout: '', exit_code: '3' } },
      { runtime: 'claude', event: 'PostToolUse' }
    );
    assert.equal(evt.toolExitCode, 3);
  });
});
