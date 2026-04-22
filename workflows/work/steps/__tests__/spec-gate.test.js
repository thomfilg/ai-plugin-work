/**
 * Unit tests for the spec-gate step module (GH-244, Task 4).
 *
 * Covers the five DEFER/RUN decision paths:
 *   1. !s.hasSpec → DEFER
 *   2. spec.md unreadable → RUN /spec
 *   3. gherkin-skip override → DEFER with reason
 *   4. Validation passes → DEFER with scenario count
 *   5. Validation fails → RUN with error messages
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

  before(() => {
    const mod = require(path.join(__dirname, '..', 'spec-gate.js'));
    specGateStep = typeof mod === 'function' ? mod : mod.specGateStep;
  });

  afterEach(() => {
    while (createdDirs.length) rmrf(createdDirs.pop());
  });

  it('exports a function', () => {
    assert.equal(typeof specGateStep, 'function');
  });

  // GH-253 Task 4: WORK_SPEC_ENABLED toggle removed — spec-gate no longer
  // checks process.env.WORK_SPEC_ENABLED.
  it('does not reference WORK_SPEC_ENABLED in source code', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'spec-gate.js'), 'utf8');
    assert.ok(
      !src.includes('WORK_SPEC_ENABLED'),
      'spec-gate.js must not contain WORK_SPEC_ENABLED'
    );
  });

  it('ignores WORK_SPEC_ENABLED=0 and still evaluates spec.md normally', () => {
    const prev = process.env.WORK_SPEC_ENABLED;
    process.env.WORK_SPEC_ENABLED = '0';
    try {
      const { add, entries } = makeAdd();
      // hasSpec=false should DEFER with "No spec.md present", NOT "disabled"
      specGateStep(add, makeState({ hasSpec: false }), makeCtx());
      assert.equal(entries.length, 1);
      assert.equal(entries[0].step, STEPS.spec_gate);
      assert.equal(entries[0].action, 'DEFER');
      assert.match(entries[0].reason, /no spec/i);
    } finally {
      if (prev === undefined) delete process.env.WORK_SPEC_ENABLED;
      else process.env.WORK_SPEC_ENABLED = prev;
    }
  });

  // Case 1: No spec.md present
  it('DEFERs when !s.hasSpec', () => {
    const { add, entries } = makeAdd();
    specGateStep(add, makeState({ hasSpec: false }), makeCtx());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.spec_gate);
    assert.equal(entries[0].action, 'DEFER');
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
  it('DEFERs with reason when skip override is present', () => {
    const dir = makeTmpTasksDir(SPEC_WITH_SKIP_OVERRIDE);
    createdDirs.push(dir);
    const { add, entries } = makeAdd();
    specGateStep(add, makeState(), makeCtx({ tasksDir: dir }));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.spec_gate);
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason, /skip override/i);
    assert.match(entries[0].reason, /legacy migration/i);
  });

  // Case 5: Validation passes
  it('DEFERs with scenario count when validation passes', () => {
    const dir = makeTmpTasksDir(SPEC_VALID_GHERKIN);
    createdDirs.push(dir);
    const { add, entries } = makeAdd();
    specGateStep(add, makeState(), makeCtx({ tasksDir: dir }));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.spec_gate);
    assert.equal(entries[0].action, 'DEFER');
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
