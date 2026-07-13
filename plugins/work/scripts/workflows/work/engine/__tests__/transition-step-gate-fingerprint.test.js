/**
 * Tests for workflows/work/engine/transition-step.js — GH-398 Task 7
 *
 * Verifies that transitioning a `*_gate` step to completed writes a
 * gateFingerprint to ws.gateFingerprints[<stepName>] containing the
 * current plugin version and an ISO8601 timestamp.
 *
 * Strategy: stub out the deps required by transitionStep (no real fs/git),
 * provide a minimal STEPS / ALL_STEPS / STEP_TRANSITIONS shaped to allow
 * brief_gate -> spec, capture the saved work state via the saveWorkState
 * stub, and assert the fingerprint structure.
 *
 * Run: node --test scripts/workflows/work/engine/__tests__/transition-step-gate-fingerprint.test.js
 */

'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { transitionStep } = require(path.join(__dirname, '..', 'transition-step'));
const { computeGateInputHashes, compareGateInputHashes } = require(
  path.join(__dirname, '..', '..', 'lib', 'gate-input-hashes')
);

function makeStepRegistry() {
  const STEPS = {
    brief: 'brief',
    brief_gate: 'brief_gate',
    spec: 'spec',
    spec_gate: 'spec_gate',
    tasks: 'tasks',
    tasks_gate: 'tasks_gate',
    implement: 'implement',
    check: 'check',
    pr: 'pr',
    complete: 'complete',
    ticket: 'ticket',
  };
  const ALL_STEPS = [
    STEPS.ticket,
    STEPS.brief,
    STEPS.brief_gate,
    STEPS.spec,
    STEPS.spec_gate,
    STEPS.tasks,
    STEPS.tasks_gate,
    STEPS.implement,
    STEPS.check,
    STEPS.pr,
    STEPS.complete,
  ];
  const STEP_TRANSITIONS = {
    brief_gate: [STEPS.spec],
    spec_gate: [STEPS.tasks],
    tasks_gate: [STEPS.implement],
    implement: [STEPS.check],
  };
  return { STEPS, ALL_STEPS, STEP_TRANSITIONS };
}

function makeDeps({ initialWs, savedRef, tasksBase }) {
  const { STEPS, ALL_STEPS, STEP_TRANSITIONS } = makeStepRegistry();
  return {
    tp: {
      sanitizeTicketIdForPath: (t) => t,
      getProviderConfig: () => ({}),
    },
    STEPS,
    ALL_STEPS,
    STEP_TRANSITIONS,
    workflowCanTransition: (from, to) => (STEP_TRANSITIONS[from] || []).includes(to),
    TDD_GATED_STEPS: [],
    readTddEvidence: () => ({ exists: true, parseError: false, evidence: {} }),
    validateTddEvidence: () => ({ valid: true }),
    validateCheckGate: () => ({ valid: true }),
    archiveStepArtifacts: () => null,
    appendAction: () => {},
    loadWorkState: () => initialWs,
    saveWorkState: (_t, ws) => {
      savedRef.ws = ws;
    },
    getCurrentStep: (ws) => ws.currentStep,
    TASKS_BASE: tasksBase || '/tmp/tasks-gate-fingerprint',
    softSteps: new Set(),
    commandMap: [],
    getHeadSha: () => null,
  };
}

function makeInitialWs(currentStep) {
  const { ALL_STEPS } = makeStepRegistry();
  const stepStatus = {};
  ALL_STEPS.forEach((s) => {
    stepStatus[s] = 'pending';
  });
  stepStatus[currentStep] = 'in_progress';
  return {
    ticketId: 'TEST-700',
    currentStep,
    stepStatus,
  };
}

describe('transition-step gateFingerprints (GH-398 Task 7)', () => {
  it('writes gateFingerprints[brief_gate] with pluginVersion + satisfiedAt on brief_gate -> spec', () => {
    const savedRef = { ws: null };
    const initialWs = makeInitialWs('brief_gate');
    const deps = makeDeps({ initialWs, savedRef });

    const before = Date.now();
    const result = transitionStep('TEST-700', 'spec', deps);
    const after = Date.now();

    assert.ok(result && result.success, `expected success, got ${JSON.stringify(result)}`);
    assert.ok(savedRef.ws, 'saveWorkState must be called');
    assert.ok(
      savedRef.ws.gateFingerprints && typeof savedRef.ws.gateFingerprints === 'object',
      'gateFingerprints object must be present'
    );
    const fp = savedRef.ws.gateFingerprints.brief_gate;
    assert.ok(fp, 'fingerprint for brief_gate must exist');
    // __dirname = plugins/work/scripts/workflows/work/engine/__tests__ → repo root is 7 levels up
    const pkg = require(
      path.join(__dirname, '..', '..', '..', '..', '..', '..', '..', 'package.json')
    );
    assert.equal(fp.pluginVersion, pkg.version, 'pluginVersion must equal package.json version');
    assert.match(
      fp.satisfiedAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      'satisfiedAt must be ISO8601'
    );
    const ts = Date.parse(fp.satisfiedAt);
    assert.ok(ts >= before && ts <= after, 'satisfiedAt must be recent');
  });

  it('preserves existing gateFingerprints and adds new entry on later gate transitions', () => {
    const savedRef = { ws: null };
    const initialWs = makeInitialWs('spec_gate');
    initialWs.gateFingerprints = {
      brief_gate: { pluginVersion: '0.0.1-test', satisfiedAt: '2020-01-01T00:00:00.000Z' },
    };
    const deps = makeDeps({ initialWs, savedRef });

    const result = transitionStep('TEST-700', 'tasks', deps);
    assert.ok(result && result.success);
    assert.ok(savedRef.ws.gateFingerprints.brief_gate, 'prior fingerprint must remain');
    assert.equal(
      savedRef.ws.gateFingerprints.brief_gate.pluginVersion,
      '0.0.1-test',
      'prior fingerprint must be untouched'
    );
    assert.ok(savedRef.ws.gateFingerprints.spec_gate, 'new fingerprint for spec_gate must exist');
  });

  it('does not write gateFingerprints when transitioning a non-gate step', () => {
    const savedRef = { ws: null };
    const initialWs = makeInitialWs('implement');
    const deps = makeDeps({ initialWs, savedRef });

    const result = transitionStep('TEST-700', 'check', deps);
    assert.ok(result && result.success);
    // No new fingerprint key should be added for non-gate sources.
    const fps = savedRef.ws.gateFingerprints || {};
    assert.equal(
      Object.keys(fps).length,
      0,
      `non-gate transition must not add fingerprints, got ${JSON.stringify(fps)}`
    );
  });
});

