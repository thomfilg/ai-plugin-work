'use strict';

/**
 * Unit tests for the createPhaseStateCli factory.
 *
 * Task 6 (GH-478) — Extract the CLI body from
 * `plugins/work/scripts/workflows/work-tasks/tasks-phase-state.js` into a
 * reusable factory at `plugins/work/scripts/workflows/lib/phase-state/
 * create-phase-state-cli.js`. The factory is constructed with:
 *
 *   createPhaseStateCli({ phaseRegistry, allowedAgents, stateFileName, scriptName })
 *
 * Each test spawns a synthetic CLI bin that wires the factory up with a
 * deterministic stub phase registry, then exercises the public subcommands
 * (`init`, `current`, `record`, `transition`) against a temp TASKS_BASE.
 * Tokens are minted using the same path scheme the production hook uses.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TOKEN_DIR = '/tmp/.claude-write-tokens';
const { tokenPath } = require('../../scripts/write-report');

const FACTORY_PATH = path.resolve(__dirname, '..', 'create-phase-state-cli.js');
const BIN_BASENAME = 'stub-phase-state.js';

/** Stub phase registry matching the tasks-phase-registry contract. */
const STUB_REGISTRY_SRC = `
'use strict';
const PHASE_ORDER = Object.freeze(['a', 'b', 'c', 'done']);
const TRANSITIONS = Object.freeze({
  a: Object.freeze(['b']),
  b: Object.freeze(['c']),
  c: Object.freeze(['done']),
  done: Object.freeze([]),
});
module.exports = {
  PHASE_ORDER,
  INITIAL_PHASE: 'a',
  TERMINAL_PHASE: 'done',
  nextPhases(p) { return TRANSITIONS[p] || []; },
  canTransition(p, n) { return (TRANSITIONS[p] || []).includes(n); },
  isPhase(p) { return PHASE_ORDER.includes(p); },
};
`;

function makeBin(tmp) {
  const registryPath = path.join(tmp, 'stub-registry.js');
  fs.writeFileSync(registryPath, STUB_REGISTRY_SRC);
  const binPath = path.join(tmp, BIN_BASENAME);
  const factoryPathJson = JSON.stringify(FACTORY_PATH);
  const registryPathJson = JSON.stringify(registryPath);
  const binSrc = `#!/usr/bin/env node
'use strict';
const { createPhaseStateCli } = require(${factoryPathJson});
const reg = require(${registryPathJson});
const cli = createPhaseStateCli({
  phaseRegistry: {
    PHASE_ORDER: reg.PHASE_ORDER,
    INITIAL_PHASE: reg.INITIAL_PHASE,
    TERMINAL_PHASE: reg.TERMINAL_PHASE,
    nextPhases: reg.nextPhases,
    canTransition: reg.canTransition,
    isPhase: reg.isPhase,
  },
  allowedAgents: ['stub-agent'],
  stateFileName: 'stub-phase.json',
  scriptName: ${JSON.stringify(BIN_BASENAME)},
});
cli.main(process.argv);
`;
  fs.writeFileSync(binPath, binSrc, { mode: 0o755 });
  return binPath;
}

function mintToken(ticketId, opts = {}) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  const tp = tokenPath(BIN_BASENAME, ticketId);
  const payload = {
    agent: opts.agent || 'stub-agent',
    timestamp: typeof opts.timestamp === 'number' ? opts.timestamp : Date.now(),
    tasksBase: null,
  };
  fs.writeFileSync(tp, JSON.stringify(payload), { mode: 0o600 });
  return tp;
}

function clearToken(ticketId) {
  for (const tp of [tokenPath(BIN_BASENAME, ticketId), tokenPath(BIN_BASENAME)]) {
    try {
      fs.unlinkSync(tp);
    } catch {
      /* ignore */
    }
  }
}

function run(binPath, args, env) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      TASKS_BASE: env.TASKS_BASE,
    },
  });
}

