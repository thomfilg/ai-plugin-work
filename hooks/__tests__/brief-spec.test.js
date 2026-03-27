/**
 * Step 3 (brief) → Step 4 (spec) enforcement checklist.
 *
 * Brief is the first ENFORCED step with output file requirement.
 * Verifies:
 * - brief is NOT a soft step (requires evidence)
 * - brief.md must exist to transition (compound evidence)
 * - brief.md can only be written at brief step (output protection)
 * - Only brief-writer agent can produce evidence
 *
 * Run: node --test hooks/__tests__/brief-spec.test.js
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

const TEST_TICKET = `STEP3-${process.pid}`;
const TASKS_DIR = path.join(TASKS_BASE, TEST_TICKET);

const ALL_STEPS = [
  'ticket', 'bootstrap', 'brief', 'spec', 'implement', 'quality',
  'commit', 'check', 'test_enhancement', 'pr', 'ready', 'follow_up',
  'ci', 'cleanup', 'reports', 'complete',
];

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

function clearEvidence() { try { fs.unlinkSync(path.join(TASKS_DIR, '.step-evidence.json')); } catch {} }
function readEvidence() { try { return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, '.step-evidence.json'), 'utf8')); } catch { return {}; } }

function runOrchestrator(args) {
  try {
    return JSON.parse(execSync(`node ${ORCHESTRATOR_PATH} ${args}`, { encoding: 'utf8', timeout: 10000 }));
  } catch (e) { try { return JSON.parse(e.stdout || '{}'); } catch { return { error: true }; } }
}

describe('Step 3 (brief) → Step 4 (spec) checklist', () => {

  beforeEach(() => {
    if (fs.existsSync(TASKS_DIR)) fs.rmSync(TASKS_DIR, { recursive: true, force: true });
    execSync(`node ${WORK_STATE_PATH} init ${TEST_TICKET} "test"`, { encoding: 'utf8' });
    setState('brief');
  });

  afterEach(() => {
    if (fs.existsSync(TASKS_DIR)) fs.rmSync(TASKS_DIR, { recursive: true, force: true });
  });

  // ═══ 1. Brief is NOT soft ═══

  describe('1. Brief requires evidence + output', () => {
    it('transition with nothing → blocked (no evidence)', async () => {
      clearEvidence();
      const { code, stderr } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} spec` } });
      assert.equal(code, 2);
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('transition with evidence only → blocked (no brief.md)', async () => {
      clearEvidence();
      await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'brief-writer', description: 'gen brief' } }, 'PostToolUse');
      const { code, stderr } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} spec` } });
      assert.equal(code, 2);
      assert.ok(stderr.includes('brief.md'), 'should mention missing file');
    });

    it('transition with brief.md only → blocked (no evidence)', async () => {
      clearEvidence();
      fs.writeFileSync(path.join(TASKS_DIR, 'brief.md'), '# Brief');
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} spec` } });
      assert.equal(code, 2);
    });

    it('transition with evidence + brief.md → allowed', async () => {
      clearEvidence();
      await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'brief-writer', description: 'gen brief' } }, 'PostToolUse');
      fs.writeFileSync(path.join(TASKS_DIR, 'brief.md'), '# Brief\n## Problem\nTest');
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} spec` } });
      assert.equal(code, 0);
    });
  });

  // ═══ 2. Output file protection ═══

  describe('2. Output file protection', () => {
    it('Write brief.md at brief step → allowed', async () => {
      const { code } = await runHook({ tool_name: 'Write', tool_input: { file_path: path.join(TASKS_DIR, 'brief.md'), content: '# Brief' } });
      assert.equal(code, 0);
    });

    it('Write brief.md at OTHER step → blocked', async () => {
      setState('implement');
      const { code, stderr } = await runHook({ tool_name: 'Write', tool_input: { file_path: path.join(TASKS_DIR, 'brief.md'), content: 'fake' } });
      assert.equal(code, 2);
      assert.ok(stderr.includes('brief'));
    });

    it('Edit brief.md at OTHER step → blocked', async () => {
      setState('spec');
      const { code } = await runHook({ tool_name: 'Edit', tool_input: { file_path: path.join(TASKS_DIR, 'brief.md'), old_string: 'a', new_string: 'b' } });
      assert.equal(code, 2);
    });

    it('Write spec.md at brief step → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Write', tool_input: { file_path: path.join(TASKS_DIR, 'spec.md'), content: 'x' } });
      assert.equal(code, 2);
    });

    it('Write unprotected file → allowed', async () => {
      const { code } = await runHook({ tool_name: 'Write', tool_input: { file_path: path.join(TASKS_DIR, 'notes.md'), content: 'x' } });
      assert.equal(code, 0);
    });
  });

  // ═══ 3. Rule 1: Step command matching ═══

  describe('3. Step command matching at brief', () => {
    it('Task(brief-writer) → allowed', async () => {
      const { code } = await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'brief-writer', description: 'gen brief' } });
      assert.equal(code, 0);
    });

    it('Agent(brief-writer) → allowed', async () => {
      const { code } = await runHook({ tool_name: 'Agent', tool_input: { subagent_type: 'brief-writer', description: 'gen brief' } });
      assert.equal(code, 0);
    });

    it('Task "brief generate" → allowed (description match)', async () => {
      const { code } = await runHook({ tool_name: 'Task', tool_input: { description: 'brief generate product brief', subagent_type: 'general-purpose' } });
      assert.equal(code, 0);
    });

    it('Task(spec-writer) → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'spec-writer' } });
      assert.equal(code, 2);
    });

    it('Skill(work-implement) → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Skill', tool_input: { skill: 'work-implement' } });
      assert.equal(code, 2);
    });

    it('Skill(bootstrap) → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Skill', tool_input: { skill: 'bootstrap' } });
      assert.equal(code, 2);
    });
  });

  // ═══ 4. Rule 4: CLI bypass ═══

  describe('4. CLI bypass blocked', () => {
    it('set-step → blocked', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} set-step ${TEST_TICKET} brief completed` } });
      assert.equal(code, 2);
    });
  });

  // ═══ 5. Evidence recording ═══

  describe('5. Evidence recording', () => {
    it('Task(brief-writer) records evidence', async () => {
      clearEvidence();
      await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'brief-writer', description: 'gen brief' } }, 'PostToolUse');
      const ev = readEvidence();
      assert.equal(ev.brief?.executed, true);
      assert.ok(ev.brief?.timestamp);
    });

    it('Task "brief" description also records evidence', async () => {
      clearEvidence();
      await runHook({ tool_name: 'Task', tool_input: { description: 'brief product brief', subagent_type: 'general-purpose' } }, 'PostToolUse');
      const ev = readEvidence();
      assert.equal(ev.brief?.executed, true);
    });
  });

  // ═══ 6. Transition targets ═══

  describe('6. Transition targets', () => {
    beforeEach(async () => {
      clearEvidence();
      await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'brief-writer' } }, 'PostToolUse');
      fs.writeFileSync(path.join(TASKS_DIR, 'brief.md'), '# Brief');
    });

    it('brief → spec allowed', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} spec` } });
      assert.equal(code, 0);
    });

    it('brief → implement allowed (skip spec)', async () => {
      const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} implement` } });
      assert.equal(code, 0);
    });

    it('orchestrator rejects brief → check', () => {
      const result = runOrchestrator(`transition ${TEST_TICKET} check`);
      assert.equal(result.error, true);
    });
  });

  // ═══ 7. Post-transition state ═══

  describe('7. Post-transition state', () => {
    it('after brief → spec: brief=completed, spec=in_progress', async () => {
      clearEvidence();
      await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'brief-writer' } }, 'PostToolUse');
      fs.writeFileSync(path.join(TASKS_DIR, 'brief.md'), '# Brief');
      runOrchestrator(`transition ${TEST_TICKET} spec`);
      const st = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, '.work-state.json'), 'utf8'));
      assert.equal(st.stepStatus.brief, 'completed');
      assert.equal(st.stepStatus.spec, 'in_progress');
    });
  });

  // ═══ 8. Error messages ═══

  describe('8. Error messages include unblock instructions', () => {
    it('missing evidence message shows expected commands', async () => {
      clearEvidence();
      const { stderr } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} spec` } });
      assert.ok(stderr.includes('brief-writer') || stderr.includes('brief'), 'should mention expected command/step');
    });

    it('missing output message lists files', async () => {
      clearEvidence();
      await runHook({ tool_name: 'Task', tool_input: { subagent_type: 'brief-writer' } }, 'PostToolUse');
      const { stderr } = await runHook({ tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} spec` } });
      assert.ok(stderr.includes('brief.md'), 'should list missing file');
    });

    it('output protection message shows owning step', async () => {
      setState('implement');
      const { stderr } = await runHook({ tool_name: 'Write', tool_input: { file_path: path.join(TASKS_DIR, 'brief.md'), content: 'x' } });
      assert.ok(stderr.includes("'brief'"), 'should name the owning step');
      assert.ok(stderr.includes('transition'), 'should suggest how to unblock');
    });
  });
});
