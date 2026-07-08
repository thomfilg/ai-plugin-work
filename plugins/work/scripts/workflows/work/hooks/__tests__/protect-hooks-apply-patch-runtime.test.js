'use strict';

/**
 * Dual-runtime e2e tests for the protect-* PreToolUse hooks (WP-07/C6).
 *
 * On codex the Edit|Write matcher lanes alias-fire for `apply_patch` with a
 * raw-patch payload (no file_path). Each hook must derive the write targets
 * from the patch headers and apply its existing rules:
 *   - protect-tasks-md: blocks a patch touching the ROOT tasks.md outside
 *     the allowed steps; subfolder tasks.md patches stay allowed (GH-309).
 *   - protect-orchestrator-state: blocks patches touching orchestrator-
 *     managed state files; unparseable patches fail OPEN (advisory hook).
 *   - protect-gherkin: blocks patches touching gherkin.feature outside spec.
 *   - protect-task-scope: unit-level — every parsed target runs the scope
 *     decision (Gate D).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TASKS_MD_HOOK = path.resolve(__dirname, '..', 'protect-tasks-md.js');
const ORCH_STATE_HOOK = path.resolve(__dirname, '..', 'protect-orchestrator-state.js');
const GHERKIN_HOOK = path.resolve(__dirname, '..', 'protect-gherkin.js');

const TICKET = `TEST-APR-${process.pid}`;

function patch(headers) {
  return `*** Begin Patch\n${headers.join('\n')}\n+content line\n*** End Patch\n`;
}

describe('protect-* hooks — codex apply_patch vector', () => {
  let tmp;
  let tasksBase;
  let ticketDir;
  let envBase;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protect-apply-patch-'));
    tasksBase = path.join(tmp, 'tasks');
    ticketDir = path.join(tasksBase, TICKET);
    fs.mkdirSync(path.join(ticketDir, 'flaky-tests'), { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ status: 'in_progress', stepStatus: { implement: 'in_progress' } })
    );
    fs.writeFileSync(path.join(ticketDir, 'tasks.md'), '## Task 1\n');
    fs.writeFileSync(path.join(ticketDir, 'gherkin.feature'), 'Feature: x\n');
    envBase = {
      WORKTREES_BASE: tmp,
      TASKS_BASE: tasksBase,
      REPO_NAME: 'my-project',
      TICKET_PROJECT_KEY: 'TEST',
      TICKET_PROVIDER: '',
      JIRA_PROJECT_KEY: '',
      TICKET_ID: TICKET,
    };
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function runHook(hook, payload, env = {}) {
    const merged = { ...process.env, ...envBase, ...env };
    for (const key of ['AGENT_RUNTIME', 'AGENT_SESSION_ID', 'CODEX_THREAD_ID', 'PLUGIN_ROOT']) {
      if (!(key in env)) delete merged[key];
    }
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      cwd: tmp,
      timeout: 15000,
      env: merged,
    });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
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

  describe('protect-tasks-md', () => {
    it('blocks an apply_patch touching the root tasks.md during implement', () => {
      const r = runHook(
        TASKS_MD_HOOK,
        codexPayload(patch([`*** Update File: ${path.join(ticketDir, 'tasks.md')}`])),
        { AGENT_RUNTIME: 'codex' }
      );
      assert.equal(r.code, 2);
      assert.match(r.stderr, /BLOCKED: Cannot write tasks\.md/);
    });

    it('allows an apply_patch touching only a SUBFOLDER tasks.md (GH-309)', () => {
      const r = runHook(
        TASKS_MD_HOOK,
        codexPayload(
          patch([`*** Update File: ${path.join(ticketDir, 'flaky-tests', 'tasks.md')}`])
        ),
        { AGENT_RUNTIME: 'codex' }
      );
      assert.equal(r.code, 0);
    });

    it('claude Edit to root tasks.md still blocks (characterization)', () => {
      const r = runHook(
        TASKS_MD_HOOK,
        {
          session_id: 'sess-1',
          hook_event_name: 'PreToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: path.join(ticketDir, 'tasks.md'), old_string: 'a' },
        },
        { AGENT_RUNTIME: 'claude' }
      );
      assert.equal(r.code, 2);
      assert.match(r.stderr, /BLOCKED: Cannot write tasks\.md/);
    });
  });

  describe('protect-orchestrator-state', () => {
    it('blocks an apply_patch touching .work-state.json (relative target)', () => {
      const r = runHook(
        ORCH_STATE_HOOK,
        codexPayload(patch([`*** Update File: tasks/${TICKET}/.work-state.json`])),
        { AGENT_RUNTIME: 'codex' }
      );
      assert.equal(r.code, 2);
      assert.match(r.stderr, /orchestrator-managed/);
      assert.match(r.stderr, /vector: apply_patch/);
    });

    it('blocks a multi-file patch when ONE target is orchestrator-managed', () => {
      const r = runHook(
        ORCH_STATE_HOOK,
        codexPayload(patch(['*** Add File: src/ok.js', `*** Update File: task1/tdd-phase.json`])),
        { AGENT_RUNTIME: 'codex' }
      );
      assert.equal(r.code, 2);
      assert.match(r.stderr, /tdd-phase\.json/);
    });

    it('fails OPEN on an unparseable apply_patch payload (advisory hook)', () => {
      const r = runHook(ORCH_STATE_HOOK, codexPayload('not a patch'), {
        AGENT_RUNTIME: 'codex',
      });
      assert.equal(r.code, 0);
    });

    it('allows an apply_patch touching only regular source files', () => {
      const r = runHook(ORCH_STATE_HOOK, codexPayload(patch(['*** Add File: src/feature.js'])), {
        AGENT_RUNTIME: 'codex',
      });
      assert.equal(r.code, 0);
    });
  });

  describe('protect-gherkin', () => {
    it('blocks an apply_patch touching gherkin.feature outside the spec step', () => {
      const r = runHook(
        GHERKIN_HOOK,
        codexPayload(patch([`*** Update File: ${path.join(ticketDir, 'gherkin.feature')}`])),
        { AGENT_RUNTIME: 'codex' }
      );
      assert.equal(r.code, 2);
      assert.match(r.stderr, /Cannot write gherkin\.feature/);
      assert.match(r.stderr, /BYPASS: edit gherkin\.feature via \/work spec_gate/);
    });
  });
});

describe('protect-task-scope — apply_patch targets (unit)', () => {
  const { evaluateTool, extractApplyPatchWriteTargets } = require(
    path.resolve(__dirname, '..', 'protect-task-scope.js')
  );

  const active = {
    taskNum: 1,
    label: 'Task 1 — scope test',
    filesInScope: ['src/allowed/**'],
    filesOutOfScope: ['src/forbidden/**'],
    crossTaskDeps: [],
    type: '',
  };

  it('extracts every parsed patch target and drops unparseable ones', () => {
    assert.deepEqual(
      extractApplyPatchWriteTargets({
        command: patch(['*** Add File: a.js', '*** Update File: b/c.js']),
      }),
      ['a.js', 'b/c.js']
    );
    assert.deepEqual(extractApplyPatchWriteTargets({ command: 'garbage' }), []);
  });

  it('blocks an apply_patch whose target is out of the task scope', () => {
    const decision = evaluateTool(
      'apply_patch',
      { command: patch(['*** Update File: src/forbidden/x.js']) },
      active,
      '/repo'
    );
    assert.ok(decision);
    assert.equal(decision.blocked, true);
  });

  it('allows an apply_patch whose targets are all in scope', () => {
    const decision = evaluateTool(
      'apply_patch',
      { command: patch(['*** Update File: src/allowed/x.js']) },
      active,
      '/repo'
    );
    assert.equal(decision, null);
  });
});
