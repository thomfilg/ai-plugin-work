'use strict';

/**
 * Integration tests for the migrated `tasks-phase-state.js`.
 *
 * Task 7 (GH-478) — Migrate `work-tasks/tasks-phase-state.js` to delegate to
 * the `createPhaseStateCli` factory while preserving:
 *   - byte-equivalent state-file shape and key order
 *     (`{ ticket, createdAt, updatedAt, currentPhase, phases }`)
 *   - the public re-exports `PHASES`, `tasksCanTransition`, `tasksNextPhases`
 *   - token-gating, atomic write, and path-traversal rejection
 *
 * These tests spawn the actual `tasks-phase-state.js` script as a child
 * process against a temporary TASKS_BASE, minting tokens the same way the
 * production hook does. They are designed to fail until the migration is
 * complete: in particular, the script must contain a `createPhaseStateCli(`
 * call so we have a structural signal that the factory is wired up.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TOKEN_DIR = '/tmp/.claude-write-tokens';
const { tokenPath } = require('../../lib/scripts/write-report');

const SCRIPT_PATH = path.resolve(__dirname, '..', 'tasks-phase-state.js');
const SCRIPT_BASENAME = 'tasks-phase-state.js';

function mintToken(ticketId, opts = {}) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  const tp = tokenPath(SCRIPT_BASENAME, ticketId);
  const payload = {
    agent: opts.agent || 'split-in-tasks',
    timestamp: typeof opts.timestamp === 'number' ? opts.timestamp : Date.now(),
    tasksBase: null,
  };
  fs.writeFileSync(tp, JSON.stringify(payload), { mode: 0o600 });
  return tp;
}

function clearToken(ticketId) {
  for (const tp of [tokenPath(SCRIPT_BASENAME, ticketId), tokenPath(SCRIPT_BASENAME)]) {
    try {
      fs.unlinkSync(tp);
    } catch {
      /* ignore */
    }
  }
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      TASKS_BASE: env.TASKS_BASE,
    },
  });
}

