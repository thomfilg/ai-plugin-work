'use strict';

/**
 * E2E tests for GH-768 Task 3 — wiring `checkVersionSkew` into workflow start
 * in `createGetNextInstruction` (lib/next-instruction.js).
 *
 * Drives the REAL `createGetNextInstruction` closure with an injected env over
 * a `fs.mkdtempSync` temp TASKS_BASE. The executing version is the real
 * installed plugin version (read via the same `readInstalledVersion` seam the
 * wiring must use); skew is created by writing a different-but-valid
 * `pluginVersionAnchor` into the temp `.work-state.json`.
 *
 * Scenarios (gherkin titles verbatim):
 *   - Skewed version emits a banner warning and an audit row
 *   - Matching versions stay silent
 *   - Pre-feature ticket without an anchor degrades gracefully
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createGetNextInstruction } = require('../next-instruction');
const { readInstalledVersion } = require('../update-check');
const { ALL_STEPS, STEP_TRANSITIONS, STEPS } = require('../../step-registry');

const TICKET = 'ECHO-1';
const EXECUTING_VERSION = readInstalledVersion();
// A valid X.Y.Z that can never equal the real installed version.
const SKEWED_ANCHOR = '0.0.1';

assert.ok(
  /^\d+\.\d+\.\d+$/.test(EXECUTING_VERSION || ''),
  `test precondition: installed plugin version must be readable, got: ${EXECUTING_VERSION}`
);

// ─── Fixture helpers ────────────────────────────────────────────────────────

function statePathFor(tasksBase, safeName) {
  return path.join(tasksBase, safeName, '.work-state.json');
}

function writeStateFile(tasksBase, safeName, extraFields = {}) {
  const dir = path.join(tasksBase, safeName);
  fs.mkdirSync(dir, { recursive: true });
  const state = {
    ticketId: safeName,
    ticketBase: safeName,
    ticketSuffix: null,
    ticketSeparator: null,
    description: 'version-skew e2e fixture',
    currentStep: 8,
    status: 'in_progress',
    stepStatus: Object.fromEntries(ALL_STEPS.map((s) => [s, 'pending'])),
    checkProgress: {},
    errors: [],
    startTime: new Date().toISOString(),
    ...extraFields,
  };
  fs.writeFileSync(statePathFor(tasksBase, safeName), JSON.stringify(state, null, 2));
  return state;
}

function readStateFile(tasksBase, safeName) {
  return JSON.parse(fs.readFileSync(statePathFor(tasksBase, safeName), 'utf8'));
}

/** Stub workDir whose work-state.js exits 0 (handleAdvanceTask succeeds). */
function makeStubWorkDir(tmpRoot) {
  const dir = path.join(tmpRoot, 'stub-work-dir');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'work-state.js'), 'process.exit(0);\n');
  return dir;
}

/**
 * Build the injected orchestrator env. Real FS-backed load/save over the temp
 * TASKS_BASE (with recording), recording appendAction, inert provider stubs,
 * and an empty plan so the loop falls through to the `complete` instruction
 * without touching gates/enrichments.
 */
