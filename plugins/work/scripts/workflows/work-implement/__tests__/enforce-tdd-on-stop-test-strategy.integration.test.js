/**
 * enforce-tdd-on-stop.js — SubagentStop TDD gate (W1, implement-phase fix design).
 *
 * The hook is registered in hooks/hooks.json under `SubagentStop` (matcher `.*`)
 * and self-filters. Behavior pinned here:
 *
 *   - a runnable `### Test Strategy` with NO valid evidence BLOCKS the stop
 *     (exit 2) and points at task-next.js — the hook NEVER runs tests or
 *     records evidence (the legacy auto-record path is removed);
 *   - a valid completed RED→GREEN cycle allows the stop;
 *   - citation kinds (verified-by/wiring-citation) are satisfied by citation
 *     green evidence (validateTddEvidence, W4) — no command is executed;
 *   - a task with NO strategy resolution is allowed to stop, but the allow is
 *     AUDITED to .work-actions.json (action `tdd-stop-strategy-missing-allow`);
 *     a resolver ERROR takes the same audited-allow path with the distinct
 *     reason 'strategy resolution threw: <msg>';
 *   - non-implement sessions and non-developer subagents are unaffected;
 *   - gating requires POSITIVE developer identification: the payload's
 *     `agent_type` (documented SubagentStop identity field; agent_name /
 *     subagent_type as legacy fallbacks), else the structural developer
 *     dispatch-prompt marker in the subagent transcript's FIRST user message.
 *     Unidentifiable subagents are ALWAYS allowed to stop;
 *   - worktreeDir resolution prefers WORK_WORKTREE_DIR / work-state over cwd.
 *
 * Run with:
 *   node --test scripts/workflows/work-implement/__tests__/enforce-tdd-on-stop-test-strategy.integration.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'enforce-tdd-on-stop.js');
const HELPERS_PATH = path.join(__dirname, '..', 'hooks', 'enforce-tdd-on-stop-helpers.js');

let homeDir;
let tasksBase;
let worktreeDir;

function mkTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-stop-int-'));
  fs.mkdirSync(path.join(dir, 'worktrees', 'tasks'), { recursive: true });
  return dir;
}

/**
 * Spawn the SubagentStop hook the way Claude Code does: feed it the hook JSON
 * on stdin, with WORK_TICKET_ID + TASKS_BASE pointing at our temp fixtures.
 *
 * Worktree-related env vars from the host session are neutralized so the
 * hook's worktree resolution is driven by the fixture work state only.
 */