describe('tasks-phase-state.js (factory delegator)', () => {
  let tmp;
  let tasksBase;
  const ticket = 'GH-99082';

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-phase-state-int-'));
    tasksBase = path.join(tmp, 'tasks');
    fs.mkdirSync(path.join(tasksBase, ticket), { recursive: true });
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    clearToken(ticket);
  });

  beforeEach(() => {
    const stateFile = path.join(tasksBase, ticket, 'tasks-phase.json');
    try {
      fs.unlinkSync(stateFile);
    } catch {
      /* ignore */
    }
    clearToken(ticket);
  });

  it('source file delegates to createPhaseStateCli factory', () => {
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    assert.match(
      src,
      /createPhaseStateCli\s*\(/,
      'tasks-phase-state.js must contain a createPhaseStateCli( call'
    );
  });

  it('preserves public re-exports: PHASES, tasksCanTransition, tasksNextPhases', () => {
    // Clear require cache so we read the on-disk module fresh.
    delete require.cache[SCRIPT_PATH];
    const mod = require(SCRIPT_PATH);
    assert.ok(Array.isArray(mod.PHASES), 'PHASES must be an array');
    assert.ok(mod.PHASES.includes('inputs'), 'PHASES must include "inputs"');
    assert.ok(mod.PHASES.includes('done'), 'PHASES must include "done"');
    assert.equal(typeof mod.tasksCanTransition, 'function');
    assert.equal(typeof mod.tasksNextPhases, 'function');
    assert.equal(mod.tasksCanTransition('inputs', 'requirements_extract'), true);
    assert.equal(mod.tasksCanTransition('inputs', 'done'), false);
    assert.deepEqual(mod.tasksNextPhases('inputs'), ['requirements_extract']);
  });

  it('init → record → transition round-trip preserves baseline JSON shape and key order', () => {
    // INIT
    mintToken(ticket);
    const initRes = run(['init', ticket], { TASKS_BASE: tasksBase });
    assert.equal(initRes.status, 0, `init failed: ${initRes.stderr}`);
    const initOut = JSON.parse(initRes.stdout.trim());
    assert.equal(initOut.ok, true);
    assert.equal(initOut.status, 'created');
    assert.deepEqual(Object.keys(initOut.state), [
      'ticket',
      'createdAt',
      'updatedAt',
      'currentPhase',
      'phases',
    ]);
    assert.equal(initOut.state.ticket, ticket);
    assert.equal(initOut.state.currentPhase, 'inputs');
    assert.deepEqual(initOut.state.phases, {});

    // RECORD inputs
    mintToken(ticket);
    const recRes = run(['record', ticket, 'inputs', '--summary', 'did inputs'], {
      TASKS_BASE: tasksBase,
    });
    assert.equal(recRes.status, 0, `record failed: ${recRes.stderr}`);
    const recOut = JSON.parse(recRes.stdout.trim());
    assert.equal(recOut.ok, true);
    assert.equal(recOut.recordedPhase, 'inputs');
    assert.equal(recOut.state.phases.inputs.summary, 'did inputs');
    assert.equal(typeof recOut.state.phases.inputs.completedAt, 'string');

    // TRANSITION inputs → requirements_extract
    mintToken(ticket);
    const trRes = run(['transition', ticket, 'requirements_extract'], { TASKS_BASE: tasksBase });
    assert.equal(trRes.status, 0, `transition failed: ${trRes.stderr}`);
    const trOut = JSON.parse(trRes.stdout.trim());
    assert.equal(trOut.ok, true);
    assert.equal(trOut.currentPhase, 'requirements_extract');

    // CURRENT (un-gated)
    const curRes = run(['current', ticket], { TASKS_BASE: tasksBase });
    assert.equal(curRes.status, 0, `current failed: ${curRes.stderr}`);
    const curOut = JSON.parse(curRes.stdout.trim());
    assert.equal(curOut.ok, true);
    assert.equal(curOut.currentPhase, 'requirements_extract');
    assert.deepEqual(Object.keys(curOut.state), [
      'ticket',
      'createdAt',
      'updatedAt',
      'currentPhase',
      'phases',
    ]);

    // On-disk file matches the captured baseline shape (atomic write preserved).
    const stateFile = path.join(tasksBase, ticket, 'tasks-phase.json');
    const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepEqual(Object.keys(onDisk), [
      'ticket',
      'createdAt',
      'updatedAt',
      'currentPhase',
      'phases',
    ]);
    assert.equal(onDisk.currentPhase, 'requirements_extract');
    assert.equal(onDisk.phases.inputs.summary, 'did inputs');
  });

  it('rejects an expired write token', () => {
    mintToken(ticket);
    run(['init', ticket], { TASKS_BASE: tasksBase });

    mintToken(ticket, { timestamp: Date.now() - 60_000 });
    const res = run(['record', ticket, 'inputs'], { TASKS_BASE: tasksBase });
    assert.notEqual(res.status, 0);
    const err = JSON.parse(res.stderr.trim().split('\n').pop());
    assert.equal(err.error, true);
    assert.match(err.message, /expired/i);
  });

  it('rejects an unauthorized agent', () => {
    mintToken(ticket);
    run(['init', ticket], { TASKS_BASE: tasksBase });

    mintToken(ticket, { agent: 'someone-else' });
    const res = run(['record', ticket, 'inputs'], { TASKS_BASE: tasksBase });
    assert.notEqual(res.status, 0);
    const err = JSON.parse(res.stderr.trim().split('\n').pop());
    assert.equal(err.error, true);
    assert.match(err.message, /not authorized/i);
  });

  it('rejects a path-traversal ticket id', () => {
    mintToken('../etc');
    const res = run(['init', '../etc'], { TASKS_BASE: tasksBase });
    assert.notEqual(res.status, 0);
    const err = JSON.parse(res.stderr.trim().split('\n').pop());
    assert.equal(err.error, true);
    assert.match(err.message, /Invalid ticket ID/i);
    clearToken('../etc');
  });
});
