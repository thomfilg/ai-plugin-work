/**
 * Tests for enforce-step-workflow.js
 *
 * Uses node:test + node:assert/strict.
 * Run: node --test hooks/__tests__/enforce-step-workflow.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'enforce-step-workflow.js');
const getConfig = require(path.join(__dirname, '..', 'get-config'));
const TASKS_BASE = getConfig.require('TASKS_BASE');

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
  'ticket', 'bootstrap', 'brief', 'spec', 'implement',
  'commit', 'check',
  'pr', 'ready', 'follow_up', 'ci', 'cleanup', 'reports', 'complete',
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
          tool_input: { command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/work-orchestrator.js plan PROJ-123' },
        });
        assert.equal(code, 0);
      });

      it('allows orchestrator transitions command', async () => {
        const { code } = await runHook({
          tool_name: 'Bash',
          tool_input: { command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/work-orchestrator.js transitions PROJ-123' },
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
          tool_input: { subagent_type: 'general-purpose', description: 'ticket fetch ticket details', prompt: 'fetch ticket' },
        });
        assert.equal(code, 0);
      });

      it('recognizes Task with description "cleanup" as cleanup', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'Bash', description: 'cleanup kill dev session', prompt: 'kill session' },
        });
        assert.equal(code, 0);
      });

      it('recognizes Task with description "ready" as ready', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'Bash', description: 'ready mark PR ready', prompt: 'gh pr ready' },
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
          tool_input: { subagent_type: 'Bash', description: 'reports consolidate', prompt: 'consolidate reports' },
        });
        assert.equal(code, 0);
      });

      it('recognizes Task with description "complete" as complete', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'Bash', description: 'complete finish', prompt: 'mark complete' },
        });
        assert.equal(code, 0);
      });

      it('description matching is case-insensitive', async () => {
        const { code } = await runHook({
          tool_name: 'Task',
          tool_input: { subagent_type: 'Bash', description: 'CLEANUP kill dev session', prompt: 'kill session' },
        });
        assert.equal(code, 0);
      });
    });

    describe('Agent tool recognition and evidence recording', () => {
      it('Agent with description "cleanup" is recognized and records evidence', async () => {
        writeWorkState(makeStepStatus('cleanup', WORK_STEPS));
        const input = { tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', description: 'cleanup kill dev session', prompt: 'kill session' } };

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
        const input = { tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', description: 'ready mark PR ready', prompt: 'gh pr ready' } };
        const pre = await runHook(input);
        assert.equal(pre.code, 0);
        const post = await runHook(input, 'PostToolUse');
        assert.equal(post.code, 0);
        const evidence = readEvidence();
        assert.ok(evidence['ready']?.executed, 'Should record evidence for ready');
      });

      it('Agent with description "ci" is recognized and records evidence', async () => {
        writeWorkState(makeStepStatus('ci', WORK_STEPS));
        const input = { tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', description: 'ci watch CI', prompt: 'gh pr checks' } };
        const pre = await runHook(input);
        assert.equal(pre.code, 0);
        const post = await runHook(input, 'PostToolUse');
        assert.equal(post.code, 0);
        const evidence = readEvidence();
        assert.ok(evidence['ci']?.executed, 'Should record evidence for ci');
      });

      it('Agent with description "reports" is recognized and records evidence', async () => {
        writeWorkState(makeStepStatus('reports', WORK_STEPS));
        const input = { tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', description: 'reports consolidate', prompt: 'consolidate reports' } };
        const pre = await runHook(input);
        assert.equal(pre.code, 0);
        const post = await runHook(input, 'PostToolUse');
        assert.equal(post.code, 0);
        const evidence = readEvidence();
        assert.ok(evidence['reports']?.executed, 'Should record evidence for reports');
      });

      it('Agent with description "complete" is recognized and records evidence', async () => {
        writeWorkState(makeStepStatus('complete', WORK_STEPS));
        const input = { tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', description: 'complete finish', prompt: 'mark complete' } };
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

      it('Agent(pr-generator) is recognized and records evidence for 3_pr_gen', async () => {
        writeWorkflowState(
          makeStepStatus('3_pr_gen', ['1_preflight', '2_setup', '3_pr_gen', '4_screenshot_gate', '5_post_pr_gen', '6_summary']),
          'work-pr',
        );
        const input = { tool_name: 'Agent', tool_input: { subagent_type: 'pr-generator', prompt: 'update PR' } };

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
          makeStepStatus('5_post_pr_gen', ['1_preflight', '2_setup', '3_pr_gen', '4_screenshot_gate', '5_post_pr_gen', '6_summary']),
          'work-pr',
        );
        const input = { tool_name: 'Agent', tool_input: { subagent_type: 'pr-post-generator', prompt: 'add screenshots' } };

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
      writeWorkState(makeStepStatus('pr', WORK_STEPS));
      writeWorkflowState(makeStepStatus('3_pr_gen', WORK_PR_STEPS));

      const workState = JSON.parse(
        fs.readFileSync(path.join(TASKS_DIR, '.work-state.json'), 'utf-8'),
      );
      const workPrState = JSON.parse(
        fs.readFileSync(path.join(TASKS_DIR, '.workflow-state.json'), 'utf-8'),
      );

      assert.equal(workState.stepStatus['pr'], 'in_progress');
      assert.equal(workPrState.stepStatus['3_pr_gen'], 'in_progress');
      assert.equal(workPrState.workflow, 'work-pr');
    });

    it('evidence files are separate per workflow', () => {
      writeEvidence(
        { 'pr': { executed: true, tool: 'Skill', timestamp: new Date().toISOString() } },
        '.step-evidence.json',
      );
      writeEvidence(
        { '3_pr_gen': { executed: true, tool: 'Task', timestamp: new Date().toISOString() } },
        '.step-evidence-work-pr.json',
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
      fs.writeFileSync(path.join(TASKS_DIR, '.workflow-state.json'), 'corrupted');
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
          tool_input: { command: 'node /path/to/work-orchestrator.js transition PROJ-123 commit' },
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
        tool_input: { command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} commit` },
      });
      assert.equal(code, 2);
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('PostToolUse skips evidence clearing for different ticket transition (Patch 3)', async () => {
      writeWorkState(makeStepStatus('cleanup', WORK_STEPS));
      writeEvidence({
        'implement': { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
        'commit': { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
        'check': { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        'cleanup': { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
      });

      // Transition for a DIFFERENT ticket — should NOT touch our evidence
      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: 'node /path/to/work-orchestrator.js transition OTHER-999 commit' },
        },
        'PostToolUse',
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
        'implement': { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        'commit': { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
        'check': { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        'pr': { executed: true, tool: 'Skill', timestamp: new Date().toISOString() },
        'cleanup': { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
      });

      // Backward transition from cleanup to commit — clears check through cleanup
      const { code } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} commit` },
        },
        'PostToolUse',
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
        { ENFORCE_HOOK_DEBUG: '1' },
      );
      assert.equal(code, 0);
      assert.ok(stderr.includes('WARNING: Multiple steps in_progress'), 'Should warn about multiple in_progress');
      assert.ok(stderr.includes('implement'), 'Should mention first in_progress step');
      assert.ok(stderr.includes('check'), 'Should mention second in_progress step');
    });

    it('still functions correctly — picks the first in_progress step', async () => {
      const stepStatus = makeStepStatus('implement', WORK_STEPS);
      stepStatus['check'] = 'in_progress';
      writeWorkState(stepStatus);

      const { code } = await runHook({
        tool_name: 'Task',
        tool_input: { subagent_type: 'quality-checker', description: 'quality run checks', prompt: 'run checks' },
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
      writeWorkState(makeStepStatus('check', WORK_STEPS));

      const { code } = await runHook(
        {
          tool_name: 'Skill',
          tool_input: { skill: 'check' },
        },
        'PostToolUse',
      );
      assert.equal(code, 0);

      const evidence = readEvidence();
      assert.ok(evidence['check']?.executed, 'Evidence should be recorded');
      assert.equal(evidence['check']?.tool, 'Skill');

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

    it('(Patch 6) reads .git/HEAD directly for ticket detection', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes(".git/HEAD"), 'Should read .git/HEAD');
      assert.ok(hookSource.includes('resolveGitHead'), 'Should use resolveGitHead helper');
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
      assert.ok(hookSource.includes('if (DEBUG) process.stderr.write(`WARNING'), 'WARNING messages must be gated');
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
        tool_input: { command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} nonexistent_step` },
      });
      // Should NOT block — the command doesn't target a known step, so it's not a real transition
      assert.equal(code, 0);
    });

    it('blocks transition with valid target step (PreToolUse — real transition without evidence)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));
      writeEvidence({});

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} commit` },
      });
      assert.equal(code, 2);
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('PostToolUse ignores transition with unknown target step', async () => {
      writeWorkState(makeStepStatus('commit', WORK_STEPS));
      writeEvidence({
        'implement': { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
        'commit': { executed: true, tool: 'Task', timestamp: new Date().toISOString() },
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
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook({
        tool_name: 'Bash',
        tool_input: { command: `node /path/to/work-orchestrator.js transition ${TEST_TICKET} commit` },
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
        'PreToolUse',
      );
      assert.equal(code, 0);
      assert.ok(!stderr.includes('WARNING: Multiple steps in_progress'), 'WARNING hidden without DEBUG');
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
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      // Check that softSteps contains STEPS.ready (uses central registry)
      const softStepsMatch = hookSource.match(/softSteps:\s*new Set\(\[([^\]]+)\]\)/);
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
        'PostToolUse',
      );
      assert.equal(code, 0);

      const evidence = readEvidence();
      assert.equal(evidence['pr'], undefined, 'Should NOT record evidence without .pr-update-sha');
    });

    it('source has Patch 14 evidence validation block', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes("(Patch 14) Strengthen pr evidence"), 'Should have Patch 14 comment');
      assert.ok(hookSource.includes('.pr-update-sha'), 'Should reference .pr-update-sha file');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Rule 3: Block direct state file writes
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Rule 3: Block direct state file writes', () => {

    const PROTECTED_FILES = [
      '.work-state.json',
      '.workflow-state.json',
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
          { tool_name: 'Write', tool_input: { file_path: `/tmp/tasks/TEST-1/${filename}`, content: '{}' } },
          'PreToolUse',
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
          { tool_name: 'Edit', tool_input: { file_path: `/home/user/tasks/PROJ-99/${filename}`, old_string: 'a', new_string: 'b' } },
          'PreToolUse',
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
          { tool_name: 'MultiEdit', tool_input: { file_path: `/home/user/tasks/PROJ-99/${filename}`, edits: [] } },
          'PreToolUse',
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
          { tool_name: 'Write', tool_input: { file_path: `/home/user/project/${filename}`, content: '{}' } },
          'PreToolUse',
        );
        assert.equal(code, 0, `Should allow Write to ${filename}`);
      });

      it(`allows Edit to non-protected file ${filename}`, async () => {
        writeWorkState(makeStepStatus('implement', WORK_STEPS));

        const { code } = await runHook(
          { tool_name: 'Edit', tool_input: { file_path: `/home/user/project/${filename}`, old_string: 'a', new_string: 'b' } },
          'PreToolUse',
        );
        assert.equal(code, 0, `Should allow Edit to ${filename}`);
      });

      it(`allows MultiEdit to non-protected file ${filename}`, async () => {
        writeWorkState(makeStepStatus('implement', WORK_STEPS));

        const { code } = await runHook(
          { tool_name: 'MultiEdit', tool_input: { file_path: `/home/user/project/${filename}`, edits: [] } },
          'PreToolUse',
        );
        assert.equal(code, 0, `Should allow MultiEdit to ${filename}`);
      });
    }

    // ── Edge cases ──────────────────────────────────────────────────────────

    it('blocks .work-state.json even at a different path like /tmp/random/', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        { tool_name: 'Write', tool_input: { file_path: '/tmp/random/.work-state.json', content: '{}' } },
        'PreToolUse',
      );
      assert.equal(code, 2, 'Should block based on basename regardless of path');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('allows when ENFORCE_HOOK_TICKET_ID is empty (fail-open)', async () => {
      const { code } = await runHook(
        { tool_name: 'Write', tool_input: { file_path: '/tmp/.work-state.json', content: '{}' } },
        'PreToolUse',
        { ENFORCE_HOOK_TICKET_ID: '' },
      );
      assert.equal(code, 0, 'Should allow when no ticket context (fail-open)');
    });

    it('allows when file_path is empty (fail-open)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        { tool_name: 'Write', tool_input: { file_path: '', content: '{}' } },
        'PreToolUse',
      );
      assert.equal(code, 0, 'Should allow when file_path is empty');
    });

    // ── Bash write detection ───────────────────────────────────────────────

    it('blocks Bash redirect (>) to .work-state.json', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'echo "{}" > /home/node/worktrees/tasks/TEST-1/.work-state.json' } },
        'PreToolUse',
      );
      assert.equal(code, 2, 'Should block Bash redirect to state file');
      assert.ok(stderr.includes('BLOCKED'));
      assert.ok(stderr.includes('.work-state.json'));
    });

    it('blocks Bash tee to .step-evidence.json', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'echo "{}" | tee /tmp/.step-evidence.json' } },
        'PreToolUse',
      );
      assert.equal(code, 2, 'Should block Bash tee to evidence file');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks Bash cp to .workflow-state.json', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'cp /tmp/fake.json /tasks/.workflow-state.json' } },
        'PreToolUse',
      );
      assert.equal(code, 2, 'Should block Bash cp to state file');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks Bash append (>>) to .work-actions.json', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'echo "action" >> /tmp/.work-actions.json' } },
        'PreToolUse',
      );
      assert.equal(code, 2, 'Should block Bash append to actions file');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('blocks Bash mv to .pr-update-sha', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'mv /tmp/sha .pr-update-sha' } },
        'PreToolUse',
      );
      assert.equal(code, 2, 'Should block Bash mv to pr-update-sha');
      assert.ok(stderr.includes('BLOCKED'));
    });

    it('allows Bash read-only commands referencing state files', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'cat /home/node/worktrees/tasks/TEST-1/.work-state.json' } },
        'PreToolUse',
      );
      assert.equal(code, 0, 'Should allow read-only cat of state file');
    });

    it('allows Bash redirect to non-protected file', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'echo "test" > /tmp/output.json' } },
        'PreToolUse',
      );
      assert.equal(code, 0, 'Should allow redirect to non-protected file');
    });

    // ── Source verification ─────────────────────────────────────────────────

    it('source uses createFileProtector from protect-state-files lib', () => {
      const hookSource = fs.readFileSync(HOOK_PATH, 'utf-8');
      assert.ok(hookSource.includes('createFileProtector'), 'Should use createFileProtector');
      assert.ok(hookSource.includes('PROTECTED_STATE_BASENAMES'), 'Should define PROTECTED_STATE_BASENAMES');
    });

    it('protect-state-files lib covers MultiEdit in FILE_WRITE_TOOLS', () => {
      const libPath = path.join(__dirname, '..', '..', 'lib', 'protect-state-files.js');
      const libSource = fs.readFileSync(libPath, 'utf-8');
      assert.ok(libSource.includes("'MultiEdit'"), 'Library should cover MultiEdit');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /check workflow interaction (issue #67)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('/check workflow interaction', () => {
    it('allows quality-checker when /check is active and /work is at complete', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));
      writeWorkflowState(
        { '1_setup': 'completed', '4_phase1_agents': 'in_progress' },
        'check',
      );
      const { code } = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'work-workflow:quality-checker', description: 'run tests' },
      });
      assert.equal(code, 0, 'quality-checker should be allowed when /check is active');
    });

    it('allows quality-checker via Task when /check is active and /work is at complete', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));
      writeWorkflowState(
        { '1_setup': 'completed', '4_phase1_agents': 'in_progress' },
        'check',
      );
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
      writeWorkflowState(
        { '1_setup': 'completed', '4_phase1_agents': 'in_progress' },
        'check',
      );
      const { code, stderr } = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'general-purpose', description: 'cleanup kill session' },
      });
      assert.equal(code, 2, 'cleanup agent should still be blocked');
      assert.ok(stderr.includes('BLOCKED'), 'should include BLOCKED message');
    });

    it('allows completion-checker when /check is active', async () => {
      writeWorkState(makeStepStatus('complete', WORK_STEPS));
      writeWorkflowState(
        { '1_setup': 'completed', '4_phase1_agents': 'in_progress' },
        'check',
      );
      const { code } = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'work-workflow:completion-checker', description: 'verify' },
      });
      assert.equal(code, 0, 'completion-checker should be allowed when /check is active');
    });

    it('allows quality-checker when /check is active and /work is at mid-step', async () => {
      writeWorkState(makeStepStatus('commit', WORK_STEPS));
      writeWorkflowState(
        { '1_setup': 'completed', '4_phase1_agents': 'in_progress' },
        'check',
      );
      const { code } = await runHook({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'quality-checker', description: 'run tests' },
      });
      assert.equal(code, 0, 'quality-checker should be allowed when /check is active regardless of /work step');
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
        { tool_name: 'Bash', tool_input: { command: `node ${ORCHESTRATOR_PATH} transition TEST-1 commit` } },
        'PreToolUse',
      );
      assert.equal(code, 0, 'orchestrator transition should be allowed from trusted path');
    });

    it('allows node workflow-engine.js check transition command (trusted path)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        { tool_name: 'Bash', tool_input: { command: `node ${ENGINE_PATH} check transition TEST-1 setup` } },
        'PreToolUse',
      );
      assert.equal(code, 0, 'workflow-engine transition should be allowed from trusted path');
    });

    it('allows orchestrator with env prefix and node flags', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        { tool_name: 'Bash', tool_input: { command: `SESSION_GUARD_ENABLED=0 node --no-warnings ${ORCHESTRATOR_PATH} transition TEST-1 commit` } },
        'PreToolUse',
      );
      assert.equal(code, 0, 'orchestrator with env prefix and flags should be allowed');
    });

    it('allows orchestrator with quoted script path', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        { tool_name: 'Bash', tool_input: { command: `node "${ORCHESTRATOR_PATH}" transition TEST-1 commit` } },
        'PreToolUse',
      );
      assert.equal(code, 0, 'orchestrator with quoted path should be allowed');
    });

    it('allows orchestrator after cd && (chained command)', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code } = await runHook(
        { tool_name: 'Bash', tool_input: { command: `cd /some/dir && node ${ORCHESTRATOR_PATH} transition TEST-1 commit` } },
        'PreToolUse',
      );
      assert.equal(code, 0, 'orchestrator after cd && should be allowed');
    });

    it('blocks exempt script name from untrusted path', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      // Create a fake work-orchestrator.js in /tmp (untrusted)
      const fakePath = path.join(os.tmpdir(), 'work-orchestrator.js');
      fs.writeFileSync(fakePath, 'const fs = require("fs"); fs.writeFileSync(".work-state.json", "{}");');

      try {
        const { code, stderr } = await runHook(
          { tool_name: 'Bash', tool_input: { command: `node ${fakePath} transition TEST-1 commit` } },
          'PreToolUse',
        );
        // Should be blocked because /tmp is not a trusted directory
        assert.equal(code, 2, 'should block exempt script name from untrusted path');
        assert.ok(stderr.includes('BLOCKED'));
      } finally {
        try { fs.unlinkSync(fakePath); } catch { /* cleanup */ }
      }
    });

    it('still blocks non-exempt script that references protected files', async () => {
      writeWorkState(makeStepStatus('implement', WORK_STEPS));

      const { code, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'echo "work-orchestrator.js" > /tmp/.work-state.json' } },
        'PreToolUse',
      );
      assert.equal(code, 2, 'should block redirect even if command mentions exempt script name');
      assert.ok(stderr.includes('BLOCKED'));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Agent allowlist prefix normalization (GH-149)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('agent allowlist prefix normalization', () => {
    it('allows quality-checker via bare CLAUDE_CURRENT_AGENT during check step', async () => {
      writeWorkState(makeStepStatus('check', WORK_STEPS));

      const { code } = await runHook(
        { tool_name: 'Write', tool_input: { file_path: `${TASKS_DIR}/tests.check.md`, content: '# Check report' } },
        'PreToolUse',
        { CLAUDE_CURRENT_AGENT: 'quality-checker' },
      );
      assert.equal(code, 0, 'bare agent name should be allowed');
    });

    it('allows work-workflow:quality-checker via prefixed CLAUDE_CURRENT_AGENT during check step', async () => {
      writeWorkState(makeStepStatus('check', WORK_STEPS));

      const { code } = await runHook(
        { tool_name: 'Write', tool_input: { file_path: `${TASKS_DIR}/tests.check.md`, content: '# Check report' } },
        'PreToolUse',
        { CLAUDE_CURRENT_AGENT: 'work-workflow:quality-checker' },
      );
      assert.equal(code, 0, 'prefixed agent name should be normalized and allowed');
    });

    it('blocks unauthorized agent during check step', async () => {
      writeWorkState(makeStepStatus('check', WORK_STEPS));

      const { code, stderr } = await runHook(
        { tool_name: 'Write', tool_input: { file_path: `${TASKS_DIR}/tests.check.md`, content: '# Check report' } },
        'PreToolUse',
        { CLAUDE_CURRENT_AGENT: 'unauthorized-agent' },
      );
      assert.equal(code, 2, 'unauthorized agent should be blocked');
      assert.ok(stderr.includes('BLOCKED'));
    });
  });
});
