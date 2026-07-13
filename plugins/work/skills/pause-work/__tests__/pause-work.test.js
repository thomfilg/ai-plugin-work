/**
 * Tests for pause-work.js — the scriptable helper behind the `/pause-work`
 * skill (GH-315, Task 6).
 *
 * pause-work.js exposes:
 *  - buildPauseCommitMessage({ step, taskN, taskM }) -> string — the WIP commit
 *    header `chore(work): pause at <step> (task N/M) (#315)`, using an ALLOWED
 *    commit type (`chore`) and carrying the `(#315)` ticket ref so the shared
 *    commit-message validator accepts it;
 *  - an author-and-validate guard (assertHandoffValid / pauseWork) that calls
 *    validateHandoffSections and REFUSES to proceed when a required section is
 *    missing, before any commit is attempted;
 *  - resolveStepAndProgress(ticketId) -> { step, taskN, taskM } reading
 *    `.work-state.json` (step) + `tasks.md` progress (N/M) — a pure resolver.
 *
 * The actual commit is delegated to commit-and-push.js (the only sanctioned
 * commit path); this suite asserts the MESSAGE SHAPE is accepted by the shared
 * rules, not that a real git commit runs.
 *
 * node:test + node:assert/strict; isolated TASKS_BASE via fs.mkdtempSync.
 * The three required handoff sections are:
 *   ## Decisions made (and why)
 *   ## Blockers / warnings
 *   ## What was in flight
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'pause-work.js');
const COMMIT_RULES_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'scripts',
  'workflows',
  'work',
  'hooks',
  'commit-msg-rules.js'
);
const CONTEXT_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'scripts',
  'workflows',
  'lib',
  'hooks',
  'session-guard',
  'context.js'
);
const HANDOFF_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'scripts',
  'workflows',
  'lib',
  'handoff.js'
);

// github provider context so the (#315) ticket ref satisfies the id rule.
const GITHUB_CTX = { providerConfig: { provider: 'github' } };

let TASKS_BASE;
let prevTasksBase;
let prevWorktreesBase;

/**
 * Load pause-work.js fresh each test so it observes the temp TASKS_BASE.
 *
 * Drops the require cache for pause-work.js AND its context.js/handoff.js
 * dependencies (context.js caches TASKS_BASE via getConfig, so it must be
 * reloaded too).
 *
 * While pause-work.js does not yet exist (RED phase), a raw `require` of a
 * missing module would emit a top-level module-resolution error that the RED
 * validator treats as a structural load failure rather than a behavior gap.
 * We convert that specific "module absent" case into a clean assertion failure
 * so the suite loads, collects its tests, and each test fails on a real
 * expectation — exactly the RED signal the gate wants.
 */
function loadModuleFresh() {
  let resolved;
  try {
    resolved = require.resolve(MODULE_PATH);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      assert.fail('pause-work.js is not implemented yet (expected once GREEN lands)');
    }
    throw err;
  }
  delete require.cache[resolved];
  for (const dep of [CONTEXT_PATH, HANDOFF_PATH]) {
    try {
      delete require.cache[require.resolve(dep)];
    } catch {
      /* dependency resolves once pause-work.js requires it */
    }
  }
  return require(resolved);
}

/** A handoff body with all three required sections filled in. */
function validHandoff() {
  return [
    '# Continue Here — GH-315',
    '',
    '## Decisions made (and why)',
    'Chose chore(work) so the commit type stays in the allowed set.',
    '',
    '## Blockers / warnings',
    'None; Task 2 helpers are already in place.',
    '',
    '## What was in flight',
    'Writing the pause-work.js RED tests.',
    '',
  ].join('\n');
}

/** A skeleton missing the `## What was in flight` section. */
function skeletonMissingInFlight() {
  return [
    '# Continue Here — GH-315',
    '',
    '## Decisions made (and why)',
    'Placeholder.',
    '',
    '## Blockers / warnings',
    'Placeholder.',
    '',
  ].join('\n');
}