function buildEnv(tasksBase, overrides = {}) {
  const auditRows = [];
  const savedStates = [];
  const generatePlanResults = overrides.generatePlanResults || null;
  let planCalls = 0;

  const env = {
    tp: {
      getProviderConfig: () => ({ provider: 'jira' }),
      sanitizeTicketIdForPath: (t) => t,
    },
    validateRawTicketInput: (raw) => ({ ticketBase: raw, suffix: null, separator: null }),
    inspect: () => null,
    generatePlan: () => {
      planCalls++;
      if (generatePlanResults) {
        const idx = Math.min(planCalls - 1, generatePlanResults.length - 1);
        // shallow copy — persistPlanMetadata mutates the result object
        return { ...generatePlanResults[idx] };
      }
      return { plan: [] };
    },
    loadWorkState: (safeName) => {
      try {
        return JSON.parse(fs.readFileSync(statePathFor(tasksBase, safeName), 'utf8'));
      } catch {
        return null;
      }
    },
    saveWorkState: (safeName, ws) => {
      savedStates.push(JSON.parse(JSON.stringify(ws)));
      fs.writeFileSync(statePathFor(tasksBase, safeName), JSON.stringify(ws, null, 2));
    },
    appendAction: (safeName, row) => {
      auditRows.push({ safeName, ...row });
    },
    transitionStep: () => ({ error: true, message: 'not under test' }),
    getCurrentStep: () => 'implement',
    ALL_STEPS,
    STEP_TRANSITIONS,
    STEPS,
    TASKS_BASE: tasksBase,
    WORKTREES_BASE: path.join(tasksBase, 'no-worktrees'),
    MAIN_WORKTREE_FOLDER: 'no-such-repo',
    workDir: makeStubWorkDir(tasksBase),
    work2Dir: tasksBase,
    ...overrides.env,
  };
  return { env, auditRows, savedStates };
}