describe('createPhaseStateCli factory', () => {
  let tmp;
  let tasksBase;
  let binPath;
  const ticket = 'GH-99081';

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'create-phase-state-cli-'));
    tasksBase = path.join(tmp, 'tasks');
    fs.mkdirSync(path.join(tasksBase, ticket), { recursive: true });
    binPath = makeBin(tmp);
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    clearToken(ticket);
  });

  beforeEach(() => {
    // Reset the per-ticket state file between tests.
    const stateFile = path.join(tasksBase, ticket, 'stub-phase.json');
    try {
      fs.unlinkSync(stateFile);
    } catch {
      /* ignore */
    }
    clearToken(ticket);
  });

  it('init → record → transition round-trip preserves baseline JSON shape and key order; current returns { ok, currentPhase, state }', () => {
    // INIT
    mintToken(ticket);
    const initRes = run(binPath, ['init', ticket], { TASKS_BASE: tasksBase });
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
    assert.equal(initOut.state.currentPhase, 'a');
    assert.deepEqual(initOut.state.phases, {});

    // RECORD a
    mintToken(ticket);
    const recRes = run(binPath, ['record', ticket, 'a', '--summary', 'did a'], {
      TASKS_BASE: tasksBase,
    });
    assert.equal(recRes.status, 0, `record failed: ${recRes.stderr}`);
    const recOut = JSON.parse(recRes.stdout.trim());
    assert.equal(recOut.ok, true);
    assert.equal(recOut.recordedPhase, 'a');
    assert.equal(recOut.state.phases.a.summary, 'did a');
    assert.ok(typeof recOut.state.phases.a.completedAt === 'string');

    // TRANSITION a → b
    mintToken(ticket);
    const trRes = run(binPath, ['transition', ticket, 'b'], { TASKS_BASE: tasksBase });
    assert.equal(trRes.status, 0, `transition failed: ${trRes.stderr}`);
    const trOut = JSON.parse(trRes.stdout.trim());
    assert.equal(trOut.ok, true);
    assert.equal(trOut.currentPhase, 'b');
    assert.equal(trOut.state.currentPhase, 'b');

    // CURRENT (un-gated)
    const curRes = run(binPath, ['current', ticket], { TASKS_BASE: tasksBase });
    assert.equal(curRes.status, 0, `current failed: ${curRes.stderr}`);
    const curOut = JSON.parse(curRes.stdout.trim());
    assert.equal(curOut.ok, true);
    assert.equal(curOut.currentPhase, 'b');
    assert.deepEqual(Object.keys(curOut.state), [
      'ticket',
      'createdAt',
      'updatedAt',
      'currentPhase',
      'phases',
    ]);

    // On-disk file matches the captured baseline shape (atomic write preserved).
    const stateFile = path.join(tasksBase, ticket, 'stub-phase.json');
    const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepEqual(Object.keys(onDisk), [
      'ticket',
      'createdAt',
      'updatedAt',
      'currentPhase',
      'phases',
    ]);
  });

  it('record rejects when no write token is present (missing token)', () => {
    // Initialize state under valid token, then drop tokens.
    mintToken(ticket);
    run(binPath, ['init', ticket], { TASKS_BASE: tasksBase });
    clearToken(ticket);

    const res = run(binPath, ['record', ticket, 'a'], { TASKS_BASE: tasksBase });
    assert.notEqual(res.status, 0);
    const err = JSON.parse(res.stderr.trim().split('\n').pop());
    assert.equal(err.error, true);
    assert.match(err.message, /No valid write token/i);
  });

  it('record rejects an expired token', () => {
    mintToken(ticket);
    run(binPath, ['init', ticket], { TASKS_BASE: tasksBase });

    // Mint an old token (older than TOKEN_MAX_AGE_MS = 10s).
    mintToken(ticket, { timestamp: Date.now() - 60_000 });
    const res = run(binPath, ['record', ticket, 'a'], { TASKS_BASE: tasksBase });
    assert.notEqual(res.status, 0);
    const err = JSON.parse(res.stderr.trim().split('\n').pop());
    assert.equal(err.error, true);
    assert.match(err.message, /expired/i);
  });

  it('record rejects an unauthorized agent', () => {
    mintToken(ticket);
    run(binPath, ['init', ticket], { TASKS_BASE: tasksBase });

    mintToken(ticket, { agent: 'someone-else' });
    const res = run(binPath, ['record', ticket, 'a'], { TASKS_BASE: tasksBase });
    assert.notEqual(res.status, 0);
    const err = JSON.parse(res.stderr.trim().split('\n').pop());
    assert.equal(err.error, true);
    assert.match(err.message, /not authorized/i);
  });

  it('rejects ticket IDs containing path-traversal sequences', () => {
    mintToken('../etc');
    const res = run(binPath, ['init', '../etc'], { TASKS_BASE: tasksBase });
    assert.notEqual(res.status, 0);
    const err = JSON.parse(res.stderr.trim().split('\n').pop());
    assert.equal(err.error, true);
    assert.match(err.message, /Invalid ticket ID/i);
    clearToken('../etc');
  });

  it('transition rejects an invalid edge per the injected phaseRegistry', () => {
    mintToken(ticket);
    run(binPath, ['init', ticket], { TASKS_BASE: tasksBase });
    mintToken(ticket);
    run(binPath, ['record', ticket, 'a'], { TASKS_BASE: tasksBase });

    // a → c is not an allowed edge in the stub registry; only a → b is.
    mintToken(ticket);
    const res = run(binPath, ['transition', ticket, 'c'], { TASKS_BASE: tasksBase });
    assert.notEqual(res.status, 0);
    const err = JSON.parse(res.stderr.trim().split('\n').pop());
    assert.equal(err.error, true);
    assert.match(err.message, /Invalid transition/i);
  });
});
