/**
 * The document step's transition gate.
 *
 * `verifyDocument` is what makes the step non-auto-advancing: it is registered
 * in commandMap and `document` is deliberately absent from `softSteps`, so
 * stepVerifyGate runs it on every forward transition out of the step.
 *
 * These tests pin the two halves that matter: the gate agrees with the CLI the
 * agent runs (same evaluation, so the step cannot self-check green and then be
 * refused), and it fails CLOSED on every unknown.
 *
 * Run: node --test scripts/workflows/work/workflow-def/__tests__/document-verifier.integration.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDeliveryVerifiers } = require('../delivery-verifiers');
const { STEPS } = require('../../step-registry');
const { appendNote, SINKS } = require('../../../work-document/lib/notes-store');

const TICKET = 'GH-800';
const REPO = 'demo';
const GOOD_SUMMARY =
  'Reworked the cache key to include the shard index; the old key collided across ' +
  'shards and the failure only showed up under parallel CI, never locally.';

let root;
let tasksBase;
let tasksDir;
let worktree;
let origEnv;

function makeVerifiers(tasksBaseOverride) {
  return createDeliveryVerifiers({
    TASKS_BASE: tasksBaseOverride === undefined ? tasksBase : tasksBaseOverride,
    safeTicketPath: (id) => id,
    workRoot: path.join(__dirname, '..', '..'),
    STEPS,
    evidenceRequirements: {},
    verifyPerTaskTDD: () => true,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'document-verifier-'));
  tasksBase = path.join(root, 'tasks');
  tasksDir = path.join(tasksBase, TICKET);
  worktree = path.join(root, 'worktrees', `${REPO}-${TICKET}`);
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  // Private HOME with no memory plugin installed → the docs sink is required.
  origEnv = {
    HOME: process.env.HOME,
    WORKTREES_BASE: process.env.WORKTREES_BASE,
    REPO_NAME: process.env.REPO_NAME,
  };
  fs.mkdirSync(path.join(root, 'home', '.claude', 'plugins', 'cache'), { recursive: true });
  process.env.HOME = path.join(root, 'home');
  process.env.WORKTREES_BASE = path.join(root, 'worktrees');
  process.env.REPO_NAME = REPO;
});

afterEach(() => {
  for (const [k, v] of Object.entries(origEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function writeDocNote() {
  const file = path.join(worktree, 'docs', 'work-notes', `${TICKET}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# ${TICKET}\n\n${GOOD_SUMMARY}\n${'detail. '.repeat(30)}`);
  return file;
}

describe('verifyDocument', () => {
  it('is false when nothing has been recorded', () => {
    assert.equal(makeVerifiers().verifyDocument(TICKET), false);
  });

  it('is true once a real note is recorded', () => {
    const file = writeDocNote();
    appendNote(tasksDir, TICKET, { sink: SINKS.docs, path: file, summary: GOOD_SUMMARY });
    assert.equal(makeVerifiers().verifyDocument(TICKET), true);
  });

  it('goes back to false when the recorded note is deleted', () => {
    const file = writeDocNote();
    appendNote(tasksDir, TICKET, { sink: SINKS.docs, path: file, summary: GOOD_SUMMARY });
    fs.rmSync(file);
    assert.equal(makeVerifiers().verifyDocument(TICKET), false);
  });

  it('is false for a placeholder summary, however long', () => {
    const file = writeDocNote();
    appendNote(tasksDir, TICKET, { sink: SINKS.docs, path: file, summary: '-'.repeat(200) });
    assert.equal(makeVerifiers().verifyDocument(TICKET), false);
  });

  it('fails closed on a corrupt receipt', () => {
    fs.writeFileSync(path.join(tasksDir, '.document-notes.json'), '{not json');
    assert.equal(makeVerifiers().verifyDocument(TICKET), false);
  });

  it('fails closed when the tasks dir cannot be resolved', () => {
    // Unlike cleanup — which runs post-merge and must not strand a shipped
    // ticket — document runs BEFORE the merge, so refusing costs only a re-run.
    const throwing = createDeliveryVerifiers({
      TASKS_BASE: tasksBase,
      safeTicketPath: () => {
        throw new Error('TASKS_BASE unset');
      },
      workRoot: path.join(__dirname, '..', '..'),
      STEPS,
      evidenceRequirements: {},
      verifyPerTaskTDD: () => true,
    });
    assert.equal(throwing.verifyDocument(TICKET), false);
  });
});

describe('document is wired as a hard gate', () => {
  const buildWorkflow = require('../../workflow-definition');

  it('is not a soft step, and carries a verify', () => {
    const { workflow } = buildWorkflow({
      TASKS_BASE: tasksBase,
      safeTicketPath: (id) => id,
      resolveGitHead: () => '',
    });
    assert.equal(workflow.softSteps.has(STEPS.document), false, 'soft steps skip stepVerifyGate');
    const entry = workflow.commandMap.find(
      (c) => c.step === STEPS.document && typeof c.verify === 'function'
    );
    assert.ok(entry, 'document must register a verify or the gate never runs');
  });

  it('sits between ready and follow_up, with no edge that skips it', () => {
    const { STEP_ORDER, STEP_TRANSITIONS } = require('../../step-registry');
    const order = [...STEP_ORDER];
    assert.equal(order[order.indexOf(STEPS.document) - 1], STEPS.ready);
    assert.equal(order[order.indexOf(STEPS.document) + 1], STEPS.follow_up);
    assert.ok(!STEP_TRANSITIONS[STEPS.ready].includes(STEPS.follow_up));
    // Only steps BEFORE document could skip the gate by reaching follow_up.
    // Later steps reaching back to follow_up (ci's un-mergeable rollback) are
    // retry edges on a run that already passed the gate.
    const documentIdx = order.indexOf(STEPS.document);
    for (const [from, targets] of Object.entries(STEP_TRANSITIONS)) {
      if (order.indexOf(from) >= documentIdx) continue;
      assert.ok(
        !targets.includes(STEPS.follow_up),
        `${from} → follow_up would step over the document gate`
      );
    }
  });

  it('reports now runs after ci and before cleanup', () => {
    const { STEP_ORDER } = require('../../step-registry');
    const order = [...STEP_ORDER];
    assert.ok(order.indexOf(STEPS.ci) < order.indexOf(STEPS.reports));
    assert.ok(order.indexOf(STEPS.reports) < order.indexOf(STEPS.cleanup));
  });
});
