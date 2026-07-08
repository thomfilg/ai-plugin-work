'use strict';

/**
 * WP-05: dispatcher end-to-end over codex stdin fixtures (same spawn harness
 * as dispatcher-enforce.integration.test.js, isolated tmp HOME).
 *
 * Pins the dual-runtime contract:
 *   - an `Edit:` memory injects on a codex apply_patch PreToolUse payload via
 *     the alias hop, in the SAME additionalContext envelope the claude path
 *     emits (the envelope shape is already codex-valid — design §D);
 *   - the same store fires identically on the equivalent claude Edit payload
 *     (no behavior fork);
 *   - `enforce: block` emits the UNCHANGED deny envelope on a codex payload;
 *   - a trigger_stop_response memory fires on the codex Stop payload's
 *     last_assistant_message;
 *   - the SessionStart setup hint renders through the vocabulary layer
 *     (byte-identical on claude, `$skill` mention + request_user_input on
 *     codex).
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DISPATCHER = path.resolve(__dirname, '..', 'synapsys.js');
const SETUP_HINTS = require(path.resolve(__dirname, '..', '..', 'lib', 'setup-hints'));

const DOTCLAUDE_PATCH =
  '*** Begin Patch\n*** Update File: .claude/settings.json\n+{"hooks": []}\n*** End Patch\n';

function writeMemory(dir, file, frontmatter, body) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  fs.writeFileSync(path.join(dir, file), `---\n${fm}\n---\n${body}`);
}

function runDispatcher({ event = 'PreToolUse', payload, home, env = {} }) {
  const res = spawnSync(process.execPath, [DISPATCHER, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      SYNAPSYS_NO_SETUP_HINT: '1',
      SYNAPSYS_TELEMETRY: '1',
      CLAUDE_CODE_SESSION_ID: '',
      // Keep runtime detection payload/env-driven and deterministic in tests.
      AGENT_RUNTIME: '',
      CODEX_THREAD_ID: '',
      PLUGIN_ROOT: '',
      ...env,
    },
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

function setupFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-codex-e2e-'));
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'project');
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ kind: 'local', projectName: 'codex-e2e-fixture', schemaVersion: 1 })
  );
  return { base, home, cwd, storeDir };
}

// Real codex PreToolUse envelope shape (probe capture pre-apply-patch.json),
// re-keyed onto the fixture cwd.
function codexApplyPatchPayload(cwd, sessionId) {
  return {
    session_id: sessionId,
    turn_id: '019f3c4e-0fa1-7db2-8979-a470735cf498',
    cwd,
    hook_event_name: 'PreToolUse',
    model: 'gpt-5.5',
    permission_mode: 'bypassPermissions',
    tool_name: 'apply_patch',
    tool_input: { command: DOTCLAUDE_PATCH },
    tool_use_id: 'call_DHHGzmcYvfXtIIYeL6gIhjxO',
  };
}

function claudeEditPayload(cwd, sessionId) {
  return {
    session_id: sessionId,
    cwd,
    hook_event_name: 'PreToolUse',
    permission_mode: 'default',
    tool_name: 'Edit',
    tool_input: { file_path: `${cwd}/.claude/settings.json`, new_string: '{"hooks": []}' },
  };
}

function parseEnvelope(stdout) {
  assert.notEqual(stdout, '', 'expected dispatcher to emit hook JSON, got empty stdout');
  const parsed = JSON.parse(stdout);
  assert.equal(typeof parsed.hookSpecificOutput, 'object');
  return parsed.hookSpecificOutput;
}

describe('dispatcher codex dual-runtime e2e (WP-05)', () => {
  let fixture;

  beforeEach(() => {
    fixture = setupFixture();
  });

  function writeDotclaudeMemory() {
    writeMemory(
      fixture.storeDir,
      'dotclaude-edits.md',
      {
        name: 'dotclaude-edits',
        description: 'reminder for .claude edits',
        events: 'PreToolUse',
        trigger_pretool: 'Edit:\\.claude/',
        trigger_session: 'false',
        inject: 'full',
      },
      'DOTCLAUDE-EDIT-REMINDER'
    );
  }

  it('an Edit: memory injects on a codex apply_patch payload (alias hop, envelope)', () => {
    writeDotclaudeMemory();
    const r = runDispatcher({
      payload: codexApplyPatchPayload(fixture.cwd, 'codex-e2e-1'),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);
    const out = parseEnvelope(r.stdout);
    assert.equal(out.hookEventName, 'PreToolUse');
    assert.match(out.additionalContext, /DOTCLAUDE-EDIT-REMINDER/);
    assert.equal(out.permissionDecision, undefined, 'advisory injection must not deny');
  });

  it('the same store fires identically on the equivalent claude Edit payload', () => {
    writeDotclaudeMemory();
    const r = runDispatcher({
      payload: claudeEditPayload(fixture.cwd, 'claude-e2e-1'),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);
    const out = parseEnvelope(r.stdout);
    assert.equal(out.hookEventName, 'PreToolUse');
    assert.match(out.additionalContext, /DOTCLAUDE-EDIT-REMINDER/);
  });

  it('a Bash: memory stays silent on the codex apply_patch payload', () => {
    writeMemory(
      fixture.storeDir,
      'bash-only.md',
      {
        name: 'bash-only',
        description: 'bash-scoped memory',
        events: 'PreToolUse',
        trigger_pretool: 'Bash:patch',
        trigger_session: 'false',
        inject: 'full',
      },
      'BASH-ONLY-BODY'
    );
    const r = runDispatcher({
      payload: codexApplyPatchPayload(fixture.cwd, 'codex-e2e-2'),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);
    assert.equal(r.stdout, '', 'no memory matched — dispatcher must stay silent');
  });

  it('enforce: block emits the unchanged deny envelope on a codex payload', () => {
    writeMemory(
      fixture.storeDir,
      'patch-block.md',
      {
        name: 'patch-block',
        description: 'block .claude patches',
        events: 'PreToolUse',
        trigger_pretool: 'Edit:\\.claude/',
        trigger_session: 'false',
        inject: 'full',
        enforce: 'block',
      },
      'PATCH-BLOCK-BODY'
    );
    const r = runDispatcher({
      payload: codexApplyPatchPayload(fixture.cwd, 'codex-e2e-3'),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);
    const out = parseEnvelope(r.stdout);
    assert.equal(out.hookEventName, 'PreToolUse');
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /^\[synapsys:block\] patch-block\n/);
    assert.match(out.permissionDecisionReason, /PATCH-BLOCK-BODY/);
    assert.equal(out.additionalContext, undefined, 'a deny must not mix in additionalContext');
  });

  it('a trigger_stop_response memory fires on the codex Stop payload', () => {
    writeMemory(
      fixture.storeDir,
      'stop-review.md',
      {
        name: 'stop-review',
        description: 'end-of-turn review reminder',
        events: 'Stop',
        trigger_stop_response: 'ready for review',
        trigger_session: 'false',
        inject: 'full',
      },
      'STOP-REVIEW-BODY'
    );
    const r = runDispatcher({
      event: 'Stop',
      payload: {
        session_id: 'codex-e2e-4',
        turn_id: '019f3c4e-0fa1-7db2-8979-a470735cf498',
        cwd: fixture.cwd,
        hook_event_name: 'Stop',
        permission_mode: 'bypassPermissions',
        stop_hook_active: false,
        last_assistant_message: 'All checks passed. The follow-up PR is ready for review.',
      },
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);
    assert.match(r.stdout, /STOP-REVIEW-BODY/, 'Stop injections stay raw stdout (not enveloped)');
  });

  it('SessionStart setup hint is byte-identical on claude and vocab-rendered on codex', () => {
    // No store dir at all — the setup-required hint fires.
    const bareCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-codex-barecwd-'));
    const base = { cwd: bareCwd, hook_event_name: 'SessionStart', source: 'startup' };

    const claude = runDispatcher({
      event: 'SessionStart',
      payload: { ...base, session_id: 'claude-hint-1' },
      home: fixture.home,
      env: { SYNAPSYS_NO_SETUP_HINT: '' },
    });
    assert.equal(claude.status, 0, `dispatcher failed: ${claude.stderr}`);
    assert.equal(
      claude.stdout,
      SETUP_HINTS.SETUP_REQUIRED_HINT,
      'claude hint is the exact literal'
    );

    const codex = runDispatcher({
      event: 'SessionStart',
      payload: { ...base, session_id: 'codex-hint-1' },
      home: fixture.home,
      env: { SYNAPSYS_NO_SETUP_HINT: '', AGENT_RUNTIME: 'codex' },
    });
    assert.equal(codex.status, 0, `dispatcher failed: ${codex.stderr}`);
    assert.match(codex.stdout, /the \$install skill \(synapsys:install\)/);
    assert.match(codex.stdout, /request_user_input/);
    assert.doesNotMatch(codex.stdout, /AskUserQuestion/);
  });
});