/** Seed a ticket dir with a .work-state.json + tasks.md for resolver tests. */
function seedTicket(ticketId, { currentStep, tasksMd } = {}) {
  const dir = path.join(TASKS_BASE, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  if (currentStep !== undefined) {
    fs.writeFileSync(path.join(dir, '.work-state.json'), JSON.stringify({ currentStep }), 'utf-8');
  }
  if (tasksMd !== undefined) {
    fs.writeFileSync(path.join(dir, 'tasks.md'), tasksMd, 'utf-8');
  }
  return dir;
}

beforeEach(() => {
  TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-work-'));
  prevTasksBase = process.env.TASKS_BASE;
  prevWorktreesBase = process.env.WORKTREES_BASE;
  process.env.TASKS_BASE = TASKS_BASE;
  process.env.WORKTREES_BASE = TASKS_BASE;
});

afterEach(() => {
  if (prevTasksBase === undefined) delete process.env.TASKS_BASE;
  else process.env.TASKS_BASE = prevTasksBase;
  if (prevWorktreesBase === undefined) delete process.env.WORKTREES_BASE;
  else process.env.WORKTREES_BASE = prevWorktreesBase;
  fs.rmSync(TASKS_BASE, { recursive: true, force: true });
});

describe('pause-work.js → module surface', () => {
  it('exports buildPauseCommitMessage and the author-and-validate guard', () => {
    const mod = loadModuleFresh();
    assert.equal(
      typeof mod.buildPauseCommitMessage,
      'function',
      'buildPauseCommitMessage must be exported'
    );
    assert.equal(
      typeof mod.assertHandoffValid,
      'function',
      'assertHandoffValid guard must be exported'
    );
  });
});

describe('pause-work commit uses an allowed type and carries the ticket ref', () => {
  it('builds `chore(work): pause at <step> (task N/M) (#315)` with an allowed type + (#315)', () => {
    const mod = loadModuleFresh();
    const header = mod.buildPauseCommitMessage({ step: 'implement', taskN: 6, taskM: 9 });
    assert.equal(
      header,
      'chore(work): pause at implement (task 6/9) (#315)',
      'header must be the exact WIP commit shape'
    );
    // Type is one of the allowed commit types.
    const { ALLOWED_TYPES } = require(COMMIT_RULES_PATH);
    const type = /^([a-zA-Z]+)/.exec(header)[1];
    assert.ok(ALLOWED_TYPES.has(type), `type "${type}" must be an allowed commit type`);
    assert.notEqual(type, 'wip', 'must not introduce a "wip" type');
    // Carries the (#315) ticket ref.
    assert.match(header, /\(#315\)/, 'header must carry the (#315) ticket ref');
  });

  it('produces a header accepted by the shared commit-message validator', () => {
    const mod = loadModuleFresh();
    const { validateMessage } = require(COMMIT_RULES_PATH);
    const header = mod.buildPauseCommitMessage({ step: 'implement', taskN: 6, taskM: 9 });
    const result = validateMessage(header, GITHUB_CTX);
    assert.ok(result.ok, `header must pass commit-message rules, got: ${result.reason || 'ok'}`);
  });
});

describe('pause-work authors a valid handoff with all three sections', () => {
  it('accepts a handoff carrying all three required sections (no throw)', () => {
    const mod = loadModuleFresh();
    assert.doesNotThrow(
      () => mod.assertHandoffValid(validHandoff()),
      'a handoff with all three sections must be accepted'
    );
  });

  it('refuses when validateHandoffSections reports a missing section', () => {
    const mod = loadModuleFresh();
    assert.throws(
      () => mod.assertHandoffValid(skeletonMissingInFlight()),
      /What was in flight/,
      'must refuse a skeleton and name the missing section before any commit'
    );
  });
});

describe('pause-work.js → resolveStepAndProgress', () => {
  it('reads <step> from .work-state.json and N/M from tasks.md progress', () => {
    const ticketId = 'GH-315';
    const tasksMd = [
      '# Tasks',
      '',
      '## Task 1 — first',
      '## Task 2 — second',
      '## Task 3 — third',
      '',
    ].join('\n');
    // currentStep 8 → the `implement` step (1-based index into STEP_ORDER).
    seedTicket(ticketId, { currentStep: 8, tasksMd });
    const mod = loadModuleFresh();
    const { step, taskN, taskM } = mod.resolveStepAndProgress(ticketId);
    assert.equal(step, 'implement', 'step must resolve from .work-state.json currentStep');
    assert.equal(taskM, 3, 'taskM must count the ## Task headings in tasks.md');
    assert.equal(typeof taskN, 'number', 'taskN must be a number');
  });
});
