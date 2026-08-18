/**
 * check-spec-retry.test.js — GH-247
 *
 * `check` can retry back to `spec` so the 4b_gherkin_scope gate's own
 * remediation ("transition back to the spec step and add the missing tagged
 * scenario(s)") is reachable. A declared-scope mismatch is a spec.md defect,
 * not a code defect, so routing it through `implement` would fix the wrong
 * artifact.
 *
 * The edge alone is not enough. steps/spec.js DEFERs on "spec.md already
 * exists", so the retry would land on a step that declines to run and the
 * workflow would advance with the very spec.md the gate rejected. The backward
 * transition therefore invalidates the destination step's artifact, and the
 * spec step dispatches an amend run instead of deferring.
 *
 * Uses node:test + node:assert/strict.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORK = path.join(__dirname, '..');
const registry = require(path.join(WORK, 'step-registry'));
const helpers = require(path.join(WORK, 'lib', 'work-helpers'));
const { archiveStepArtifacts } = require(path.join(WORK, 'lib', 'artifact-archival'));
const { isEvidenceStale } = require(path.join(WORK, 'lib', 'evidence-staleness'));
const { transitionStep } = require(path.join(WORK, 'engine', 'transition-step'));
const createWorkflowDefinition = require(path.join(WORK, 'workflow-definition'));
const specStep = require(path.join(WORK, 'steps', 'spec'));

const { STEPS, ALL_STEPS, STEP_TRANSITIONS, workflowCanTransition } = registry;
const TICKET = 'GH-247';

let tasksBase;
let ticketDir;
let workflow;

function seedState(currentStep) {
  const stepStatus = {};
  const idx = ALL_STEPS.indexOf(currentStep);
  ALL_STEPS.forEach((s, i) => {
    stepStatus[s] = i < idx ? 'completed' : i === idx ? 'in_progress' : 'pending';
  });
  helpers.saveWorkState(tasksBase, TICKET, {
    ticketId: TICKET,
    currentStep: idx + 1,
    status: 'in_progress',
    stepStatus,
    checkProgress: {},
    errors: [],
  });
}

function makeDeps() {
  return {
    tp: { getProviderConfig: () => ({}), sanitizeTicketIdForPath: (id) => id },
    STEPS,
    ALL_STEPS,
    STEP_TRANSITIONS,
    workflowCanTransition,
    TDD_GATED_STEPS: [],
    readTddEvidence: () => null,
    validateTddEvidence: () => ({ valid: true }),
    validateCheckGate: () => ({ valid: true, reasons: [] }),
    archiveStepArtifacts,
    appendAction: () => {},
    loadWorkState: (t) => helpers.loadWorkState(tasksBase, t),
    saveWorkState: (t, s) => helpers.saveWorkState(tasksBase, t, s),
    getCurrentStep: (s) => helpers.getCurrentStep(s, STEPS, ALL_STEPS),
    TASKS_BASE: tasksBase,
    softSteps: new Set(ALL_STEPS), // the edge, not the gates, is under test
    commandMap: [],
    evidenceRequirements: workflow.evidenceRequirements,
    getHeadSha: () => null,
  };
}

/** Collect the plan actions steps/spec.js emits for a given inspect state. */
function specActions(s) {
  const actions = [];
  specStep(
    (step, action, tool, reason, opts) => actions.push({ step, action, tool, reason, opts }),
    s,
    {
      STEPS,
      t: TICKET,
      tasksDir: ticketDir,
      worktreeDir: '/tmp/wt',
      path,
      fileExists: fs.existsSync,
      getDocsPrompt: () => '',
    }
  );
  return actions;
}

beforeEach(() => {
  tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'check-spec-retry-'));
  ticketDir = path.join(tasksBase, TICKET);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, 'spec.md'), '# Spec\n\n## Test Scenarios (Gherkin)\n');
  workflow = createWorkflowDefinition({
    TASKS_BASE: tasksBase,
    safeTicketPath: (id) => id,
    resolveGitHead: () => '',
  }).workflow;
});

afterEach(() => fs.rmSync(tasksBase, { recursive: true, force: true }));

describe('check → spec retry (GH-247)', () => {
  it('the graph allows the edge the gherkin-scope gate tells agents to take', () => {
    assert.equal(workflowCanTransition(STEPS.check, STEPS.spec), true);
    assert.ok(STEP_TRANSITIONS[STEPS.check].includes(STEPS.spec));
  });

  it('still allows the original check → implement retry', () => {
    assert.equal(workflowCanTransition(STEPS.check, STEPS.implement), true);
  });

  it('invalidates spec.md so the retry cannot be answered by the rejected file', () => {
    seedState(STEPS.check);
    const result = transitionStep(TICKET, STEPS.spec, makeDeps());

    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.to, STEPS.spec);
    assert.ok(fs.existsSync(path.join(ticketDir, 'spec.md')), 'spec.md must not be moved');
    assert.equal(
      isEvidenceStale(ticketDir, STEPS.spec, helpers.loadWorkState(tasksBase, TICKET)),
      true,
      'the destination of a retry edge is the step being sent back to be redone'
    );
  });

  it('dispatches the spec writer to amend, instead of deferring', () => {
    const actions = specActions({ hasSpec: true, specPhaseMidFlight: false, specStale: true });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].action, 'RUN', 'a retried spec step must not DEFER');
    assert.equal(actions[0].opts.agentType, 'spec-writer');
    assert.match(actions[0].opts.agentPrompt, /amend/i);
    assert.match(actions[0].opts.agentPrompt, /gherkin_scope|Gherkin/i);
  });

  it('still defers when spec.md is present and nothing invalidated it', () => {
    const actions = specActions({ hasSpec: true, specPhaseMidFlight: false, specStale: false });
    assert.equal(actions[0].action, 'DEFER');
  });

  it('re-running the spec writer clears the block', async () => {
    seedState(STEPS.check);
    transitionStep(TICKET, STEPS.spec, makeDeps());

    await new Promise((r) => setTimeout(r, 10));
    fs.writeFileSync(
      path.join(ticketDir, 'spec.md'),
      '# Spec\n\n## Test Scenarios (Gherkin)\n@integration\nScenario: added\n'
    );

    assert.equal(
      isEvidenceStale(ticketDir, STEPS.spec, helpers.loadWorkState(tasksBase, TICKET)),
      false,
      'amending spec.md must clear the mark — otherwise the retry dead-ends'
    );
  });
});
