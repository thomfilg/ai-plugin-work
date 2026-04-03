/**
 * Tests for TDD enforcement feature in work-orchestrator.js
 *
 * Covers:
 *   - WORK_TDD_ENFORCE toggle behavior
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
  try { fs.rmSync(tempWorktreesBase, { recursive: true, force: true }); } catch {}
  // Safety-net: clean up leaked session guard files created by THIS suite only (TDD* tickets)
  try {
    const tmpDir = require('os').tmpdir();
    const tmpFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith('claude-session-guard-TDD'));
    for (const f of tmpFiles) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
    }
  } catch { /* ignore if tmpdir unreadable */ }
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

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

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
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/** Shared env that isolates file I/O to temp dirs */
function baseEnv(extra = {}) {
  return { WORKTREES_BASE: tempWorktreesBase, TASKS_BASE: tempTasksBase, SESSION_GUARD_ENABLED: '0', ...extra };
}

/**
 * Walk a ticket through transitions 1_ticket -> ... -> targetStep.
 * Returns the result of the final transition.
 */
async function transitionTo(ticket, targetStep, envExtra = {}) {
  const steps = [
    'bootstrap', 'brief', 'spec', 'implement', 'commit',
    'check', 'pr',
    'ready', 'follow_up', 'ci', 'cleanup', 'reports', 'complete',
  ];
  const idx = steps.indexOf(targetStep);
  if (idx === -1) throw new Error(`Unknown target step: ${targetStep}`);

  let lastResult;
  // Walk step by step through the linear graph.
  for (let i = 0; i <= idx; i++) {
    const { result } = await runOrchestrator(
      ['transition', ticket, steps[i]],
      { env: baseEnv(envExtra) },
    );
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
  // WORK_TDD_ENFORCE toggle tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('WORK_TDD_ENFORCE toggle', () => {
    const TICKET = 'TDDT-100';
    afterEach(() => { cleanupTempWorkState(TICKET); });

    it('with WORK_TDD_ENFORCE=1: agentPrompt for 3_implement includes TDD protocol text', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv({ WORK_TDD_ENFORCE: '1' }),
      });
      const implStep = result.plan.find(s => s.step === 'implement');
      assert.ok(implStep, '3_implement step must exist in plan');
      assert.match(implStep.agentPrompt, /hook-enforced/i);
    });

    it('with WORK_TDD_ENFORCE=0: agentPrompt for 3_implement does NOT include TDD protocol', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv({ WORK_TDD_ENFORCE: '0' }),
      });
      const implStep = result.plan.find(s => s.step === 'implement');
      assert.ok(implStep, '3_implement step must exist in plan');
      assert.doesNotMatch(implStep.agentPrompt || '', /hook-enforced/i);
    });

    it('with WORK_TDD_ENFORCE empty: auto-detection kicks in and agentPrompt for 3_implement includes TDD protocol', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], { env: baseEnv({ WORK_TDD_ENFORCE: '' }) });
      const implStep = result.plan.find(s => s.step === 'implement');
      assert.ok(implStep, '3_implement step must exist in plan');
      assert.match(implStep.agentPrompt, /hook-enforced/i);
    });

    it('with WORK_TDD_ENFORCE=1: transition 3_implement -> commit BLOCKED without evidence', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      const { result } = await runOrchestrator(
        ['transition', TICKET, 'commit'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.error, true);
      assert.match(result.message, /TDD evidence/i);
    });

    it('with WORK_TDD_ENFORCE=0: transition 3_implement -> commit ALLOWED without evidence', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '0' });
      const { result } = await runOrchestrator(
        ['transition', TICKET, 'commit'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '0' }) },
      );
      assert.equal(result.success, true);
    });

    it('with WORK_TDD_ENFORCE empty: auto-detection blocks transition 3_implement -> commit without evidence', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '' });
      const { result } = await runOrchestrator(
        ['transition', TICKET, 'commit'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '' }) },
      );
      // Empty string falls through to auto-detection which returns true (project has tests)
      assert.equal(result.error, true);
      assert.match(result.message, /TDD evidence/i);
    });

    it('with WORK_TDD_ENFORCE=1: transition INTO 3_implement deletes stale tdd-phase.json', async () => {
      // Setup: create a stale phase state file
      const ticketDir = path.join(tempTasksBase, TICKET);
      fs.mkdirSync(ticketDir, { recursive: true });
      const phasePath = path.join(ticketDir, 'tdd-phase.json');
      fs.writeFileSync(phasePath, JSON.stringify({ currentPhase: 'red', currentCycle: 1, cycles: [] }));
      assert.ok(fs.existsSync(phasePath), 'Stale phase state should exist before transition');

      // Transition linearly to 3_implement
      await runOrchestrator(['transition', TICKET, 'bootstrap'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      await runOrchestrator(['transition', TICKET, 'brief'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      await runOrchestrator(['transition', TICKET, 'spec'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      await runOrchestrator(['transition', TICKET, 'implement'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });

      assert.ok(!fs.existsSync(phasePath), 'Stale phase state should be deleted when entering 3_implement');
    });

    it('with WORK_TDD_ENFORCE=0: transition INTO 3_implement does NOT delete existing tdd-phase.json', async () => {
      const ticketDir = path.join(tempTasksBase, TICKET);
      fs.mkdirSync(ticketDir, { recursive: true });
      const phasePath = path.join(ticketDir, 'tdd-phase.json');
      fs.writeFileSync(phasePath, JSON.stringify({ currentPhase: 'red', currentCycle: 1, cycles: [] }));

      await runOrchestrator(['transition', TICKET, 'bootstrap'], { env: baseEnv({ WORK_TDD_ENFORCE: '0' }) });
      await runOrchestrator(['transition', TICKET, 'brief'], { env: baseEnv({ WORK_TDD_ENFORCE: '0' }) });
      await runOrchestrator(['transition', TICKET, 'spec'], { env: baseEnv({ WORK_TDD_ENFORCE: '0' }) });
      await runOrchestrator(['transition', TICKET, 'implement'], { env: baseEnv({ WORK_TDD_ENFORCE: '0' }) });

      assert.ok(fs.existsSync(phasePath), 'Phase state file should NOT be deleted when WORK_TDD_ENFORCE=0');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Prompt augmentation tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Prompt augmentation (WORK_TDD_ENFORCE=1)', () => {
    const TICKET = 'TDDP-200';
    afterEach(() => { cleanupTempWorkState(TICKET); });

    it('plan for 3_implement includes TDD instructions in agentPrompt', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv({ WORK_TDD_ENFORCE: '1' }),
      });
      const implStep = result.plan.find(s => s.step === 'implement');
      assert.ok(implStep.agentPrompt.includes('TDD protocol'), 'Should include TDD protocol header');
    });

    it('agentPrompt for 3_implement contains instruction not to make local commits', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv({ WORK_TDD_ENFORCE: '1' }),
      });
      const implStep = result.plan.find(s => s.step === 'implement');
      const prompt = implStep.agentPrompt;
      const hasNoCommit = /do not.*commit/i.test(prompt) || /leave.*uncommitted/i.test(prompt);
      assert.ok(hasNoCommit, 'agentPrompt should instruct not to make local commits');
    });

    it('agentPrompt for 3_implement contains the real tdd-phase-state.js path', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv({ WORK_TDD_ENFORCE: '1' }),
      });
      const implStep = result.plan.find(s => s.step === 'implement');
      const tddStatePath = path.join(__dirname, '..', '..', 'work-implement', 'tdd-phase-state.js');
      assert.ok(implStep.agentPrompt.includes(tddStatePath), 'Should contain the real tdd-phase-state.js path');
    });

    it('agentPrompt for 3_implement contains the real ticket ID', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv({ WORK_TDD_ENFORCE: '1' }),
      });
      const implStep = result.plan.find(s => s.step === 'implement');
      assert.ok(implStep.agentPrompt.includes(TICKET), 'Should contain the real ticket ID');
    });

    it('agentPrompt for 3_implement does not contain literal <TDD_STATE_PATH>', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv({ WORK_TDD_ENFORCE: '1' }),
      });
      const implStep = result.plan.find(s => s.step === 'implement');
      assert.doesNotMatch(implStep.agentPrompt, /<TDD_STATE_PATH>/);
    });

    it('agentPrompt for 3_implement does not contain literal <TICKET_ID>', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv({ WORK_TDD_ENFORCE: '1' }),
      });
      const implStep = result.plan.find(s => s.step === 'implement');
      assert.doesNotMatch(implStep.agentPrompt, /<TICKET_ID>/);
    });

    it('agentPrompt for 3_implement contains record-red command reference', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv({ WORK_TDD_ENFORCE: '1' }),
      });
      const implStep = result.plan.find(s => s.step === 'implement');
      assert.ok(implStep.agentPrompt.includes('record-red'), 'Should contain record-red command');
      assert.ok(implStep.agentPrompt.includes('record-green'), 'Should contain record-green command');
      assert.ok(implStep.agentPrompt.includes('record-refactor'), 'Should contain record-refactor command');
    });

  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Gate enforcement tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Gate enforcement (WORK_TDD_ENFORCE=1)', () => {
    const TICKET = 'TDDG-300';
    afterEach(() => { cleanupTempWorkState(TICKET); });

    it('transition 3_implement -> commit BLOCKED without evidence file', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      const { result } = await runOrchestrator(
        ['transition', TICKET, 'commit'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.error, true);
      assert.match(result.message, /TDD evidence/i);
    });

    it('transition 3_implement -> commit ALLOWED with valid tdd-phase.json (complete cycle)', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      writeValidPhaseState(TICKET);
      const { result } = await runOrchestrator(
        ['transition', TICKET, 'commit'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.success, true);
      assert.equal(result.to, 'commit');
    });

    it('transition 3_implement -> commit ALLOWED with partial cycle (red + green, no refactor)', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      const ticketDir = path.join(tempTasksBase, TICKET);
      fs.mkdirSync(ticketDir, { recursive: true });
      const phasePath = path.join(ticketDir, 'tdd-phase.json');
      fs.writeFileSync(phasePath, JSON.stringify({
        currentPhase: 'refactor',
        currentCycle: 1,
        cycles: [{
          cycle: 1,
          red: { testFiles: ['a.test.ts'], testCommand: 'pnpm test', testExitCode: 1, timestamp: new Date().toISOString() },
          green: { testCommand: 'pnpm test', testExitCode: 0, timestamp: new Date().toISOString() },
        }],
      }));
      const { result } = await runOrchestrator(
        ['transition', TICKET, 'commit'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.success, true);
      assert.equal(result.to, 'commit');
    });

    it('phase state with only red evidence (no green) -> BLOCKED', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      writePartialPhaseState(TICKET);
      const { result } = await runOrchestrator(
        ['transition', TICKET, 'commit'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.error, true);
      assert.match(result.message, /RED.*GREEN/i);
    });

    it('phase state with empty cycles array -> BLOCKED', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      const ticketDir = path.join(tempTasksBase, TICKET);
      fs.mkdirSync(ticketDir, { recursive: true });
      const phasePath = path.join(ticketDir, 'tdd-phase.json');
      fs.writeFileSync(phasePath, JSON.stringify({
        currentPhase: 'red',
        currentCycle: 1,
        cycles: [],
      }));
      const { result } = await runOrchestrator(
        ['transition', TICKET, 'commit'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.error, true);
      assert.match(result.message, /No TDD cycles/i);
    });

    it('transition INTO 3_implement (from 6_check) deletes existing tdd-phase.json', async () => {
      // Walk to implement linearly
      await runOrchestrator(['transition', TICKET, 'bootstrap'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      await runOrchestrator(['transition', TICKET, 'brief'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      await runOrchestrator(['transition', TICKET, 'spec'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      await runOrchestrator(['transition', TICKET, 'implement'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });

      // Record valid evidence so we can leave 3_implement
      writeValidPhaseState(TICKET);
      await runOrchestrator(['transition', TICKET, 'commit'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      await runOrchestrator(['transition', TICKET, 'check'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });

      // Now create a stale phase state file for 3_implement
      const phasePath = path.join(tempTasksBase, TICKET, 'tdd-phase.json');
      fs.writeFileSync(phasePath, JSON.stringify({ currentPhase: 'red', currentCycle: 1, cycles: [] }));
      assert.ok(fs.existsSync(phasePath));

      // Transition back INTO 3_implement
      await runOrchestrator(['transition', TICKET, 'implement'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      assert.ok(!fs.existsSync(phasePath), 'Phase state file should be deleted on entry to 3_implement');
    });

    it('transition INTO 3_implement with no prior tdd-phase.json does not error (ENOENT handled)', async () => {
      await runOrchestrator(['transition', TICKET, 'bootstrap'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      await runOrchestrator(['transition', TICKET, 'brief'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      await runOrchestrator(['transition', TICKET, 'spec'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      // Make sure no phase state file exists
      const phasePath = path.join(tempTasksBase, TICKET, 'tdd-phase.json');
      try { fs.unlinkSync(phasePath); } catch {}

      const { result } = await runOrchestrator(
        ['transition', TICKET, 'implement'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.success, true);
    });

    it('corrupt JSON tdd-phase.json -> BLOCKED', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      const phasePath = path.join(tempTasksBase, TICKET, 'tdd-phase.json');
      fs.writeFileSync(phasePath, '{corrupt json!!!');

      const { result } = await runOrchestrator(
        ['transition', TICKET, 'commit'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.error, true);
      assert.match(result.message, /TDD evidence/i);
    });

    it('phase state with null evidence -> BLOCKED', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      const phasePath = path.join(tempTasksBase, TICKET, 'tdd-phase.json');
      fs.writeFileSync(phasePath, 'null');

      const { result } = await runOrchestrator(
        ['transition', TICKET, 'commit'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.error, true);
    });

    it('phase state without cycles key -> BLOCKED', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      const phasePath = path.join(tempTasksBase, TICKET, 'tdd-phase.json');
      fs.writeFileSync(phasePath, JSON.stringify({
        currentPhase: 'red',
        currentCycle: 1,
      }));

      const { result } = await runOrchestrator(
        ['transition', TICKET, 'commit'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.error, true);
      assert.match(result.message, /No TDD cycles/i);
    });

    it('transition 3_implement -> commit ALLOWED with exception-based tdd-phase.json', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      const ticketDir = path.join(tempTasksBase, TICKET);
      fs.mkdirSync(ticketDir, { recursive: true });
      const phasePath = path.join(ticketDir, 'tdd-phase.json');
      fs.writeFileSync(phasePath, JSON.stringify({
        currentPhase: 'exception',
        exception: 'config-only change, no testable behavior',
        cycles: [],
      }));
      const { result } = await runOrchestrator(
        ['transition', TICKET, 'commit'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.success, true);
      assert.equal(result.to, 'commit');
    });

    it('current commit -> check does not consult TDD evidence (non-gated step)', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      writeValidPhaseState(TICKET);
      await runOrchestrator(['transition', TICKET, 'commit'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });

      // Now try commit -> check without any evidence for commit (non-gated)
      const { result } = await runOrchestrator(
        ['transition', TICKET, 'check'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.success, true);
      assert.equal(result.to, 'check');
    });
  });

});