describe('gateFingerprint input content hashes (GH-419)', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fp-inputs-'));
  after(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  const sha256 = (content) => crypto.createHash('sha256').update(content).digest('hex');

  function writeTicketFiles(ticket, files) {
    const dir = path.join(tmpBase, ticket);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
  }

  it('records sha256 of spec.md + gherkin.feature on spec_gate -> tasks', () => {
    writeTicketFiles('TEST-710', {
      'spec.md': 'spec body\n',
      'gherkin.feature': 'Feature: x\n',
    });
    const savedRef = { ws: null };
    const initialWs = makeInitialWs('spec_gate');
    const deps = makeDeps({ initialWs, savedRef, tasksBase: tmpBase });

    const result = transitionStep('TEST-710', 'tasks', deps);
    assert.ok(result && result.success, `expected success, got ${JSON.stringify(result)}`);
    const fp = savedRef.ws.gateFingerprints.spec_gate;
    assert.ok(fp, 'fingerprint for spec_gate must exist');
    assert.deepEqual(fp.inputs, {
      'spec.md': sha256('spec body\n'),
      'gherkin.feature': sha256('Feature: x\n'),
    });
  });

  it('hashes missing input files as null without throwing (tasks_gate)', () => {
    writeTicketFiles('TEST-711', { 'tasks.md': '- [ ] task 1\n' });
    const savedRef = { ws: null };
    const initialWs = makeInitialWs('tasks_gate');
    const deps = makeDeps({ initialWs, savedRef, tasksBase: tmpBase });

    const result = transitionStep('TEST-711', 'implement', deps);
    assert.ok(result && result.success, `expected success, got ${JSON.stringify(result)}`);
    const fp = savedRef.ws.gateFingerprints.tasks_gate;
    assert.ok(fp, 'fingerprint for tasks_gate must exist');
    assert.deepEqual(fp.inputs, {
      'tasks.md': sha256('- [ ] task 1\n'),
      'gherkin.feature': null,
    });
  });

  it('records empty inputs for gates with no mapped input files (brief_gate)', () => {
    const savedRef = { ws: null };
    const initialWs = makeInitialWs('brief_gate');
    const deps = makeDeps({ initialWs, savedRef, tasksBase: tmpBase });

    const result = transitionStep('TEST-712', 'spec', deps);
    assert.ok(result && result.success);
    const fp = savedRef.ws.gateFingerprints.brief_gate;
    assert.ok(fp, 'fingerprint for brief_gate must exist');
    assert.deepEqual(fp.inputs, {}, 'unmapped gate must record empty inputs');
  });

  it('computeGateInputHashes returns null hashes when the tasks dir is missing', () => {
    const res = computeGateInputHashes('spec_gate', path.join(tmpBase, 'no-such-dir'));
    assert.deepEqual(res, { 'spec.md': null, 'gherkin.feature': null });
  });

  it('compareGateInputHashes reports match when hashes are identical', () => {
    const recorded = { 'spec.md': 'aaa', 'gherkin.feature': 'bbb' };
    const current = { 'spec.md': 'aaa', 'gherkin.feature': 'bbb' };
    assert.deepEqual(compareGateInputHashes(recorded, current), { match: true, drifted: [] });
  });

  it('compareGateInputHashes detects drift per file', () => {
    const recorded = { 'spec.md': 'aaa', 'gherkin.feature': 'bbb' };
    const current = { 'spec.md': 'aaa', 'gherkin.feature': 'CHANGED' };
    assert.deepEqual(compareGateInputHashes(recorded, current), {
      match: false,
      drifted: ['gherkin.feature'],
    });
  });

  it('compareGateInputHashes treats legacy fingerprints without inputs as non-match, no throw', () => {
    const current = { 'spec.md': 'aaa', 'gherkin.feature': 'bbb' };
    const res = compareGateInputHashes(undefined, current);
    assert.equal(res.match, false);
    assert.deepEqual(res.drifted, ['gherkin.feature', 'spec.md']);
  });
});