function skewRows(auditRows) {
  return auditRows.filter((r) => r.what === 'plugin version skew detected');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('next-instruction version-skew wiring (GH-768 Task 3)', () => {
  let tasksBase;
  let prevSessionGuard;

  beforeEach(() => {
    tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'next-instr-skew-'));
    prevSessionGuard = process.env.SESSION_GUARD_ENABLED;
    process.env.SESSION_GUARD_ENABLED = '0';
  });

  afterEach(() => {
    fs.rmSync(tasksBase, { recursive: true, force: true });
    if (prevSessionGuard === undefined) delete process.env.SESSION_GUARD_ENABLED;
    else process.env.SESSION_GUARD_ENABLED = prevSessionGuard;
  });

  it('Skewed version emits a banner warning and an audit row', () => {
    writeStateFile(tasksBase, TICKET, { pluginVersionAnchor: SKEWED_ANCHOR });
    const { env, auditRows } = buildEnv(tasksBase);
    const getNextInstruction = createGetNextInstruction(env);

    const instr = getNextInstruction(TICKET);

    // Never a block: the workflow still returns its normal next instruction.
    assert.ok(instr, 'expected an instruction object');
    assert.notEqual(
      instr.action,
      'blocked',
      `skew must never block the workflow, got: ${JSON.stringify(instr)}`
    );

    // Banner surfaces in the instruction's state block (stateCtx.versionSkew).
    const banner = instr.state && instr.state.versionSkew;
    assert.equal(typeof banner, 'string', 'expected state.versionSkew banner string');
    assert.ok(
      banner.includes(EXECUTING_VERSION),
      `banner must name the executing version ${EXECUTING_VERSION}; got: ${banner}`
    );
    assert.ok(
      banner.includes(SKEWED_ANCHOR),
      `banner must name the recorded version ${SKEWED_ANCHOR}; got: ${banner}`
    );
    assert.ok(
      banner.includes(statePathFor(tasksBase, TICKET)),
      `banner must name the state file path; got: ${banner}`
    );

    // Exactly one audit row with the exact contract shape.
    const rows = skewRows(auditRows);
    assert.equal(rows.length, 1, `expected exactly one skew audit row, got ${rows.length}`);
    assert.equal(rows[0].meta.executingVersion, EXECUTING_VERSION);
    assert.equal(rows[0].meta.recordedVersion, SKEWED_ANCHOR);
    assert.equal(rows[0].meta.stateFile, statePathFor(tasksBase, TICKET));

    // Anchor is never re-baselined on warn.
    assert.equal(readStateFile(tasksBase, TICKET).pluginVersionAnchor, SKEWED_ANCHOR);
  });

  it('runs the skew check only once per top-level invocation (auto-advance recursion)', () => {
    writeStateFile(tasksBase, TICKET, { pluginVersionAnchor: SKEWED_ANCHOR });
    // saveWorkState recorder that does NOT persist: the de-dup marker never
    // reaches disk, so if the check re-ran on the recursed pass it would
    // append a SECOND audit row. The recursionDepth===1 guard prevents that.
    const savedOnly = [];
    const { env, auditRows } = buildEnv(tasksBase, {
      generatePlanResults: [{ plan: [], nextAction: 'advance_task' }, { plan: [] }],
      env: {
        saveWorkState: (_safeName, ws) => {
          savedOnly.push(JSON.parse(JSON.stringify(ws)));
        },
      },
    });
    const getNextInstruction = createGetNextInstruction(env);

    const instr = getNextInstruction(TICKET);

    assert.ok(instr, 'expected an instruction object');
    assert.notEqual(instr.action, 'blocked', 'auto-advance run must not be blocked');
    const rows = skewRows(auditRows);
    assert.equal(
      rows.length,
      1,
      `skew check must run once per top-level invocation — expected 1 audit row across the recursed passes, got ${rows.length}`
    );
  });

  it('Matching versions stay silent', () => {
    writeStateFile(tasksBase, TICKET, {
      pluginVersionAnchor: EXECUTING_VERSION,
      pluginVersionAnchorAt: '2026-01-01T00:00:00.000Z',
    });
    const { env, auditRows, savedStates } = buildEnv(tasksBase);
    const getNextInstruction = createGetNextInstruction(env);

    const instr = getNextInstruction(TICKET);

    assert.ok(instr, 'expected an instruction object');
    assert.notEqual(instr.action, 'blocked');
    assert.ok(
      !instr.state || !('versionSkew' in instr.state),
      `matching versions must not attach a versionSkew field; got: ${JSON.stringify(instr.state)}`
    );
    assert.equal(skewRows(auditRows).length, 0, 'no audit row on match');

    // No skew-driven state rewrite: nothing saved ever carries the de-dup
    // marker and the anchor fields on disk are untouched.
    for (const saved of savedStates) {
      assert.ok(!('versionSkewWarnedFor' in saved), 'match must not write versionSkewWarnedFor');
    }
    const after = readStateFile(tasksBase, TICKET);
    assert.equal(after.pluginVersionAnchor, EXECUTING_VERSION);
    assert.equal(after.pluginVersionAnchorAt, '2026-01-01T00:00:00.000Z');
    assert.ok(!('versionSkewWarnedFor' in after), 'no de-dup marker persisted on match');
  });

  it('Pre-feature ticket without an anchor degrades gracefully', () => {
    const before = writeStateFile(tasksBase, TICKET); // no anchor fields at all
    assert.ok(!('pluginVersionAnchor' in before), 'fixture precondition: pre-feature state');
    const { env, auditRows } = buildEnv(tasksBase);
    const getNextInstruction = createGetNextInstruction(env);

    const instr = getNextInstruction(TICKET);

    // Silent adoption: no banner, no false warning, no skew audit row.
    assert.ok(instr, 'expected an instruction object');
    assert.notEqual(instr.action, 'blocked');
    assert.ok(
      !instr.state || !('versionSkew' in instr.state),
      `adoption must be silent; got: ${JSON.stringify(instr.state)}`
    );
    assert.equal(skewRows(auditRows).length, 0, 'no skew audit row on adoption');

    // The anchor is persisted to disk through the env's real saveWorkState.
    const after = readStateFile(tasksBase, TICKET);
    assert.equal(
      after.pluginVersionAnchor,
      EXECUTING_VERSION,
      'adopt path must persist the executing version as the anchor'
    );
    assert.ok(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(after.pluginVersionAnchorAt || ''),
      `expected ISO pluginVersionAnchorAt, got: ${after.pluginVersionAnchorAt}`
    );
    assert.ok(!('versionSkewWarnedFor' in after), 'adoption must not set the de-dup marker');

    // Additive-only write: every pre-existing field survives unchanged.
    for (const key of Object.keys(before)) {
      if (key === 'lastPlanTimestamp' || key === 'deferredSteps') continue; // plan metadata refresh
      assert.deepEqual(
        after[key],
        before[key],
        `pre-existing field "${key}" must be preserved by the adoption write`
      );
    }
  });
});
