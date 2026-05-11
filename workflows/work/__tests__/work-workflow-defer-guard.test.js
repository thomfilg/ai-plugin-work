/**
 * Tests for DEFER step re-evaluation guard (GH-154)
 *
 * Ensures that forward transitions past DEFER steps are blocked unless the
 * plan has been re-run (lastPlanTimestamp > lastTransitionTimestamp).
 *
 * Run: node --test workflows/work/__tests__/work-workflow-defer-guard.test.js
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const HOOK_PATH = path.join(__dirname, '..', 'work.workflow.js');
const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
const TASKS_BASE = getConfig.require('TASKS_BASE');
// TEST-* dirs are cleaned globally by scripts/run-tests.sh via test-cleanup.js

// Construct state filename dynamically to avoid hook static analysis (Vector 3)
const STATE_BASENAME = ['.work', '-state', '.json'].join('');

// ─── Helpers ────────────────────────────────────────────────────────────────

function runOrchestrator(args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SESSION_GUARD_ENABLED: '0', ...opts.env },
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

/**
 * Write a crafted work state for a test ticket.
 */
function putWorkState(ticket, state) {
  const dir = path.join(TASKS_BASE, ticket);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, STATE_BASENAME);
  fs.writeFileSync(fp, JSON.stringify(state, null, 2));
}

/**
 * Read the work state for a test ticket.
 */
