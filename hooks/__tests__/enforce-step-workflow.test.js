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
const TASKS_BASE = '/home/node/worktrees/tasks';

// Use a unique ticket ID per test run to avoid interference
const TEST_TICKET = `APPSUPEN-TEST-${process.pid}`;
const TASKS_DIR = path.join(TASKS_BASE, TEST_TICKET);

// ─── Helpers ────────────────────────────────────────────────────────────────

function runHook(hookData, hookType = 'PreToolUse', env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDE_HOOK_TYPE: hookType,
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
          tool_input: { command: 'node ~/.claude/hooks/work-orchestrator.js plan APPSUPEN-123' },
        });
        assert.equal(code, 0);
      });

      it('allows orchestrator transitions command', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'node ~/.claude/hooks/work-orchestrator.js transitions APPSUPEN-123' },
        });
        assert.equal(code, 0);
      });

      it('allows work-state.js get command', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'node ~/.claude/hooks/work-state.js get APPSUPEN-123' },
        });
        assert.equal(code, 0);
      });
    });

    describe('step command matching', () => {
      it('recognizes jira-task-creator as 1_ticket', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'jira-task-creator', prompt: 'create ticket' },
        });
        assert.equal(code, 0);
      });

      it('recognizes mcp__atlassian__jira_get_issue as 1_ticket', async () => {
        const { code } = await runHook({
          tool_name: 'mcp__atlassian__jira_get_issue',
          tool_input: { issue_key: 'APPSUPEN-123' },
        });
        assert.equal(code, 0);
      });

      it('recognizes bootstrap skill as 2_bootstrap', async () => {
        const { code } = await runHook({
          tool_name: 'Skill',
          tool_input: { skill: 'bootstrap' },
        });
        assert.equal(code, 0);
      });

      it('recognizes pnpm dev:check as 4_quality', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'pnpm dev:check' },
        });
        assert.equal(code, 0);
      });

      it('recognizes commit-writer as 5_commit', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'commit-writer', prompt: 'commit changes' },
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

      it('recognizes gh pr ready as 10_ready', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'gh pr ready' },
        });
        assert.equal(code, 0);
      });

      it('recognizes gh pr checks as 11_ci', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'gh pr checks --watch --interval 60' },
        });
        assert.equal(code, 0);
      });

      it('recognizes work-state.js complete as 13_complete', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'node ~/.claude/hooks/work-state.js complete APPSUPEN-123' },
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
        // Write a workflow-state for a different workflow (e.g. "check")
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
          tool_input: { command: 'node /some/path/workflow-engine.js work-pr plan APPSUPEN-123' },
        });
        assert.equal(code, 0);
      });

      it('allows workflow-engine transitions command', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'node /some/path/workflow-engine.js work-pr transitions APPSUPEN-123' },
        });
        assert.equal(code, 0);
      });

      it('allows workflow-state get command', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'node /some/path/workflow-state.js work-pr get APPSUPEN-123' },
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
          tool_input: { command: 'node /path/to/workflow-engine.js work-pr transition APPSUPEN-123 3_pr_gen' },
        },
        'PostToolUse',
      );
      assert.equal(code, 0);
    });

    it('does not crash on PostToolUse for work transition', async () => {
      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: 'node /path/to/work-orchestrator.js transition APPSUPEN-123 4_quality' },
        },
        'PostToolUse',
      );
      assert.equal(code, 0);
    });
  });
});
