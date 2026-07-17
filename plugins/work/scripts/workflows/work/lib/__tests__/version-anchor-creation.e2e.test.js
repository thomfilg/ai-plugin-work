/**
 * version-anchor-creation.e2e.test.js — GH-768 Task 2
 *
 * Scenario: New ticket records a version anchor at state creation
 *
 * Drives the four real fresh-state constructors and asserts every one stamps
 * `pluginVersionAnchor` (= the executing plugin version) plus an ISO
 * `pluginVersionAnchorAt` timestamp at creation:
 *   1. `initialTransitionState`  (engine/transition-step.js — test-only export)
 *   2. `buildInitialDeferState`  (lib/next-preflight.js — test-only export)
 *   3. `buildMinimalPlanState`   (engine/cli.js — extracted from the inline
 *                                 `minimalState` literal)
 *   4. `initState`               (work-state/core.js — exercised against a
 *                                 fs.mkdtempSync temp TASKS_BASE)
 *
 * Uses node:test + node:assert/strict with direct `require()` (the
 * work-claims.test.js convention: TASKS_BASE is pinned to a temp dir BEFORE
 * requiring config-reading modules, since config.js resolves it once at
 * require time).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Pin TASKS_BASE to a temp dir BEFORE requiring work-state/core (config.js
// resolves TASKS_BASE once at require() time).
const TEMP_TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'version-anchor-test-'));
const ORIGINAL_TASKS_BASE = process.env.TASKS_BASE;
process.env.TASKS_BASE = TEMP_TASKS_BASE;

// Clear cached modules that read TASKS_BASE at require time so the override
// takes effect even if another test file loaded them first in this process.
for (const key of Object.keys(require.cache)) {
  if (key.includes(path.join('workflows', 'lib', 'config.js'))) delete require.cache[key];
  if (key.includes(path.join('work', 'work-state'))) delete require.cache[key];
}

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { readInstalledVersion } = require(path.join(__dirname, '..', 'update-check'));
const transitionStepMod = require(path.join(__dirname, '..', '..', 'engine', 'transition-step'));
const nextPreflightMod = require(path.join(__dirname, '..', 'next-preflight'));
const cliMod = require(path.join(__dirname, '..', '..', 'engine', 'cli'));
const workStateCore = require(path.join(__dirname, '..', '..', 'work-state', 'core'));

const EXECUTING_VERSION = readInstalledVersion();
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const FAKE_ALL_STEPS = ['ticket', 'bootstrap', 'implement', 'complete'];
const FAKE_STEPS = { ticket: 'ticket' };

function assertAnchor(ws, label) {
  assert.equal(
    ws.pluginVersionAnchor,
    EXECUTING_VERSION,
    `${label}: pluginVersionAnchor must equal the executing plugin version`
  );
  assert.equal(typeof ws.pluginVersionAnchorAt, 'string', `${label}: pluginVersionAnchorAt type`);
  assert.match(
    ws.pluginVersionAnchorAt,
    ISO_RE,
    `${label}: pluginVersionAnchorAt must be an ISO timestamp`
  );
}

describe('New ticket records a version anchor at state creation', () => {
  after(() => {
    if (ORIGINAL_TASKS_BASE === undefined) {
      delete process.env.TASKS_BASE;
    } else {
      process.env.TASKS_BASE = ORIGINAL_TASKS_BASE;
    }
    fs.rmSync(TEMP_TASKS_BASE, { recursive: true, force: true });
  });

  it('initialTransitionState stamps the anchor on the fresh transition state', () => {
    assert.equal(
      typeof transitionStepMod.initialTransitionState,
      'function',
      'engine/transition-step.js must export initialTransitionState for direct assertion'
    );
    const actions = [];
    const deps = {
      ALL_STEPS: FAKE_ALL_STEPS,
      STEPS: FAKE_STEPS,
      appendAction: (safeTicket, row) => actions.push({ safeTicket, row }),
    };
    const ws = transitionStepMod.initialTransitionState(deps, 'GH-768-T');
    assert.equal(ws.ticketId, 'GH-768-T');
    assert.equal(ws.currentStep, 1);
    assert.deepEqual(ws.stepStatus, Object.fromEntries(FAKE_ALL_STEPS.map((s) => [s, 'pending'])));
    assertAnchor(ws, 'initialTransitionState');
  });

  it('buildInitialDeferState stamps the anchor on the fresh defer state', () => {
    assert.equal(
      typeof nextPreflightMod.buildInitialDeferState,
      'function',
      'lib/next-preflight.js must export buildInitialDeferState for direct assertion'
    );
    const env = { ALL_STEPS: FAKE_ALL_STEPS };
    const meta = { safeName: 'GH-768-D', safeBase: 'GH-768-D', suffix: null, separator: null };
    const timestamp = '2026-07-17T00:00:00.000Z';
    const ws = nextPreflightMod.buildInitialDeferState(env, meta, ['check'], timestamp);
    assert.equal(ws.ticketId, 'GH-768-D');
    assert.deepEqual(ws.deferredSteps, ['check']);
    assert.equal(ws.lastPlanTimestamp, timestamp);
    assertAnchor(ws, 'buildInitialDeferState');
  });

  it('buildMinimalPlanState returns the minimal defer-state shape with the anchor', () => {
    assert.equal(
      typeof cliMod.buildMinimalPlanState,
      'function',
      'engine/cli.js must export buildMinimalPlanState (extracted from the inline minimalState literal)'
    );
    const timestamp = '2026-07-17T00:00:00.000Z';
    const ws = cliMod.buildMinimalPlanState({
      ALL_STEPS: FAKE_ALL_STEPS,
      safeName: 'GH-768-M',
      timestamp,
      deferredSteps: ['pr'],
    });
    // Field-by-field assertion against the original inline literal shape
    // (deliverable 2.2.3: extraction changes nothing beyond the anchor fields).
    assert.equal(ws.ticketId, 'GH-768-M');
    assert.equal(ws.description, '');
    assert.equal(ws.currentStep, 1);
    assert.equal(ws.status, 'in_progress');
    assert.deepEqual(ws.stepStatus, Object.fromEntries(FAKE_ALL_STEPS.map((s) => [s, 'pending'])));
    assert.deepEqual(ws.checkProgress, {});
    assert.deepEqual(ws.errors, []);
    assert.equal(typeof ws.startTime, 'string');
    assert.equal(ws.lastPlanTimestamp, timestamp);
    assert.deepEqual(ws.deferredSteps, ['pr']);
    assertAnchor(ws, 'buildMinimalPlanState');
    const expectedKeys = [
      'ticketId',
      'description',
      'currentStep',
      'status',
      'stepStatus',
      'checkProgress',
      'errors',
      'startTime',
      'lastPlanTimestamp',
      'deferredSteps',
      'pluginVersionAnchor',
      'pluginVersionAnchorAt',
    ];
    assert.deepEqual(
      Object.keys(ws).sort(),
      expectedKeys.slice().sort(),
      'buildMinimalPlanState must add nothing beyond the original literal shape + anchor fields'
    );
  });

  it('initState persists the anchor in the durable .work-state.json', () => {
    const ticketId = 'GH-768-INIT';
    const ws = workStateCore.initState(ticketId, 'anchor test');
    assertAnchor(ws, 'initState (returned state)');

    const statePath = path.join(TEMP_TASKS_BASE, ticketId, '.work-state.json');
    assert.ok(fs.existsSync(statePath), `state file must exist at ${statePath}`);
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assertAnchor(onDisk, 'initState (persisted state)');
  });

  it('initState leaves pre-existing state files without the fields unchanged (no backfill)', () => {
    const ticketId = 'GH-768-LEGACY';
    const dir = path.join(TEMP_TASKS_BASE, ticketId);
    fs.mkdirSync(dir, { recursive: true });
    const legacy = {
      ticketId,
      description: 'pre-feature ticket',
      currentStep: 3,
      status: 'in_progress',
      stepStatus: {},
      checkProgress: {},
      errors: [],
      startTime: '2025-01-01T00:00:00.000Z',
      lastUpdate: '2025-01-01T00:00:00.000Z',
    };
    fs.writeFileSync(path.join(dir, '.work-state.json'), JSON.stringify(legacy, null, 2));

    // initState is idempotent: it must return the existing state untouched.
    const ws = workStateCore.initState(ticketId);
    assert.equal(ws.pluginVersionAnchor, undefined, 'no migration/backfill on existing state');
    assert.equal(ws.pluginVersionAnchorAt, undefined, 'no migration/backfill on existing state');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.work-state.json'), 'utf8'));
    assert.deepEqual(onDisk, legacy, 'pre-existing state file must load and remain unchanged');
  });
});
