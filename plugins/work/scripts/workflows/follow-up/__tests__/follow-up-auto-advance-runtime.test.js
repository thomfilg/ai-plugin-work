'use strict';

/**
 * Dual-runtime tests for follow-up-auto-advance.js (WP-06), which exercises
 * the shared lib/auto-advance.js drivetrain end-to-end.
 *
 * The claude snapshots below are the pre-port stdout bytes captured at HEAD
 * with the same stub instructions — the port must not change a single byte.
 * Codex asserts the PostToolUse additionalContext envelope carrying the
 * identical banner text.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.resolve(__dirname, '..', 'hooks', 'follow-up-auto-advance.js');
const MARKER = '.follow-up-orchestrator.pid';

const EXECUTE_INSTRUCTION = {
  action: 'execute',
  step: 'monitor',
  payload: { note: 'char-fixture' },
};
const SURFACE_INSTRUCTION = { action: 'surface', payload: { reason: 'infra-stuck' } };

// Pre-port claude stdout bytes (characterization capture at HEAD).
const CLAUDE_EXECUTE_BYTES = `\n═══ FOLLOW-UP2: NEXT STEP ═══\n${JSON.stringify(
  EXECUTE_INSTRUCTION,
  null,
  2
)}\n══════════════════════════════\n\n`;
const CLAUDE_SURFACE_BYTES = `\n═══ FOLLOW-UP2: SURFACE ═══\nreason: infra-stuck\n${JSON.stringify(
  SURFACE_INSTRUCTION,
  null,
  2
)}\n═══════════════════════════\n\n`;

function parseEnvelope(stdout) {
  const parsed = JSON.parse(stdout);
  assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(parsed.hookSpecificOutput).sort(), [
    'additionalContext',
    'hookEventName',
  ]);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
  return parsed.hookSpecificOutput.additionalContext;
}

describe('follow-up-auto-advance — dual runtime', () => {
  let base;
  let stubPath;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-aa-rt-'));
    const dir = path.join(base, 'tasks', 'AAA-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, MARKER),
      JSON.stringify({
        ticket: 'AAA-1',
        startedAt: new Date().toISOString(),
        workflow: '/follow-up',
      })
    );
    stubPath = path.join(base, 'stub-next.js');
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  function stubNext(instruction) {
    fs.writeFileSync(
      stubPath,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(instruction))});\n`
    );
  }

  function runHook(payload, env = {}) {
    const merged = {
      ...process.env,
      HOME: base,
      TASKS_BASE: path.join(base, 'tasks'),
      WORKTREES_BASE: base,
      FOLLOW_UP_NEXT_PATH: stubPath,
      ...env,
    };
    delete merged.NODE_TEST_CONTEXT;
    for (const key of ['AGENT_RUNTIME', 'AGENT_SESSION_ID', 'CODEX_THREAD_ID', 'PLUGIN_ROOT']) {
      if (!(key in env)) delete merged[key];
    }
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 20000,
      env: merged,
    });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  it('claude execute: stdout byte-identical to the HEAD characterization capture', () => {
    stubNext(EXECUTE_INSTRUCTION);
    const r = runHook(
      { tool_name: 'Task', transcript_path: '/tmp/t.jsonl', session_id: 'sess-1' },
      { AGENT_RUNTIME: 'claude', CLAUDE_CODE_SESSION_ID: 'sess-1' }
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, CLAUDE_EXECUTE_BYTES);
  });

  it('claude surface: reason line + banner byte-identical to the HEAD capture', () => {
    stubNext(SURFACE_INSTRUCTION);
    const r = runHook(
      { tool_name: 'Task', transcript_path: '/tmp/t.jsonl', session_id: 'sess-1' },
      { AGENT_RUNTIME: 'claude', CLAUDE_CODE_SESSION_ID: 'sess-1' }
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, CLAUDE_SURFACE_BYTES);
  });

  it('codex execute: envelope carries the identical banner text', () => {
    stubNext(EXECUTE_INSTRUCTION);
    const r = runHook(
      {
        tool_name: 'Bash',
        turn_id: 't-1',
        transcript_path: '/tmp/h/sessions/2026/07/07/rollout-x.jsonl',
        session_id: 'sess-1',
      },
      { AGENT_RUNTIME: 'codex' }
    );
    assert.equal(r.code, 0);
    assert.equal(`${parseEnvelope(r.stdout)}\n`, CLAUDE_EXECUTE_BYTES);
  });

  it('codex still persists the instruction file for the Stop-hook surface', () => {
    stubNext(EXECUTE_INSTRUCTION);
    const r = runHook(
      {
        tool_name: 'Bash',
        turn_id: 't-1',
        transcript_path: '/tmp/h/sessions/2026/07/07/rollout-x.jsonl',
        session_id: 'sess-1',
      },
      { AGENT_RUNTIME: 'codex' }
    );
    assert.equal(r.code, 0);
    const persisted = path.join(base, 'tasks', 'AAA-1', '.follow-up-next.json');
    assert.ok(fs.existsSync(persisted), 'state-file fallback must survive the codex port');
  });
});
