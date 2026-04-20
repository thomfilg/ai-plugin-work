/**
 * Tests for TDD enforcement feature in work-orchestrator.js
 *
 * Covers:
 *   - Prompt augmentation (TDD_PROTOCOL injection)
 *   - Gate enforcement (transition blocking without evidence)
 *
 * Uses node:test + node:assert/strict.
 * Run: node --test workflows/work/__tests__/tdd-enforcement.test.js
 */

const { describe, it, after, afterEach, before } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'work.workflow.js');

// ─── Temp dir for isolated TASKS_BASE ─────────────────────────────────────────

let tempTasksBase;
let tempWorktreesBase;

before(() => {
  tempWorktreesBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-enforce-wt-'));
  tempTasksBase = path.join(tempWorktreesBase, 'tasks');
  fs.mkdirSync(tempTasksBase, { recursive: true });
});

after(() => {
  try {
    fs.rmSync(tempWorktreesBase, { recursive: true, force: true });
  } catch {}
  // Safety-net: clean up leaked session guard files created by THIS suite only (TDD* tickets)
  try {
    const tmpDir = require('os').tmpdir();
    const tmpFiles = fs.readdirSync(tmpDir).filter((f) => f.startsWith('claude-session-guard-TDD'));
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(path.join(tmpDir, f));
      } catch {}
    }
  } catch {
    /* ignore if tmpdir unreadable */
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function runOrchestrator(args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      try {
        const result = stdout.trim() ? JSON.parse(stdout.trim()) : null;
        resolve({ result, stdout, stderr, code });
      } catch (e) {
        resolve({ result: null, stdout, stderr, code, parseError: e.message });
      }
    });

    proc.on('error', reject);
  });
}

