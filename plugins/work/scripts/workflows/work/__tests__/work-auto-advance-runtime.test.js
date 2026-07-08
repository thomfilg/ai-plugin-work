'use strict';

/**
 * Dual-runtime tests for work-auto-advance.js (WP-06).
 *
 * Claude branch is pinned byte-identical to the pre-port console.log sequence
 * (characterization snapshot); codex rides the PostToolUse
 * hookSpecificOutput.additionalContext envelope with the identical banner
 * text. Subagent guard matrix: claude /subagents/ transcript path, codex
 * agent_id. Child spawns get AGENT_RUNTIME/AGENT_SESSION_ID bridged.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'hooks', 'work-auto-advance.js');

const INSTRUCTION = { action: 'execute', step: 'implement' };
// Byte-identical snapshot of the pre-port claude stdout for action:execute.
const CLAUDE_EXECUTE_BYTES = `\n═══ WORK2: NEXT STEP ═══\n${JSON.stringify(
  INSTRUCTION,
  null,
  2
)}\n════════════════════════\n\n`;

// Structural validation of the codex PostToolUse output envelope
// (ground truth §2.6.4/§2.6.5: hookSpecificOutput + additionalContext).
function parseEnvelope(stdout) {
  const parsed = JSON.parse(stdout);
  assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(parsed.hookSpecificOutput).sort(), [
    'additionalContext',
    'hookEventName',
  ]);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(typeof parsed.hookSpecificOutput.additionalContext, 'string');
  return parsed.hookSpecificOutput.additionalContext;
}

describe('work-auto-advance — dual runtime', () => {
  let base;
  let stubPath;
  let envBase;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'work-aa-rt-'));
    const dir = path.join(base, 'tasks', 'AAA-2');
    fs.mkdirSync(dir, { recursive: true });
    // Legacy marker (no owner identity) — never foreign for any caller.
    fs.writeFileSync(
      path.join(dir, '.work.pid'),
      JSON.stringify({ ticket: 'AAA-2', startedAt: new Date().toISOString() })
    );
    stubPath = path.join(base, 'stub-work-next.js');
    // Stub echoes the bridged env so tests can assert the child saw it.
    fs.writeFileSync(
      stubPath,
      '#!/usr/bin/env node\n' +
        'process.stdout.write(JSON.stringify({ action: "execute", step: "implement", ' +
        'bridge: { runtime: process.env.AGENT_RUNTIME || null, sessionId: process.env.AGENT_SESSION_ID || null } }));\n'
    );
    envBase = {
      HOME: base,
      TASKS_BASE: path.join(base, 'tasks'),
      WORKTREES_BASE: base,
      WORK_NEXT_PATH: stubPath,
    };
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  function runHook(payload, env = {}) {
    const merged = { ...process.env, ...envBase, ...env };
    // Scrub ambient runtime signals so each row controls detection fully.
    for (const key of ['AGENT_RUNTIME', 'AGENT_SESSION_ID', 'CODEX_THREAD_ID', 'PLUGIN_ROOT']) {
      if (!(key in env)) delete merged[key];
    }
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 15000,
      env: merged,
    });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  it('claude: banner stdout is byte-identical to the pre-port console.log sequence', () => {
    // Stub without the bridge fields so the JSON matches the snapshot exactly.
    fs.writeFileSync(
      stubPath,
      '#!/usr/bin/env node\n' +
        `process.stdout.write(${JSON.stringify(JSON.stringify(INSTRUCTION))});\n`
    );
    const r = runHook(
      { tool_name: 'Task', transcript_path: '/tmp/t.jsonl', session_id: 'sess-1' },
      { AGENT_RUNTIME: 'claude', CLAUDE_CODE_SESSION_ID: 'sess-1' }
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, CLAUDE_EXECUTE_BYTES);
  });

  it('codex: instruction rides the additionalContext envelope with identical banner text', () => {
    fs.writeFileSync(
      stubPath,
      '#!/usr/bin/env node\n' +
        `process.stdout.write(${JSON.stringify(JSON.stringify(INSTRUCTION))});\n`
    );
    const r = runHook(
      {
        tool_name: 'Bash',
        turn_id: '019f3c4e-0fa1-7db2-8979-a470735cf498',
        transcript_path: '/tmp/h/sessions/2026/07/07/rollout-x.jsonl',
        session_id: 'sess-1',
      },
      { AGENT_RUNTIME: 'codex' }
    );
    assert.equal(r.code, 0);
    const context = parseEnvelope(r.stdout);
    assert.equal(`${context}\n`, CLAUDE_EXECUTE_BYTES);
  });

  it('codex without an env pin: rollout payload sniff still selects the envelope', () => {
    const r = runHook({
      tool_name: 'Bash',
      turn_id: '019f3c4e-0fa1-7db2-8979-a470735cf498',
      transcript_path: '/tmp/h/sessions/2026/07/07/rollout-x.jsonl',
      session_id: 'sess-1',
    });
    assert.equal(r.code, 0);
    parseEnvelope(r.stdout);
  });

  it('bridges AGENT_RUNTIME/AGENT_SESSION_ID to the work-next child', () => {
    const r = runHook(
      {
        tool_name: 'Bash',
        turn_id: 't-1',
        transcript_path: '/tmp/h/sessions/2026/07/07/rollout-x.jsonl',
        session_id: 'sess-bridge',
      },
      { AGENT_RUNTIME: 'codex' }
    );
    assert.equal(r.code, 0);
    const instruction = JSON.parse(parseEnvelope(r.stdout).split('\n').slice(2, -2).join('\n'));
    assert.deepEqual(instruction.bridge, { runtime: 'codex', sessionId: 'sess-bridge' });
  });

  it('subagent guard: claude /subagents/ transcript path is silent', () => {
    const r = runHook(
      { tool_name: 'Task', transcript_path: '/x/subagents/y.jsonl', session_id: 'sess-1' },
      { AGENT_RUNTIME: 'claude' }
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  });

  it('subagent guard: codex agent_id is silent', () => {
    const r = runHook(
      {
        tool_name: 'Bash',
        turn_id: 't-1',
        agent_id: 'agent-9',
        agent_type: 'worker',
        session_id: 'sess-1',
      },
      { AGENT_RUNTIME: 'codex' }
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  });
});