function runHook(ticket, { extraEnv = {}, hookInput = {}, cwd = null } = {}) {
  const env = {
    ...process.env,
    HOME: homeDir,
    TASKS_BASE: tasksBase,
    WORK_TICKET_ID: ticket,
    WORK_WORKTREE_DIR: '',
    WORKTREES_BASE: '',
    REPO_NAME: '',
    ...extraEnv,
  };
  const res = spawnSync(process.execPath, [HOOK_PATH], {
    encoding: 'utf8',
    cwd: cwd || worktreeDir,
    // Positive-identification default: unless a test overrides the identity
    // fields, spawn the hook the way current Claude Code does for a
    // developer subagent (SubagentStop payload carries `agent_type`).
    input: JSON.stringify({
      stop_hook_active: false,
      agent_type: 'work-workflow:developer-nodejs-tdd',
      ...hookInput,
    }),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    exitCode: typeof res.status === 'number' ? res.status : 1,
  };
}

function ticketDir(ticket) {
  return path.join(tasksBase, ticket);
}

function readDebug(ticket) {
  const p = path.join(ticketDir(ticket), 'debug.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function readActions(ticket) {
  const p = path.join(ticketDir(ticket), '.work-actions.json');
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Seed a `.work-state.json`. `stepStatus` defaults to implement in_progress;
// currentTaskIndex is 0-based (taskNum = idx + 1).
function writeWorkState(ticket, taskNum, { nTasks = taskNum, stepStatus = null, wtDir } = {}) {
  const dir = ticketDir(ticket);
  fs.mkdirSync(dir, { recursive: true });
  const tasks = Array.from({ length: nTasks }, (_, i) => ({ num: i + 1 }));
  fs.writeFileSync(
    path.join(dir, '.work-state.json'),
    JSON.stringify(
      {
        ticketId: ticket,
        stepStatus: stepStatus || { implement: 'in_progress' },
        worktreeDir: wtDir === undefined ? worktreeDir : wtDir,
        tasksMeta: { currentTaskIndex: taskNum - 1, tasks },
      },
      null,
      2
    )
  );
}

// Single-task tasks.md: a task carrying a `### Test Strategy` block.
function writeStrategyTasksMd(ticket, { strategyLines, scope = ['src/wiring.js'], type }) {
  const dir = ticketDir(ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'tasks.md'),
    [
      '## Task 1 — Strategy-authored task',
      '',
      '### Type',
      type || 'backend',
      '',
      '### Files in scope',
      ...scope.map((f) => `- ${f}`),
      '',
      '### Test Strategy',
      '```',
      ...strategyLines,
      '```',
      '',
    ].join('\n')
  );
}

// A citing task (Task 2) plus a peer (Task 1) whose unit entry covers Task 2's
// scope — the shape that yields a valid peer citation.
function writeCitationTasksMd(ticket, { citingKind }) {
  const dir = ticketDir(ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'tasks.md'),
    [
      '## Task 1 — Peer with real tests',
      '',
      '### Type',
      'backend',
      '',
      '### Files in scope',
      '- src/wiring.js',
      '',
      '### Test Strategy',
      '```',
      'kind: unit',
      'entry: src/wiring.test.js',
      '```',
      '',
      '## Task 2 — Citing task',
      '',
      '### Type',
      'backend',
      '',
      '### Files in scope',
      '- src/wiring.js',
      '',
      '### Test Strategy',
      '```',
      `kind: ${citingKind}`,
      'peer: Task 1',
      '```',
      '',
    ].join('\n')
  );
}

// A tasks.md with NO `### Test Strategy` block (legacy/broken artifact shape).
function writeBareTasksMd(ticket) {
  const dir = ticketDir(ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'tasks.md'),
    [
      '## Task 1 — Bare task',
      '',
      '### Type',
      'backend',
      '',
      '### Files in scope',
      '- src/x.js',
      '',
    ].join('\n')
  );
}