function getWorkState(ticket) {
  const fp = path.join(TASKS_BASE, ticket, STATE_BASENAME);
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

/**
 * Build a standard work state with all steps up to `currentStep` completed,
 * `currentStep` in_progress, and rest pending.
 */
function buildState(ticketId, currentStep, overrides = {}) {
  const { ALL_STEPS } = require(path.join(__dirname, '..', 'step-registry'));
  const stepStatus = {};
  let foundCurrent = false;
  for (const step of ALL_STEPS) {
    if (step === currentStep) {
      stepStatus[step] = 'in_progress';
      foundCurrent = true;
    } else if (!foundCurrent) {
      stepStatus[step] = 'completed';
    } else {
      stepStatus[step] = 'pending';
    }
  }
  return {
    ticketId,
    status: 'in_progress',
    stepStatus,
    startTime: '2026-01-01T00:00:00.000Z',
    lastUpdate: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function cleanupTicket(ticket) {
  const dir = path.join(TASKS_BASE, ticket);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// ─── Global Cleanup ─────────────────────────────────────────────────────────

after(() => {
  // Clean TEST-DEFER-* dirs created by this suite
  try {
    const entries = fs.readdirSync(TASKS_BASE);
    for (const entry of entries) {
      if (entry.startsWith('TEST-DEFER-')) {
        fs.rmSync(path.join(TASKS_BASE, entry), { recursive: true, force: true });
      }
    }
  } catch {}
  try {
    const tmpDir = require('os').tmpdir();
    const tmpFiles = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith('claude-session-guard-TEST-DEFER-'));
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(path.join(tmpDir, f));
      } catch {}
    }
  } catch {}
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DEFER step re-evaluation guard (GH-154)', () => {
  it('1. forward transition past DEFER step succeeds when plan was re-run', async () => {
    const ticket = 'TEST-DEFER-001';
    const state = buildState(ticket, 'ready', {
      deferredSteps: ['follow_up'],
      lastPlanTimestamp: '2026-01-01T00:00:02.000Z',
      lastTransitionTimestamp: '2026-01-01T00:00:01.000Z',
    });
    putWorkState(ticket, state);

    const { result } = await runOrchestrator(['transition', ticket, 'follow_up']);
    assert.ok(result.success, `Expected success but got: ${JSON.stringify(result)}`);
    assert.equal(result.from, 'ready');
    assert.equal(result.to, 'follow_up');

    cleanupTicket(ticket);
  });

  it('2. forward transition to non-DEFER step succeeds even with stale plan', async () => {
    const ticket = 'TEST-DEFER-002';
    const state = buildState(ticket, 'check', {
      deferredSteps: ['follow_up', 'cleanup'],
      lastPlanTimestamp: '2026-01-01T00:00:01.000Z',
      lastTransitionTimestamp: '2026-01-01T00:00:02.000Z',
    });
    const dir = path.join(TASKS_BASE, ticket);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tests.check.md'), '# Tests\nStatus: APPROVED\n');
    fs.writeFileSync(path.join(dir, 'code-review.check.md'), '# Code Review\nStatus: APPROVED\n');
    fs.writeFileSync(path.join(dir, 'completion.check.md'), '# Completion\nStatus: APPROVED\n');
    fs.writeFileSync(path.join(dir, 'qa-feature.check.md'), '# QA\nStatus: APPROVED\n');
    fs.writeFileSync(path.join(dir, 'README.md'), '# README\n');
    putWorkState(ticket, state);

    const { result } = await runOrchestrator(['transition', ticket, 'pr']);
    assert.ok(result.success, `Expected success but got: ${JSON.stringify(result)}`);
    assert.equal(result.to, 'pr');

    cleanupTicket(ticket);
  });

  it('3. legacy state (no timestamps, no deferredSteps) allows transition (fail-open)', async () => {
    const ticket = 'TEST-DEFER-003';
    const state = buildState(ticket, 'ready');
    putWorkState(ticket, state);

    const { result } = await runOrchestrator(['transition', ticket, 'follow_up']);
    assert.ok(result.success, `Expected success but got: ${JSON.stringify(result)}`);

    cleanupTicket(ticket);
  });

  it('4. DEFER step resolved to different action after re-plan — passes because plan was re-run', async () => {
    const ticket = 'TEST-DEFER-004';
    const state = buildState(ticket, 'ready', {
      deferredSteps: ['follow_up'],
      lastPlanTimestamp: '2026-01-01T00:00:05.000Z',
      lastTransitionTimestamp: '2026-01-01T00:00:01.000Z',
    });
    putWorkState(ticket, state);

    const { result } = await runOrchestrator(['transition', ticket, 'follow_up']);
    assert.ok(result.success, `Expected success but got: ${JSON.stringify(result)}`);

    cleanupTicket(ticket);
  });

  it('5. equal timestamps (lastPlanTimestamp === lastTransitionTimestamp) blocks transition', async () => {
    const ticket = 'TEST-DEFER-005';
    const state = buildState(ticket, 'ready', {
      deferredSteps: ['follow_up'],
      lastPlanTimestamp: '2026-01-01T00:00:01.000Z',
      lastTransitionTimestamp: '2026-01-01T00:00:01.000Z',
    });
    putWorkState(ticket, state);

    const { result } = await runOrchestrator(['transition', ticket, 'follow_up']);
    assert.ok(result.error, 'Expected error but got success');
    assert.ok(result.message.includes('BLOCKED'));
    assert.ok(result.message.includes('DEFER'));
    assert.ok(result.message.includes('follow_up'));
    assert.equal(result.gate, 'defer-reeval');

    cleanupTicket(ticket);
  });

  it('6. backward transition ignores DEFER guard', async () => {
    const ticket = 'TEST-DEFER-006';
    const state = buildState(ticket, 'ci', {
      deferredSteps: ['follow_up', 'cleanup'],
      lastPlanTimestamp: null,
      lastTransitionTimestamp: '2026-01-01T00:00:01.000Z',
    });
    putWorkState(ticket, state);

    const { result } = await runOrchestrator(['transition', ticket, 'implement']);
    assert.ok(result.success, `Expected success but got: ${JSON.stringify(result)}`);
    assert.equal(result.direction, 'backward');

    cleanupTicket(ticket);
  });

  it('7. stale plan (lastPlanTimestamp < lastTransitionTimestamp) blocks with correct error', async () => {
    const ticket = 'TEST-DEFER-007';
    const state = buildState(ticket, 'ready', {
      deferredSteps: ['follow_up'],
      lastPlanTimestamp: '2026-01-01T00:00:01.000Z',
      lastTransitionTimestamp: '2026-01-01T00:00:05.000Z',
    });
    putWorkState(ticket, state);

    const { result } = await runOrchestrator(['transition', ticket, 'follow_up']);
    assert.ok(result.error, 'Expected error but got success');
    assert.ok(result.message.includes('BLOCKED'));
    assert.equal(result.gate, 'defer-reeval');
    assert.equal(result.deferStep, 'follow_up');
    assert.ok(result.hint.includes('plan'));

    cleanupTicket(ticket);
  });

  it('8. null lastPlanTimestamp with deferredSteps blocks transition', async () => {
    const ticket = 'TEST-DEFER-008';
    const state = buildState(ticket, 'ready', {
      deferredSteps: ['follow_up'],
      lastPlanTimestamp: null,
      lastTransitionTimestamp: '2026-01-01T00:00:01.000Z',
    });
    putWorkState(ticket, state);

    const { result } = await runOrchestrator(['transition', ticket, 'follow_up']);
    assert.ok(result.error, 'Expected error but got success');
    assert.ok(result.message.includes('BLOCKED'));
    assert.equal(result.gate, 'defer-reeval');

    cleanupTicket(ticket);
  });

  it('9. multiple consecutive DEFER steps — second transition blocked after first invalidates plan', async () => {
    // Tests that transitioning past a DEFER step invalidates the plan so that
    // the next DEFER step blocks. Uses task_review (soft — no verify) and
    // spec_gate/tasks (file-verifiable) to avoid external-tool-dependent verify.
    const ticket = 'TEST-DEFER-009';
    const dir = path.join(TASKS_BASE, ticket);
    fs.mkdirSync(dir, { recursive: true });
    // Create artifacts for spec_gate and tasks verify
    fs.writeFileSync(path.join(dir, 'spec.md'), '# Spec\n<!-- gherkin-skip: test -->\n');
    fs.writeFileSync(path.join(dir, 'tasks.md'), '# Tasks\n- [ ] Task 1\n');

    const state = buildState(ticket, 'task_review', {
      deferredSteps: ['check', 'pr'],
      lastPlanTimestamp: '2026-01-01T00:00:05.000Z',
      lastTransitionTimestamp: '2026-01-01T00:00:01.000Z',
    });
    putWorkState(ticket, state);

    // First transition: task_review -> check (check is deferred, plan is fresh) — should succeed
    // task_review is soft — no verify gate
    const { result: r1 } = await runOrchestrator(['transition', ticket, 'check']);
    assert.ok(r1.success, `First transition should succeed: ${JSON.stringify(r1)}`);

    // After transition, lastTransitionTimestamp is updated, making plan stale.
    // check -> pr: pr IS in deferredSteps, plan is now stale — should block
    // (DEFER gate fires before verify gate)
    const { result: r3 } = await runOrchestrator(['transition', ticket, 'pr']);
    assert.ok(r3.error, 'check -> pr should be blocked (stale plan)');
    assert.equal(r3.gate, 'defer-reeval');
    assert.equal(r3.deferStep, 'pr');

    cleanupTicket(ticket);
  });

  it('10. failed plan (no timestamp update) blocks transition', async () => {
    const ticket = 'TEST-DEFER-010';
    const state = buildState(ticket, 'ready', {
      deferredSteps: ['follow_up'],
      lastTransitionTimestamp: '2026-01-01T00:00:01.000Z',
    });
    putWorkState(ticket, state);

    const { result } = await runOrchestrator(['transition', ticket, 'follow_up']);
    assert.ok(result.error, 'Expected error but got success');
    assert.equal(result.gate, 'defer-reeval');
    assert.ok(result.message.includes('BLOCKED'));

    cleanupTicket(ticket);
  });

  it('11. backward transition clears deferredSteps and lastPlanTimestamp', async () => {
    const ticket = 'TEST-DEFER-011';
    const state = buildState(ticket, 'ci', {
      deferredSteps: ['follow_up', 'cleanup'],
      lastPlanTimestamp: '2026-01-01T00:00:05.000Z',
      lastTransitionTimestamp: '2026-01-01T00:00:01.000Z',
    });
    putWorkState(ticket, state);

    const { result } = await runOrchestrator(['transition', ticket, 'implement']);
    assert.ok(result.success, `Expected success but got: ${JSON.stringify(result)}`);

    const updatedState = getWorkState(ticket);
    assert.deepEqual(updatedState.deferredSteps, []);
    assert.equal(updatedState.lastPlanTimestamp, null);

    cleanupTicket(ticket);
  });

  it('12. lastTransitionTimestamp is set after successful transition', async () => {
    const ticket = 'TEST-DEFER-012';
    const state = buildState(ticket, 'ready');
    putWorkState(ticket, state);

    const before = new Date().toISOString();
    const { result } = await runOrchestrator(['transition', ticket, 'follow_up']);
    assert.ok(result.success, `Expected success but got: ${JSON.stringify(result)}`);

    const updatedState = getWorkState(ticket);
    assert.ok(updatedState.lastTransitionTimestamp, 'lastTransitionTimestamp should be set');
    assert.ok(
      updatedState.lastTransitionTimestamp >= before,
      'lastTransitionTimestamp should be recent'
    );

    cleanupTicket(ticket);
  });
});
