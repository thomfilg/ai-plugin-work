/**
 * Regression tests for GH-106: Fix 'stuck in complete' deadlock
 *
 * Covers three root causes:
 * 1. No retry edge — complete had no outgoing transitions
 * 2. Verify gate too strict — enforce-step-workflow required CI at complete step
 * 3. Silent error swallowing — work-state.js exit 0 on uncaught exceptions
 *
 * Uses node:test + node:assert/strict, following work-state.test.js pattern.
 * Run: node --test workflows/work/__tests__/complete-deadlock.test.js
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WORK_STATE_PATH = path.join(__dirname, '..', 'work-state.js');
const TEMP_TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'complete-deadlock-test-'));

// ─── Helpers ────────────────────────────────────────────────────────────────

function runWorkState(args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [WORK_STATE_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TASKS_BASE: TEMP_TASKS_BASE, ...opts.env },
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

function writeState(ticketId, state) {
  const dir = path.join(TEMP_TASKS_BASE, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.work-state.json'), JSON.stringify(state, null, 2));
}

function readState(ticketId) {
  const fp = path.join(TEMP_TASKS_BASE, ticketId, '.work-state.json');
  return JSON.parse(fs.readFileSync(fp, 'utf-8'));
}

function cleanupTicket(ticketId) {
  const dir = path.join(TEMP_TASKS_BASE, ticketId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// ─── Global Cleanup ─────────────────────────────────────────────────────────

after(() => {
  try {
    fs.rmSync(TEMP_TASKS_BASE, { recursive: true, force: true });
  } catch {}
});

// ─── Test 1: complete -> complete self-transition exists ─────────────────────

describe('GH-106: complete step deadlock fix', () => {
  describe('1. step-registry: complete -> complete self-transition', () => {
    it('STEP_TRANSITIONS allows complete -> complete', () => {
      const { STEP_TRANSITIONS } = require(path.join(__dirname, '..', 'step-registry'));
      const completeTargets = STEP_TRANSITIONS['complete'] || [];
      assert.ok(
        completeTargets.includes('complete'),
        `Expected STEP_TRANSITIONS.complete to include 'complete' for retry, got: [${completeTargets}]`
      );
    });

    it('workflowCanTransition(complete, complete) returns true', () => {
      const { workflowCanTransition } = require(path.join(__dirname, '..', 'step-registry'));
      assert.ok(
        workflowCanTransition('complete', 'complete'),
        'workflowCanTransition(complete, complete) should return true for retry'
      );
    });
  });

  // ─── Test 2: verify gate relaxed for complete step ──────────────────────

  describe('2. enforce-step-workflow: complete is a soft step', () => {
    it('complete is in the softSteps set for the work workflow', () => {
      // We read the file and check that 'complete' appears in the softSteps definition
      const src = fs.readFileSync(path.join(__dirname, '..', 'workflow-definition.js'), 'utf-8');
      // The softSteps set should include STEPS.complete
      // Check for the pattern: softSteps containing complete
      assert.match(
        src,
        /softSteps:\s*new\s+Set\(\[[\s\S]*?STEPS\.complete[\s\S]*?\]\)/,
        'enforce-step-workflow.js should include STEPS.complete in softSteps'
      );
    });
  });

  // ─── Test 3: work-state.js complete command error handling ────────────────

  describe('3. work-state.js: complete command error handling', () => {
    it('complete exits 1 when no state exists (not silent exit 0)', async () => {
      const ticket = 'DEADLOCK-NO-STATE';
      cleanupTicket(ticket);

      const { code, stderr } = await runWorkState(['complete', ticket]);
      assert.equal(code, 1, 'complete should exit 1 when no state found');
      assert.ok(stderr.length > 0, 'complete should write error to stderr');
    });

    it('complete exits 0 and marks status completed on valid state', async () => {
      const ticket = 'DEADLOCK-VALID';
      cleanupTicket(ticket);

      // Initialize state first
      await runWorkState(['init', ticket, 'test ticket']);
      const { code, result } = await runWorkState(['complete', ticket]);

      assert.equal(code, 0, 'complete should exit 0 on success');
      assert.equal(result.status, 'completed', 'status should be completed');
      assert.ok(result.completedTime, 'completedTime should be set');
    });

    it('complete is idempotent — second call on completed state exits 0', async () => {
      const ticket = 'DEADLOCK-IDEMPOTENT';
      cleanupTicket(ticket);

      await runWorkState(['init', ticket, 'test ticket']);
      await runWorkState(['complete', ticket]);

      // Second call should also succeed
      const { code, result } = await runWorkState(['complete', ticket]);
      assert.equal(code, 0, 'second complete should exit 0');
      assert.equal(result.status, 'completed', 'status should remain completed');
    });
  });

  // ─── Test 4: exception handler exits 1 for complete command ──────────────

  describe('4. work-state.js: exception handler exits 1 for complete', () => {
    it('exits 1 when work-state.js complete encounters corrupt JSON', async () => {
      const ticket = 'DEADLOCK-CORRUPT';
      const dir = path.join(TEMP_TASKS_BASE, ticket);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.work-state.json'), '{{INVALID JSON');

      const { code } = await runWorkState(['complete', ticket]);
      // loadState returns null for corrupt JSON, so complete should exit 1
      assert.equal(code, 1, 'complete on corrupt state should exit 1');

      cleanupTicket(ticket);
    });
  });

  // ─── Test 5: STEP_ARTIFACTS does NOT include complete (self-transition doesn't trigger archival) ──

  describe('5. work.workflow.js: STEP_ARTIFACTS excludes complete', () => {
    it('STEP_ARTIFACTS does not have a complete entry (recovery archival is in unstick-complete.js)', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'work.workflow.js'), 'utf-8');
      assert.doesNotMatch(
        src,
        /STEP_ARTIFACTS[\s\S]*?\[STEPS\.complete\]/,
        'STEP_ARTIFACTS should not include complete — self-transitions do not trigger archival'
      );
    });
  });

  // ─── Test 6: complete step prompt includes archival ───────────────────────

  describe('6. workflows/work/steps/complete.js: complete step prompt includes archival', () => {
    it('complete step agentPrompt mentions archiving artifacts', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'steps', 'complete.js'),
        'utf-8'
      );
      assert.match(
        src,
        /archive|archiv/i,
        'complete step prompt should reference archiving artifacts'
      );
    });
  });

  // ─── Test 7: verify gate for complete is removed/relaxed ──────────────────

  describe('7. enforce-step-workflow: complete verify gate removed', () => {
    it('no verify function requiring CI checks exists for the complete step', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'lib', 'hooks', 'enforce-step-workflow.js'),
        'utf-8'
      );
      // The old verify function for complete checked CI via gh pr checks
      // After the fix, there should be no verify function for complete that calls gh pr checks
      const completeVerifyMatch = src.match(
        /step:\s*STEPS\.complete[^}]*verify:\s*\(ticketId\)\s*=>\s*\{[\s\S]*?\}\}/g
      );
      if (completeVerifyMatch) {
        // If a verify exists, it must NOT call 'gh pr checks'
        for (const match of completeVerifyMatch) {
          assert.ok(
            !match.includes('pr checks') && !match.includes("pr', 'checks"),
            'complete verify function should not check CI status via gh pr checks'
          );
        }
      }
      // If no verify function exists at all, that is also acceptable (soft step)
    });
  });

  // ─── Tests 8-10: unstick-complete.js helper unit tests ─────────────────────
  //
  // Load the module once with env vars set so config resolves.
  // If the module cannot load, the setup test FAILS (not silently skipped).

  describe('8-10. unstick-complete.js helpers', () => {
    let sanitizeTicketId, isStuckInComplete, archiveArtifacts;
    const origEnv = { ...process.env };

    it('setup — require unstick-complete.js', () => {
      process.env.TASKS_BASE = TEMP_TASKS_BASE;
      process.env.WORKTREES_BASE = TEMP_TASKS_BASE;
      process.env.REPO_NAME = 'test';
      delete require.cache[require.resolve('../unstick-complete')];
      // Must not throw — if it does, all subsequent tests in this block fail visibly
      const mod = require('../unstick-complete');
      sanitizeTicketId = mod.sanitizeTicketId;
      isStuckInComplete = mod.isStuckInComplete;
      archiveArtifacts = mod.archiveArtifacts;
      assert.ok(sanitizeTicketId, 'sanitizeTicketId must be exported');
      assert.ok(isStuckInComplete, 'isStuckInComplete must be exported');
      assert.ok(archiveArtifacts, 'archiveArtifacts must be exported');
    });

    // ─── sanitizeTicketId ──────────────────────────────────────────────────

    it('sanitize: accepts valid ticket IDs', () => {
      assert.equal(sanitizeTicketId('GH-106'), 'GH-106');
      assert.equal(sanitizeTicketId('PROJ-123'), 'PROJ-123');
      assert.equal(sanitizeTicketId('ticket_1'), 'ticket_1');
    });

    it('sanitize: accepts suffix tickets', () => {
      assert.equal(sanitizeTicketId('GH-145/phase1'), 'GH-145/phase1');
    });

    it('sanitize: rejects path traversal', () => {
      assert.equal(sanitizeTicketId('../etc'), null);
      assert.equal(sanitizeTicketId('..'), null);
      assert.equal(sanitizeTicketId('foo/../../bar'), null);
    });

    it('sanitize: rejects backslashes', () => {
      assert.equal(sanitizeTicketId('foo\\bar'), null);
    });

    it('sanitize: rejects empty and non-string', () => {
      assert.equal(sanitizeTicketId(''), null);
      assert.equal(sanitizeTicketId(null), null);
      assert.equal(sanitizeTicketId(undefined), null);
      assert.equal(sanitizeTicketId(123), null);
    });

    it('sanitize: rejects too many segments', () => {
      assert.equal(sanitizeTicketId('a/b/c'), null);
    });

    // ─── isStuckInComplete ─────────────────────────────────────────────────

    it('stuck: returns false for null/undefined state', () => {
      assert.equal(isStuckInComplete(null), false);
      assert.equal(isStuckInComplete(undefined), false);
    });

    it('stuck: returns false for completed tickets', () => {
      assert.equal(
        isStuckInComplete({ status: 'completed', stepStatus: { complete: 'completed' } }),
        false
      );
    });

    it('stuck: returns true when complete step is in_progress', () => {
      assert.equal(
        isStuckInComplete({ status: 'in_progress', stepStatus: { complete: 'in_progress' } }),
        true
      );
    });

    it('stuck: returns true when all other steps completed but complete is pending', () => {
      assert.equal(
        isStuckInComplete({
          status: 'in_progress',
          stepStatus: {
            ticket: 'completed',
            implement: 'completed',
            check: 'completed',
            complete: 'pending',
          },
        }),
        true
      );
    });

    it('stuck: returns false when other steps are still in progress', () => {
      assert.equal(
        isStuckInComplete({
          status: 'in_progress',
          stepStatus: { ticket: 'completed', implement: 'in_progress', complete: 'pending' },
        }),
        false
      );
    });

    // ─── archiveArtifacts ──────────────────────────────────────────────────

    it('archive: returns empty array for invalid ticket', () => {
      assert.deepEqual(archiveArtifacts('../invalid'), []);
    });

    it('archive: moves matching files to archive/ subdir', () => {
      const ticket = 'ARCHIVE-TEST-' + Date.now();
      const dir = path.join(TEMP_TASKS_BASE, ticket);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'tests.check.md'), 'test');
      fs.writeFileSync(path.join(dir, 'keep-me.txt'), 'keep');

      const archived = archiveArtifacts(ticket);
      assert.ok(archived.includes('tests.check.md'), 'tests.check.md should be archived');
      assert.ok(!archived.includes('keep-me.txt'), 'keep-me.txt should not be archived');
      assert.ok(fs.existsSync(path.join(dir, 'archive', 'tests.check.md')));
      assert.ok(fs.existsSync(path.join(dir, 'keep-me.txt')));
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('archive: handles duplicate with timestamp suffix', () => {
      const ticket = 'ARCHIVE-DUP-' + Date.now();
      const dir = path.join(TEMP_TASKS_BASE, ticket);
      const archiveDir = path.join(dir, 'archive');
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(path.join(archiveDir, 'tests.check.md'), 'old');
      fs.writeFileSync(path.join(dir, 'tests.check.md'), 'new');

      const archived = archiveArtifacts(ticket);
      assert.ok(archived.includes('tests.check.md'));
      assert.equal(fs.readFileSync(path.join(archiveDir, 'tests.check.md'), 'utf-8'), 'old');
      const files = fs.readdirSync(archiveDir);
      assert.ok(files.length >= 2, 'Should have original + timestamped file');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    after(() => {
      Object.assign(process.env, origEnv);
    });
  });
});
