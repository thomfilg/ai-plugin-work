/**
 * Step 2 (bootstrap) → Step 3 (brief) enforcement checklist.
 *
 * Verifies enforcement at the bootstrap step:
 * - Rule 4: CLI bypass prevention
 * - Rule 5: Output file protection
 * - Rule 1: Step command matching (bootstrap is NOT soft — requires evidence)
 * - Bootstrap commandMap fix (Skill(bootstrap) records evidence)
 * - Transition requires evidence (not a soft step)
 * - Post-transition state
 *
 * Run: node --test hooks/__tests__/bootstrap-brief.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOOK_PATH = path.join(__dirname, '..', 'enforce-step-workflow.js');
const ORCHESTRATOR_PATH = path.join(__dirname, '..', 'work-orchestrator.js');
const WORK_STATE_PATH = path.join(__dirname, '..', 'work-state.js');
const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
const TASKS_BASE = getConfig.require('TASKS_BASE');

const TEST_TICKET = `STEP2-${process.pid}`;
const TASKS_DIR = path.join(TASKS_BASE, TEST_TICKET);

const ALL_STEPS = [
  'ticket', 'bootstrap', 'brief', 'spec', 'implement', 'quality',
  'commit', 'check', 'test_enhancement', 'pr', 'ready', 'follow_up',
  'ci', 'cleanup', 'reports', 'complete',
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function runHook(hookData, hookType = 'PreToolUse', env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_HOOK_TYPE: hookType, ENFORCE_HOOK_TICKET_ID: TEST_TICKET, ...env },
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => { resolve({ code, stdout, stderr }); });
    proc.on('error', reject);
    proc.stdin.write(JSON.stringify(hookData));
    proc.stdin.end();
  });
}

function setState(currentStep) {
  if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
  const stateFile = path.join(TASKS_DIR, '.work-state.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {
    state = { ticketId: TEST_TICKET, description: 'test', currentStep: 1, status: 'in_progress', stepStatus: {}, checkProgress: {}, testEnhancement: { initialRating: 0, finalRating: 0, iterations: 0, skipped: false, skipReason: null }, errors: [], startTime: new Date().toISOString(), lastUpdate: new Date().toISOString() };
  }
  const idx = ALL_STEPS.indexOf(currentStep);
  state.stepStatus = {};
  ALL_STEPS.forEach((s, i) => { state.stepStatus[s] = i < idx ? 'completed' : i === idx ? 'in_progress' : 'pending'; });
  state.status = 'in_progress';
  state.lastUpdate = new Date().toISOString();
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function readState() { return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, '.work-state.json'), 'utf8')); }
function clearEvidence() { try { fs.unlinkSync(path.join(TASKS_DIR, '.step-evidence.json')); } catch {} }
function readEvidence() { try { return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, '.step-evidence.json'), 'utf8')); } catch { return {}; } }
function readActions() { try { return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, '.work-actions.json'), 'utf8')); } catch { return []; } }

function runOrchestrator(args) {
  try {
    const out = execSync(`node ${ORCHESTRATOR_PATH} ${args}`, { encoding: 'utf8', timeout: 10000 });
    return JSON.parse(out);
  } catch (e) { try { return JSON.parse(e.stdout || '{}'); } catch { return { error: true, message: e.message }; } }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Step 2 (bootstrap) → Step 3 (brief) checklist', () => {

  beforeEach(() => {
    if (fs.existsSync(TASKS_DIR)) fs.rmSync(TASKS_DIR, { recursive: true, force: true });
    execSync(`node ${WORK_STATE_PATH} init ${TEST_TICKET} "test"`, { encoding: 'utf8' });
    setState('bootstrap');
  });

  afterEach(() => {
    if (fs.existsSync(TASKS_DIR)) fs.rmSync(TASKS_DIR, { recursive: true, force: true });
  });

  // ═══ 1. Bootstrap is NOT a soft step ═══

  describe('1. Bootstrap requires evidence', () => {
    it('transition without evidence → blocked', async () => {
      clearEvidence();
      const { code, stderr } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} brief` } });
      assert.equal(code, 2);
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('transition with evidence → allowed', async () => {
      clearEvidence();
      await runHook({ tool_name: 'Skill', tool_input: { skill: 'bootstrap' } }, 'PostToolUse');
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} brief` } });
      assert.equal(code, 0);
    });
  });

  // ═══ 2. Rule 4: CLI bypass ═══

  describe('2. Rule 4: CLI bypass blocked', () => {
    it('set-step → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} set-step ${TEST_TICKET} bootstrap completed` } });
      assert.equal(code, 2);
    });

    it('add-error → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} add-error ${TEST_TICKET} bootstrap "err"` } });
      assert.equal(code, 2);
    });

    it('get → allowed', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} get ${TEST_TICKET}` } });
      assert.equal(code, 0);
    });
  });

  // ═══ 3. Rule 5: Output file protection ═══

  describe('3. Rule 5: Output files blocked at bootstrap', () => {
    for (const file of ['brief.md', 'spec.md', 'tests.check.md', 'code-review.check.md', 'completion.check.md']) {
      it(`Write ${file} → blocked`, async () => {
        const { code } = await runHook({ tool_name: 'Write', tool_input: { file_path: path.join(TASKS_DIR, file), content: 'x' } });
        assert.equal(code, 2);
      });
    }

    it('Write unprotected file → allowed', async () => {
      const { code } = await runHook({ tool_name: 'Write', tool_input: { file_path: path.join(TASKS_DIR, 'notes.md'), content: 'x' } });
      assert.equal(code, 0);
    });
  });

  // ═══ 4. Rule 1: Step command matching ═══

  describe('4. Rule 1: Commands at bootstrap step', () => {
    it('Skill(bootstrap) → allowed (matches bootstrap)', async () => {
      const { code } = await runHook({ tool_name: 'Skill', tool_input: { skill: 'bootstrap' } });
      assert.equal(code, 0);
    });

    it('Task "bootstrap setup" → allowed', async () => {
      const { code } = await runHook({ tool_name: 'Task', tool_input: { description: 'bootstrap worktree', subagent_type: 'general-purpose' } });
      assert.equal(code, 0);
    });

    it('Task(brief-writer) → blocked (wrong step)', async () => {
      const { code } = await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'brief-writer', description: 'gen brief' } });
      assert.equal(code, 2);
    });

    it('Skill(work-implement) → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Skill', tool_input: { skill: 'work-implement' } });
      assert.equal(code, 2);
    });

    it('Task(commit-writer) → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'commit-writer' } });
      assert.equal(code, 2);
    });

    it('Skill(check) → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Skill', tool_input: { skill: 'check' } });
      assert.equal(code, 2);
    });
  });

  // ═══ 5. Evidence recording ═══

  describe('5. Evidence recording', () => {
    it('Skill(bootstrap) records evidence via PostToolUse', async () => {
      clearEvidence();
      await runHook({ tool_name: 'Skill', tool_input: { skill: 'bootstrap' } }, 'PostToolUse');
      const ev = readEvidence();
      assert.equal(ev.bootstrap?.executed, true);
      assert.ok(ev.bootstrap?.timestamp);
    });

    it('Task "bootstrap" records evidence via PostToolUse', async () => {
      clearEvidence();
      await runHook({ tool_name: 'Task', tool_input: { description: 'bootstrap setup', subagent_type: 'general-purpose' } }, 'PostToolUse');
      const ev = readEvidence();
      assert.equal(ev.bootstrap?.executed, true);
    });

    it('only bootstrap has evidence (no leakage)', async () => {
      clearEvidence();
      await runHook({ tool_name: 'Skill', tool_input: { skill: 'bootstrap' } }, 'PostToolUse');
      const ev = readEvidence();
      assert.equal(Object.keys(ev).length, 1);
      assert.ok('bootstrap' in ev);
    });
  });

  // ═══ 6. Transition targets ═══

  describe('6. Transition targets', () => {
    beforeEach(async () => {
      clearEvidence();
      await runHook({ tool_name: 'Skill', tool_input: { skill: 'bootstrap' } }, 'PostToolUse');
    });

    it('bootstrap → brief allowed', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} brief` } });
      assert.equal(code, 0);
    });

    it('bootstrap → implement allowed (skip brief/spec)', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} implement` } });
      assert.equal(code, 0);
    });

    it('orchestrator rejects bootstrap → follow_up', () => {
      const result = runOrchestrator(`transition ${TEST_TICKET} follow_up`);
      assert.equal(result.error, true);
    });
  });

  // ═══ 7. Post-transition state ═══

  describe('7. Post-transition state', () => {
    it('after bootstrap → brief: bootstrap=completed, brief=in_progress', () => {
      clearEvidence();
      // Record evidence then transition
      execSync(`echo '{"tool_name":"Skill","tool_input":{"skill":"bootstrap"}}' | ENFORCE_HOOK_TICKET_ID=${TEST_TICKET} CLAUDE_HOOK_TYPE=PostToolUse node ${HOOK_PATH}`, { encoding: 'utf8' });
      runOrchestrator(`transition ${TEST_TICKET} brief`);
      const st = readState();
      assert.equal(st.stepStatus.ticket, 'completed');
      assert.equal(st.stepStatus.bootstrap, 'completed');
      assert.equal(st.stepStatus.brief, 'in_progress');
      assert.equal(st.status, 'in_progress');
    });

    it('evidence preserved after transition', () => {
      clearEvidence();
      execSync(`echo '{"tool_name":"Skill","tool_input":{"skill":"bootstrap"}}' | ENFORCE_HOOK_TICKET_ID=${TEST_TICKET} CLAUDE_HOOK_TYPE=PostToolUse node ${HOOK_PATH}`, { encoding: 'utf8' });
      runOrchestrator(`transition ${TEST_TICKET} brief`);
      const ev = readEvidence();
      assert.ok(ev.bootstrap?.executed);
    });
  });

  // ═══ 8. Bootstrap deadlock fix verification ═══

  describe('8. Bootstrap deadlock fix (GH-89)', () => {
    it('Skill(bootstrap) is in commandMap (was missing → caused deadlock)', async () => {
      clearEvidence();
      // Before fix: no commandMap entry for Skill(bootstrap) → evidence never recorded → deadlock
      // After fix: Skill(bootstrap) matches commandMap → evidence recorded → transition works
      await runHook({ tool_name: 'Skill', tool_input: { skill: 'bootstrap' } }, 'PostToolUse');
      const ev = readEvidence();
      assert.ok(ev.bootstrap?.executed, 'Skill(bootstrap) should record evidence (commandMap entry exists)');

      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} brief` } });
      assert.equal(code, 0, 'transition should work after Skill(bootstrap) evidence');
    });
  });
});
