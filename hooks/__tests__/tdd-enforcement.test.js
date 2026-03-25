/**
 * Tests for TDD enforcement feature in work-orchestrator.js
 *
 * Covers:
 *   - WORK_TDD_ENFORCE toggle behavior
 *   - Prompt augmentation (TDD_PROTOCOL injection)
 *   - Gate enforcement (transition blocking without evidence)
 *   - record-tdd subcommand
 *
 * Uses node:test + node:assert/strict.
 * Run: node --test hooks/__tests__/tdd-enforcement.test.js
 */

const { describe, it, after, afterEach, before } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'work-orchestrator.js');

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
    'bootstrap', 'brief', 'spec', 'implement', 'quality', 'commit',
    'check', 'test_enhancement', 'pr',
    'ready', 'ci', 'cleanup', 'reports', 'complete',
  ];
  const idx = steps.indexOf(targetStep);
  if (idx === -1) throw new Error(`Unknown target step: ${targetStep}`);

  let lastResult;
  // Walk step by step. Some steps require skip edges; use the direct path.
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
      assert.match(implStep.agentPrompt, /confirm RED/i);
    });

    it('with WORK_TDD_ENFORCE=0: agentPrompt for 3_implement does NOT include TDD protocol', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv({ WORK_TDD_ENFORCE: '0' }),
      });
      const implStep = result.plan.find(s => s.step === 'implement');
      assert.ok(implStep, '3_implement step must exist in plan');
      assert.doesNotMatch(implStep.agentPrompt || '', /confirm RED/i);
    });

    it('with WORK_TDD_ENFORCE empty: agentPrompt for 3_implement does NOT include TDD protocol', async () => {
      // Set WORK_TDD_ENFORCE to empty string to override any inherited env value
      const { result } = await runOrchestrator(['plan', TICKET], { env: baseEnv({ WORK_TDD_ENFORCE: '' }) });
      const implStep = result.plan.find(s => s.step === 'implement');
      assert.ok(implStep, '3_implement step must exist in plan');
      assert.doesNotMatch(implStep.agentPrompt || '', /confirm RED/i);
    });

    it('with WORK_TDD_ENFORCE=1: transition 3_implement -> 4_quality BLOCKED without evidence', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      const { result } = await runOrchestrator(
        ['transition', TICKET, 'quality'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.error, true);
      assert.match(result.message, /TDD evidence/i);
    });

    it('with WORK_TDD_ENFORCE=0: transition 3_implement -> 4_quality ALLOWED without evidence', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '0' });
      const { result } = await runOrchestrator(
        ['transition', TICKET, 'quality'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '0' }) },
      );
      assert.equal(result.success, true);
    });

    it('with WORK_TDD_ENFORCE empty: transition 3_implement -> 4_quality ALLOWED without evidence', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '' });
      const { result } = await runOrchestrator(
        ['transition', TICKET, 'quality'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '' }) },
      );
      assert.equal(result.success, true);
    });

    it('with WORK_TDD_ENFORCE=1: transition INTO 3_implement deletes stale evidence', async () => {
      // Setup: create a stale evidence file
      const ticketDir = path.join(tempTasksBase, TICKET);
      fs.mkdirSync(ticketDir, { recursive: true });
      const evidencePath = path.join(ticketDir, '.tdd-evidence-implement.json');
      fs.writeFileSync(evidencePath, JSON.stringify({ step: 'implement', stale: true }));
      assert.ok(fs.existsSync(evidencePath), 'Stale evidence should exist before transition');

      // Transition to 2_bootstrap first, then to 3_implement
      await runOrchestrator(['transition', TICKET, 'bootstrap'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      await runOrchestrator(['transition', TICKET, 'implement'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });

      assert.ok(!fs.existsSync(evidencePath), 'Stale evidence should be deleted when entering 3_implement');
    });

    it('with WORK_TDD_ENFORCE=0: transition INTO 3_implement does NOT delete existing evidence files', async () => {
      const ticketDir = path.join(tempTasksBase, TICKET);
      fs.mkdirSync(ticketDir, { recursive: true });
      const evidencePath = path.join(ticketDir, '.tdd-evidence-implement.json');
      fs.writeFileSync(evidencePath, JSON.stringify({ step: 'implement', kept: true }));

      await runOrchestrator(['transition', TICKET, 'bootstrap'], { env: baseEnv({ WORK_TDD_ENFORCE: '0' }) });
      await runOrchestrator(['transition', TICKET, 'implement'], { env: baseEnv({ WORK_TDD_ENFORCE: '0' }) });

      assert.ok(fs.existsSync(evidencePath), 'Evidence file should NOT be deleted when WORK_TDD_ENFORCE=0');
    });

    it('record-tdd works regardless of WORK_TDD_ENFORCE value (always writes evidence)', async () => {
      const { result, code } = await runOrchestrator(
        ['record-tdd', TICKET, 'implement', '--cmd', 'pnpm test', '--red', '--green', '--files', 'a.test.ts'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '0' }) },
      );
      assert.equal(code, 0);
      assert.equal(result.recorded, true);
      const evidencePath = path.join(tempTasksBase, TICKET, '.tdd-evidence-implement.json');
      assert.ok(fs.existsSync(evidencePath), 'Evidence should be written even with WORK_TDD_ENFORCE=0');
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

    it('plan for 8_test_enhancement includes TDD instructions in agentPrompt', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv({ WORK_TDD_ENFORCE: '1' }),
      });
      const testStep = result.plan.find(s => s.step === 'test_enhancement');
      // 8_test_enhancement is RUN by default (not yet run), so it gets TDD protocol
      if (testStep.action === 'RUN') {
        assert.ok(testStep.agentPrompt.includes('TDD protocol'), 'Should include TDD protocol header');
      }
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

    it('agentPrompt for 3_implement contains the real orchestrator path', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv({ WORK_TDD_ENFORCE: '1' }),
      });
      const implStep = result.plan.find(s => s.step === 'implement');
      const realPath = path.join(__dirname, '..', 'work-orchestrator.js');
      assert.ok(implStep.agentPrompt.includes(realPath), 'Should contain the real orchestrator path');
    });

    it('agentPrompt for 3_implement contains the real ticket ID', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv({ WORK_TDD_ENFORCE: '1' }),
      });
      const implStep = result.plan.find(s => s.step === 'implement');
      assert.ok(implStep.agentPrompt.includes(TICKET), 'Should contain the real ticket ID');
    });

    it('agentPrompt for 3_implement does not contain literal <ORCHESTRATOR_PATH>', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv({ WORK_TDD_ENFORCE: '1' }),
      });
      const implStep = result.plan.find(s => s.step === 'implement');
      assert.doesNotMatch(implStep.agentPrompt, /<ORCHESTRATOR_PATH>/);
    });

    it('agentPrompt for 3_implement does not contain literal <TICKET_ID>', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv({ WORK_TDD_ENFORCE: '1' }),
      });
      const implStep = result.plan.find(s => s.step === 'implement');
      assert.doesNotMatch(implStep.agentPrompt, /<TICKET_ID>/);
    });

    it('agentPrompt for 3_implement does not contain literal <step_id>', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv({ WORK_TDD_ENFORCE: '1' }),
      });
      const implStep = result.plan.find(s => s.step === 'implement');
      assert.doesNotMatch(implStep.agentPrompt, /<step_id>/);
    });

    it('agentPrompt for 3_implement contains literal string 3_implement in the record-tdd command', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv({ WORK_TDD_ENFORCE: '1' }),
      });
      const implStep = result.plan.find(s => s.step === 'implement');
      assert.ok(implStep.agentPrompt.includes('record-tdd'), 'Should contain record-tdd command');
      assert.ok(implStep.agentPrompt.includes('implement'), 'Should contain 3_implement in record-tdd');
    });

    it('agentPrompt for 8_test_enhancement contains literal string 8_test_enhancement in the record-tdd command', async () => {
      const { result } = await runOrchestrator(['plan', TICKET], {
        env: baseEnv({ WORK_TDD_ENFORCE: '1' }),
      });
      const testStep = result.plan.find(s => s.step === 'test_enhancement');
      if (testStep.action === 'RUN') {
        assert.ok(testStep.agentPrompt.includes('record-tdd'), 'Should contain record-tdd command');
        assert.ok(testStep.agentPrompt.includes('test_enhancement'), 'Should contain 8_test_enhancement in record-tdd');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Gate enforcement tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Gate enforcement (WORK_TDD_ENFORCE=1)', () => {
    const TICKET = 'TDDG-300';
    afterEach(() => { cleanupTempWorkState(TICKET); });

    it('transition 3_implement -> 4_quality BLOCKED without evidence file', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      const { result } = await runOrchestrator(
        ['transition', TICKET, 'quality'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.error, true);
      assert.match(result.message, /TDD evidence/i);
    });

    it('transition 3_implement -> 4_quality ALLOWED with valid evidence file', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      // Record valid evidence
      await runOrchestrator(
        ['record-tdd', TICKET, 'implement', '--cmd', 'pnpm test', '--red', '--green', '--files', 'a.test.ts'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      const { result } = await runOrchestrator(
        ['transition', TICKET, 'quality'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.success, true);
      assert.equal(result.to, 'quality');
    });

    it('transition 3_implement -> 4_quality ALLOWED with exception evidence', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      // Record exception evidence
      await runOrchestrator(
        ['record-tdd', TICKET, 'implement', '--exception', 'config only change'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      const { result } = await runOrchestrator(
        ['transition', TICKET, 'quality'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.success, true);
      assert.equal(result.to, 'quality');
    });

    it('transition 8_test_enhancement -> 5_commit BLOCKED without evidence file', async () => {
      // Walk to 8_test_enhancement: 2_bootstrap -> 6_check (skip edge) -> 8_test_enhancement
      await runOrchestrator(['transition', TICKET, 'bootstrap'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      await runOrchestrator(['transition', TICKET, 'check'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      await runOrchestrator(['transition', TICKET, 'test_enhancement'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });

      const { result } = await runOrchestrator(
        ['transition', TICKET, 'commit'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.error, true);
      assert.match(result.message, /TDD evidence/i);
    });

    it('evidence with redConfirmed: false, greenConfirmed: true, no exception -> BLOCKED', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      const evidencePath = path.join(tempTasksBase, TICKET, '.tdd-evidence-implement.json');
      fs.writeFileSync(evidencePath, JSON.stringify({
        step: 'implement',
        targetedTestCommand: 'pnpm test',
        redConfirmed: false,
        greenConfirmed: true,
        testFilesChanged: ['a.test.ts'],
        exceptionReason: '',
      }));

      const { result } = await runOrchestrator(
        ['transition', TICKET, 'quality'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.error, true);
      assert.match(result.message, /redConfirmed/i);
    });

    it('evidence with whitespace-only targetedTestCommand -> BLOCKED', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      const evidencePath = path.join(tempTasksBase, TICKET, '.tdd-evidence-implement.json');
      fs.writeFileSync(evidencePath, JSON.stringify({
        step: 'implement',
        targetedTestCommand: '   ',
        redConfirmed: true,
        greenConfirmed: true,
        testFilesChanged: ['a.test.ts'],
        exceptionReason: '',
      }));

      const { result } = await runOrchestrator(
        ['transition', TICKET, 'quality'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.error, true);
      assert.match(result.message, /targetedTestCommand/i);
    });

    it('evidence with empty testFilesChanged and no exception -> BLOCKED', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      const evidencePath = path.join(tempTasksBase, TICKET, '.tdd-evidence-implement.json');
      fs.writeFileSync(evidencePath, JSON.stringify({
        step: 'implement',
        targetedTestCommand: 'pnpm test',
        redConfirmed: true,
        greenConfirmed: true,
        testFilesChanged: [],
        exceptionReason: '',
      }));

      const { result } = await runOrchestrator(
        ['transition', TICKET, 'quality'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.error, true);
      assert.match(result.message, /testFilesChanged/i);
    });

    it('evidence with greenConfirmed: false and no exceptionReason is BLOCKED', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      const evidencePath = path.join(tempTasksBase, TICKET, '.tdd-evidence-implement.json');
      fs.writeFileSync(evidencePath, JSON.stringify({
        step: 'implement',
        targetedTestCommand: 'pnpm test',
        redConfirmed: true,
        greenConfirmed: false,
        testFilesChanged: ['a.test.ts'],
        exceptionReason: '',
      }));

      const { result } = await runOrchestrator(
        ['transition', TICKET, 'quality'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.error, true);
      assert.match(result.message, /greenConfirmed/i);
    });

    it('transition INTO 3_implement (from 6_check) deletes existing .tdd-evidence-implement.json', async () => {
      // Walk to 6_check
      await runOrchestrator(['transition', TICKET, 'bootstrap'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      await runOrchestrator(['transition', TICKET, 'implement'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });

      // Record evidence so we can leave 3_implement
      await runOrchestrator(
        ['record-tdd', TICKET, 'implement', '--cmd', 'pnpm test', '--red', '--green', '--files', 'a.test.ts'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      await runOrchestrator(['transition', TICKET, 'quality'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      await runOrchestrator(['transition', TICKET, 'commit'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      await runOrchestrator(['transition', TICKET, 'check'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });

      // Now create a stale evidence file for 3_implement
      const evidencePath = path.join(tempTasksBase, TICKET, '.tdd-evidence-implement.json');
      fs.writeFileSync(evidencePath, JSON.stringify({ step: 'implement', stale: true }));
      assert.ok(fs.existsSync(evidencePath));

      // Transition back INTO 3_implement
      await runOrchestrator(['transition', TICKET, 'implement'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      assert.ok(!fs.existsSync(evidencePath), 'Evidence file should be deleted on entry to 3_implement');
    });

    it('transition INTO 3_implement with no prior evidence file does not error (ENOENT handled)', async () => {
      await runOrchestrator(['transition', TICKET, 'bootstrap'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      // Make sure no evidence file exists
      const evidencePath = path.join(tempTasksBase, TICKET, '.tdd-evidence-implement.json');
      try { fs.unlinkSync(evidencePath); } catch {}

      const { result } = await runOrchestrator(
        ['transition', TICKET, 'implement'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.success, true);
    });

    it('corrupt JSON evidence file -> BLOCKED', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      const evidencePath = path.join(tempTasksBase, TICKET, '.tdd-evidence-implement.json');
      fs.writeFileSync(evidencePath, '{corrupt json!!!');

      const { result } = await runOrchestrator(
        ['transition', TICKET, 'quality'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.error, true);
      assert.match(result.message, /TDD evidence/i);
    });

    it('evidence file with wrong step value -> BLOCKED', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      const evidencePath = path.join(tempTasksBase, TICKET, '.tdd-evidence-implement.json');
      fs.writeFileSync(evidencePath, JSON.stringify({
        step: 'test_enhancement',
        targetedTestCommand: 'pnpm test',
        redConfirmed: true,
        greenConfirmed: true,
        testFilesChanged: ['a.test.ts'],
        exceptionReason: '',
      }));

      const { result } = await runOrchestrator(
        ['transition', TICKET, 'quality'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.error, true);
      assert.match(result.message, /Step mismatch/i);
    });

    it('evidence file with missing required keys -> BLOCKED', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      const evidencePath = path.join(tempTasksBase, TICKET, '.tdd-evidence-implement.json');
      fs.writeFileSync(evidencePath, JSON.stringify({
        step: 'implement',
        // Missing: targetedTestCommand, redConfirmed, greenConfirmed, testFilesChanged
      }));

      const { result } = await runOrchestrator(
        ['transition', TICKET, 'quality'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.error, true);
      assert.match(result.message, /invalid/i);
    });

    it('evidence file with greenConfirmed: "true" (string instead of boolean) -> BLOCKED', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      const evidencePath = path.join(tempTasksBase, TICKET, '.tdd-evidence-implement.json');
      fs.writeFileSync(evidencePath, JSON.stringify({
        step: 'implement',
        targetedTestCommand: 'pnpm test',
        redConfirmed: 'true',
        greenConfirmed: 'true',
        testFilesChanged: ['a.test.ts'],
        exceptionReason: '',
      }));

      const { result } = await runOrchestrator(
        ['transition', TICKET, 'quality'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.error, true);
      assert.match(result.message, /boolean/i);
    });

    it('evidence file with exceptionReason: "  " (whitespace-only after trim) -> BLOCKED', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      const evidencePath = path.join(tempTasksBase, TICKET, '.tdd-evidence-implement.json');
      fs.writeFileSync(evidencePath, JSON.stringify({
        step: 'implement',
        targetedTestCommand: '',
        redConfirmed: false,
        greenConfirmed: false,
        testFilesChanged: [],
        exceptionReason: '   ',
      }));

      const { result } = await runOrchestrator(
        ['transition', TICKET, 'quality'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.error, true);
    });

    it('current 4_quality -> 5_commit does not consult TDD evidence (non-gated step)', async () => {
      await transitionTo(TICKET, 'implement', { WORK_TDD_ENFORCE: '1' });
      // Record evidence so we can leave 3_implement
      await runOrchestrator(
        ['record-tdd', TICKET, 'implement', '--cmd', 'pnpm test', '--red', '--green', '--files', 'a.test.ts'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      await runOrchestrator(['transition', TICKET, 'quality'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });

      // Now try 4_quality -> 5_commit without any evidence for 4_quality (non-gated)
      const { result } = await runOrchestrator(
        ['transition', TICKET, 'commit'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.equal(result.success, true);
      assert.equal(result.to, 'commit');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // record-tdd subcommand tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('record-tdd subcommand', () => {
    const TICKET = 'TDDR-400';
    afterEach(() => { cleanupTempWorkState(TICKET); });

    it('record-tdd with normal flags creates valid evidence file', async () => {
      const { result, code } = await runOrchestrator(
        ['record-tdd', TICKET, 'implement', '--cmd', 'pnpm test', '--red', '--green', '--files', 'a.test.ts'],
        { env: baseEnv() },
      );
      assert.equal(code, 0);
      assert.equal(result.recorded, true);

      // Read the file and validate
      const evidencePath = path.join(tempTasksBase, TICKET, '.tdd-evidence-implement.json');
      const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf-8'));
      assert.equal(evidence.step, 'implement');
      assert.equal(evidence.targetedTestCommand, 'pnpm test');
      assert.equal(evidence.redConfirmed, true);
      assert.equal(evidence.greenConfirmed, true);
      assert.deepEqual(evidence.testFilesChanged, ['a.test.ts']);
      assert.equal(evidence.exceptionReason, '');
    });

    it('record-tdd with --exception creates valid exception evidence file', async () => {
      const { result, code } = await runOrchestrator(
        ['record-tdd', TICKET, 'implement', '--exception', 'config only'],
        { env: baseEnv() },
      );
      assert.equal(code, 0);
      assert.equal(result.recorded, true);

      const evidencePath = path.join(tempTasksBase, TICKET, '.tdd-evidence-implement.json');
      const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf-8'));
      assert.equal(evidence.step, 'implement');
      assert.equal(evidence.exceptionReason, 'config only');
      assert.equal(evidence.redConfirmed, false);
      assert.equal(evidence.greenConfirmed, false);
      assert.deepEqual(evidence.testFilesChanged, []);
    });

    it('record-tdd for non-gated step rejects (exit code 1)', async () => {
      const { code, stderr } = await runOrchestrator(
        ['record-tdd', TICKET, 'quality', '--cmd', 'pnpm test', '--red', '--green', '--files', 'a.test.ts'],
        { env: baseEnv() },
      );
      assert.equal(code, 1);
      assert.ok(stderr.includes('invalid_step') || stderr.includes('not a TDD-gated step'));
    });

    it('record-tdd without required flags returns error on stderr (exit code 1)', async () => {
      const { code, stderr } = await runOrchestrator(
        ['record-tdd', TICKET, 'implement'],
        { env: baseEnv() },
      );
      assert.equal(code, 1);
      assert.ok(stderr.includes('missing_flag') || stderr.includes('required'));
    });

    it('record-tdd with --green but without --cmd returns error', async () => {
      const { code, stderr } = await runOrchestrator(
        ['record-tdd', TICKET, 'implement', '--green', '--red', '--files', 'a.test.ts'],
        { env: baseEnv() },
      );
      assert.equal(code, 1);
      assert.ok(stderr.includes('--cmd') || stderr.includes('missing_flag'));
    });

    it('record-tdd with empty --files (comma-only) returns error', async () => {
      const { code, stderr } = await runOrchestrator(
        ['record-tdd', 'TEST-EMPTY', 'implement', '--cmd', 'pnpm test', '--red', '--green', '--files', ','],
        { env: baseEnv() },
      );
      assert.equal(code, 1);
      assert.ok(stderr.includes('at least one test file'));
    });

    it('calling record-tdd twice overwrites previous evidence cleanly', async () => {
      // First call
      await runOrchestrator(
        ['record-tdd', TICKET, 'implement', '--cmd', 'pnpm test:old', '--red', '--green', '--files', 'old.test.ts'],
        { env: baseEnv() },
      );

      // Second call with different values
      const { result, code } = await runOrchestrator(
        ['record-tdd', TICKET, 'implement', '--cmd', 'pnpm test:new', '--red', '--green', '--files', 'new.test.ts'],
        { env: baseEnv() },
      );
      assert.equal(code, 0);
      assert.equal(result.recorded, true);

      // Verify it was overwritten
      const evidencePath = path.join(tempTasksBase, TICKET, '.tdd-evidence-implement.json');
      const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf-8'));
      assert.equal(evidence.targetedTestCommand, 'pnpm test:new');
      assert.deepEqual(evidence.testFilesChanged, ['new.test.ts']);
    });

    it('record-tdd with path-traversal ticket ID returns error, no file outside tasks dir', async () => {
      const { code, stderr } = await runOrchestrator(
        ['record-tdd', '../../etc', 'implement', '--exception', 'test'],
        { env: baseEnv() },
      );
      assert.equal(code, 1);
      assert.ok(stderr.includes('Invalid ticket id') || stderr.includes('invalid'),
        'Should reject path-traversal ticket ID');

      // Verify no file written outside tasks dir
      const outsidePath = path.resolve(tempTasksBase, '../../etc', '.tdd-evidence-implement.json');
      assert.ok(!fs.existsSync(outsidePath), 'No file should be written outside tasks dir');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Transition graph enforcement for TDD-gated steps
  // ═══════════════════════════════════════════════════════════════════════════

  describe('transition graph enforcement for 8_test_enhancement', () => {
    const TICKET = 'TDDT-500';
    afterEach(() => { cleanupTempWorkState(TICKET); });

    it('transition graph prevents skipping 8_test_enhancement from 7_cleanup', async () => {
      // 7_cleanup can only go to 8_test_enhancement (graph enforces it)
      await transitionTo(TICKET, 'cleanup', { WORK_TDD_ENFORCE: '0' });

      const { result } = await runOrchestrator(
        ['transition', TICKET, 'pr'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '0' }) },
      );
      assert.ok(result.error, 'Graph should block 7_cleanup → 9_pr');
      assert.ok(result.message.includes('BLOCKED'), 'Should include BLOCKED');
    });

    it('TDD gate blocks leaving 8_test_enhancement without evidence', async () => {
      // Walk to 8_test_enhancement via skip edge (2_bootstrap → 6_check → 8_test_enhancement)
      await runOrchestrator(['transition', TICKET, 'bootstrap'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      await runOrchestrator(['transition', TICKET, 'check'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });
      await runOrchestrator(['transition', TICKET, 'test_enhancement'], { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) });

      const { result } = await runOrchestrator(
        ['transition', TICKET, 'pr'],
        { env: baseEnv({ WORK_TDD_ENFORCE: '1' }) },
      );
      assert.ok(result.error, 'Should block leaving 8_test_enhancement without evidence');
      assert.match(result.message, /TDD evidence/i);
    });
  });
});