function cleanupTempWorkState(ticket) {
  const dir = path.join(tempTasksBase, ticket);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

/** Shared env that isolates file I/O to temp dirs */
function baseEnv(extra = {}) {
  return {
    WORKTREES_BASE: tempWorktreesBase,
    TASKS_BASE: tempTasksBase,
    SESSION_GUARD_ENABLED: '0',
    ...extra,
  };
}

/**
 * Walk a ticket through transitions 1_ticket -> ... -> targetStep.
 * Returns the result of the final transition.
 */
async function transitionTo(ticket, targetStep, envExtra = {}) {
  const steps = [
    'bootstrap',
    'brief',
    'brief_gate', // GH-215
    'spec',
    'tasks',
    'implement',
    'commit',
    'check',
    'pr',
    'ready',
    'follow_up',
    'ci',
    'cleanup',
    'reports',
    'complete',
  ];
  const idx = steps.indexOf(targetStep);
  if (idx === -1) throw new Error(`Unknown target step: ${targetStep}`);

  // Determine the sanitized ticket for writing TDD evidence
  const safeTicket = ticket.startsWith('#') ? `GH-${ticket.slice(1)}` : ticket;

  let lastResult;
  // Walk step by step through the linear graph.
  for (let i = 0; i <= idx; i++) {
    // Before transitioning OUT of implement (i.e. to commit),
    // write valid TDD evidence so the gate allows progression.
    if (steps[i] === 'commit') {
      writeValidPhaseState(safeTicket);
    }
    const { result } = await runOrchestrator(['transition', ticket, steps[i]], {
      env: baseEnv(envExtra),
    });
    lastResult = result;
    if (result?.error) break;
  }
  return lastResult;
}

/**
 * Write a valid tdd-phase.json with a complete cycle (red + green + refactor).
 */
function writeValidPhaseState(ticket) {
  const ticketDir = path.join(tempTasksBase, ticket);
  fs.mkdirSync(ticketDir, { recursive: true });
  const phasePath = path.join(ticketDir, 'tdd-phase.json');
  const state = {
    currentPhase: 'red',
    currentCycle: 2,
    cycles: [
      {
        cycle: 1,
        red: {
          testFiles: ['a.test.ts'],
          testCommand: 'pnpm test',
          testExitCode: 1,
          timestamp: new Date().toISOString(),
        },
        green: {
          testCommand: 'pnpm test',
          testExitCode: 0,
          timestamp: new Date().toISOString(),
        },
        refactor: {
          testCommand: 'pnpm test',
          testExitCode: 0,
          timestamp: new Date().toISOString(),
        },
      },
    ],
  };
  fs.writeFileSync(phasePath, JSON.stringify(state, null, 2));
  return phasePath;
}

/**
 * Write a partial tdd-phase.json with only red evidence (no green/refactor).
 */
function writePartialPhaseState(ticket) {
  const ticketDir = path.join(tempTasksBase, ticket);
  fs.mkdirSync(ticketDir, { recursive: true });
  const phasePath = path.join(ticketDir, 'tdd-phase.json');
  const state = {
    currentPhase: 'green',
    currentCycle: 1,
    cycles: [
      {
        cycle: 1,
        red: {
          testFiles: ['a.test.ts'],
          testCommand: 'pnpm test',
          testExitCode: 1,
          timestamp: new Date().toISOString(),
        },
      },
    ],
  };
  fs.writeFileSync(phasePath, JSON.stringify(state, null, 2));
  return phasePath;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('TDD enforcement', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // Prompt augmentation tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Prompt augmentation', () => {
    const TICKET = 'TDDP-200';
    afterEach(() => {
      cleanupTempWorkState(TICKET);
    });

    it('plan for 3_implement includes TDD instructions in agentPrompt', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv(),
      });
      const implStep = result.plan.find((s) => s.step === 'implement');
      assert.ok(
        implStep.agentPrompt.includes('TDD protocol'),
        'Should include TDD protocol header'
      );
    });

    it('agentPrompt for 3_implement contains instruction not to make local commits', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv(),
      });
      const implStep = result.plan.find((s) => s.step === 'implement');
      const prompt = implStep.agentPrompt;
      const hasNoCommit = /do not.*commit/i.test(prompt) || /leave.*uncommitted/i.test(prompt);
      assert.ok(hasNoCommit, 'agentPrompt should instruct not to make local commits');
    });

    it('agentPrompt for 3_implement contains the real tdd-phase-state.js path', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv(),
      });
      const implStep = result.plan.find((s) => s.step === 'implement');
      const tddStatePath = path.join(__dirname, '..', '..', 'work-implement', 'tdd-phase-state.js');
      assert.ok(
        implStep.agentPrompt.includes(tddStatePath),
        'Should contain the real tdd-phase-state.js path'
      );
    });

    it('agentPrompt for 3_implement contains the real ticket ID', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv(),
      });
      const implStep = result.plan.find((s) => s.step === 'implement');
      assert.ok(implStep.agentPrompt.includes(TICKET), 'Should contain the real ticket ID');
    });

    it('agentPrompt for 3_implement does not contain literal <TDD_STATE_PATH>', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv(),
      });
      const implStep = result.plan.find((s) => s.step === 'implement');
      assert.doesNotMatch(implStep.agentPrompt, /<TDD_STATE_PATH>/);
    });

    it('agentPrompt for 3_implement does not contain literal <TICKET_ID>', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv(),
      });
      const implStep = result.plan.find((s) => s.step === 'implement');
      assert.doesNotMatch(implStep.agentPrompt, /<TICKET_ID>/);
    });

    it('agentPrompt for 3_implement contains record-red command reference', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv(),
      });
      const implStep = result.plan.find((s) => s.step === 'implement');
      assert.ok(implStep.agentPrompt.includes('record-red'), 'Should contain record-red command');
      assert.ok(
        implStep.agentPrompt.includes('record-green'),
        'Should contain record-green command'
      );
      assert.ok(
        implStep.agentPrompt.includes('record-refactor'),
        'Should contain record-refactor command'
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Gate enforcement tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Gate enforcement', () => {
    const TICKET = 'TDDG-300';
    afterEach(() => {
      cleanupTempWorkState(TICKET);
    });

    it('transition 3_implement -> commit BLOCKED without evidence file', async () => {
      await transitionTo(TICKET, 'implement');
      const { result } = await runOrchestrator(['transition', TICKET, 'commit'], {
        env: baseEnv(),
      });
      assert.equal(result.error, true);
      assert.match(result.message, /TDD evidence/i);
    });

    it('transition 3_implement -> commit ALLOWED with valid tdd-phase.json (complete cycle)', async () => {
      await transitionTo(TICKET, 'implement');
      writeValidPhaseState(TICKET);
      const { result } = await runOrchestrator(['transition', TICKET, 'commit'], {
        env: baseEnv(),
      });
      assert.equal(result.success, true);
      assert.equal(result.to, 'commit');
    });

    it('transition 3_implement -> commit ALLOWED with partial cycle (red + green, no refactor)', async () => {
      await transitionTo(TICKET, 'implement');
      const ticketDir = path.join(tempTasksBase, TICKET);
      fs.mkdirSync(ticketDir, { recursive: true });
      const phasePath = path.join(ticketDir, 'tdd-phase.json');
      fs.writeFileSync(
        phasePath,
        JSON.stringify({
          currentPhase: 'refactor',
          currentCycle: 1,
          cycles: [
            {
              cycle: 1,
              red: {
                testFiles: ['a.test.ts'],
                testCommand: 'pnpm test',
                testExitCode: 1,
                timestamp: new Date().toISOString(),
              },
              green: {
                testCommand: 'pnpm test',
                testExitCode: 0,
                timestamp: new Date().toISOString(),
              },
            },
          ],
        })
      );
      const { result } = await runOrchestrator(['transition', TICKET, 'commit'], {
        env: baseEnv(),
      });
      assert.equal(result.success, true);
      assert.equal(result.to, 'commit');
    });

    it('phase state with only red evidence (no green) -> BLOCKED', async () => {
      await transitionTo(TICKET, 'implement');
      writePartialPhaseState(TICKET);
      const { result } = await runOrchestrator(['transition', TICKET, 'commit'], {
        env: baseEnv(),
      });
      assert.equal(result.error, true);
      assert.match(result.message, /RED.*GREEN/i);
    });

    it('phase state with empty cycles array -> BLOCKED', async () => {
      await transitionTo(TICKET, 'implement');
      const ticketDir = path.join(tempTasksBase, TICKET);
      fs.mkdirSync(ticketDir, { recursive: true });
      const phasePath = path.join(ticketDir, 'tdd-phase.json');
      fs.writeFileSync(
        phasePath,
        JSON.stringify({
          currentPhase: 'red',
          currentCycle: 1,
          cycles: [],
        })
      );
      const { result } = await runOrchestrator(['transition', TICKET, 'commit'], {
        env: baseEnv(),
      });
      assert.equal(result.error, true);
      assert.match(result.message, /No TDD cycles/i);
    });

    it('transition INTO 3_implement (from 6_check) resets tdd-phase.json to RED phase', async () => {
      // Walk to implement linearly
      await runOrchestrator(['transition', TICKET, 'bootstrap'], { env: baseEnv() });
      await runOrchestrator(['transition', TICKET, 'brief'], { env: baseEnv() });
      await runOrchestrator(['transition', TICKET, 'brief_gate'], { env: baseEnv() });
      await runOrchestrator(['transition', TICKET, 'spec'], { env: baseEnv() });
      await runOrchestrator(['transition', TICKET, 'tasks'], { env: baseEnv() });
      await runOrchestrator(['transition', TICKET, 'implement'], { env: baseEnv() });

      // Record valid evidence so we can leave 3_implement
      writeValidPhaseState(TICKET);
      await runOrchestrator(['transition', TICKET, 'commit'], { env: baseEnv() });
      await runOrchestrator(['transition', TICKET, 'task_review'], { env: baseEnv() });
      await runOrchestrator(['transition', TICKET, 'check'], { env: baseEnv() });

      // Now create a stale phase state file for 3_implement
      const phasePath = path.join(tempTasksBase, TICKET, 'tdd-phase.json');
      fs.writeFileSync(
        phasePath,
        JSON.stringify({ currentPhase: 'green', currentCycle: 2, cycles: [{ cycle: 1 }] })
      );
      assert.ok(fs.existsSync(phasePath));

      // Transition back INTO 3_implement
      await runOrchestrator(['transition', TICKET, 'implement'], { env: baseEnv() });

      // tdd-phase.json should be re-created (not deleted) with fresh RED phase
      assert.ok(
        fs.existsSync(phasePath),
        'Phase state file should be re-created after transition into implement'
      );
      const state = JSON.parse(fs.readFileSync(phasePath, 'utf8'));
      assert.equal(state.currentPhase, 'red', 'Phase should be reset to red');
      assert.equal(state.currentCycle, 1, 'Cycle should be reset to 1');
      assert.deepEqual(state.cycles, [], 'Cycles should be empty after reset');
    });

    it('transition INTO 3_implement with no prior tdd-phase.json does not error (ENOENT handled)', async () => {
      await runOrchestrator(['transition', TICKET, 'bootstrap'], { env: baseEnv() });
      await runOrchestrator(['transition', TICKET, 'brief'], { env: baseEnv() });
      await runOrchestrator(['transition', TICKET, 'brief_gate'], { env: baseEnv() });
      await runOrchestrator(['transition', TICKET, 'spec'], { env: baseEnv() });
      await runOrchestrator(['transition', TICKET, 'tasks'], { env: baseEnv() });
      // Make sure no phase state file exists
      const phasePath = path.join(tempTasksBase, TICKET, 'tdd-phase.json');
      try {
        fs.unlinkSync(phasePath);
      } catch {}

      const { result } = await runOrchestrator(['transition', TICKET, 'implement'], {
        env: baseEnv(),
      });
      assert.equal(result.success, true);
    });

    it('corrupt JSON tdd-phase.json -> BLOCKED', async () => {
      await transitionTo(TICKET, 'implement');
      const phasePath = path.join(tempTasksBase, TICKET, 'tdd-phase.json');
      fs.writeFileSync(phasePath, '{corrupt json!!!');

      const { result } = await runOrchestrator(['transition', TICKET, 'commit'], {
        env: baseEnv(),
      });
      assert.equal(result.error, true);
      assert.match(result.message, /TDD evidence/i);
    });

    it('phase state with null evidence -> BLOCKED', async () => {
      await transitionTo(TICKET, 'implement');
      const phasePath = path.join(tempTasksBase, TICKET, 'tdd-phase.json');
      fs.writeFileSync(phasePath, 'null');

      const { result } = await runOrchestrator(['transition', TICKET, 'commit'], {
        env: baseEnv(),
      });
      assert.equal(result.error, true);
    });

    it('phase state without cycles key -> BLOCKED', async () => {
      await transitionTo(TICKET, 'implement');
      const phasePath = path.join(tempTasksBase, TICKET, 'tdd-phase.json');
      fs.writeFileSync(
        phasePath,
        JSON.stringify({
          currentPhase: 'red',
          currentCycle: 1,
        })
      );

      const { result } = await runOrchestrator(['transition', TICKET, 'commit'], {
        env: baseEnv(),
      });
      assert.equal(result.error, true);
      assert.match(result.message, /No TDD cycles/i);
    });

    it('transition 3_implement -> commit ALLOWED with exception-based tdd-phase.json', async () => {
      await transitionTo(TICKET, 'implement');
      const ticketDir = path.join(tempTasksBase, TICKET);
      fs.mkdirSync(ticketDir, { recursive: true });
      const phasePath = path.join(ticketDir, 'tdd-phase.json');
      fs.writeFileSync(
        phasePath,
        JSON.stringify({
          currentPhase: 'exception',
          exception: 'config-only change, no testable behavior',
          cycles: [],
        })
      );
      const { result } = await runOrchestrator(['transition', TICKET, 'commit'], {
        env: baseEnv(),
      });
      assert.equal(result.success, true);
      assert.equal(result.to, 'commit');
    });

    it('current commit -> task_review -> check does not consult TDD evidence (non-gated steps)', async () => {
      await transitionTo(TICKET, 'implement');
      writeValidPhaseState(TICKET);
      await runOrchestrator(['transition', TICKET, 'commit'], { env: baseEnv() });

      // commit -> task_review -> check without any evidence for these (non-gated)
      await runOrchestrator(['transition', TICKET, 'task_review'], { env: baseEnv() });
      const { result } = await runOrchestrator(['transition', TICKET, 'check'], { env: baseEnv() });
      assert.equal(result.success, true);
      assert.equal(result.to, 'check');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Per-task TDD evidence (GH-219 Task 2)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('readTddEvidence with taskNum (per-task paths)', () => {
    const { readTddEvidence } = require('../tdd-enforcement');

    it('reads from per-task path when taskNum is provided', () => {
      const ticket = 'TDDT2-100';
      const taskDir = path.join(tempTasksBase, ticket, 'task3');
      fs.mkdirSync(taskDir, { recursive: true });
      const state = {
        currentPhase: 'red',
        currentCycle: 2,
        cycles: [{ cycle: 1, red: { testFiles: ['a.test.ts'] }, green: { testCommand: 'test' }, refactor: { testCommand: 'test' } }],
      };
      fs.writeFileSync(path.join(taskDir, 'tdd-phase.json'), JSON.stringify(state));

      const result = readTddEvidence(tempTasksBase, ticket, 'implement', 3);
      assert.equal(result.exists, true);
      assert.equal(result.parseError, false);
      assert.deepEqual(result.evidence.cycles.length, 1);

      // Cleanup
      fs.rmSync(path.join(tempTasksBase, ticket), { recursive: true, force: true });
    });

    it('returns exists:false when per-task file is missing (no fallback to ticket root)', () => {
      const ticket = 'TDDT2-101';
      const ticketDir = path.join(tempTasksBase, ticket);
      fs.mkdirSync(ticketDir, { recursive: true });
      // Write evidence at ticket root — should NOT be found when taskNum is given
      fs.writeFileSync(
        path.join(ticketDir, 'tdd-phase.json'),
        JSON.stringify({ currentPhase: 'red', cycles: [] })
      );

      const result = readTddEvidence(tempTasksBase, ticket, 'implement', 2);
      assert.equal(result.exists, false, 'Must not fall back to ticket root when taskNum is provided');

      // Cleanup
      fs.rmSync(ticketDir, { recursive: true, force: true });
    });

    it('still reads from ticket root when taskNum is NOT provided (backward compat)', () => {
      const ticket = 'TDDT2-102';
      const ticketDir = path.join(tempTasksBase, ticket);
      fs.mkdirSync(ticketDir, { recursive: true });
      const state = { currentPhase: 'red', cycles: [{ cycle: 1, red: {}, green: {}, refactor: {} }] };
      fs.writeFileSync(path.join(ticketDir, 'tdd-phase.json'), JSON.stringify(state));

      const result = readTddEvidence(tempTasksBase, ticket, 'implement');
      assert.equal(result.exists, true, 'Should read from ticket root when no taskNum');

      // Cleanup
      fs.rmSync(ticketDir, { recursive: true, force: true });
    });

    it('returns parseError:true for corrupt JSON in per-task path', () => {
      const ticket = 'TDDT2-103';
      const taskDir = path.join(tempTasksBase, ticket, 'task1');
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(path.join(taskDir, 'tdd-phase.json'), '{corrupt!!!');

      const result = readTddEvidence(tempTasksBase, ticket, 'implement', 1);
      assert.equal(result.exists, true);
      assert.equal(result.parseError, true);

      // Cleanup
      fs.rmSync(path.join(tempTasksBase, ticket), { recursive: true, force: true });
    });

    it('uses taskSegment() for path construction (task5, not task-5)', () => {
      const ticket = 'TDDT2-104';
      // Create task5/ directory with evidence
      const taskDir = path.join(tempTasksBase, ticket, 'task5');
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(
        path.join(taskDir, 'tdd-phase.json'),
        JSON.stringify({ currentPhase: 'red', cycles: [] })
      );

      const result = readTddEvidence(tempTasksBase, ticket, 'implement', 5);
      assert.equal(result.exists, true, 'Should find file via taskSegment("task5")');

      // Cleanup
      fs.rmSync(path.join(tempTasksBase, ticket), { recursive: true, force: true });
    });
  });

  describe('autoInitTdd with taskNum (per-task paths)', () => {
    let origTasksBase;

    afterEach(() => {
      // Restore original TASKS_BASE (or delete if not originally set) and clear module cache
      if (origTasksBase !== undefined) {
        process.env.TASKS_BASE = origTasksBase;
      } else {
        delete process.env.TASKS_BASE;
      }
      delete require.cache[require.resolve('../work-state')];
      delete require.cache[require.resolve('../../lib/config')];
    });

    it('creates tdd-phase.json at per-task path with red phase and empty cycles', () => {
      const ticket = 'TEST-200';
      const expectedDir = path.join(tempTasksBase, ticket, 'task2');
      const expectedFile = path.join(expectedDir, 'tdd-phase.json');

      // Point TASKS_BASE at our temp dir and reload config + work-state to pick it up
      origTasksBase = process.env.TASKS_BASE;
      process.env.TASKS_BASE = tempTasksBase;
      delete require.cache[require.resolve('../../lib/config')];
      delete require.cache[require.resolve('../work-state')];
      // Also clear submodules that work-state requires (they cache parent fns)
      try { delete require.cache[require.resolve('../work-state/task-readiness')]; } catch {}
      try { delete require.cache[require.resolve('../work-state/parallel-workers')]; } catch {}
      try { delete require.cache[require.resolve('../work-state/graph-validation')]; } catch {}
      const { autoInitTdd } = require('../work-state');

      // Call autoInitTdd with taskNum
      autoInitTdd(ticket, 2);

      // Assert file exists at per-task path
      assert.ok(
        fs.existsSync(expectedFile),
        `Expected tdd-phase.json at ${expectedFile}`
      );

      // Assert file contents
      const state = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
      assert.equal(state.currentPhase, 'red', 'currentPhase should be red');
      assert.deepEqual(state.cycles, [], 'cycles should be empty array');

      // Cleanup
      fs.rmSync(path.join(tempTasksBase, ticket), { recursive: true, force: true });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GitHub ticket ID sanitization in transitionStep
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GitHub ticket ID sanitization in transitionStep', () => {
    const RAW_TICKET = '#154';
    const SAFE_TICKET = 'GH-154';

    afterEach(() => {
      cleanupTempWorkState(RAW_TICKET);
      cleanupTempWorkState(SAFE_TICKET);
    });

    const ghEnv = (extra = {}) => ({ TICKET_PROVIDER: 'github', ...extra });

    it('transition with #NNN ticket finds work state written to GH-NNN/ directory', async () => {
      // Walk to bootstrap using raw #154 ticket
      const { result } = await runOrchestrator(['transition', RAW_TICKET, 'bootstrap'], {
        env: baseEnv(ghEnv()),
      });
      assert.equal(result.success, true, 'Transition should succeed');

      // Work state should be saved under GH-154/, not #154/
      const safeDir = path.join(tempTasksBase, SAFE_TICKET);
      const rawDir = path.join(tempTasksBase, RAW_TICKET);
      assert.ok(
        fs.existsSync(path.join(safeDir, '.work-state.json')),
        'Work state should exist under GH-154/'
      );
      assert.ok(
        !fs.existsSync(path.join(rawDir, '.work-state.json')),
        'Work state should NOT exist under #154/'
      );
    });

    it('transition with #NNN ticket finds TDD evidence in GH-NNN/ directory (TDD gate passes)', async () => {
      // Walk to implement
      await transitionTo(RAW_TICKET, 'implement', ghEnv());

      // Write valid TDD evidence to the sanitized directory
      writeValidPhaseState(SAFE_TICKET);

      // Transition out of implement should pass because evidence is in GH-154/
      const { result } = await runOrchestrator(['transition', RAW_TICKET, 'commit'], {
        env: baseEnv(ghEnv()),
      });
      assert.equal(result.success, true, 'Transition should succeed with TDD evidence in GH-NNN/');
      assert.equal(result.to, 'commit');
    });

    it('transition with #NNN ticket and TDD enforcement blocks when no evidence in GH-NNN/', async () => {
      // Walk to implement
      await transitionTo(RAW_TICKET, 'implement', ghEnv());

      // No TDD evidence written — should block
      const { result } = await runOrchestrator(['transition', RAW_TICKET, 'commit'], {
        env: baseEnv(ghEnv()),
      });
      assert.equal(result.error, true);
      assert.match(result.message, /TDD evidence/i);
    });

    it('already-sanitized GH-NNN ticket works (idempotent)', async () => {
      // Use already-sanitized ticket ID
      const { result } = await runOrchestrator(['transition', SAFE_TICKET, 'bootstrap'], {
        env: baseEnv(ghEnv()),
      });
      assert.equal(result.success, true);

      // Work state should exist under GH-154/
      const safeDir = path.join(tempTasksBase, SAFE_TICKET);
      assert.ok(
        fs.existsSync(path.join(safeDir, '.work-state.json')),
        'Work state should exist under GH-154/'
      );
    });

    it('getAvailableTransitions(#NNN) correctly reads work state from GH-NNN/', async () => {
      // First set up some state via transition
      await transitionTo(RAW_TICKET, 'brief', ghEnv());

      // Now query available transitions with raw ticket
      const { result } = await runOrchestrator(['transitions', RAW_TICKET], {
        env: baseEnv(ghEnv()),
      });

      // Should find the state (currently at brief, can go to spec or implement)
      assert.equal(result.currentStep, 'brief', 'Should find current step from GH-NNN/ state');
      assert.ok(result.allowed.length > 0, 'Should have available transitions');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TDD_PROTOCOL text includes --task <N> in CLI examples (GH-219 Task 3)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('TDD_PROTOCOL includes --task <N> in CLI examples', () => {
    const { TDD_PROTOCOL } = require('../tdd-enforcement');

    it('init command includes --task <N>', () => {
      assert.match(TDD_PROTOCOL, /init <TICKET_ID> --task <N>/);
    });

    it('record-red command includes --task <N>', () => {
      assert.match(TDD_PROTOCOL, /record-red <TICKET_ID> --task <N>/);
    });

    it('record-green command includes --task <N>', () => {
      assert.match(TDD_PROTOCOL, /record-green <TICKET_ID> --task <N>/);
    });

    it('record-refactor command includes --task <N>', () => {
      assert.match(TDD_PROTOCOL, /record-refactor <TICKET_ID> --task <N>/);
    });

    it('transition to green includes --task <N>', () => {
      assert.match(TDD_PROTOCOL, /transition <TICKET_ID> green --task <N>/);
    });

    it('transition to refactor includes --task <N>', () => {
      assert.match(TDD_PROTOCOL, /transition <TICKET_ID> refactor --task <N>/);
    });

    it('transition to red includes --task <N>', () => {
      assert.match(TDD_PROTOCOL, /transition <TICKET_ID> red --task <N>/);
    });

    it('exception command includes --task <N>', () => {
      assert.match(TDD_PROTOCOL, /exception <TICKET_ID> --task <N>/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // task-review uses per-task path when task context is available (GH-219 Task 3)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('task-review uses per-task tasksDir', () => {
    const taskReviewStep = require('../steps/task-review');
    const { STEPS } = require('../step-registry');
    const { taskSegment } = require('../../lib/allocate-output-folder');

    function makeAdd() {
      const entries = [];
      const add = (step, action, command, reason, extra) => {
        entries.push({ step, action, command, reason, ...(extra || {}) });
      };
      return { add, entries };
    }

    function makeCtx(overrides = {}) {
      return {
        STEPS,
        ticket: 'TEST-TR-100',
        tasksDir: '/tmp/tasks/TEST-TR-100',
        path,
        _taskData: null,
        _allTasksDone: false,
        _currentTaskIdx: 0,
        ...overrides,
      };
    }

    function makeState(overrides = {}) {
      return {
        hasTasks: false,
        workState: null,
        ...overrides,
      };
    }

    it('overrides tasksDir to per-task path when _currentTaskIdx is set', () => {
      const ticketTasksDir = path.join(tempTasksBase, 'TEST-TR-101');
      const taskData = [
        { num: 1, title: 'Task A' },
        { num: 2, title: 'Task B' },
        { num: 3, title: 'Task C' },
      ];
      const s = makeState({
        hasTasks: true,
        workState: {
          tasksMeta: {
            currentTaskIndex: 0,
            tasks: [
              { id: 'task-1', taskReviewFixRounds: 0 },
              { id: 'task-2' },
              { id: 'task-3' },
            ],
          },
        },
      });
      // _currentTaskIdx is 0-indexed, task num is 1-indexed
      const ctx = makeCtx({
        _taskData: taskData,
        _currentTaskIdx: 0,
        tasksDir: ticketTasksDir,
        ticket: 'TEST-TR-101',
      });

      // Create the per-task directory with .last-commit-sha so computeTaskDiff can find it
      const perTaskDir = path.join(ticketTasksDir, taskSegment(1));
      fs.mkdirSync(perTaskDir, { recursive: true });
      fs.writeFileSync(path.join(perTaskDir, '.last-commit-sha'), 'a'.repeat(40));

      const { add, entries } = makeAdd();
      taskReviewStep(add, s, ctx);

      assert.equal(entries.length, 1);
      assert.equal(entries[0].action, 'RUN');
      // The diffRange should have been computed from the per-task dir
      // (not the ticket root). If it used the ticket root, .last-commit-sha
      // would not be found and diffRange would be null.
      assert.ok(entries[0].diffRange !== null, 'diffRange should be computed from per-task path');

      // Cleanup
      fs.rmSync(ticketTasksDir, { recursive: true, force: true });
    });

    it('falls back to ticket-level tasksDir when _currentTaskIdx is not set', () => {
      const ticketTasksDir = path.join(tempTasksBase, 'TEST-TR-102');
      const taskData = [
        { num: 1, title: 'Task A' },
        { num: 2, title: 'Task B' },
      ];
      const s = makeState({
        hasTasks: true,
        workState: {
          tasksMeta: {
            currentTaskIndex: 0,
            tasks: [
              { id: 'task-1', taskReviewFixRounds: 0 },
              { id: 'task-2' },
            ],
          },
        },
      });
      // _currentTaskIdx is explicitly undefined (not set by implement step)
      const ctx = makeCtx({
        _taskData: taskData,
        _currentTaskIdx: undefined,
        tasksDir: ticketTasksDir,
        ticket: 'TEST-TR-102',
      });

      // Create .last-commit-sha at ticket root level (not per-task)
      fs.mkdirSync(ticketTasksDir, { recursive: true });
      fs.writeFileSync(path.join(ticketTasksDir, '.last-commit-sha'), 'b'.repeat(40));

      const { add, entries } = makeAdd();
      taskReviewStep(add, s, ctx);

      // _currentTaskIdx is undefined, defaults to 0 in the step
      // With default 0, it's still an intermediate task (0 < 2-1),
      // but tasksDir should NOT be overridden to per-task path
      assert.equal(entries.length, 1);
      assert.equal(entries[0].action, 'RUN');
      // diffRange should come from ticket root (where .last-commit-sha exists)
      assert.ok(entries[0].diffRange !== null, 'diffRange should be computed from ticket root');

      // Cleanup
      fs.rmSync(ticketTasksDir, { recursive: true, force: true });
    });
  });
});