function writePhaseState(ticket, taskNum, state) {
  const dir = path.join(ticketDir(ticket), `task${taskNum}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tdd-phase.json'), JSON.stringify(state, null, 2));
}

// Pre-populate a completed citation cycle (green kind verified-by + peerSha).
function seedCitationGreenEvidence(ticket, taskNum) {
  writePhaseState(ticket, taskNum, {
    ticket,
    task: taskNum,
    currentPhase: 'refactor',
    currentCycle: 1,
    cycles: [
      {
        cycle: 1,
        red: {
          testFiles: ['src/wiring.test.js'],
          testCommand: 'false',
          testExitCode: 1,
          timestamp: new Date().toISOString(),
        },
        green: {
          kind: 'verified-by',
          peer: 'Task 1',
          peerSha: 'a'.repeat(40),
          scopeOverlap: true,
          recordedAt: new Date().toISOString(),
        },
      },
    ],
  });
}

// Pre-populate a completed real RED→GREEN cycle.
function seedCompleteCycleEvidence(ticket, taskNum) {
  writePhaseState(ticket, taskNum, {
    ticket,
    task: taskNum,
    currentPhase: 'refactor',
    currentCycle: 1,
    cycles: [
      {
        cycle: 1,
        red: {
          testFiles: ['src/wiring.test.js'],
          testCommand: 'node --test src/wiring.test.js',
          testExitCode: 1,
          timestamp: new Date().toISOString(),
        },
        green: {
          testCommand: 'node --test src/wiring.test.js',
          testExitCode: 0,
          timestamp: new Date().toISOString(),
        },
      },
    ],
  });
}

describe('enforce-tdd-on-stop — SubagentStop TDD gate (W1)', () => {
  beforeEach(() => {
    homeDir = mkTempHome();
    tasksBase = path.join(homeDir, 'worktrees', 'tasks');
    worktreeDir = path.join(homeDir, 'worktrees', 'wt');
    fs.mkdirSync(worktreeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  // (a) Runnable strategy + no evidence → block with the ONE next command;
  //     the hook must not auto-run tests, record evidence, or bypass.
  it('Synthesizable Test-Strategy task blocks the stop without recording evidence', () => {
    const ticket = 'TEST-STOP-SYNTH';
    writeWorkState(ticket, 1);
    writeStrategyTasksMd(ticket, {
      strategyLines: ['kind: integration', 'entry: src/wiring.test.js'],
    });

    const res = runHook(ticket);

    assert.equal(
      res.exitCode,
      2,
      `expected evidence-missing block (exit 2), got ${res.exitCode}\nstderr: ${res.stderr}`
    );
    // The block message names the single next command (task-next.js).
    assert.match(res.stderr, /STOP BLOCKED/);
    assert.match(res.stderr, /task-next\.js TEST-STOP-SYNTH task1/);
    // No fabrication: the hook must NOT have created any phase state.
    const phasePath = path.join(ticketDir(ticket), 'task1', 'tdd-phase.json');
    assert.ok(
      !fs.existsSync(phasePath),
      'the stop hook must never record TDD evidence (auto-record path removed)'
    );
    // And it must not have taken the no-strategy bypass.
    assert.doesNotMatch(readDebug(ticket), /no ### Test Strategy resolution/);
  });

  // (b) A valid completed RED→GREEN cycle allows the stop.
  it('Stop is allowed when a valid RED→GREEN cycle exists', () => {
    const ticket = 'TEST-STOP-VALID';
    writeWorkState(ticket, 1);
    writeStrategyTasksMd(ticket, {
      strategyLines: ['kind: unit', 'entry: src/wiring.test.js'],
    });
    seedCompleteCycleEvidence(ticket, 1);

    const res = runHook(ticket);

    assert.equal(
      res.exitCode,
      0,
      `valid cycle should allow stop (exit 0), got ${res.exitCode}\nstderr: ${res.stderr}`
    );
  });

  // Coverage-review finding 2 — the stop hook must apply the SAME
  // contract-aware validator the gate uses (validateTddEvidenceForType):
  // a TDD-exempt task holding only the gate's red-only non-TDD stub is a
  // COMPLETE record for its Type and must be allowed to stop, even though a
  // runnable verifier resolves.
  it('TDD-exempt (docs) task with the gate red-only stub is allowed to stop', () => {
    const ticket = 'TEST-STOP-DOCS-STUB';
    writeWorkState(ticket, 1);
    writeStrategyTasksMd(ticket, {
      type: 'docs',
      scope: ['README.md'],
      strategyLines: ['kind: custom', 'command: node verify-docs.js'],
    });
    // The exact stub gate-writer.js buildNonTddStub writes on a passing
    // pre-implement verifier for exempt Types.
    writePhaseState(ticket, 1, {
      currentPhase: 'green',
      currentCycle: 1,
      cycles: [
        {
          cycle: 1,
          red: {
            testCommand: 'node verify-docs.js',
            testExitCode: 0,
            timestamp: new Date().toISOString(),
            capturedByGate: true,
            note: 'RED skipped: task type "docs" does not require TDD.',
          },
        },
      ],
    });

    const res = runHook(ticket);

    assert.equal(
      res.exitCode,
      0,
      `docs task with the gate stub must be allowed to stop (exit 0), got ${res.exitCode}\nstderr: ${res.stderr}`
    );
    assert.equal(res.stderr, '', 'no block message for exempt-type stub evidence');
  });

  // The SAME red-only stub under a TDD-required Type still blocks — the
  // relaxation is contract-scoped, not a blanket loosening.
  it('TDD-required (tdd-code) task with only a red-only entry still blocks', () => {
    const ticket = 'TEST-STOP-TDD-REDONLY';
    writeWorkState(ticket, 1);
    writeStrategyTasksMd(ticket, {
      type: 'tdd-code',
      strategyLines: ['kind: unit', 'entry: src/wiring.test.js'],
    });
    writePhaseState(ticket, 1, {
      currentPhase: 'green',
      currentCycle: 1,
      cycles: [
        {
          cycle: 1,
          red: {
            testCommand: 'node --test src/wiring.test.js',
            testExitCode: 1,
            timestamp: new Date().toISOString(),
            capturedByGate: true,
          },
        },
      ],
    });

    const res = runHook(ticket);

    assert.equal(res.exitCode, 2, `red-only on tdd-code must block\nstderr: ${res.stderr}`);
    assert.match(res.stderr, /STOP BLOCKED/);
  });

  // (d) Citation-kind evidence satisfies the hook (W4 validator).
  it('Citation-kind task is satisfied by citation green evidence', () => {
    const ticket = 'TEST-STOP-CITE';
    writeWorkState(ticket, 2);
    writeCitationTasksMd(ticket, { citingKind: 'verified-by' });
    seedCitationGreenEvidence(ticket, 2);

    const res = runHook(ticket);

    assert.equal(
      res.exitCode,
      0,
      `citation green should satisfy the gate (exit 0), got ${res.exitCode}\nstderr: ${res.stderr}`
    );
  });

  // Citation-kind task WITHOUT evidence still blocks (no bypass).
  it('Citation-kind task without evidence blocks the stop', () => {
    const ticket = 'TEST-STOP-CITE-NONE';
    writeWorkState(ticket, 2);
    writeCitationTasksMd(ticket, { citingKind: 'verified-by' });

    const res = runHook(ticket);

    assert.equal(res.exitCode, 2, `expected citation block (exit 2)\nstderr: ${res.stderr}`);
    assert.match(res.stderr, /citation-kind/);
  });

  // (c) No-strategy task keeps the allow-stop bypass — but AUDITED.
  it('No-strategy task allows the stop and audits the bypass to .work-actions.json', () => {
    const ticket = 'TEST-STOP-LEGACY';
    writeWorkState(ticket, 1);
    writeBareTasksMd(ticket);

    const res = runHook(ticket);

    assert.equal(
      res.exitCode,
      0,
      `bare task must keep the allow-stop bypass (exit 0), got ${res.exitCode}\nstderr: ${res.stderr}`
    );
    // The bypass marker still lands in debug.md…
    assert.match(readDebug(ticket), /no ### Test Strategy resolution — evidence check skipped/);
    // …and, critically, a visible enforcement audit row exists.
    const rows = readActions(ticket);
    const audit = rows.find((r) => r.action === 'tdd-stop-strategy-missing-allow');
    assert.ok(audit, `expected tdd-stop-strategy-missing-allow row, got: ${JSON.stringify(rows)}`);
    assert.equal(audit.kind, 'enforcement');
    assert.equal(audit.allow, true);
    assert.equal(audit.task, 1);
    assert.match(audit.reason, /no ### Test Strategy resolution/);
  });

  // Bypass-review note 6 — a resolver ERROR (throw) is audited under the
  // DISTINCT reason 'strategy resolution threw: <msg>', not mislabeled as the
  // legacy 'no ### Test Strategy resolution' artifact. A custom strategy with
  // no command/body makes resolveTaskTestExecution throw (synthesis null for
  // a non-citation kind).
  it('Resolver throw is an audited allow with a distinct reason', () => {
    const ticket = 'TEST-STOP-RESOLVER-THROW';
    writeWorkState(ticket, 1);
    writeStrategyTasksMd(ticket, {
      strategyLines: ['kind: custom'],
    });

    const res = runHook(ticket);

    assert.equal(res.exitCode, 0, `resolver throw must fail-open to allow\n${res.stderr}`);
    const rows = readActions(ticket);
    const audit = rows.find((r) => r.action === 'tdd-stop-strategy-missing-allow');
    assert.ok(audit, `expected audited allow row, got: ${JSON.stringify(rows)}`);
    assert.match(audit.reason, /strategy resolution threw: /);
    assert.match(audit.reason, /Test Strategy synthesis returned null/);
    assert.doesNotMatch(audit.reason, /^no ### Test Strategy resolution/);
  });

  // (e) Non-implement sessions are unaffected.
  it('Non-implement sessions are unaffected (exit 0, no block, no audit)', () => {
    const ticket = 'TEST-STOP-NOTIMPL';
    writeWorkState(ticket, 1, { stepStatus: { implement: 'completed', check: 'in_progress' } });
    writeStrategyTasksMd(ticket, {
      strategyLines: ['kind: unit', 'entry: src/wiring.test.js'],
    });

    const res = runHook(ticket);

    assert.equal(res.exitCode, 0, `non-implement step must exit 0\nstderr: ${res.stderr}`);
    assert.equal(readActions(ticket).length, 0, 'no audit rows outside implement');
  });

  // Self-filter: a positively-identified non-developer subagent is never gated.
  it('Non-developer subagents are not gated (exit 0 fast)', () => {
    const ticket = 'TEST-STOP-NONDEV';
    writeWorkState(ticket, 1);
    writeStrategyTasksMd(ticket, {
      strategyLines: ['kind: unit', 'entry: src/wiring.test.js'],
    });

    const res = runHook(ticket, { hookInput: { agent_type: 'commit-writer' } });

    assert.equal(res.exitCode, 0, `non-developer agent must exit 0\nstderr: ${res.stderr}`);
    assert.equal(res.stderr, '', 'no block message for non-developer agents');
  });

  // Downstream-review finding 2 — POSITIVE identification required. Claude
  // Code's SubagentStop payload identifies agents via `agent_type`, and older
  // builds sent no identity field at all: a payload with NO identity and NO
  // transcript must be allowed to stop (never gate arbitrary subagents), even
  // when the current task has a runnable strategy and no evidence.
  it('Unidentifiable subagent (no identity fields, no transcript) is allowed to stop', () => {
    const ticket = 'TEST-STOP-UNIDENT';
    writeWorkState(ticket, 1);
    writeStrategyTasksMd(ticket, {
      strategyLines: ['kind: unit', 'entry: src/wiring.test.js'],
    });

    const res = runHook(ticket, { hookInput: { agent_type: undefined } });

    assert.equal(res.exitCode, 0, `unidentifiable agent must exit 0\nstderr: ${res.stderr}`);
    assert.equal(res.stderr, '', 'no block message for unidentifiable agents');
    assert.equal(readActions(ticket).length, 0, 'no audit row for unidentifiable agents');
  });

  // No payload identity, but the subagent transcript's FIRST user message is
  // the developer dispatch prompt (structural 'self-paced TDD agent' +
  // task-next.js markers) — the hook identifies the developer and gates.
  it('Transcript dispatch-prompt marker positively identifies a developer agent', () => {
    const ticket = 'TEST-STOP-TRANSCRIPT';
    writeWorkState(ticket, 1);
    writeStrategyTasksMd(ticket, {
      strategyLines: ['kind: unit', 'entry: src/wiring.test.js'],
    });
    const transcriptPath = path.join(homeDir, 'dev-transcript.jsonl');
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          message: {
            content:
              '## Task 1/1 — Fixture\n\nYou are a self-paced TDD agent. Do NOT plan ahead…\n' +
              '### Single instruction\n```bash\nnode /x/task-next.js TEST-STOP-TRANSCRIPT task1\n```',
          },
        }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
      ].join('\n')
    );

    const res = runHook(ticket, {
      hookInput: { agent_type: undefined, transcript_path: transcriptPath },
    });

    assert.equal(res.exitCode, 2, `transcript-identified developer must be gated\n${res.stderr}`);
    assert.match(res.stderr, /STOP BLOCKED/);
  });

  // A transcript whose first user message is NOT the developer dispatch
  // prompt (merely mentions an agent name — the GH-665 substring pitfall)
  // does NOT identify a developer.
  it('Transcript without the structural dispatch marker does not gate', () => {
    const ticket = 'TEST-STOP-TRANSCRIPT-NEG';
    writeWorkState(ticket, 1);
    writeStrategyTasksMd(ticket, {
      strategyLines: ['kind: unit', 'entry: src/wiring.test.js'],
    });
    const transcriptPath = path.join(homeDir, 'other-transcript.jsonl');
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'user',
        message: {
          content:
            'Review the diff produced by developer-nodejs-tdd and check task-next.js output.',
        },
      }) + '\n'
    );

    const res = runHook(ticket, {
      hookInput: { agent_type: undefined, transcript_path: transcriptPath },
    });

    // First user message lacks the 'self-paced TDD agent' role marker.
    assert.equal(res.exitCode, 0, `non-dispatch transcript must not gate\n${res.stderr}`);
  });

  // Developer subagents (including plugin-namespaced names) ARE gated.
  it('Developer subagents are gated (block still fires with agent_name set)', () => {
    const ticket = 'TEST-STOP-DEVNAME';
    writeWorkState(ticket, 1);
    writeStrategyTasksMd(ticket, {
      strategyLines: ['kind: unit', 'entry: src/wiring.test.js'],
    });

    const res = runHook(ticket, {
      // Legacy fallback field (agent_type absent) still identifies positively.
      hookInput: { agent_type: undefined, subagent_type: 'work-workflow:developer-nodejs-tdd' },
    });

    assert.equal(res.exitCode, 2, `developer agent must be gated\nstderr: ${res.stderr}`);
    assert.match(res.stderr, /STOP BLOCKED/);
  });

  // stop_hook_active re-entrance guard is preserved.
  it('Re-entrant stop (stop_hook_active) exits 0 immediately', () => {
    const ticket = 'TEST-STOP-REENTRANT';
    writeWorkState(ticket, 1);
    writeStrategyTasksMd(ticket, {
      strategyLines: ['kind: unit', 'entry: src/wiring.test.js'],
    });

    const res = runHook(ticket, { hookInput: { stop_hook_active: true } });

    assert.equal(res.exitCode, 0);
  });

  // worktreeDir wiring: even when the hook runs from an unrelated cwd, the
  // strategy still resolves via the work-state worktree (no silent bypass).
  it('Strategy resolves via work-state worktreeDir when cwd is unrelated', () => {
    const ticket = 'TEST-STOP-WTDIR';
    writeWorkState(ticket, 1);
    writeStrategyTasksMd(ticket, {
      strategyLines: ['kind: unit', 'entry: src/wiring.test.js'],
    });

    const res = runHook(ticket, { cwd: os.tmpdir() });

    assert.equal(res.exitCode, 2, `expected block via resolved strategy\nstderr: ${res.stderr}`);
    assert.doesNotMatch(readDebug(ticket), /no ### Test Strategy resolution/);
  });
});

describe('enforce-tdd-on-stop-helpers.resolveWorktreeDir', () => {
  const helpers = require(HELPERS_PATH);
  const SAVED = {};
  const VARS = ['WORK_WORKTREE_DIR', 'WORKTREES_BASE', 'REPO_NAME'];
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-stop-wt-'));
    for (const v of VARS) {
      SAVED[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const v of VARS) {
      if (SAVED[v] === undefined) delete process.env[v];
      else process.env[v] = SAVED[v];
    }
  });

  it('prefers WORK_WORKTREE_DIR when it is an existing directory', () => {
    const envDir = path.join(tmp, 'env-wt');
    const stateDir = path.join(tmp, 'state-wt');
    fs.mkdirSync(envDir);
    fs.mkdirSync(stateDir);
    process.env.WORK_WORKTREE_DIR = envDir;
    const got = helpers.resolveWorktreeDir({ worktreeDir: stateDir }, 'GH-1');
    assert.equal(got, path.resolve(envDir));
  });

  it('uses the work-state worktreeDir when the env override is absent', () => {
    const stateDir = path.join(tmp, 'state-wt');
    fs.mkdirSync(stateDir);
    const got = helpers.resolveWorktreeDir({ worktreeDir: stateDir }, 'GH-1');
    assert.equal(got, path.resolve(stateDir));
  });

  it('ignores a non-existent work-state worktreeDir and falls back to convention', () => {
    const conv = path.join(tmp, 'repo-GH-1');
    fs.mkdirSync(conv);
    process.env.WORKTREES_BASE = tmp;
    process.env.REPO_NAME = 'repo';
    const got = helpers.resolveWorktreeDir({ worktreeDir: path.join(tmp, 'gone') }, 'GH-1');
    assert.equal(got, path.resolve(conv));
  });

  it('falls back to process.cwd() as last resort', () => {
    const got = helpers.resolveWorktreeDir(null, 'GH-1');
    assert.equal(got, process.cwd());
  });
});
