/**
 * check-archival-evidence.test.js — echo-6842
 *
 * The `check` step's archival pattern and its own evidence requirement used
 * to cover the SAME files: `archivalPatterns[check]` was `/^.*\.check\.md$/`
 * and `evidenceRequirements[check].requiredFiles` names three `*.check.md`
 * reports. Every archival of the check step therefore moved the evidence
 * `verifyCheck` + `validateCheckGate` read, and the gate reported
 * "Missing report: tests.check.md" for files sitting in `runs/runN/`.
 *
 * The check-drift gate made that reachable from a FORWARD transition: it
 * archives the artifacts of the step it redirects TO, which no other
 * archival path does (`resetIntermediateSteps` only archives steps left
 * BEHIND the destination). One false drift signal was enough to strand a
 * ticket, and `protect-orchestrator-state.js` correctly refuses hand
 * restores, so there was no way back.
 *
 * These tests drive the REAL engine (real archiveStepArtifacts, real
 * validateCheckGate, real workflow-definition commandMap) against a real
 * temp TASKS_BASE.
 *
 * Uses node:test + node:assert/strict.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORK_ROOT = path.join(__dirname, '..');

const registry = require(path.join(WORK_ROOT, 'step-registry'));
const helpers = require(path.join(WORK_ROOT, 'lib', 'work-helpers'));
const { archiveStepArtifacts } = require(path.join(WORK_ROOT, 'lib', 'artifact-archival'));
const checkGateMod = require(path.join(WORK_ROOT, 'gates', 'check-gate'));
const { transitionStep } = require(path.join(WORK_ROOT, 'engine', 'transition-step'));
const createWorkflowDefinition = require(path.join(WORK_ROOT, 'workflow-definition'));

const { STEPS, ALL_STEPS, STEP_TRANSITIONS, workflowCanTransition } = registry;

const OLD_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);
const TICKET = 'ECHO-6842';

const CHECK_REPORTS = {
  'tests.check.md': '# Tests\n\n**Status:** APPROVED\n',
  'code-review.check.md': '# Code review\n\n**Status:** APPROVED\n',
  'completion.check.md': '# Completion\n\n**Status:** COMPLETE\n',
  'qa-feature-tester.check.md': '# QA\n\n**Status:** APPROVED\n',
};

// ─── Harness ────────────────────────────────────────────────────────────────

let tasksBase;
let ticketDir;
let workflow;
let headSha;

function writeCheckReports(marker) {
  for (const [file, body] of Object.entries(CHECK_REPORTS)) {
    fs.writeFileSync(path.join(ticketDir, file), marker ? `${body}\n<!-- ${marker} -->\n` : body);
  }
}

function setup() {
  tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'work-test-check-archival-'));
  ticketDir = path.join(tasksBase, TICKET);
  fs.mkdirSync(ticketDir, { recursive: true });
  writeCheckReports();
  fs.writeFileSync(path.join(ticketDir, 'README.md'), `# ${TICKET}\n`);
  headSha = OLD_SHA;
  workflow = createWorkflowDefinition({
    TASKS_BASE: tasksBase,
    safeTicketPath: (id) => id,
    resolveGitHead: () => headSha,
  }).workflow;
}

function teardown() {
  if (tasksBase) fs.rmSync(tasksBase, { recursive: true, force: true });
}

/** Seed work state with `currentStep` in progress and everything before it done. */
function seedState(currentStep, extra = {}) {
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
    checkPassedSha: OLD_SHA,
    ...extra,
  });
}

