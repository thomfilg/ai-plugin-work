/**
 * advisory-step-mapping.test.js
 *
 * A Task/Agent `description` is a human-facing label, not a command. The label
 * mappings in the /work commandMap (ready, ci, reports, cleanup, complete,
 * document) are therefore declared `advisory`: they attribute a call to a step
 * only while that step is in progress, and they never block.
 *
 * The regression they encode: dispatching the brief-writer with the
 * description "Complete CHAR-8178 brief via brief-next" matched /^complete\b/i
 * and was blocked with "Cannot run 'work-workflow:brief-writer' — step
 * complete is not in_progress. Current step: brief (in_progress)" — a block
 * that names a step nobody asked for. Rewording the label made the identical
 * call succeed.
 *
 * Run: node --test workflows/lib/hooks/policies/__tests__/advisory-step-mapping.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { createWorkflowLoopRules } = require('../workflow-loop-rules');
const { buildCommandIndex } = require('../command-matching');
const { getCurrentStep } = require('../step-gate');
const createWorkflowDefinition = require(
  path.join(__dirname, '..', '..', '..', '..', 'work', 'workflow-definition')
);
const { STEPS } = require(path.join(__dirname, '..', '..', '..', '..', 'work', 'step-registry'));

const TICKET = 'CHAR-8178';
const NO_TRANSITION = { isTransition: false };

function buildWorkflow(tasksBase) {
  const { workflow } = createWorkflowDefinition({
    TASKS_BASE: tasksBase,
    safeTicketPath: (id) => id,
    resolveGitHead: () => 'ref: refs/heads/stub',
  });
  workflow.commandIndex = buildCommandIndex(workflow.commandMap);
  return workflow;
}

function stateWith(step) {
  return { status: 'in_progress', stepStatus: { [step]: 'in_progress' } };
}

describe('advisory description mappings', () => {
  let tasksBase;
  let workflow;
  let rules;
  let currentState;

  beforeEach(() => {
    tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'advisory-'));
    fs.mkdirSync(path.join(tasksBase, TICKET), { recursive: true });
    workflow = buildWorkflow(tasksBase);
    currentState = stateWith(STEPS.brief);
    rules = createWorkflowLoopRules({
      loadStateFile: (_ticketId, file) => (file === '.work-state.json' ? currentState : null),
      getCurrentStep,
      checkAgents: new Set(),
      tasksBase,
      safeTicketPath: (id) => id,
      appendAction: () => {},
      prStepName: STEPS.pr,
      prShaMatchesHead: () => true,
    });
  });

  afterEach(() => {
    fs.rmSync(tasksBase, { recursive: true, force: true });
  });

  const dispatch = (description, subagentType = 'work-workflow:brief-writer') => ({
    ticketId: TICKET,
    toolName: 'Task',
    toolInput: { description, subagent_type: subagentType },
    transition: NO_TRANSITION,
  });

  it('does not block a brief dispatch whose label starts with "Complete"', () => {
    const block = rules.checkWorkflowPre(
      workflow,
      dispatch('Complete CHAR-8178 brief via brief-next')
    );
    assert.equal(block, null);
  });

  it('does not block on the other label collisions either', () => {
    for (const description of [
      'Check the fixture helper',
      'Ready the migration',
      'Report on bundle size',
      'Cleanup dead imports',
      'CI logs — read only',
      // `document` shipped without `advisory: true`, so this exact label
      // blocked a spec-writer dispatch with "step document is not
      // in_progress" — the regression this whole file exists to prevent,
      // reintroduced by a new step rather than by editing an old one.
      'Document the spec decisions',
    ]) {
      assert.equal(rules.checkWorkflowPre(workflow, dispatch(description)), null, description);
    }
  });

  it('files no evidence for a step whose work never ran', () => {
    rules.recordWorkflowPost(workflow, dispatch('Complete CHAR-8178 brief via brief-next'));
    const evidencePath = path.join(tasksBase, TICKET, workflow.evidenceFile);
    const evidence = fs.existsSync(evidencePath)
      ? JSON.parse(fs.readFileSync(evidencePath, 'utf8'))
      : {};
    assert.equal(evidence[STEPS.complete], undefined);
  });

  it('still attributes the label to the step that IS in progress', () => {
    currentState = stateWith(STEPS.cleanup);
    rules.recordWorkflowPost(workflow, dispatch('cleanup CHAR-8178 worktree', 'cleanup-runner'));
    const evidence = JSON.parse(
      fs.readFileSync(path.join(tasksBase, TICKET, workflow.evidenceFile), 'utf8')
    );
    assert.ok(evidence[STEPS.cleanup]?.executed, 'cleanup evidence should be recorded');
  });

  it('keeps blocking machine-checkable mappings out of their step', () => {
    const block = rules.checkWorkflowPre(workflow, {
      ticketId: TICKET,
      toolName: 'Skill',
      toolInput: { skill: 'work-workflow:split-in-tasks' },
      transition: NO_TRANSITION,
    });
    assert.ok(block, 'a Skill mapping is a command, not a label — it must still gate');
    assert.match(block.message, /step tasks is not in_progress/);
  });

  it('declares every description mapping advisory', () => {
    const labelMappings = workflow.commandMap.filter((m) => m.field === 'description');
    assert.ok(labelMappings.length > 0);
    for (const m of labelMappings) {
      assert.equal(m.advisory, true, `${m.step} matches a label and must be advisory`);
    }
  });

  it('leaves every advisory step transitionable without its label', () => {
    // Nothing is lost by not recording label evidence: each advisory step is
    // covered for the transition gate by a verify() entry or by softSteps.
    for (const m of workflow.commandMap.filter((x) => x.advisory)) {
      const covered =
        workflow.softSteps.has(m.step) ||
        workflow.commandMap.some((x) => x.step === m.step && typeof x.verify === 'function');
      assert.ok(covered, `${m.step} would have no way past the transition gate`);
    }
  });
});
