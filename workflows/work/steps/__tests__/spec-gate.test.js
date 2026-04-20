/**
 * Unit tests for the spec-gate step module (GH-244, Task 4).
 *
 * Covers the six SKIP/RUN decision paths:
 *   1. WORK_SPEC_ENABLED=0 → SKIP
 *   2. !s.hasSpec → SKIP
 *   3. spec.md unreadable → RUN /spec
 *   4. gherkin-skip override → SKIP with reason
 *   5. Validation passes → SKIP with scenario count
 *   6. Validation fails → RUN with error messages
 *
 * Run: node --test workflows/work/steps/__tests__/spec-gate.test.js
 */

'use strict';

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { STEPS } = require('../../step-registry');

// ─── Test doubles matching brief-gate.test.js ────────────────────────────────

function makeCtx(overrides = {}) {
  return {
    STEPS,
    ticket: 'TEST-100',
    description: null,
    rework: false,
    safeName: 'TEST-100',
    worktreeDir: '/tmp/worktrees/my-project-TEST-100',
    tasksDir: '/tmp/tasks/TEST-100',
    t: 'TEST-100',
    path,
    fileExists: (p) => fs.existsSync(p),
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    worktreeExists: true,
    hasSpec: true,
    pr: null,
    ...overrides,
  };
}

function makeAdd() {
  const entries = [];
  const add = (step, action, command, reason, extra) => {
    entries.push({ step, action, command, reason, ...(extra || {}) });
  };
  return { add, entries };
}

// ─── Fixture helpers ────────────────────────────────────────────────────────

const SPEC_VALID_GHERKIN = [
  '# Spec',
  '',
  '## Test Scenarios (Gherkin)',
  '',
  'Feature: User login',
  '  @integration',
  '  Scenario: Successful login',
  '    Given a registered user',
  '    When they submit valid credentials',
  '    Then they are logged in',
  '',
  '  Scenario: Failed login',
  '    Given a registered user',
  '    When they submit invalid credentials',
  '    Then they see an error message',
  '',
].join('\n');

const SPEC_INVALID_GHERKIN = [
  '# Spec',
  '',
  '## Test Scenarios (Gherkin)',
  '',
  'Feature: Incomplete',
  '  Scenario: Only one scenario',
  '    Given something',
  '    When action',
  '    Then result',
  '',
].join('\n');

const SPEC_MALFORMED_GHERKIN = [
  '# Spec',
  '',
  '## Test Scenarios (Gherkin)',
  '',
  'Some free text without any Feature or Scenario keywords.',
  'This should trigger parse errors (no features found).',
  '',
].join('\n');

const SPEC_WITH_SKIP_OVERRIDE = [
  '# Spec',
  '',
  '<!-- gherkin-skip: legacy migration, no testable behavior -->',
  '',
  '## Test Scenarios (Gherkin)',
  '',
  'Some free text without proper gherkin.',
  '',
].join('\n');

