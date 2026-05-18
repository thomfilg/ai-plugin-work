/**
 * Tests for enforce-step-workflow.js
 *
 * Uses node:test + node:assert/strict.
 * Run: node --test hooks/__tests__/enforce-step-workflow.test.js
 */

const { describe, it, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'enforce-step-workflow.js');
const getConfig = require(path.join(__dirname, '..', 'get-config'));
const TASKS_BASE = getConfig.require('TASKS_BASE');
// TEST-* dirs are cleaned globally by scripts/run-tests.sh via test-cleanup.js

// Use a unique ticket ID per test run to avoid interference
// Convention: all test tickets MUST start with TEST- for cleanup (see test-cleanup.js)
const TEST_TICKET = `TEST-ESW-${process.pid}`;
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
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
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
  const stateFile = `.${workflow}.workflow-state.json`;
  fs.writeFileSync(path.join(TASKS_DIR, stateFile), JSON.stringify(state, null, 2));
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
  'ticket',
  'bootstrap',
  'brief',
  // GH-215: brief_gate sits between `brief` and `spec` so the hook can block
  // the transition into `spec` until every cross-ticket/architectural open
  // question in brief.md has been resolved. The ordering here must mirror
  // workflows/work/step-registry.js:ALL_STEPS so tests that rely on
  // makeStepStatus() see an authentic in-progress/pending split.
  'brief_gate',
  'spec',
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