/** Transition deps wired the way orchestrator-context.js wires them. */
function makeDeps() {
  return {
    tp: {
      getProviderConfig: () => ({ provider: 'github' }),
      sanitizeTicketIdForPath: (id) => id,
    },
    STEPS,
    ALL_STEPS,
    STEP_TRANSITIONS,
    workflowCanTransition,
    TDD_GATED_STEPS: [],
    readTddEvidence: () => null,
    validateTddEvidence: () => ({ valid: true }),
    validateCheckGate: (ticket) => checkGateMod.validateCheckGate(tasksBase, ticket),
    archiveStepArtifacts,
    appendAction: () => {},
    loadWorkState: (ticket) => helpers.loadWorkState(tasksBase, ticket),
    saveWorkState: (ticket, state) => helpers.saveWorkState(tasksBase, ticket, state),
    getCurrentStep: (state) => helpers.getCurrentStep(state, STEPS, ALL_STEPS),
    TASKS_BASE: tasksBase,
    softSteps: workflow.softSteps,
    commandMap: workflow.commandMap,
    evidenceRequirements: workflow.evidenceRequirements,
    getHeadSha: () => headSha,
  };
}

function reportsAtTopLevel() {
  return Object.keys(CHECK_REPORTS).filter((f) => fs.existsSync(path.join(ticketDir, f)));
}

// ─── The deadlock ───────────────────────────────────────────────────────────

describe('check archival vs check evidence (echo-6842)', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it('drift redirect leaves the check evidence where the gate reads it', () => {
    seedState(STEPS.pr);
    headSha = NEW_SHA; // HEAD moved since check passed → drift gate fires

    const result = transitionStep(TICKET, STEPS.ready, makeDeps());

    assert.equal(result.gate, 'check-drift', JSON.stringify(result));
    assert.equal(result.to, STEPS.check, 'drift must redirect back to check');

    assert.deepEqual(
      reportsAtTopLevel().sort(),
      Object.keys(CHECK_REPORTS).sort(),
      'the redirect must not move the evidence the check gate reads'
    );

    // The failure signature from the real run: the gate claiming files are
    // missing while they sit one directory away in runs/runN/.
    const gate = checkGateMod.validateCheckGate(tasksBase, TICKET);
    assert.equal(
      gate.reasons.some((r) => /^Missing report:/.test(r)),
      false,
      `gate must not report present reports as missing: ${JSON.stringify(gate.reasons)}`
    );
  });

  it('drift redirect still forces a re-run — stale evidence cannot re-open the gate', () => {
    seedState(STEPS.pr);
    headSha = NEW_SHA;
    transitionStep(TICKET, STEPS.ready, makeDeps());

    // Archival's intent: a looped-back workflow must not satisfy the check
    // gate with reports that reviewed older code.
    const stale = checkGateMod.validateCheckGate(tasksBase, TICKET);
    assert.equal(stale.valid, false, 'untouched reports must not re-satisfy the gate');

    const blocked = transitionStep(TICKET, STEPS.pr, makeDeps());
    assert.equal(blocked.error, true, JSON.stringify(blocked));
    assert.equal(blocked.gate, 'check-to-pr');
  });

  it('re-running check clears the block without anything having been restored', async () => {
    seedState(STEPS.pr);
    headSha = NEW_SHA;
    transitionStep(TICKET, STEPS.ready, makeDeps());

    await new Promise((resolve) => setTimeout(resolve, 10));
    writeCheckReports('re-run at NEW_SHA'); // what /check does on re-dispatch

    const fresh = checkGateMod.validateCheckGate(tasksBase, TICKET);
    assert.equal(fresh.valid, true, JSON.stringify(fresh.reasons));

    const result = transitionStep(TICKET, STEPS.pr, makeDeps());
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.to, STEPS.pr);
    assert.equal(helpers.loadWorkState(tasksBase, TICKET).checkPassedSha, NEW_SHA);
  });

  it('a genuine loop-back (check → implement) keeps the reports and still forces a re-run', () => {
    seedState(STEPS.check);

    const result = transitionStep(TICKET, STEPS.implement, makeDeps());
    assert.equal(result.to, STEPS.implement, JSON.stringify(result));

    assert.deepEqual(
      reportsAtTopLevel().sort(),
      Object.keys(CHECK_REPORTS).sort(),
      'loop-back must not move the evidence either'
    );
    assert.equal(
      checkGateMod.validateCheckGate(tasksBase, TICKET).valid,
      false,
      'reports that reviewed pre-loop-back code must not re-satisfy the gate'
    );
  });

  it('the check verifier agrees with the check gate about invalidated evidence', () => {
    const verifyCheck = workflow.commandMap.find((c) => c.step === STEPS.check).verify;
    assert.equal(verifyCheck(TICKET), true, 'baseline: complete evidence verifies');

    seedState(STEPS.pr);
    headSha = NEW_SHA;
    transitionStep(TICKET, STEPS.ready, makeDeps());

    assert.equal(verifyCheck(TICKET), false, 'invalidated evidence must not verify');
  });
});