function makeTmpTasksDir(specContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-gate-test-'));
  if (specContent !== null) {
    fs.writeFileSync(path.join(dir, 'spec.md'), specContent, 'utf8');
  }
  return dir;
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_e) {
    /* ignore */
  }
}

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('spec-gate step', () => {
  let specGateStep;
  const createdDirs = [];
  const originalEnv = process.env.WORK_SPEC_ENABLED;

  before(() => {
    const mod = require(path.join(__dirname, '..', 'spec-gate.js'));
    specGateStep = typeof mod === 'function' ? mod : mod.specGateStep;
  });

  beforeEach(() => {
    delete process.env.WORK_SPEC_ENABLED;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WORK_SPEC_ENABLED;
    else process.env.WORK_SPEC_ENABLED = originalEnv;
    while (createdDirs.length) rmrf(createdDirs.pop());
  });

  it('exports a function', () => {
    assert.equal(typeof specGateStep, 'function');
  });

  // Case 1: WORK_SPEC_ENABLED=0
  it('SKIPs when WORK_SPEC_ENABLED=0', () => {
    process.env.WORK_SPEC_ENABLED = '0';
    const { add, entries } = makeAdd();
    specGateStep(add, makeState(), makeCtx());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.spec_gate);
    assert.equal(entries[0].action, 'SKIP');
    assert.match(entries[0].reason, /disabled/i);
  });

  // Case 2: No spec.md present
  it('SKIPs when !s.hasSpec', () => {
    const { add, entries } = makeAdd();
    specGateStep(add, makeState({ hasSpec: false }), makeCtx());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.spec_gate);
    assert.equal(entries[0].action, 'SKIP');
    assert.match(entries[0].reason, /no spec/i);
  });

  // Case 3: spec.md unreadable
  it('RUNs when spec.md is unreadable', () => {
    const dir = makeTmpTasksDir(null); // no spec.md file
    createdDirs.push(dir);
    const { add, entries } = makeAdd();
    specGateStep(add, makeState({ hasSpec: true }), makeCtx({ tasksDir: dir }));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.spec_gate);
    assert.equal(entries[0].action, 'RUN');
    assert.equal(entries[0].command, '/spec');
    assert.match(entries[0].reason, /unreadable|regenerate/i);
    assert.equal(entries[0].agentType, 'skill');
    assert.equal(entries[0].agentPrompt, '/spec');
  });

  // Case 4: gherkin-skip override
  it('SKIPs with reason when skip override is present', () => {
    const dir = makeTmpTasksDir(SPEC_WITH_SKIP_OVERRIDE);
    createdDirs.push(dir);
    const { add, entries } = makeAdd();
    specGateStep(add, makeState(), makeCtx({ tasksDir: dir }));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.spec_gate);
    assert.equal(entries[0].action, 'SKIP');
    assert.match(entries[0].reason, /skip override/i);
    assert.match(entries[0].reason, /legacy migration/i);
  });

  // Case 5: Validation passes
  it('SKIPs with scenario count when validation passes', () => {
    const dir = makeTmpTasksDir(SPEC_VALID_GHERKIN);
    createdDirs.push(dir);
    const { add, entries } = makeAdd();
    specGateStep(add, makeState(), makeCtx({ tasksDir: dir }));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.spec_gate);
    assert.equal(entries[0].action, 'SKIP');
    assert.match(entries[0].reason, /passed/i);
    assert.match(entries[0].reason, /2 scenarios/);
    assert.match(entries[0].reason, /1 @integration/);
    assert.match(entries[0].reason, /0 @e2e/);
  });

  // Case 6a: Validation fails (valid parse but thresholds not met)
  it('RUNs with error messages when validation fails', () => {
    const dir = makeTmpTasksDir(SPEC_INVALID_GHERKIN);
    createdDirs.push(dir);
    const { add, entries } = makeAdd();
    specGateStep(add, makeState(), makeCtx({ tasksDir: dir }));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.spec_gate);
    assert.equal(entries[0].action, 'RUN');
    assert.equal(entries[0].command, '/spec');
    assert.match(entries[0].reason, /need at least 2|No @integration or @e2e/i);
    assert.equal(entries[0].agentType, 'skill');
    assert.equal(entries[0].agentPrompt, '/spec');
  });

  // Case 6b: Parse errors (malformed gherkin with no features)
  it('RUNs with parse errors when Gherkin is malformed', () => {
    const dir = makeTmpTasksDir(SPEC_MALFORMED_GHERKIN);
    createdDirs.push(dir);
    const { add, entries } = makeAdd();
    specGateStep(add, makeState(), makeCtx({ tasksDir: dir }));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.spec_gate);
    assert.equal(entries[0].action, 'RUN');
    assert.equal(entries[0].command, '/spec');
    // Should include parse-level error about no features/structure found
    assert.match(entries[0].reason, /No Feature\/Scenario structure found/i);
    assert.equal(entries[0].agentType, 'skill');
    assert.equal(entries[0].agentPrompt, '/spec');
  });
});