const WORK_PR_STEPS = [
  '1_preflight',
  '2_setup',
  '3_pr_gen',
  '4_screenshot_gate',
  '5_post_pr_gen',
  '6_summary',
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
          'PostToolUse'
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
          tool_input: {
            command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/work-orchestrator.js plan PROJ-123',
          },
        });
        assert.equal(code, 0);
      });

      it('allows orchestrator transitions command', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: {
            command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/work-orchestrator.js transitions PROJ-123',
          },
        });
        assert.equal(code, 0);
      });

      it('allows work-state.js get command', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/work-state.js get PROJ-123' },
        });
        assert.equal(code, 0);
      });
    });

    describe('step command matching', () => {
      it('recognizes commit-writer as commit', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'commit-writer', prompt: 'commit changes' },
        });
        assert.equal(code, 0);
      });

      it('recognizes work-implement skill as implement', async () => {
        const { code } = await runHook({
          tool_name: 'Skill',
          tool_input: { skill: 'work-implement' },
        });
        assert.equal(code, 0);
      });

      it('recognizes check skill as check', async () => {
        const { code } = await runHook({
          tool_name: 'Skill',
          tool_input: { skill: 'check' },
        });
        assert.equal(code, 0);
      });

      it('recognizes work-pr skill as pr', async () => {
        const { code } = await runHook({
          tool_name: 'Skill',
          tool_input: { skill: 'work-pr' },
        });
        assert.equal(code, 0);
      });
    });

    describe('Task-based delegation patterns', () => {
      it('recognizes Task with description "ticket" as ticket', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: {
            subagent_type: 'general-purpose',
            description: 'ticket fetch ticket details',
            prompt: 'fetch ticket',
          },
        });
        assert.equal(code, 0);
      });

      it('recognizes Task with description "cleanup" as cleanup', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: {
            subagent_type: 'Bash',
            description: 'cleanup kill dev session',
            prompt: 'kill session',
          },
        });
        assert.equal(code, 0);
      });

      it('recognizes Task with description "ready" as ready', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: {
            subagent_type: 'Bash',
            description: 'ready mark PR ready',
            prompt: 'gh pr ready',
          },
        });
        assert.equal(code, 0);
      });

      it('recognizes Task with description "ci" as ci', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'Bash', description: 'ci watch CI', prompt: 'gh pr checks' },
        });
        assert.equal(code, 0);
      });

      it('recognizes Task with description "reports" as reports', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: {
            subagent_type: 'Bash',
            description: 'reports consolidate',
            prompt: 'consolidate reports',
          },
        });
        assert.equal(code, 0);
      });

      it('recognizes Task with description "complete" as complete', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: {
            subagent_type: 'Bash',
            description: 'complete finish',
            prompt: 'mark complete',
          },
        });
        assert.equal(code, 0);
      });

      it('description matching is case-insensitive', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: {
            subagent_type: 'Bash',
            description: 'CLEANUP kill dev session',
            prompt: 'kill session',
          },
        });
        assert.equal(code, 0);
      });
    });

    describe('Agent tool recognition and evidence recording', () => {
      it('Agent with description "cleanup" is recognized and records evidence', async () => {
        writeWorkState(makeStepStatus('cleanup', WORK_STEPS));
        const input = {
          tool_name: 'Agent',
          tool_input: {
            subagent_type: 'general-purpose',
            description: 'cleanup kill dev session',
            prompt: 'kill session',
          },
        };

        const pre = await runHook(input);
        assert.equal(pre.code, 0, 'PreToolUse should allow Agent');

        const post = await runHook(input, 'PostToolUse');
        assert.equal(post.code, 0);
        const evidence = readEvidence();
        assert.ok(evidence['cleanup']?.executed, 'Should record evidence for cleanup');
        assert.equal(evidence['cleanup']?.tool, 'Agent');
      });

      it('Agent with description "ready" is recognized and records evidence', async () => {
        writeWorkState(makeStepStatus('ready', WORK_STEPS));
        const input = {
          tool_name: 'Agent',
          tool_input: {
            subagent_type: 'general-purpose',
            description: 'ready mark PR ready',
            prompt: 'gh pr ready',
          },
        };
        const pre = await runHook(input);
        assert.equal(pre.code, 0);
        const post = await runHook(input, 'PostToolUse');
        assert.equal(post.code, 0);
        const evidence = readEvidence();
        assert.ok(evidence['ready']?.executed, 'Should record evidence for ready');
      });

      it('Agent with description "ci" is recognized and records evidence', async () => {
        writeWorkState(makeStepStatus('ci', WORK_STEPS));
        const input = {
          tool_name: 'Agent',
          tool_input: {
            subagent_type: 'general-purpose',
            description: 'ci watch CI',
            prompt: 'gh pr checks',
          },
        };
        const pre = await runHook(input);
        assert.equal(pre.code, 0);
        const post = await runHook(input, 'PostToolUse');
        assert.equal(post.code, 0);
        const evidence = readEvidence();
        assert.ok(evidence['ci']?.executed, 'Should record evidence for ci');
      });

      it('Agent with description "reports" is recognized and records evidence', async () => {
        writeWorkState(makeStepStatus('reports', WORK_STEPS));
        const input = {
          tool_name: 'Agent',
          tool_input: {
            subagent_type: 'general-purpose',
            description: 'reports consolidate',
            prompt: 'consolidate reports',
          },
        };
        const pre = await runHook(input);
        assert.equal(pre.code, 0);
        const post = await runHook(input, 'PostToolUse');
        assert.equal(post.code, 0);
        const evidence = readEvidence();
        assert.ok(evidence['reports']?.executed, 'Should record evidence for reports');
      });

      it('Agent with description "complete" is recognized and records evidence', async () => {
        writeWorkState(makeStepStatus('complete', WORK_STEPS));
        const input = {
          tool_name: 'Agent',
          tool_input: {
            subagent_type: 'general-purpose',
            description: 'complete finish',
            prompt: 'mark complete',
          },
        };
        const pre = await runHook(input);
        assert.equal(pre.code, 0);
        const post = await runHook(input, 'PostToolUse');
        assert.equal(post.code, 0);
        const evidence = readEvidence();
        assert.ok(evidence['complete']?.executed, 'Should record evidence for complete');
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
          'check'
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

      it('Agent(pr-generator) is recognized and records evidence for 3_pr_gen', async () => {
        writeWorkflowState(
          makeStepStatus('3_pr_gen', [
            '1_preflight',
            '2_setup',
            '3_pr_gen',
            '4_screenshot_gate',
            '5_post_pr_gen',
            '6_summary',
          ]),
          'work-pr'
        );
        const input = {
          tool_name: 'Agent',
          tool_input: { subagent_type: 'pr-generator', prompt: 'update PR' },
        };

        const pre = await runHook(input);
        assert.equal(pre.code, 0, 'PreToolUse should allow Agent');

        const post = await runHook(input, 'PostToolUse');
        assert.equal(post.code, 0);
        const evidence = readEvidence('.step-evidence-work-pr.json');
        assert.ok(evidence['3_pr_gen']?.executed, 'Should record evidence for 3_pr_gen');
        assert.equal(evidence['3_pr_gen']?.tool, 'Agent');
      });

      it('Agent(pr-post-generator) is recognized and records evidence for 5_post_pr_gen', async () => {
        writeWorkflowState(
          makeStepStatus('5_post_pr_gen', [
            '1_preflight',
            '2_setup',
            '3_pr_gen',
            '4_screenshot_gate',
            '5_post_pr_gen',
            '6_summary',
          ]),
          'work-pr'
        );
        const input = {
          tool_name: 'Agent',
          tool_input: { subagent_type: 'pr-post-generator', prompt: 'add screenshots' },
        };

        const pre = await runHook(input);
        assert.equal(pre.code, 0, 'PreToolUse should allow Agent');

        const post = await runHook(input, 'PostToolUse');
        assert.equal(post.code, 0);
        const evidence = readEvidence('.step-evidence-work-pr.json');
        assert.ok(evidence['5_post_pr_gen']?.executed, 'Should record evidence for 5_post_pr_gen');
        assert.equal(evidence['5_post_pr_gen']?.tool, 'Agent');
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
          tool_input: {
            command: 'node /some/path/workflow-engine.js work-pr transitions PROJ-123',
          },
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
        // After OCP refactor, work-pr definition lives in its own file
        const defPath = path.join(__dirname, '..', '..', 'work-pr', 'workflow-definition.js');
        const defSource = fs.readFileSync(defPath, 'utf-8');
        assert.ok(defSource.includes("'1_preflight'"));
        assert.ok(defSource.includes("'2_setup'"));
        assert.ok(defSource.includes("'6_summary'"));
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Multi-workflow coexistence tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('multi-workflow coexistence', () => {
    it('both workflows can have state files simultaneously', () => {
      writeWorkState(makeStepStatus('pr', WORK_STEPS));
      writeWorkflowState(makeStepStatus('3_pr_gen', WORK_PR_STEPS));

      const workState = JSON.parse(
        fs.readFileSync(path.join(TASKS_DIR, '.work-state.json'), 'utf-8')
      );
      const workPrState = JSON.parse(
        fs.readFileSync(path.join(TASKS_DIR, '.work-pr.workflow-state.json'), 'utf-8')
      );

      assert.equal(workState.stepStatus['pr'], 'in_progress');
      assert.equal(workPrState.stepStatus['3_pr_gen'], 'in_progress');
      assert.equal(workPrState.workflow, 'work-pr');
    });

    it('evidence files are separate per workflow', () => {
      writeEvidence(
        { pr: { executed: true, tool: 'Skill', timestamp: new Date().toISOString() } },
        '.step-evidence.json'
      );
      writeEvidence(
        { '3_pr_gen': { executed: true, tool: 'Task', timestamp: new Date().toISOString() } },
        '.step-evidence-work-pr.json'
      );

      const workEvidence = readEvidence('.step-evidence.json');
      const workPrEvidence = readEvidence('.step-evidence-work-pr.json');

      assert.ok(workEvidence['pr']?.executed);
      assert.ok(!workEvidence['3_pr_gen']);
      assert.ok(workPrEvidence['3_pr_gen']?.executed);
      assert.ok(!workPrEvidence['pr']);
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
      fs.writeFileSync(path.join(TASKS_DIR, '.work-pr.workflow-state.json'), 'corrupted');
      // Should not crash — fail-open
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Helper tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('makeStepStatus helper', () => {
    it('correctly marks /work steps', () => {
      const status = makeStepStatus('check', WORK_STEPS);
      assert.equal(status['ticket'], 'completed');
      assert.equal(status['implement'], 'completed');
      assert.equal(status['check'], 'in_progress');
      assert.equal(status['pr'], 'pending');
      assert.equal(status['complete'], 'pending');
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
        'PostToolUse'
      );
      assert.equal(code, 0);
    });

    it('does not crash on PostToolUse for work-pr transition', async () => {
      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: 'node /path/to/workflow-engine.js work-pr transition PROJ-123 3_pr_gen',
          },
        },
        'PostToolUse'
      );
      assert.equal(code, 0);
    });

    it('does not crash on PostToolUse for work transition', async () => {
      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: 'node /path/to/work-orchestrator.js transition PROJ-123 commit' },
        },
        'PostToolUse'
      );
      assert.equal(code, 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Hardening tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ticket-aware transition enforcement', () => {
    it('allows transition command targeting a different ticket (PreToolUse)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: 'node /path/to/work-orchestrator.js transition OTHER-999 commit' },
      });
      assert.equal(code, 0);
    });

    it('blocks transition command targeting the SAME ticket without evidence', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: {
          command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} commit`,
        },
      });
      assert.equal(code, 2);
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('PostToolUse skips evidence clearing for different ticket transition (Patch 3)', async () => {
      writeWorkState(makeStepStatus('cleanup', WORK_STEPS));
      writeEvidence({
        implement: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
        commit: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
        check: { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        cleanup: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
      });

      // Transition for a DIFFERENT ticket — should NOT touch our evidence
      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: 'node /path/to/work-orchestrator.js transition OTHER-999 commit' },
        },
        'PostToolUse'
      );
      assert.equal(code, 0);

      // All evidence should remain untouched
      const evidence = readEvidence();
      assert.ok(evidence['implement']?.executed, 'Evidence should be untouched');
      assert.ok(evidence['commit']?.executed, 'Evidence should be untouched');
      assert.ok(evidence['check']?.executed, 'Evidence should be untouched');
      assert.ok(evidence['cleanup']?.executed, 'Evidence should be untouched');
    });
  });

  describe('backward transition range fix', () => {
    it('preserves target step evidence on backward transition', async () => {
      writeWorkState(makeStepStatus('cleanup', WORK_STEPS));
      writeEvidence({
        implement: { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        commit: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
        check: { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        pr: { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        cleanup: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
      });

      // Backward transition from cleanup to commit — clears check through cleanup
      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} commit`,
          },
        },
        'PostToolUse'
      );
      assert.equal(code, 0);

      const evidence = readEvidence();
      assert.ok(evidence['implement']?.executed, 'Step before target should be preserved');
      assert.ok(evidence['commit']?.executed, 'Target step evidence should be preserved');
      assert.equal(evidence['check'], undefined, 'Step after target should be cleared');
      assert.equal(evidence['pr'], undefined, 'Step after target should be cleared');
      assert.equal(evidence['cleanup'], undefined, 'Current step should be cleared');
    });
  });

  describe('multi-command expected hint (Patch 5)', () => {
    it('shows all valid commands with field names for check', async () => {
      writeWorkState(makeStepStatus('check', WORK_STEPS));

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} pr` },
      });
      assert.equal(code, 2);

      // Patch 5: new format includes field names and "Expected one of:"
      assert.ok(stderr.includes('Expected one of:'), 'Should use "Expected one of:" header');
      assert.ok(stderr.includes('Skill.skill matches'), 'Should include field name skill');
      assert.ok(stderr.includes('check'), 'Should mention check pattern');
    });

    it('shows all valid commands for 3_pr_gen in work-pr', async () => {
      writeWorkflowState(makeStepStatus('3_pr_gen', WORK_PR_STEPS));

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: {
          command: `node /path/to/workflow-engine.js work-pr transition ${TEST_TICKET} 4_screenshot_gate`,
        },
      });
      assert.equal(code, 2);

      assert.ok(stderr.includes('Expected one of:'), 'Should use new format');
      assert.ok(stderr.includes('pr-generator'), 'Should mention pr-generator');
      assert.ok(stderr.includes('Bash.command matches'), 'Should include Bash.command field');
    });
  });

  describe('attempted command in block message', () => {
    it('includes the attempted transition command via transition.raw (Patch 4)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const transitionCmd = `node /path/to/work-orchestrator.js transition ${TEST_TICKET} commit`;
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
    it('warns on stderr when multiple steps are in_progress (with DEBUG)', async () => {
      const stepStatus = makeStepStatus('implement', WORK_STEPS);
      stepStatus['check'] = 'in_progress';
      writeWorkState(stepStatus);

      const { code, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'echo hello' } },
        'PreToolUse',
        { ENFORCE_HOOK_DEBUG: '1' }
      );
      assert.equal(code, 0);
      assert.ok(
        stderr.includes('WARNING: Multiple steps in_progress'),
        'Should warn about multiple in_progress'
      );
      assert.ok(stderr.includes('implement'), 'Should mention first in_progress step');
      assert.ok(stderr.includes('check'), 'Should mention second in_progress step');
    });

    it('still functions correctly — picks the first in_progress step', async () => {
      const stepStatus = makeStepStatus('implement', WORK_STEPS);
      stepStatus['check'] = 'in_progress';
      writeWorkState(stepStatus);

      const { code } = await runHook({
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'quality-checker',
          description: 'quality run checks',
          prompt: 'run checks',
        },
      });
      assert.equal(code, 0);
    });
  });

  describe('field coercion safety', () => {
    it('handles non-string field values gracefully (object)', async () => {
      const { code } = await runHook({
        tool_name: 'Task',
        tool_input: {
          subagent_type: { nested: 'object' },
          description: 'some task',
          prompt: 'test',
        },
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
      writeWorkState(makeStepStatus('check', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Skill',
          tool_input: { skill: 'check' },
        },
        'PostToolUse'
      );
      assert.equal(code, 0);

      const evidence = readEvidence();
      assert.ok(evidence['check']?.executed, 'Evidence should be recorded');
      assert.equal(evidence['check']?.tool, 'Skill');

      const files = fs.readdirSync(TASKS_DIR);
      const tmpFiles = files.filter((f) => f.includes('.tmp.'));
      assert.equal(tmpFiles.length, 0, 'No temp files should remain');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Source inspection tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('source structure', () => {
    it('transitionHint uses __dirname not hardcoded cache paths', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(
        !hookSource.includes('plugins/cache/work-workflow'),
        'Should not contain hardcoded cache path'
      );
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
      assert.ok(hookSource.includes('appendAction = () => {}'), 'Should have no-op fallback');
    });

    it('(Patch 2) uses didBlock flag in error handlers', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes('let didBlock = false'), 'Should declare didBlock flag');
      assert.ok(hookSource.includes('didBlock ? 2 : 0'), 'Error handlers should check didBlock');
      // Verify didBlock is set before each process.exit(2)
      const exitLines = hookSource
        .split('\n')
        .filter((l) => l.trim().startsWith('process.exit(2)'));
      assert.ok(exitLines.length >= 2, 'Should have at least 2 process.exit(2) calls');
    });

    it('(Patch 6) reads .git/HEAD directly for ticket detection', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes('.git/HEAD'), 'Should read .git/HEAD');
      assert.ok(hookSource.includes('resolveGitHead'), 'Should use resolveGitHead helper');
    });

    it('(Patch 7) validates workflow config at startup', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes('validateWorkflow'), 'Should have validateWorkflow function');
      assert.ok(
        hookSource.includes('softSteps references unknown step'),
        'Should validate softSteps'
      );
      assert.ok(
        hookSource.includes('commandMap references unknown step'),
        'Should validate commandMap steps'
      );
      assert.ok(
        hookSource.includes('commandMap missing field'),
        'Should validate commandMap fields'
      );
    });

    it('(Patch 8) catch blocks log errors to stderr', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes('[enforce-step-workflow] fail-open:'), 'main catch should log');
      assert.ok(hookSource.includes('[enforce-step-workflow] fatal:'), 'outer catch should log');
      assert.ok(
        hookSource.includes('[enforce-step-workflow] uncaught:'),
        'uncaughtException should log'
      );
    });

    it('(Patch 4) parseTransition uses String() coercion and returns raw', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      // Check that parseTransition uses String() coercion
      assert.ok(
        hookSource.includes("String(toolInput?.command || '')"),
        'Should use String() coercion'
      );
      // Check that it returns raw in the result
      assert.ok(hookSource.includes('raw: cmd'), 'Should return raw command in result');
    });

    it('(Patch 9) has resolveGitHead for worktree support', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(
        hookSource.includes('function resolveGitHead()'),
        'Should have resolveGitHead function'
      );
      assert.ok(hookSource.includes('gitdir: '), 'Should check for gitdir pointer');
      assert.ok(
        hookSource.includes("path.join(gitdir, 'HEAD')"),
        'Should resolve worktree HEAD path'
      );
      // Fallback path still reads .git/HEAD as path.join
      assert.ok(
        hookSource.includes("path.join('.git', 'HEAD')"),
        'Should have normal repo fallback'
      );
    });

    it('(Patch 10) validates transition targets against known steps', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      // Both PreToolUse and PostToolUse should check steps.includes
      const matches = hookSource.match(/wf\.steps\.includes\(transition\.targetStep\)/g);
      assert.ok(matches && matches.length >= 2, 'Should validate targetStep in both handlers');
    });

    it('(Patch 12) resolves relative gitdir paths with path.resolve', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(
        hookSource.includes('path.resolve(path.dirname(dotgitPath), rawGitdir)'),
        'Should resolve relative gitdir'
      );
      assert.ok(
        hookSource.includes("const dotgitPath = '.git'"),
        'Should store dotgitPath for dirname'
      );
    });

    it('(Patch 13) isExempt uses String() coercion', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      // Find the isExempt function body
      const exemptMatch = hookSource.match(/function isExempt[\s\S]*?return exemptPatterns/);
      assert.ok(exemptMatch, 'Should have isExempt function');
      assert.ok(
        exemptMatch[0].includes("String(toolInput?.command || '')"),
        'isExempt should use String() coercion'
      );
    });

    it('(Patch 11) gates transient stderr behind DEBUG env var', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(
        hookSource.includes('const DEBUG = !!process.env.ENFORCE_HOOK_DEBUG'),
        'Should declare DEBUG constant'
      );
      // DEBUG must be declared before the error handlers (before uncaughtException)
      const debugIdx = hookSource.indexOf('const DEBUG');
      const uncaughtIdx = hookSource.indexOf("process.on('uncaughtException'");
      assert.ok(debugIdx < uncaughtIdx, 'DEBUG must be declared before uncaughtException handler');
      // Error handlers should be gated
      assert.ok(
        hookSource.includes('if (DEBUG) process.stderr.write(`[enforce-step-workflow] uncaught:'),
        'uncaught handler gated'
      );
      assert.ok(
        hookSource.includes('if (DEBUG) process.stderr.write(`[enforce-step-workflow] fail-open:'),
        'fail-open gated'
      );
      assert.ok(
        hookSource.includes('if (DEBUG) process.stderr.write(`[enforce-step-workflow] fatal:'),
        'fatal gated'
      );
      // BLOCKED and WARNING messages should NOT be gated
      assert.ok(
        !hookSource.includes('if (DEBUG) process.stderr.write(`BLOCKED'),
        'BLOCKED messages must not be gated'
      );
      assert.ok(
        hookSource.includes('if (DEBUG) process.stderr.write(`WARNING'),
        'WARNING messages must be gated'
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Patch 10: transition target validation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('transition target validation (Patch 10)', () => {
    it('allows transition with unknown target step (PreToolUse — not a real transition)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));
      writeEvidence({});

      // Transition to a step that doesn't exist in the workflow — should be ignored
      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: {
          command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} nonexistent_step`,
        },
      });
      // Should NOT block — the command doesn't target a known step, so it's not a real transition
      assert.equal(code, 0);
    });

    it('blocks transition with valid target step (PreToolUse — real transition without evidence)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));
      writeEvidence({});

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: {
          command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} commit`,
        },
      });
      assert.equal(code, 2);
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('PostToolUse ignores transition with unknown target step', async () => {
      writeWorkState(makeStepStatus('commit', WORK_STEPS));
      writeEvidence({
        implement: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
        commit: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
      });

      // Backward transition to unknown step — should be ignored, evidence untouched
      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} fake_step`,
          },
        },
        'PostToolUse'
      );
      assert.equal(code, 0);

      const evidence = readEvidence();
      assert.ok(evidence['implement']?.executed, 'Evidence should be untouched');
      assert.ok(evidence['implement']?.executed, 'Evidence should be untouched');
      assert.ok(evidence['commit']?.executed, 'Evidence should be untouched');
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
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      const exitCode = await new Promise((resolve) => {
        proc.on('close', resolve);
        proc.stdin.write('not valid json {{{{');
        proc.stdin.end();
      });
      assert.equal(exitCode, 0);
      // Without DEBUG, transient errors should NOT appear on stderr
      assert.ok(
        !stderr.includes('[enforce-step-workflow] fail-open:'),
        'Should suppress fail-open message'
      );
    });

    it('shows transient error messages with ENFORCE_HOOK_DEBUG=1', async () => {
      const proc = spawn('node', [HOOK_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_HOOK_TYPE: 'PreToolUse', ENFORCE_HOOK_DEBUG: '1' },
      });
      let stderr = '';
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      const exitCode = await new Promise((resolve) => {
        proc.on('close', resolve);
        proc.stdin.write('not valid json {{{{');
        proc.stdin.end();
      });
      assert.equal(exitCode, 0);
      // With DEBUG, transient errors SHOULD appear on stderr
      assert.ok(
        stderr.includes('[enforce-step-workflow] fail-open:'),
        'Should show fail-open message with DEBUG'
      );
    });

    it('always shows BLOCKED messages regardless of DEBUG', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: {
          command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} commit`,
        },
      });
      assert.equal(code, 2);
      assert.ok(stderr.includes('BLOCKED'), 'BLOCKED messages always visible');
    });

    it('hides WARNING messages when DEBUG is off', async () => {
      const stepStatus = makeStepStatus('implement', WORK_STEPS);
      stepStatus['check'] = 'in_progress';
      writeWorkState(stepStatus);

      const { code, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'echo hello' } },
        'PreToolUse'
      );
      assert.equal(code, 0);
      assert.ok(
        !stderr.includes('WARNING: Multiple steps in_progress'),
        'WARNING hidden without DEBUG'
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Patch 14: ready as soft step
  // ═══════════════════════════════════════════════════════════════════════════

  describe('ready soft step (Patch 14)', () => {
    it('allows transition from ready without evidence', async () => {
      writeWorkState(makeStepStatus('ready', WORK_STEPS));
      // No evidence written for ready

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} ci` },
      });
      // Soft step → should allow transition without evidence
      assert.equal(code, 0);
    });

    it('source confirms ready is in softSteps set', () => {
      // After OCP refactor, work workflow definition lives in its own file
      const defPath = path.join(__dirname, '..', '..', 'work', 'workflow-definition.js');
      const defSource = fs.readFileSync(defPath, 'utf-8');
      const softStepsMatch = defSource.match(/softSteps:\s*new Set\(\[([^\]]+)\]\)/);
      assert.ok(softStepsMatch, 'Should have softSteps declaration');
      assert.ok(softStepsMatch[1].includes('STEPS.ready'), 'softSteps should include STEPS.ready');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Patch 14: pr evidence validation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('pr evidence validation (Patch 14)', () => {
    it('does NOT record evidence for pr when .pr-update-sha is missing', async () => {
      writeWorkState(makeStepStatus('pr', WORK_STEPS));
      // Do NOT create .pr-update-sha file

      const { code } = await runHook(
        { tool_name: 'Skill', tool_input: { skill: 'work-pr' } },
        'PostToolUse'
      );
      assert.equal(code, 0);

      const evidence = readEvidence();
      assert.equal(evidence['pr'], undefined, 'Should NOT record evidence without .pr-update-sha');
    });

    it('source has Patch 14 evidence validation block', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(
        hookSource.includes('(Patch 14) Strengthen pr evidence'),
        'Should have Patch 14 comment'
      );
      assert.ok(hookSource.includes('.pr-update-sha'), 'Should reference .pr-update-sha file');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Rule 3: Block direct state file writes
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Rule 3: Block direct state file writes', () => {
    const PROTECTED_FILES = [
      '.work-state.json',
      '.work-pr.workflow-state.json',
      '.step-evidence.json',
      '.step-evidence-work-pr.json',
      '.work-actions.json',
      '.pr-update-sha',
    ];

    // ── Block Write to all protected files ──────────────────────────────────

    for (const filename of PROTECTED_FILES) {
      it(`blocks Write to ${filename}`, async () => {
        writeWorkState(makeStepStatus('implement', WORK_STEPS));

        const { code, stderr } = await runHook(
          {
            tool_name: 'Write',
            tool_input: { file_path: `/tmp/tasks/TEST-1/${filename}`, content: '{}' },
          },
          'PreToolUse'
        );
        assert.equal(code, 2, `Should block Write to ${filename}`);
        assert.ok(stderr.includes('BLOCKED'), `stderr should contain BLOCKED for ${filename}`);
        assert.ok(stderr.includes(filename), `stderr should mention ${filename}`);
      });
    }

    // ── Block Edit to representative protected files ────────────────────────

    for (const filename of ['.work-state.json', '.step-evidence.json']) {
      it(`blocks Edit to ${filename}`, async () => {
        writeWorkState(makeStepStatus('implement', WORK_STEPS));

        const { code, stderr } = await runHook(
          {
            tool_name: 'Edit',
            tool_input: {
              file_path: `/home/user/tasks/PROJ-99/${filename}`,
              old_string: 'a',
              new_string: 'b',
            },
          },
          'PreToolUse'
        );
        assert.equal(code, 2, `Should block Edit to ${filename}`);
        assert.ok(stderr.includes('BLOCKED'), `stderr should contain BLOCKED`);
        assert.ok(stderr.includes('Edit'), `stderr should mention Edit tool`);
      });
    }

    // ── Block MultiEdit to representative protected files ───────────────────

    for (const filename of ['.work-state.json', '.step-evidence.json']) {
      it(`blocks MultiEdit to ${filename}`, async () => {
        writeWorkState(makeStepStatus('implement', WORK_STEPS));

        const { code, stderr } = await runHook(
          {
            tool_name: 'MultiEdit',
            tool_input: { file_path: `/home/user/tasks/PROJ-99/${filename}`, edits: [] },
          },
          'PreToolUse'
        );
        assert.equal(code, 2, `Should block MultiEdit to ${filename}`);
        assert.ok(stderr.includes('BLOCKED'), `stderr should contain BLOCKED`);
        assert.ok(stderr.includes('MultiEdit'), `stderr should mention MultiEdit tool`);
      });
    }

    // ── Allow non-protected files ───────────────────────────────────────────

    for (const filename of ['package.json', 'index.js', 'app.ts']) {
      it(`allows Write to non-protected file ${filename}`, async () => {
        writeWorkState(makeStepStatus('implement', WORK_STEPS));

        const { code } = await runHook(
          {
            tool_name: 'Write',
            tool_input: { file_path: `/home/user/project/${filename}`, content: '{}' },
          },
          'PreToolUse'
        );
        assert.equal(code, 0, `Should allow Write to ${filename}`);
      });

      it(`allows Edit to non-protected file ${filename}`, async () => {
        writeWorkState(makeStepStatus('implement', WORK_STEPS));

        const { code } = await runHook(
          {
            tool_name: 'Edit',
            tool_input: {
              file_path: `/home/user/project/${filename}`,
              old_string: 'a',
              new_string: 'b',
            },
          },
          'PreToolUse'
        );
        assert.equal(code, 0, `Should allow Edit to ${filename}`);
      });

      it(`allows MultiEdit to non-protected file ${filename}`, async () => {
        writeWorkState(makeStepStatus('implement', WORK_STEPS));

        const { code } = await runHook(
          {
            tool_name: 'MultiEdit',
            tool_input: { file_path: `/home/user/project/${filename}`, edits: [] },
          },
          'PreToolUse'
        );
        assert.equal(code, 0, `Should allow MultiEdit to ${filename}`);
      });
    }

    // ── Edge cases ──────────────────────────────────────────────────────────

    it('blocks .work-state.json even at a different path like /tmp/random/', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Write',
          tool_input: { file_path: '/tmp/random/.work-state.json', content: '{}' },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'Should block based on basename regardless of path');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('allows when ENFORCE_HOOK_TICKET_ID is empty (fail-open)', async () => {
      const { code } = await runHook(
        { tool_name: 'Write', tool_input: { file_path: '/tmp/.work-state.json', content: '{}' } },
        'PreToolUse',
        { ENFORCE_HOOK_TICKET_ID: '' }
      );
      assert.equal(code, 0, 'Should allow when no ticket context (fail-open)');
    });

    it('allows when file_path is empty (fail-open)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        { tool_name: 'Write', tool_input: { file_path: '', content: '{}' } },
        'PreToolUse'
      );
      assert.equal(code, 0, 'Should allow when file_path is empty');
    });

    // ── Bash write detection ───────────────────────────────────────────────

    it('blocks Bash redirect (>) to .work-state.json', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: 'echo "{}" > /home/node/worktrees/tasks/TEST-1/.work-state.json' },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'Should block Bash redirect to state file');
      assert.ok(stderr.includes('BLOCKED'));
      assert.ok(stderr.includes('.work-state.json'));
    });

    it('blocks Bash tee to .step-evidence.json', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'echo "{}" | tee /tmp/.step-evidence.json' } },
        'PreToolUse'
      );
      assert.equal(code, 2, 'Should block Bash tee to evidence file');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks Bash cp to .work-pr.workflow-state.json', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: 'cp /tmp/fake.json /tasks/.work-pr.workflow-state.json' },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'Should block Bash cp to state file');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks Bash append (>>) to .work-actions.json', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'echo "action" >> /tmp/.work-actions.json' } },
        'PreToolUse'
      );
      assert.equal(code, 2, 'Should block Bash append to actions file');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks Bash mv to .pr-update-sha', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'mv /tmp/sha .pr-update-sha' } },
        'PreToolUse'
      );
      assert.equal(code, 2, 'Should block Bash mv to pr-update-sha');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('allows Bash read-only commands referencing state files', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: 'cat /home/node/worktrees/tasks/TEST-1/.work-state.json' },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'Should allow read-only cat of state file');
    });

    it('allows Bash redirect to non-protected file', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'echo "test" > /tmp/output.json' } },
        'PreToolUse'
      );
      assert.equal(code, 0, 'Should allow redirect to non-protected file');
    });

    // ── Source verification ─────────────────────────────────────────────────

    it('source uses createFileProtector from protect-state-files lib', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes('createFileProtector'), 'Should use createFileProtector');
      assert.ok(
        hookSource.includes('PROTECTED_STATE_BASENAMES'),
        'Should define PROTECTED_STATE_BASENAMES'
      );
    });

    it('protect-state-files lib covers MultiEdit in FILE_WRITE_TOOLS', () => {
      const libPath = path.join(__dirname, '..', '..', 'lib', 'protect-state-files.js');
      const libSource = fs.readFileSync(libPath, 'utf-8');
      assert.ok(libSource.includes("'MultiEdit'"), 'Library should cover MultiEdit');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Rule 3c: Block follow-up PR state file writes
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Rule 3c: Block follow-up PR state file writes', () => {
    it('blocks Write to follow-up-pr state file when not in follow_up step', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Write',
          tool_input: { file_path: '/tmp/.claude/follow-up-pr-my-repo-42.json', content: '{}' },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'Should block Write to follow-up-pr state file');
      assert.ok(stderr.includes('follow-up-pr-my-repo-42.json'), 'stderr should mention the file');
    }); // fail-open test for missing .work-state.json is covered below

    it('blocks Edit to follow-up-pr state file when not in follow_up step', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: '/tmp/.claude/follow-up-pr-my-repo-42.json',
            old_string: 'a',
            new_string: 'b',
          },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'Should block Edit to follow-up-pr state file');
    });

    it('blocks MultiEdit to follow-up-pr state file', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'MultiEdit',
          tool_input: { file_path: '/tmp/.claude/follow-up-pr-my-repo-42.json', edits: [] },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'Should block MultiEdit to follow-up-pr state file');
    });

    it('blocks Bash redirect to follow-up-pr state file', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: "echo '{}' > /tmp/.claude/follow-up-pr-my-repo-42.json" },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'Should block Bash redirect to follow-up-pr state file');
    });

    it('allows Write from follow-up-pr agent during follow_up step', async () => {
      writeWorkState(makeStepStatus('follow_up', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Write',
          tool_input: { file_path: '/tmp/.claude/follow-up-pr-my-repo-42.json', content: '{}' },
        },
        'PreToolUse',
        { CLAUDE_CURRENT_AGENT: 'follow-up-pr' }
      );
      assert.equal(code, 0, 'Should allow Write from follow-up-pr agent during follow_up step');
    });

    it('allows Write from follow-up-pr agent during follow_up step (hookData path)', async () => {
      writeWorkState(makeStepStatus('follow_up', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Write',
          tool_input: {
            file_path: '/tmp/.claude/follow-up-pr-my-repo-42.json',
            content: '{}',
            subagent_type: 'follow-up-pr',
          },
          transcript_path: '/tmp/fake-transcript.txt',
        },
        'PreToolUse'
      );
      assert.equal(
        code,
        0,
        'Should allow Write from follow-up-pr agent via hookData during follow_up step'
      );
    });

    it('allows Bash from follow-up-pr agent during follow_up step', async () => {
      writeWorkState(makeStepStatus('follow_up', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: "echo '{}' > /tmp/.claude/follow-up-pr-my-repo-42.json" },
        },
        'PreToolUse',
        { CLAUDE_CURRENT_AGENT: 'follow-up-pr' }
      );
      assert.equal(code, 0, 'Should allow Bash from follow-up-pr agent during follow_up step');
    });

    it('blocks when agent is follow-up-pr but step is NOT follow_up', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Write',
          tool_input: { file_path: '/tmp/.claude/follow-up-pr-my-repo-42.json', content: '{}' },
        },
        'PreToolUse',
        { CLAUDE_CURRENT_AGENT: 'follow-up-pr' }
      );
      assert.equal(code, 2, 'Should block even from follow-up-pr agent if not in follow_up step');
    });

    it('allows Write when no .work-state.json exists (fail-open)', async () => {
      // Do NOT call writeWorkState — simulates no active work workflow
      const { code } = await runHook(
        {
          tool_name: 'Write',
          tool_input: { file_path: '/tmp/.claude/follow-up-pr-my-repo-42.json', content: '{}' },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'Should allow when no work state exists (fail-open)');
    });

    it('allows Write to non-matching files', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Write',
          tool_input: { file_path: '/tmp/.claude/other-file.json', content: '{}' },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'Should allow Write to non-matching files');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Rule 4 verification: review-accountability.json Bash protection
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Rule 4 verification: review-accountability.json Bash protection', () => {
    // These tests verify that the existing artifactProtector (Rule 4) correctly
    // blocks Bash writes to review-accountability.json. The file is protected
    // via ARTIFACT_RULES, not followUpStateProtector (Rule 3c).

    it('blocks Bash redirect to review-accountability.json from non-follow-up-pr agent', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: `echo '{"userApproval":true}' > ${TASKS_DIR}/review-accountability.json`,
          },
        },
        'PreToolUse'
      );
      assert.equal(
        code,
        2,
        'Should block Bash redirect to review-accountability.json outside follow_up step'
      );
    });

    it('allows Bash to review-accountability.json from follow-up-pr agent during follow_up step', async () => {
      writeWorkState(makeStepStatus('follow_up', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: `echo '{"userApproval":true}' > ${TASKS_DIR}/review-accountability.json`,
          },
        },
        'PreToolUse',
        { CLAUDE_CURRENT_AGENT: 'follow-up-pr' }
      );
      assert.equal(
        code,
        0,
        'Should allow Bash to review-accountability.json from follow-up-pr agent during follow_up step'
      );
    }); // Verified: these tests are under Rule 4, not Rule 3c (moved per copilot review)
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /check workflow interaction (issue #67)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('/check workflow interaction', () => {
    it('allows quality-checker when /check is active and /work is at complete', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));
      writeWorkflowState({ '1_setup': 'completed', '4_phase1_agents': 'in_progress' }, 'check');
      const { code } = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'work-workflow:quality-checker', description: 'run tests' },
      });
      assert.equal(code, 0, 'quality-checker should be allowed when /check is active');
    });

    it('allows quality-checker via Task when /check is active and /work is at complete', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));
      writeWorkflowState({ '1_setup': 'completed', '4_phase1_agents': 'in_progress' }, 'check');
      // quality-checker maps to /work's quality step — would be blocked without /check bypass
      const { code } = await runHook({
        tool_name: 'Task',
        tool_input: { subagent_type: 'work-workflow:quality-checker', description: 'run tests' },
      });
      assert.equal(code, 0, 'quality-checker should be allowed when /check is active');
    });

    it('still blocks check agents when /check is NOT active', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));
      // No /check workflow state written — quality-checker has no /work step mapping,
      // so we test with a description-pattern agent like cleanup that maps to a /work step
      const { code, stderr } = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'general-purpose', description: 'cleanup kill session' },
      });
      assert.equal(code, 2, 'cleanup agent should be blocked when cleanup step is not in_progress');
      assert.ok(stderr.includes('BLOCKED'), 'should include BLOCKED message');
    });

    it('still blocks non-check agents even when /check is active', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));
      writeWorkflowState({ '1_setup': 'completed', '4_phase1_agents': 'in_progress' }, 'check');
      const { code, stderr } = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'general-purpose', description: 'cleanup kill session' },
      });
      assert.equal(code, 2, 'cleanup agent should still be blocked');
      assert.ok(stderr.includes('BLOCKED'), 'should include BLOCKED message');
    });

    it('allows completion-checker when /check is active', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));
      writeWorkflowState({ '1_setup': 'completed', '4_phase1_agents': 'in_progress' }, 'check');
      const { code } = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'work-workflow:completion-checker', description: 'verify' },
      });
      assert.equal(code, 0, 'completion-checker should be allowed when /check is active');
    });

    it('allows quality-checker when /check is active and /work is at mid-step', async () => {
      writeWorkState(makeStepStatus('commit', WORK_STEPS));
      writeWorkflowState({ '1_setup': 'completed', '4_phase1_agents': 'in_progress' }, 'check');
      const { code } = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'quality-checker', description: 'run tests' },
      });
      assert.equal(
        code,
        0,
        'quality-checker should be allowed when /check is active regardless of /work step'
      );
    });
  });

  describe('Vector 3 exempt scripts', () => {
    // Use the actual hooks directory (trusted path) for exempt script tests
    const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
    const LIB_DIR = path.join(__dirname, '..');
    const WORK_DIR = path.join(__dirname, '..', '..', 'work');
    const ORCHESTRATOR_PATH = path.join(WORK_DIR, 'work.workflow.js');
    const ENGINE_PATH = path.join(LIB_DIR, 'workflow-engine.js');

    it('allows node work-orchestrator.js transition command (trusted path)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${ORCHESTRATOR_PATH} transition TEST-1 commit` },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'orchestrator transition should be allowed from trusted path');
    });

    it('allows node workflow-engine.js check transition command (trusted path)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${ENGINE_PATH} check transition TEST-1 setup` },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'workflow-engine transition should be allowed from trusted path');
    });

    it('allows orchestrator with env prefix and node flags', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: `SESSION_GUARD_ENABLED=0 node --no-warnings ${ORCHESTRATOR_PATH} transition TEST-1 commit`,
          },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'orchestrator with env prefix and flags should be allowed');
    });

    it('allows orchestrator with quoted script path', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node "${ORCHESTRATOR_PATH}" transition TEST-1 commit` },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'orchestrator with quoted path should be allowed');
    });

    it('allows orchestrator after cd && (chained command)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: `cd /some/dir && node ${ORCHESTRATOR_PATH} transition TEST-1 commit`,
          },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'orchestrator after cd && should be allowed');
    });

    it('blocks exempt script name from untrusted path', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      // Create a fake work-orchestrator.js in /tmp (untrusted)
      const fakePath = path.join(os.tmpdir(), 'work-orchestrator.js');
      fs.writeFileSync(
        fakePath,
        'const fs = require("fs"); fs.writeFileSync(".work-state.json", "{}");'
      );

      try {
        const { code, stderr } = await runHook(
          {
            tool_name: 'Bash',
            tool_input: { command: `node ${fakePath} transition TEST-1 commit` },
          },
          'PreToolUse'
        );
        // Should be blocked because /tmp is not a trusted directory
        assert.equal(code, 2, 'should block exempt script name from untrusted path');
        assert.ok(stderr.includes('BLOCKED'));
      } finally {
        try {
          fs.unlinkSync(fakePath);
        } catch {
          /* cleanup */
        }
      }
    });

    it('still blocks non-exempt script that references protected files', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: 'echo "work-orchestrator.js" > /tmp/.work-state.json' },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'should block redirect even if command mentions exempt script name');
      assert.ok(stderr.includes('BLOCKED'));
    });

    // ─── GH-89: Sub-command filtering for state scripts ──────────────────────
    const WORK_STATE_PATH = path.join(WORK_DIR, 'work-state.js');
    const WORKFLOW_STATE_PATH = path.join(LIB_DIR, 'workflow-state.js');

    // Blocked mutating sub-commands
    it('blocks direct work-state.js set-step call', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${WORK_STATE_PATH} set-step TEST-1 check completed` },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'direct set-step should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks direct work-state.js set-check call', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: `node ${WORK_STATE_PATH} set-check TEST-1 quality_checker completed`,
          },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'direct set-check should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('allows direct work-state.js complete call at terminal step (GH-276)', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${WORK_STATE_PATH} complete ${TEST_TICKET}` },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'direct complete should be allowed at terminal step');
    });

    it('allows direct work-state.js complete with quoted path at terminal step (GH-276)', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node "${WORK_STATE_PATH}" complete ${TEST_TICKET}` },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'quoted path complete should be allowed at terminal step');
    });

    it('does not trigger complete bypass for untrusted path (GH-276 security)', async () => {
      // /tmp/work-state.js is not in TRUSTED_SCRIPT_DIRS, so the bypass won't fire.
      // Rule 3b also skips untrusted paths (they are handled by Vector 3).
      // This test verifies the bypass function itself rejects untrusted paths.
      writeWorkState(makeStepStatus('complete', WORK_STEPS));

      // The command passes through the hook (not blocked, not bypassed) because
      // Rule 3 doesn't detect .work-state.json in the command text, and
      // Rule 3b skips untrusted paths. This is correct — Vector 3 handles untrusted scripts.
      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node /tmp/work-state.js complete ${TEST_TICKET}` },
        },
        'PreToolUse'
      );
      // The hook allows it through (exit 0) — the script doesn't exist so it would fail at runtime.
      // The important thing is that isTerminalCompleteBypass() returns false for untrusted paths.
      assert.equal(code, 0, 'untrusted path is not caught by this hook (handled by Vector 3)');
    });

    it('blocks direct work-state.js complete call from non-terminal step (GH-276)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${WORK_STATE_PATH} complete ${TEST_TICKET}` },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'complete should be blocked at non-terminal step');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks direct work-state.js complete targeting a different ticket (GH-276)', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${WORK_STATE_PATH} complete WRONG-TICKET` },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'complete targeting wrong ticket should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks work-state.js complete with command substitution (GH-276 security)', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${WORK_STATE_PATH} complete $(echo ${TEST_TICKET})` },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'command substitution should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks work-state.js complete with backtick substitution (GH-276 security)', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${WORK_STATE_PATH} complete \`echo ${TEST_TICKET}\`` },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'backtick substitution should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks work-state.js complete chained with || (GH-276 security)', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${WORK_STATE_PATH} complete ${TEST_TICKET} || echo pwned` },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'chained || should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks work-state.js complete with pipe (GH-276 security)', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${WORK_STATE_PATH} complete ${TEST_TICKET} | tee /tmp/out` },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'pipe should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks work-state.js complete with redirect (GH-276 security)', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${WORK_STATE_PATH} complete ${TEST_TICKET} > /tmp/out` },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'redirect should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks work-state.js complete with extra args after ticket (GH-276 security)', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${WORK_STATE_PATH} complete ${TEST_TICKET} --force` },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'extra args should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks work-state.js init-subtask command', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${WORK_STATE_PATH} init-subtask TEST-1 "description"` },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'init-subtask should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks work-state.js complete-subtask command', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${WORK_STATE_PATH} complete-subtask TEST-1 0` },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'complete-subtask should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });

    // Blocked with chained/env-prefix bypass attempts
    it('blocks set-step with chained cd command', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: `cd /some/dir && node ${WORK_STATE_PATH} set-step TEST-1 implement completed`,
          },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'set-step after cd && should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks set-step with env prefix', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: `SESSION_GUARD_ENABLED=0 node ${WORK_STATE_PATH} set-step TEST-1 implement completed`,
          },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'set-step with env prefix should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks chained command that sneaks set-step after safe get', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: `node ${WORK_STATE_PATH} get TEST-1 && node ${WORK_STATE_PATH} set-step TEST-1 implement completed`,
          },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'chained get+set-step should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks semicolon-chained bypass after safe get', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: `node ${WORK_STATE_PATH} get TEST-1; node ${WORK_STATE_PATH} set-step TEST-1 implement completed`,
          },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'semicolon-chained get+set-step should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });
    // ─── GH-89: pipe and flag-arg bypass tests are at the end of this block ─
    // Allowed safe (read-only) sub-commands
    it('allows work-state.js get command', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        { tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} get TEST-1` } },
        'PreToolUse'
      );
      assert.equal(code, 0, 'get should be allowed');
    });

    it('allows work-state.js resume-info command', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${WORK_STATE_PATH} resume-info TEST-1` },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'resume-info should be allowed');
    });

    it('allows work-state.js init command', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        { tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} init TEST-1` } },
        'PreToolUse'
      );
      assert.equal(code, 0, 'init should be allowed');
    });

    it('allows work-state.js add-error command', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${WORK_STATE_PATH} add-error TEST-1 "something failed"` },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'add-error should be allowed');
    });

    it('allows work-state.js active-subtask command', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${WORK_STATE_PATH} active-subtask TEST-1` },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'active-subtask should be allowed');
    });

    it('allows work-state.js quoted subcommand get', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        { tool_name: 'Bash', tool_input: { command: `node ${WORK_STATE_PATH} 'get' TEST-1` } },
        'PreToolUse'
      );
      assert.equal(code, 0, 'quoted get should be allowed');
    });

    // workflow-state.js parity
    it('blocks workflow-state.js set-step call', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: `node ${WORKFLOW_STATE_PATH} work-pr set-step TEST-1 3_pr_gen in_progress`,
          },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'workflow-state.js set-step should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks workflow-state.js complete call', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${WORKFLOW_STATE_PATH} work-pr complete TEST-1` },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'workflow-state.js complete should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks workflow-state.js init call (not idempotent)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${WORKFLOW_STATE_PATH} work-pr init TEST-1` },
        },
        'PreToolUse'
      );
      assert.equal(
        code,
        2,
        'workflow-state.js init should be blocked (not idempotent, resets progress)'
      );
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('allows workflow-state.js get call', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${WORKFLOW_STATE_PATH} work-pr get TEST-1` },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'workflow-state.js get should be allowed');
    });

    it('allows workflow-state.js resume-info call', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${WORKFLOW_STATE_PATH} work-pr resume-info TEST-1` },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'workflow-state.js resume-info should be allowed');
    });

    it('allows workflow-state.js add-error call', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: `node ${WORKFLOW_STATE_PATH} work-pr add-error TEST-1 "something failed"`,
          },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'workflow-state.js add-error should be allowed');
    });

    // ─── GH-89: Node flags with separate arguments ──────────────────────────
    it('node flag with argument does not bypass exempt check (--require)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node --require ./noop.js ${WORK_STATE_PATH} get TEST-1` },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'node --require <arg> followed by safe get should be allowed');
    });

    it('node -r short flag with argument does not bypass exempt check', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node -r ./noop.js ${WORK_STATE_PATH} get TEST-1` },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'node -r <arg> followed by safe get should be allowed');
    });

    it('node --require with unsafe sub-command is blocked', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: `node --require ./noop.js ${WORK_STATE_PATH} set-step TEST-1 check completed`,
          },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'node --require <arg> followed by set-step should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('node -e inline code is not treated as multi-arg flag (GH-89)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      // node -e runs inline code; remaining args are just process.argv, not executed files.
      // With -e removed from multi-arg flags, the regex captures the inline code string
      // as the "script path" (which doesn't exist on disk), so the command is allowed.
      // This is correct: work-state.js is NOT being executed here.
      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: `node -e "console.log('hi')" ${WORK_STATE_PATH} set-step TEST-1 check completed`,
          },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'node -e with trailing argv args is not executing work-state.js');
    });

    it('pipe-chained command blocks unsafe second invocation', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: `node ${WORK_STATE_PATH} get TEST-1 | node ${WORK_STATE_PATH} set-step TEST-1 check completed`,
          },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'pipe-chained get + set-step should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    }); // end pipe-chain bypass test
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Agent allowlist prefix normalization (GH-149)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('agent allowlist prefix normalization', () => {
    it('allows quality-checker via bare CLAUDE_CURRENT_AGENT during check step', async () => {
      writeWorkState(makeStepStatus('check', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Write',
          tool_input: {
            file_path: `${TASKS_DIR}/tests.check.md`,
            content: 'Status: APPROVED\n# Check report',
          },
        },
        'PreToolUse',
        { CLAUDE_CURRENT_AGENT: 'quality-checker' }
      );
      assert.equal(code, 0, 'bare agent name should be allowed');
    });

    it('allows work-workflow:quality-checker via prefixed CLAUDE_CURRENT_AGENT during check step', async () => {
      writeWorkState(makeStepStatus('check', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Write',
          tool_input: {
            file_path: `${TASKS_DIR}/tests.check.md`,
            content: 'Status: APPROVED\n# Check report',
          },
        },
        'PreToolUse',
        { CLAUDE_CURRENT_AGENT: 'work-workflow:quality-checker' }
      );
      assert.equal(code, 0, 'prefixed agent name should be normalized and allowed');
    });

    it('blocks unauthorized agent during check step', async () => {
      writeWorkState(makeStepStatus('check', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Write',
          tool_input: { file_path: `${TASKS_DIR}/tests.check.md`, content: '# Check report' },
        },
        'PreToolUse',
        { CLAUDE_CURRENT_AGENT: 'unauthorized-agent' }
      );
      assert.equal(code, 2, 'unauthorized agent should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });
  });
  // ─── ENFORCE_HOOK_SUFFIX tests (GH-146) ───────────────────────────────────

  describe('ENFORCE_HOOK_SUFFIX (GH-146)', () => {
    const SUFFIX_TICKET = `TEST-SUFFIX-${process.pid}`;
    const SUFFIX = 'phase1';
    const SUFFIX_TASKS_DIR = path.join(TASKS_BASE, SUFFIX_TICKET, SUFFIX);

    afterEach(() => {
      // Clean up both flat and suffixed dirs
      try {
        fs.rmSync(path.join(TASKS_BASE, SUFFIX_TICKET), { recursive: true, force: true });
      } catch {}
    });

    function writeSuffixWorkState(stepStatus, status = 'in_progress') {
      fs.mkdirSync(SUFFIX_TASKS_DIR, { recursive: true });
      const state = {
        ticketId: `${SUFFIX_TICKET}/${SUFFIX}`,
        description: '',
        currentStep: 1,
        status,
        stepStatus,
        checkProgress: {},
        errors: [],
        startTime: new Date().toISOString(),
        lastUpdate: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(SUFFIX_TASKS_DIR, '.work-state.json'),
        JSON.stringify(state, null, 2)
      );
    }

    function writeSuffixEvidence(evidence) {
      fs.mkdirSync(SUFFIX_TASKS_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(SUFFIX_TASKS_DIR, '.step-evidence.json'),
        JSON.stringify(evidence, null, 2)
      );
    }

    it('should resolve suffixed ticket path when ENFORCE_HOOK_SUFFIX is set', async () => {
      writeSuffixWorkState(makeStepStatus('implement', WORK_STEPS));
      writeSuffixEvidence({});

      // With suffix, the hook should find state at SUFFIX_TICKET/phase1/
      const { code } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'echo hello' } },
        'PreToolUse',
        {
          ENFORCE_HOOK_TICKET_ID: SUFFIX_TICKET,
          ENFORCE_HOOK_SUFFIX: SUFFIX,
        }
      );
      // Should allow (not block) since implement is in_progress and echo is not a protected command
      assert.equal(code, 0, 'should allow non-protected command in suffixed state');
    });

    it('should fail-open when suffixed state path does not exist', async () => {
      // No state file created — hook should fail-open
      const { code } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'echo hello' } },
        'PreToolUse',
        {
          ENFORCE_HOOK_TICKET_ID: SUFFIX_TICKET,
          ENFORCE_HOOK_SUFFIX: SUFFIX,
        }
      );
      assert.equal(code, 0, 'should fail-open when no state exists for suffixed path');
    });

    it('should ignore invalid ENFORCE_HOOK_SUFFIX (path traversal prevention)', async () => {
      // Create state only in flat path
      const flatDir = path.join(TASKS_BASE, SUFFIX_TICKET);
      fs.mkdirSync(flatDir, { recursive: true });
      const flatState = {
        ticketId: SUFFIX_TICKET,
        description: '',
        currentStep: 1,
        status: 'in_progress',
        stepStatus: makeStepStatus('implement', WORK_STEPS),
        checkProgress: {},
        errors: [],
        startTime: new Date().toISOString(),
        lastUpdate: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(flatDir, '.work-state.json'), JSON.stringify(flatState, null, 2));
      fs.writeFileSync(path.join(flatDir, '.step-evidence.json'), JSON.stringify({}, null, 2));

      // Invalid suffix should be ignored — hook falls back to flat path
      const { code } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'echo hello' } },
        'PreToolUse',
        {
          ENFORCE_HOOK_TICKET_ID: SUFFIX_TICKET,
          ENFORCE_HOOK_SUFFIX: '../../../etc',
        }
      );
      assert.equal(code, 0, 'should ignore invalid suffix and fall back to flat path');
    });

    it('should use flat ticket path when ENFORCE_HOOK_SUFFIX is not set', async () => {
      // Create state only in flat path, not suffixed
      const flatDir = path.join(TASKS_BASE, SUFFIX_TICKET);
      fs.mkdirSync(flatDir, { recursive: true });
      const flatState = {
        ticketId: SUFFIX_TICKET,
        description: '',
        currentStep: 1,
        status: 'in_progress',
        stepStatus: makeStepStatus('implement', WORK_STEPS),
        checkProgress: {},
        errors: [],
        startTime: new Date().toISOString(),
        lastUpdate: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(flatDir, '.work-state.json'), JSON.stringify(flatState, null, 2));
      fs.writeFileSync(path.join(flatDir, '.step-evidence.json'), JSON.stringify({}, null, 2));

      // Without suffix env, hook should look in flat path
      const { code } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'echo hello' } },
        'PreToolUse',
        {
          ENFORCE_HOOK_TICKET_ID: SUFFIX_TICKET,
          // No ENFORCE_HOOK_SUFFIX
        }
      );
      assert.equal(code, 0, 'should use flat path when suffix env is not set');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // follow_up verify function (live GitHub state checks)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('follow_up verify function', () => {
    // These tests verify that transitioning FROM follow_up uses the verify()
    // function which delegates to follow-up-pr.js functions (single source of truth).
    // We mock `gh` by creating a fake script and prepending its dir to PATH.

    const FAKE_GH_DIR = path.join(os.tmpdir(), `fake-gh-${process.pid}`);
    const FAKE_GH_PATH = path.join(FAKE_GH_DIR, 'gh');
    const ORCHESTRATOR_PATH = path.join(__dirname, '..', '..', 'work', 'work.workflow.js');

    // The verify() function now delegates to follow-up-pr.js which calls:
    //   getPRInfo():  gh pr view --json number,title,url,headRefName,baseRefName,mergeable,mergeStateStatus,state
    //   checkCI():    gh pr checks <N> --json name,bucket,state,link,workflow
    //                 gh pr view <N> --json statusCheckRollup  (NEUTRAL enrichment)
    //   getReviews(): gh pr view <N> --json reviews,statusCheckRollup
    //                 gh repo view --json nameWithOwner
    //                 gh api repos/<owner>/<repo>/pulls/<N>/comments?per_page=100&page=1
    //                 gh api graphql ...  (resolved thread IDs)
    //                 gh pr view <N> --json commits
    //                 gh api repos/<owner>/<repo>/pulls/<N>/requested_reviewers

    function writeFakeGh(responseMap) {
      if (!fs.existsSync(FAKE_GH_DIR)) fs.mkdirSync(FAKE_GH_DIR, { recursive: true });
      let script = '#!/bin/bash\nARGS="$*"\n';
      for (const [pattern, response] of Object.entries(responseMap)) {
        if (response === 'EXIT1') {
          script += `if echo "$ARGS" | grep -qF -- "${pattern}"; then exit 1; fi\n`;
        } else {
          script += `if echo "$ARGS" | grep -qF -- "${pattern}"; then echo '${response.replace(/'/g, "'\\''")}'; exit 0; fi\n`;
        }
      }
      script += 'exit 1\n';
      fs.writeFileSync(FAKE_GH_PATH, script, { mode: 0o755 });
    }

    function cleanupFakeGh() {
      try {
        fs.rmSync(FAKE_GH_DIR, { recursive: true, force: true });
      } catch {}
    }

    function transitionFromFollowUp(extraEnv = {}) {
      return runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} ci` },
        },
        'PreToolUse',
        { PATH: `${FAKE_GH_DIR}:${process.env.PATH}`, ...extraEnv }
      );
    }

    // Helper: build gh mock responses for the full verify() flow.
    // getPRInfo, checkCI, getReviews all need to succeed for transition to pass.
    function buildGhResponses({
      prState = 'OPEN',
      mergeable = 'MERGEABLE',
      mergeStateStatus = 'CLEAN',
      ciBucket = 'pass',
      ciState = 'completed',
      reviewState = 'APPROVED',
      reviewBody = '',
      inlineComments = '[]',
      commentCount = null, // auto-computed from inlineComments if not set
      requestedReviewers = '{"users":[]}',
      graphql = '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}',
      commits = '{"commits":[]}',
    } = {}) {
      // Auto-compute comment count from inline comments JSON
      const autoCount =
        commentCount != null ? commentCount : JSON.parse(inlineComments).length || 0;
      const prView = JSON.stringify({
        number: 42,
        title: 'Test PR',
        url: 'https://github.com/test/repo/pull/42',
        headRefName: 'test-branch',
        baseRefName: 'main',
        mergeable,
        mergeStateStatus,
        state: prState,
      });
      const ciChecks = JSON.stringify([
        { name: 'build', bucket: ciBucket, state: ciState, link: '', workflow: {} },
      ]);
      const statusCheckRollup = JSON.stringify({ statusCheckRollup: [] });
      const reviews = JSON.stringify({
        reviews: reviewState
          ? [{ id: 1, author: { login: 'reviewer' }, state: reviewState, body: reviewBody }]
          : [],
        statusCheckRollup: [],
      });

      return {
        // getPRInfo: gh pr view --json number,title,...
        'pr view --json number,title,url,headRefName,baseRefName,mergeable,mergeStateStatus,state':
          prView,
        // checkCI: gh pr checks 42 --json ...
        'pr checks 42 --json name,bucket,state,link,workflow': ciChecks,
        // checkCI: NEUTRAL enrichment fallback
        'pr view 42 --json statusCheckRollup': statusCheckRollup,
        // getReviews: gh pr view 42 --json reviews,...
        'pr view 42 --json reviews,statusCheckRollup': reviews,
        // getReviews: gh repo view
        'repo view --json nameWithOwner': '{"nameWithOwner":"test/repo"}',
        // isPRGateReady: strict comment count (--jq length, must match before general pattern)
        '--jq length': String(autoCount),
        // getReviews: inline comments (paginated)
        'repos/test/repo/pulls/42/comments': inlineComments,
        // getReviews: GraphQL resolved threads
        'api graphql': graphql,
        // getReviews: commits for stale detection
        'pr view 42 --json commits': commits,
        // getReviews: requested reviewers
        'repos/test/repo/pulls/42/requested_reviewers': requestedReviewers,
      };
    }

    beforeEach(() => {
      writeWorkState(makeStepStatus('follow_up', WORK_STEPS));
    });

    afterEach(() => {
      cleanupFakeGh();
    });

    it('allows transition when CI passes, no blocking reviews, no comments', async () => {
      writeFakeGh(buildGhResponses());
      const { code } = await transitionFromFollowUp();
      assert.equal(code, 0, 'Should allow transition when all checks pass');
    });

    it('blocks transition when CI has failures', async () => {
      writeFakeGh(buildGhResponses({ ciBucket: 'fail' }));
      const { code } = await transitionFromFollowUp();
      assert.equal(code, 2, 'Should block transition when CI has failures');
    });

    it('blocks transition when CI is pending', async () => {
      writeFakeGh(buildGhResponses({ ciBucket: 'pending', ciState: 'pending' }));
      const { code } = await transitionFromFollowUp();
      assert.equal(code, 2, 'Should block transition when CI is pending');
    });

    it('blocks transition when review is CHANGES_REQUESTED', async () => {
      writeFakeGh(buildGhResponses({ reviewState: 'CHANGES_REQUESTED' }));
      const { code } = await transitionFromFollowUp();
      assert.equal(code, 2, 'Should block transition when review has changes requested');
    });

    it('blocks transition when merge is conflicting', async () => {
      writeFakeGh(buildGhResponses({ mergeable: 'CONFLICTING' }));
      const { code } = await transitionFromFollowUp();
      assert.equal(code, 2, 'Should block transition when PR has merge conflicts');
    });

    it('blocks transition when merge state is DIRTY', async () => {
      writeFakeGh(buildGhResponses({ mergeStateStatus: 'DIRTY' }));
      const { code } = await transitionFromFollowUp();
      assert.equal(code, 2, 'Should block transition when merge state is DIRTY');
    });

    it('allows transition when non-blocking comments exist with valid accountability', async () => {
      // Copilot [nitpick] comments → low priority (non-blocking)
      const inlineComments = JSON.stringify([
        {
          id: 1,
          user: { login: 'copilot-pull-request-reviewer' },
          body: '[nitpick] Consider renaming',
          path: 'src/a.js',
          line: 10,
        },
        {
          id: 2,
          user: { login: 'copilot-pull-request-reviewer' },
          body: '[low] Minor style issue',
          path: 'src/b.js',
          line: 20,
        },
      ]);
      writeFakeGh(buildGhResponses({ inlineComments }));

      if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
      const accountability = [
        { disposition: 'addressed', reason: 'Fixed in latest commit' },
        { disposition: 'addressed', reason: 'Updated per feedback' },
      ];
      fs.writeFileSync(
        path.join(TASKS_DIR, 'review-accountability.json'),
        JSON.stringify(accountability, null, 2)
      );

      const { code } = await transitionFromFollowUp();
      assert.equal(code, 0, 'Should allow transition when comments have valid accountability');
    });

    it('blocks transition when non-blocking comments exist but no accountability file', async () => {
      const inlineComments = JSON.stringify([
        {
          id: 1,
          user: { login: 'copilot-pull-request-reviewer' },
          body: '[nitpick] Consider renaming',
          path: 'src/a.js',
          line: 10,
        },
        {
          id: 2,
          user: { login: 'copilot-pull-request-reviewer' },
          body: '[low] Minor style issue',
          path: 'src/b.js',
          line: 20,
        },
      ]);
      writeFakeGh(buildGhResponses({ inlineComments }));

      const { code } = await transitionFromFollowUp();
      assert.equal(code, 2, 'Should block transition when comments exist without accountability');
    });

    it('blocks transition when blocking (human) comments exist even with accountability', async () => {
      // Human comments are always high priority (blocking) — decideNextAction returns exit-fail
      const inlineComments = JSON.stringify([
        { id: 1, user: { login: 'reviewer1' }, body: 'Fix this bug', path: 'src/a.js', line: 10 },
      ]);
      writeFakeGh(buildGhResponses({ inlineComments }));

      if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
      const accountability = [{ disposition: 'addressed', reason: 'Fixed' }];
      fs.writeFileSync(
        path.join(TASKS_DIR, 'review-accountability.json'),
        JSON.stringify(accountability, null, 2)
      );

      const { code } = await transitionFromFollowUp();
      assert.equal(code, 2, 'Should block when blocking human comments exist');
    });

    it('blocks transition when gh pr view fails (no PR)', async () => {
      writeFakeGh({
        'pr view --json number,title,url,headRefName,mergeable,mergeStateStatus,state': 'EXIT1',
      });

      const { code } = await transitionFromFollowUp();
      assert.equal(code, 2, 'Should block transition when no PR exists');
    });

    it('allows transition when no CI checks exist (empty array)', async () => {
      // Override ciChecks to empty and set reviewState to empty
      const responses = buildGhResponses({ reviewState: null });
      responses['pr checks 42 --json name,bucket,state,link,workflow'] = '[]';
      writeFakeGh(responses);

      const { code } = await transitionFromFollowUp();
      assert.equal(code, 0, 'Should allow transition when no CI checks exist');
    });

    it('blocks when accountability entries lack disposition/reason', async () => {
      const inlineComments = JSON.stringify([
        {
          id: 1,
          user: { login: 'copilot-pull-request-reviewer' },
          body: '[nitpick] Minor issue',
          path: 'src/a.js',
          line: 10,
        },
      ]);
      writeFakeGh(buildGhResponses({ inlineComments }));

      if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
      const accountability = [{ disposition: 'addressed' }]; // missing reason
      fs.writeFileSync(
        path.join(TASKS_DIR, 'review-accountability.json'),
        JSON.stringify(accountability, null, 2)
      );

      const { code, stderr } = await transitionFromFollowUp();
      assert.equal(code, 2, 'Should block when accountability entries are incomplete');
      assert.ok(stderr.includes('BLOCKED'), 'stderr should contain BLOCKED marker');
    });

    it('allows acknowledged entries without userApproval (GH-285)', async () => {
      const inlineComments = JSON.stringify([
        {
          id: 1,
          user: { login: 'copilot-pull-request-reviewer' },
          body: '[nitpick] Minor issue',
          path: 'src/a.js',
          line: 10,
        },
      ]);
      writeFakeGh(buildGhResponses({ inlineComments }));

      if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
      const accountability = [{ disposition: 'acknowledged', reason: 'Known issue' }];
      fs.writeFileSync(
        path.join(TASKS_DIR, 'review-accountability.json'),
        JSON.stringify(accountability, null, 2)
      );

      const { code } = await transitionFromFollowUp();
      assert.equal(code, 0, 'Should allow acknowledged entries without userApproval (GH-285)');
    });

    it('allows when acknowledged entries have userApproval=true', async () => {
      const inlineComments = JSON.stringify([
        {
          id: 1,
          user: { login: 'copilot-pull-request-reviewer' },
          body: '[nitpick] Minor issue',
          path: 'src/a.js',
          line: 10,
        },
      ]);
      writeFakeGh(buildGhResponses({ inlineComments }));

      if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
      const accountability = [
        { disposition: 'acknowledged', reason: 'Known issue', userApproval: true },
      ];
      fs.writeFileSync(
        path.join(TASKS_DIR, 'review-accountability.json'),
        JSON.stringify(accountability, null, 2)
      );

      const { code } = await transitionFromFollowUp();
      assert.equal(code, 0, 'Should allow when acknowledged entries have userApproval');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // commit verify: branch-name fallback (GH-191)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('commit verify branch-name fallback (GH-191)', () => {
    const FAKE_GIT_DIR = path.join(os.tmpdir(), `fake-git-commit-${process.pid}`);
    const FAKE_GIT_PATH = path.join(FAKE_GIT_DIR, 'git');
    const FAKE_GH_DIR = path.join(os.tmpdir(), `fake-gh-commit-${process.pid}`);
    const FAKE_GH_PATH = path.join(FAKE_GH_DIR, 'gh');
    const ORCHESTRATOR_PATH = path.join(__dirname, '..', '..', 'work', 'work.workflow.js');

    function writeFakeGit(responseMap) {
      if (!fs.existsSync(FAKE_GIT_DIR)) fs.mkdirSync(FAKE_GIT_DIR, { recursive: true });
      let script = '#!/bin/bash\nARGS="$*"\n';
      for (const [pattern, response] of Object.entries(responseMap)) {
        if (response === 'EXIT1') {
          script += `if echo "$ARGS" | grep -qF -- "${pattern}"; then exit 1; fi\n`;
        } else {
          script += `if echo "$ARGS" | grep -qF -- "${pattern}"; then echo '${response.replace(/'/g, "'\\''")}'; exit 0; fi\n`;
        }
      }
      script += 'exit 1\n';
      fs.writeFileSync(FAKE_GIT_PATH, script, { mode: 0o755 });
    }

    function writeFakeGh(responseMap) {
      if (!fs.existsSync(FAKE_GH_DIR)) fs.mkdirSync(FAKE_GH_DIR, { recursive: true });
      let script = '#!/bin/bash\nARGS="$*"\n';
      for (const [pattern, response] of Object.entries(responseMap)) {
        if (response === 'EXIT1') {
          script += `if echo "$ARGS" | grep -qF -- "${pattern}"; then exit 1; fi\n`;
        } else {
          script += `if echo "$ARGS" | grep -qF -- "${pattern}"; then echo '${response.replace(/'/g, "'\\''")}'; exit 0; fi\n`;
        }
      }
      script += 'exit 1\n';
      fs.writeFileSync(FAKE_GH_PATH, script, { mode: 0o755 });
    }

    function cleanup() {
      try {
        fs.rmSync(FAKE_GIT_DIR, { recursive: true, force: true });
      } catch {}
      try {
        fs.rmSync(FAKE_GH_DIR, { recursive: true, force: true });
      } catch {}
    }

    function transitionFromCommit(extraEnv = {}) {
      return runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} check` },
        },
        'PreToolUse',
        {
          PATH: `${FAKE_GIT_DIR}:${FAKE_GH_DIR}:${process.env.PATH}`,
          TASKS_BASE,
          ...extraEnv,
        }
      );
    }

    beforeEach(() => {
      writeWorkState(makeStepStatus('commit', WORK_STEPS));
    });

    afterEach(() => {
      cleanup();
    });

    it('allows transition via branch-name fallback when commit messages lack ticket ID', async () => {
      writeFakeGit({
        'rev-parse --show-toplevel': process.cwd(),
        'symbolic-ref': 'EXIT1',
        'rev-parse --verify': 'EXIT1',
        'rev-parse HEAD': 'abc123',
        'log --oneline': '', // No commits with ticket ID
        'branch --show-current': `${TEST_TICKET}-fix-something`,
        'diff --shortstat': '1 file changed, 10 insertions(+)',
      });

      const { code } = await transitionFromCommit();
      assert.equal(
        code,
        0,
        'Should allow transition when branch contains ticket ID and diff is non-empty'
      );
    });

    it('blocks transition when branch does not contain ticket ID', async () => {
      writeFakeGit({
        'rev-parse --show-toplevel': process.cwd(),
        'symbolic-ref': 'EXIT1',
        'rev-parse --verify': 'EXIT1',
        'rev-parse HEAD': 'abc123',
        'log --oneline': '',
        'branch --show-current': 'some-unrelated-branch',
        'diff --shortstat': '1 file changed, 10 insertions(+)',
      });

      const { code, stderr } = await transitionFromCommit();
      assert.equal(code, 2, 'Should block when branch name does not contain ticket ID');
    });

    it('blocks transition when branch matches but no committed changes (empty diff)', async () => {
      writeFakeGit({
        'rev-parse --show-toplevel': process.cwd(),
        'symbolic-ref': 'EXIT1',
        'rev-parse --verify': 'EXIT1',
        'rev-parse HEAD': 'abc123',
        'log --oneline': '',
        'branch --show-current': `${TEST_TICKET}-fix-something`,
        'diff --shortstat': '', // No changes
      });

      const { code, stderr } = await transitionFromCommit();
      assert.equal(code, 2, 'Should block when branch matches but diff is empty');
    });

    it('blocks transition on detached HEAD (branch --show-current returns empty)', async () => {
      writeFakeGit({
        'rev-parse --show-toplevel': process.cwd(),
        'symbolic-ref': 'EXIT1',
        'rev-parse --verify': 'EXIT1',
        'rev-parse HEAD': 'abc123',
        'log --oneline': '',
        'branch --show-current': '',
        'diff --shortstat': '1 file changed',
      });

      const { code, stderr } = await transitionFromCommit();
      assert.equal(code, 2, 'Should block when in detached HEAD state');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PR verify: branch positional arg (GH-191, GH-203)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PR verify branch positional arg (GH-191, GH-203)', () => {
    const FAKE_GIT_DIR = path.join(os.tmpdir(), `fake-git-pr-191-${process.pid}`);
    const FAKE_GIT_PATH = path.join(FAKE_GIT_DIR, 'git');
    const FAKE_GH_DIR = path.join(os.tmpdir(), `fake-gh-pr-191-${process.pid}`);
    const FAKE_GH_PATH = path.join(FAKE_GH_DIR, 'gh');
    const ORCHESTRATOR_PATH = path.join(__dirname, '..', '..', 'work', 'work.workflow.js');
    const PR_TEST_BRANCH = `${TEST_TICKET}-pr-test`;

    function writeFakeGit() {
      if (!fs.existsSync(FAKE_GIT_DIR)) fs.mkdirSync(FAKE_GIT_DIR, { recursive: true });
      // Provide controlled branch name so positional arg is always added,
      // even in CI where the checkout may be in detached HEAD state.
      const script = [
        '#!/bin/bash',
        'ARGS="$*"',
        `if echo "$ARGS" | grep -qF -- "branch --show-current"; then echo '${PR_TEST_BRANCH}'; exit 0; fi`,
        `if echo "$ARGS" | grep -qF -- "rev-parse --show-toplevel"; then echo '${process.cwd()}'; exit 0; fi`,
        // Let symbolic-ref / rev-parse --verify fail so getBaseBranch falls through
        'if echo "$ARGS" | grep -qF -- "symbolic-ref"; then exit 1; fi',
        'if echo "$ARGS" | grep -qF -- "rev-parse --verify"; then exit 1; fi',
        'exit 1',
      ].join('\n');
      fs.writeFileSync(FAKE_GIT_PATH, script, { mode: 0o755 });
    }

    function writeFakeGh(responseMap) {
      if (!fs.existsSync(FAKE_GH_DIR)) fs.mkdirSync(FAKE_GH_DIR, { recursive: true });
      let script = '#!/bin/bash\nARGS="$*"\n';
      for (const [pattern, response] of Object.entries(responseMap)) {
        if (response === 'EXIT1') {
          script += `if echo "$ARGS" | grep -qF -- "${pattern}"; then exit 1; fi\n`;
        } else {
          script += `if echo "$ARGS" | grep -qF -- "${pattern}"; then echo '${response.replace(/'/g, "'\\''")}'; exit 0; fi\n`;
        }
      }
      script += 'exit 1\n';
      fs.writeFileSync(FAKE_GH_PATH, script, { mode: 0o755 });
    }

    function cleanup() {
      try {
        fs.rmSync(FAKE_GIT_DIR, { recursive: true, force: true });
      } catch {}
      try {
        fs.rmSync(FAKE_GH_DIR, { recursive: true, force: true });
      } catch {}
    }

    function transitionFromPr(extraEnv = {}) {
      return runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} ready` },
        },
        'PreToolUse',
        { PATH: `${FAKE_GIT_DIR}:${FAKE_GH_DIR}:${process.env.PATH}`, TASKS_BASE, ...extraEnv }
      );
    }

    beforeEach(() => {
      writeFakeGit();
      writeWorkState(makeStepStatus('pr', WORK_STEPS));
    });

    afterEach(() => {
      cleanup();
    });

    it('passes branch as positional arg to gh pr view', async () => {
      // The fake gh should receive the branch name as positional arg (not --head)
      writeFakeGh({
        [`pr view ${PR_TEST_BRANCH}`]: '{"number":42,"state":"OPEN"}',
      });
      // Fake git provides deterministic branch name for positional arg (CI-safe)
      const { code } = await transitionFromPr();
      assert.equal(code, 0, 'Should pass transition when branch positional arg resolves the PR');
    });
  });

  // follow_up verify branch positional arg (GH-191, GH-203) — REMOVED
  // The verify() function now delegates to follow-up-pr.js's isPRGateReady() which
  // relies on `gh pr view` auto-detecting the branch (gh's default behavior).
  // No dedicated branch positional-arg test exists here; gh handles auto-detection.

  // ═══════════════════════════════════════════════════════════════════════════
  // Per-script step gating for AGENT_GATED_SCRIPTS (GH-184)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('per-script step gating (GH-184)', () => {
    // Resolve real script paths so they pass trusted-directory checks
    const TDD_SCRIPT = path.resolve(__dirname, '..', '..', 'work-implement', 'tdd-phase-state.js');
    const QA_REPORT_SCRIPT = path.resolve(
      __dirname,
      '..',
      '..',
      'check',
      'scripts',
      'write-qa-report.js'
    );

    afterEach(() => {
      // Clean up any tokens that may have been written
      const TOKEN_DIR = '/tmp/.claude-write-tokens';
      try {
        fs.unlinkSync(path.join(TOKEN_DIR, 'tdd-phase-state.js'));
      } catch {}
      try {
        fs.unlinkSync(path.join(TOKEN_DIR, 'write-qa-report.js'));
      } catch {}
    });

    it('tdd-phase-state.js token issuance succeeds during implement step', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: `node "${TDD_SCRIPT}" init ${TEST_TICKET}` } },
        'PreToolUse',
        { CLAUDE_CURRENT_AGENT: 'developer-nodejs-tdd' }
      );
      assert.equal(
        code,
        0,
        `tdd-phase-state.js should be allowed during implement step. stderr: ${stderr}`
      );
    });

    it('tdd-phase-state.js token issuance blocked during check step (wrong step)', async () => {
      writeWorkState(makeStepStatus('check', WORK_STEPS));

      const { code, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: `node "${TDD_SCRIPT}" init ${TEST_TICKET}` } },
        'PreToolUse',
        { CLAUDE_CURRENT_AGENT: 'developer-nodejs-tdd' }
      );
      assert.equal(code, 2, 'tdd-phase-state.js should be blocked during check step');
      assert.ok(stderr.includes('BLOCKED'), 'should contain BLOCKED message');
      assert.ok(stderr.includes('implement'), 'error should mention the required step (implement)');
    });

    it('write-qa-report.js succeeds during check step', async () => {
      writeWorkState(makeStepStatus('check', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node "${QA_REPORT_SCRIPT}" --ticket ${TEST_TICKET}` },
        },
        'PreToolUse',
        { CLAUDE_CURRENT_AGENT: 'qa-feature-tester' }
      );
      assert.equal(
        code,
        0,
        `write-qa-report.js should be allowed during check step. stderr: ${stderr}`
      );
    });

    it('write-qa-report.js blocked during implement step (wrong step)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node "${QA_REPORT_SCRIPT}" --ticket ${TEST_TICKET}` },
        },
        'PreToolUse',
        { CLAUDE_CURRENT_AGENT: 'qa-feature-tester' }
      );
      assert.equal(code, 2, 'write-qa-report.js should be blocked during implement step');
      assert.ok(stderr.includes('BLOCKED'), 'should contain BLOCKED message');
      assert.ok(stderr.includes('check'), 'error should mention the required step (check)');
    });

    it('tdd-phase-state.js allowed when no step is active (null currentStep)', async () => {
      // All steps pending — no step is in_progress → currentStep resolves to null
      const allPending = {};
      for (const s of WORK_STEPS) allPending[s] = 'pending';
      writeWorkState(allPending);

      const { code, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: `node "${TDD_SCRIPT}" init ${TEST_TICKET}` } },
        'PreToolUse',
        { CLAUDE_CURRENT_AGENT: 'developer-nodejs-tdd' }
      );
      assert.equal(
        code,
        0,
        `tdd-phase-state.js should be allowed when no step is active (null currentStep). stderr: ${stderr}`
      );
    });

    it('write-qa-report.js from unauthorized agent is blocked', async () => {
      writeWorkState(makeStepStatus('check', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node "${QA_REPORT_SCRIPT}" --ticket ${TEST_TICKET}` },
        },
        'PreToolUse',
        { CLAUDE_CURRENT_AGENT: 'developer-nodejs-tdd' }
      );
      assert.equal(code, 2, 'write-qa-report.js should be blocked from unauthorized agent');
      assert.ok(stderr.includes('BLOCKED'), 'should contain BLOCKED message');
      assert.ok(
        stderr.includes('not running in an authorized agent'),
        'should mention unauthorized agent'
      );
    });

    it('error message includes the per-script required step dynamically', async () => {
      writeWorkState(makeStepStatus('check', WORK_STEPS));

      const { stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: `node "${TDD_SCRIPT}" init ${TEST_TICKET}` } },
        'PreToolUse',
        { CLAUDE_CURRENT_AGENT: 'developer-nodejs-tdd' }
      );
      // Error should say 'check' is active (not 'implement'), and reference the required step
      assert.ok(stderr.includes("'check' is active"), 'error should show current active step');
      assert.ok(stderr.includes("'implement'"), 'error should reference required implement step');
      assert.ok(
        !stderr.includes('Report writer scripts'),
        'should not use generic report writer message'
      );
    });
  });

  describe('commit verifier fallback (GH-144)', () => {
    // These tests validate that the commit verifier accepts commits even when
    // the commit message does NOT contain the ticket ID.
    // Requires a real git repo to exercise the git log/diff commands.

    const { execSync } = require('child_process');
    const WORK_ORCH_PATH = path.join(__dirname, '..', '..', 'work', 'work.workflow.js');
    let gitRepoDir;
    let bareDir;
    let tmpTasksBase;
    const COMMIT_TICKET = `COMMITV-${process.pid}`;

    function runHookInRepo(hookData, hookType = 'PreToolUse', env = {}) {
      return new Promise((resolve, reject) => {
        const proc = spawn('node', [HOOK_PATH], {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: gitRepoDir,
          env: {
            ...process.env,
            CLAUDE_HOOK_TYPE: hookType,
            ENFORCE_HOOK_TICKET_ID: COMMIT_TICKET,
            TASKS_BASE: tmpTasksBase,
            ...env,
          },
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => {
          stdout += d.toString();
        });
        proc.stderr.on('data', (d) => {
          stderr += d.toString();
        });
        proc.on('close', (code) => {
          resolve({ code, stdout, stderr });
        });
        proc.on('error', reject);
        proc.stdin.write(JSON.stringify(hookData));
        proc.stdin.end();
      });
    }

    function writeCommitWorkState(stepStatus, status = 'in_progress') {
      const taskDir = path.join(tmpTasksBase, COMMIT_TICKET);
      if (!fs.existsSync(taskDir)) fs.mkdirSync(taskDir, { recursive: true });
      const state = {
        ticketId: COMMIT_TICKET,
        description: '',
        currentStep: 1,
        status,
        stepStatus,
        checkProgress: {},
        errors: [],
        startTime: new Date().toISOString(),
        lastUpdate: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(taskDir, '.work-state.json'), JSON.stringify(state, null, 2));
    }

    beforeEach(() => {
      // Create a bare repo as "origin" with default branch "main"
      bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-verify-bare-'));
      execSync('git init --bare --initial-branch=main', { cwd: bareDir, stdio: 'pipe' });

      // Clone bare repo — default branch is explicitly "main" (set via --initial-branch above)
      gitRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-verify-work-')); // branch guaranteed "main"
      execSync(`git clone "${bareDir}" .`, { cwd: gitRepoDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: gitRepoDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: gitRepoDir, stdio: 'pipe' });

      // Create initial file, stage, and save on main, push to origin
      fs.writeFileSync(path.join(gitRepoDir, 'README.md'), '# test');
      execSync('git add README.md', { cwd: gitRepoDir, stdio: 'pipe' });
      execSync('git commit -m "initial"', { cwd: gitRepoDir, stdio: 'pipe' });
      execSync('git push origin main', { cwd: gitRepoDir, stdio: 'pipe' });

      // Create feature branch with a file change that does NOT contain the ticket ID in message
      execSync('git checkout -b feature-branch', { cwd: gitRepoDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(gitRepoDir, 'feature.js'), 'const x = 1;');
      execSync('git add feature.js', { cwd: gitRepoDir, stdio: 'pipe' });
      execSync('git commit -m "fix: improve reliability"', { cwd: gitRepoDir, stdio: 'pipe' });

      // Create temp tasks base
      tmpTasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-verify-tasks-'));
    });

    afterEach(() => {
      if (gitRepoDir) fs.rmSync(gitRepoDir, { recursive: true, force: true });
      if (bareDir) fs.rmSync(bareDir, { recursive: true, force: true });
      if (tmpTasksBase) fs.rmSync(tmpTasksBase, { recursive: true, force: true });
    });

    it('accepts transition to check when commits exist without ticket ID in message', async () => {
      // State: commit step is in_progress, no .last-commit-sha exists,
      // commit message does NOT contain the ticket ID.
      // The verifier should detect commits on the branch even without ticket ID.
      const stepStatus = {};
      for (const s of WORK_STEPS) stepStatus[s] = 'pending';
      stepStatus['commit'] = 'in_progress';
      writeCommitWorkState(stepStatus);

      // Transition from commit → check triggers the verify function
      const transitionCmd = `node ${WORK_ORCH_PATH} transition ${COMMIT_TICKET} check`;
      const { code, stderr } = await runHookInRepo({
        tool_name: 'Bash',
        tool_input: { command: transitionCmd },
      });

      // The hook should allow (exit 0) because the commit verifier
      // detects commits on the branch even without ticket ID in message
      assert.equal(code, 0, `Hook should allow transition when commits exist. stderr: ${stderr}`);
    });

    it('blocks transition to check when no commits exist on branch', async () => {
      // Reset the feature branch to match main (no unique commits)
      execSync('git reset --hard origin/main', { cwd: gitRepoDir, stdio: 'pipe' });

      const stepStatus = {};
      for (const s of WORK_STEPS) stepStatus[s] = 'pending';
      stepStatus['commit'] = 'in_progress';
      writeCommitWorkState(stepStatus);

      const transitionCmd = `node ${WORK_ORCH_PATH} transition ${COMMIT_TICKET} check`;
      const { code } = await runHookInRepo({
        tool_name: 'Bash',
        tool_input: { command: transitionCmd },
      });

      // Should block because there are no commits on the branch
      assert.notEqual(code, 0, 'Hook should block transition when no commits exist');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GH-141: Comprehensive transition tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('spec -> implement transition (#96)', () => {
    const ORCHESTRATOR_PATH = path.join(__dirname, '..', '..', 'work', 'work.workflow.js');

    it('allows transition from spec when spec.md exists (verify function)', async () => {
      writeWorkState(makeStepStatus('spec', WORK_STEPS));
      // Create spec.md to satisfy verify function
      fs.writeFileSync(path.join(TASKS_DIR, 'spec.md'), '# Spec\nSome spec content');

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} implement` },
      });
      assert.equal(code, 0, 'Should allow transition when spec.md exists');
    });

    it('blocks transition from spec when spec.md is absent', async () => {
      writeWorkState(makeStepStatus('spec', WORK_STEPS));
      // No spec.md file created

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} implement` },
      });
      assert.equal(code, 2, 'Should block transition when spec.md is absent');
    });

    it('allows transition from implement when tdd-phase.json has red+green cycle', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));
      // Create tdd-phase.json with valid cycle
      fs.writeFileSync(
        path.join(TASKS_DIR, 'tdd-phase.json'),
        JSON.stringify({
          cycles: [{ red: { timestamp: '2026-01-01' }, green: { timestamp: '2026-01-01' } }],
        })
      );

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} commit` },
      });
      assert.equal(code, 0, 'Should allow transition when TDD cycle has red+green');
    });

    it('allows transition from implement with TDD exception mode', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));
      fs.writeFileSync(
        path.join(TASKS_DIR, 'tdd-phase.json'),
        JSON.stringify({
          exception: 'config-only change, no TDD needed',
          cycles: [],
        })
      );

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} commit` },
      });
      assert.equal(code, 0, 'Should allow transition with TDD exception');
    });

    it('blocks transition from implement when tdd-phase.json has no red+green', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));
      fs.writeFileSync(
        path.join(TASKS_DIR, 'tdd-phase.json'),
        JSON.stringify({
          cycles: [{ red: { timestamp: '2026-01-01' } }], // green missing
        })
      );

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} commit` },
      });
      assert.equal(code, 2, 'Should block when TDD cycle incomplete');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks transition from implement when tdd-phase.json is absent', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));
      // No tdd-phase.json

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} commit` },
      });
      assert.equal(code, 2, 'Should block when tdd-phase.json is absent');
      assert.ok(stderr.includes('BLOCKED'));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GH-215: brief_gate transition (brief_gate -> spec)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // These tests exercise the end-to-end enforce-step-workflow hook against the
  // verify entry wired up in workflow-definition.js for STEPS.brief_gate. They
  // simulate a planner asking the orchestrator to advance the workflow from
  // `brief_gate` to `spec`. The hook must:
  //   - allow the transition when brief.md has no blocking open questions
  //     (only-local questions, or architectural questions already resolved),
  //   - block the transition with a BLOCKED message when one or more
  //     architectural / cross-ticket questions remain unresolved, and
  //   - behave idempotently: running two consecutive transitions against an
  //     already-resolved brief must leave brief.md byte-equal and succeed both
  //     times.
  //
  // Shared helpers for building fixture briefs live at the top of this block
  // so all four scenarios use identical framing (same heading placement, same
  // subfield indentation, same trailing newline) — that isolates the gate's
  // behavior from any whitespace noise in the fixtures.
  describe('brief_gate -> spec transition (GH-215)', () => {
    const ORCHESTRATOR_PATH = path.join(__dirname, '..', '..', 'work', 'work.workflow.js');
    const BRIEF_PATH = () => path.join(TASKS_DIR, 'brief.md');

    // Minimal brief.md containing a single structured Open Question of the
    // requested scope + resolved state. Kept deliberately small so a diff of a
    // failing byte-equality assertion is readable.
    function buildBrief({ scope, resolved, withResolution = false }) {
      const lines = [
        '# Brief',
        '',
        '## Open Questions',
        '',
        '- **Question:** Does this change affect the shared auth layer?',
        '  - `scope: ' + scope + '`',
        '  - `resolved: ' + (resolved ? 'true' : 'false') + '`',
        '  - `rationale: gate-scenario fixture`',
      ];
      if (withResolution) {
        lines.push('  - **Resolution:** No — stays confined to this module.');
      }
      lines.push(''); // trailing newline for POSIX-friendly files
      return lines.join('\n');
    }

    function writeBrief(markdown) {
      if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
      fs.writeFileSync(BRIEF_PATH(), markdown);
    }

    it('allows brief_gate -> spec when brief has only scope: local questions', async () => {
      // Scenario 1 (spec §Test Scenarios): only-local questions never block.
      writeWorkState(makeStepStatus('brief_gate', WORK_STEPS));
      writeBrief(buildBrief({ scope: 'local', resolved: false }));

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} spec` },
      });
      assert.equal(
        code,
        0,
        `Should allow brief_gate -> spec for only-local brief. stderr: ${stderr}`
      );
    });

    it('blocks brief_gate -> spec when brief has unresolved architectural question', async () => {
      // Scenario 2: unresolved architectural must block with a reason.
      writeWorkState(makeStepStatus('brief_gate', WORK_STEPS));
      writeBrief(buildBrief({ scope: 'architectural', resolved: false }));

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} spec` },
      });
      assert.equal(
        code,
        2,
        'Should block brief_gate -> spec when architectural question is unresolved'
      );
      assert.ok(stderr.includes('BLOCKED'), 'stderr should contain BLOCKED marker');
      // Tightened assertion: the block reason must reference the gate or the
      // open questions it guards so the user understands what to fix.
      assert.match(
        stderr,
        /brief[_-]gate|open questions|unresolved/i,
        `stderr should mention brief_gate / open questions / unresolved. stderr: ${stderr}`
      );
    });

    it('blocks brief_gate -> spec when brief has unresolved cross-ticket question', async () => {
      // Scenario 2 (cross-ticket counterpart): the gate must also block on
      // scope: cross-ticket unresolved questions. This locks in that BOTH
      // blocking scopes (architectural + cross-ticket) are handled at the
      // integration level, not just architectural.
      writeWorkState(makeStepStatus('brief_gate', WORK_STEPS));
      writeBrief(buildBrief({ scope: 'cross-ticket', resolved: false }));

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} spec` },
      });
      assert.equal(
        code,
        2,
        'Should block brief_gate -> spec when cross-ticket question is unresolved'
      );
      assert.ok(stderr.includes('BLOCKED'), 'stderr should contain BLOCKED marker');
      assert.match(
        stderr,
        /brief[_-]gate|open questions|unresolved/i,
        `stderr should mention brief_gate / open questions / unresolved. stderr: ${stderr}`
      );
    });

    it('allows brief_gate -> spec when architectural question is resolved', async () => {
      // Scenario 4 (first half): architectural question with resolved: true
      // and a Resolution: subfield must pass cleanly.
      writeWorkState(makeStepStatus('brief_gate', WORK_STEPS));
      writeBrief(buildBrief({ scope: 'architectural', resolved: true, withResolution: true }));

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} spec` },
      });
      assert.equal(
        code,
        0,
        `Should allow brief_gate -> spec for resolved architectural brief. stderr: ${stderr}`
      );
    });

    it('is idempotent: two consecutive runs leave brief.md byte-equal and both pass', async () => {
      // Scenario 6: re-running the gate on an already-resolved brief must not
      // mutate the file (byte-equal) and must not re-prompt — both transitions
      // succeed. This guards against accidental rewriter side-effects in the
      // verify path and against duplicate Resolution lines.
      writeWorkState(makeStepStatus('brief_gate', WORK_STEPS));
      const initial = buildBrief({
        scope: 'architectural',
        resolved: true,
        withResolution: true,
      });
      writeBrief(initial);

      const first = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} spec` },
      });
      assert.equal(first.code, 0, `First run should pass. stderr: ${first.stderr}`);
      const afterFirst = fs.readFileSync(BRIEF_PATH(), 'utf-8');
      assert.equal(
        afterFirst,
        initial,
        'brief.md must be byte-equal after the first gate run (verify is read-only)'
      );

      // Re-arm the state as the orchestrator would on a subsequent /work pass.
      writeWorkState(makeStepStatus('brief_gate', WORK_STEPS));
      const second = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} spec` },
      });
      assert.equal(second.code, 0, `Second run should also pass. stderr: ${second.stderr}`);
      const afterSecond = fs.readFileSync(BRIEF_PATH(), 'utf-8');
      assert.equal(
        afterSecond,
        initial,
        'brief.md must remain byte-equal after the second gate run (idempotent)'
      );
    });
  });

  describe('commit -> check transition (#95)', () => {
    const ORCHESTRATOR_PATH = path.join(__dirname, '..', '..', 'work', 'work.workflow.js');

    it('allows forward transition from commit to check with evidence (new commits exist)', async () => {
      writeWorkState(makeStepStatus('commit', WORK_STEPS));
      writeEvidence({
        commit: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
      });

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} check` },
      });
      assert.equal(code, 0, 'Should allow forward transition from commit to check with evidence');
    });

    // Note: The commit verify fallback (GH-144) — which passes when the branch has
    // commits vs base — is tested by the 'commit verifier fallback (GH-144)' describe
    // block above, using an isolated git repo. We don't duplicate that here since it
    // requires a real git setup that CI environments may not have.
  });

  describe('check -> pr and check -> implement (#95)', () => {
    const ORCHESTRATOR_PATH = path.join(__dirname, '..', '..', 'work', 'work.workflow.js');

    it('allows transition from check to pr with Skill(check) evidence', async () => {
      writeWorkState(makeStepStatus('check', WORK_STEPS));
      writeEvidence({
        check: { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
      });

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} pr` },
      });
      assert.equal(code, 0, 'Should allow forward transition with evidence');
    });

    it('allows transition from check to pr when check report files exist (verify)', async () => {
      writeWorkState(makeStepStatus('check', WORK_STEPS));
      // Create required check report files
      const files = [
        'code-review.check.md',
        'tests.check.md',
        'completion.check.md',
        'README.md',
        'qa-manual.check.md',
      ];
      for (const f of files) {
        fs.writeFileSync(path.join(TASKS_DIR, f), '# Report\nContent');
      }

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} pr` },
      });
      assert.equal(code, 0, 'Should allow transition when check report files exist');
    });

    it('blocks transition from check to pr without evidence and no reports', async () => {
      writeWorkState(makeStepStatus('check', WORK_STEPS));
      // No evidence, no report files

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} pr` },
      });
      assert.equal(code, 2, 'Should block forward transition without evidence');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('allows backward transition from check to implement (retry loop)', async () => {
      writeWorkState(makeStepStatus('check', WORK_STEPS));
      // Evidence for current step is required before any transition (including backward)
      writeEvidence({
        check: { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
      });

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} implement` },
      });
      assert.equal(code, 0, 'Should allow backward transition via retry loop');
    });
  });

  describe('pr -> ready transition (#101)', () => {
    const ORCHESTRATOR_PATH = path.join(__dirname, '..', '..', 'work', 'work.workflow.js');

    it('allows transition from pr to ready when pr evidence exists', async () => {
      writeWorkState(makeStepStatus('pr', WORK_STEPS));
      writeEvidence({
        pr: { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
      });

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} ready` },
      });
      assert.equal(code, 0, 'Should allow transition with pr evidence');
    });

    it('blocks transition from pr to ready without evidence when pr verify fails', async () => {
      writeWorkState(makeStepStatus('pr', WORK_STEPS));
      // No evidence — the pr verify function calls `gh pr view` which may pass
      // if a real PR exists for the current branch. To isolate, we use a fake
      // gh that returns an error for pr view.
      const fakeGhDir = path.join(os.tmpdir(), `fake-gh-pr-${process.pid}`);
      const fakeGhPath = path.join(fakeGhDir, 'gh');
      fs.mkdirSync(fakeGhDir, { recursive: true });
      fs.writeFileSync(fakeGhPath, '#!/bin/bash\nexit 1\n', { mode: 0o755 });

      try {
        const { code, stderr } = await runHook(
          {
            tool_name: 'Bash',
            tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} ready` },
          },
          'PreToolUse',
          { PATH: `${fakeGhDir}:${process.env.PATH}` }
        );
        assert.equal(code, 2, 'Should block transition without pr evidence when no PR exists');
        assert.ok(stderr.includes('BLOCKED'));
      } finally {
        fs.rmSync(fakeGhDir, { recursive: true, force: true });
      }
    });

    it('does not record pr evidence when .pr-update-sha is missing (PostToolUse)', async () => {
      writeWorkState(makeStepStatus('pr', WORK_STEPS));
      // No .pr-update-sha file

      const { code } = await runHook(
        { tool_name: 'Skill', tool_input: { skill: 'work-pr' } },
        'PostToolUse'
      );
      assert.equal(code, 0);
      const evidence = readEvidence();
      assert.equal(evidence['pr'], undefined, 'Should NOT record evidence without .pr-update-sha');
    });
  });

  describe('ready -> follow_up and ready -> ci (#102)', () => {
    const ORCHESTRATOR_PATH = path.join(__dirname, '..', '..', 'work', 'work.workflow.js');

    it('allows transition from ready to follow_up (soft step, no evidence needed)', async () => {
      writeWorkState(makeStepStatus('ready', WORK_STEPS));

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} follow_up` },
      });
      assert.equal(code, 0, 'ready is soft step — transition should be allowed without evidence');
    });

    it('allows transition from ready to ci (soft step bypasses evidence check)', async () => {
      writeWorkState(makeStepStatus('ready', WORK_STEPS));

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} ci` },
      });
      // ready IS a soft step, so Rule 2 is skipped entirely (no evidence check).
      // Anti-skip enforcement happens at the orchestrator level, not the hook level.
      // The hook only enforces evidence gating, not transition graph validity.
      assert.equal(
        code,
        0,
        'Soft step bypasses evidence check — anti-skip is orchestrator concern'
      );
    });
  });

  describe('follow_up -> ci and follow_up -> implement (#103)', () => {
    const ORCHESTRATOR_PATH = path.join(__dirname, '..', '..', 'work', 'work.workflow.js');

    it('allows backward transition from follow_up to implement (retry loop)', async () => {
      writeWorkState(makeStepStatus('follow_up', WORK_STEPS));
      // follow_up is NOT a soft step — evidence or verify is required.
      // Provide evidence for follow_up so the backward transition is allowed.
      writeEvidence({
        follow_up: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
      });

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} implement` },
      });
      assert.equal(code, 0, 'Should allow backward transition via RETRY_EDGES with evidence');
    });

    it('allows transition from follow_up to reports (anti-skip is orchestrator concern)', async () => {
      writeWorkState(makeStepStatus('follow_up', WORK_STEPS));
      // Provide evidence so transition is not blocked by evidence gate
      writeEvidence({
        follow_up: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
      });

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} reports` },
      });
      // The hook only checks evidence gating (Rule 2), not transition graph validity.
      // With evidence for follow_up, the hook allows the transition through.
      // Anti-skip enforcement is the orchestrator's responsibility.
      // Note: follow_up has evidence, so Rule 2 passes. The hook does NOT validate
      // whether `reports` is reachable from `follow_up` in the transition graph.
      assert.equal(
        code,
        0,
        'Hook allows transition with evidence — anti-skip is orchestrator concern'
      );
    });
  });

  describe('ci -> cleanup and ci -> implement (#104)', () => {
    const ORCHESTRATOR_PATH = path.join(__dirname, '..', '..', 'work', 'work.workflow.js');

    it('allows transition from ci to cleanup with ci evidence', async () => {
      writeWorkState(makeStepStatus('ci', WORK_STEPS));
      writeEvidence({
        ci: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
      });

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} cleanup` },
      });
      assert.equal(code, 0, 'Should allow forward transition with ci evidence');
    });

    it('blocks transition from ci to cleanup without evidence', async () => {
      writeWorkState(makeStepStatus('ci', WORK_STEPS));
      // No evidence — ci verify() delegates to follow-up-pr.js functions which call `gh`.
      // Use a fake `gh` that fails so verify() returns false.
      const fakeGhDir = path.join(os.tmpdir(), `fake-gh-ci-${process.pid}`);
      fs.mkdirSync(fakeGhDir, { recursive: true });
      fs.writeFileSync(path.join(fakeGhDir, 'gh'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });

      try {
        const { code, stderr } = await runHook(
          {
            tool_name: 'Bash',
            tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} cleanup` },
          },
          'PreToolUse',
          { PATH: `${fakeGhDir}:${process.env.PATH}` }
        );
        assert.equal(code, 2, 'Should block forward transition without evidence');
        assert.ok(stderr.includes('BLOCKED'));
      } finally {
        fs.rmSync(fakeGhDir, { recursive: true, force: true });
      }
    });

    it('allows backward transition from ci to implement (retry loop)', async () => {
      writeWorkState(makeStepStatus('ci', WORK_STEPS));
      // ci is NOT a soft step — evidence or verify is required before transitioning.
      writeEvidence({
        ci: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
      });

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} implement` },
      });
      assert.equal(code, 0, 'Should allow backward transition via RETRY_EDGES with evidence');
    });
  });

  describe('cleanup -> reports transition (#105)', () => {
    const ORCHESTRATOR_PATH = path.join(__dirname, '..', '..', 'work', 'work.workflow.js');

    it('allows transition from cleanup with cleanup evidence', async () => {
      writeWorkState(makeStepStatus('cleanup', WORK_STEPS));
      writeEvidence({
        cleanup: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
      });

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} reports` },
      });
      assert.equal(code, 0, 'Should allow forward transition with cleanup evidence');
    });

    it('allows transition when no tmux session exists in test environment', async () => {
      writeWorkState(makeStepStatus('cleanup', WORK_STEPS));
      // No evidence — cleanup verify checks for tmux session absence
      // Without mock tmux, the verify function will likely return true (no session exists)
      // so we just verify the evidence path works

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} reports` },
      });
      // The cleanup verify function checks for tmux session absence.
      // In test environment, no tmux session exists for this ticket, so verify passes.
      assert.equal(code, 0, 'Should pass via verify — no tmux session exists in test environment');
    });
  });

  describe('backward transition evidence clearing (GH-141)', () => {
    const ORCHESTRATOR_PATH = path.join(__dirname, '..', '..', 'work', 'work.workflow.js');

    it('clears evidence for commit through ci on ci -> implement backward transition', async () => {
      writeWorkState(makeStepStatus('ci', WORK_STEPS));
      writeEvidence({
        implement: { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        commit: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
        check: { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        pr: { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        ready: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
        follow_up: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
        ci: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
      });

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} implement` },
        },
        'PostToolUse'
      );
      assert.equal(code, 0);

      const evidence = readEvidence();
      assert.ok(evidence['implement']?.executed, 'Target step evidence should be preserved');
      assert.equal(evidence['commit'], undefined, 'commit should be cleared');
      assert.equal(evidence['check'], undefined, 'check should be cleared');
      assert.equal(evidence['pr'], undefined, 'pr should be cleared');
      assert.equal(evidence['ready'], undefined, 'ready should be cleared');
      assert.equal(evidence['follow_up'], undefined, 'follow_up should be cleared');
      assert.equal(evidence['ci'], undefined, 'ci should be cleared');
    });

    it('clears evidence for commit through follow_up on follow_up -> implement', async () => {
      writeWorkState(makeStepStatus('follow_up', WORK_STEPS));
      writeEvidence({
        implement: { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        commit: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
        check: { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        pr: { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        ready: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
        follow_up: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
      });

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} implement` },
        },
        'PostToolUse'
      );
      assert.equal(code, 0);

      const evidence = readEvidence();
      assert.ok(evidence['implement']?.executed, 'Target step evidence should be preserved');
      assert.equal(evidence['commit'], undefined, 'commit should be cleared');
      assert.equal(evidence['check'], undefined, 'check should be cleared');
      assert.equal(evidence['pr'], undefined, 'pr should be cleared');
      assert.equal(evidence['ready'], undefined, 'ready should be cleared');
      assert.equal(evidence['follow_up'], undefined, 'follow_up should be cleared');
    });

    it('preserves evidence before target step on backward transition', async () => {
      writeWorkState(makeStepStatus('check', WORK_STEPS));
      writeEvidence({
        spec: { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        implement: { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        commit: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
        check: { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
      });

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} implement` },
        },
        'PostToolUse'
      );
      assert.equal(code, 0);

      const evidence = readEvidence();
      assert.ok(evidence['spec']?.executed, 'Evidence before target should be preserved');
      assert.ok(evidence['implement']?.executed, 'Target step evidence should be preserved');
      assert.equal(evidence['commit'], undefined, 'Steps after target should be cleared');
      assert.equal(evidence['check'], undefined, 'Current step should be cleared');
    });
  });

  describe('anti-skip transitions allowed by hook (GH-141)', () => {
    const ORCHESTRATOR_PATH = path.join(__dirname, '..', '..', 'work', 'work.workflow.js');

    it('allows transition from commit to pr (anti-skip is orchestrator concern)', async () => {
      writeWorkState(makeStepStatus('commit', WORK_STEPS));
      writeEvidence({
        commit: { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
      });

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} pr` },
      });
      // The hook's Rule 2 only checks if evidence exists for currentStep, not if the
      // target is reachable. With commit evidence, the hook allows the transition.
      // Anti-skip enforcement is the orchestrator's responsibility, not the hook's.
      assert.equal(
        code,
        0,
        'Hook allows transition with evidence — anti-skip is orchestrator concern'
      );
    });

    it('allows transition from implement to pr (anti-skip is orchestrator concern)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));
      // With TDD evidence
      fs.writeFileSync(
        path.join(TASKS_DIR, 'tdd-phase.json'),
        JSON.stringify({
          cycles: [{ red: { timestamp: '2026-01-01' }, green: { timestamp: '2026-01-01' } }],
        })
      );

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} pr` },
      });
      // The hook checks evidence, not transition graph validity.
      // With TDD evidence, the hook allows the transition through.
      assert.equal(
        code,
        0,
        'Hook allows transition with evidence — anti-skip is orchestrator concern'
      );
    });

    it('allows transition from implement to ci (anti-skip is orchestrator concern)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));
      fs.writeFileSync(
        path.join(TASKS_DIR, 'tdd-phase.json'),
        JSON.stringify({
          cycles: [{ red: { timestamp: '2026-01-01' }, green: { timestamp: '2026-01-01' } }],
        })
      );

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} ci` },
      });
      // With TDD evidence, the hook allows the transition through.
      assert.equal(
        code,
        0,
        'Hook allows transition with evidence — anti-skip is orchestrator concern'
      );
    });

    it('allows transition from bootstrap to implement (anti-skip is orchestrator concern)', async () => {
      writeWorkState(makeStepStatus('bootstrap', WORK_STEPS));
      writeEvidence({
        bootstrap: { executed: true, tool: 'Bash', timestamp: new Date().toISOString() },
      });

      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node ${ORCHESTRATOR_PATH} transition ${TEST_TICKET} implement` },
      });
      // With bootstrap evidence, the hook allows the transition through.
      assert.equal(
        code,
        0,
        'Hook allows transition with evidence — anti-skip is orchestrator concern'
      );
    });
  });

  describe('Bash hook false-positive fix (GH-141)', () => {
    it('allows node --test of workflow-state test files', async () => {
      // This verifies the fix in protect-state-files.js checkScriptBypass
      // that skips scanning test files
      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: {
          command: 'node --test workflows/lib/__tests__/enforce-step-workflow.test.js',
        },
      });
      assert.equal(code, 0, 'node --test of test file should not be blocked');
    });

    it('allows node --test of a real in-repo test file (GH-141 false-positive)', async () => {
      // Use the real workflow-state.test.js — it exists, contains writeFileSync calls,
      // and lives in __tests__/. Pre-fix, checkScriptBypass would scan it and block.
      // Post-fix (isTrustedTestScript, GH-191), it's skipped as a trusted in-repo test file.
      const realTestFile = path.resolve(__dirname, 'workflow-state.test.js');
      const { code } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node --test ${realTestFile}` },
      });
      assert.equal(code, 0, 'node --test of in-repo __tests__/ file should not be blocked');
    });

    it('still blocks actual write scripts targeting state files', async () => {
      // Create a non-test script that writes to protected files
      const tmpScript = path.join(os.tmpdir(), `evil-${process.pid}.js`);
      fs.writeFileSync(
        tmpScript,
        'const fs = require("fs"); fs.writeFileSync(".work-state.json", "{}");'
      );

      try {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: `node ${tmpScript}` },
        });
        assert.equal(code, 2, 'Non-test scripts writing to state files should still be blocked');
      } finally {
        try {
          fs.unlinkSync(tmpScript);
        } catch {}
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GH-338: session-guard.js subcommand gating
  // ═══════════════════════════════════════════════════════════════════════════

  describe('session-guard.js subcommand gating', () => {
    const SESSION_GUARD_PATH = path.join(__dirname, '..', 'hooks', 'session-guard.js');

    // ─── R2/R4: session-guard finish blocked when not at complete step ──────
    // session-guard finish allowed at complete step (R3/R5)
    // session-guard init allowed at any step (R1/R7)

    it('blocks session-guard.js finish when workflow is not at complete step (R2)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${SESSION_GUARD_PATH} finish ${TEST_TICKET}` },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'finish should be blocked at non-terminal step');
      assert.ok(stderr.includes('BLOCKED'), `expected BLOCKED in stderr, got: ${stderr}`);
    });

    it('blocks session-guard.js reveal when workflow is not at complete step (R4)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${SESSION_GUARD_PATH} reveal ${TEST_TICKET}` },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'reveal should be blocked at non-terminal step');
      assert.ok(stderr.includes('BLOCKED'), `expected BLOCKED in stderr, got: ${stderr}`);
    });

    it('blocks session-guard.js complete when workflow is not at complete step (R4)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${SESSION_GUARD_PATH} complete ${TEST_TICKET}` },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'complete should be blocked at non-terminal step');
      assert.ok(stderr.includes('BLOCKED'), `expected BLOCKED in stderr, got: ${stderr}`);
    });

    // ─── R3/R5: Allow finish/reveal/complete when AT complete step ──────────

    it('allows session-guard.js finish when workflow is at complete step (R3, R5)', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${SESSION_GUARD_PATH} finish ${TEST_TICKET}` },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'finish should be allowed at complete step');
    });

    it('allows session-guard.js reveal when workflow is at complete step (R3)', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${SESSION_GUARD_PATH} reveal ${TEST_TICKET}` },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'reveal should be allowed at complete step');
    });

    it('allows session-guard.js complete when workflow is at complete step (R3)', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${SESSION_GUARD_PATH} complete ${TEST_TICKET}` },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'complete should be allowed at complete step');
    });

    // ─── R1/R7: Allow safe subcommands (init, status) at any step ───────────

    it('allows session-guard.js init at any step (R1, R7)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${SESSION_GUARD_PATH} init ${TEST_TICKET}` },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'init should be allowed at any step');
    });

    it('allows session-guard.js status at any step (R1, R7)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${SESSION_GUARD_PATH} status ${TEST_TICKET}` },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'status should be allowed at any step');
    });

    // ─── R8: Block shell operators even at complete step ────────────────────

    it('blocks session-guard.js finish with shell operators at complete step (R8)', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));

      const shellOperatorCases = [
        { desc: 'pipe', cmd: `node ${SESSION_GUARD_PATH} finish ${TEST_TICKET} | tee /tmp/out` },
        { desc: 'redirect', cmd: `node ${SESSION_GUARD_PATH} finish ${TEST_TICKET} > /tmp/out` },
        { desc: '|| chain', cmd: `node ${SESSION_GUARD_PATH} finish ${TEST_TICKET} || echo pwned` },
        { desc: '&& chain', cmd: `node ${SESSION_GUARD_PATH} finish ${TEST_TICKET} && echo done` },
        {
          desc: 'command substitution',
          cmd: `node ${SESSION_GUARD_PATH} finish $(echo ${TEST_TICKET})`,
        },
        {
          desc: 'backtick substitution',
          cmd: `node ${SESSION_GUARD_PATH} finish \`echo ${TEST_TICKET}\``,
        },
      ];

      for (const { desc, cmd } of shellOperatorCases) {
        const { code, stderr } = await runHook(
          {
            tool_name: 'Bash',
            tool_input: { command: cmd },
          },
          'PreToolUse'
        );
        assert.equal(code, 2, `finish with ${desc} should be blocked`);
        assert.ok(stderr.includes('BLOCKED'), `expected BLOCKED for ${desc}, got: ${stderr}`);
      }
    });

    // ─── R9: Block wrong ticket ─────────────────────────────────────────────

    it('blocks session-guard.js finish targeting wrong ticket at complete step (R9)', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));

      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node ${SESSION_GUARD_PATH} finish WRONG-TICKET` },
        },
        'PreToolUse'
      );
      assert.equal(code, 2, 'finish targeting wrong ticket should be blocked');
      assert.ok(stderr.includes('BLOCKED'), `expected BLOCKED in stderr, got: ${stderr}`);
    });

    // ─── R10: Untrusted path does not get bypass ────────────────────────────

    it('does not trigger bypass for session-guard.js from untrusted path (R10)', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));

      // /tmp/session-guard.js is not in TRUSTED_SCRIPT_DIRS — the bypass must not fire.
      // Rule 3b skips untrusted paths (Vector 3 handles those). Hook exits 0.
      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: `node /tmp/session-guard.js finish ${TEST_TICKET}`,
          },
        },
        'PreToolUse'
      );
      assert.equal(code, 0, 'untrusted path not caught by Rule 3b (handled by Vector 3)');
    });
  });

  // ─── ticketId fallback chain (regression: ECHO-4560 token-mint failure) ───
  describe('ticketId fallback chain when CWD has no ticket branch', () => {
    it('derives ticket from hookData.tool_input.command when ENFORCE_HOOK_TICKET_ID is empty', async () => {
      // Empty ENFORCE_HOOK_TICKET_ID forces the fallback chain. The hook
      // should still process the Bash call (not silently early-return)
      // and exit 0 because no state file matches our fabricated ticket.
      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: 'node /tmp/some-script.js TEST-FALLBACK-CMD-9999 task1',
          },
        },
        'PreToolUse',
        { ENFORCE_HOOK_TICKET_ID: '' }
      );
      assert.equal(code, 0, 'hook should allow Bash with no ticket context');
    });

    it('derives ticket from hookData.transcript_path when command has none', async () => {
      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: 'ls -la' },
          transcript_path:
            '/home/u/.claude/projects/-home-u-g2i-w-tabwoah-tabwoah-TEST-FALLBACK-TR-9998/abc.jsonl',
        },
        'PreToolUse',
        { ENFORCE_HOOK_TICKET_ID: '' }
      );
      assert.equal(code, 0, 'hook should allow Bash when ticket only present in transcript_path');
    });

    it('does not early-return when ticketId is null — Bash on a gated script still reaches Rule 5', async () => {
      // The bug being prevented: prior to the fix, handlePreToolUse exited
      // before Rule 5 when getTicketId() returned null, so no write token
      // was ever minted. This test exercises the path with an explicitly
      // empty ticketId and a Bash call invoking a gated script via a path
      // that resolves to /tmp (untrusted), which means Rule 5 will hit the
      // trusted-dir check and exit 2. That non-zero exit IS the signal
      // that Rule 5 ran — under the bug, the hook would have exited 0.
      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: 'node /tmp/task-next.js TEST-FALLBACK-RULE5-9997 task1',
          },
          transcript_path: '/tmp/no-ticket-here.jsonl',
        },
        'PreToolUse',
        { ENFORCE_HOOK_TICKET_ID: '' }
      );
      assert.equal(
        code,
        2,
        'Rule 5 should run for gated script and block on untrusted path (proves no early-return)'
      );
    });
  });
});
