'use strict';

/**
 * Dual-runtime e2e: the enforce-step-workflow write-gate (Rule 3, protected
 * workflow state files) must fire on the codex `apply_patch` payload shape —
 * the Edit|Write matcher lanes alias-fire for apply_patch, whose tool_input
 * is a raw patch with no file_path (WP-07/C6).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnHook } = require(
  path.resolve(__dirname, '..', '..', '__tests__', '_helpers', 'run-hook')
);

const HOOK_PATH = path.resolve(__dirname, '..', 'enforce-step-workflow.js');
const TICKET = `TEST-ESWAP-${process.pid}`;

function patch(headers) {
  return `*** Begin Patch\n${headers.join('\n')}\n+content line\n*** End Patch\n`;
}

describe('enforce-step-workflow — codex apply_patch write gate', () => {
  let tmp;
  let tasksBase;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esw-apply-patch-'));
    tasksBase = path.join(tmp, 'tasks');
    fs.mkdirSync(path.join(tasksBase, TICKET), { recursive: true });
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function runHook(payload, env = {}) {
    return spawnHook(HOOK_PATH, payload, {
      CLAUDE_HOOK_TYPE: 'PreToolUse',
      ENFORCE_HOOK_TICKET_ID: TICKET,
      TASKS_BASE: tasksBase,
      WORKTREES_BASE: tmp,
      TICKET_PROJECT_KEY: 'TEST',
      ...env,
    });
  }

  function codexPayload(command) {
    return {
      session_id: 'sess-1',
      turn_id: 't-1',
      cwd: tmp,
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command },
    };
  }

  it('blocks an apply_patch touching .work-state.json', async () => {
    const r = await runHook(
      codexPayload(patch([`*** Update File: tasks/${TICKET}/.work-state.json`])),
      { AGENT_RUNTIME: 'codex' }
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /BLOCKED: Direct apply_patch to \.work-state\.json/);
    assert.match(r.stderr, /designated scripts|orchestrator\/workflow-engine/);
  });

  it('blocks an apply_patch touching the follow-up evidence state', async () => {
    const r = await runHook(
      codexPayload(patch([`*** Update File: tasks/${TICKET}/.follow-up-state.json`])),
      { AGENT_RUNTIME: 'codex' }
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /\.follow-up-state\.json/);
  });

  it('allows an apply_patch touching regular source files', async () => {
    const r = await runHook(codexPayload(patch(['*** Add File: src/feature.js'])), {
      AGENT_RUNTIME: 'codex',
    });
    assert.equal(r.code, 0);
  });

  it('fails OPEN on an unparseable patch (advisory gate, C6)', async () => {
    const r = await runHook(codexPayload('definitely not a patch'), {
      AGENT_RUNTIME: 'codex',
    });
    assert.equal(r.code, 0);
  });

  it('claude Write to .work-state.json still blocks (characterization)', async () => {
    const r = await runHook(
      {
        session_id: 'sess-1',
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: {
          file_path: path.join(tasksBase, TICKET, '.work-state.json'),
          content: '{}',
        },
      },
      { AGENT_RUNTIME: 'claude' }
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /BLOCKED: Direct Write to \.work-state\.json/);
  });
});