// ─── The audit trail GH-130 asked for, without the destruction ──────────────

describe('archiveStepArtifacts preserves gate evidence instead of moving it', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it('copies the check step evidence into runs/runN and leaves the originals', () => {
    fs.writeFileSync(path.join(ticketDir, 'dev-quality.check.md'), '# scratch\n');

    assert.equal(archiveStepArtifacts(ticketDir, [STEPS.check]), 'runs/run1');

    const runDir = path.join(ticketDir, 'runs', 'run1');
    for (const file of Object.keys(CHECK_REPORTS)) {
      assert.ok(fs.existsSync(path.join(runDir, file)), `${file} preserved under runs/run1`);
      assert.ok(fs.existsSync(path.join(ticketDir, file)), `${file} still readable in place`);
    }
    // Non-evidence reports are still moved — nothing reads them.
    assert.ok(fs.existsSync(path.join(runDir, 'dev-quality.check.md')));
    assert.ok(!fs.existsSync(path.join(ticketDir, 'dev-quality.check.md')));
  });

  it('creates a run dir even when only evidence matched', () => {
    assert.equal(archiveStepArtifacts(ticketDir, [STEPS.check]), 'runs/run1');
    assert.equal(archiveStepArtifacts(ticketDir, [STEPS.check]), 'runs/run2');
  });
});

// ─── Fail-open contract ─────────────────────────────────────────────────────
//
// Nothing in the staleness bookkeeping may become a new reason a ticket
// cannot move — that is the failure mode it was written to remove.

describe('evidence-staleness fails open', () => {
  const { markEvidenceStale, isEvidenceStale, clearEvidenceStale } = require(
    path.join(WORK_ROOT, 'lib', 'evidence-staleness')
  );

  beforeEach(() => setup());
  afterEach(() => teardown());

  it('records nothing when the step declares no files it rewrites', () => {
    const ws = {};
    assert.equal(markEvidenceStale(ws, STEPS.check, ticketDir, undefined, 'x'), false);
    assert.equal(markEvidenceStale(ws, STEPS.check, ticketDir, [], 'x'), false);
    assert.equal(isEvidenceStale(ticketDir, STEPS.check, ws), false);
  });

  it('reads not-stale when no state file exists', () => {
    assert.equal(isEvidenceStale(ticketDir, STEPS.check), false);
  });

  it('clears once a single tracked report is rewritten', async () => {
    const ws = {};
    const files = ['tests.check.md', 'code-review.check.md', 'completion.check.md'];
    assert.equal(markEvidenceStale(ws, STEPS.check, ticketDir, files, 'step reset'), true);
    assert.equal(isEvidenceStale(ticketDir, STEPS.check, ws), true);

    await new Promise((resolve) => setTimeout(resolve, 10));
    fs.writeFileSync(path.join(ticketDir, 'tests.check.md'), CHECK_REPORTS['tests.check.md']);
    assert.equal(
      isEvidenceStale(ticketDir, STEPS.check, ws),
      false,
      'one rewrite is enough — requiring all three would dead-end on an identical re-approval'
    );

    clearEvidenceStale(ws, STEPS.check);
    assert.equal(isEvidenceStale(ticketDir, STEPS.check, ws), false);
  });
});
