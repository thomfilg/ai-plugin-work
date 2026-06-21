/**
 * Tests for initFreshState(ticketId) helper extracted from follow-up-next.js.
 *
 * Task 1 (GH-531) RED: assert the helper is exported, returns a fresh state
 * shape matching the existing init path, writes the state file at the correct
 * path under TASKS_BASE/<ticket>/.follow-up-state.json, and is idempotent
 * (second call overwrites with a fresh state).
 *
 * node:test + node:assert/strict; isolated TASKS_BASE via fs.mkdtempSync.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE_PATH = path.join(__dirname, '..', 'follow-up-next.js');

let TASKS_BASE;
let prevTasksBase;
let prevWorktreesBase;

function loadModuleFresh() {
  // follow-up-next.js reads TASKS_BASE at require time via getConfig; clear
  // the require cache so each test sees the temp TASKS_BASE.
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

beforeEach(() => {
  TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'follow-up-next-init-'));
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

describe('follow-up-next.js → initFreshState(ticketId)', () => {
  it('is exported as a function from follow-up-next.js', () => {
    const mod = loadModuleFresh();
    assert.equal(
      typeof mod.initFreshState,
      'function',
      'initFreshState must be exported from follow-up-next.js'
    );
  });

  it('returns a fresh state object with the canonical init shape', () => {
    const { initFreshState } = loadModuleFresh();
    const state = initFreshState('GH-999');

    assert.ok(state && typeof state === 'object', 'returns an object');
    assert.equal(state.ticketId, 'GH-999');
    assert.equal(state.status, 'in_progress');
    assert.equal(state.attempt, 0);
    assert.equal(state.maxAttempts, 40);
    assert.equal(state.lastMonitorResult, null);
    assert.equal(state.failureCategory, null);
    assert.equal(state.dispatched, null);
    assert.ok(typeof state.currentStep === 'string' && state.currentStep.length > 0);
    assert.ok(typeof state.startTime === 'string' && state.startTime.length > 0);
  });

  it('writes the state file at TASKS_BASE/<ticket>/.follow-up-state.json', () => {
    const { initFreshState } = loadModuleFresh();
    const ticketId = 'GH-999';
    const expectedPath = path.join(TASKS_BASE, ticketId, '.follow-up-state.json');

    initFreshState(ticketId);

    assert.ok(fs.existsSync(expectedPath), `state file written at ${expectedPath}`);
    const onDisk = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
    assert.equal(onDisk.ticketId, ticketId);
    assert.equal(onDisk.attempt, 0);
    assert.equal(onDisk.status, 'in_progress');
  });

  it('is idempotent — calling twice overwrites with a fresh state', () => {
    const { initFreshState } = loadModuleFresh();
    const ticketId = 'GH-999';
    const statePath = path.join(TASKS_BASE, ticketId, '.follow-up-state.json');

    initFreshState(ticketId);
    // Mutate on-disk state to simulate progress.
    const dirty = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    dirty.attempt = 27;
    dirty.status = 'blocked';
    dirty.failureCategory = 'something';
    fs.writeFileSync(statePath, JSON.stringify(dirty, null, 2));

    const second = initFreshState(ticketId);
    assert.equal(second.attempt, 0, 'returned state is fresh');
    assert.equal(second.status, 'in_progress', 'returned state is fresh');
    assert.equal(second.failureCategory, null, 'returned state is fresh');

    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(onDisk.attempt, 0, 'on-disk state overwritten fresh');
    assert.equal(onDisk.status, 'in_progress', 'on-disk state overwritten fresh');
    assert.equal(onDisk.failureCategory, null, 'on-disk state overwritten fresh');
  });
});
