/**
 * Unit tests for the bootstrap step module.
 *
 * Run: node --test workflows/work/steps/__tests__/bootstrap.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { STEPS } = require('../../step-registry');

const BOOTSTRAP_PATH = path.join(__dirname, '..', 'bootstrap.js');

/**
 * Run the bootstrap step in a fresh child process so the once-per-invocation
 * guard / cross-process marker in config-validate starts clean and any stderr
 * write from runStartupValidation is captured in isolation.
 */
function runBootstrapInChild(extraEnv = {}) {
  const driver = `
    const path = ${JSON.stringify(BOOTSTRAP_PATH)};
    const bootstrapStep = require(path);
    const { STEPS } = require(${JSON.stringify(
      path.join(__dirname, '..', '..', 'step-registry'),
    )});
    const add = () => {};
    bootstrapStep(add, { worktreeExists: true, pr: { number: 42 } }, {
      STEPS, ticket: 'TEST-100', t: 'TEST-100',
    });
  `;
  // Build a minimal, deterministic env so the child's validation result is
  // governed only by `extraEnv` — not by whatever WORK_*/ENABLE_*/TICKET_* or
  // schema keys happen to live in the test runner's ambient environment.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  // Ensure the once-guard marker is unset for the child invocation.
  delete env.__WORK_CONFIG_VALIDATED;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, ['-e', driver], {
    env,
    encoding: 'utf8',
  });
}

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
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    worktreeExists: false,
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

describe('bootstrap step', () => {
  let bootstrapStep;
  before(() => {
    bootstrapStep = require(path.join(__dirname, '..', 'bootstrap.js'));
  });

  it('exports a function', () => {
    assert.equal(typeof bootstrapStep, 'function');
  });

  it('DEFERs when worktree + PR both exist', () => {
    const { add, entries } = makeAdd();
    const s = makeState({ worktreeExists: true, pr: { number: 42 } });
    bootstrapStep(add, s, makeCtx());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.bootstrap);
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason, /PR #42/);
  });

  it('RUNs with ticket name when worktree exists but PR missing', () => {
    const { add, entries } = makeAdd();
    const s = makeState({ worktreeExists: true, pr: null });
    bootstrapStep(add, s, makeCtx());
    assert.equal(entries[0].action, 'RUN');
    assert.match(entries[0].command, /\/bootstrap TEST-100/);
    assert.equal(entries[0].reason, 'Worktree exists but no PR');
    assert.equal(entries[0].agentType, 'skill');
    assert.match(entries[0].agentPrompt, /\/bootstrap TEST-100/);
  });

  it('RUNs with placeholder when no worktree exists', () => {
    const { add, entries } = makeAdd();
    const s = makeState({ worktreeExists: false });
    const ctx = makeCtx({ ticket: null, t: '{TICKET}', description: 'add login' });
    bootstrapStep(add, s, ctx);
    assert.equal(entries[0].action, 'RUN');
    assert.match(entries[0].command, /\/bootstrap \{TICKET\}/);
    assert.equal(entries[0].reason, 'No worktree found');
  });

  it('handles null state defensively (no worktree path)', () => {
    const { add, entries } = makeAdd();
    bootstrapStep(add, null, makeCtx());
    assert.equal(entries[0].action, 'RUN');
    assert.equal(entries[0].reason, 'No worktree found');
  });
});

describe('bootstrap step — startup config validation (R11)', () => {
  it('surfaces a config-validation warning on stderr for a typo\'d known key', () => {
    // ENABEL_SYMLINK is a distance-2 typo of the known key ENABLE_SYMLINK.
    const result = runBootstrapInChild({ ENABEL_SYMLINK: '1' });
    assert.equal(result.status, 0, 'bootstrap step must not block / exit non-zero');
    assert.match(
      result.stderr,
      /config validation/i,
      'expected runStartupValidation to write a warning block to stderr',
    );
    assert.match(
      result.stderr,
      /ENABEL_SYMLINK/,
      'warning block should name the typo\'d key',
    );
  });

  it('writes zero config-validation warnings for a clean environment', () => {
    const result = runBootstrapInChild();
    assert.equal(result.status, 0, 'bootstrap step must not block / exit non-zero');
    assert.doesNotMatch(
      result.stderr,
      /config validation/i,
      'a correctly-configured env must produce no config-validation warning',
    );
  });
});
