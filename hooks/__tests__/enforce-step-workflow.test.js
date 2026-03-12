/**
 * Tests for enforce-step-workflow.js
 *
 * Uses node:test + node:assert/strict.
 * Run: node --test hooks/__tests__/enforce-step-workflow.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOOK_PATH = path.join(__dirname, '..', 'enforce-step-workflow.js');
let _config;
try { _config = require(path.join(__dirname, '..', '..', 'lib', 'config')); } catch { _config = null; }
const TASKS_BASE = _config?.TASKS_BASE || `${process.env.HOME}/worktrees/tasks`;

// Use a unique ticket ID per test run to avoid interference
const TEST_TICKET = `TEST-${process.pid}`;
const TASKS_DIR = path.join(TASKS_BASE, TEST_TICKET);

// ─── Helpers ────────────────────────────────────────────────────────────────

function runHook(hookData, hookType = 'PreToolUse', env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDE_HOOK_TYPE: hookType,
        ENFORCE_HOOK_TICKET_ID: TEST_TICKET,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    proc.on('error', reject);
    proc.stdin.write(JSON.stringify(hookData));
    proc.stdin.end();
  });
}

function writeWorkState(stepStatus, status = 'in_progress') {
  if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
  const state = {
    ticketId: TEST_TICKET,
    description: '',
    currentStep: 1,
    status,
    stepStatus,
    checkProgress: {},
    testEnhancement: { initialRating: 0, finalRating: 0, iterations: 0, skipped: false, skipReason: null },
    errors: [],
    startTime: new Date().toISOString(),
    lastUpdate: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(TASKS_DIR, '.work-state.json'), JSON.stringify(state, null, 2));
}

function writeWorkflowState(stepStatus, workflow = 'work-pr', status = 'in_progress') {
  if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
  const state = {
    workflow,
    instanceId: TEST_TICKET,
    status,
    currentStep: 1,
    stepStatus,
    errors: [],
    startTime: new Date().toISOString(),
    lastUpdate: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(TASKS_DIR, '.workflow-state.json'), JSON.stringify(state, null, 2));
}

function writeEvidence(evidence, evidenceFile = '.step-evidence.json') {
  if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.writeFileSync(path.join(TASKS_DIR, evidenceFile), JSON.stringify(evidence, null, 2));
}

function readEvidence(evidenceFile = '.step-evidence.json') {
  try {
    return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, evidenceFile), 'utf-8'));
  } catch {
    return {};
  }
}

function makeStepStatus(currentStep, allSteps) {
  const status = {};
  let found = false;
  for (const step of allSteps) {
    if (step === currentStep) {
      status[step] = 'in_progress';
      found = true;
    } else if (!found) {
      status[step] = 'completed';
    } else {
      status[step] = 'pending';
    }
  }
  return status;
}

const WORK_STEPS = [
  '1_ticket', '2_bootstrap', '3_implement', '4_quality',
  '5_commit', '6_check', '7_cleanup', '8_test_enhancement',
  '9_pr', '10_ready', '11_ci', '12_reports', '13_complete',
];

const WORK_PR_STEPS = [
  '1_preflight', '2_setup', '3_pr_gen',
  '4_screenshot_gate', '5_post_pr_gen', '6_summary',
];

// ─── Setup / Teardown ───────────────────────────────────────────────────────

describe('enforce-step-workflow', () => {

  beforeEach(() => {
    if (fs.existsSync(TASKS_DIR)) {
      fs.rmSync(TASKS_DIR, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(TASKS_DIR)) {
      fs.rmSync(TASKS_DIR, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /work workflow tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('/work workflow', () => {

    describe('when no .work-state.json exists', () => {
      it('allows all tool calls (PreToolUse)', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'pnpm dev:check' },
        });
        assert.equal(code, 0);
      });

      it('allows all tool calls (PostToolUse)', async () => {
        const { code } = await runHook(
          { tool_name: 'Bash', tool_input: { command: 'pnpm dev:check' } },
          'PostToolUse',
        );
        assert.equal(code, 0);
      });
    });

    describe('when no ticket found in branch', () => {
      it('allows step commands freely', async () => {
        const { code } = await runHook({
          tool_name: 'Skill',
          tool_input: { skill: 'work-implement' },
        });
        assert.equal(code, 0);
      });
    });

    describe('non-step commands', () => {
      it('allows commands that do not map to any step', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'echo hello' },
        });
        assert.equal(code, 0);
      });

      it('allows Read tool calls', async () => {
        const { code } = await runHook({
          tool_name: 'Read',
          tool_input: { file_path: '/some/file.js' },
        });
        assert.equal(code, 0);
      });
    });

    describe('exempt commands', () => {
      it('allows orchestrator plan commands', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'node ~/.claude/hooks/work-orchestrator.js plan PROJ-123' },
        });
        assert.equal(code, 0);
      });

      it('allows orchestrator transitions command', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'node ~/.claude/hooks/work-orchestrator.js transitions PROJ-123' },
        });
        assert.equal(code, 0);
      });

      it('allows work-state.js get command', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'node ~/.claude/hooks/work-state.js get PROJ-123' },
        });
        assert.equal(code, 0);
      });
    });

    describe('step command matching', () => {
      it('recognizes commit-writer as 5_commit', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'commit-writer', prompt: 'commit changes' },
        });
        assert.equal(code, 0);
      });

      it('recognizes work-implement skill as 3_implement', async () => {
        const { code } = await runHook({
          tool_name: 'Skill',
          tool_input: { skill: 'work-implement' },
        });
        assert.equal(code, 0);
      });

      it('recognizes check skill as 6_check', async () => {
        const { code } = await runHook({
          tool_name: 'Skill',
          tool_input: { skill: 'check' },
        });
        assert.equal(code, 0);
      });

      it('recognizes test-coordination skill as 8_test_enhancement', async () => {
        const { code } = await runHook({
          tool_name: 'Skill',
          tool_input: { skill: 'test-coordination' },
        });
        assert.equal(code, 0);
      });

      it('recognizes work-pr skill as 9_pr', async () => {
        const { code } = await runHook({
          tool_name: 'Skill',
          tool_input: { skill: 'work-pr' },
        });
        assert.equal(code, 0);
      });
    });

    describe('Task-based delegation patterns', () => {
      it('recognizes Task with description "1_ticket" as 1_ticket', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'general-purpose', description: '1_ticket fetch ticket details', prompt: 'fetch ticket' },
        });
        assert.equal(code, 0);
      });

      it('recognizes Task(quality-checker) via subagent_type as 4_quality', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'quality-checker', description: '4_quality run checks', prompt: 'run checks' },
        });
        assert.equal(code, 0);
      });

      it('recognizes Task with description "4_quality" as 4_quality', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'Bash', description: '4_quality run dev:check', prompt: 'run checks' },
        });
        assert.equal(code, 0);
      });

      it('recognizes Task with description "7_cleanup" as 7_cleanup', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'Bash', description: '7_cleanup kill dev session', prompt: 'kill session' },
        });
        assert.equal(code, 0);
      });

      it('recognizes Task with description "10_ready" as 10_ready', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'Bash', description: '10_ready mark PR ready', prompt: 'gh pr ready' },
        });
        assert.equal(code, 0);
      });

      it('recognizes Task with description "11_ci" as 11_ci', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'Bash', description: '11_ci watch CI', prompt: 'gh pr checks' },
        });
        assert.equal(code, 0);
      });

      it('recognizes Task with description "12_reports" as 12_reports', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'Bash', description: '12_reports consolidate', prompt: 'consolidate reports' },
        });
        assert.equal(code, 0);
      });

      it('recognizes Task with description "13_complete" as 13_complete', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'Bash', description: '13_complete finish', prompt: 'mark complete' },
        });
        assert.equal(code, 0);
      });

      it('description matching is case-insensitive', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'Bash', description: '7_CLEANUP kill dev session', prompt: 'kill session' },
        });
        assert.equal(code, 0);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /work-pr workflow tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('/work-pr workflow', () => {

    describe('when no .workflow-state.json exists', () => {
      it('allows pr-generator freely', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'pr-generator', prompt: 'update PR' },
        });
        assert.equal(code, 0);
      });

      it('allows pr-post-generator freely', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'pr-post-generator', prompt: 'add screenshots' },
        });
        assert.equal(code, 0);
      });
    });

    describe('when workflow-state exists but is not work-pr', () => {
      it('allows pr-generator (different workflow active)', async () => {
        writeWorkflowState(
          makeStepStatus('1_setup', ['1_setup', '2_start_env', '3_verify']),
          'check',
        );
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'pr-generator', prompt: 'update PR' },
        });
        assert.equal(code, 0);
      });
    });

    describe('step command matching for work-pr', () => {
      it('recognizes pr-generator as 3_pr_gen', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'pr-generator', prompt: 'update PR' },
        });
        assert.equal(code, 0);
      });

      it('recognizes gh pr create as 3_pr_gen', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'gh pr create --title "test" --body "body"' },
        });
        assert.equal(code, 0);
      });

      it('recognizes gh pr edit as 3_pr_gen', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'gh pr edit 123 --body "updated"' },
        });
        assert.equal(code, 0);
      });

      it('recognizes pr-post-generator as 5_post_pr_gen', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'pr-post-generator', prompt: 'add screenshots' },
        });
        assert.equal(code, 0);
      });
    });

    describe('exempt commands for work-pr', () => {
      it('allows workflow-engine plan commands', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'node /some/path/workflow-engine.js work-pr plan PROJ-123' },
        });
        assert.equal(code, 0);
      });

      it('allows workflow-engine transitions command', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'node /some/path/workflow-engine.js work-pr transitions PROJ-123' },
        });
        assert.equal(code, 0);
      });

      it('allows workflow-state get command', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'node /some/path/workflow-state.js work-pr get PROJ-123' },
        });
        assert.equal(code, 0);
      });
    });

    describe('soft steps for work-pr', () => {
      it('1_preflight, 2_setup, 6_summary are defined as soft', () => {
        const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
        assert.ok(hookSource.includes("'1_preflight'"));
        assert.ok(hookSource.includes("'2_setup'"));
        assert.ok(hookSource.includes("'6_summary'"));
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Multi-workflow coexistence tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('multi-workflow coexistence', () => {
    it('both workflows can have state files simultaneously', () => {
      writeWorkState(makeStepStatus('9_pr', WORK_STEPS));
      writeWorkflowState(makeStepStatus('3_pr_gen', WORK_PR_STEPS));

      const workState = JSON.parse(
        fs.readFileSync(path.join(TASKS_DIR, '.work-state.json'), 'utf-8'),
      );
      const workPrState = JSON.parse(
        fs.readFileSync(path.join(TASKS_DIR, '.workflow-state.json'), 'utf-8'),
      );

      assert.equal(workState.stepStatus['9_pr'], 'in_progress');
      assert.equal(workPrState.stepStatus['3_pr_gen'], 'in_progress');
      assert.equal(workPrState.workflow, 'work-pr');
    });

    it('evidence files are separate per workflow', () => {
      writeEvidence(
        { '9_pr': { executed: true, tool: 'Skill', timestamp: new Date().toISOString() } },
        '.step-evidence.json',
      );
      writeEvidence(
        { '3_pr_gen': { executed: true, tool: 'Task', timestamp: new Date().toISOString() } },
        '.step-evidence-work-pr.json',
      );

      const workEvidence = readEvidence('.step-evidence.json');
      const workPrEvidence = readEvidence('.step-evidence-work-pr.json');

      assert.ok(workEvidence['9_pr']?.executed);
      assert.ok(!workEvidence['3_pr_gen']);
      assert.ok(workPrEvidence['3_pr_gen']?.executed);
      assert.ok(!workPrEvidence['9_pr']);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Edge cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('edge cases', () => {
    it('handles invalid JSON on stdin (fail-open)', async () => {
      const proc = spawn('node', [HOOK_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_HOOK_TYPE: 'PreToolUse' },
      });
      const exitCode = await new Promise((resolve) => {
        proc.on('close', resolve);
        proc.stdin.write('not valid json {{{{');
        proc.stdin.end();
      });
      assert.equal(exitCode, 0);
    });

    it('handles empty stdin (fail-open)', async () => {
      const proc = spawn('node', [HOOK_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_HOOK_TYPE: 'PreToolUse' },
      });
      const exitCode = await new Promise((resolve) => {
        proc.on('close', resolve);
        proc.stdin.end();
      });
      assert.equal(exitCode, 0);
    });

    it('handles missing tool_input (fail-open)', async () => {
      const { code } = await runHook({ tool_name: 'Bash' });
      assert.equal(code, 0);
    });

    it('handles corrupt evidence file gracefully', () => {
      if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
      fs.writeFileSync(path.join(TASKS_DIR, '.step-evidence.json'), 'not json {{{');
      const evidence = readEvidence('.step-evidence.json');
      assert.deepEqual(evidence, {});
    });

    it('handles corrupt workflow-state file gracefully', () => {
      if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
      fs.writeFileSync(path.join(TASKS_DIR, '.workflow-state.json'), 'corrupted');
      // Should not crash — fail-open
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Helper tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('makeStepStatus helper', () => {
    it('correctly marks /work steps', () => {
      const status = makeStepStatus('4_quality', WORK_STEPS);
      assert.equal(status['1_ticket'], 'completed');
      assert.equal(status['3_implement'], 'completed');
      assert.equal(status['4_quality'], 'in_progress');
      assert.equal(status['5_commit'], 'pending');
      assert.equal(status['13_complete'], 'pending');
    });

    it('correctly marks /work-pr steps', () => {
      const status = makeStepStatus('3_pr_gen', WORK_PR_STEPS);
      assert.equal(status['1_preflight'], 'completed');
      assert.equal(status['2_setup'], 'completed');
      assert.equal(status['3_pr_gen'], 'in_progress');
      assert.equal(status['4_screenshot_gate'], 'pending');
      assert.equal(status['5_post_pr_gen'], 'pending');
      assert.equal(status['6_summary'], 'pending');
    });
  });

  describe('PostToolUse evidence recording', () => {
    it('does not crash on PostToolUse with valid data', async () => {
      const { code } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'pnpm dev:check' } },
        'PostToolUse',
      );
      assert.equal(code, 0);
    });

    it('does not crash on PostToolUse for work-pr transition', async () => {
      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: 'node /path/to/workflow-engine.js work-pr transition PROJ-123 3_pr_gen' },
        },
        'PostToolUse',
      );
      assert.equal(code, 0);
    });

    it('does not crash on PostToolUse for work transition', async () => {
      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: 'node /path/to/work-orchestrator.js transition PROJ-123 4_quality' },
        },
        'PostToolUse',
      );
      assert.equal(code, 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Hardening tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ticket-aware transition enforcement', () => {
    it('allows transition command targeting a different ticket (PreToolUse)', async () => {
      writeWorkState(makeStepStatus('3_implement', WORK_STEPS));

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'node /path/to/work-orchestrator.js transition OTHER-999 4_quality' },
      });
      assert.equal(code, 0);
    });

    it('blocks transition command targeting the SAME ticket without evidence', async () => {
      writeWorkState(makeStepStatus('3_implement', WORK_STEPS));

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} 4_quality` },
      });
      assert.equal(code, 2);
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('PostToolUse skips evidence clearing for different ticket transition (Patch 3)', async () => {
      writeWorkState(makeStepStatus('7_cleanup', WORK_STEPS));
      writeEvidence({
        '4_quality': { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
        '5_commit': { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
        '6_check': { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        '7_cleanup': { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
      });

      // Transition for a DIFFERENT ticket — should NOT touch our evidence
      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: 'node /path/to/work-orchestrator.js transition OTHER-999 4_quality' },
        },
        'PostToolUse',
      );
      assert.equal(code, 0);

      // All evidence should remain untouched
      const evidence = readEvidence();
      assert.ok(evidence['4_quality']?.executed, 'Evidence should be untouched');
      assert.ok(evidence['5_commit']?.executed, 'Evidence should be untouched');
      assert.ok(evidence['6_check']?.executed, 'Evidence should be untouched');
      assert.ok(evidence['7_cleanup']?.executed, 'Evidence should be untouched');
    });
  });

  describe('backward transition range fix', () => {
    it('preserves target step evidence on backward transition', async () => {
      writeWorkState(makeStepStatus('7_cleanup', WORK_STEPS));
      writeEvidence({
        '3_implement': { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        '4_quality': { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
        '5_commit': { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
        '6_check': { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        '7_cleanup': { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
      });

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} 4_quality` },
        },
        'PostToolUse',
      );
      assert.equal(code, 0);

      const evidence = readEvidence();
      assert.ok(evidence['4_quality']?.executed, 'Target step evidence should be preserved');
      assert.equal(evidence['5_commit'], undefined, 'Step after target should be cleared');
      assert.equal(evidence['6_check'], undefined, 'Step after target should be cleared');
      assert.equal(evidence['7_cleanup'], undefined, 'Current step should be cleared');
      assert.ok(evidence['3_implement']?.executed, 'Step before target should be preserved');
    });
  });

  describe('multi-command expected hint (Patch 5)', () => {
    it('shows all valid commands with field names for 4_quality', async () => {
      writeWorkState(makeStepStatus('4_quality', WORK_STEPS));

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} 5_commit` },
      });
      assert.equal(code, 2);

      // Patch 5: new format includes field names and "Expected one of:"
      assert.ok(stderr.includes('Expected one of:'), 'Should use "Expected one of:" header');
      assert.ok(stderr.includes('Task.subagent_type matches'), 'Should include field name subagent_type');
      assert.ok(stderr.includes('quality-checker'), 'Should mention quality-checker pattern');
      assert.ok(stderr.includes('Task.description matches'), 'Should include field name description');
      assert.ok(stderr.includes('4_quality'), 'Should mention 4_quality pattern');
    });

    it('shows all valid commands for 3_pr_gen in work-pr', async () => {
      writeWorkflowState(makeStepStatus('3_pr_gen', WORK_PR_STEPS));

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node /path/to/workflow-engine.js work-pr transition ${TEST_TICKET} 4_screenshot_gate` },
      });
      assert.equal(code, 2);

      assert.ok(stderr.includes('Expected one of:'), 'Should use new format');
      assert.ok(stderr.includes('pr-generator'), 'Should mention pr-generator');
      assert.ok(stderr.includes('Bash.command matches'), 'Should include Bash.command field');
    });
  });

  describe('attempted command in block message', () => {
    it('includes the attempted transition command via transition.raw (Patch 4)', async () => {
      writeWorkState(makeStepStatus('3_implement', WORK_STEPS));

      const transitionCmd = `node /path/to/work-orchestrator.js transition ${TEST_TICKET} 4_quality`;
      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: transitionCmd },
      });
      assert.equal(code, 2);
      assert.ok(stderr.includes('Attempted:'), 'Should include Attempted: label');
      assert.ok(stderr.includes(transitionCmd), 'Should include the actual command');
    });
  });

  describe('dual in_progress detection', () => {
    it('warns on stderr when multiple steps are in_progress', async () => {
      const stepStatus = makeStepStatus('4_quality', WORK_STEPS);
      stepStatus['6_check'] = 'in_progress';
      writeWorkState(stepStatus);

      const { code, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'echo hello' } },
        'PreToolUse',
      );
      assert.equal(code, 0);
      assert.ok(stderr.includes('WARNING: Multiple steps in_progress'), 'Should warn about multiple in_progress');
      assert.ok(stderr.includes('4_quality'), 'Should mention first in_progress step');
      assert.ok(stderr.includes('6_check'), 'Should mention second in_progress step');
    });

    it('still functions correctly — picks the first in_progress step', async () => {
      const stepStatus = makeStepStatus('4_quality', WORK_STEPS);
      stepStatus['6_check'] = 'in_progress';
      writeWorkState(stepStatus);

      const { code } = await runHook({
        tool_name: 'Task',
        tool_input: { subagent_type: 'quality-checker', description: '4_quality run checks', prompt: 'run checks' },
      });
      assert.equal(code, 0);
    });
  });

  describe('field coercion safety', () => {
    it('handles non-string field values gracefully (object)', async () => {
      const { code } = await runHook({
        tool_name: 'Task',
        tool_input: { subagent_type: { nested: 'object' }, description: 'some task', prompt: 'test' },
      });
      assert.equal(code, 0);
    });

    it('handles non-string field values gracefully (array)', async () => {
      const { code } = await runHook({
        tool_name: 'Task',
        tool_input: { subagent_type: ['an', 'array'], description: 'some task', prompt: 'test' },
      });
      assert.equal(code, 0);
    });

    it('handles null field values gracefully', async () => {
      const { code } = await runHook({
        tool_name: 'Task',
        tool_input: { subagent_type: null, description: null, prompt: 'test' },
      });
      assert.equal(code, 0);
    });
  });

  describe('atomic evidence writes', () => {
    it('evidence file is written correctly after PostToolUse', async () => {
      writeWorkState(makeStepStatus('3_implement', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Skill',
          tool_input: { skill: 'work-implement' },
        },
        'PostToolUse',
      );
      assert.equal(code, 0);

      const evidence = readEvidence();
      assert.ok(evidence['3_implement']?.executed, 'Evidence should be recorded');
      assert.equal(evidence['3_implement']?.tool, 'Skill');

      const files = fs.readdirSync(TASKS_DIR);
      const tmpFiles = files.filter(f => f.includes('.tmp.'));
      assert.equal(tmpFiles.length, 0, 'No temp files should remain');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Source inspection tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('source structure', () => {
    it('transitionHint uses __dirname not hardcoded cache paths', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(!hookSource.includes('plugins/cache/work-workflow'), 'Should not contain hardcoded cache path');
      assert.ok(hookSource.includes('__dirname'), 'Should use __dirname for path computation');
    });

    it('ticket pattern uses broad [A-Z]+-\\d+ not project-specific prefix', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes('[A-Z]+-\\d+'), 'Should use broader ticket pattern');
      // The hook uses match(/[A-Z]+-\d+/) which IS the broad pattern (not project-specific)
      assert.ok(!hookSource.includes('APPSUPEN-'), 'Should not have hardcoded project prefix');
    });

    it('caches ticket ID per invocation', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes('_cachedTicketId'), 'Should have cached ticket ID variable');
      assert.ok(hookSource.includes('_ticketIdResolved'), 'Should have resolved flag');
    });

    it('pre-indexes commandMap by tool name', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes('buildCommandIndex'), 'Should have buildCommandIndex function');
      assert.ok(hookSource.includes('commandIndex'), 'Should use commandIndex');
    });

    it('(Patch 1) lazy-loads appendAction with try/catch fallback', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes('let appendAction'), 'Should use let for appendAction');
      assert.ok(hookSource.includes("appendAction = () => {}"), 'Should have no-op fallback');
    });

    it('(Patch 2) uses didBlock flag in error handlers', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes('let didBlock = false'), 'Should declare didBlock flag');
      assert.ok(hookSource.includes('didBlock ? 2 : 0'), 'Error handlers should check didBlock');
      // Verify didBlock is set before each process.exit(2)
      const exitLines = hookSource.split('\n').filter(l => l.trim().startsWith('process.exit(2)'));
      assert.ok(exitLines.length >= 2, 'Should have at least 2 process.exit(2) calls');
    });

    it('(Patch 6) reads .git/HEAD directly instead of execSync', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes(".git/HEAD"), 'Should read .git/HEAD');
      assert.ok(!hookSource.includes('execSync'), 'Should not use execSync');
      assert.ok(!hookSource.includes("require('child_process')"), 'Should not require child_process');
    });

    it('(Patch 7) validates workflow config at startup', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes('validateWorkflow'), 'Should have validateWorkflow function');
      assert.ok(hookSource.includes('softSteps references unknown step'), 'Should validate softSteps');
      assert.ok(hookSource.includes('commandMap references unknown step'), 'Should validate commandMap steps');
      assert.ok(hookSource.includes('commandMap missing field'), 'Should validate commandMap fields');
    });

    it('(Patch 8) catch blocks log errors to stderr', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes('[enforce-step-workflow] fail-open:'), 'main catch should log');
      assert.ok(hookSource.includes('[enforce-step-workflow] fatal:'), 'outer catch should log');
      assert.ok(hookSource.includes('[enforce-step-workflow] uncaught:'), 'uncaughtException should log');
    });

    it('(Patch 4) parseTransition uses String() coercion and returns raw', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      // Check that parseTransition uses String() coercion
      assert.ok(hookSource.includes("String(toolInput?.command || '')"), 'Should use String() coercion');
      // Check that it returns raw in the result
      assert.ok(hookSource.includes('raw: cmd'), 'Should return raw command in result');
    });

    it('(Patch 9) has resolveGitHead for worktree support', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes('function resolveGitHead()'), 'Should have resolveGitHead function');
      assert.ok(hookSource.includes("gitdir: "), 'Should check for gitdir pointer');
      assert.ok(hookSource.includes("path.join(gitdir, 'HEAD')"), 'Should resolve worktree HEAD path');
      // Fallback path still reads .git/HEAD as path.join
      assert.ok(hookSource.includes("path.join('.git', 'HEAD')"), 'Should have normal repo fallback');
    });

    it('(Patch 10) validates transition targets against known steps', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      // Both PreToolUse and PostToolUse should check steps.includes
      const matches = hookSource.match(/wf\.steps\.includes\(transition\.targetStep\)/g);
      assert.ok(matches && matches.length >= 2, 'Should validate targetStep in both handlers');
    });

    it('(Patch 12) resolves relative gitdir paths with path.resolve', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes('path.resolve(path.dirname(dotgitPath), rawGitdir)'), 'Should resolve relative gitdir');
      assert.ok(hookSource.includes("const dotgitPath = '.git'"), 'Should store dotgitPath for dirname');
    });

    it('(Patch 13) isExempt uses String() coercion', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      // Find the isExempt function body
      const exemptMatch = hookSource.match(/function isExempt[\s\S]*?return exemptPatterns/);
      assert.ok(exemptMatch, 'Should have isExempt function');
      assert.ok(exemptMatch[0].includes("String(toolInput?.command || '')"), 'isExempt should use String() coercion');
    });

    it('(Patch 11) gates transient stderr behind DEBUG env var', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes('const DEBUG = !!process.env.ENFORCE_HOOK_DEBUG'), 'Should declare DEBUG constant');
      // DEBUG must be declared before the error handlers (before uncaughtException)
      const debugIdx = hookSource.indexOf('const DEBUG');
      const uncaughtIdx = hookSource.indexOf("process.on('uncaughtException'");
      assert.ok(debugIdx < uncaughtIdx, 'DEBUG must be declared before uncaughtException handler');
      // Error handlers should be gated
      assert.ok(hookSource.includes('if (DEBUG) process.stderr.write(`[enforce-step-workflow] uncaught:'), 'uncaught handler gated');
      assert.ok(hookSource.includes('if (DEBUG) process.stderr.write(`[enforce-step-workflow] fail-open:'), 'fail-open gated');
      assert.ok(hookSource.includes('if (DEBUG) process.stderr.write(`[enforce-step-workflow] fatal:'), 'fatal gated');
      // BLOCKED and WARNING messages should NOT be gated
      assert.ok(!hookSource.includes('if (DEBUG) process.stderr.write(`BLOCKED'), 'BLOCKED messages must not be gated');
      assert.ok(!hookSource.includes('if (DEBUG) process.stderr.write(`WARNING'), 'WARNING messages must not be gated');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Patch 10: transition target validation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('transition target validation (Patch 10)', () => {
    it('allows transition with unknown target step (PreToolUse — not a real transition)', async () => {
      writeWorkState(makeStepStatus('3_implement', WORK_STEPS));
      writeEvidence({});

      // Transition to a step that doesn't exist in the workflow — should be ignored
      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} nonexistent_step` },
      });
      // Should NOT block — the command doesn't target a known step, so it's not a real transition
      assert.equal(code, 0);
    });

    it('blocks transition with valid target step (PreToolUse — real transition without evidence)', async () => {
      writeWorkState(makeStepStatus('3_implement', WORK_STEPS));
      writeEvidence({});

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} 4_quality` },
      });
      assert.equal(code, 2);
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('PostToolUse ignores transition with unknown target step', async () => {
      writeWorkState(makeStepStatus('5_commit', WORK_STEPS));
      writeEvidence({
        '3_implement': { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        '4_quality': { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
        '5_commit': { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
      });

      // Backward transition to unknown step — should be ignored, evidence untouched
      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} fake_step` },
        },
        'PostToolUse',
      );
      assert.equal(code, 0);

      const evidence = readEvidence();
      assert.ok(evidence['3_implement']?.executed, 'Evidence should be untouched');
      assert.ok(evidence['4_quality']?.executed, 'Evidence should be untouched');
      assert.ok(evidence['5_commit']?.executed, 'Evidence should be untouched');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Patch 11: debug stderr gating
  // ═══════════════════════════════════════════════════════════════════════════

  describe('debug stderr gating (Patch 11)', () => {
    it('suppresses transient error messages without ENFORCE_HOOK_DEBUG', async () => {
      const proc = spawn('node', [HOOK_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_HOOK_TYPE: 'PreToolUse' },
      });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      const exitCode = await new Promise((resolve) => {
        proc.on('close', resolve);
        proc.stdin.write('not valid json {{{{');
        proc.stdin.end();
      });
      assert.equal(exitCode, 0);
      // Without DEBUG, transient errors should NOT appear on stderr
      assert.ok(!stderr.includes('[enforce-step-workflow] fail-open:'), 'Should suppress fail-open message');
    });

    it('shows transient error messages with ENFORCE_HOOK_DEBUG=1', async () => {
      const proc = spawn('node', [HOOK_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_HOOK_TYPE: 'PreToolUse', ENFORCE_HOOK_DEBUG: '1' },
      });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      const exitCode = await new Promise((resolve) => {
        proc.on('close', resolve);
        proc.stdin.write('not valid json {{{{');
        proc.stdin.end();
      });
      assert.equal(exitCode, 0);
      // With DEBUG, transient errors SHOULD appear on stderr
      assert.ok(stderr.includes('[enforce-step-workflow] fail-open:'), 'Should show fail-open message with DEBUG');
    });

    it('always shows BLOCKED messages regardless of DEBUG', async () => {
      writeWorkState(makeStepStatus('3_implement', WORK_STEPS));

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} 4_quality` },
      });
      assert.equal(code, 2);
      assert.ok(stderr.includes('BLOCKED'), 'BLOCKED messages always visible');
    });

    it('always shows WARNING messages regardless of DEBUG', async () => {
      const stepStatus = makeStepStatus('4_quality', WORK_STEPS);
      stepStatus['6_check'] = 'in_progress';
      writeWorkState(stepStatus);

      const { code, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'echo hello' } },
        'PreToolUse',
      );
      assert.equal(code, 0);
      assert.ok(stderr.includes('WARNING: Multiple steps in_progress'), 'WARNING always visible');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Patch 14: Bash dev:check command matching for 4_quality
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Bash dev:check → 4_quality command matching (Patch 14)', () => {
    it('blocks pnpm dev:check when step is NOT 4_quality', async () => {
      writeWorkState(makeStepStatus('3_implement', WORK_STEPS));

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'pnpm dev:check' },
      });
      assert.equal(code, 2);
      assert.ok(stderr.includes('BLOCKED'), 'Should block dev:check outside 4_quality');
      assert.ok(stderr.includes('4_quality'), 'Should mention 4_quality');
    });

    it('allows pnpm dev:check when step IS 4_quality', async () => {
      writeWorkState(makeStepStatus('4_quality', WORK_STEPS));

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'pnpm dev:check' },
      });
      assert.equal(code, 0);
    });

    it('blocks LOW_CONCURRENCY=1 pnpm dev:check outside 4_quality', async () => {
      writeWorkState(makeStepStatus('6_check', WORK_STEPS));

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'LOW_CONCURRENCY=1 pnpm dev:check' },
      });
      assert.equal(code, 2);
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('allows LOW_CONCURRENCY=1 pnpm dev:check during 4_quality', async () => {
      writeWorkState(makeStepStatus('4_quality', WORK_STEPS));

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'LOW_CONCURRENCY=1 pnpm dev:check' },
      });
      assert.equal(code, 0);
    });

    it('blocks npm run dev:check outside 4_quality', async () => {
      writeWorkState(makeStepStatus('5_commit', WORK_STEPS));

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'npm run dev:check' },
      });
      assert.equal(code, 2);
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('records evidence for pnpm dev:check via PostToolUse during 4_quality', async () => {
      writeWorkState(makeStepStatus('4_quality', WORK_STEPS));

      const { code } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'pnpm dev:check' } },
        'PostToolUse',
      );
      assert.equal(code, 0);

      const evidence = readEvidence();
      assert.ok(evidence['4_quality']?.executed, 'Should record evidence for 4_quality');
      assert.equal(evidence['4_quality']?.tool, 'Bash');
    });

    it('matches pnpm dev:check-types as 4_quality (\\b matches at hyphen)', async () => {
      writeWorkState(makeStepStatus('3_implement', WORK_STEPS));

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'pnpm dev:check-types' },
      });
      // \b matches at word boundary before hyphen — this IS caught as 4_quality
      assert.equal(code, 2);
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks bundled dev-check.sh outside 4_quality', async () => {
      writeWorkState(makeStepStatus('3_implement', WORK_STEPS));

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: '/home/node/claude-plugin-work/scripts/dev-check/dev-check.sh' },
      });
      assert.equal(code, 2);
      assert.ok(stderr.includes('BLOCKED'), 'Should block bundled dev-check.sh outside 4_quality');
    });

    it('allows bundled dev-check.sh during 4_quality', async () => {
      writeWorkState(makeStepStatus('4_quality', WORK_STEPS));

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: '/home/node/claude-plugin-work/scripts/dev-check/dev-check.sh' },
      });
      assert.equal(code, 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Patch 14: 10_ready as soft step
  // ═══════════════════════════════════════════════════════════════════════════

  describe('10_ready soft step (Patch 14)', () => {
    it('allows transition from 10_ready without evidence', async () => {
      writeWorkState(makeStepStatus('10_ready', WORK_STEPS));
      // No evidence written for 10_ready

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} 11_ci` },
      });
      // Soft step → should allow transition without evidence
      assert.equal(code, 0);
    });

    it('source confirms 10_ready is in softSteps set', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      // Check that softSteps contains 10_ready
      const softStepsMatch = hookSource.match(/softSteps:\s*new Set\(\[([^\]]+)\]\)/);
      assert.ok(softStepsMatch, 'Should have softSteps declaration');
      assert.ok(softStepsMatch[1].includes("'10_ready'"), 'softSteps should include 10_ready');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Patch 14: 9_pr evidence validation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('9_pr evidence validation (Patch 14)', () => {
    it('does NOT record evidence for 9_pr when .pr-update-sha is missing', async () => {
      writeWorkState(makeStepStatus('9_pr', WORK_STEPS));
      // Do NOT create .pr-update-sha file

      const { code } = await runHook(
        { tool_name: 'Skill', tool_input: { skill: 'work-pr' } },
        'PostToolUse',
      );
      assert.equal(code, 0);

      const evidence = readEvidence();
      assert.equal(evidence['9_pr'], undefined, 'Should NOT record evidence without .pr-update-sha');
    });

    it('source has Patch 14 evidence validation block', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes("(Patch 14) Strengthen 9_pr evidence"), 'Should have Patch 14 comment');
      assert.ok(hookSource.includes('.pr-update-sha'), 'Should reference .pr-update-sha file');
    });
  });
});
